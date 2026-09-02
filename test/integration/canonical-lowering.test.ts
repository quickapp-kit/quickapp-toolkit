import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { CancellationController, OperationCancelledError } from '../../src/application/cancellation.js'
import { CanonicalLowerer } from '../../src/compiler/lowering/index.js'
import type { CanonicalLoweringResult } from '../../src/compiler/lowering/types.js'
import { ModuleGraphBuilder } from '../../src/compiler/module-graph/module-graph-builder.js'
import type { GraphBuildResult } from '../../src/compiler/module-graph/types.js'
import { SourceFrontend } from '../../src/compiler/frontend/source-frontend.js'
import { SourceAccess } from '../../src/workspace/source-access.js'
import { caseRoot, publicManifestValidator, validManifest } from '../compiler-helpers.js'
import { withTempDirectory } from '../helpers.js'

test('TK-S04 Case 001 lowers Host, Style, Binding, Handler and module facts once', async () => {
  const { result, dispose } = await buildCase('alliance-hap-case001')
  try {
    const lowered = lower(result)
    assert.equal(lowered.status, 'success')
    if (lowered.status !== 'success') return
    assert.equal(lowered.model.modelVersion, 1)
    assert.equal(lowered.model.pages.length, 2)
    assert.equal(lowered.model.sharedModules.length, 4)
    assert.equal(lowered.model.appModule.references.length, 2)
    for (const page of lowered.model.pages) {
      assert.equal(page.rootTemplateNodeId, 1)
      assert.deepEqual(page.nodes.map((node) => node.templateNodeId), page.nodes.map((_node, index) => index + 1))
      assert.deepEqual(page.bindings.map((binding) => binding.templateBindingId), page.bindings.map((_binding, index) => index + 1))
      assert.deepEqual(page.handlers.map((handler) => handler.templateHandlerId), page.handlers.map((_handler, index) => index + 1))
      assert.ok(page.nodes.every((node) => Object.keys(node.host.style).every((key) => !key.includes('-'))))
    }
    const demo = lowered.model.pages.find((page) => page.route === '/pages/Demo')
    assert.ok(demo)
    assert.equal(demo.nodes[0]?.host.type, 'View')
    assert.equal(demo.nodes[1]?.host.type, 'Text')
    assert.equal(demo.nodes[2]?.host.type, 'Button')
    assert.equal(demo.nodes[2]?.host.props.enabled, true)
    assert.equal(demo.bindings[0]?.resultType, 'string')
    assert.equal(demo.handlers[0]?.eventType, 'click')
    assert.equal(demo.handlers[0]?.methodName, 'onDetailBtnClick')
    assert.equal(demo.nodes[2]?.host.style.backgroundColor, '#09BA07')
    assert.equal(demo.nodes[2]?.host.style.width?.value, 450)
    assert.equal(demo.templateId, 'page:/pages/Demo')
    assert.deepEqual(demo.stateFields.map((field) => field.name), ['title'])
    assert.equal(demo.bindings[0]?.evaluator.kind, 'expression')
    if (demo.bindings[0]?.evaluator.kind === 'expression') assert.deepEqual(demo.bindings[0].evaluator.expression.stateBindings, ['title'])
    assert.deepEqual(demo.module.references.find((reference) => reference.kind === 'capability')?.targets, ['@app-module/system.router'])
    const modules = [lowered.model.appModule, ...lowered.model.sharedModules, ...lowered.model.pages.map((page) => page.module)]
    const packageIds = new Set(modules.map((module) => module.moduleId))
    for (const module of modules) {
      assert.equal(module.dependencies.includes(module.moduleId), false)
      assert.equal(module.dependencies.every((dependency) => packageIds.has(dependency)), true)
      assert.equal(module.dependencies.some((dependency) => dependency.startsWith('@app-module/')), false)
    }
    const contextModule = lowered.model.sharedModules.find((module) => module.source.sourcePath.endsWith('/helper/apis/index.js'))
    assert.ok(contextModule)
    const context = contextModule.references.find((reference) => reference.kind === 'context')
    assert.deepEqual(context?.contextMembers?.map((member) => member.key), ['./example.js'])
    assert.deepEqual(contextModule.dependencies, context?.contextMembers?.map((member) => member.moduleId))
    assert.equal(Object.isFrozen(lowered.model), true)
    assert.equal(Object.isFrozen(demo.nodes[2]?.host.style), true)
  } finally {
    dispose()
  }
})

test('TK-S04 Case 002 lowers if and keyed for with nearest Block scope', async () => {
  const { result, dispose } = await buildCase('quickapp-code-test2')
  try {
    const lowered = lower(result)
    assert.equal(lowered.status, 'success')
    if (lowered.status !== 'success') return
    const page = lowered.model.pages[0]
    assert.ok(page)
    assert.deepEqual(page.blocks.map((block) => block.kind), ['if', 'for'])
    assert.deepEqual(page.blocks.map((block) => block.templateBlockId), [1, 2])
    assert.deepEqual(page.stateFields.map((field) => field.name), ['count', 'items', 'visible'])
    const listBlock = page.blocks.find((block) => block.kind === 'for')
    assert.ok(listBlock)
    if (listBlock === undefined || listBlock.controller.kind !== 'for') return
    assert.deepEqual(listBlock.controller.keyPath, ['id'])
    assert.equal(listBlock.controller.keyExpression.lexicalBindings.includes('item'), true)
    assert.equal(page.bindings.some((binding) => binding.scope.kind === 'block' && binding.scope.templateBlockId === listBlock.templateBlockId), true)
    assert.equal(page.handlers[0]?.scope.kind, 'page')
    assert.equal(page.nodes.some((node) => node.children.some((child) => child.kind === 'block')), true)
  } finally {
    dispose()
  }
})

test('TK-S13 list-001 lowers explicit List/Scroll and scroll handlers', async () => {
  const { result, dispose } = await buildCase('showcases/list-001')
  try {
    const lowered = lower(result)
    assert.equal(lowered.status, 'success')
    if (lowered.status !== 'success') return
    const page = lowered.model.pages[0]
    assert.ok(page)
    if (page === undefined) return
    assert.deepEqual(page.nodes.map((node) => node.host.type).filter((type) => type === 'List' || type === 'Scroll'), ['Scroll', 'List'])
    assert.deepEqual(page.handlers.map((handler) => handler.eventType), ['scroll', 'scrollend', 'scrolltop', 'scrollbottom', 'click'])
    const listBlock = page.blocks.find((block) => block.kind === 'for')
    assert.ok(listBlock)
    if (listBlock?.controller.kind === 'for') assert.deepEqual(listBlock.controller.keyPath, ['id'])
  } finally {
    dispose()
  }
})

test('TK-S14 media-001 lowers Video props and lifecycle handlers', async () => {
  const { result, dispose } = await buildCase('showcases/media-001')
  try {
    const lowered = lower(result)
    assert.equal(lowered.status, 'success')
    if (lowered.status !== 'success') return
    const page = lowered.model.pages[0]
    assert.ok(page)
    if (page === undefined) return
    const video = page.nodes.find((node) => node.host.type === 'Video')
    assert.deepEqual(video?.host.props, {
      src: 'assets/videos/demo.mp4',
      poster: 'assets/images/media-poster.png',
      autoplay: false,
      controls: true,
      muted: true,
    })
    assert.deepEqual(page.handlers.map((handler) => handler.eventType), ['prepared', 'start', 'pause', 'finish', 'error', 'timeupdate'])
  } finally {
    dispose()
  }
})

test('TK-S15 url-001 lowers internal, external and webview links', async () => {
  const { result, dispose } = await buildCase('showcases/url-001')
  try {
    const lowered = lower(result)
    assert.equal(lowered.status, 'success')
    if (lowered.status !== 'success') return
    const home = lowered.model.pages.find((page) => page.route === '/pages/Home')
    assert.ok(home)
    if (home === undefined) return
    assert.deepEqual(home.nodes.filter((node) => node.host.type === 'Button').map((node) => (node.host.props as { readonly text?: string }).text), [
      '应用内详情',
      '系统浏览器',
      '平台 WebView',
    ])
    assert.deepEqual(home.handlers.map((handler) => handler.eventType), ['click', 'click', 'click'])
    assert.deepEqual(home.handlers.map((handler) => handler.methodName), [
      '__qak_link_1',
      '__qak_link_2',
      '__qak_link_3',
    ])
    assert.deepEqual(home.module.references.filter((reference) => reference.kind === 'capability').map((reference) => reference.targets), [
      ['@app-module/system.router'],
      ['@app-module/system.openUrl'],
      ['@app-module/system.webview'],
    ])
  } finally {
    dispose()
  }
})

test('TK-S16 tabs-001 lowers controlled Tabs and selected binding', async () => {
  const { result, dispose } = await buildCase('showcases/tabs-001')
  try {
    const lowered = lower(result)
    assert.equal(lowered.status, 'success')
    if (lowered.status !== 'success') return
    const page = lowered.model.pages[0]
    assert.ok(page)
    if (page === undefined) return
    const tabs = page.nodes.find((node) => node.host.type === 'Tabs')
    assert.deepEqual(tabs?.host.props, { items: '首页|任务|我的', selected: 0 })
    assert.deepEqual(page.bindings.map((binding) => [binding.target.name, binding.resultType]), [['selected', 'number'], ['text', 'string']])
    assert.deepEqual(page.handlers.map((handler) => handler.eventType), ['change'])
    assert.equal(page.handlers[0]?.methodName, 'onTabChange')
  } finally {
    dispose()
  }
})

test('TK-S17 commerce-001 preserves selectedTab dependencies for all if blocks', async () => {
  const { result, dispose } = await buildCase('showcases/commerce-001')
  try {
    const lowered = lower(result)
    assert.equal(lowered.status, 'success')
    if (lowered.status !== 'success') return
    const home = lowered.model.pages.find((page) => page.route === '/pages/Home')
    assert.ok(home)
    if (home === undefined) return
    const selectedTabBlocks = home.blocks.filter((block) =>
      block.controller.kind === 'if' && block.controller.predicate.stateBindings.includes('selectedTab'))
    assert.equal(selectedTabBlocks.length, 14)
    assert.deepEqual(selectedTabBlocks.map((block) => block.controller.kind), Array(14).fill('if'))
    assert.deepEqual(home.blocks.filter((block) => block.controller.kind === 'if' && block.controller.predicate.stateBindings.includes('loading')).length, 0)
    assert.deepEqual(home.blocks.find((block) => block.kind === 'for')?.controller.kind, 'for')
  } finally {
    dispose()
  }
})

test('TK-S04 single-class styles do not leak to descendants in the golden app', async () => {
  const { result, dispose } = await buildCase('quickapp-code-test5')
  try {
    const lowered = lower(result)
    assert.equal(lowered.status, 'success')
    if (lowered.status !== 'success') return
    const page = lowered.model.pages.find((candidate) => candidate.route === '/pages/Home')
    assert.ok(page)
    if (page === undefined) return

    const root = page.nodes.find((node) => node.templateNodeId === 1)
    const title = page.nodes.find((node) => node.templateNodeId === 2)
    const updateButton = page.nodes.find((node) => node.templateNodeId === 4)
    assert.equal(root?.host.style.width?.value, 300)
    assert.equal(root?.host.style.height?.value, 560)
    assert.equal(title?.host.style.width, undefined)
    assert.equal(title?.host.style.height, undefined)
    assert.equal(title?.host.style.backgroundColor, undefined)
    assert.equal(updateButton?.host.style.width?.value, 220)
    assert.equal(updateButton?.host.style.height?.value, 44)
    assert.equal(updateButton?.host.style.backgroundColor, '#00C800')
    assert.equal(updateButton?.host.style.paddingTop, undefined)
  } finally {
    dispose()
  }
})

test('TK-S04 repeated builds are deterministic and do not retain mutable session state', async () => {
  const first = await buildCase('alliance-hap-case001')
  const second = await buildCase('alliance-hap-case001')
  try {
    const left = lower(first.result)
    const right = lower(second.result)
    assert.equal(left.status, 'success')
    assert.equal(right.status, 'success')
    assert.equal(JSON.stringify(left), JSON.stringify(right))
    for (let index = 0; index < 100; index += 1) {
      const next = lower(first.result)
      assert.equal(JSON.stringify(next), JSON.stringify(left))
    }
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('TK-S04 rejects root Block and missing Handler with source diagnostics', async () => {
  await withWorkspace({
    'src/app.ux': '<script>export default {}</script>',
    'src/pages/Home/index.ux': '<template><div if="{{ visible }}"></div></template><script>export default {}</script>',
  }, async (result, dispose) => {
    try {
      const lowered = lower(result)
      assert.equal(lowered.status, 'failure')
      assert.equal(lowered.diagnostics[0]?.code, 'TK_LOWER_BLOCK_INVALID')
      assert.equal(lowered.diagnostics[0]?.file, 'src/pages/Home/index.ux')
      assert.ok(lowered.diagnostics[0]?.range)
    } finally {
      dispose()
    }
  })
  await withWorkspace({
    'src/app.ux': '<script>export default {}</script>',
    'src/pages/Home/index.ux': '<template><input type="button" value="x" onclick="missing"/></template><script>export default {}</script>',
  }, async (result, dispose) => {
    try {
      const lowered = lower(result)
      assert.equal(lowered.status, 'failure')
      assert.equal(lowered.diagnostics[0]?.code, 'TK_LOWER_HANDLER_INVALID')
    } finally {
      dispose()
    }
  })
})

test('TK-S04 returns no partial model for budget and cancellation failures', async () => {
  const { result, dispose } = await buildCase('quickapp-code-test2')
  try {
    const limited = lower(result, { maxNodes: 1, maxProvenance: 100 })
    assert.equal(limited.status, 'failure')
    assert.equal(limited.diagnostics[0]?.code, 'TK_LOWER_LIMIT_EXCEEDED')
    assert.equal('model' in limited, false)

    const cancelled = new CancellationController()
    cancelled.cancel()
    const before = lower(result, undefined, cancelled.token)
    assert.equal(before.status, 'failure')
    assert.equal(before.diagnostics[0]?.code, 'TK_LOWER_CANCELLED')

    let checks = 0
    const midToken = {
      get cancelled() { return checks > 8 },
      get reason() { return checks > 8 ? 'requested' as const : undefined },
      throwIfCancelled() {
        checks += 1
        if (checks > 8) throw new OperationCancelledError('requested')
      },
    }
    const during = lower(result, undefined, midToken)
    assert.equal(during.status, 'failure')
    assert.equal(during.diagnostics[0]?.code, 'TK_LOWER_CANCELLED')
    assert.equal('model' in during, false)
  } finally {
    dispose()
  }
})

test('TK-S04 rejects mutable S02/S03 input before semantic traversal', async () => {
  const { result, dispose } = await buildCase('alliance-hap-case001')
  try {
    assert.equal(result.status, 'success')
    if (result.status !== 'success') return
    const mutableModel = { ...result.model, manifest: { ...result.model.manifest, raw: { ...result.model.manifest.raw } } }
    const mutableSources = new Map(result.parsedSources)
    const lowered = new CanonicalLowerer().lower({
      resolvedAppModel: mutableModel,
      parsedSourceModel: mutableSources,
      cancellation: new CancellationController().token,
    })
    assert.equal(lowered.status, 'failure')
    assert.equal(lowered.diagnostics[0]?.code, 'TK_LOWER_INPUT_INVALID')
  } finally {
    dispose()
  }
})

function lower(result: GraphBuildResult, limits?: Readonly<Record<string, number>>, cancellation = new CancellationController().token): CanonicalLoweringResult {
  assert.equal(result.status, 'success')
  if (result.status !== 'success') return { status: 'failure', diagnostics: [] }
  const request = {
    resolvedAppModel: result.model,
    parsedSourceModel: result.parsedSources,
    cancellation,
  }
  if (limits === undefined) return new CanonicalLowerer().lower(request)
  return new CanonicalLowerer().lower({ ...request, limits: {
      maxPages: limits.maxPages ?? 1000,
      maxTemplateDepth: limits.maxTemplateDepth ?? 256,
      maxNodes: limits.maxNodes ?? 100000,
      maxBindings: limits.maxBindings ?? 100000,
      maxBlocks: limits.maxBlocks ?? 50000,
      maxHandlers: limits.maxHandlers ?? 100000,
      maxExpressionNodes: limits.maxExpressionNodes ?? 1000000,
      maxStyleRules: limits.maxStyleRules ?? 100000,
      maxStyleDeclarations: limits.maxStyleDeclarations ?? 1000000,
      maxSelectorMatches: limits.maxSelectorMatches ?? 2000000,
      maxLessExpansionSteps: limits.maxLessExpansionSteps ?? 1000000,
      maxWorkQueue: limits.maxWorkQueue ?? 1000000,
      maxProvenance: limits.maxProvenance ?? 1000000,
    } })
}

async function buildCase(caseName: 'alliance-hap-case001' | 'quickapp-code-test2' | 'quickapp-code-test5' | 'showcases/list-001' | 'showcases/media-001' | 'showcases/url-001' | 'showcases/tabs-001' | 'showcases/commerce-001'): Promise<{ result: GraphBuildResult; dispose(): void }> {
  const access = new SourceAccess(caseRoot(caseName), [])
  const manifest = await access.read('src/manifest.json', { content: 'strictUtf8', maxBytes: 2_000_000 })
  const result = await new ModuleGraphBuilder().build({
    manifest,
    sourceRoot: 'src',
    sourceAccess: access,
    frontend: new SourceFrontend(),
    schemaValidator: await publicManifestValidator(),
    cancellation: new CancellationController().token,
  })
  return { result, dispose: () => access.dispose() }
}

async function withWorkspace(files: Readonly<Record<string, string>>, run: (result: GraphBuildResult, dispose: () => void) => Promise<void>): Promise<void> {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'manifest.json'), JSON.stringify(validManifest()) + '\n')
    for (const [logicalPath, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true })
      await writeFile(path.join(root, logicalPath), content)
    }
    const access = new SourceAccess(await realpath(root), [])
    const manifest = await access.read('src/manifest.json', { content: 'strictUtf8', maxBytes: 2_000_000 })
    const result = await new ModuleGraphBuilder().build({
      manifest,
      sourceRoot: 'src',
      sourceAccess: access,
      frontend: new SourceFrontend(),
      schemaValidator: await publicManifestValidator(),
      cancellation: new CancellationController().token,
    })
    await run(result, () => access.dispose())
  })
}
