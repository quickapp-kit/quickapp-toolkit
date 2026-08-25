import path from 'node:path'
import { OperationCancelledError } from '../../application/cancellation.js'
import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import { sortDiagnostics } from '../../diagnostics/diagnostic.js'
import { ErrorCodes } from '../../diagnostics/error-codes.js'
import { deepFreeze } from '../immutable.js'
import type {
  ParsedSource,
  ParsedUxSource,
  SourceSpan,
  SyntaxNode,
  TemplateAttributeSyntax,
  TemplateElementSyntax,
  TemplateTextSyntax,
} from '../frontend/types.js'
import type { ModuleNode } from '../module-graph/types.js'
import { LoweringBudget } from './budget.js'
import { LoweringIssue } from './lowering-issue.js'
import { lowerStyles, type StyleTarget } from './style-lowerer.js'
import {
  assertDeepFrozen,
  booleanField,
  buildMethodIndex,
  defaultObjectProperties,
  expression,
  location,
  nodeArray,
  nodeField,
  propertyName,
  templateAttribute,
  textSegments,
  countSyntaxNodes,
} from './syntax.js'
import type {
  CanonicalBinding,
  CanonicalBindingEvaluator,
  CanonicalBlock,
  CanonicalChild,
  CanonicalForController,
  CanonicalHandler,
  CanonicalHost,
  CanonicalIfController,
  CanonicalLoweredAppModel,
  CanonicalLoweredPageModel,
  CanonicalModuleEntry,
  CanonicalModuleReference,
  CanonicalNode,
  CanonicalScope,
  CanonicalStateField,
  CanonicalStyle,
  CanonicalLoweringRequest,
  CanonicalLoweringResult,
} from './types.js'
import { DEFAULT_LOWERING_LIMITS } from './types.js'

interface MutableNode {
  readonly templateNodeId: number
  readonly source: { readonly sourcePath: string; readonly span: SourceSpan }
  readonly classes: readonly string[]
  readonly ancestors: readonly (readonly string[])[]
  readonly children: CanonicalChild[]
  readonly hostType: CanonicalHost['type']
  readonly props: Record<string, string | boolean | number>
  style: CanonicalStyle
}

interface PageScratch {
  readonly nodes: MutableNode[]
  readonly bindings: CanonicalBinding[]
  readonly blocks: CanonicalBlock[]
  readonly handlers: CanonicalHandler[]
  readonly styleTargets: StyleTarget[]
  readonly stateSymbols: ReadonlySet<string>
  nextNodeId: number
  nextBindingId: number
  nextBlockId: number
  nextHandlerId: number
}

export class CanonicalLowerer {
  lower(request: CanonicalLoweringRequest): CanonicalLoweringResult {
    try {
      request.cancellation.throwIfCancelled()
      const limits = request.limits ?? DEFAULT_LOWERING_LIMITS
      validateInput(request)
      const budget = new LoweringBudget(limits)
      const model = new LoweringSession(request, budget).run()
      request.cancellation.throwIfCancelled()
      return deepFreeze({ status: 'success', model, diagnostics: Object.freeze([]) } as const)
    } catch (error) {
      if (error instanceof OperationCancelledError) return { status: 'failure', diagnostics: Object.freeze([cancelledDiagnostic()]) }
      if (error instanceof LoweringIssue) return { status: 'failure', diagnostics: Object.freeze(sortDiagnostics([error.diagnostic])) }
      if (error instanceof TypeError) return { status: 'failure', diagnostics: Object.freeze([inputDiagnostic(error.message)]) }
      return { status: 'failure', diagnostics: Object.freeze([inputDiagnostic('Unexpected Canonical Lowering failure')]) }
    }
  }
}

class LoweringSession {
  readonly #request: CanonicalLoweringRequest
  readonly #budget: LoweringBudget

  constructor(request: CanonicalLoweringRequest, budget: LoweringBudget) {
    this.#request = request
    this.#budget = budget
  }

  run(): CanonicalLoweredAppModel {
    const model = this.#request.resolvedAppModel
    const appModule = this.lowerModule(model.appModule)
    const sharedModules = model.sharedModules
      .slice()
      .sort((left, right) => compareText(left.moduleId, right.moduleId))
      .map((module) => this.lowerModule(module))
    const pages: CanonicalLoweredPageModel[] = []
    for (const module of model.pageModules.slice().sort((left, right) => compareText(left.manifestRoute ?? '', right.manifestRoute ?? ''))) {
      this.#budget.charge('pages', 1, module.sourcePath)
      pages.push(this.lowerPage(module))
    }
    return {
      modelVersion: 1,
      packageName: model.manifest.packageName,
      appModule,
      sharedModules: Object.freeze(sharedModules),
      pages: Object.freeze(pages),
    }
  }

  lowerModule(module: ModuleNode): CanonicalModuleEntry {
    const parsed = this.#request.parsedSourceModel.get(module.sourcePath)
    if (parsed === undefined) throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Module source is absent from ParsedSourceModel: ' + module.sourcePath, module.sourcePath)
    const program = scriptProgram(parsed)
    const references = this.moduleReferences(module, parsed)
    const dependencies = [...new Set(references
      .filter((reference) => reference.kind !== 'capability')
      .flatMap((reference) => reference.targets)
      .filter((target) => target !== module.moduleId))].sort(compareText)
    return {
      moduleId: module.moduleId,
      moduleKind: module.kind,
      dependencies: Object.freeze(dependencies),
      program,
      references: Object.freeze(references),
      source: location(module.sourcePath, program.span),
    }
  }

  moduleReferences(module: ModuleNode, parsed: ParsedSource): readonly CanonicalModuleReference[] {
    const references: CanonicalModuleReference[] = []
    for (const reference of parsed.references) {
      if (reference.kind !== 'scriptImport' && reference.kind !== 'scriptRequire' && reference.kind !== 'scriptContext' && reference.kind !== 'capability') continue
      const edges = this.#request.resolvedAppModel.graph.edges.filter((edge) =>
        edge.fromModuleId === module.moduleId &&
        (reference.kind === 'capability' ? edge.kind === 'capability' : edge.kind === 'script') &&
        edge.specifier === reference.specifier &&
        edge.references.some((evidence) => evidence.sourcePath === reference.ownerSourcePath && evidence.span.startByte === reference.span.startByte),
      )
      if (edges.length === 0) throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Resolved module reference is missing a graph edge: ' + reference.specifier, reference.ownerSourcePath, reference.span)
      const rawTargets = [...new Set(edges.map((edge) => edge.target))].sort(compareText)
      const targets = reference.kind === 'capability'
        ? Object.freeze([normalizeCapabilityId(reference.specifier)])
        : Object.freeze(rawTargets.filter((target) => target !== module.moduleId))
      const contextMembers = reference.kind === 'scriptContext'
        ? Object.freeze(targets.map((target) => ({ key: contextKey(reference.ownerSourcePath, reference.specifier, sourcePathForModule(this.#request.resolvedAppModel, target)), moduleId: target })).sort((left, right) => compareText(left.key, right.key)))
        : undefined
      this.#budget.charge('provenance', 1, reference.ownerSourcePath, reference.span)
      references.push({
        kind: reference.kind === 'capability' ? 'capability' : reference.kind === 'scriptContext' ? 'context' : 'module',
        specifier: reference.specifier,
        targets,
        ...(contextMembers === undefined ? {} : { contextMembers }),
        source: location(reference.ownerSourcePath, reference.span),
      })
    }
    return Object.freeze(references.sort((left, right) => left.source.span.startByte - right.source.span.startByte || compareText(left.specifier, right.specifier)))
  }

  lowerPage(module: ModuleNode): CanonicalLoweredPageModel {
    this.#request.cancellation.throwIfCancelled()
    const parsed = this.#request.parsedSourceModel.get(module.sourcePath)
    if (parsed === undefined || parsed.sourceKind !== 'pageUx' || parsed.template === undefined) {
      throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Page source does not contain a verified template: ' + module.sourcePath, module.sourcePath)
    }
    const pageModule = this.lowerModule(module)
    const stateFields = lowerStateFields(parsed.script, module.sourcePath)
    const stateSymbols = new Set(stateFields.map((field) => field.name))
    const scratch: PageScratch = {
      nodes: [],
      bindings: [],
      blocks: [],
      handlers: [],
      styleTargets: [],
      stateSymbols,
      nextNodeId: 1,
      nextBindingId: 1,
      nextBlockId: 1,
      nextHandlerId: 1,
    }
    this.lowerElement(parsed, parsed.template.root, scratch, { kind: 'page' }, new Set<string>(), [], undefined, true, false)
    const root = scratch.nodes[0]
    if (root === undefined) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Canonical page has no root Node', module.sourcePath, parsed.template.root.span)
    lowerStyles({
      ownerModuleId: module.moduleId,
      rootSourcePath: module.sourcePath,
      rootSource: parsed,
      model: this.#request.resolvedAppModel,
      parsedSources: this.#request.parsedSourceModel,
      targets: scratch.styleTargets,
      budget: this.#budget,
      cancellation: this.#request.cancellation,
    })
    for (let index = 0; index < scratch.nodes.length; index += 1) {
      scratch.nodes[index]!.style = scratch.styleTargets[index]?.style ?? Object.freeze({})
    }
    const page: CanonicalLoweredPageModel = {
      manifestRoute: module.manifestRoute as string,
      route: module.route as string,
      moduleId: module.moduleId,
      module: pageModule,
      templateId: 'page:' + module.route,
      stateFields,
      rootTemplateNodeId: root.templateNodeId,
      nodes: Object.freeze(scratch.nodes.map((node) => this.freezeNode(node))),
      bindings: Object.freeze(scratch.bindings.slice().sort((left, right) => left.templateBindingId - right.templateBindingId)),
      blocks: Object.freeze(scratch.blocks.slice().sort((left, right) => left.templateBlockId - right.templateBlockId)),
      handlers: Object.freeze(scratch.handlers.slice().sort((left, right) => left.templateHandlerId - right.templateHandlerId)),
    }
    validatePage(page)
    return page
  }

  lowerElement(
    page: ParsedUxSource,
    element: TemplateElementSyntax,
    scratch: PageScratch,
    scope: CanonicalScope,
    aliases: ReadonlySet<string>,
    ancestors: readonly (readonly string[])[],
    parent: MutableNode | undefined,
    isRoot: boolean,
    isBlockRoot: boolean,
  ): MutableNode {
    this.#request.cancellation.throwIfCancelled()
    this.#budget.claimDepth(ancestors.length + 1, page.sourcePath, element.span)
    const ifAttribute = templateAttribute(element, 'if')
    const forAttribute = templateAttribute(element, 'for')
    if (isRoot && (ifAttribute !== undefined || forAttribute !== undefined)) {
      throw new LoweringIssue(ErrorCodes.loweringBlockInvalid, 'Page root cannot be a Block root', page.sourcePath, (ifAttribute ?? forAttribute)?.span)
    }
    if (ifAttribute !== undefined && forAttribute !== undefined) {
      throw new LoweringIssue(ErrorCodes.loweringBlockInvalid, 'One element cannot contain both if and for', page.sourcePath, element.span)
    }
    const classes = classTokens(element, page.sourcePath)
    const hostInfo = this.hostFor(element, page, scratch, scope, aliases)
    this.#budget.charge('nodes', 1, page.sourcePath, element.span)
    this.#budget.charge('provenance', 1, page.sourcePath, element.span)
    const node: MutableNode = {
      templateNodeId: scratch.nextNodeId++,
      source: location(page.sourcePath, element.span),
      classes,
      ancestors,
      children: [],
      hostType: hostInfo.type,
      props: hostInfo.props,
      style: Object.freeze({}),
    }
    scratch.nodes.push(node)
    scratch.styleTargets.push({ sourcePath: page.sourcePath, span: element.span, classes, ancestors, style: node.style })
    if (parent !== undefined && !isBlockRoot) parent.children.push({ kind: 'node', templateNodeId: node.templateNodeId })
    this.addBindingAndHandler(element, node, page, scratch, scope)
    for (const child of element.children) {
      if (child.kind !== 'element') continue
      const childIf = templateAttribute(child, 'if')
      const childFor = templateAttribute(child, 'for')
      if (childIf !== undefined || childFor !== undefined) {
        const directive = (childIf ?? childFor) as TemplateAttributeSyntax
        const blockId = scratch.nextBlockId++
        this.#budget.charge('blocks', 1, page.sourcePath, directive.span)
        this.#budget.charge('provenance', 1, page.sourcePath, directive.span)
        const blockScope: CanonicalScope = { kind: 'block', templateBlockId: blockId }
        const blockAliases = childFor === undefined
          ? aliases
          : new Set([...aliases, childFor.forAliases?.index as string, childFor.forAliases?.item as string])
        const blockChild: CanonicalChild = { kind: 'block', templateBlockId: blockId }
        node.children.push(blockChild)
        const controller = childFor !== undefined
          ? this.forController(child, childFor, page, aliases, blockAliases, scratch.stateSymbols)
          : this.ifController(childIf as TemplateAttributeSyntax, page, aliases, scratch.stateSymbols)
        const rootNode = this.lowerElement(page, child, scratch, blockScope, blockAliases, [...ancestors, classes], node, false, true)
        scratch.blocks.push({
          templateBlockId: blockId,
          kind: childFor === undefined ? 'if' : 'for',
          parentTemplateNodeId: node.templateNodeId,
          templateRootNodeId: rootNode.templateNodeId,
          controller,
          source: location(page.sourcePath, directive.span),
        })
        continue
      }
      this.lowerElement(page, child, scratch, scope, aliases, [...ancestors, classes], node, false, false)
    }
    return node
  }

  hostFor(element: TemplateElementSyntax, page: ParsedUxSource, scratch: PageScratch, scope: CanonicalScope, aliases: ReadonlySet<string>): { readonly type: CanonicalHost['type']; readonly props: Record<string, string | boolean | number> } {
    const tag = element.tagName
    const typeAttribute = templateAttribute(element, 'type')
    const valueAttribute = templateAttribute(element, 'value')
    const checkedAttribute = templateAttribute(element, 'checked')
    const selectedAttribute = templateAttribute(element, 'selected')
    const tidAttribute = templateAttribute(element, 'tid')
    if (tidAttribute !== undefined && templateAttribute(element, 'for') === undefined) {
      throw new LoweringIssue(ErrorCodes.loweringBlockInvalid, 'tid is only valid on a keyed for element', page.sourcePath, tidAttribute.span)
    }
    if (tag === 'div') {
      if (typeAttribute !== undefined || valueAttribute !== undefined) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'View cannot receive input props', page.sourcePath, (typeAttribute ?? valueAttribute)?.span)
      return { type: 'View', props: {} }
    }
    if (tag === 'text') {
      if (typeAttribute !== undefined || valueAttribute !== undefined) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Text cannot receive input props', page.sourcePath, (typeAttribute ?? valueAttribute)?.span)
      const segments = element.children.filter((child): child is TemplateTextSyntax => child.kind === 'text').flatMap(textSegments)
      if (element.children.some((child) => child.kind === 'element')) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Text cannot contain an element child in V1', page.sourcePath, element.span)
      const hasExpression = segments.some((segment) => segment.expression !== undefined)
      const text = hasExpression ? '' : segments.map((segment) => segment.literal).join('')
      if (hasExpression) {
        const binding = this.bindingForText(segments, page, scope, aliases, scratch)
        scratch.bindings.push(binding)
      }
      return { type: 'Text', props: { text } }
    }
    if (tag === 'image') {
      if (typeAttribute !== undefined || valueAttribute !== undefined || element.children.some((child) => child.kind === 'element' || (child.kind === 'text' && child.value.trim() !== ''))) {
        throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Image accepts only a static src prop in V1', page.sourcePath, element.span)
      }
      const srcAttribute = templateAttribute(element, 'src')
      if (srcAttribute === undefined || !/^assets\/[A-Za-z0-9._/-]+$/.test(srcAttribute.rawValue)) {
        throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Image src must reference an RPK assets path', page.sourcePath, srcAttribute?.span ?? element.span)
      }
      return { type: 'Image', props: { src: srcAttribute.rawValue } }
    }
    if (tag === 'a') {
      const href = templateAttribute(element, 'href')?.rawValue
      const mode = templateAttribute(element, 'open-mode')?.rawValue
      const text = element.children.filter((child): child is TemplateTextSyntax => child.kind === 'text').map((child) => child.value).join('')
      if (element.children.some((child) => child.kind === 'element') || href === undefined || href.length === 0 || text.trim().length === 0) {
        throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Anchor requires one static text label and href', page.sourcePath, element.span)
      }
      if (href.startsWith('/')) {
        if (mode !== undefined && mode !== 'internal') throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Internal anchor open-mode must be internal or omitted', page.sourcePath, element.span)
      } else if (mode !== 'external' && mode !== 'webview') {
        throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'External anchor requires open-mode=external or webview', page.sourcePath, element.span)
      }
      return { type: 'Button', props: { text, enabled: true } }
    }
    if (tag === 'switch') {
      if (typeAttribute !== undefined || valueAttribute !== undefined || element.children.length !== 0) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Switch accepts checked only', page.sourcePath, element.span)
      const checked = checkedAttribute?.rawValue ?? 'false'
      if (checked !== 'true' && checked !== 'false') throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Switch checked must be true or false in B1', page.sourcePath, checkedAttribute?.span ?? element.span)
      return { type: 'Switch', props: { checked: checked === 'true', enabled: true } }
    }
    if (tag === 'slider') {
      if (element.children.length !== 0) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Slider does not accept children', page.sourcePath, element.span)
      const numberAttribute = (name: string, fallback: number): number => {
        const raw = templateAttribute(element, name)?.rawValue
        const value = raw === undefined || raw === '' ? fallback : Number(raw)
        if (!Number.isFinite(value)) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, `Slider ${name} must be finite`, page.sourcePath, templateAttribute(element, name)?.span ?? element.span)
        return value
      }
      const min = numberAttribute('min', 0)
      const max = numberAttribute('max', 100)
      const step = numberAttribute('step', 1)
      const value = numberAttribute('value', min)
      if (max < min || step <= 0 || value < min || value > max) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Slider range or value is invalid', page.sourcePath, element.span)
      return { type: 'Slider', props: { min, max, step, value, enabled: true } }
    }
    if (tag === 'picker') {
      if (typeAttribute?.rawValue !== undefined && typeAttribute.rawValue !== 'text') throw new LoweringIssue(ErrorCodes.loweringComponentUnsupported, 'Only Picker mode=text is supported in B2', page.sourcePath, typeAttribute.span)
      const range = templateAttribute(element, 'range')?.rawValue
      const selectedRaw = templateAttribute(element, 'selected')?.rawValue ?? '0'
      const selected = Number(selectedRaw)
      if (range === undefined || range.length === 0 || !Number.isInteger(selected) || selected < 0) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Picker requires a non-empty range and integer selected index', page.sourcePath, element.span)
      return { type: 'Picker', props: { mode: 'text', range, selected } }
    }
    if (tag === 'tabs') {
      if (element.children.length !== 0 || typeAttribute !== undefined || valueAttribute !== undefined || checkedAttribute !== undefined) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Tabs accepts static items and selected props only', page.sourcePath, element.span)
      const items = templateAttribute(element, 'items')?.rawValue
      const selectedRaw = selectedAttribute?.expression === undefined ? (selectedAttribute?.rawValue ?? '0') : '0'
      const selected = Number(selectedRaw)
      if (items === undefined || items.length === 0 || items.split('|').some((item) => item.trim().length === 0) || !Number.isInteger(selected) || selected < 0) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Tabs requires non-empty pipe-delimited items and a non-negative selected index', page.sourcePath, element.span)
      return { type: 'Tabs', props: { items, selected } }
    }
    if (tag === 'list' || tag === 'scroll') {
      if (typeAttribute !== undefined || valueAttribute !== undefined || checkedAttribute !== undefined) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, `${tag} accepts no host props`, page.sourcePath, element.span)
      return { type: tag === 'list' ? 'List' : 'Scroll', props: {} }
    }
    if (tag === 'video') {
      if (element.children.length !== 0) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Video does not accept children', page.sourcePath, element.span)
      const src = templateAttribute(element, 'src')?.rawValue
      const poster = templateAttribute(element, 'poster')?.rawValue ?? ''
      const booleanAttribute = (name: string): boolean => {
        const raw = templateAttribute(element, name)?.rawValue
        if (raw === undefined || raw === '') return false
        if (raw !== 'true' && raw !== 'false') throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, `Video ${name} must be true or false`, page.sourcePath, templateAttribute(element, name)?.span ?? element.span)
        return raw === 'true'
      }
      if (src === undefined || src.length === 0 || (poster.length > 0 && !/^assets\/[A-Za-z0-9._/-]+$/.test(poster))) {
        throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Video requires a non-empty src and an assets poster path', page.sourcePath, element.span)
      }
      return { type: 'Video', props: { src, poster, autoplay: booleanAttribute('autoplay'), controls: booleanAttribute('controls'), muted: booleanAttribute('muted') } }
    }
    if (tag === 'input') {
      if (typeAttribute?.rawValue === 'text') {
        if (element.children.length !== 0 || valueAttribute?.rawValue.includes('{{')) {
          throw new LoweringIssue(ErrorCodes.loweringBindingInvalid, 'Input text value must be a static V1 value', page.sourcePath, valueAttribute?.span ?? element.span)
        }
        return { type: 'Input', props: { value: valueAttribute?.rawValue ?? '', enabled: true } }
      }
      if (typeAttribute?.rawValue !== 'button') throw new LoweringIssue(ErrorCodes.loweringComponentUnsupported, 'Only input type=button or type=text lowers in V1', page.sourcePath, typeAttribute?.span ?? element.span)
      if (valueAttribute?.rawValue.includes('{{')) throw new LoweringIssue(ErrorCodes.loweringBindingInvalid, 'Dynamic input value is outside the verified V1 frontend contract', page.sourcePath, valueAttribute.span)
      return { type: 'Button', props: { text: valueAttribute?.rawValue ?? '', enabled: true } }
    }
    throw new LoweringIssue(ErrorCodes.loweringComponentUnsupported, 'Unsupported Host Component: ' + tag, page.sourcePath, element.span)
  }

  bindingForText(segments: readonly { readonly literal: string; readonly expression?: SyntaxNode; readonly span: SourceSpan }[], page: ParsedUxSource, scope: CanonicalScope, aliases: ReadonlySet<string>, scratch: PageScratch): CanonicalBinding {
    const canonicalSegments = segments.map((segment) => segment.expression === undefined
      ? { kind: 'literal' as const, value: segment.literal }
      : { kind: 'expression' as const, expression: expression(page.sourcePath, segment.expression, 'displayString', aliases, scratch.stateSymbols) })
    for (const segment of canonicalSegments) {
      if (segment.kind === 'expression') this.#budget.charge('expressionNodes', countSyntaxNodes(segment.expression.ast), page.sourcePath, segment.expression.source.span)
    }
    const evaluator: CanonicalBindingEvaluator = canonicalSegments.length === 1 && canonicalSegments[0]?.kind === 'expression'
      ? { kind: 'expression', expression: canonicalSegments[0].expression }
      : { kind: 'concat', segments: Object.freeze(canonicalSegments) }
    const source = segments.find((segment) => segment.expression !== undefined) ?? segments[0]
    if (source === undefined) throw new LoweringIssue(ErrorCodes.loweringBindingInvalid, 'Binding has no source segment', page.sourcePath, page.template?.root.span)
    this.#budget.charge('bindings', 1, page.sourcePath, source.span)
    this.#budget.charge('provenance', 1, page.sourcePath, source.span)
    return {
      templateBindingId: scratch.nextBindingId++,
      scope,
      target: { templateNodeId: scratch.nextNodeId, name: 'text' },
      evaluator,
      resultType: 'string',
      source: location(page.sourcePath, source.span),
    }
  }

  addBindingAndHandler(element: TemplateElementSyntax, node: MutableNode, page: ParsedUxSource, scratch: PageScratch, scope: CanonicalScope): void {
    const eventNames = node.hostType === 'Button' ? ['onclick'] : node.hostType === 'Input' ? ['oninput', 'onchange', 'onfocus'] : node.hostType === 'Switch' || node.hostType === 'Slider' || node.hostType === 'Picker' || node.hostType === 'Tabs' ? ['onchange'] : node.hostType === 'List' || node.hostType === 'Scroll' ? ['onscroll', 'onscrollend', 'onscrolltop', 'onscrollbottom'] : node.hostType === 'Video' ? ['onprepared', 'onstart', 'onpause', 'onfinish', 'onerror', 'ontimeupdate'] : []
    const eventTypes = new Map([['onclick', 'click' as const], ['oninput', 'input' as const], ['onchange', 'change' as const], ['onfocus', 'focus' as const], ['onscroll', 'scroll' as const], ['onscrollend', 'scrollend' as const], ['onscrolltop', 'scrolltop' as const], ['onscrollbottom', 'scrollbottom' as const], ['onprepared', 'prepared' as const], ['onstart', 'start' as const], ['onpause', 'pause' as const], ['onfinish', 'finish' as const], ['onerror', 'error' as const], ['ontimeupdate', 'timeupdate' as const]])
    let methods: ReadonlyMap<string, SyntaxNode> | undefined
    if (element.tagName === 'a') {
      const href = templateAttribute(element, 'href')?.rawValue as string
      const mode = templateAttribute(element, 'open-mode')?.rawValue
      const handlerId = scratch.nextHandlerId++
      this.#budget.charge('handlers', 1, page.sourcePath, element.span)
      this.#budget.charge('provenance', 1, page.sourcePath, element.span)
      scratch.handlers.push({
        templateHandlerId: handlerId,
        scope,
        templateNodeId: node.templateNodeId,
        eventType: 'click',
        methodName: `__qak_link_${handlerId}`,
        action: { kind: 'url', url: href, mode: href.startsWith('/') ? 'router' : mode === 'webview' ? 'webview' : 'external' },
        source: location(page.sourcePath, element.span),
      })
    }
    if (node.hostType === 'Tabs' && element.attributes.find((attribute) => attribute.name === 'selected')?.expression !== undefined) {
      const attribute = element.attributes.find((candidate) => candidate.name === 'selected') as TemplateAttributeSyntax
      const selected = expression(page.sourcePath, attribute.expression as SyntaxNode, 'identity', new Set<string>(), scratch.stateSymbols)
      this.#budget.charge('expressionNodes', countSyntaxNodes(selected.ast), page.sourcePath, selected.source.span)
      this.#budget.charge('bindings', 1, page.sourcePath, attribute.span)
      this.#budget.charge('provenance', 1, page.sourcePath, attribute.span)
      scratch.bindings.push({ templateBindingId: scratch.nextBindingId++, scope, target: { templateNodeId: node.templateNodeId, name: 'selected' }, evaluator: { kind: 'expression', expression: selected }, resultType: 'number', source: location(page.sourcePath, attribute.span) })
    }
    for (const eventName of eventNames) {
      const attribute = templateAttribute(element, eventName)
      if (attribute === undefined) continue
      if (methods === undefined) {
        try { methods = buildMethodIndex(page.script) } catch (error) {
          throw new LoweringIssue(ErrorCodes.loweringHandlerInvalid, 'Page export default methods are not statically valid', page.sourcePath, attribute.span)
        }
      }
      const methodName = attribute.rawValue
      if (!methods.has(methodName)) throw new LoweringIssue(ErrorCodes.loweringHandlerInvalid, 'Handler method is not present: ' + methodName, page.sourcePath, attribute.span)
      this.#budget.charge('handlers', 1, page.sourcePath, attribute.span)
      this.#budget.charge('provenance', 1, page.sourcePath, attribute.span)
      scratch.handlers.push({
        templateHandlerId: scratch.nextHandlerId++, scope, templateNodeId: node.templateNodeId,
        eventType: eventTypes.get(eventName) as 'click' | 'input' | 'change' | 'focus' | 'scroll' | 'scrollend' | 'scrolltop' | 'scrollbottom' | 'prepared' | 'start' | 'pause' | 'finish' | 'error' | 'timeupdate', methodName,
        source: location(page.sourcePath, attribute.span),
      })
    }
  }

  ifController(attribute: TemplateAttributeSyntax, page: ParsedUxSource, aliases: ReadonlySet<string>, stateSymbols: ReadonlySet<string>): CanonicalIfController {
    const predicate = expression(page.sourcePath, attribute.expression as SyntaxNode, 'boolean', aliases, stateSymbols)
    this.#budget.charge('expressionNodes', countSyntaxNodes(predicate.ast), page.sourcePath, predicate.source.span)
    return { kind: 'if', predicate }
  }

  forController(element: TemplateElementSyntax, attribute: TemplateAttributeSyntax, page: ParsedUxSource, aliases: ReadonlySet<string>, blockAliases: ReadonlySet<string>, stateSymbols: ReadonlySet<string>): CanonicalForController {
    const tid = templateAttribute(element, 'tid')
    if (tid === undefined || !/^[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*$/.test(tid.rawValue)) {
      throw new LoweringIssue(ErrorCodes.loweringBlockInvalid, 'Keyed for requires a static tid property path', page.sourcePath, tid?.span ?? attribute.span)
    }
    const keyPath = tid.rawValue.split('.')
    const itemAlias = element.attributes.find((item) => item.name === 'for')?.forAliases?.item as string
    const itemNode: SyntaxNode = Object.freeze({ type: 'Identifier', span: tid.span, fields: Object.freeze({ name: itemAlias }) })
    const keyAst: SyntaxNode = Object.freeze({
      type: 'CanonicalMemberPath',
      span: tid.span,
      fields: Object.freeze({ root: itemNode, path: Object.freeze(keyPath) }),
    })
    const iterable = expression(page.sourcePath, attribute.expression as SyntaxNode, 'identity', aliases, stateSymbols)
    const keyExpression = expression(page.sourcePath, keyAst, 'identity', blockAliases, stateSymbols)
    this.#budget.charge('expressionNodes', countSyntaxNodes(iterable.ast), page.sourcePath, iterable.source.span)
    this.#budget.charge('expressionNodes', countSyntaxNodes(keyExpression.ast), page.sourcePath, keyExpression.source.span)
    return {
      kind: 'for',
      iterable,
      indexAlias: attribute.forAliases?.index as string,
      itemAlias: attribute.forAliases?.item as string,
      keyPath: Object.freeze(keyPath),
      keyExpression,
    }
  }

  freezeNode(node: MutableNode): CanonicalNode {
    const props = node.hostType === 'View' ? {} : node.hostType === 'Text' ? { text: String(node.props.text ?? '') } : node.hostType === 'Button' ? { text: String(node.props.text ?? ''), enabled: node.props.enabled !== false } : node.hostType === 'Image' ? { src: String(node.props.src ?? '') } : node.hostType === 'Input' ? { value: String(node.props.value ?? ''), enabled: node.props.enabled !== false } : node.hostType === 'Switch' ? { checked: node.props.checked === true, enabled: node.props.enabled !== false } : node.hostType === 'Slider' ? { min: Number(node.props.min), max: Number(node.props.max), step: Number(node.props.step), value: Number(node.props.value), enabled: node.props.enabled !== false } : node.hostType === 'Picker' ? { mode: 'text' as const, range: String(node.props.range ?? ''), selected: Number(node.props.selected) } : node.hostType === 'Video' ? { src: String(node.props.src ?? ''), poster: String(node.props.poster ?? ''), autoplay: node.props.autoplay === true, controls: node.props.controls === true, muted: node.props.muted === true } : node.hostType === 'Tabs' ? { items: String(node.props.items ?? ''), selected: Number(node.props.selected) } : {}
    return {
      templateNodeId: node.templateNodeId,
      host: { type: node.hostType, props, style: node.style } as CanonicalHost,
      children: Object.freeze(node.children.slice()),
      source: node.source,
    }
  }
}

function scriptProgram(source: ParsedSource): SyntaxNode {
  if (source.sourceKind === 'sharedJs') return source.program
  if (source.sourceKind === 'appUx' || source.sourceKind === 'pageUx') return source.script
  throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Style source cannot be lowered as a JavaScript module', source.sourcePath)
}

function lowerStateFields(program: SyntaxNode, sourcePath: string): readonly CanonicalStateField[] {
  const privateProperties = defaultObjectProperties(program).filter((property) => propertyName(property) === 'private')
  if (privateProperties.length === 0) return Object.freeze([])
  if (privateProperties.length !== 1) throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Page export default contains duplicate private state', sourcePath, privateProperties[1]?.span)
  const privateValue = nodeField(privateProperties[0] as SyntaxNode, 'value')
  if (privateValue?.type !== 'ObjectExpression') throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Page private state must be one static object', sourcePath, privateProperties[0]?.span)
  const names = new Set<string>()
  const fields: CanonicalStateField[] = []
  for (const property of nodeArray(privateValue, 'properties')) {
    const name = propertyName(property)
    const initializer = nodeField(property, 'value')
    if (property.type !== 'Property' || name === undefined || initializer === undefined || booleanField(property, 'computed') === true || booleanField(property, 'method') === true || booleanField(property, 'shorthand') === true) {
      throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Page private state requires static named data properties', sourcePath, property.span)
    }
    if (names.has(name)) throw new LoweringIssue(ErrorCodes.loweringInputInvalid, `Duplicate Page private state symbol: ${name}`, sourcePath, property.span)
    assertStaticStateInitializer(initializer, sourcePath)
    names.add(name)
    fields.push({ name, initializer, source: location(sourcePath, property.span) })
  }
  return Object.freeze(fields.sort((left, right) => compareText(left.name, right.name)))
}

function assertStaticStateInitializer(node: SyntaxNode, sourcePath: string): void {
  if (node.type === 'Literal') return
  if (node.type === 'ArrayExpression') {
    for (const entry of nodeArray(node, 'elements')) assertStaticStateInitializer(entry, sourcePath)
    return
  }
  if (node.type === 'ObjectExpression') {
    const names = new Set<string>()
    for (const property of nodeArray(node, 'properties')) {
      const name = propertyName(property)
      const value = nodeField(property, 'value')
      if (property.type !== 'Property' || name === undefined || value === undefined || booleanField(property, 'computed') === true || booleanField(property, 'method') === true || booleanField(property, 'shorthand') === true || names.has(name)) {
        throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Page private state contains a non-static object property', sourcePath, property.span)
      }
      names.add(name)
      assertStaticStateInitializer(value, sourcePath)
    }
    return
  }
  throw new LoweringIssue(ErrorCodes.loweringInputInvalid, `Unsupported Page private state initializer: ${node.type}`, sourcePath, node.span)
}

function normalizeCapabilityId(specifier: string): string {
  if (!/^@system\.[A-Za-z0-9_.-]+$/.test(specifier)) throw new LoweringIssue(ErrorCodes.loweringInputInvalid, `Capability module ID is invalid: ${specifier}`)
  return `@app-module/${specifier.slice(1)}`
}

function sourcePathForModule(model: CanonicalLoweringRequest['resolvedAppModel'], moduleId: string): string {
  const module = model.graph.nodes.find((candidate) => candidate.moduleId === moduleId)
  if (module === undefined) throw new LoweringIssue(ErrorCodes.loweringInputInvalid, `Context target module is absent: ${moduleId}`)
  return module.sourcePath
}

function contextKey(ownerSourcePath: string, specifier: string, targetSourcePath: string): string {
  const root = path.posix.normalize(path.posix.join(path.posix.dirname(ownerSourcePath), specifier))
  const relative = path.posix.relative(root, targetSourcePath)
  if (relative.length === 0 || relative === '..' || relative.startsWith('../')) throw new LoweringIssue(ErrorCodes.loweringInputInvalid, `Context target escapes its root: ${targetSourcePath}`, ownerSourcePath)
  return `./${relative}`
}

function classTokens(element: TemplateElementSyntax, file: string): readonly string[] {
  const value = templateAttribute(element, 'class')?.rawValue ?? ''
  if (value.includes('{{')) throw new LoweringIssue(ErrorCodes.loweringHostPropInvalid, 'Dynamic class is not a canonical V1 value', file, templateAttribute(element, 'class')?.span)
  return Object.freeze(value.split(/\s+/).filter(Boolean))
}


function validateInput(request: CanonicalLoweringRequest): void {
  try {
    assertDeepFrozen(request.resolvedAppModel)
    assertDeepFrozen(request.parsedSourceModel)
  } catch (error) {
    throw new LoweringIssue(ErrorCodes.loweringInputInvalid, error instanceof Error ? error.message : 'Input is not deeply immutable')
  }
  const model = request.resolvedAppModel
  const modules = [model.appModule, ...model.pageModules, ...model.sharedModules]
  const moduleIds = new Set(modules.map((module) => module.moduleId))
  for (const module of modules) {
    const source = request.parsedSourceModel.get(module.sourcePath)
    if (source === undefined) throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Module source is missing: ' + module.sourcePath, module.sourcePath)
    if (!/^[a-f0-9]{64}$/.test(source.sourceSha256)) throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Source hash is not a lowercase SHA-256: ' + module.sourcePath, module.sourcePath)
  }
  for (const page of model.pageModules) {
    if (typeof page.manifestRoute !== 'string' || typeof page.route !== 'string') {
      throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Page module is missing its verified route: ' + page.sourcePath, page.sourcePath)
    }
  }
  for (const edge of model.graph.edges) {
    if (!moduleIds.has(edge.fromModuleId)) throw new LoweringIssue(ErrorCodes.loweringInputInvalid, 'Graph edge owner is absent: ' + edge.fromModuleId)
  }
}

function validatePage(page: CanonicalLoweredPageModel): void {
  const nodes = new Map(page.nodes.map((node) => [node.templateNodeId, node]))
  const blocks = new Map(page.blocks.map((block) => [block.templateBlockId, block]))
  assertContiguousIds(page.nodes.map((node) => node.templateNodeId), 'TemplateNodeId')
  assertContiguousIds(page.blocks.map((block) => block.templateBlockId), 'TemplateBlockId')
  assertContiguousIds(page.bindings.map((binding) => binding.templateBindingId), 'TemplateBindingId')
  assertContiguousIds(page.handlers.map((handler) => handler.templateHandlerId), 'TemplateHandlerId')
  if (page.rootTemplateNodeId !== 1 || !nodes.has(1)) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Canonical root Node must have TemplateNodeId 1')
  const visitedNodes = new Set<number>()
  const visitedBlocks = new Set<number>()
  const scopes = new Map<number, CanonicalScope>()
  const visit = (nodeId: number, scope: CanonicalScope): void => {
    if (visitedNodes.has(nodeId)) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Canonical Node is shared or cyclic: ' + nodeId)
    const node = nodes.get(nodeId)
    if (node === undefined) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Canonical child Node is missing: ' + nodeId)
    visitedNodes.add(nodeId)
    scopes.set(nodeId, scope)
    for (const child of node.children) {
      if (child.kind === 'node') visit(child.templateNodeId, scope)
      else {
        if (visitedBlocks.has(child.templateBlockId)) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Canonical Block is shared: ' + child.templateBlockId)
        const block = blocks.get(child.templateBlockId)
        if (block === undefined || block.parentTemplateNodeId !== nodeId) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Canonical Block parent is invalid: ' + child.templateBlockId)
        visitedBlocks.add(child.templateBlockId)
        visit(block.templateRootNodeId, { kind: 'block', templateBlockId: block.templateBlockId })
      }
    }
  }
  visit(1, { kind: 'page' })
  if (visitedNodes.size !== nodes.size || visitedBlocks.size !== blocks.size) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Canonical Page contains unreachable static facts')
  const bindingTargets = new Set<string>()
  for (const binding of page.bindings) {
    const target = nodes.get(binding.target.templateNodeId)
    if (target === undefined || !sameScope(scopes.get(binding.target.templateNodeId), binding.scope)) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Binding target or scope is invalid')
    if (binding.target.name === 'text' && target.host.type !== 'Text') throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Text Binding target is not a Text Host')
    if (binding.target.name === 'enabled' && target.host.type !== 'Button' && target.host.type !== 'Input' && target.host.type !== 'Switch') throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Enabled Binding target is not a Button, Input or Switch Host')
    if (binding.target.name === 'value' && target.host.type !== 'Input') throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Value Binding target is not an Input Host')
    if (binding.target.name === 'checked' && target.host.type !== 'Switch') throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Checked Binding target is not a Switch Host')
    if (binding.target.name === 'selected' && target.host.type !== 'Picker' && target.host.type !== 'Tabs') throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Selected Binding target is not a Picker or Tabs Host')
    const key = `${binding.scope.kind}:${binding.scope.kind === 'block' ? binding.scope.templateBlockId : 0}:${binding.target.templateNodeId}:${binding.target.name}`
    if (bindingTargets.has(key)) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Duplicate Binding target: ' + key)
    bindingTargets.add(key)
  }
  const handlerTargets = new Set<string>()
  for (const handler of page.handlers) {
    const target = nodes.get(handler.templateNodeId)
    if (target === undefined || !sameScope(scopes.get(handler.templateNodeId), handler.scope)) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Handler target or scope is invalid')
    const validHandler = (target.host.type === 'Button' && handler.eventType === 'click')
      || (target.host.type === 'Input' && (handler.eventType === 'input' || handler.eventType === 'change' || handler.eventType === 'focus'))
      || (target.host.type === 'Switch' && handler.eventType === 'change')
      || (target.host.type === 'Slider' && handler.eventType === 'change')
      || ((target.host.type === 'Picker' || target.host.type === 'Tabs') && handler.eventType === 'change')
      || ((target.host.type === 'List' || target.host.type === 'Scroll') && (handler.eventType === 'scroll' || handler.eventType === 'scrollend' || handler.eventType === 'scrolltop' || handler.eventType === 'scrollbottom'))
      || (target.host.type === 'Video' && (handler.eventType === 'prepared' || handler.eventType === 'start' || handler.eventType === 'pause' || handler.eventType === 'finish' || handler.eventType === 'error' || handler.eventType === 'timeupdate'))
    if (!validHandler) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, `Handler target or event type is invalid: ${target.host.type}/${handler.eventType}`)
    const key = `${handler.scope.kind}:${handler.scope.kind === 'block' ? handler.scope.templateBlockId : 0}:${handler.templateNodeId}:${handler.eventType}`
    if (handlerTargets.has(key)) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, 'Duplicate Handler target: ' + key)
    handlerTargets.add(key)
  }
}

function assertContiguousIds(ids: readonly number[], label: string): void {
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] !== index + 1) throw new LoweringIssue(ErrorCodes.loweringInternalInvariant, `${label} sequence is not contiguous`)
  }
}

function sameScope(left: CanonicalScope | undefined, right: CanonicalScope): boolean {
  return left?.kind === right.kind && left.kind === 'page' || left?.kind === 'block' && right.kind === 'block' && left.templateBlockId === right.templateBlockId
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right))
}

function cancelledDiagnostic(): Diagnostic {
  return Object.freeze({ severity: 'error', code: ErrorCodes.loweringCancelled, phase: 'lowering', message: 'Canonical Lowering was cancelled', hint: 'Retry the build without cancellation.' })
}

function inputDiagnostic(message: string): Diagnostic {
  return Object.freeze({ severity: 'error', code: ErrorCodes.loweringInputInvalid, phase: 'lowering', message, hint: 'Provide the verified immutable S02/S03 model pair.' })
}
