import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { SourceSpan } from '../frontend/types.js'

export class LoweringIssue extends Error {
  readonly diagnostic: Diagnostic

  constructor(code: string, message: string, file?: string, span?: SourceSpan, hint = 'Fix the source semantics before continuing the build.') {
    super(message)
    this.name = 'LoweringIssue'
    this.diagnostic = Object.freeze({
      severity: 'error',
      code,
      phase: 'lowering',
      message,
      ...(file === undefined ? {} : { file }),
      ...(span === undefined ? {} : { range: { start: span.start, end: span.end } }),
      hint,
    })
  }
}
