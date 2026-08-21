import type { CancellationToken } from '../../application/cancellation.js'
import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { SourceAccess } from '../../workspace/source-access.js'
import type { SourceUnit } from '../../workspace/types.js'
import type { ParsedSource, SourceFrontendPort, SourceSpan } from '../frontend/types.js'
import type { ExcludedWidget, ManifestSchemaValidator, ResolvedManifest } from '../manifest/types.js'

export interface GraphLimits {
  readonly maxModules: number
  readonly maxEdges: number
  readonly maxContextEntries: number
  readonly maxAssets: number
  readonly maxAssetBytes: number
}

export const DEFAULT_GRAPH_LIMITS: GraphLimits = Object.freeze({
  maxModules: 10_000,
  maxEdges: 50_000,
  maxContextEntries: 10_000,
  maxAssets: 10_000,
  maxAssetBytes: 16 * 1024 * 1024,
})

export interface ModuleNode {
  readonly moduleId: string
  readonly kind: 'app' | 'page' | 'shared'
  readonly sourcePath: string
  readonly manifestRoute?: string
  readonly route?: string
  readonly component?: string
}

export interface SourceRangeEvidence {
  readonly sourcePath: string
  readonly span: SourceSpan
}

export interface GraphEdge {
  readonly fromModuleId: string
  readonly kind: 'script' | 'style' | 'asset' | 'capability'
  readonly specifier: string
  readonly target: string
  readonly references: readonly SourceRangeEvidence[]
}

export interface AssetNode {
  readonly sourcePath: string
  readonly mediaKind: string
  readonly byteLength: number
  readonly sha256: string
  readonly references: readonly SourceRangeEvidence[]
}

export interface CapabilityRelation {
  readonly name: string
  readonly status: 'required' | 'deferred' | 'declaredOnly'
  readonly references: readonly SourceRangeEvidence[]
}

export interface ResolvedAppModel {
  readonly manifest: ResolvedManifest
  readonly entryRoute: string
  readonly appModule: ModuleNode
  readonly pageModules: readonly ModuleNode[]
  readonly sharedModules: readonly ModuleNode[]
  readonly assets: readonly AssetNode[]
  readonly capabilities: readonly CapabilityRelation[]
  readonly graph: { readonly nodes: readonly ModuleNode[]; readonly edges: readonly GraphEdge[] }
  readonly excludedWidgets: readonly ExcludedWidget[]
}

export interface BuildGraphRequest {
  readonly manifest: SourceUnit
  readonly sourceRoot: string
  readonly sourceAccess: SourceAccess
  readonly frontend: SourceFrontendPort
  readonly schemaValidator: ManifestSchemaValidator
  readonly cancellation: CancellationToken
  readonly limits?: GraphLimits
}

export type GraphBuildResult =
  | {
      readonly status: 'success'
      readonly model: ResolvedAppModel
      readonly parsedSources: ReadonlyMap<string, ParsedSource>
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly status: 'failure'; readonly diagnostics: readonly Diagnostic[] }
