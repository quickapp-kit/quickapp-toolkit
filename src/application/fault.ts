import type { Diagnostic } from '../diagnostics/diagnostic.js'
import type { FailureKind } from './contracts.js'

export class ToolkitFault extends Error {
  readonly kind: FailureKind
  readonly diagnostic: Diagnostic

  constructor(kind: FailureKind, diagnostic: Diagnostic, cause?: unknown) {
    super(diagnostic.message, cause === undefined ? undefined : { cause })
    this.name = 'ToolkitFault'
    this.kind = kind
    this.diagnostic = diagnostic
  }
}
