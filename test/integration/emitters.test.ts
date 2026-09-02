import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { parse } from 'acorn'
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import { CancellationController } from '../../src/application/cancellation.js'
import { JsModuleEmitter, PageIrEmitter } from '../../src/compiler/emitter/index.js'
import type { PageIrSchemaValidator } from '../../src/compiler/emitter/types.js'
import { CanonicalLowerer } from '../../src/compiler/lowering/index.js'
import type { CanonicalLoweringResult } from '../../src/compiler/lowering/types.js'
import { ModuleGraphBuilder } from '../../src/compiler/module-graph/module-graph-builder.js'
import { SourceFrontend } from '../../src/compiler/frontend/source-frontend.js'
import { SourceAccess } from '../../src/workspace/source-access.js'
import { caseRoot, publicManifestValidator } from '../compiler-helpers.js'

test('TK-S05/TK-S06 Case 001 emit one ABI-consistent JS set and valid Page IR', async () => {
  const { model, dispose } = await buildLowered('alliance-hap-case001')
  try {
    const js = new JsModuleEmitter().emit({ model, cancellation: new CancellationController().token })
    assert.equal(js.status, 'success')
    if (js.status !== 'success') return
    assert.equal(js.bundles.length, 7)
    const packageIds = new Set(js.bundles.map((bundle) => bundle.moduleId))
    for (const bundle of js.bundles) {
      parse(bundle.content, { ecmaVersion: 'latest', sourceType: 'script' })
      assert.equal(bundle.content.endsWith('\n'), true)
      assert.equal(bundle.sourceMap.path, `${bundle.path}.map`)
      assert.deepEqual(readDefineDependencies(bundle.content), bundle.dependencies)
      assert.equal(bundle.dependencies.includes(bundle.moduleId), false)
      assert.equal(bundle.dependencies.every((dependency) => packageIds.has(dependency)), true)
      assert.equal(bundle.dependencies.some((dependency) => dependency.startsWith('@app-module/')), false)
      assert.doesNotMatch(bundle.content, /\$app_require\$\.context/)
      if (bundle.moduleKind === 'shared') {
        assert.equal((bundle.content.match(/\$app_bootstrap\$/g) ?? []).length, 0)
      } else {
        assert.equal((bundle.content.match(/\$app_bootstrap\$/g) ?? []).length, 1)
        assert.match(bundle.content, /module\.exports\s*=\s*\{/)
      }
    }
    const demoBundle = js.bundles.find((bundle) => bundle.moduleId === '@quickapp-kit/page/pages/Demo')
    assert.ok(demoBundle)
    const registry = new Map<string, unknown>()
    const bootstraps: unknown[] = []
    runInNewContext(demoBundle.content, {
      $app_define$(moduleId: string, _dependencies: readonly string[], factory: (require: (target: string) => unknown, module: { exports: unknown }, exports: unknown) => void) {
        const module = { exports: {} as unknown }
        factory((target) => registry.get(target) ?? { default: { push() {} } }, module, module.exports)
        registry.set(moduleId, module.exports)
      },
      $app_bootstrap$(_moduleId: string, bootstrap: unknown) { bootstraps.push(bootstrap) },
    })
    const definition = registry.get('@quickapp-kit/page/pages/Demo') as Record<string, unknown>
    assert.deepEqual(Object.keys(definition).sort(), ['bindingEvaluators', 'createPageVm', 'handlerMethods', 'kind', 'schemaVersion'])
    assert.equal(typeof definition.createPageVm, 'function')
    const pageVm = (definition.createPageVm as (context: unknown) => Record<string, unknown>)({})
    assert.equal(pageVm.title, '欢迎体验 quickapp 开发')
    assert.equal(Object.prototype.hasOwnProperty.call(pageVm, 'private'), false)
    const evaluators = definition.bindingEvaluators as Record<string, (this: Record<string, unknown>, scope: unknown) => unknown>
    assert.equal(evaluators['1']?.call(pageVm, {}), '欢迎体验 quickapp 开发')
    assert.match(demoBundle.content, /String\(this\.title\)/)
    assert.match(demoBundle.content, /\$app_require\$\("@app-module\/system\.router"\)/)
    assert.equal(bootstraps.length, 1)
    const contextBundle = js.bundles.find((bundle) => JSON.parse(bundle.sourceMap.content).sources[0].endsWith('/helper/apis/index.js'))
    assert.ok(contextBundle)
    assert.match(contextBundle.content, /"\.\/example\.js"/)
    assert.match(contextBundle.content, /return \$app_require\$\("@quickapp-kit\/shared\//)
    assert.equal(contextBundle.dependencies.includes(contextBundle.moduleId), false)
    assert.equal(js.bundles.some((bundle) => bundle.content.includes('@system.')), false)
    const ir = new PageIrEmitter().emit({ model, schemaValidator: await pageIrValidator(), cancellation: new CancellationController().token })
    assert.equal(ir.status, 'success')
    if (ir.status !== 'success') return
    assert.equal(ir.pages.length, 2)
    for (const page of ir.pages) {
      assert.equal(JSON.parse(page.content).templateId, page.templateId)
      const firstNode = (page.value.nodes as readonly unknown[])[0]
      assert.equal(Object.prototype.hasOwnProperty.call(firstNode as object, 'source'), false)
    }
  } finally {
    dispose()
  }
})

test('TK-S05/TK-S06 Case 002 preserve Block IDs and produce deterministic output', async () => {
  const { model, dispose } = await buildLowered('quickapp-code-test2')
  try {
    const first = new JsModuleEmitter().emit({ model, cancellation: new CancellationController().token })
    const second = new JsModuleEmitter().emit({ model, cancellation: new CancellationController().token })
    assert.equal(first.status, 'success')
    assert.equal(second.status, 'success')
    if (first.status !== 'success' || second.status !== 'success') return
    assert.deepEqual(first.bundles.map((bundle) => [bundle.path, bundle.content, bundle.sourceMap.content]), second.bundles.map((bundle) => [bundle.path, bundle.content, bundle.sourceMap.content]))
    const ir = new PageIrEmitter().emit({ model, schemaValidator: await pageIrValidator(), cancellation: new CancellationController().token })
    assert.equal(ir.status, 'success')
    if (ir.status !== 'success') return
    assert.deepEqual(JSON.parse(ir.pages[0]?.content ?? '').blocks.map((block: { templateBlockId: number }) => block.templateBlockId), [1, 2])
  } finally {
    dispose()
  }
})

test('TK-S05/TK-S06 never publish partial output on cancellation or invalid public schema', async () => {
  const { model, dispose } = await buildLowered('alliance-hap-case001')
  try {
    const cancelled = new CancellationController()
    cancelled.cancel()
    const js = new JsModuleEmitter().emit({ model, cancellation: cancelled.token })
    assert.equal(js.status, 'failure')
    assert.equal('bundles' in js, false)
    const ir = new PageIrEmitter().emit({ model, schemaValidator: { validate: () => ['forced failure'] }, cancellation: new CancellationController().token })
    assert.equal(ir.status, 'failure')
    assert.equal('pages' in ir, false)

    const limitedJs = new JsModuleEmitter().emit({ model, cancellation: new CancellationController().token, limits: { maxGeneratedBytes: 1 } })
    assert.equal(limitedJs.status, 'failure')
    assert.equal(limitedJs.diagnostics[0]?.code, 'TK_EMIT_LIMIT_EXCEEDED')
    const limitedIr = new PageIrEmitter().emit({ model, schemaValidator: await pageIrValidator(), cancellation: new CancellationController().token, limits: { maxGeneratedNodes: 1 } })
    assert.equal(limitedIr.status, 'failure')
    assert.equal(limitedIr.diagnostics[0]?.code, 'TK_EMIT_IR_LIMIT_EXCEEDED')
  } finally {
    dispose()
  }
})

async function buildLowered(caseName: 'alliance-hap-case001' | 'quickapp-code-test2'): Promise<{ model: NonNullable<Extract<CanonicalLoweringResult, { status: 'success' }>['model']>; dispose(): void }> {
  const access = new SourceAccess(caseRoot(caseName), [])
  const manifest = await access.read('src/manifest.json', { content: 'strictUtf8', maxBytes: 2_000_000 })
  const graph = await new ModuleGraphBuilder().build({
    manifest,
    sourceRoot: 'src',
    sourceAccess: access,
    frontend: new SourceFrontend(),
    schemaValidator: await publicManifestValidator(),
    cancellation: new CancellationController().token,
  })
  assert.equal(graph.status, 'success')
  if (graph.status !== 'success') throw new Error('Case graph failed')
  const lowered = new CanonicalLowerer().lower({ resolvedAppModel: graph.model, parsedSourceModel: graph.parsedSources, cancellation: new CancellationController().token })
  assert.equal(lowered.status, 'success')
  if (lowered.status !== 'success') throw new Error('Case Lowering failed')
  return { model: lowered.model, dispose: () => access.dispose() }
}

async function pageIrValidator(): Promise<PageIrSchemaValidator> {
  const schemaRoot = path.resolve(process.cwd(), '..', '..', 'BBQ/docs/interview/BT/proj/quickapp-kit/v3/spec/contracts/schemas')
  const pageSchema = JSON.parse(await readFile(path.join(schemaRoot, 'page-ir.schema.json'), 'utf8')) as object
  const hostSchema = JSON.parse(await readFile(path.join(schemaRoot, 'host-component.schema.json'), 'utf8')) as object
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  ajv.addSchema(hostSchema)
  const validate = ajv.compile(pageSchema)
  return {
    validate(value: unknown): readonly string[] {
      if (validate(value)) return []
      return (validate.errors ?? []).map((error: ErrorObject) => `${error.instancePath} ${error.message ?? 'invalid'}`)
    },
  }
}

function readDefineDependencies(content: string): readonly string[] {
  let dependencies: readonly string[] | undefined
  runInNewContext(content, {
    $app_define$(_moduleId: string, values: readonly string[], _factory: unknown) { dependencies = [...values] },
    $app_bootstrap$() {},
  })
  assert.ok(dependencies)
  return dependencies
}
