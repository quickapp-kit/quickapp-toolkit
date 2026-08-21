import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { SourceSpan } from '../frontend/types.js'

export interface ManifestSchemaValidator {
  validate(value: unknown): readonly string[]
}

export interface ResolvedPage {
  readonly manifestRoute: string
  readonly runtimeRoute: string
  readonly component: string
  readonly sourcePath: string
  readonly moduleId: string
}

export interface ResolvedManifest {
  readonly packageName: string
  readonly name?: string
  readonly versionName: string
  readonly versionCode: number
  readonly minPlatformVersion: number
  readonly entry: string
  readonly pages: readonly ResolvedPage[]
  readonly features: readonly string[]
  readonly permissions: readonly unknown[]
  readonly display?: unknown
  readonly icon?: string
  readonly raw: Readonly<Record<string, unknown>>
}

export interface ExcludedWidget {
  readonly manifestKey: string
  readonly code: 'TK_WIDGET_EXCLUDED_V1'
  readonly span: SourceSpan
}

export type ManifestResult =
  | {
      readonly status: 'success'
      readonly manifest: ResolvedManifest
      readonly excludedWidgets: readonly ExcludedWidget[]
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly status: 'failure'; readonly diagnostics: readonly Diagnostic[] }
