import type { CancellationToken } from '../../application/cancellation.js'
import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { CanonicalLoweredAppModel, CanonicalLoweredPageModel } from '../lowering/types.js'

export interface EmitterLimits {
  readonly maxBundles: number
  readonly maxGeneratedBytes: number
  readonly maxGeneratedNodes: number
  readonly maxExpressionNodes: number
  readonly maxSourceMapSources: number
  readonly maxSourceMapSegments: number
  readonly maxDiagnostics: number
}

export const DEFAULT_EMITTER_LIMITS: EmitterLimits = Object.freeze({
  maxBundles: 10_000,
  maxGeneratedBytes: 16 * 1024 * 1024,
  maxGeneratedNodes: 2_000_000,
  maxExpressionNodes: 1_000_000,
  maxSourceMapSources: 10_000,
  maxSourceMapSegments: 2_000_000,
  maxDiagnostics: 1_000,
})

export interface JsEmitterRequest {
  readonly model: CanonicalLoweredAppModel
  readonly cancellation: CancellationToken
  readonly limits?: Partial<EmitterLimits>
}

export interface PageIrSchemaValidator {
  validate(value: unknown): readonly string[]
}

export interface PageIrEmitterRequest {
  readonly model: CanonicalLoweredAppModel
  readonly schemaValidator: PageIrSchemaValidator
  readonly cancellation: CancellationToken
  readonly limits?: Partial<EmitterLimits>
}

export interface SourceMapArtifact {
  readonly path: string
  readonly content: string
}

export interface JsBundleArtifact {
  readonly moduleId: string
  readonly moduleKind: 'app' | 'shared' | 'page'
  readonly dependencies: readonly string[]
  readonly path: string
  readonly content: string
  readonly sourceMap: SourceMapArtifact
}

export interface JsEmissionResult {
  readonly status: 'success'
  readonly bundles: readonly JsBundleArtifact[]
  readonly diagnostics: readonly Diagnostic[]
}

export interface PageIrArtifact {
  readonly moduleId: string
  readonly route: string
  readonly templateId: string
  readonly path: string
  readonly value: Readonly<Record<string, unknown>>
  readonly content: string
}

export interface PageIrEmissionResult {
  readonly status: 'success'
  readonly pages: readonly PageIrArtifact[]
  readonly diagnostics: readonly Diagnostic[]
}

export type JsEmitterResult = JsEmissionResult | { readonly status: 'failure'; readonly diagnostics: readonly Diagnostic[] }
export type PageIrResult = PageIrEmissionResult | { readonly status: 'failure'; readonly diagnostics: readonly Diagnostic[] }

export type LoweredPage = CanonicalLoweredPageModel
