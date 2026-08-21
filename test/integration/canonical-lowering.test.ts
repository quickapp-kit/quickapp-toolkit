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
  const { result, dispose } = await buildCase('quickapp-code-test1')
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

test('TK-S04 repeated builds are deterministic and do not retain mutable session state', async () => {
  const first = await buildCase('quickapp-code-test1')
  const second = await buildCase('quickapp-code-test1')
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
  const { result, dispose } = await buildCase('quickapp-code-test1')
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

async function buildCase(caseName: 'quickapp-code-test1' | 'quickapp-code-test2'): Promise<{ result: GraphBuildResult; dispose(): void }> {
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
