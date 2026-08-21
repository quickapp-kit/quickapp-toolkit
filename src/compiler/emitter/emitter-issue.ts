import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { SourceSpan } from '../frontend/types.js'

export class EmitterIssue extends Error {
  readonly diagnostic: Diagnostic

  constructor(code: string, message: string, file?: string, span?: SourceSpan, hint = 'Fix the verified Lowered Model before emitting artifacts.') {
    super(message)
    this.name = 'EmitterIssue'
    this.diagnostic = Object.freeze({
      severity: 'error',
      code,
      phase: 'build',
      message,
      ...(file === undefined ? {} : { file }),
      ...(span === undefined ? {} : { range: { start: span.start, end: span.end } }),
      hint,
    })
  }
}
