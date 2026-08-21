import type { CancellationToken } from '../../application/cancellation.js'
import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { ResolvedManifest } from '../manifest/types.js'
import type { CanonicalLoweredAppModel } from '../lowering/types.js'
import type { JsEmitterResult, PageIrResult } from '../emitter/types.js'

export interface ArtifactLimits {
  readonly maxPackageBytes: number
  readonly maxMemberBytes: number
  readonly maxMembers: number
  readonly maxPages: number
  readonly maxManifestBytes: number
  readonly maxMetadataBytes: number
  readonly maxPageIrBytes: number
  readonly maxZipCentralDirectoryBytes: number
  readonly maxDiagnostics: number
}

export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = Object.freeze({
  maxPackageBytes: 32 * 1024 * 1024,
  maxMemberBytes: 16 * 1024 * 1024,
  maxMembers: 2048,
  maxPages: 128,
  maxManifestBytes: 1 * 1024 * 1024,
  maxMetadataBytes: 1 * 1024 * 1024,
  maxPageIrBytes: 4 * 1024 * 1024,
  maxZipCentralDirectoryBytes: 2 * 1024 * 1024,
  maxDiagnostics: 1000,
})

export interface ArtifactSchemaValidator {
  validateManifest(value: unknown): readonly string[]
  validateRuntimeMetadata(value: unknown): readonly string[]
}

export interface RuntimeResourceInput {
  readonly path: string
  readonly mediaType: 'application/octet-stream' | 'image/png' | 'image/jpeg'
  readonly bytes: readonly number[]
}

export interface RuntimeArtifactRequest {
  readonly model: CanonicalLoweredAppModel
  readonly manifest: ResolvedManifest
  readonly js: Extract<JsEmitterResult, { readonly status: 'success' }>
  readonly pageIr: Extract<PageIrResult, { readonly status: 'success' }>
  readonly resources?: readonly RuntimeResourceInput[]
  readonly toolkitVersion: string
  readonly buildMode: 'debug' | 'release'
  readonly schemaValidator: ArtifactSchemaValidator
  readonly cancellation: CancellationToken
  readonly limits?: Partial<ArtifactLimits>
}

export interface ArtifactDescriptor {
  readonly path: string
  readonly mediaType: string
  readonly byteLength: number
  readonly sha256: string
}

export interface RuntimeRpkMember {
  readonly descriptor: ArtifactDescriptor
  readonly bytes: readonly number[]
}

export interface RuntimeMetadata {
  readonly schemaVersion: 1
  readonly packageFormat: 'quickapp-kit-rpk-v1'
  readonly runtimeAbi: 'quickapp-kit-runtime-v1'
  readonly irVersion: 1
  readonly jsModuleAbi: 'quickapp-kit-app-module-v1'
  readonly packageId: string
  readonly toolkit: { readonly name: 'quickapp-toolkit'; readonly version: string }
  readonly buildMode: 'debug' | 'release'
  readonly entryRoute: string
  readonly app: { readonly moduleId: string; readonly dependencies: readonly string[]; readonly bundle: ArtifactDescriptor }
  readonly sharedModules: readonly { readonly moduleId: string; readonly dependencies: readonly string[]; readonly bundle: ArtifactDescriptor }[]
  readonly pages: readonly {
    readonly route: string
    readonly manifestRoute: string
    readonly component: string
    readonly moduleId: string
    readonly dependencies: readonly string[]
    readonly templateId: string
    readonly bundle: ArtifactDescriptor
    readonly pageIr: ArtifactDescriptor
  }[]
  readonly resources: readonly ArtifactDescriptor[]
}

export interface RuntimeArtifact {
  readonly status: 'success'
  readonly metadata: RuntimeMetadata
  readonly members: readonly RuntimeRpkMember[]
  readonly packageBytes: readonly number[]
}

export type RuntimeArtifactResult = RuntimeArtifact | { readonly status: 'failure'; readonly diagnostics: readonly Diagnostic[] }
