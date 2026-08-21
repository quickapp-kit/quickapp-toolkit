import test from 'node:test'
import assert from 'node:assert/strict'
import type { JsonValue } from '../../src/application/contracts.js'
import { CancellationController } from '../../src/application/cancellation.js'
import { ToolkitApplicationService } from '../../src/application/toolkit-application-service.js'
import { createDefaultCommandRegistry } from '../../src/cli/command-registry.js'
import { runCli } from '../../src/cli/main.js'
import type { CliCommandContribution } from '../../src/cli/types.js'
import { ErrorCodes } from '../../src/diagnostics/error-codes.js'
import { captureIo, createWorkspace, withTempDirectory } from '../helpers.js'

function ids() {
  return {
    createInvocationId: () => 'inv:cli-test' as const,
    createRunId: () => 'run:cli-test' as const,
  }
}

test('Top-level help lists only the three V1 commands', async () => {
  const output = captureIo()
  const execution = await runCli({
    argv: ['--help'],
    cwd: process.cwd(),
    service: new ToolkitApplicationService(),
    cancellation: new CancellationController().token,
    io: output.io,
    ...ids(),
  })
  assert.equal(execution.exitCode, 0)
  assert.match(output.stdout(), /build/)
  assert.match(output.stdout(), /inspect/)
  assert.match(output.stdout(), /run/)
  assert.doesNotMatch(output.stdout(), /watch|server|mcp|bench/)
})

test('Version is a single line and does not invoke the service', async () => {
  const output = captureIo()
  const execution = await runCli({
    argv: ['--version'],
    cwd: process.cwd(),
    service: new ToolkitApplicationService(),
    cancellation: new CancellationController().token,
    io: output.io,
    ...ids(),
  })
  assert.equal(execution.exitCode, 0)
  assert.match(output.stdout(), /^0\.1\.0\n$/)
})

test('Build delegates once and JSON output is one document', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    let calls = 0
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute() {
          calls += 1
          return { status: 'success', data: { kind: 'fake-build' } }
        },
      },
    })
    const output = captureIo()
    const execution = await runCli({
      argv: ['build', root, '--format', 'json'],
      cwd: root,
      service,
      cancellation: new CancellationController().token,
      io: output.io,
      ...ids(),
    })
    assert.equal(execution.exitCode, 0)
    assert.equal(calls, 1)
    assert.equal(output.stderr(), '')
    assert.equal(output.stdout().trim().split('\n').length, 1)
    assert.equal(JSON.parse(output.stdout()).status, 'success')
  })
})

test('Unknown command returns structured JSON usage failure', async () => {
  let serviceCalls = 0
  const service = new ToolkitApplicationService<JsonValue, unknown, JsonValue>({
    inspectUseCase: {
      async execute() {
        serviceCalls += 1
        return { status: 'success', data: {} }
      },
    },
  })
  const output = captureIo()
  const execution = await runCli({
    argv: ['unknown', '--format', 'json'],
    cwd: process.cwd(),
    service,
    cancellation: new CancellationController().token,
    io: output.io,
    ...ids(),
  })
  assert.equal(execution.exitCode, 2)
  assert.equal(output.stderr(), '')
  assert.equal(output.stdout().trim().split('\n').length, 1)
  const result = JSON.parse(output.stdout())
  assert.equal(result.kind, 'cliDiagnostic')
  assert.equal(Object.hasOwn(result, 'operation'), false)
  assert.equal(result.failure.code, ErrorCodes.cliUnknownCommand)
  assert.equal(serviceCalls, 0)
})

test('Invalid common option returns one CLI diagnostic document before Application Service', async () => {
  let buildCalls = 0
  const service = new ToolkitApplicationService<JsonValue>({
    buildUseCase: {
      async execute() {
        buildCalls += 1
        return { status: 'success', data: {} }
      },
    },
  })
  const output = captureIo()
  const execution = await runCli({
    argv: ['build', '--format', 'yaml', '--format', 'json'],
    cwd: process.cwd(),
    service,
    cancellation: new CancellationController().token,
    io: output.io,
    ...ids(),
  })

  assert.equal(execution.exitCode, 2)
  assert.equal(output.stderr(), '')
  assert.equal(output.stdout().trim().split('\n').length, 1)
  const result = JSON.parse(output.stdout())
  assert.equal(result.kind, 'cliDiagnostic')
  assert.equal(Object.hasOwn(result, 'operation'), false)
  assert.equal(result.failure.code, ErrorCodes.cliInvalidArgument)
  assert.equal(buildCalls, 0)
})

test('Duplicate common options fail before Application Service', async () => {
  const output = captureIo()
  const execution = await runCli({
    argv: ['build', '--format', 'json', '--format', 'json'],
    cwd: process.cwd(),
    service: new ToolkitApplicationService(),
    cancellation: new CancellationController().token,
    io: output.io,
    ...ids(),
  })
  assert.equal(execution.exitCode, 2)
  assert.equal(JSON.parse(output.stdout()).failure.code, ErrorCodes.cliConflictingOption)
})

test('Human warnings go to stderr without changing success', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute() {
          return {
            status: 'success',
            data: { kind: 'fake-build' },
            diagnostics: [{ severity: 'warning', code: 'TK_TEST_WARNING', phase: 'build', message: 'warning' }],
          }
        },
      },
    })
    const output = captureIo()
    const execution = await runCli({
      argv: ['build', '--no-color'],
      cwd: root,
      service,
      cancellation: new CancellationController().token,
      io: output.io,
      ...ids(),
    })
    assert.equal(execution.exitCode, 0)
    assert.match(output.stdout(), /fake-build/)
    assert.match(output.stderr(), /TK_TEST_WARNING/)
    assert.doesNotMatch(output.stderr(), /\u001B/)
  })
})

test('Reserved inspect command is explicit operation unavailable', async () => {
  const output = captureIo()
  const execution = await runCli({
    argv: ['inspect', 'sample.rpk', '--format', 'json'],
    cwd: process.cwd(),
    service: new ToolkitApplicationService(),
    cancellation: new CancellationController().token,
    io: output.io,
    ...ids(),
  })
  assert.equal(execution.exitCode, 10)
  assert.equal(JSON.parse(output.stdout()).failure.code, ErrorCodes.operationUnavailable)
})

test('TK-S08 can statically replace a reserved command contribution', async () => {
  const inspectContribution: CliCommandContribution = {
    name: 'inspect',
    summary: 'test inspect',
    usage: 'quickapp inspect <value>',
    parse(tokens) {
      return { value: tokens[0] ?? '' }
    },
    async invoke(service, request, context) {
      return service.inspect(request, context)
    },
  }
  const service = new ToolkitApplicationService<JsonValue, unknown, JsonValue>({
    inspectUseCase: {
      async execute(request) {
        return { status: 'success', data: request as JsonValue }
      },
    },
  })
  const output = captureIo()
  const execution = await runCli({
    argv: ['inspect', 'value', '--format', 'json'],
    cwd: process.cwd(),
    service,
    registry: createDefaultCommandRegistry({ inspect: inspectContribution }),
    cancellation: new CancellationController().token,
    io: output.io,
    ...ids(),
  })
  assert.equal(execution.exitCode, 0)
  assert.equal(JSON.parse(output.stdout()).data.value, 'value')
})

test('NO_COLOR disables ANSI without changing business results', async () => {
  const output = captureIo()
  const execution = await runCli({
    argv: ['inspect'],
    cwd: process.cwd(),
    service: new ToolkitApplicationService(),
    cancellation: new CancellationController().token,
    noColorEnvironment: true,
    io: output.io,
    ...ids(),
  })
  assert.equal(execution.exitCode, 10)
  assert.doesNotMatch(output.stderr(), /\u001B/)
})

test('SIGINT cancellation maps to exit 130', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const cancellation = new CancellationController()
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute() {
          cancellation.cancel('SIGINT')
          return { status: 'success', data: {} }
        },
      },
    })
    const output = captureIo()
    const execution = await runCli({
      argv: ['build', '--format', 'json'],
      cwd: root,
      service,
      cancellation: cancellation.token,
      io: output.io,
      ...ids(),
    })
    assert.equal(execution.exitCode, 130)
    assert.equal(JSON.parse(output.stdout()).status, 'cancelled')
  })
})

test('SIGTERM cancellation maps to exit 143', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const cancellation = new CancellationController()
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute() {
          cancellation.cancel('SIGTERM')
          return { status: 'success', data: {} }
        },
      },
    })
    const output = captureIo()
    const execution = await runCli({
      argv: ['build', '--format', 'json'],
      cwd: root,
      service,
      cancellation: cancellation.token,
      io: output.io,
      ...ids(),
    })
    assert.equal(execution.exitCode, 143)
  })
})

test('Renderer failure returns 70 without re-running the UseCase', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    let calls = 0
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute() {
          calls += 1
          return { status: 'success', data: {} }
        },
      },
    })
    const execution = await runCli({
      argv: ['build'],
      cwd: root,
      service,
      cancellation: new CancellationController().token,
      io: {
        writeStdout() {
          throw new Error('broken stdout')
        },
        writeStderr() {
          throw new Error('broken stderr')
        },
      },
      ...ids(),
    })
    assert.equal(execution.exitCode, 70)
    assert.equal(calls, 1)
  })
})
