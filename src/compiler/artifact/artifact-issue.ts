import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { SourceSpan } from '../frontend/types.js'

export class ArtifactIssue extends Error {
  readonly diagnostic: Diagnostic

  constructor(code: string, message: string, file?: string, span?: SourceSpan, hint = 'Fix the verified artifact inputs before packaging.') {
    super(message)
    this.name = 'ArtifactIssue'
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
