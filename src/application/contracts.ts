import type { Diagnostic } from '../diagnostics/diagnostic.js'

export type ToolkitOperation = 'build' | 'inspect' | 'run'
export type FailureKind = 'usage' | 'workspace' | 'config' | 'operation' | 'cancelled' | 'internal'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

interface ToolkitResultBase {
  readonly schemaVersion: 1
  readonly operation: ToolkitOperation
  readonly invocationId: `inv:${string}`
  readonly diagnostics: readonly Diagnostic[]
}

export interface ToolkitSuccess<T> extends ToolkitResultBase {
  readonly status: 'success'
  readonly data: T
}

export interface ToolkitFailure extends ToolkitResultBase {
  readonly status: 'failure' | 'cancelled'
  readonly failure: {
    readonly kind: FailureKind
    readonly code: string
  }
}

export type ToolkitResult<T> = ToolkitSuccess<T> | ToolkitFailure

export interface OperationSuccess<T> {
  readonly status: 'success'
  readonly data: T
  readonly diagnostics?: readonly Diagnostic[]
}

export interface OperationFailure {
  readonly status: 'failure' | 'cancelled'
  readonly failure: {
    readonly kind: FailureKind
    readonly code: string
  }
  readonly diagnostics: readonly Diagnostic[]
}

export type OperationResult<T> = OperationSuccess<T> | OperationFailure

export function assertToolkitResult(value: unknown): asserts value is ToolkitResult<unknown> {
  if (!value || typeof value !== 'object') throw new TypeError('ToolkitResult must be an object')
  const result = value as Record<string, unknown>
  if (result.schemaVersion !== 1) throw new TypeError('ToolkitResult.schemaVersion must be 1')
  if (!['build', 'inspect', 'run'].includes(String(result.operation))) {
    throw new TypeError('ToolkitResult.operation is invalid')
  }
  if (typeof result.invocationId !== 'string' || !result.invocationId.startsWith('inv:')) {
    throw new TypeError('ToolkitResult.invocationId is invalid')
  }
  if (!Array.isArray(result.diagnostics)) throw new TypeError('ToolkitResult.diagnostics must be an array')
  if (result.status === 'success') {
    if (!Object.hasOwn(result, 'data') || Object.hasOwn(result, 'failure')) {
      throw new TypeError('Successful ToolkitResult must contain only data')
    }
    return
  }
  if (result.status !== 'failure' && result.status !== 'cancelled') {
    throw new TypeError('ToolkitResult.status is invalid')
  }
  if (!result.failure || typeof result.failure !== 'object' || Object.hasOwn(result, 'data')) {
    throw new TypeError('Failed ToolkitResult must contain only failure')
  }
  const failure = result.failure as Record<string, unknown>
  if (typeof failure.code !== 'string' || typeof failure.kind !== 'string') {
    throw new TypeError('ToolkitResult.failure is invalid')
  }
  const hasPrimaryDiagnostic = (result.diagnostics as readonly unknown[]).some(
    (diagnostic) =>
      !!diagnostic &&
      typeof diagnostic === 'object' &&
      (diagnostic as Record<string, unknown>).code === failure.code,
  )
  if (!hasPrimaryDiagnostic) throw new TypeError('ToolkitResult must include its primary diagnostic')
}
