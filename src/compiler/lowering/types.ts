import type { CancellationToken } from '../../application/cancellation.js'
import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { SourceSpan, SyntaxNode } from '../frontend/types.js'
import type { ResolvedAppModel } from '../module-graph/types.js'
import type { ParsedSource } from '../frontend/types.js'

export interface CanonicalSourceLocation {
  readonly sourcePath: string
  readonly span: SourceSpan
}

export interface CanonicalModuleReference {
  readonly kind: 'module' | 'context' | 'capability'
  readonly specifier: string
  readonly targets: readonly string[]
  readonly contextMembers?: readonly { readonly key: string; readonly moduleId: string }[]
  readonly source: CanonicalSourceLocation
}

export interface CanonicalModuleEntry {
  readonly moduleId: string
  readonly moduleKind: 'app' | 'shared' | 'page'
  readonly dependencies: readonly string[]
  readonly program: SyntaxNode
  readonly references: readonly CanonicalModuleReference[]
  readonly source: CanonicalSourceLocation
}

export interface CanonicalLength {
  readonly value: number
  readonly unit: 'logical-px' | 'percent'
}

export interface CanonicalStyle {
  readonly width?: CanonicalLength
  readonly height?: CanonicalLength
  readonly marginTop?: CanonicalLength
  readonly marginRight?: CanonicalLength
  readonly marginBottom?: CanonicalLength
  readonly marginLeft?: CanonicalLength
  readonly flexDirection?: 'row' | 'column'
  readonly justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between'
  readonly alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  readonly backgroundColor?: string
  readonly color?: string
  readonly borderRadius?: number
  readonly fontSize?: number
  readonly textAlign?: 'left' | 'center' | 'right'
}

export type CanonicalHost =
  | { readonly type: 'View'; readonly props: Readonly<Record<string, never>>; readonly style: CanonicalStyle }
  | { readonly type: 'Text'; readonly props: { readonly text: string }; readonly style: CanonicalStyle }
  | { readonly type: 'Button'; readonly props: { readonly text: string; readonly enabled: boolean }; readonly style: CanonicalStyle }

export type CanonicalScope =
  | { readonly kind: 'page' }
  | { readonly kind: 'block'; readonly templateBlockId: number }

export type CanonicalChild =
  | { readonly kind: 'node'; readonly templateNodeId: number }
  | { readonly kind: 'block'; readonly templateBlockId: number }

export interface CanonicalNode {
  readonly templateNodeId: number
  readonly host: CanonicalHost
  readonly children: readonly CanonicalChild[]
  readonly source: CanonicalSourceLocation
}

export interface CanonicalExpression {
  readonly ast: SyntaxNode
  readonly coercion: 'identity' | 'boolean' | 'displayString'
  readonly lexicalBindings: readonly string[]
  readonly stateBindings: readonly string[]
  readonly source: CanonicalSourceLocation
}

export interface CanonicalStateField {
  readonly name: string
  readonly initializer: SyntaxNode
  readonly source: CanonicalSourceLocation
}

export type CanonicalBindingSegment =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'expression'; readonly expression: CanonicalExpression }

export type CanonicalBindingEvaluator =
  | { readonly kind: 'expression'; readonly expression: CanonicalExpression }
  | { readonly kind: 'concat'; readonly segments: readonly CanonicalBindingSegment[] }

export interface CanonicalBinding {
  readonly templateBindingId: number
  readonly scope: CanonicalScope
  readonly target: { readonly templateNodeId: number; readonly name: 'text' | 'enabled' }
  readonly evaluator: CanonicalBindingEvaluator
  readonly resultType: 'string' | 'boolean'
  readonly source: CanonicalSourceLocation
}

export interface CanonicalIfController {
  readonly kind: 'if'
  readonly predicate: CanonicalExpression
}

export interface CanonicalForController {
  readonly kind: 'for'
  readonly iterable: CanonicalExpression
  readonly indexAlias: string
  readonly itemAlias: string
  readonly keyPath: readonly string[]
  readonly keyExpression: CanonicalExpression
}

export interface CanonicalBlock {
  readonly templateBlockId: number
  readonly kind: 'if' | 'for'
  readonly parentTemplateNodeId: number
  readonly templateRootNodeId: number
  readonly controller: CanonicalIfController | CanonicalForController
  readonly source: CanonicalSourceLocation
}

export interface CanonicalHandler {
  readonly templateHandlerId: number
  readonly scope: CanonicalScope
  readonly templateNodeId: number
  readonly eventType: 'click'
  readonly methodName: string
  readonly source: CanonicalSourceLocation
}

export interface CanonicalLoweredPageModel {
  readonly manifestRoute: string
  readonly route: string
  readonly moduleId: string
  readonly module: CanonicalModuleEntry
  readonly templateId: string
  readonly stateFields: readonly CanonicalStateField[]
  readonly rootTemplateNodeId: number
  readonly nodes: readonly CanonicalNode[]
  readonly bindings: readonly CanonicalBinding[]
  readonly blocks: readonly CanonicalBlock[]
  readonly handlers: readonly CanonicalHandler[]
}

export interface CanonicalLoweredAppModel {
  readonly modelVersion: 1
  readonly packageName: string
  readonly appModule: CanonicalModuleEntry
  readonly sharedModules: readonly CanonicalModuleEntry[]
  readonly pages: readonly CanonicalLoweredPageModel[]
}

export interface LoweringLimits {
  readonly maxPages: number
  readonly maxTemplateDepth: number
  readonly maxNodes: number
  readonly maxBindings: number
  readonly maxBlocks: number
  readonly maxHandlers: number
  readonly maxExpressionNodes: number
  readonly maxStyleRules: number
  readonly maxStyleDeclarations: number
  readonly maxSelectorMatches: number
  readonly maxLessExpansionSteps: number
  readonly maxWorkQueue: number
  readonly maxProvenance: number
}

export const DEFAULT_LOWERING_LIMITS: LoweringLimits = Object.freeze({
  maxPages: 1_000,
  maxTemplateDepth: 256,
  maxNodes: 100_000,
  maxBindings: 100_000,
  maxBlocks: 50_000,
  maxHandlers: 100_000,
  maxExpressionNodes: 1_000_000,
  maxStyleRules: 100_000,
  maxStyleDeclarations: 1_000_000,
  maxSelectorMatches: 2_000_000,
  maxLessExpansionSteps: 1_000_000,
  maxWorkQueue: 1_000_000,
  maxProvenance: 1_000_000,
})

export interface CanonicalLoweringRequest {
  readonly resolvedAppModel: ResolvedAppModel
  readonly parsedSourceModel: ReadonlyMap<string, ParsedSource>
  readonly cancellation: CancellationToken
  readonly limits?: LoweringLimits
}

export type CanonicalLoweringResult =
  | { readonly status: 'success'; readonly model: CanonicalLoweredAppModel; readonly diagnostics: readonly Diagnostic[] }
  | { readonly status: 'failure'; readonly diagnostics: readonly Diagnostic[] }
