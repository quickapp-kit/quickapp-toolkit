import { ErrorCodes } from '../../diagnostics/error-codes.js'
import type { SourceSpan } from '../frontend/types.js'
import { LoweringIssue } from './lowering-issue.js'
import type { LoweringLimits } from './types.js'

export type LoweringBudgetKind =
  | 'pages'
  | 'templateDepth'
  | 'nodes'
  | 'bindings'
  | 'blocks'
  | 'handlers'
  | 'expressionNodes'
  | 'styleRules'
  | 'styleDeclarations'
  | 'selectorMatches'
  | 'lessExpansionSteps'
  | 'workQueue'
  | 'provenance'

const LIMIT_KEY: Readonly<Record<LoweringBudgetKind, keyof LoweringLimits>> = Object.freeze({
  pages: 'maxPages',
  templateDepth: 'maxTemplateDepth',
  nodes: 'maxNodes',
  bindings: 'maxBindings',
  blocks: 'maxBlocks',
  handlers: 'maxHandlers',
  expressionNodes: 'maxExpressionNodes',
  styleRules: 'maxStyleRules',
  styleDeclarations: 'maxStyleDeclarations',
  selectorMatches: 'maxSelectorMatches',
  lessExpansionSteps: 'maxLessExpansionSteps',
  workQueue: 'maxWorkQueue',
  provenance: 'maxProvenance',
})

export class LoweringBudget {
  readonly #limits: LoweringLimits
  readonly #usage = new Map<LoweringBudgetKind, number>()

  constructor(limits: LoweringLimits) {
    this.#limits = limits
  }

  charge(kind: LoweringBudgetKind, amount = 1, file?: string, span?: SourceSpan): void {
    const next = (this.#usage.get(kind) ?? 0) + amount
    this.#usage.set(kind, next)
    const limit = this.#limits[LIMIT_KEY[kind]]
    if (next > limit) {
      throw new LoweringIssue(
        ErrorCodes.loweringLimitExceeded,
        `Canonical Lowering ${kind} budget exceeded: ${next} > ${limit}`,
        file,
        span,
        'Reduce source complexity or raise the explicit Lowering limit.',
      )
    }
  }

  claimDepth(depth: number, file: string, span: SourceSpan): void {
    if (depth > this.#limits.maxTemplateDepth) {
      throw new LoweringIssue(
        ErrorCodes.loweringLimitExceeded,
        `Canonical Lowering templateDepth budget exceeded: ${depth} > ${this.#limits.maxTemplateDepth}`,
        file,
        span,
        'Reduce template nesting or raise the explicit Lowering limit.',
      )
    }
  }

  snapshot(): Readonly<Record<LoweringBudgetKind, number>> {
    return Object.freeze(Object.fromEntries(Object.keys(LIMIT_KEY).map((key) => [key, this.#usage.get(key as LoweringBudgetKind) ?? 0])) as Record<LoweringBudgetKind, number>)
  }
}
