import type { CancellationToken } from '../../application/cancellation.js'
import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { SourceAccess } from '../../workspace/source-access.js'

export type FrontendSourceKind = 'appUx' | 'pageUx' | 'sharedJs' | 'style'
export type FrontendReferenceKind =
  | 'scriptImport'
  | 'scriptRequire'
  | 'scriptContext'
  | 'capability'
  | 'styleImport'
  | 'styleUrl'

export interface SourcePoint {
  readonly line: number
  readonly column: number
}

export interface SourceSpan {
  readonly startByte: number
  readonly endByte: number
  readonly start: SourcePoint
  readonly end: SourcePoint
}

export interface SyntaxNode {
  readonly type: string
  readonly span: SourceSpan
  readonly fields: Readonly<Record<string, SyntaxValue>>
}

export type SyntaxValue = null | boolean | number | string | SyntaxNode | readonly SyntaxValue[]

export interface TemplateAttributeSyntax {
  readonly name: string
  readonly rawValue: string
  readonly span: SourceSpan
  readonly expression?: SyntaxNode
  readonly directive?: 'if' | 'for'
  readonly forAliases?: { readonly index: string; readonly item: string }
}

export interface TemplateTextSyntax {
  readonly kind: 'text'
  readonly value: string
  readonly span: SourceSpan
  readonly interpolations: readonly SyntaxNode[]
  readonly ignorableWhitespace: boolean
}

export interface TemplateElementSyntax {
  readonly kind: 'element'
  readonly tagName: string
  readonly attributes: readonly TemplateAttributeSyntax[]
  readonly children: readonly TemplateChildSyntax[]
  readonly selfClosing: boolean
  readonly span: SourceSpan
}

export type TemplateChildSyntax = TemplateElementSyntax | TemplateTextSyntax

export interface TemplateSyntax {
  readonly root: TemplateElementSyntax
}

export interface StyleNodeSyntax {
  readonly type: string
  readonly name?: string
  readonly selector?: string
  readonly property?: string
  readonly value?: string
  readonly params?: string
  readonly span: SourceSpan
  readonly children: readonly StyleNodeSyntax[]
}

export interface UnresolvedReference {
  readonly kind: FrontendReferenceKind
  readonly ownerSourcePath: string
  readonly specifier: string
  readonly span: SourceSpan
  readonly context?: {
    readonly recursive: boolean
    readonly regexpSource: string
    readonly regexpFlags: string
  }
}

export interface FrontendFeatureUsage {
  readonly featureId: string
  readonly span: SourceSpan
}

interface ParsedSourceBase {
  readonly sourcePath: string
  readonly sourceKind: FrontendSourceKind
  readonly sourceSha256: string
  readonly references: readonly UnresolvedReference[]
  readonly featureUsage: readonly FrontendFeatureUsage[]
}

export interface ParsedUxSource extends ParsedSourceBase {
  readonly sourceKind: 'appUx' | 'pageUx'
  readonly template?: TemplateSyntax
  readonly script: SyntaxNode
  readonly style?: readonly StyleNodeSyntax[]
}

export interface ParsedJavaScriptSource extends ParsedSourceBase {
  readonly sourceKind: 'sharedJs'
  readonly program: SyntaxNode
}

export interface ParsedStyleSource extends ParsedSourceBase {
  readonly sourceKind: 'style'
  readonly stylesheet: readonly StyleNodeSyntax[]
}

export type ParsedSource = ParsedUxSource | ParsedJavaScriptSource | ParsedStyleSource

export interface FrontendLimits {
  readonly maxSourceBytes: number
  readonly maxAstNodes: number
  readonly maxDepth: number
  readonly maxTokens: number
  readonly maxReferences: number
  readonly maxSelectorLength: number
  readonly maxExpressionLength: number
}

export const DEFAULT_FRONTEND_LIMITS: FrontendLimits = Object.freeze({
  maxSourceBytes: 2 * 1024 * 1024,
  maxAstNodes: 100_000,
  maxDepth: 256,
  maxTokens: 200_000,
  maxReferences: 10_000,
  maxSelectorLength: 8_192,
  maxExpressionLength: 64 * 1024,
})

export interface ParseSourceRequest {
  readonly sourcePath: string
  readonly sourceKind: FrontendSourceKind
  readonly sourceAccess: SourceAccess
  readonly cancellation: CancellationToken
  readonly limits?: FrontendLimits
}

export type FrontendResult =
  | { readonly status: 'success'; readonly parsedSource: ParsedSource; readonly diagnostics: readonly Diagnostic[] }
  | { readonly status: 'failure'; readonly diagnostics: readonly Diagnostic[] }

export interface SourceFrontendPort {
  parse(request: ParseSourceRequest): Promise<FrontendResult>
}
