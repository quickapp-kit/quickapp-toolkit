import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { CancellationController } from '../../src/application/cancellation.js'
import { WorkspaceResolver } from '../../src/workspace/workspace-resolver.js'

for (const [name, directory] of [
  ['Case 001', '../quickapp-examples/alliance-hap-case001'],
  ['Case 002', '../quickapp-examples/quickapp-code-test2'],
  ['BLOCK-001', '../quickapp-examples/quickapp-code-test3'],
] as const) {
  test(`${name} is accepted by the default Workspace contract`, async () => {
    const root = path.resolve(process.cwd(), directory)
    const resolution = await new WorkspaceResolver().resolve(
      { cwd: root },
      new CancellationController().token,
    )
    try {
      assert.equal(resolution.context.root, root)
      assert.equal(resolution.context.manifest.logicalPath, 'src/manifest.json')
      const expected = createHash('sha256')
        .update(await readFile(path.join(root, 'src', 'manifest.json')))
        .digest('hex')
      assert.equal(resolution.context.manifest.sha256, expected)
      assert.equal(resolution.context.manifest.contentKind, 'utf8')
    } finally {
      resolution.sourceAccess.dispose()
    }
  })
}
