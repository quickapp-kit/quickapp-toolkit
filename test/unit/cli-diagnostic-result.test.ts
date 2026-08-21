import test from 'node:test'
import assert from 'node:assert/strict'
import { assertToolkitResult } from '../../src/application/contracts.js'
import {
  assertCliDiagnosticResult,
  assertRenderableResult,
  isCliDiagnosticResult,
} from '../../src/cli/cli-diagnostic-result.js'
import { renderResult } from '../../src/cli/result-renderer.js'
import type { CliDiagnosticResult, RenderableResult } from '../../src/cli/types.js'
import { ErrorCodes } from '../../src/diagnostics/error-codes.js'

function cliDiagnostic(): CliDiagnosticResult {
  return {
    schemaVersion: 1,
    kind: 'cliDiagnostic',
    status: 'failure',
    invocationId: 'inv:cli-diagnostic-test',
    failure: { kind: 'usage', code: ErrorCodes.cliUnknownCommand },
    diagnostics: [
      {
        severity: 'error',
        code: ErrorCodes.cliUnknownCommand,
        phase: 'cli',
        message: 'Unknown command',
      },
    ],
  }
}

test('CliDiagnosticResult has an independent discriminator and validator', () => {
  const result = cliDiagnostic()
  assert.equal(isCliDiagnosticResult(result), true)
  assert.doesNotThrow(() => assertCliDiagnosticResult(result))
  assert.doesNotThrow(() => assertRenderableResult(result))
  assert.throws(() => assertToolkitResult(result), /operation is invalid/)
})

test('ToolkitResult and CliDiagnosticResult are separately accepted by the renderer union', () => {
  const toolkitResult = {
    schemaVersion: 1,
    operation: 'build',
    status: 'success',
    invocationId: 'inv:build-test',
    data: { ok: true },
    diagnostics: [],
  } as const

  assert.doesNotThrow(() => assertRenderableResult(toolkitResult))
  assert.doesNotThrow(() => renderResult(toolkitResult, 'json', false))
  assert.doesNotThrow(() => renderResult(cliDiagnostic(), 'json', false))
})

test('CliDiagnosticResult rejects an operation or data field', () => {
  const withOperation = { ...cliDiagnostic(), operation: 'cli' }
  const withData = { ...cliDiagnostic(), data: {} }

  assert.equal(isCliDiagnosticResult(withOperation), false)
  assert.throws(() => assertCliDiagnosticResult(withOperation), /unexpected property: operation/)
  assert.throws(() => assertCliDiagnosticResult(withData), /unexpected property: data/)
  assert.throws(
    () => renderResult(withOperation as unknown as RenderableResult, 'json', false),
    /unexpected property: operation/,
  )
})

test('CliDiagnosticResult rejects malformed error envelopes', () => {
  const missingKind = { ...cliDiagnostic(), kind: undefined }
  const missingPrimary = { ...cliDiagnostic(), diagnostics: [] }

  assert.equal(isCliDiagnosticResult(missingKind), false)
  assert.throws(() => assertCliDiagnosticResult(missingKind), /kind must be cliDiagnostic/)
  assert.throws(() => assertCliDiagnosticResult(missingPrimary), /primary diagnostic/)
})
