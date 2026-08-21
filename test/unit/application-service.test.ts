import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { assertToolkitResult, type JsonValue } from '../../src/application/contracts.js'
import { CancellationController } from '../../src/application/cancellation.js'
import { ToolkitApplicationService } from '../../src/application/toolkit-application-service.js'
import type { BuildInvocation, BuildUseCasePort, InvocationContext } from '../../src/application/use-case-ports.js'
import { ErrorCodes } from '../../src/diagnostics/error-codes.js'
import type { BuildObservationMarker, MonotonicClock, ToolkitObservationPort } from '../../src/observation/toolkit-observation-port.js'
import { createWorkspace, withTempDirectory } from '../helpers.js'

function context(cancellation = new CancellationController()): InvocationContext {
  return {
    invocationId: 'inv:test',
    runId: 'run:test',
    cwd: process.cwd(),
    cancellation: cancellation.token,
  }
}

class FakeClock implements MonotonicClock {
  readonly domain = 'test-clock'
  #value = 0
  nowNs(): number {
    return this.#value++
  }
}

class RecordingObservation implements ToolkitObservationPort {
  readonly markers: BuildObservationMarker[] = []
  emit(marker: BuildObservationMarker): void {
    this.markers.push(marker)
  }
}

test('Application Service delegates build once and disposes the session', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    let invocation: BuildInvocation | undefined
    let calls = 0
    const buildUseCase: BuildUseCasePort<JsonValue> = {
      async execute(value) {
        calls += 1
        invocation = value
        return { status: 'success', data: { kind: 'fake-build' } }
      },
    }
    const observation = new RecordingObservation()
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase,
      observation,
      clock: new FakeClock(),
    })
    const result = await service.build({ workspace: root }, { ...context(), cwd: root })

    assert.equal(result.status, 'success')
    assert.equal(calls, 1)
    assert.equal(invocation?.sourceAccess.disposed, true)
    assert.deepEqual(observation.markers.map(({ markerName }) => markerName), [
      'build.started',
      'build.completed',
    ])
  })
})

test('Workspace failure does not invoke build and produces failed marker', async () => {
  await withTempDirectory(async (root) => {
    let calls = 0
    const observation = new RecordingObservation()
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute() {
          calls += 1
          return { status: 'success', data: {} }
        },
      },
      observation,
      clock: new FakeClock(),
    })
    const result = await service.build({}, { ...context(), cwd: root })

    assert.equal(result.status, 'failure')
    assert.equal(result.failure.code, ErrorCodes.workspaceNotFound)
    assert.equal(calls, 0)
    assert.deepEqual(observation.markers.map(({ markerName }) => markerName), [
      'build.started',
      'build.failed',
    ])
    assert.equal(observation.markers[1]?.errorCode, ErrorCodes.workspaceNotFound)
  })
})

test('Unexpected UseCase exceptions are hidden behind TK_INTERNAL_ERROR', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute() {
          throw new Error('sensitive internal detail')
        },
      },
    })
    const result = await service.build({}, { ...context(), cwd: root })
    assert.equal(result.status, 'failure')
    assert.equal(result.failure.code, ErrorCodes.internalError)
    assert.doesNotMatch(result.diagnostics[0]?.message ?? '', /sensitive/)
  })
})

test('Observation failures do not change a successful build result', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute() {
          return { status: 'success', data: { ok: true } }
        },
      },
      observation: {
        emit() {
          throw new Error('collector unavailable')
        },
      },
    })
    const result = await service.build({}, { ...context(), cwd: root })
    assert.equal(result.status, 'success')
  })
})

test('Cancellation prevents UseCase invocation', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const cancellation = new CancellationController()
    cancellation.cancel('SIGINT')
    let calls = 0
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute() {
          calls += 1
          return { status: 'success', data: {} }
        },
      },
    })
    const result = await service.build({}, { ...context(cancellation), cwd: root })
    assert.equal(result.status, 'cancelled')
    assert.equal(calls, 0)
  })
})

test('Uninstalled inspect and run operations fail explicitly', async () => {
  const service = new ToolkitApplicationService()
  const inspect = await service.inspect({}, context())
  const run = await service.run({}, context())
  assert.equal(inspect.status, 'failure')
  assert.equal(inspect.failure.code, ErrorCodes.operationUnavailable)
  assert.equal(run.status, 'failure')
  assert.equal(run.failure.code, ErrorCodes.operationUnavailable)
})

test('Application Service returns only operation-scoped ToolkitResult envelopes', async () => {
  const service = new ToolkitApplicationService()
  const results = [await service.inspect({}, context()), await service.run({}, context())]

  for (const result of results) {
    assertToolkitResult(result)
    assert.equal(['build', 'inspect', 'run'].includes(result.operation), true)
    assert.equal(Object.hasOwn(result, 'kind'), false)
  }
})

test('Artifact hash is copied to completed marker only when valid', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const observation = new RecordingObservation()
    const hash = 'a'.repeat(64)
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute() {
          return { status: 'success', data: { artifactSha256: hash } }
        },
      },
      observation,
      clock: new FakeClock(),
    })
    await service.build({ workspace: path.resolve(root) }, { ...context(), cwd: root })
    assert.equal(observation.markers[1]?.artifactSha256, hash)
  })
})

test('Repeated builds release every SourceAccess session', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const sessions: BuildInvocation[] = []
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute(invocation) {
          sessions.push(invocation)
          return { status: 'success', data: { ok: true } }
        },
      },
    })
    for (let index = 0; index < 100; index += 1) {
      const result = await service.build(
        {},
        {
          invocationId: `inv:repeat-${index}`,
          runId: `run:repeat-${index}`,
          cwd: root,
          cancellation: new CancellationController().token,
        },
      )
      assert.equal(result.status, 'success')
    }
    assert.equal(sessions.length, 100)
    assert.equal(sessions.every(({ sourceAccess }) => sourceAccess.disposed), true)
  })
})

test('Concurrent library invocations keep Workspace and IDs isolated', async () => {
  await withTempDirectory(async (root) => {
    const roots = [path.join(root, 'one'), path.join(root, 'two')]
    await Promise.all(roots.map((workspace) => createWorkspace(workspace)))
    const observed: Array<{ root: string; invocationId: string; runId: string }> = []
    const service = new ToolkitApplicationService<JsonValue>({
      buildUseCase: {
        async execute(invocation) {
          observed.push({
            root: invocation.workspace.root,
            invocationId: invocation.context.invocationId,
            runId: invocation.context.runId,
          })
          return { status: 'success', data: { root: invocation.workspace.root } }
        },
      },
    })
    const results = await Promise.all(
      roots.map((workspace, index) =>
        service.build(
          {},
          {
            invocationId: `inv:concurrent-${index}`,
            runId: `run:concurrent-${index}`,
            cwd: workspace,
            cancellation: new CancellationController().token,
          },
        ),
      ),
    )
    assert.equal(results.every(({ status }) => status === 'success'), true)
    assert.equal(new Set(observed.map(({ root: value }) => value)).size, 2)
    assert.equal(new Set(observed.map(({ invocationId }) => invocationId)).size, 2)
    assert.equal(new Set(observed.map(({ runId }) => runId)).size, 2)
  })
})
