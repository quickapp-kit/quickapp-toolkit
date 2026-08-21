import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { SourceSpan } from './types.js'

export class FrontendIssue extends Error {
  readonly code: string
  readonly span: SourceSpan
  readonly hint: string

  constructor(code: string, message: string, span: SourceSpan, hint: string) {
    super(message)
    this.name = 'FrontendIssue'
    this.code = code
    this.span = span
    this.hint = hint
  }
}

export function issueDiagnostic(issue: FrontendIssue, sourcePath: string): Diagnostic {
  return {
    severity: 'error',
    code: issue.code,
    phase: 'frontend',
    message: issue.message,
    file: sourcePath,
    range: { start: issue.span.start, end: issue.span.end },
    hint: issue.hint,
  }
}
