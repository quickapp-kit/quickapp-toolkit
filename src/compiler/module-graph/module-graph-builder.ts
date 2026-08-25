import path from 'node:path'
import { ToolkitFault } from '../../application/fault.js'
import { ErrorCodes } from '../../diagnostics/error-codes.js'
import { sortDiagnostics, type Diagnostic } from '../../diagnostics/diagnostic.js'
import type { SourceEntry } from '../../workspace/types.js'
import type { ParsedSource, SourceSpan, UnresolvedReference } from '../frontend/types.js'
import { deepFreeze, ImmutableMap } from '../immutable.js'
import { parseManifest } from '../manifest/manifest-parser.js'
import type { ResolvedManifest } from '../manifest/types.js'
import {
  DEFAULT_GRAPH_LIMITS,
  type AssetNode,
  type BuildGraphRequest,
  type CapabilityRelation,
  type GraphBuildResult,
  type GraphEdge,
  type GraphLimits,
  type ModuleNode,
  type ResolvedAppModel,
  type SourceRangeEvidence,
} from './types.js'

interface PendingSource {
  readonly sourcePath: string
  readonly sourceKind: 'appUx' | 'pageUx' | 'sharedJs' | 'style'
  readonly ownerModuleId: string
}

interface MutableEdge {
  readonly fromModuleId: string
  readonly kind: GraphEdge['kind']
  readonly specifier: string
  readonly target: string
  readonly references: SourceRangeEvidence[]
}

interface MutableAsset {
  readonly sourcePath: string
  readonly mediaKind: string
  readonly byteLength: number
  readonly sha256: string
  readonly references: SourceRangeEvidence[]
}

export class ModuleGraphBuilder {
  async build(request: BuildGraphRequest): Promise<GraphBuildResult> {
    request.cancellation.throwIfCancelled()
    const manifestResult = parseManifest(request.manifest, request.sourceRoot, request.schemaValidator)
    if (manifestResult.status === 'failure') return manifestResult
    const session = new GraphSession(request, request.limits ?? DEFAULT_GRAPH_LIMITS, manifestResult.manifest, [...manifestResult.diagnostics])
    try {
      return await session.build(manifestResult.excludedWidgets)
    } catch (error) {
      if (error instanceof ToolkitFault) return { status: 'failure', diagnostics: Object.freeze(sortDiagnostics([...session.diagnostics, error.diagnostic])) }
      if (error instanceof GraphIssue) return { status: 'failure', diagnostics: Object.freeze(sortDiagnostics([...session.diagnostics, error.diagnostic])) }
      throw error
    }
  }
}

class GraphSession {
  readonly request: BuildGraphRequest
  readonly limits: GraphLimits
  readonly manifest: ResolvedManifest
  readonly diagnostics: Diagnostic[]
  readonly modules = new Map<string, ModuleNode>()
  readonly moduleBySource = new Map<string, ModuleNode>()
  readonly parsed = new Map<string, ParsedSource>()
  readonly processedOwners = new Set<string>()
  readonly pending: PendingSource[] = []
  readonly pendingKeys = new Set<string>()
  readonly edges = new Map<string, MutableEdge>()
  readonly assets = new Map<string, MutableAsset>()
  readonly capabilityEvidence = new Map<string, SourceRangeEvidence[]>()
  readonly styleAdjacency = new Map<string, Set<string>>()

  constructor(request: BuildGraphRequest, limits: GraphLimits, manifest: ResolvedManifest, diagnostics: Diagnostic[]) {
    this.request = request
    this.limits = limits
    this.manifest = manifest
    this.diagnostics = diagnostics
  }

  async build(excludedWidgets: ResolvedAppModel['excludedWidgets']): Promise<GraphBuildResult> {
    const app = freezeModule({ moduleId: '@quickapp-kit/app', kind: 'app', sourcePath: `${this.request.sourceRoot}/app.ux` })
    this.addModule(app)
    await this.requireFile(app.sourcePath, ErrorCodes.moduleNotFound, 'App source does not exist')
    this.enqueue({ sourcePath: app.sourcePath, sourceKind: 'appUx', ownerModuleId: app.moduleId })
    for (const page of this.manifest.pages) {
      const node = freezeModule({ moduleId: page.moduleId, kind: 'page', sourcePath: page.sourcePath, manifestRoute: page.manifestRoute, route: page.runtimeRoute, component: page.component })
      this.addModule(node)
      await this.requireFile(node.sourcePath, ErrorCodes.moduleNotFound, `Page source does not exist: ${node.sourcePath}`)
      this.enqueue({ sourcePath: node.sourcePath, sourceKind: 'pageUx', ownerModuleId: node.moduleId })
    }
    if (this.manifest.icon !== undefined) {
      const iconPath = this.manifest.icon.startsWith('/') ? `${this.request.sourceRoot}${this.manifest.icon}` : `${this.request.sourceRoot}/${this.manifest.icon}`
      await this.addAsset(app.moduleId, this.manifest.icon, iconPath, this.request.manifest.logicalPath, this.manifestSpan())
    }

    while (this.pending.length > 0) {
      this.request.cancellation.throwIfCancelled()
      this.pending.sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath) || compareUtf8(left.ownerModuleId, right.ownerModuleId))
      const item = this.pending.shift()
      if (item === undefined) continue
      const processKey = sourceOwnerKey(item.ownerModuleId, item.sourcePath)
      if (this.processedOwners.has(processKey)) continue
      let parsedSource = this.parsed.get(item.sourcePath)
      if (parsedSource === undefined) {
        const result = await this.request.frontend.parse({ sourcePath: item.sourcePath, sourceKind: item.sourceKind, sourceAccess: this.request.sourceAccess, cancellation: this.request.cancellation })
        this.request.cancellation.throwIfCancelled()
        if (result.status === 'failure') return { status: 'failure', diagnostics: Object.freeze(sortDiagnostics([...this.diagnostics, ...result.diagnostics])) }
        parsedSource = deepFreeze(result.parsedSource)
        this.parsed.set(item.sourcePath, parsedSource)
        this.diagnostics.push(...result.diagnostics)
      }
      this.processedOwners.add(processKey)
      for (const reference of parsedSource.references) await this.resolveReference(item, reference)
    }

    this.assertStyleAcyclic()
    const capabilities = this.finalizeCapabilities()
    const nodes = [...this.modules.values()].sort((left, right) => compareUtf8(left.moduleId, right.moduleId))
    const edges = [...this.edges.values()].map(freezeEdge).sort(compareEdges)
    const assets = [...this.assets.values()].map(freezeAsset).sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath))
    const appModule = this.modules.get('@quickapp-kit/app') as ModuleNode
    const pageModules = nodes.filter((node) => node.kind === 'page')
    const sharedModules = nodes.filter((node) => node.kind === 'shared')
    const model: ResolvedAppModel = deepFreeze({
      manifest: this.manifest,
      entryRoute: `/${this.manifest.entry}`,
      appModule,
      pageModules: Object.freeze(pageModules),
      sharedModules: Object.freeze(sharedModules),
      assets: Object.freeze(assets),
      capabilities: Object.freeze(capabilities),
      graph: { nodes, edges },
      excludedWidgets,
    })
    const parsedSources = new ImmutableMap([...this.parsed.entries()].sort(([left], [right]) => compareUtf8(left, right)))
    return deepFreeze({ status: 'success', model, parsedSources, diagnostics: sortDiagnostics(this.diagnostics) } as const)
  }

  async resolveReference(owner: PendingSource, reference: UnresolvedReference): Promise<void> {
    switch (reference.kind) {
      case 'capability':
        this.addCapability(reference)
        this.addEdge(owner.ownerModuleId, 'capability', reference.specifier, reference.specifier.slice(1), reference)
        return
      case 'scriptImport':
      case 'scriptRequire': {
        const target = await this.resolveFile(owner.sourcePath, reference, ['', '.js', '/index.js'], 'script')
        const owned = this.moduleBySource.get(target)
        if (owned !== undefined && owned.kind !== 'shared') throw this.issue(ErrorCodes.moduleDependencyInvalid, `Module dependency targets an App or Page source: ${target}`, reference)
        const module = owned ?? freezeModule({ moduleId: sharedModuleId(this.request.sourceRoot, target), kind: 'shared', sourcePath: target })
        if (owned === undefined) this.addModule(module)
        this.addEdge(owner.ownerModuleId, 'script', reference.specifier, module.moduleId, reference)
        this.enqueue({ sourcePath: target, sourceKind: 'sharedJs', ownerModuleId: module.moduleId })
        return
      }
      case 'scriptContext': {
        const targets = await this.resolveContext(owner.sourcePath, reference)
        for (const target of targets) {
          const module = this.moduleBySource.get(target) ?? freezeModule({ moduleId: sharedModuleId(this.request.sourceRoot, target), kind: 'shared', sourcePath: target })
          if (!this.moduleBySource.has(target)) this.addModule(module)
          this.addEdge(owner.ownerModuleId, 'script', reference.specifier, module.moduleId, reference)
          this.enqueue({ sourcePath: target, sourceKind: 'sharedJs', ownerModuleId: module.moduleId })
        }
        return
      }
      case 'styleImport': {
        const target = await this.resolveFile(owner.sourcePath, reference, ['', '.less', '.css'], 'style')
        this.addEdge(owner.ownerModuleId, 'style', reference.specifier, target, reference)
        const adjacency = this.styleAdjacency.get(owner.sourcePath) ?? new Set<string>()
        adjacency.add(target)
        this.styleAdjacency.set(owner.sourcePath, adjacency)
        this.enqueue({ sourcePath: target, sourceKind: 'style', ownerModuleId: owner.ownerModuleId })
        return
      }
      case 'styleUrl': {
        const target = normalizeRelative(owner.sourcePath, reference.specifier, this.request.sourceRoot)
        await this.addAsset(owner.ownerModuleId, reference.specifier, target, reference.ownerSourcePath, reference.span)
      }
    }
  }

  async resolveFile(ownerPath: string, reference: UnresolvedReference, suffixes: readonly string[], label: string): Promise<string> {
    const base = normalizeRelative(ownerPath, reference.specifier, this.request.sourceRoot)
    const matches: string[] = []
    for (const suffix of suffixes) {
      const candidate = `${base}${suffix}`
      try {
        const entry = await this.request.sourceAccess.stat(candidate)
        if (entry.kind === 'file') matches.push(candidate)
      } catch (error) {
        if (!(error instanceof ToolkitFault) || error.diagnostic.code !== ErrorCodes.sourceNotFound) throw error
      }
    }
    if (matches.length === 0) throw this.issue(ErrorCodes.moduleNotFound, `${label} target not found: ${reference.specifier}`, reference)
    if (matches.length > 1) throw this.issue(ErrorCodes.moduleAmbiguous, `${label} target is ambiguous: ${matches.join(', ')}`, reference)
    return matches[0] as string
  }

  async resolveContext(ownerPath: string, reference: UnresolvedReference): Promise<readonly string[]> {
    const context = reference.context
    if (context === undefined) throw this.issue(ErrorCodes.moduleDependencyInvalid, 'Context reference is missing literal facts', reference)
    const root = normalizeRelative(ownerPath, reference.specifier, this.request.sourceRoot)
    const output: string[] = []
    const pending = [root]
    const usage: ContextBudgetUsage = { total: 0, queuedDirectories: 0, visitedDirectories: 0, scannedEntries: 0, matchedFiles: 0 }
    const charge = (kind: ContextBudgetKind, amount: number): void => {
      usage[kind] += amount
      usage.total += amount
      if (usage.total > this.limits.maxContextEntries || usage[kind] > this.limits.maxContextEntries || pending.length > this.limits.maxContextEntries) {
        throw this.issue(
          ErrorCodes.contextLimitExceeded,
          `require.context traversal exceeds cumulative budget=${this.limits.maxContextEntries} (${formatContextUsage(usage)})`,
          reference,
        )
      }
    }
    charge('queuedDirectories', 1)
    const expression = new RegExp(context.regexpSource, context.regexpFlags.replace(/[gy]/g, ''))
    while (pending.length > 0) {
      this.request.cancellation.throwIfCancelled()
      const directory = pending.shift() as string
      charge('visitedDirectories', 1)
      const remainingBudget = this.limits.maxContextEntries - usage.total
      if (remainingBudget <= 0) throw this.issue(ErrorCodes.contextLimitExceeded, `require.context traversal exhausted cumulative budget (${formatContextUsage(usage)})`, reference)
      let entries: readonly SourceEntry[]
      try {
        entries = await this.request.sourceAccess.list(directory, { maxEntries: remainingBudget })
      } catch (error) {
        if (error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.sourceTooLarge) {
          throw this.issue(ErrorCodes.contextLimitExceeded, `require.context directory exceeds remaining cumulative budget=${remainingBudget} (${formatContextUsage(usage)})`, reference)
        }
        throw error
      }
      charge('scannedEntries', entries.length)
      for (const entry of entries) {
        if (entry.kind === 'directory' && context.recursive) {
          pending.push(entry.logicalPath)
          charge('queuedDirectories', 1)
        }
        if (entry.kind !== 'file' || !entry.logicalPath.endsWith('.js')) continue
        const relative = `./${path.posix.relative(root, entry.logicalPath)}`
        expression.lastIndex = 0
        if (expression.test(relative)) {
          output.push(entry.logicalPath)
          charge('matchedFiles', 1)
        }
      }
    }
    return output.sort(compareUtf8)
  }

  addModule(module: ModuleNode): void {
    const byId = this.modules.get(module.moduleId)
    const bySource = this.moduleBySource.get(module.sourcePath)
    if (byId !== undefined && byId.sourcePath !== module.sourcePath || bySource !== undefined && bySource.moduleId !== module.moduleId) {
      throw this.issueAt(ErrorCodes.moduleIdConflict, `Module identity conflict: ${module.moduleId}`, module.sourcePath)
    }
    this.modules.set(module.moduleId, module)
    this.moduleBySource.set(module.sourcePath, module)
    if (this.modules.size > this.limits.maxModules) throw this.issueAt(ErrorCodes.contextLimitExceeded, 'Module count exceeds configured limit', module.sourcePath)
  }

  enqueue(item: PendingSource): void {
    const key = sourceOwnerKey(item.ownerModuleId, item.sourcePath)
    if (this.pendingKeys.has(key) || this.processedOwners.has(key)) return
    this.pendingKeys.add(key)
    this.pending.push(item)
  }

  addEdge(fromModuleId: string, kind: GraphEdge['kind'], specifier: string, target: string, reference: UnresolvedReference): void {
    const key = `${fromModuleId}\0${kind}\0${specifier}\0${target}`
    const evidence = Object.freeze({ sourcePath: reference.ownerSourcePath, span: reference.span })
    const existing = this.edges.get(key)
    if (existing === undefined) this.edges.set(key, { fromModuleId, kind, specifier, target, references: [evidence] })
    else existing.references.push(evidence)
    if (this.edges.size > this.limits.maxEdges) throw this.issue(ErrorCodes.contextLimitExceeded, 'Graph edge count exceeds configured limit', reference)
  }

  addCapability(reference: UnresolvedReference): void {
    const name = reference.specifier.slice(1)
    if (!this.manifest.features.includes(name)) throw this.issue(ErrorCodes.capabilityNotDeclared, `Capability is referenced but not declared: ${name}`, reference)
    if (!['system.router', 'system.prompt', 'system.device', 'system.fetch', 'system.file', 'system.timer', 'system.openUrl', 'system.webview'].includes(name)) throw this.issue(ErrorCodes.capabilityUnsupported, `Capability is not supported in V1: ${name}`, reference)
    const evidence = this.capabilityEvidence.get(name) ?? []
    evidence.push(Object.freeze({ sourcePath: reference.ownerSourcePath, span: reference.span }))
    this.capabilityEvidence.set(name, evidence)
  }

  async addAsset(ownerModuleId: string, specifier: string, sourcePath: string, evidenceSourcePath: string, span: SourceSpan): Promise<void> {
    const extension = path.posix.extname(sourcePath).slice(1).toLowerCase()
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) throw this.issueAt(ErrorCodes.assetUnsupported, `Unsupported asset type: ${sourcePath}`, sourcePath, span)
    const source = await this.request.sourceAccess.read(sourcePath, { content: 'bytes', maxBytes: this.limits.maxAssetBytes })
    const evidence = Object.freeze({ sourcePath: evidenceSourcePath, span })
    const existing = this.assets.get(sourcePath)
    if (existing === undefined) this.assets.set(sourcePath, { sourcePath, mediaKind: extension, byteLength: source.byteLength, sha256: source.sha256, references: [evidence] })
    else existing.references.push(evidence)
    const fakeReference: UnresolvedReference = { kind: 'styleUrl', ownerSourcePath: evidenceSourcePath, specifier, span }
    this.addEdge(ownerModuleId, 'asset', specifier, sourcePath, fakeReference)
    if (this.assets.size > this.limits.maxAssets) throw this.issueAt(ErrorCodes.contextLimitExceeded, 'Asset count exceeds configured limit', sourcePath, span)
  }

  finalizeCapabilities(): CapabilityRelation[] {
    return this.manifest.features.map((name) => {
      const references = this.capabilityEvidence.get(name) ?? []
      return Object.freeze({
        name,
        status: references.length === 0 ? 'declaredOnly' : 'required',
        references: Object.freeze([...references].sort(compareEvidence)),
      }) as CapabilityRelation
    }).sort((left, right) => compareUtf8(left.name, right.name))
  }

  assertStyleAcyclic(): void {
    const active = new Set<string>()
    const done = new Set<string>()
    const visit = (sourcePath: string, chain: readonly string[]): void => {
      if (active.has(sourcePath)) throw this.issueAt(ErrorCodes.styleImportCycle, `Style import cycle: ${[...chain, sourcePath].join(' -> ')}`, sourcePath)
      if (done.has(sourcePath)) return
      active.add(sourcePath)
      for (const target of [...(this.styleAdjacency.get(sourcePath) ?? [])].sort(compareUtf8)) visit(target, [...chain, sourcePath])
      active.delete(sourcePath)
      done.add(sourcePath)
    }
    for (const sourcePath of [...this.styleAdjacency.keys()].sort(compareUtf8)) visit(sourcePath, [])
  }

  async requireFile(sourcePath: string, code: string, message: string): Promise<SourceEntry> {
    try {
      const entry = await this.request.sourceAccess.stat(sourcePath)
      if (entry.kind !== 'file') throw this.issueAt(code, message, sourcePath)
      return entry
    } catch (error) {
      if (error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.sourceNotFound) throw this.issueAt(code, message, sourcePath)
      throw error
    }
  }

  manifestSpan(): SourceSpan {
    return { startByte: 0, endByte: 0, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
  }

  issue(code: string, message: string, reference: UnresolvedReference): GraphIssue {
    return this.issueAt(code, message, reference.ownerSourcePath, reference.span)
  }

  issueAt(code: string, message: string, file: string, span?: SourceSpan): GraphIssue {
    return new GraphIssue({ severity: 'error', code, phase: code.startsWith('TK_CAPABILITY') ? 'capability' : code.startsWith('TK_ASSET') ? 'asset' : 'moduleGraph', message, file, ...(span === undefined ? {} : { range: { start: span.start, end: span.end } }), hint: 'Fix the declared source relationship before continuing the build.' })
  }
}

class GraphIssue extends Error {
  readonly diagnostic: Diagnostic
  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message)
    this.name = 'GraphIssue'
    this.diagnostic = diagnostic
  }
}

function normalizeRelative(ownerPath: string, specifier: string, sourceRoot: string): string {
  if (!specifier.startsWith('.') || specifier.includes('\\') || specifier.includes('\0')) throw new GraphIssue({ severity: 'error', code: ErrorCodes.moduleDependencyInvalid, phase: 'moduleGraph', message: `Dependency path must be relative: ${specifier}`, file: ownerPath })
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), specifier))
  if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}/`)) throw new GraphIssue({ severity: 'error', code: ErrorCodes.moduleDependencyInvalid, phase: 'moduleGraph', message: `Dependency escapes source root: ${specifier}`, file: ownerPath })
  return resolved
}

function sharedModuleId(sourceRoot: string, sourcePath: string): string {
  const relative = sourcePath.slice(sourceRoot.length + 1)
  return `@quickapp-kit/shared/${relative.endsWith('.js') ? relative.slice(0, -3) : relative}`
}

function freezeModule(module: ModuleNode): ModuleNode {
  return Object.freeze({ ...module })
}

function freezeEdge(edge: MutableEdge): GraphEdge {
  return Object.freeze({ ...edge, references: Object.freeze([...edge.references].sort(compareEvidence)) })
}

function freezeAsset(asset: MutableAsset): AssetNode {
  return Object.freeze({ ...asset, references: Object.freeze([...asset.references].sort(compareEvidence)) })
}

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return compareUtf8(left.fromModuleId, right.fromModuleId) || compareUtf8(left.kind, right.kind) || compareUtf8(left.target, right.target) || compareUtf8(left.specifier, right.specifier)
}

function compareEvidence(left: SourceRangeEvidence, right: SourceRangeEvidence): number {
  return compareUtf8(left.sourcePath, right.sourcePath) || left.span.startByte - right.span.startByte
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right))
}

type ContextBudgetKind = 'queuedDirectories' | 'visitedDirectories' | 'scannedEntries' | 'matchedFiles'

interface ContextBudgetUsage {
  total: number
  queuedDirectories: number
  visitedDirectories: number
  scannedEntries: number
  matchedFiles: number
}

function formatContextUsage(usage: ContextBudgetUsage): string {
  return `total=${usage.total}, queued=${usage.queuedDirectories}, visited=${usage.visitedDirectories}, scanned=${usage.scannedEntries}, matched=${usage.matchedFiles}`
}

function sourceOwnerKey(ownerModuleId: string, sourcePath: string): string {
  return `${ownerModuleId}\0${sourcePath}`
}
