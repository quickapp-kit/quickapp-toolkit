import type { CancellationToken } from './cancellation.js'
import type { JsonValue, OperationResult } from './contracts.js'
import type { DiagnosticCollector } from '../diagnostics/diagnostic.js'
import type { SourceAccess } from '../workspace/source-access.js'
import type { WorkspaceContext, WorkspaceOverrides } from '../workspace/types.js'

export interface InvocationContext {
  readonly invocationId: `inv:${string}`
  readonly runId: `run:${string}`
  readonly cwd: string
  readonly cancellation: CancellationToken
}

export interface BuildRequest {
  readonly workspace?: string
  readonly config?: string
  readonly overrides?: WorkspaceOverrides
}

export interface BuildInvocation {
  readonly context: InvocationContext
  readonly workspace: WorkspaceContext
  readonly sourceAccess: SourceAccess
  readonly diagnostics: DiagnosticCollector
}

export interface BuildUseCasePort<T extends JsonValue = JsonValue> {
  execute(invocation: BuildInvocation): Promise<OperationResult<T>>
}

export interface OperationUseCasePort<Request, Result extends JsonValue> {
  execute(request: Request, context: InvocationContext): Promise<OperationResult<Result>>
}

export interface BuildResultWithArtifact extends Readonly<Record<string, JsonValue>> {
  readonly artifactSha256?: string
}
