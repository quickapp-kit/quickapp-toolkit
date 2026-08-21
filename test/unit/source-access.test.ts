import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { ToolkitFault } from '../../src/application/fault.js'
import { ErrorCodes } from '../../src/diagnostics/error-codes.js'
import { SourceAccess } from '../../src/workspace/source-access.js'
import { withTempDirectory } from '../helpers.js'

test('SourceAccess reads immutable copies and returns deterministic listings', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'z.ux'), 'z')
    await writeFile(path.join(root, 'src', 'a.ux'), 'a')
    const access = new SourceAccess(await realpath(root), [])
    const entries = await access.list('src', { maxEntries: 10 })
    assert.deepEqual(entries.map(({ logicalPath }) => logicalPath), ['src/a.ux', 'src/z.ux'])

    const first = await access.read('src/a.ux', { content: 'strictUtf8', maxBytes: 10 })
    const mutable = first.bytes as Uint8Array
    mutable[0] = 122
    const second = await access.read('src/a.ux', { content: 'strictUtf8', maxBytes: 10 })
    assert.equal(second.text, 'a')
    assert.equal(second.sha256, 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
    access.dispose()
  })
})

test('SourceAccess enforces directory limits and excludes output roots', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, 'src'))
    await mkdir(path.join(root, 'dist'))
    await writeFile(path.join(root, 'src', 'a.txt'), 'a')
    await writeFile(path.join(root, 'src', 'b.txt'), 'b')
    await writeFile(path.join(root, 'dist', 'old.txt'), 'old')
    const canonicalRoot = await realpath(root)
    const access = new SourceAccess(canonicalRoot, [path.join(canonicalRoot, 'dist')])
    await assert.rejects(
      access.list('src', { maxEntries: 1 }),
      (error: unknown) => error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.sourceTooLarge,
    )
    await assert.rejects(
      access.read('dist/old.txt', { content: 'bytes', maxBytes: 100 }),
      (error: unknown) =>
        error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.workspacePathEscape,
    )
    access.dispose()
  })
})

test('SourceAccess rejects path traversal and size overflow', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'large.txt'), '12345')
    const access = new SourceAccess(await realpath(root), [])
    await assert.rejects(
      access.read('../outside', { content: 'bytes', maxBytes: 10 }),
      (error: unknown) =>
        error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.workspacePathEscape,
    )
    await assert.rejects(
      access.read('src/large.txt', { content: 'bytes', maxBytes: 4 }),
      (error: unknown) => error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.sourceTooLarge,
    )
    access.dispose()
  })
})

test('SourceAccess rejects invalid UTF-8', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'bad.txt'), Buffer.from([0xc3, 0x28]))
    const access = new SourceAccess(await realpath(root), [])
    await assert.rejects(
      access.read('src/bad.txt', { content: 'strictUtf8', maxBytes: 10 }),
      (error: unknown) =>
        error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.sourceInvalidUtf8,
    )
    access.dispose()
  })
})

test('SourceAccess rejects symlinks escaping the Workspace', async () => {
  await withTempDirectory(async (root) => {
    await withTempDirectory(async (outside) => {
      await mkdir(path.join(root, 'src'))
      await writeFile(path.join(outside, 'secret.txt'), 'secret')
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'src', 'link.txt'))
      const access = new SourceAccess(await realpath(root), [])
      await assert.rejects(
        access.read('src/link.txt', { content: 'bytes', maxBytes: 100 }),
        (error: unknown) =>
          error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.workspacePathEscape,
      )
      access.dispose()
    })
  })
})

test('SourceAccess detects canonical path aliases', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'real.txt'), 'same')
    await symlink('real.txt', path.join(root, 'src', 'alias.txt'))
    const access = new SourceAccess(await realpath(root), [])
    await access.read('src/real.txt', { content: 'bytes', maxBytes: 100 })
    await assert.rejects(
      access.read('src/alias.txt', { content: 'bytes', maxBytes: 100 }),
      (error: unknown) =>
        error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.workspacePathConflict,
    )
    access.dispose()
  })
})

test('SourceAccess detects files changed during an operation', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, 'src'))
    const file = path.join(root, 'src', 'value.txt')
    await writeFile(file, 'before')
    const access = new SourceAccess(await realpath(root), [])
    await access.read('src/value.txt', { content: 'bytes', maxBytes: 100 })
    await writeFile(file, 'after-change')
    await assert.rejects(
      access.verifyUnchanged(),
      (error: unknown) =>
        error instanceof ToolkitFault && error.diagnostic.code === ErrorCodes.workspaceChanged,
    )
    access.dispose()
    access.dispose()
    assert.equal(access.disposed, true)
  })
})
