import { assertToolkitResult } from '../application/contracts.js'
import type { Diagnostic } from '../diagnostics/diagnostic.js'
import type { CliDiagnosticResult, RenderableResult } from './types.js'

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'kind', 'status', 'invocationId', 'failure', 'diagnostics'])
const FAILURE_KEYS = new Set(['kind', 'code'])

export function isCliDiagnosticResult(value: unknown): value is CliDiagnosticResult {
  try {
    assertCliDiagnosticResult(value)
    return true
  } catch {
    return false
  }
}

export function assertCliDiagnosticResult(value: unknown): asserts value is CliDiagnosticResult {
  if (!isRecord(value)) throw new TypeError('CliDiagnosticResult must be an object')
  assertOnlyKeys(value, TOP_LEVEL_KEYS, 'CliDiagnosticResult')
  if (value.schemaVersion !== 1) throw new TypeError('CliDiagnosticResult.schemaVersion must be 1')
  if (value.kind !== 'cliDiagnostic') throw new TypeError('CliDiagnosticResult.kind must be cliDiagnostic')
  if (value.status !== 'failure') throw new TypeError('CliDiagnosticResult.status must be failure')
  if (typeof value.invocationId !== 'string' || !/^inv:.+/.test(value.invocationId)) {
    throw new TypeError('CliDiagnosticResult.invocationId is invalid')
  }
  if (!isRecord(value.failure)) throw new TypeError('CliDiagnosticResult.failure must be an object')
  const failure = value.failure
  assertOnlyKeys(failure, FAILURE_KEYS, 'CliDiagnosticResult.failure')
  if (failure.kind !== 'usage' && failure.kind !== 'internal') {
    throw new TypeError('CliDiagnosticResult.failure.kind is invalid')
  }
  if (typeof failure.code !== 'string' || failure.code.length === 0) {
    throw new TypeError('CliDiagnosticResult.failure.code is invalid')
  }
  if (!Array.isArray(value.diagnostics) || !value.diagnostics.every(isDiagnostic)) {
    throw new TypeError('CliDiagnosticResult.diagnostics is invalid')
  }
  if (!value.diagnostics.some((diagnostic) => diagnostic.code === failure.code)) {
    throw new TypeError('CliDiagnosticResult must include its primary diagnostic')
  }
}

export function assertRenderableResult(value: unknown): asserts value is RenderableResult {
  if (isRecord(value) && value.kind === 'cliDiagnostic') {
    assertCliDiagnosticResult(value)
    return
  }
  assertToolkitResult(value)
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (!isRecord(value)) return false
  return (
    (value.severity === 'error' || value.severity === 'warning' || value.severity === 'info') &&
    typeof value.code === 'string' &&
    value.code.length > 0 &&
    typeof value.phase === 'string' &&
    value.phase.length > 0 &&
    typeof value.message === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key))
  if (unexpected) throw new TypeError(`${label} contains unexpected property: ${unexpected}`)
}
