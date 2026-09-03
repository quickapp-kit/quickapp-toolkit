import { createHash } from 'node:crypto'
import { ErrorCodes } from '../../diagnostics/error-codes.js'
import { sortDiagnostics, type Diagnostic } from '../../diagnostics/diagnostic.js'
import { assertDeepFrozen, booleanField, countSyntaxNodes, nodeArray, nodeField, propertyName, stringField } from '../lowering/syntax.js'
import type {
  CanonicalBindingEvaluator,
  CanonicalExpression,
  CanonicalModuleEntry,
  CanonicalModuleReference,
  CanonicalLoweredAppModel,
  CanonicalLoweredPageModel,
} from '../lowering/types.js'
import type { SyntaxNode } from '../frontend/types.js'
import { EmitterIssue } from './emitter-issue.js'
import { DEFAULT_EMITTER_LIMITS, type EmitterLimits, type JsBundleArtifact, type JsEmitterRequest, type JsEmitterResult } from './types.js'

interface PrinterContext {
  readonly module: CanonicalModuleEntry
  readonly targetBySpecifier: ReadonlyMap<string, string>
  readonly contextByStartByte: ReadonlyMap<number, CanonicalModuleReference>
  readonly aliases?: ReadonlySet<string>
  readonly stateBindings?: ReadonlySet<string>
}

const PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  SequenceExpression: 1,
  AssignmentExpression: 2,
  ConditionalExpression: 3,
  LogicalExpression: 4,
  BinaryExpression: 5,
  UnaryExpression: 7,
  UpdateExpression: 8,
  CallExpression: 9,
  MemberExpression: 10,
})

export class JsModuleEmitter {
  emit(request: JsEmitterRequest): JsEmitterResult {
    const limits = { ...DEFAULT_EMITTER_LIMITS, ...(request.limits ?? {}) }
    const diagnostics: Diagnostic[] = []
    try {
      request.cancellation.throwIfCancelled()
      assertDeepFrozen(request.model)
      validateModel(request.model, limits)
      const modules = emissionOrder(request.model)
      if (modules.length > limits.maxBundles) throw new EmitterIssue(ErrorCodes.emitterLimitExceeded, 'Bundle count exceeds emitter limit')
      const bundles: JsBundleArtifact[] = []
      if (request.framework !== undefined) {
        const frameworkPath = `framework/${request.framework.moduleId.replace(/[^A-Za-z0-9_.-]/g, '_')}.js`
        const frameworkMap = createSourceMap(frameworkPath, undefined, request.framework.content, limits)
        bundles.push(Object.freeze({ moduleId: request.framework.moduleId, moduleKind: 'shared', dependencies: Object.freeze([]), path: frameworkPath, content: request.framework.content, sourceMap: frameworkMap }))
      }
      let totalBytes = 0
      for (const module of modules) {
        request.cancellation.throwIfCancelled()
        const page = request.model.pages.find((candidate) => candidate.moduleId === module.moduleId)
        const content = emitBundle(module, page, limits, request.framework?.moduleId)
        const path = bundlePath(module, page)
        const sourceMap = createSourceMap(path, module, content, limits)
        totalBytes += utf8ByteLength(content) + utf8ByteLength(sourceMap.content)
        if (totalBytes > limits.maxGeneratedBytes) throw new EmitterIssue(ErrorCodes.emitterLimitExceeded, 'Generated JS and Source Map bytes exceed emitter limit', module.source.sourcePath, module.source.span)
        if (bundles.some((bundle) => bundle.path === path)) throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, `Bundle path collision: ${path}`, module.source.sourcePath, module.source.span)
        const dependencies = module.moduleKind === 'page' && request.framework !== undefined
          ? Object.freeze([...new Set([...module.dependencies, request.framework.moduleId])].sort(compareUtf8))
          : module.dependencies
        bundles.push(Object.freeze({ moduleId: module.moduleId, moduleKind: module.moduleKind, dependencies, path, content, sourceMap }))
      }
      return Object.freeze({ status: 'success', bundles: Object.freeze(bundles), diagnostics: Object.freeze(sortDiagnostics(diagnostics)) })
    } catch (error) {
      if (error instanceof EmitterIssue) diagnostics.push(error.diagnostic)
      else if (isCancellation(error)) diagnostics.push(cancelledDiagnostic())
      else diagnostics.push(invalidDiagnostic(error instanceof Error ? error.message : 'JavaScript emission failed'))
      return Object.freeze({ status: 'failure', diagnostics: Object.freeze(sortDiagnostics(diagnostics).slice(0, limits.maxDiagnostics)) })
    }
  }
}

function validateModel(model: CanonicalLoweredAppModel, limits: EmitterLimits): void {
  if (model.modelVersion !== 1 || model.pages.length > limits.maxBundles) throw new EmitterIssue(ErrorCodes.emitterInputInvalid, 'Canonical Lowered App Model version or page count is invalid')
  if (model.appModule.moduleKind !== 'app' || countDefaultExports(model.appModule.program) !== 1) throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, 'App module must contain exactly one default export', model.appModule.source.sourcePath, model.appModule.source.span)
  const ids = new Set<string>([model.appModule.moduleId])
  for (const module of [...model.sharedModules, ...model.pages.map((page) => page.module)]) {
    if (ids.has(module.moduleId)) throw new EmitterIssue(ErrorCodes.emitterInputInvalid, `Duplicate moduleId: ${module.moduleId}`, module.source.sourcePath, module.source.span)
    ids.add(module.moduleId)
    if ((module.moduleKind === 'page' || module.moduleKind === 'app') && countDefaultExports(module.program) !== 1) throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, `Definition module must contain exactly one default export: ${module.moduleId}`, module.source.sourcePath, module.source.span)
  }
  validatePackageGraph(model)
  let syntaxNodes = 0
  for (const module of [model.appModule, ...model.sharedModules, ...model.pages.map((page) => page.module)]) syntaxNodes += countSyntaxNodes(module.program)
  if (syntaxNodes > limits.maxGeneratedNodes) throw new EmitterIssue(ErrorCodes.emitterLimitExceeded, 'JavaScript syntax projection exceeds emitter node limit')
  let expressionNodes = 0
  for (const page of model.pages) {
    for (const binding of page.bindings) {
      if (binding.evaluator.kind === 'expression') expressionNodes += countSyntaxNodes(binding.evaluator.expression.ast)
      else for (const segment of binding.evaluator.segments) if (segment.kind === 'expression') expressionNodes += countSyntaxNodes(segment.expression.ast)
    }
    for (const block of page.blocks) {
      expressionNodes += countSyntaxNodes(block.controller.kind === 'if' ? block.controller.predicate.ast : block.controller.iterable.ast)
      if (block.controller.kind === 'for') expressionNodes += countSyntaxNodes(block.controller.keyExpression.ast)
    }
  }
  if (expressionNodes > limits.maxExpressionNodes) throw new EmitterIssue(ErrorCodes.emitterLimitExceeded, 'Canonical expression projection exceeds emitter expression limit')
}

function emissionOrder(model: CanonicalLoweredAppModel): readonly CanonicalModuleEntry[] {
  const shared = [...model.sharedModules].sort((left, right) => compareUtf8(left.moduleId, right.moduleId))
  const pages = [...model.pages].sort((left, right) => compareUtf8(left.manifestRoute, right.manifestRoute)).map((page) => page.module)
  return Object.freeze([model.appModule, ...shared, ...pages])
}

function findStaticRequireIds(lines: readonly string[]): readonly string[] {
  const ids = new Set<string>()
  const pattern = /\$app_require\$\("([^"\\]+)"\)/g
  for (const line of lines) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(line)) !== null) ids.add(match[1] as string)
  }
  return [...ids]
}

function emitBundle(module: CanonicalModuleEntry, page: CanonicalLoweredPageModel | undefined, limits: EmitterLimits, frameworkModuleId?: string): string {
  const targetBySpecifier = new Map<string, string>()
  for (const reference of module.references) if (reference.targets.length === 1) targetBySpecifier.set(reference.specifier, reference.targets[0] as string)
  const contextByStartByte = new Map<number, CanonicalModuleReference>()
  for (const reference of module.references) if (reference.kind === 'context') contextByStartByte.set(reference.source.span.startByte, reference)
  const context: PrinterContext = { module, targetBySpecifier, contextByStartByte }
  const defaultExport = findDefaultExport(module.program)
  let body = nodeArray(module.program, 'body').filter((node) => node.type !== 'ExportDefaultDeclaration').map((node) => printTopLevel(node, context)).filter((line) => line.length > 0)
  const lines: string[] = []
  const dependencies = module.moduleKind === 'page' && frameworkModuleId !== undefined
    ? [...new Set([...module.dependencies, frameworkModuleId])].sort(compareUtf8)
    : module.dependencies
  lines.push(`$app_define$(${quote(module.moduleId)}, ${JSON.stringify(dependencies)}, function ($app_require$, module, exports) {`)
  const actionDependencies = frameworkModuleId !== undefined && module.moduleKind === 'page' && page !== undefined
    ? page.handlers.filter((handler) => handler.action?.kind === 'url').map((handler) => {
      const action = handler.action
      return action?.kind === 'url' ? action.mode === 'router' ? '@app-module/system.router' : action.mode === 'external' ? '@app-module/system.openUrl' : '@app-module/system.webview' : ''
    }).filter((id) => id.length > 0)
    : []
  const dependencyIds = frameworkModuleId === undefined ? [] : [...new Set([...dependencies, ...actionDependencies, ...findStaticRequireIds(body)])].sort(compareUtf8)
  const aliases = new Map(dependencyIds.map((id) => [id, `__qak_dep_${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12)}`]))
  body = body.map((statement) => {
    let result = statement
    for (const [id, alias] of aliases) result = result.replaceAll(`$app_require$(${quote(id)})`, alias)
    return result
  })
  for (const [id, alias] of aliases) lines.push(`  const ${alias} = $app_require$(${quote(id)});`)
  for (const statement of body) lines.push(`  ${statement}`)
  if (module.moduleKind === 'shared') {
    lines.push(`  module.exports = ${defaultExport === undefined ? '{}' : `{ default: ${print(defaultExport, context)} }`};`)
  } else {
    if (defaultExport === undefined || page === undefined && module.moduleKind !== 'app') throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, `Definition export is missing: ${module.moduleId}`, module.source.sourcePath, module.source.span)
    const kind = module.moduleKind
    const factoryName = kind === 'app' ? 'createAppVm' : 'createPageVm'
    if (kind === 'page') {
      lines.push('  const __qak_reactive_page_vm__ = function (target, context, bindings) {')
      lines.push('    let scheduled = false;')
      lines.push('    let revision = 0;')
      lines.push('    let sequence = 0;')
      lines.push('    const dirty = new Set();')
      lines.push('    const blockDefinitions = arguments[3] || {};')
    lines.push('    let activeBlocks = new Map();')
    lines.push('    let activeBlockSlots = new Map();')
    lines.push('    const blockGenerations = new Map();')
      lines.push('    let proxy;')
    lines.push('    const blockSlot = function (definition, key) { return String(definition.templateBlockId) + "\\u0000" + String(key); };')
    lines.push('    const blockInstanceId = function (definition, key, generation) { const base = "blk:" + context.surfaceId + "-" + String(definition.templateBlockId) + "-" + String(key).replace(/[^A-Za-z0-9_.-]/g, "_"); return generation === 1 ? base : base + "-g" + String(generation); };')
      lines.push('    const collectBlocks = function () {')
      lines.push('      const result = [];')
      lines.push('      const dynamicOffsets = {};')
      lines.push('      Object.keys(blockDefinitions).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (id) {')
      lines.push('        const definition = blockDefinitions[id];')
      lines.push('        const parentKey = String(definition.parentTemplateNodeId);')
      lines.push('        const append = function (key, scope) { const offset = dynamicOffsets[parentKey] || 0; result.push({ definition: definition, key: key, scope: scope, index: definition.staticIndex + offset }); dynamicOffsets[parentKey] = offset + 1; };')
      lines.push('        if (definition.kind === "if") {')
      lines.push('          if (definition.evaluate.call(proxy, {})) append("if", {});')
      lines.push('          return;')
      lines.push('        }')
      lines.push('        const items = definition.evaluate.call(proxy, {});')
      lines.push('        if (!Array.isArray(items)) return;')
      lines.push('        items.forEach(function (item, index) { const scope = {}; scope[definition.indexAlias] = index; scope[definition.itemAlias] = item; append(definition.key.call(proxy, scope), scope); });')
      lines.push('      });')
      lines.push('      return result;')
      lines.push('    };')
      lines.push('    const blockBindings = function (item) {')
      lines.push('      const values = {};')
      lines.push('      Object.keys(item.definition.bindings).forEach(function (id) { values[id] = item.definition.bindings[id].call(proxy, item.scope); });')
      lines.push('      return values;')
      lines.push('    };')
      lines.push('    const reconcileBlocks = function (initial) {')
      lines.push('      const nextBlocks = new Map();')
      lines.push('      const operations = [];')
      lines.push('      collectBlocks().forEach(function (item) {')
    lines.push('        const slot = blockSlot(item.definition, item.key);')
    lines.push('        const previousId = activeBlockSlots.get(slot);')
    lines.push('        const previous = previousId === undefined ? undefined : activeBlocks.get(previousId);')
    lines.push('        const generation = blockGenerations.get(slot) || 0;')
    lines.push('        const id = previousId === undefined ? blockInstanceId(item.definition, item.key, generation + 1) : previousId;')
    lines.push('        if (previousId === undefined) blockGenerations.set(slot, generation + 1);')
    lines.push('        if (previous === undefined) {')
    lines.push('          const handlers = item.definition.handlers.map(function (handler) { return { ownerInstanceId: id, templateHandlerId: handler.templateHandlerId, handlerId: "hdl:" + context.surfaceId + "-" + String(handler.templateHandlerId) + "-" + id }; });')
    lines.push('          operations.push({ kind: "instantiateBlock", templateBlockId: item.definition.templateBlockId, blockInstanceId: id, parent: { ownerInstanceId: "cmp:" + context.surfaceId, templateNodeId: item.definition.parentTemplateNodeId }, index: item.index, key: item.key, initialBindings: blockBindings(item), handlers: handlers });')
    lines.push('        } else if (!initial && previous.index !== item.index) {')
      lines.push('          operations.push({ kind: "moveBlock", blockInstanceId: id, parent: { ownerInstanceId: "cmp:" + context.surfaceId, templateNodeId: item.definition.parentTemplateNodeId }, index: item.index });')
      lines.push('        }')
    lines.push('        nextBlocks.set(id, { definition: item.definition, key: item.key, scope: item.scope, index: item.index, slot: slot });')
      lines.push('      });')
      lines.push('      if (!initial) activeBlocks.forEach(function (previous, id) { if (!nextBlocks.has(id)) operations.push({ kind: "removeBlock", blockInstanceId: id }); });')
    lines.push('      const nextSlots = new Map(); nextBlocks.forEach(function (value, id) { nextSlots.set(value.slot, id); });')
    lines.push('      return { operations: operations, nextBlocks: nextBlocks, nextSlots: nextSlots };')
    lines.push('    };')
    lines.push('    const commitBlocks = function (nextBlocks, nextSlots) { activeBlocks = nextBlocks; activeBlockSlots = nextSlots; };')
      lines.push('    const flush = function () {')
      lines.push('      scheduled = false;')
      lines.push('      if (dirty.size === 0) return;')
      lines.push('      const operations = [];')
      lines.push('      dirty.forEach(function (id) {')
      lines.push('        const binding = bindings[id];')
      lines.push('        if (binding === undefined) return;')
      lines.push('        operations.push({ kind: "updateBinding", ownerInstanceId: "cmp:" + context.surfaceId, templateBindingId: Number(id), value: binding.evaluate.call(proxy, {}) });')
      lines.push('      });')
      lines.push('      const blocks = reconcileBlocks(false);')
      lines.push('      blocks.operations.forEach(function (operation) { operations.push(operation); });')
      lines.push('      if (operations.length === 0) return;')
      lines.push('      const nextRevision = revision + 1;')
      lines.push('      const causalRequest = globalThis.$quickapp_current_request_id$;')
      lines.push('      const message = { schemaVersion: 1, surfaceId: context.surfaceId, transactionId: "txn:" + context.surfaceId + "-" + String(++sequence), revision: nextRevision, operations: operations };')
      lines.push('      if (typeof causalRequest === "string" && causalRequest.indexOf("req:") === 0) message.requestId = causalRequest;')
      lines.push('      const result = globalThis.$quickapp_runtime_v1_submitRenderTransaction$(message);')
    lines.push('      if (result && result.ok === true) { revision = nextRevision; dirty.clear(); commitBlocks(blocks.nextBlocks, blocks.nextSlots); }')
      lines.push('    };')
      lines.push('    proxy = new Proxy(target, {')
      lines.push('      set: function (object, property, value) {')
      lines.push('        object[property] = value;')
      lines.push('        const name = String(property);')
      lines.push('        Object.keys(bindings).forEach(function (id) { if (bindings[id].deps.indexOf(name) >= 0) dirty.add(id); });')
      lines.push('        Object.keys(blockDefinitions).forEach(function (id) { if (blockDefinitions[id].deps.indexOf(name) >= 0) dirty.add("__qak_block__"); });')
      lines.push('        if (!scheduled) { scheduled = true; Promise.resolve().then(flush); }')
      lines.push('        return true;')
      lines.push('      }')
      lines.push('    });')
      lines.push('    const initialBlocks = reconcileBlocks(true);')
    lines.push('    commitBlocks(initialBlocks.nextBlocks, initialBlocks.nextSlots);')
      lines.push('    Object.defineProperty(proxy, "__qak_initial_blocks__", { value: initialBlocks.operations });')
      lines.push('    return proxy;')
      lines.push('  };')
    }
    lines.push('  module.exports = {')
    lines.push('    schemaVersion: 1,')
    lines.push(`    kind: ${quote(kind)},`)
    const vm = kind === 'page' && page !== undefined ? printPageVm(defaultExport, page, context, frameworkModuleId) : print(defaultExport, context)
    lines.push(`    ${factoryName}: function (context) { return ${vm}; },`)
    if (kind === 'page' && page !== undefined) {
      lines.push('    bindingEvaluators: {')
      for (const binding of page.bindings) {
        const expression = `function (scope) { return ${printEvaluator(binding.evaluator, context)}; }`
        const evaluator = binding.scope.kind === 'page'
          ? expression
          : `(function () { const evaluator = ${expression}; Object.defineProperty(evaluator, "__qak_initial__", { value: false }); return evaluator; })()`
        lines.push(`      ${quote(String(binding.templateBindingId))}: ${evaluator},`)
      }
      lines.push('    },')
      lines.push('    handlerMethods: {')
      for (const handler of page.handlers) lines.push(`      ${quote(String(handler.templateHandlerId))}: ${quote(handler.methodName)},`)
      lines.push('    },')
    }
    lines.push('  };')
  }
  lines.push('});')
  if (module.moduleKind !== 'shared') {
    const bootstrap: Record<string, unknown> = { schemaVersion: 1, kind: module.moduleKind, moduleId: module.moduleId }
    if (module.moduleKind === 'page') {
      if (page === undefined) throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, `Page definition is absent: ${module.moduleId}`, module.source.sourcePath, module.source.span)
      bootstrap.templateId = page.templateId
    }
    lines.push(`$app_bootstrap$(${quote(module.moduleId)}, ${JSON.stringify(bootstrap)});`)
  }
  const content = `${lines.join('\n')}\n`
  if (utf8ByteLength(content) > limits.maxGeneratedBytes) throw new EmitterIssue(ErrorCodes.emitterLimitExceeded, `Bundle exceeds byte limit: ${module.moduleId}`, module.source.sourcePath, module.source.span)
  return content
}

function printTopLevel(node: SyntaxNode, context: PrinterContext): string {
  if (node.type === 'ImportDeclaration') return printImport(node, context)
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') throw new EmitterIssue(ErrorCodes.emitterJsUnsupported, 'Named exports are not in the verified V1 module ABI', context.module.source.sourcePath, node.span)
  return `${print(node, context)}${needsTerminator(node) ? ';' : ''}`
}

function printImport(node: SyntaxNode, context: PrinterContext): string {
  const source = nodeField(node, 'source')
  const specifier = source === undefined ? undefined : literalString(source)
  if (specifier === undefined) throw new EmitterIssue(ErrorCodes.emitterJsUnsupported, 'Import source is not a literal', context.module.source.sourcePath, node.span)
  const target = context.targetBySpecifier.get(specifier) ?? specifier
  const specs = nodeArray(node, 'specifiers')
  if (specs.length === 0) return `$app_require$(${quote(target)});`
  return specs.map((entry) => {
    const local = nodeField(entry, 'local')
    const localName = local === undefined ? undefined : stringField(local, 'name')
    if (localName === undefined) throw new EmitterIssue(ErrorCodes.emitterJsUnsupported, 'Import local binding is invalid', context.module.source.sourcePath, entry.span)
    if (entry.type === 'ImportNamespaceSpecifier') return `const ${localName} = $app_require$(${quote(target)});`
    if (entry.type === 'ImportDefaultSpecifier') return `const ${localName} = $app_require$(${quote(target)}).default;`
    if (entry.type === 'ImportSpecifier') {
      const imported = nodeField(entry, 'imported')
      const importedName = imported === undefined ? undefined : stringField(imported, 'name') ?? literalString(imported)
      if (importedName === undefined) throw new EmitterIssue(ErrorCodes.emitterJsUnsupported, 'Imported binding is invalid', context.module.source.sourcePath, entry.span)
      return `const ${localName} = $app_require$(${quote(target)})[${quote(importedName)}];`
    }
    throw new EmitterIssue(ErrorCodes.emitterJsUnsupported, `Unsupported import specifier: ${entry.type}`, context.module.source.sourcePath, entry.span)
  }).join('\n')
}

function printEvaluator(evaluator: CanonicalBindingEvaluator, context: PrinterContext): string {
  if (evaluator.kind === 'expression') return printExpression(evaluator.expression, context)
  const parts = evaluator.segments.map((segment) => segment.kind === 'literal' ? quote(segment.value) : printExpression(segment.expression, context))
  return parts.length === 0 ? '""' : parts.join(' + ')
}

function printExpression(expression: CanonicalExpression, context: PrinterContext): string {
  const aliases = new Set(expression.lexicalBindings)
  const stateBindings = new Set(expression.stateBindings)
  const printed = print(expression.ast, { ...context, aliases, stateBindings })
  if (expression.coercion === 'boolean') return `Boolean(${printed})`
  if (expression.coercion === 'displayString') return `String(${printed})`
  return printed
}

function print(node: SyntaxNode, context: PrinterContext, parentPrecedence = 0): string {
  const precedence = PRECEDENCE[node.type] ?? 11
  const result = printNode(node, context)
  return precedence < parentPrecedence ? `(${result})` : result
}

function printNode(node: SyntaxNode, context: PrinterContext): string {
  const field = (key: string): SyntaxNode | undefined => nodeField(node, key)
  const array = (key: string): readonly SyntaxNode[] => nodeArray(node, key)
  switch (node.type) {
    case 'Identifier': {
      const name = stringField(node, 'name')
      if (name === undefined) throw unsupported(node, context)
      if (context.aliases?.has(name) === true) return `scope[${quote(name)}]`
      return context.stateBindings?.has(name) === true ? `this.${name}` : name
    }
    case 'Literal': return literalText(node, context)
    case 'ThisExpression': return 'this'
    case 'Super': return 'super'
    case 'ArrayExpression': return `[${array('elements').map((entry) => print(entry, context)).join(', ')}]`
    case 'ObjectExpression': return `{ ${array('properties').map((entry) => printProperty(entry, context)).join(', ')} }`
    case 'Property': return printProperty(node, context)
    case 'SpreadElement': return `...${printRequired(field('argument'), context, node)}`
    case 'VariableDeclaration': return `${stringField(node, 'kind') ?? 'const'} ${array('declarations').map((entry) => print(entry, context)).join(', ')}`
    case 'VariableDeclarator': return `${printRequired(field('id'), context, node)}${field('init') === undefined ? '' : ` = ${printRequired(field('init'), context, node)}`}`
    case 'ExpressionStatement': return printRequired(field('expression'), context, node)
    case 'AssignmentExpression': return `(${printRequired(field('left'), context, node)} ${stringField(node, 'operator') ?? '='} ${printRequired(field('right'), context, node)})`
    case 'SequenceExpression': return `(${array('expressions').map((entry) => print(entry, context)).join(', ')})`
    case 'BinaryExpression':
    case 'LogicalExpression': return `(${printRequired(field('left'), context, node)} ${stringField(node, 'operator') ?? '??'} ${printRequired(field('right'), context, node)})`
    case 'UnaryExpression': return `(${stringField(node, 'operator') ?? ''}${booleanField(node, 'prefix') === false ? ' ' : ''}${printRequired(field('argument'), context, node)})`
    case 'UpdateExpression': return booleanField(node, 'prefix') === false ? `${printRequired(field('argument'), context, node)}${stringField(node, 'operator') ?? ''}` : `${stringField(node, 'operator') ?? ''}${printRequired(field('argument'), context, node)}`
    case 'ConditionalExpression': return `(${printRequired(field('test'), context, node)} ? ${printRequired(field('consequent'), context, node)} : ${printRequired(field('alternate'), context, node)})`
    case 'MemberExpression': {
      const object = printRequired(field('object'), context, node)
      const property = field('property')
      if (property === undefined) throw unsupported(node, context)
      if (booleanField(node, 'computed') === true) return `${object}[${print(property, context)}]`
      const propertyIdentifier = stringField(property, 'name')
      if (propertyIdentifier === undefined) throw unsupported(node, context)
      return `${object}.${propertyIdentifier}`
    }
    case 'CanonicalMemberPath': {
      const root = printRequired(field('root'), context, node)
      const rawPath = node.fields.path
      if (!Array.isArray(rawPath) || rawPath.some((entry) => typeof entry !== 'string')) throw unsupported(node, context)
      return rawPath.reduce((output, property) => `${output}.${property}`, root)
    }
    case 'CallExpression': {
      const callee = field('callee')
      const args = array('arguments')
      if (callee?.type === 'Identifier' && stringField(callee, 'name') === 'require' && args.length === 1) {
        const specifier = literalString(args[0] as SyntaxNode)
        if (specifier !== undefined) return `$app_require$(${quote(context.targetBySpecifier.get(specifier) ?? specifier)})`
      }
      if (callee?.type === 'MemberExpression') {
        const object = nodeField(callee, 'object')
        const property = nodeField(callee, 'property')
        if (object?.type === 'Identifier' && stringField(object, 'name') === 'require' && property?.type === 'Identifier' && stringField(property, 'name') === 'context') {
          const reference = context.contextByStartByte.get(node.span.startByte)
          if (reference === undefined) throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, 'Static require.context is absent from the Canonical module references', context.module.source.sourcePath, node.span)
          return printStaticContext(reference, context)
        }
      }
      return `${printRequired(callee, context, node)}(${args.map((entry) => print(entry, context)).join(', ')})`
    }
    case 'NewExpression': return `new ${printRequired(field('callee'), context, node)}(${array('arguments').map((entry) => print(entry, context)).join(', ')})`
    case 'FunctionExpression': return printFunction(node, context, false)
    case 'ArrowFunctionExpression': return printFunction(node, context, true)
    case 'FunctionDeclaration': return printFunction(node, context, false)
    case 'BlockStatement': return `{ ${array('body').map((entry) => printStatement(entry, context)).join(' ')} }`
    case 'ReturnStatement': return `return${field('argument') === undefined ? '' : ` ${printRequired(field('argument'), context, node)}`}`
    case 'IfStatement': return `if (${printRequired(field('test'), context, node)}) ${printStatementRequired(field('consequent'), context, node)}${field('alternate') === undefined ? '' : ` else ${printStatementRequired(field('alternate'), context, node)}`}`
    case 'ThrowStatement': return `throw ${printRequired(field('argument'), context, node)}`
    case 'TryStatement': return `try ${printStatementRequired(field('block'), context, node)}${field('handler') === undefined ? '' : ` catch ${printCatchRequired(field('handler'), context, node)}`}${field('finalizer') === undefined ? '' : ` finally ${printStatementRequired(field('finalizer'), context, node)}`}`
    case 'ForInStatement': return `for (${printRequired(field('left'), context, node)} in ${printRequired(field('right'), context, node)}) ${printStatementRequired(field('body'), context, node)}`
    case 'ForOfStatement': return `for (${printRequired(field('left'), context, node)} of ${printRequired(field('right'), context, node)}) ${printStatementRequired(field('body'), context, node)}`
    case 'AwaitExpression': return `await ${printRequired(field('argument'), context, node)}`
    case 'TemplateLiteral': {
      const quasis = array('quasis')
      const expressions = array('expressions')
      if (quasis.length !== expressions.length + 1) throw unsupported(node, context)
      let output = '`'
      for (let index = 0; index < quasis.length; index += 1) {
        const quasiValue = stringField(quasis[index] as SyntaxNode, 'value') ?? ''
        output += quasiValue.replace(/[`\\]/g, '\\$&')
        if (index < expressions.length) output += `\${${print(expressions[index] as SyntaxNode, context)}}`
      }
      return output + '`'
    }
    case 'ObjectPattern': return `{ ${array('properties').map((entry) => printProperty(entry, context)).join(', ')} }`
    case 'ArrayPattern': return `[${array('elements').map((entry) => print(entry, context)).join(', ')}]`
    case 'AssignmentPattern': return `${printRequired(field('left'), context, node)} = ${printRequired(field('right'), context, node)}`
    case 'RestElement': return `...${printRequired(field('argument'), context, node)}`
    case 'EmptyStatement': return ''
    default: throw unsupported(node, context)
  }
}

function printStatement(node: SyntaxNode, context: PrinterContext): string {
  const output = print(node, context)
  return output.length === 0 ? '' : `${output}${needsTerminator(node) ? ';' : ''}`
}

function printStatementRequired(node: SyntaxNode | undefined, context: PrinterContext, owner: SyntaxNode): string {
  if (node === undefined) throw unsupported(owner, context)
  return printStatement(node, context)
}

function printProperty(node: SyntaxNode, context: PrinterContext): string {
  if (node.type === 'SpreadElement') return print(node, context)
  if (node.type !== 'Property') throw unsupported(node, context)
  const key = nodeField(node, 'key')
  const value = nodeField(node, 'value')
  if (key === undefined || value === undefined) throw unsupported(node, context)
  const keyText = booleanField(node, 'computed') === true ? `[${print(key, context)}]` : printPropertyKey(key, context)
  if (booleanField(node, 'method') === true && (value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression')) {
    const params = nodeArray(value, 'params').map((entry) => print(entry, context)).join(', ')
    const body = nodeField(value, 'body')
    if (body === undefined) throw unsupported(node, context)
    return `${keyText}(${params}) ${print(body, context)}`
  }
  if (booleanField(node, 'shorthand') === true) {
    const name = stringField(key, 'name')
    if (name !== undefined && context.aliases?.has(name) === true) return `${keyText}: scope[${quote(name)}]`
    if (name !== undefined && context.stateBindings?.has(name) === true) return `${keyText}: this.${name}`
    return keyText
  }
  return `${keyText}: ${print(value, context)}`
}

function printPageVm(defaultExport: SyntaxNode, page: CanonicalLoweredPageModel, context: PrinterContext, frameworkModuleId?: string): string {
  if (defaultExport.type !== 'ObjectExpression') throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, 'Page default export must be an object', context.module.source.sourcePath, defaultExport.span)
  const members = nodeArray(defaultExport, 'properties').filter((entry) => entry.type !== 'Property' || propertyName(entry) !== 'private')
  const fields = page.stateFields.map((field) => `${quote(field.name)}: ${print(field.initializer, context)}`)
  const projectedMembers = members.map((entry) => printProperty(entry, context))
  const bindings = page.bindings
    .filter((binding) => binding.scope.kind === 'page')
    .map((binding) => `${quote(String(binding.templateBindingId))}: { deps: ${JSON.stringify(binding.evaluator.kind === 'expression' ? binding.evaluator.expression.stateBindings : binding.evaluator.segments.flatMap((segment) => segment.kind === 'expression' ? segment.expression.stateBindings : []))}, evaluate: function () { return ${printEvaluator(binding.evaluator, context)}; } }`)
  const blocks = page.blocks.map((block) => {
    const parent = page.nodes.find((node) => node.templateNodeId === block.parentTemplateNodeId)
    const childIndex = parent?.children.findIndex((child) => child.kind === 'block' && child.templateBlockId === block.templateBlockId) ?? -1
    if (parent === undefined || childIndex < 0) throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, `Block parent position is absent: ${block.templateBlockId}`, context.module.source.sourcePath, block.source.span)
    const staticIndex = parent.children.slice(0, childIndex).filter((child) => child.kind === 'node').length
    const blockBindings = page.bindings
      .filter((binding) => binding.scope.kind === 'block' && binding.scope.templateBlockId === block.templateBlockId)
      .map((binding) => `${quote(String(binding.templateBindingId))}: function (scope) { return ${printEvaluator(binding.evaluator, context)}; }`)
    const blockHandlers = page.handlers
      .filter((handler) => handler.scope.kind === 'block' && handler.scope.templateBlockId === block.templateBlockId)
      .map((handler) => `{ templateHandlerId: ${handler.templateHandlerId} }`)
    const handlerText = `[${blockHandlers.join(', ')}]`
    if (block.controller.kind === 'if') {
      return `${quote(String(block.templateBlockId))}: { templateBlockId: ${block.templateBlockId}, kind: "if", parentTemplateNodeId: ${block.parentTemplateNodeId}, staticIndex: ${staticIndex}, deps: ${JSON.stringify(block.controller.predicate.stateBindings)}, bindings: { ${blockBindings.join(', ')} }, handlers: ${handlerText}, evaluate: function (scope) { return ${printExpression(block.controller.predicate, context)}; } }`
    }
    const deps = [...new Set([...block.controller.iterable.stateBindings, ...block.controller.keyExpression.stateBindings])].sort(compareUtf8)
    return `${quote(String(block.templateBlockId))}: { templateBlockId: ${block.templateBlockId}, kind: "for", parentTemplateNodeId: ${block.parentTemplateNodeId}, staticIndex: ${staticIndex}, deps: ${JSON.stringify(deps)}, indexAlias: ${quote(block.controller.indexAlias)}, itemAlias: ${quote(block.controller.itemAlias)}, bindings: { ${blockBindings.join(', ')} }, handlers: ${handlerText}, evaluate: function (scope) { return ${printExpression(block.controller.iterable, context)}; }, key: function (scope) { return ${printExpression(block.controller.keyExpression, context)}; } }`
  })
  const target = `{ ${[...fields, ...projectedMembers].join(', ')} }`
  const dependencyAlias = (moduleId: string): string => `__qak_dep_${createHash('sha256').update(moduleId, 'utf8').digest('hex').slice(0, 12)}`
  const linkMethods = page.handlers.filter((handler) => handler.action?.kind === 'url').map((handler) => {
    const action = handler.action
    if (action === undefined || action.kind !== 'url') throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, 'URL handler action is absent', context.module.source.sourcePath, handler.source.span)
    const expression = action.mode === 'router'
      ? `${dependencyAlias('@app-module/system.router')}.default.push({ uri: ${quote(action.url)} })`
      : action.mode === 'external'
        ? `${dependencyAlias('@app-module/system.openUrl')}.default.open({ url: ${quote(action.url)} })`
        : `${dependencyAlias('@app-module/system.webview')}.default.open({ url: ${quote(action.url)} })`
    return `target[${quote(handler.methodName)}] = function () { return ${expression}; };`
  })
  const vmFactory = frameworkModuleId === undefined ? '__qak_reactive_page_vm__' : `${dependencyAlias(frameworkModuleId)}.default.createReactivePageVm`
  return linkMethods.length === 0
    ? `${vmFactory}(${target}, context, { ${bindings.join(', ')} }, { ${blocks.join(', ')} })`
    : `${vmFactory}((function () { const target = ${target}; ${linkMethods.join(' ')} return target; })(), context, { ${bindings.join(', ')} }, { ${blocks.join(', ')} })`
}

function printStaticContext(reference: CanonicalModuleReference, context: PrinterContext): string {
  const members = reference.contextMembers
  if (members === undefined) throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, 'Static require.context has no Canonical member expansion', context.module.source.sourcePath, reference.source.span)
  const entries = members.map((member) => `${quote(member.key)}: function () { return $app_require$(${quote(member.moduleId)}); }`)
  const keys = JSON.stringify(members.map((member) => member.key))
  return `(function () { const modules = { ${entries.join(', ')} }; const load = function (key) { const factory = modules[key]; if (factory === undefined) { throw new Error("Unknown static module: " + key); } return factory(); }; load.keys = function () { return ${keys}; }; return load; })()`
}

function validatePackageGraph(model: CanonicalLoweredAppModel): void {
  const modules = [model.appModule, ...model.sharedModules, ...model.pages.map((page) => page.module)]
  const byId = new Map(modules.map((module) => [module.moduleId, module]))
  for (const module of modules) {
    const sorted = [...new Set(module.dependencies)].sort(compareUtf8)
    if (JSON.stringify(sorted) !== JSON.stringify(module.dependencies)) throw new EmitterIssue(ErrorCodes.emitterInputInvalid, `Module dependencies are not unique and deterministic: ${module.moduleId}`, module.source.sourcePath, module.source.span)
    for (const dependency of module.dependencies) {
      const target = byId.get(dependency)
      if (dependency === module.moduleId) throw new EmitterIssue(ErrorCodes.emitterInputInvalid, `Module cannot depend on itself: ${module.moduleId}`, module.source.sourcePath, module.source.span)
      if (dependency.startsWith('@app-module/')) throw new EmitterIssue(ErrorCodes.emitterInputInvalid, `Typed facade cannot enter package dependencies: ${dependency}`, module.source.sourcePath, module.source.span)
      if (target === undefined) throw new EmitterIssue(ErrorCodes.emitterInputInvalid, `Package dependency is absent: ${dependency}`, module.source.sourcePath, module.source.span)
      const valid = module.moduleKind === 'page' ? target.moduleKind === 'app' || target.moduleKind === 'shared' : target.moduleKind === 'shared'
      if (!valid) throw new EmitterIssue(ErrorCodes.emitterInputInvalid, `Invalid ${module.moduleKind} dependency: ${dependency}`, module.source.sourcePath, module.source.span)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (moduleId: string): void => {
    if (visiting.has(moduleId)) throw new EmitterIssue(ErrorCodes.emitterInputInvalid, `Shared module dependency cycle: ${moduleId}`)
    if (visited.has(moduleId)) return
    visiting.add(moduleId)
    for (const dependency of byId.get(moduleId)?.dependencies ?? []) if (byId.get(dependency)?.moduleKind === 'shared') visit(dependency)
    visiting.delete(moduleId)
    visited.add(moduleId)
  }
  for (const module of model.sharedModules) visit(module.moduleId)
}

function printPropertyKey(node: SyntaxNode, context: PrinterContext): string {
  return node.type === 'Identifier' ? (stringField(node, 'name') ?? unsupported(node, context).message) : print(node, context)
}

function printFunction(node: SyntaxNode, context: PrinterContext, arrow: boolean): string {
  const params = nodeArray(node, 'params').map((entry) => print(entry, context)).join(', ')
  const body = nodeField(node, 'body')
  if (body === undefined) throw unsupported(node, context)
  const asyncPrefix = booleanField(node, 'async') === true ? 'async ' : ''
  if (arrow) return `${asyncPrefix}(${params}) => ${print(body, context)}`
  const id = nodeField(node, 'id')
  const name = id === undefined ? '' : ` ${stringField(id, 'name') ?? ''}`
  const generator = booleanField(node, 'generator') === true ? '*' : ''
  return `${asyncPrefix}function${generator}${name}(${params}) ${print(body, context)}`
}

function printCatch(node: SyntaxNode, context: PrinterContext): string {
  const param = nodeField(node, 'param')
  const body = nodeField(node, 'body')
  if (body === undefined) throw unsupported(node, context)
  return `(${param === undefined ? '' : print(param, context)}) ${print(body, context)}`
}

function printCatchRequired(node: SyntaxNode | undefined, context: PrinterContext, owner: SyntaxNode): string {
  if (node === undefined) throw unsupported(owner, context)
  return printCatch(node, context)
}

function printRequired(node: SyntaxNode | undefined, context: PrinterContext, owner: SyntaxNode): string {
  if (node === undefined) throw unsupported(owner, context)
  return print(node, context)
}

function findDefaultExport(program: SyntaxNode): SyntaxNode | undefined {
  const declaration = nodeArray(program, 'body').find((node) => node.type === 'ExportDefaultDeclaration')
  return declaration === undefined ? undefined : nodeField(declaration, 'declaration')
}
function countDefaultExports(program: SyntaxNode): number { return nodeArray(program, 'body').filter((node) => node.type === 'ExportDefaultDeclaration').length }
function needsTerminator(node: SyntaxNode): boolean {
  return !['BlockStatement', 'IfStatement', 'TryStatement', 'ForInStatement', 'ForOfStatement', 'FunctionDeclaration', 'EmptyStatement'].includes(node.type)
}
function literalString(node: SyntaxNode): string | undefined { const value = node.fields.value; return typeof value === 'string' ? value : undefined }
function literalText(node: SyntaxNode, context: PrinterContext): string {
  const value = node.fields.value
  if (typeof value === 'string') return quote(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  const raw = stringField(node, 'raw')
  if (raw !== undefined && /^\//.test(raw)) return raw
  throw unsupported(node, context)
}
function quote(value: string): string { return JSON.stringify(value) }
function unsupported(node: SyntaxNode, context: PrinterContext): EmitterIssue { return new EmitterIssue(ErrorCodes.emitterJsUnsupported, `Unsupported JavaScript syntax: ${node.type}`, context.module.source.sourcePath, node.span) }
function bundlePath(module: CanonicalModuleEntry, page: CanonicalLoweredPageModel | undefined): string {
  if (module.moduleKind === 'app') return 'app.js'
  if (module.moduleKind === 'page') {
    if (page === undefined) throw new EmitterIssue(ErrorCodes.emitterAbiInvalid, `Page is absent for module: ${module.moduleId}`, module.source.sourcePath, module.source.span)
    return `pages/${page.manifestRoute}/index.js`
  }
  const hash = createHash('sha256').update(module.moduleId, 'utf8').digest('hex')
  return `shared/${hash}.js`
}
function createSourceMap(path: string, module: CanonicalModuleEntry | undefined, content: string, limits: EmitterLimits): { readonly path: string; readonly content: string } {
  const mappings = content.split('\n').slice(0, -1).map(() => 'AAAA').join(';')
  const sourcePath = module?.source.sourcePath ?? path
  if (1 > limits.maxSourceMapSources || content.split('\n').length > limits.maxSourceMapSegments) throw new EmitterIssue(ErrorCodes.emitterSourceMapFailed, `Source Map budget exceeded: ${module?.moduleId ?? path}`, module?.source.sourcePath, module?.source.span)
  const value = { version: 3, file: path, sources: [sourcePath], names: [], mappings }
  return Object.freeze({ path: `${path}.map`, content: `${JSON.stringify(value)}\n` })
}
function utf8ByteLength(value: string): number { return Buffer.byteLength(value, 'utf8') }
function compareUtf8(left: string, right: string): number { return Buffer.from(left).compare(Buffer.from(right)) }
function isCancellation(value: unknown): boolean { return value instanceof Error && value.name === 'OperationCancelledError' }
function cancelledDiagnostic(): Diagnostic { return Object.freeze({ severity: 'error', code: ErrorCodes.emitterCancelled, phase: 'build', message: 'JavaScript emission was cancelled', hint: 'Retry the build without cancellation.' }) }
function invalidDiagnostic(message: string): Diagnostic { return Object.freeze({ severity: 'error', code: ErrorCodes.emitterInputInvalid, phase: 'build', message, hint: 'Provide the verified immutable CanonicalLoweredAppModel.' }) }
