import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { CancellationController } from '../../src/application/cancellation.js'
import { ToolkitFault } from '../../src/application/fault.js'
import { ErrorCodes } from '../../src/diagnostics/error-codes.js'
import { WorkspaceResolver } from '../../src/workspace/workspace-resolver.js'
import { createWorkspace, withTempDirectory } from '../helpers.js'

const token = () => new CancellationController().token

test('Workspace is discovered from the closest nested directory', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const nested = path.join(root, 'src', 'pages', 'Home')
    await mkdir(nested, { recursive: true })
    const resolution = await new WorkspaceResolver().resolve({ cwd: nested }, token())
    try {
      assert.equal(resolution.context.root, await realpath(root))
      assert.equal(resolution.context.manifest.logicalPath, 'src/manifest.json')
      assert.equal(resolution.context.config.workspace.sourceRoot.source, 'default')
    } finally {
      resolution.sourceAccess.dispose()
    }
  })
})

test('Nested Workspace wins over parent Workspace', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root, { package: 'parent' })
    const child = path.join(root, 'child')
    await createWorkspace(child, { package: 'child' })
    const resolution = await new WorkspaceResolver().resolve({ cwd: path.join(child, 'src') }, token())
    try {
      assert.equal(resolution.context.root, await realpath(child))
      assert.match(resolution.context.manifest.text ?? '', /child/)
    } finally {
      resolution.sourceAccess.dispose()
    }
  })
})

test('Explicit Workspace without a root marker fails deterministically', async () => {
  await withTempDirectory(async (root) => {
    await assert.rejects(
      new WorkspaceResolver().resolve({ cwd: root, workspace: root }, token()),
      (error: unknown) =>
        error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.workspaceMarkerMissing,
    )
  })
})

test('Configuration and request overrides preserve provenance', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, 'source'), { recursive: true })
    await writeFile(path.join(root, 'source', 'manifest.json'), '{}\n')
    await writeFile(
      path.join(root, 'quickapp.config.json'),
      JSON.stringify({
        schemaVersion: 1,
        workspace: { sourceRoot: 'source', outputRoot: 'out', cacheRoot: 'cache' },
      }),
    )
    const resolution = await new WorkspaceResolver().resolve(
      { cwd: root, overrides: { outputRoot: 'custom-out' } },
      token(),
    )
    try {
      assert.equal(resolution.context.config.workspace.sourceRoot.source, 'config')
      assert.equal(resolution.context.config.workspace.outputRoot.source, 'request')
      assert.equal(resolution.context.config.workspace.outputRoot.value, 'custom-out')
      assert.equal(resolution.context.config.workspace.cacheRoot.source, 'config')
    } finally {
      resolution.sourceAccess.dispose()
    }
  })
})

test('Unknown configuration fields fail instead of being ignored', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    await writeFile(
      path.join(root, 'quickapp.config.json'),
      JSON.stringify({ schemaVersion: 1, workspace: { unknown: true } }),
    )
    await assert.rejects(
      new WorkspaceResolver().resolve({ cwd: root }, token()),
      (error: unknown) =>
        error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.configUnknownField,
    )
  })
})

test('Unknown configuration versions and invalid JSON fail deterministically', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const config = path.join(root, 'quickapp.config.json')
    await writeFile(config, JSON.stringify({ schemaVersion: 2 }))
    await assert.rejects(
      new WorkspaceResolver().resolve({ cwd: root }, token()),
      (error: unknown) =>
        error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.configVersionUnsupported,
    )
    await writeFile(config, '{invalid')
    await assert.rejects(
      new WorkspaceResolver().resolve({ cwd: root }, token()),
      (error: unknown) =>
        error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.configInvalidJson,
    )
  })
})

test('Explicit configuration outside the Workspace is rejected', async () => {
  await withTempDirectory(async (root) => {
    await withTempDirectory(async (outside) => {
      await createWorkspace(root)
      const config = path.join(outside, 'config.json')
      await writeFile(config, JSON.stringify({ schemaVersion: 1 }))
      await assert.rejects(
        new WorkspaceResolver().resolve({ cwd: root, config }, token()),
        (error: unknown) =>
          error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.configInvalidValue,
      )
    })
  })
})

test('Overlapping source/output paths are rejected', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    await writeFile(
      path.join(root, 'quickapp.config.json'),
      JSON.stringify({
        schemaVersion: 1,
        workspace: { sourceRoot: 'src', outputRoot: 'src/out', cacheRoot: 'cache' },
      }),
    )
    await assert.rejects(
      new WorkspaceResolver().resolve({ cwd: root }, token()),
      (error: unknown) =>
        error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.workspacePathConflict,
    )
  })
})

test('Semantic environment variables do not alter Workspace resolution', async () => {
  await withTempDirectory(async (root) => {
    await createWorkspace(root)
    const before = process.env.QUICKAPP_SOURCE_ROOT
    process.env.QUICKAPP_SOURCE_ROOT = 'other'
    try {
      const resolution = await new WorkspaceResolver().resolve({ cwd: root }, token())
      try {
        assert.equal(resolution.context.config.workspace.sourceRoot.value, 'src')
      } finally {
        resolution.sourceAccess.dispose()
      }
    } finally {
      if (before === undefined) delete process.env.QUICKAPP_SOURCE_ROOT
      else process.env.QUICKAPP_SOURCE_ROOT = before
    }
  })
})
