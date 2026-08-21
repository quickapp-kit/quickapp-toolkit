import test from 'node:test'
import assert from 'node:assert/strict'
import { assertToolkitResult } from '../../src/application/contracts.js'
import { sortDiagnostics } from '../../src/diagnostics/diagnostic.js'

test('Diagnostic ordering is deterministic', () => {
  const diagnostics = sortDiagnostics([
    { severity: 'error', code: 'Z', phase: 'build', message: 'z', file: 'b.ux' },
    { severity: 'error', code: 'B', phase: 'workspace', message: 'b', file: 'z.ux' },
    { severity: 'error', code: 'A', phase: 'workspace', message: 'a', file: 'a.ux' },
  ])
  assert.deepEqual(diagnostics.map(({ code }) => code), ['A', 'B', 'Z'])
})

test('ToolkitResult rejects success with failure', () => {
  assert.throws(
    () =>
      assertToolkitResult({
        schemaVersion: 1,
        operation: 'build',
        status: 'success',
        invocationId: 'inv:test',
        data: {},
        failure: { kind: 'operation', code: 'X' },
        diagnostics: [],
      }),
    /only data/,
  )
})

test('ToolkitResult requires a primary failure diagnostic', () => {
  assert.throws(
    () =>
      assertToolkitResult({
        schemaVersion: 1,
        operation: 'build',
        status: 'failure',
        invocationId: 'inv:test',
        failure: { kind: 'operation', code: 'X' },
        diagnostics: [],
      }),
    /primary diagnostic/,
  )
})
