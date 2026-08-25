import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { CancellationController, OperationCancelledError } from '../../src/application/cancellation.js'
import { FRONTEND_FEATURE_MATRIX } from '../../src/compiler/frontend/feature-matrix.js'
import { SourceCoordinateMap } from '../../src/compiler/frontend/source-coordinate-map.js'
import { SourceFrontend } from '../../src/compiler/frontend/source-frontend.js'
import { DEFAULT_FRONTEND_LIMITS, type FrontendSourceKind } from '../../src/compiler/frontend/types.js'
import { SourceAccess } from '../../src/workspace/source-access.js'
import { withTempDirectory } from '../helpers.js'

test('SourceCoordinateMap uses UTF-8 bytes and Unicode-scalar columns across CRLF', () => {
  const span = new SourceCoordinateMap('a\r\n中😀x').span(3, 6)
  assert.deepEqual(span, {
    startByte: 3,
    endByte: 10,
    start: { line: 2, column: 1 },
    end: { line: 2, column: 3 },
  })
})

test('SourceFrontend parses Page UX into compiler-owned syntax and unresolved references', async () => {
  await withSource(
    'src/pages/Home/index.ux',
    'pageUx',
    `<template>\n<div class="page"><text>{{ title }}</text><input type="button" onclick="go" /></div>\n</template>\n<script>import router from '@system.router'; export default { private: { title: '中😀' }, go() {} }</script>\n<style>.page { color: #000; }</style>`,
    async (result) => {
      assert.equal(result.status, 'success')
      if (result.status !== 'success') return
      assert.equal(result.parsedSource.sourceKind, 'pageUx')
      assert.deepEqual(result.parsedSource.references.map((item) => [item.kind, item.specifier]), [['capability', '@system.router']])
      const serialized = JSON.stringify(result.parsedSource)
      assert.equal(serialized.includes('resolvedTarget'), false)
      assert.equal(serialized.includes('moduleId'), false)
      assert.equal(serialized.includes('templateNodeId'), false)
    },
  )
})

test('SourceFrontend returns stable diagnostics for unsupported and malformed syntax', async () => {
  const cases: Array<[string, string]> = [
    ['<template><canvas></canvas></template><script>export default {}</script>', 'TK_TEMPLATE_FEATURE_UNSUPPORTED_V1'],
    ['<template><div>{{ }}</div></template><script>export default {}</script>', 'TK_TEMPLATE_SYNTAX_ERROR'],
    ['<template><div></div></template><script>const value = 1</script>', 'TK_SCRIPT_DEFAULT_EXPORT_REQUIRED'],
    ['<template><div></div></template><script>import("./x.js"); export default {}</script>', 'TK_SCRIPT_MODULE_REFERENCE_UNSUPPORTED'],
    ['<template><div></div></template><script>export default {}</script><style>@media (x) { .a {} }</style>', 'TK_STYLE_FEATURE_UNSUPPORTED_V1'],
  ]
  for (const [source, code] of cases) {
    await withSource('src/pages/Home/index.ux', 'pageUx', source, async (result) => {
      assert.equal(result.status, 'failure')
      assert.equal(result.diagnostics[0]?.code, code)
    })
  }
})

test('SourceFrontend enforces limits and cancellation atomically', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src/app.ux'), '<script>export default { onCreate() {} }</script>')
    const access = new SourceAccess(await realpath(root), [])
    const frontend = new SourceFrontend()
    const active = new CancellationController()
    const limited = await frontend.parse({
      sourcePath: 'src/app.ux',
      sourceKind: 'appUx',
      sourceAccess: access,
      cancellation: active.token,
      limits: { ...DEFAULT_FRONTEND_LIMITS, maxAstNodes: 1 },
    })
    assert.equal(limited.status, 'failure')
    assert.equal(limited.diagnostics[0]?.code, 'TK_FRONTEND_LIMIT_EXCEEDED')
    const cancelled = new CancellationController()
    cancelled.cancel()
    await assert.rejects(
      frontend.parse({ sourcePath: 'src/app.ux', sourceKind: 'appUx', sourceAccess: access, cancellation: cancelled.token }),
      OperationCancelledError,
    )
    access.dispose()
  })
})

test('SourceFrontend output is deterministic and parser feature matrix is unique', async () => {
  assert.equal(new Set(FRONTEND_FEATURE_MATRIX.map((feature) => feature.featureId)).size, FRONTEND_FEATURE_MATRIX.length)
  await withSource('src/app.ux', 'appUx', '<script>const x = require("./x"); export default { x }</script>', async (first, parseAgain) => {
    const second = await parseAgain()
    assert.equal(JSON.stringify(first), JSON.stringify(second))
  })
})

async function withSource(
  logicalPath: string,
  sourceKind: FrontendSourceKind,
  content: string,
  run: (result: Awaited<ReturnType<SourceFrontend['parse']>>, parseAgain: () => ReturnType<SourceFrontend['parse']>) => Promise<void>,
): Promise<void> {
  await withTempDirectory(async (root) => {
    await mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true })
    await writeFile(path.join(root, logicalPath), content)
    const access = new SourceAccess(await realpath(root), [])
    const frontend = new SourceFrontend()
    const controller = new CancellationController()
    const parseAgain = () => frontend.parse({ sourcePath: logicalPath, sourceKind, sourceAccess: access, cancellation: controller.token })
    await run(await parseAgain(), parseAgain)
    access.dispose()
  })
}
