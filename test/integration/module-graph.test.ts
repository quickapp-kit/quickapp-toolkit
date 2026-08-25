import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { CancellationController, OperationCancelledError } from '../../src/application/cancellation.js'
import { SourceFrontend } from '../../src/compiler/frontend/source-frontend.js'
import type { ParsedSource, SourceFrontendPort, UnresolvedReference } from '../../src/compiler/frontend/types.js'
import { ModuleGraphBuilder } from '../../src/compiler/module-graph/module-graph-builder.js'
import { DEFAULT_GRAPH_LIMITS, type GraphBuildResult, type GraphEdge, type ModuleNode } from '../../src/compiler/module-graph/types.js'
import { SourceAccess } from '../../src/workspace/source-access.js'
import { caseRoot, publicManifestValidator, validManifest } from '../compiler-helpers.js'
import { withTempDirectory } from '../helpers.js'

test('Case 001 builds the frozen reachable closure and relations', async () => {
  const { result, dispose } = await buildCase('quickapp-code-test1')
  try {
    assert.equal(result.status, 'success')
    if (result.status !== 'success') return
    assert.equal(result.model.pageModules.length, 2)
    assert.deepEqual(result.model.sharedModules.map((node) => node.sourcePath), [
      'src/helper/ajax.js',
      'src/helper/apis/example.js',
      'src/helper/apis/index.js',
      'src/helper/utils.js',
    ])
    assert.deepEqual(result.model.assets.map((asset) => asset.sourcePath), ['src/assets/images/logo.png'])
    assert.deepEqual(result.model.capabilities.map((item) => [item.name, item.status]), [
      ['system.device', 'required'],
      ['system.fetch', 'required'],
      ['system.prompt', 'required'],
      ['system.router', 'required'],
      ['system.shortcut', 'declaredOnly'],
    ])
    assert.equal(result.model.excludedWidgets.length, 1)
    assert.equal(result.diagnostics.some((item) => item.code === 'TK_WIDGET_EXCLUDED_V1'), true)
    assert.deepEqual([...result.parsedSources.keys()], [
      'src/app.ux',
      'src/assets/styles/mixins.less',
      'src/assets/styles/style.less',
      'src/assets/styles/variables.less',
      'src/helper/ajax.js',
      'src/helper/apis/example.js',
      'src/helper/apis/index.js',
      'src/helper/utils.js',
      'src/pages/Demo/index.ux',
      'src/pages/DemoDetail/index.ux',
    ])
  } finally {
    dispose()
  }
})

test('Case 002 builds only App and the declared Contract page', async () => {
  const { result, dispose } = await buildCase('quickapp-code-test2')
  try {
    assert.equal(result.status, 'success')
    if (result.status !== 'success') return
    assert.equal(result.model.entryRoute, '/pages/Contract')
    assert.equal(result.model.pageModules.length, 1)
    assert.equal(result.model.sharedModules.length, 0)
    assert.deepEqual([...result.parsedSources.keys()], ['src/app.ux', 'src/pages/Contract/index.ux'])
  } finally {
    dispose()
  }
})

test('Case 001 Widget parses only on explicit S03 request and declared device becomes required', async () => {
  const access = new SourceAccess(caseRoot('quickapp-code-test1'), [])
  try {
    const widget = await new SourceFrontend().parse({
      sourcePath: 'src/CardDemo/index.ux',
      sourceKind: 'pageUx',
      sourceAccess: access,
      cancellation: new CancellationController().token,
    })
    assert.equal(widget.status, 'success')
  } finally {
    access.dispose()
  }

  const manifest = validManifest({ features: [{ name: 'system.device' }] })
  const page = `<template><div></div></template><script>import device from '@system.device'; export default { device }</script>`
  await withWorkspace(JSON.stringify(manifest), { 'src/app.ux': '<script>export default {}</script>', 'src/pages/Home/index.ux': page }, async (result) => {
    assert.equal(result.status, 'success')
    if (result.status === 'success') assert.deepEqual(result.model.capabilities.map((item) => [item.name, item.status]), [['system.device', 'required']])
  })
})

test('Manifest CST rejects duplicate keys and public schema failures', async () => {
  await withWorkspace('{"package":"com.example.a","package":"com.example.b"}', {}, async (result) => {
    assert.equal(result.status, 'failure')
    assert.equal(result.diagnostics[0]?.code, 'TK_MANIFEST_DUPLICATE_KEY')
  })
  await withWorkspace(JSON.stringify({ package: 'invalid' }), {}, async (result) => {
    assert.equal(result.status, 'failure')
    assert.equal(result.diagnostics[0]?.code, 'TK_MANIFEST_SCHEMA_INVALID')
  })
})

test('Graph reports undeclared capability and style cycles before Lowering', async () => {
  const page = `<template><div></div></template><script>import device from '@system.device'; export default { device }</script>`
  await withWorkspace(JSON.stringify(validManifest()), { 'src/app.ux': '<script>export default {}</script>', 'src/pages/Home/index.ux': page }, async (result) => {
    assert.equal(result.status, 'failure')
    assert.equal(result.diagnostics.at(-1)?.code, 'TK_CAPABILITY_NOT_DECLARED')
  })
  const cyclePage = `<template><div></div></template><script>export default {}</script><style lang="less">@import '../../styles/a.less';</style>`
  await withWorkspace(JSON.stringify(validManifest()), {
    'src/app.ux': '<script>export default {}</script>',
    'src/pages/Home/index.ux': cyclePage,
    'src/styles/a.less': "@import './b.less';",
    'src/styles/b.less': "@import './a.less';",
  }, async (result) => {
    assert.equal(result.status, 'failure')
    assert.equal(result.diagnostics.at(-1)?.code, 'TK_STYLE_IMPORT_CYCLE')
  })
})

test('require.context applies one cumulative budget even when empty directories produce zero matches', async () => {
  const app = `<script>const files = require.context('./empty', true, /\\.never$/); export default { files }</script>`
  const directories = Array.from({ length: 8 }, (_, index) => `src/empty/d${index}`)
  await withWorkspace(JSON.stringify(validManifest()), {
    'src/app.ux': app,
    'src/pages/Home/index.ux': '<template><div></div></template><script>export default {}</script>',
  }, async (_result, access, manifest) => {
    const limited = await new ModuleGraphBuilder().build({
      manifest,
      sourceRoot: 'src',
      sourceAccess: access,
      frontend: new SourceFrontend(),
      schemaValidator: await publicManifestValidator(),
      cancellation: new CancellationController().token,
      limits: { ...DEFAULT_GRAPH_LIMITS, maxContextEntries: 12 },
    })
    assert.equal(limited.status, 'failure')
    assert.equal(limited.diagnostics.at(-1)?.code, 'TK_CONTEXT_LIMIT_EXCEEDED')
    assert.match(limited.diagnostics.at(-1)?.message ?? '', /matched=0/)
  }, directories)
})

test('shared Style is parsed once and its transitive Style and asset relations propagate to both Page owners', async () => {
  const manifest = validManifest({
    router: {
      entry: 'pages/A',
      pages: {
        'pages/A': { component: 'index' },
        'pages/B': { component: 'index' },
      },
    },
  })
  const page = `<template><div></div></template><script>export default {}</script><style lang="less">@import '../../styles/shared.less';</style>`
  await withWorkspace(JSON.stringify(manifest), {
    'src/app.ux': '<script>export default {}</script>',
    'src/pages/A/index.ux': page,
    'src/pages/B/index.ux': page,
    'src/styles/shared.less': "@import './nested.less'; .shared { background: url('./pixel.png'); }",
    'src/styles/nested.less': '.nested { color: #000; }',
    'src/styles/pixel.png': 'png',
  }, async (_result, access, manifestSource) => {
    const parseCounts = new Map<string, number>()
    const delegate = new SourceFrontend()
    const frontend: SourceFrontendPort = {
      async parse(request) {
        parseCounts.set(request.sourcePath, (parseCounts.get(request.sourcePath) ?? 0) + 1)
        return delegate.parse(request)
      },
    }
    const rebuilt = await new ModuleGraphBuilder().build({
      manifest: manifestSource,
      sourceRoot: 'src',
      sourceAccess: access,
      frontend,
      schemaValidator: await publicManifestValidator(),
      cancellation: new CancellationController().token,
    })
    assert.equal(rebuilt.status, 'success')
    if (rebuilt.status !== 'success') return
    assert.equal(parseCounts.get('src/styles/shared.less'), 1)
    assert.equal(parseCounts.get('src/styles/nested.less'), 1)
    for (const owner of ['@quickapp-kit/page/pages/A', '@quickapp-kit/page/pages/B']) {
      const ownerEdges: readonly GraphEdge[] = rebuilt.model.graph.edges.filter((edge: GraphEdge) => edge.fromModuleId === owner)
      assert.equal(ownerEdges.some((edge) => edge.kind === 'style' && edge.target === 'src/styles/shared.less'), true)
      assert.equal(ownerEdges.some((edge) => edge.kind === 'style' && edge.target === 'src/styles/nested.less'), true)
      assert.equal(ownerEdges.some((edge) => edge.kind === 'asset' && edge.target === 'src/styles/pixel.png'), true)
    }
    assert.equal(rebuilt.model.assets[0]?.references.length, 2)
  })
})

test('Manifest, resolved model, ParsedSource values and ParsedSourceSet are runtime immutable', async () => {
  const { result, dispose } = await buildCase('quickapp-code-test1')
  try {
    assert.equal(result.status, 'success')
    if (result.status !== 'success') return
    const manifest = result.model.manifest
    assert.equal(Object.isFrozen(manifest), true)
    assert.equal(Object.isFrozen(manifest.permissions), true)
    assert.equal(Object.isFrozen(manifest.permissions[0] as object), true)
    assert.equal(Object.isFrozen(manifest.display as object), true)
    assert.equal(Object.isFrozen(manifest.raw), true)
    assert.throws(() => { (manifest.permissions[0] as { origin: string }).origin = 'changed' }, TypeError)
    assert.throws(() => {
      const display = manifest.display as { pages: Record<string, { titleBarText: string }> }
      ;(display.pages['pages/Demo'] as { titleBarText: string }).titleBarText = 'changed'
    }, TypeError)
    assert.throws(() => {
      const raw = manifest.raw as { router: { entry: string } }
      raw.router.entry = 'pages/Changed'
    }, TypeError)
    assert.throws(() => { (result.model.pageModules as ModuleNode[]).push({} as ModuleNode) }, TypeError)

    const mutableMap = result.parsedSources as unknown as Map<string, ParsedSource>
    assert.equal(typeof mutableMap.set, 'undefined')
    assert.throws(() => mutableMap.set('src/injected.js', result.parsedSources.values().next().value as ParsedSource), TypeError)
    const app = result.parsedSources.get('src/app.ux')
    assert.ok(app)
    assert.equal(Object.isFrozen(app), true)
    assert.throws(() => { (app.references as UnresolvedReference[]).push({} as UnresolvedReference) }, TypeError)
  } finally {
    dispose()
  }
})

test('Graph output is deterministic for repeated Case 001 builds', async () => {
  const first = await buildCase('quickapp-code-test1')
  const second = await buildCase('quickapp-code-test1')
  try {
    assert.equal(first.result.status, 'success')
    assert.equal(second.result.status, 'success')
    if (first.result.status === 'success' && second.result.status === 'success') {
      assert.equal(JSON.stringify(first.result.model), JSON.stringify(second.result.model))
    }
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('Graph consumes one SourceFrontendPort and does not inspect its syntax payload', async () => {
  let calls = 0
  const fake: SourceFrontendPort = {
    async parse(request) {
      calls += 1
      const source = await request.sourceAccess.read(request.sourcePath, { content: 'strictUtf8', maxBytes: 1024 })
      return {
        status: 'success',
        diagnostics: [],
        parsedSource: request.sourceKind === 'sharedJs' || request.sourceKind === 'style'
          ? request.sourceKind === 'sharedJs'
            ? { sourcePath: request.sourcePath, sourceKind: 'sharedJs', sourceSha256: source.sha256, references: [], featureUsage: [], program: fakeSyntax() }
            : { sourcePath: request.sourcePath, sourceKind: 'style', sourceSha256: source.sha256, references: [], featureUsage: [], stylesheet: [] }
          : { sourcePath: request.sourcePath, sourceKind: request.sourceKind, sourceSha256: source.sha256, references: [], featureUsage: [], script: fakeSyntax() },
      }
    },
  }
  await withWorkspace(JSON.stringify(validManifest()), { 'src/app.ux': 'opaque', 'src/pages/Home/index.ux': 'opaque' }, async (result, access, manifest) => {
    const rebuilt = await new ModuleGraphBuilder().build({ manifest, sourceRoot: 'src', sourceAccess: access, frontend: fake, schemaValidator: await publicManifestValidator(), cancellation: new CancellationController().token })
    assert.equal(result.status, 'failure')
    assert.equal(rebuilt.status, 'success')
    assert.equal(calls, 2)
  })
})

test('Graph cancellation prevents publication and repeated builds release session state', async () => {
  const access = new SourceAccess(caseRoot('quickapp-code-test2'), [])
  const manifest = await access.read('src/manifest.json', { content: 'strictUtf8', maxBytes: 2_000_000 })
  const cancelled = new CancellationController()
  cancelled.cancel()
  await assert.rejects(new ModuleGraphBuilder().build({ manifest, sourceRoot: 'src', sourceAccess: access, frontend: new SourceFrontend(), schemaValidator: await publicManifestValidator(), cancellation: cancelled.token }), OperationCancelledError)
  for (let index = 0; index < 100; index += 1) {
    const result = await new ModuleGraphBuilder().build({ manifest, sourceRoot: 'src', sourceAccess: access, frontend: new SourceFrontend(), schemaValidator: await publicManifestValidator(), cancellation: new CancellationController().token })
    assert.equal(result.status, 'success')
  }
  access.dispose()
  assert.equal(access.disposed, true)
})

async function buildCase(caseName: 'quickapp-code-test1' | 'quickapp-code-test2'): Promise<{ result: GraphBuildResult; dispose(): void }> {
  const access = new SourceAccess(caseRoot(caseName), [])
  const manifest = await access.read('src/manifest.json', { content: 'strictUtf8', maxBytes: 2_000_000 })
  const result = await new ModuleGraphBuilder().build({ manifest, sourceRoot: 'src', sourceAccess: access, frontend: new SourceFrontend(), schemaValidator: await publicManifestValidator(), cancellation: new CancellationController().token })
  return { result, dispose: () => access.dispose() }
}

async function withWorkspace(
  manifestText: string,
  files: Readonly<Record<string, string>>,
  run: (result: GraphBuildResult, access: SourceAccess, manifest: Awaited<ReturnType<SourceAccess['read']>>) => Promise<void>,
  directories: readonly string[] = [],
): Promise<void> {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src/manifest.json'), manifestText)
    for (const [logicalPath, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true })
      await writeFile(path.join(root, logicalPath), content)
    }
    for (const logicalPath of directories) await mkdir(path.join(root, logicalPath), { recursive: true })
    const access = new SourceAccess(await realpath(root), [])
    const manifest = await access.read('src/manifest.json', { content: 'strictUtf8', maxBytes: 2_000_000 })
    const result = await new ModuleGraphBuilder().build({ manifest, sourceRoot: 'src', sourceAccess: access, frontend: new SourceFrontend(), schemaValidator: await publicManifestValidator(), cancellation: new CancellationController().token })
    await run(result, access, manifest)
    access.dispose()
  })
}

function fakeSyntax() {
  const span = { startByte: 0, endByte: 0, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
  return { type: 'Opaque', span, fields: Object.freeze({ opaqueRoute: 'must-not-be-read' }) }
}
