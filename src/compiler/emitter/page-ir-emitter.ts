import { ErrorCodes } from '../../diagnostics/error-codes.js'
import { sortDiagnostics, type Diagnostic } from '../../diagnostics/diagnostic.js'
import { deepFreeze } from '../immutable.js'
import { assertDeepFrozen } from '../lowering/syntax.js'
import type {
  CanonicalChild,
  CanonicalHost,
  CanonicalLoweredAppModel,
  CanonicalLoweredPageModel,
  CanonicalSourceLocation,
  CanonicalScope,
} from '../lowering/types.js'
import { EmitterIssue } from './emitter-issue.js'
import { DEFAULT_EMITTER_LIMITS, type EmitterLimits, type PageIrArtifact, type PageIrEmitterRequest, type PageIrResult } from './types.js'

const STYLE_KEYS = [
  'width', 'height', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'flexDirection', 'justifyContent', 'alignItems', 'backgroundColor', 'color',
  'borderRadius', 'fontSize', 'textAlign',
] as const

export class PageIrEmitter {
  emit(request: PageIrEmitterRequest): PageIrResult {
    const limits = { ...DEFAULT_EMITTER_LIMITS, ...(request.limits ?? {}) }
    const diagnostics: Diagnostic[] = []
    try {
      request.cancellation.throwIfCancelled()
      assertDeepFrozen(request.model)
      validateApp(request.model, limits)
      const pages = [...request.model.pages].sort((left, right) => compareUtf8(left.manifestRoute, right.manifestRoute))
      if (pages.length > limits.maxBundles) fail(ErrorCodes.emitterIrLimitExceeded, 'Page count exceeds emitter limit')
      const artifacts: PageIrArtifact[] = []
      let work = 0
      for (const page of pages) {
        request.cancellation.throwIfCancelled()
        const projection = projectPage(page, request.schemaValidator, limits, () => {
          work += 1
          if (work > limits.maxGeneratedNodes) fail(ErrorCodes.emitterIrLimitExceeded, 'Page IR work exceeds emitter limit')
          request.cancellation.throwIfCancelled()
        })
        const path = `quickapp-kit/pages/${page.manifestRoute}/index.ir.json`
        if (artifacts.some((artifact) => artifact.path === path)) fail(ErrorCodes.emitterIrInputInvalid, `Page IR path collision: ${path}`, page.module.source)
        const content = `${JSON.stringify(projection)}\n`
        if (utf8ByteLength(content) > limits.maxGeneratedBytes) fail(ErrorCodes.emitterIrLimitExceeded, 'Page IR output exceeds emitter byte limit', page.module.source)
        artifacts.push(Object.freeze({
          moduleId: page.moduleId,
          route: page.route,
          templateId: page.templateId,
          path,
          value: deepFreeze(projection),
          content,
        }))
      }
      if (utf8ByteLength(artifacts.map((artifact) => artifact.content).join('')) > limits.maxGeneratedBytes) {
        fail(ErrorCodes.emitterIrLimitExceeded, 'Page IR output exceeds cumulative byte limit')
      }
      return Object.freeze({ status: 'success', pages: Object.freeze(artifacts), diagnostics: Object.freeze(sortDiagnostics(diagnostics)) })
    } catch (error) {
      if (error instanceof EmitterIssue) diagnostics.push(error.diagnostic)
      else if (isCancellation(error)) diagnostics.push(cancelledDiagnostic())
      else diagnostics.push(invalidDiagnostic(error instanceof Error ? error.message : 'Page IR emission failed'))
      return Object.freeze({ status: 'failure', diagnostics: Object.freeze(sortDiagnostics(diagnostics).slice(0, limits.maxDiagnostics)) })
    }

    function fail(code: string, message: string, source?: CanonicalSourceLocation): never {
      throw new EmitterIssue(code, message, source?.sourcePath, source === undefined ? undefined : source.span)
    }
  }
}

function projectPage(
  page: CanonicalLoweredPageModel,
  validator: PageIrEmitterRequest['schemaValidator'],
  limits: EmitterLimits,
  tick: () => void,
): Readonly<Record<string, unknown>> {
  validatePage(page)
  const nodes = [...page.nodes].sort((left, right) => left.templateNodeId - right.templateNodeId).map((node) => {
    tick()
    return {
      templateNodeId: node.templateNodeId,
      host: projectHost(node.host),
      children: node.children.map(projectChild),
    }
  })
  const bindings = [...page.bindings].sort((left, right) => left.templateBindingId - right.templateBindingId).map((binding) => {
    tick()
    return { templateBindingId: binding.templateBindingId, scope: projectScope(binding.scope), target: { templateNodeId: binding.target.templateNodeId, name: binding.target.name } }
  })
  const blocks = [...page.blocks].sort((left, right) => left.templateBlockId - right.templateBlockId).map((block) => {
    tick()
    return { templateBlockId: block.templateBlockId, kind: block.kind, parentTemplateNodeId: block.parentTemplateNodeId, templateRootNodeId: block.templateRootNodeId }
  })
  const handlers = [...page.handlers].sort((left, right) => left.templateHandlerId - right.templateHandlerId).map((handler) => {
    tick()
    return { templateHandlerId: handler.templateHandlerId, scope: projectScope(handler.scope), templateNodeId: handler.templateNodeId, eventType: handler.eventType }
  })
  if (nodes.length + bindings.length + blocks.length + handlers.length > limits.maxGeneratedNodes) throw new EmitterIssue(ErrorCodes.emitterIrLimitExceeded, 'Page IR node count exceeds emitter limit', page.module.source.sourcePath, page.module.source.span)
  const value = {
    schemaVersion: 1,
    templateId: page.templateId,
    rootTemplateNodeId: page.rootTemplateNodeId,
    nodes,
    bindings,
    blocks,
    handlers,
  }
  const schemaErrors = validator.validate(value)
  if (schemaErrors.length > 0) throw new EmitterIssue(ErrorCodes.emitterIrSchemaInvalid, `Public Page IR Schema rejected the projection: ${schemaErrors.join('; ')}`, page.module.source.sourcePath, page.module.source.span)
  return value
}

function validateApp(model: CanonicalLoweredAppModel, limits: EmitterLimits): void {
  if (model.modelVersion !== 1 || model.pages.length > limits.maxBundles) throw new EmitterIssue(ErrorCodes.emitterIrInputInvalid, 'Canonical Lowered App Model version or page count is invalid')
  const pageIds = new Set<string>()
  for (const page of model.pages) {
    if (pageIds.has(page.moduleId)) throw new EmitterIssue(ErrorCodes.emitterIrInputInvalid, `Duplicate Page moduleId: ${page.moduleId}`)
    pageIds.add(page.moduleId)
  }
}

function validatePage(page: CanonicalLoweredPageModel): void {
  if (!/^page:\/.+/.test(page.templateId) || page.rootTemplateNodeId !== 1) throw new EmitterIssue(ErrorCodes.emitterIrInputInvalid, 'Page identity or root TemplateNodeId is invalid', page.module.source.sourcePath, page.module.source.span)
  if (page.module.moduleKind !== 'page' || page.moduleId !== page.module.moduleId) throw new EmitterIssue(ErrorCodes.emitterIrInputInvalid, 'Page module identity is inconsistent', page.module.source.sourcePath, page.module.source.span)
  requireSequence(page.nodes.map((node) => node.templateNodeId), 'TemplateNodeId', page.module.source.sourcePath, page.module.source.span)
  requireSequence(page.bindings.map((binding) => binding.templateBindingId), 'TemplateBindingId', page.module.source.sourcePath, page.module.source.span)
  requireSequence(page.blocks.map((block) => block.templateBlockId), 'TemplateBlockId', page.module.source.sourcePath, page.module.source.span)
  requireSequence(page.handlers.map((handler) => handler.templateHandlerId), 'TemplateHandlerId', page.module.source.sourcePath, page.module.source.span)
  const nodes = new Map(page.nodes.map((node) => [node.templateNodeId, node]))
  const blocks = new Map(page.blocks.map((block) => [block.templateBlockId, block]))
  const visitedNodes = new Set<number>()
  const visitedBlocks = new Set<number>()
  const scopes = new Map<number, CanonicalScope>()
  const visitNode = (nodeId: number, scope: CanonicalScope): void => {
    if (visitedNodes.has(nodeId)) throw new EmitterIssue(ErrorCodes.emitterIrGraphInvalid, `Node is shared or cyclic: ${nodeId}`)
    const node = nodes.get(nodeId)
    if (node === undefined) throw new EmitterIssue(ErrorCodes.emitterIrGraphInvalid, `Node is missing: ${nodeId}`)
    visitedNodes.add(nodeId)
    scopes.set(nodeId, scope)
    for (const child of node.children) {
      if (child.kind === 'node') visitNode(child.templateNodeId, scope)
      else {
        const block = blocks.get(child.templateBlockId)
        if (block === undefined || block.parentTemplateNodeId !== nodeId || visitedBlocks.has(child.templateBlockId)) throw new EmitterIssue(ErrorCodes.emitterIrGraphInvalid, `Block edge is invalid: ${child.templateBlockId}`)
        visitedBlocks.add(child.templateBlockId)
        visitNode(block.templateRootNodeId, { kind: 'block', templateBlockId: block.templateBlockId })
      }
    }
  }
  visitNode(page.rootTemplateNodeId, { kind: 'page' })
  if (visitedNodes.size !== nodes.size || visitedBlocks.size !== blocks.size) throw new EmitterIssue(ErrorCodes.emitterIrGraphInvalid, 'Page graph contains unreachable static facts')
  const bindingTargets = new Set<string>()
  for (const binding of page.bindings) {
    const node = nodes.get(binding.target.templateNodeId)
    if (node === undefined || !sameScope(scopes.get(node.templateNodeId), binding.scope)) throw new EmitterIssue(ErrorCodes.emitterIrTargetInvalid, 'Binding target or scope is invalid', binding.source.sourcePath, binding.source.span)
    if (binding.target.name === 'text' && node.host.type !== 'Text' || binding.target.name === 'enabled' && node.host.type !== 'Button') throw new EmitterIssue(ErrorCodes.emitterIrTargetInvalid, 'Binding target does not match its Host', binding.source.sourcePath, binding.source.span)
    const key = `${binding.scope.kind}:${scopeId(binding.scope)}:${binding.target.templateNodeId}:${binding.target.name}`
    if (bindingTargets.has(key)) throw new EmitterIssue(ErrorCodes.emitterIrTargetInvalid, `Duplicate Binding target: ${key}`, binding.source.sourcePath, binding.source.span)
    bindingTargets.add(key)
  }
  const handlerTargets = new Set<string>()
  for (const handler of page.handlers) {
    const node = nodes.get(handler.templateNodeId)
    if (node === undefined || node.host.type !== 'Button' || handler.eventType !== 'click' || !sameScope(scopes.get(node.templateNodeId), handler.scope)) throw new EmitterIssue(ErrorCodes.emitterIrTargetInvalid, 'Handler target or scope is invalid', handler.source.sourcePath, handler.source.span)
    const key = `${handler.scope.kind}:${scopeId(handler.scope)}:${handler.templateNodeId}:${handler.eventType}`
    if (handlerTargets.has(key)) throw new EmitterIssue(ErrorCodes.emitterIrTargetInvalid, `Duplicate Handler target: ${key}`, handler.source.sourcePath, handler.source.span)
    handlerTargets.add(key)
  }
}

function projectHost(host: CanonicalHost): Readonly<Record<string, unknown>> {
  const style: Record<string, unknown> = {}
  for (const key of STYLE_KEYS) {
    const value = host.style[key]
    if (value !== undefined) style[key] = value
  }
  if (host.type === 'View') return { type: 'View', props: {}, style }
  if (host.type === 'Text') return { type: 'Text', props: { text: host.props.text }, style }
  return { type: 'Button', props: { text: host.props.text, enabled: host.props.enabled }, style }
}

function projectChild(child: CanonicalChild): Readonly<Record<string, unknown>> {
  return child.kind === 'node' ? { kind: 'node', templateNodeId: child.templateNodeId } : { kind: 'block', templateBlockId: child.templateBlockId }
}

function projectScope(scope: CanonicalScope): Readonly<Record<string, unknown>> {
  return scope.kind === 'page' ? { kind: 'page' } : { kind: 'block', templateBlockId: scope.templateBlockId }
}

function requireSequence(ids: readonly number[], label: string, file: string, span: CanonicalSourceLocation['span']): void {
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] !== index + 1) throw new EmitterIssue(ErrorCodes.emitterIrInputInvalid, `${label} sequence is not contiguous`, file, span)
  }
}

function sameScope(left: CanonicalScope | undefined, right: CanonicalScope): boolean {
  if (left?.kind !== right.kind) return false
  if (left === undefined || left.kind === 'page' || right.kind === 'page') return left?.kind === right.kind
  return left.templateBlockId === right.templateBlockId
}

function scopeId(scope: CanonicalScope): string { return scope.kind === 'page' ? 'page' : String(scope.templateBlockId) }
function compareUtf8(left: string, right: string): number { return Buffer.from(left).compare(Buffer.from(right)) }
function utf8ByteLength(value: string): number { return Buffer.byteLength(value, 'utf8') }
function isCancellation(value: unknown): boolean { return value instanceof Error && value.name === 'OperationCancelledError' }
function cancelledDiagnostic(): Diagnostic { return Object.freeze({ severity: 'error', code: ErrorCodes.emitterIrCancelled, phase: 'build', message: 'Page IR emission was cancelled', hint: 'Retry the build without cancellation.' }) }
function invalidDiagnostic(message: string): Diagnostic { return Object.freeze({ severity: 'error', code: ErrorCodes.emitterIrInputInvalid, phase: 'build', message, hint: 'Provide the verified immutable CanonicalLoweredAppModel.' }) }
