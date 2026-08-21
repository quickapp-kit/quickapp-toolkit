import { ErrorCodes } from '../diagnostics/error-codes.js'
import { DiagnosticCollector, sortDiagnostics, type Diagnostic } from '../diagnostics/diagnostic.js'
import { BuildObservationEmitter, NoopToolkitObservationPort, ProcessMonotonicClock } from '../observation/toolkit-observation-port.js'
import type { MonotonicClock, ToolkitObservationPort } from '../observation/toolkit-observation-port.js'
import { WorkspaceResolver } from '../workspace/workspace-resolver.js'
import { OperationCancelledError } from './cancellation.js'
import type { JsonValue, OperationResult, ToolkitFailure, ToolkitOperation, ToolkitResult } from './contracts.js'
import { assertToolkitResult } from './contracts.js'
import { ToolkitFault } from './fault.js'
import type {
  BuildRequest,
  BuildResultWithArtifact,
  BuildUseCasePort,
  InvocationContext,
  OperationUseCasePort,
} from './use-case-ports.js'

export interface ToolkitApplicationServiceOptions<
  BuildResult extends JsonValue = BuildResultWithArtifact,
  InspectRequest = unknown,
  InspectResult extends JsonValue = JsonValue,
  RunRequest = unknown,
  RunResult extends JsonValue = JsonValue,
> {
  readonly workspaceResolver?: WorkspaceResolver
  readonly buildUseCase?: BuildUseCasePort<BuildResult>
  readonly inspectUseCase?: OperationUseCasePort<InspectRequest, InspectResult>
  readonly runUseCase?: OperationUseCasePort<RunRequest, RunResult>
  readonly observation?: ToolkitObservationPort
  readonly clock?: MonotonicClock
}

export class ToolkitApplicationService<
  BuildResult extends JsonValue = BuildResultWithArtifact,
  InspectRequest = unknown,
  InspectResult extends JsonValue = JsonValue,
  RunRequest = unknown,
  RunResult extends JsonValue = JsonValue,
> {
  readonly #workspaceResolver: WorkspaceResolver
  readonly #buildUseCase: BuildUseCasePort<BuildResult> | undefined
  readonly #inspectUseCase: OperationUseCasePort<InspectRequest, InspectResult> | undefined
  readonly #runUseCase: OperationUseCasePort<RunRequest, RunResult> | undefined
  readonly #observation: ToolkitObservationPort
  readonly #clock: MonotonicClock

  constructor(options: ToolkitApplicationServiceOptions<BuildResult, InspectRequest, InspectResult, RunRequest, RunResult> = {}) {
    this.#workspaceResolver = options.workspaceResolver ?? new WorkspaceResolver()
    this.#buildUseCase = options.buildUseCase
    this.#inspectUseCase = options.inspectUseCase
    this.#runUseCase = options.runUseCase
    this.#observation = options.observation ?? new NoopToolkitObservationPort()
    this.#clock = options.clock ?? new ProcessMonotonicClock()
  }

  async build(request: BuildRequest, context: InvocationContext): Promise<ToolkitResult<BuildResult>> {
    const emitter = new BuildObservationEmitter(this.#observation, this.#clock, context.runId)
    emitter.started()
    let sourceAccess: Awaited<ReturnType<WorkspaceResolver['resolve']>>['sourceAccess'] | undefined
    let result: ToolkitResult<BuildResult>

    try {
      context.cancellation.throwIfCancelled()
      const resolution = await this.#workspaceResolver.resolve(
        {
          cwd: context.cwd,
          ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
          ...(request.config === undefined ? {} : { config: request.config }),
          ...(request.overrides === undefined ? {} : { overrides: request.overrides }),
        },
        context.cancellation,
      )
      sourceAccess = resolution.sourceAccess
      context.cancellation.throwIfCancelled()
      if (!this.#buildUseCase) {
        throw new ToolkitFault('operation', operationUnavailable('build'))
      }

      const diagnostics = new DiagnosticCollector()
      const operationResult = await this.#buildUseCase.execute({
        context,
        workspace: resolution.context,
        sourceAccess,
        diagnostics,
      })
      context.cancellation.throwIfCancelled()
      if (operationResult.status === 'success') await sourceAccess.verifyUnchanged()
      diagnostics.addAll(operationResult.diagnostics ?? [])
      result = normalizeOperationResult('build', context, operationResult, diagnostics.snapshot())
    } catch (error) {
      result = failureFromError('build', context, error)
    } finally {
      sourceAccess?.dispose()
    }

    if (result.status === 'success') emitter.completed(extractArtifactSha256(result.data))
    else emitter.failed(result.failure.code)
    return result
  }

  async inspect(request: InspectRequest, context: InvocationContext): Promise<ToolkitResult<InspectResult>> {
    return this.#executeOperation('inspect', request, context, this.#inspectUseCase)
  }

  async run(request: RunRequest, context: InvocationContext): Promise<ToolkitResult<RunResult>> {
    return this.#executeOperation('run', request, context, this.#runUseCase)
  }

  async #executeOperation<Request, Result extends JsonValue>(
    operation: Exclude<ToolkitOperation, 'build'>,
    request: Request,
    context: InvocationContext,
    useCase: OperationUseCasePort<Request, Result> | undefined,
  ): Promise<ToolkitResult<Result>> {
    try {
      context.cancellation.throwIfCancelled()
      if (!useCase) throw new ToolkitFault('operation', operationUnavailable(operation))
      const result = await useCase.execute(request, context)
      context.cancellation.throwIfCancelled()
      return normalizeOperationResult(operation, context, result, result.diagnostics ?? [])
    } catch (error) {
      return failureFromError(operation, context, error)
    }
  }
}

function normalizeOperationResult<T extends JsonValue>(
  operation: ToolkitOperation,
  context: InvocationContext,
  operationResult: OperationResult<T>,
  diagnostics: readonly Diagnostic[],
): ToolkitResult<T> {
  const result: ToolkitResult<T> =
    operationResult.status === 'success'
      ? {
          schemaVersion: 1,
          operation,
          status: 'success',
          invocationId: context.invocationId,
          data: operationResult.data,
          diagnostics: sortDiagnostics(diagnostics),
        }
      : {
          schemaVersion: 1,
          operation,
          status: operationResult.status,
          invocationId: context.invocationId,
          failure: operationResult.failure,
          diagnostics: sortDiagnostics(diagnostics),
        }
  assertToolkitResult(result)
  assertJsonSerializable(result)
  return result
}

function failureFromError<T>(
  operation: ToolkitOperation,
  context: InvocationContext,
  error: unknown,
): ToolkitResult<T> {
  let failure: ToolkitFailure['failure']
  let diagnostic: Diagnostic
  let status: 'failure' | 'cancelled' = 'failure'

  if (error instanceof ToolkitFault) {
    failure = { kind: error.kind, code: error.diagnostic.code }
    diagnostic = error.diagnostic
  } else if (error instanceof OperationCancelledError) {
    status = 'cancelled'
    failure = { kind: 'cancelled', code: ErrorCodes.operationCancelled }
    diagnostic = {
      severity: 'error',
      code: ErrorCodes.operationCancelled,
      phase: operation,
      message: `Operation cancelled: ${error.reason}`,
    }
  } else {
    failure = { kind: 'internal', code: ErrorCodes.internalError }
    diagnostic = {
      severity: 'error',
      code: ErrorCodes.internalError,
      phase: 'internal',
      message: 'An internal Toolkit error occurred',
    }
  }

  const result: ToolkitResult<T> = {
    schemaVersion: 1,
    operation,
    status,
    invocationId: context.invocationId,
    failure,
    diagnostics: [diagnostic],
  }
  assertToolkitResult(result)
  return result
}

function operationUnavailable(operation: ToolkitOperation): Diagnostic {
  return {
    severity: 'error',
    code: ErrorCodes.operationUnavailable,
    phase: operation,
    message: `Operation is not installed: ${operation}`,
  }
}

function extractArtifactSha256(data: JsonValue): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const value = (data as { readonly [key: string]: JsonValue }).artifactSha256
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined
}

function assertJsonSerializable(value: unknown): void {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('ToolkitResult is not JSON serializable')
}
