import type { JsonValue, ToolkitResult } from '../application/contracts.js'
import type { InvocationContext } from '../application/use-case-ports.js'
import type { ToolkitApplicationService } from '../application/toolkit-application-service.js'
import type { Diagnostic } from '../diagnostics/diagnostic.js'

export type OutputFormat = 'human' | 'json'

export interface CommonOptions {
  readonly config?: string
  readonly format: OutputFormat
  readonly color: boolean
  readonly help: boolean
}

export interface CliIo {
  writeStdout(text: string): void
  writeStderr(text: string): void
}

export interface CliCommandContribution {
  readonly name: 'build' | 'inspect' | 'run'
  readonly summary: string
  readonly usage: string
  parse(tokens: readonly string[], common: CommonOptions): unknown
  invoke(
    service: ToolkitApplicationService<JsonValue, unknown, JsonValue, unknown, JsonValue>,
    request: unknown,
    context: InvocationContext,
  ): Promise<ToolkitResult<JsonValue>>
}

export interface CliDiagnosticResult {
  readonly schemaVersion: 1
  readonly kind: 'cliDiagnostic'
  readonly status: 'failure'
  readonly invocationId: `inv:${string}`
  readonly failure: {
    readonly kind: 'usage' | 'internal'
    readonly code: string
  }
  readonly diagnostics: readonly Diagnostic[]
}

export type RenderableResult = ToolkitResult<JsonValue> | CliDiagnosticResult

export interface CliExecution {
  readonly exitCode: number
  readonly result?: RenderableResult
}
