import type { Node as AcornNode } from 'acorn'
import { ErrorCodes } from '../../diagnostics/error-codes.js'
import { FrontendIssue } from './frontend-issue.js'
import { SourceCoordinateMap } from './source-coordinate-map.js'
import type { FrontendLimits, SourceSpan, SyntaxNode, SyntaxValue } from './types.js'

interface LocatedNode {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly [key: string]: unknown
}

export class SyntaxNormalizer {
  readonly #coordinates: SourceCoordinateMap
  readonly #baseOffset: number
  readonly #limits: FrontendLimits
  #nodes = 0

  constructor(coordinates: SourceCoordinateMap, baseOffset: number, limits: FrontendLimits) {
    this.#coordinates = coordinates
    this.#baseOffset = baseOffset
    this.#limits = limits
  }

  normalize(node: AcornNode | LocatedNode): SyntaxNode {
    return this.#node(node as LocatedNode, 1)
  }

  synthetic(type: string, start: number, end: number, fields: Readonly<Record<string, SyntaxValue>>): SyntaxNode {
    this.#claimNode(1, this.#coordinates.span(this.#baseOffset + start, this.#baseOffset + end))
    return Object.freeze({
      type,
      span: this.#coordinates.span(this.#baseOffset + start, this.#baseOffset + end),
      fields: Object.freeze({ ...fields }),
    })
  }

  #node(node: LocatedNode, depth: number): SyntaxNode {
    const span = this.#coordinates.span(this.#baseOffset + node.start, this.#baseOffset + node.end)
    this.#claimNode(depth, span)
    const fields: Record<string, SyntaxValue> = {}
    for (const key of Object.keys(node).sort()) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
      const value = this.#value(node[key], depth + 1)
      if (value !== undefined) fields[key] = value
    }
    return Object.freeze({ type: node.type, span, fields: Object.freeze(fields) })
  }

  #value(value: unknown, depth: number): SyntaxValue | undefined {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
    if (Array.isArray(value)) {
      const normalized = value
        .map((entry) => this.#value(entry, depth))
        .filter((entry): entry is SyntaxValue => entry !== undefined)
      return Object.freeze(normalized)
    }
    if (isLocatedNode(value)) return this.#node(value, depth)
    if (isLiteralValueObject(value)) return value.raw ?? value.cooked ?? ''
    return undefined
  }

  #claimNode(depth: number, span: SourceSpan): void {
    this.#nodes += 1
    if (this.#nodes > this.#limits.maxAstNodes || depth > this.#limits.maxDepth) {
      throw new FrontendIssue(
        ErrorCodes.frontendLimitExceeded,
        'Frontend syntax tree exceeds configured limits',
        span,
        'Reduce source complexity or raise the explicit frontend limit.',
      )
    }
  }
}

function isLocatedNode(value: unknown): value is LocatedNode {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LocatedNode>
  return typeof candidate.type === 'string' && typeof candidate.start === 'number' && typeof candidate.end === 'number'
}

function isLiteralValueObject(value: unknown): value is { readonly raw?: string; readonly cooked?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as { readonly raw?: unknown; readonly cooked?: unknown }
  return typeof candidate.raw === 'string' || typeof candidate.cooked === 'string'
}
