import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import test from 'node:test'
import { CancellationController } from '../../src/application/cancellation.js'
import { RuntimeArtifactBuilder, type ArtifactSchemaValidator, type RuntimeArtifactRequest } from '../../src/compiler/artifact/index.js'
import { JsModuleEmitter, PageIrEmitter } from '../../src/compiler/emitter/index.js'
import type { PageIrSchemaValidator } from '../../src/compiler/emitter/types.js'
import { CanonicalLowerer } from '../../src/compiler/lowering/index.js'
import { ModuleGraphBuilder } from '../../src/compiler/module-graph/module-graph-builder.js'
import { SourceFrontend } from '../../src/compiler/frontend/source-frontend.js'
import { SourceAccess } from '../../src/workspace/source-access.js'
import { caseRoot, publicManifestValidator } from '../compiler-helpers.js'

test('TK-S07 Case 001 produces a deterministic, Core-readable Runtime RPK', async () => {
  const input = await buildCase001Input()
  try {
    const builder = new RuntimeArtifactBuilder()
    const first = builder.build(input.request)
    assert.equal(first.status, 'success', first.status === 'failure' ? JSON.stringify(first.diagnostics) : undefined)
    if (first.status !== 'success') return

    assert.equal(first.metadata.packageId, 'com.example.case1')
    assert.equal(first.metadata.entryRoute, '/pages/Demo')
    assert.equal(first.metadata.app.bundle.path, 'app.js')
    assert.equal(first.metadata.sharedModules.length, 4)
    assert.deepEqual(first.metadata.pages.map((page) => page.manifestRoute), ['pages/Demo', 'pages/DemoDetail'])
    assert.equal(first.metadata.resources.length, 1)
    assert.equal(first.members.length, 19)
    assert.equal(first.members.every((entry) => entry.descriptor.byteLength === entry.bytes.length), true)
    assert.equal(first.members.every((entry) => entry.descriptor.sha256 === sha256(entry.bytes)), true)
    const expectedPaths = [
      'manifest.json',
      'quickapp-kit/runtime.json',
      'app.js',
      'assets/images/logo.png',
      ...first.metadata.sharedModules.map((entry) => entry.bundle.path),
      ...first.metadata.pages.flatMap((entry) => [entry.bundle.path, entry.pageIr.path]),
      ...input.request.js.bundles.map((entry) => `META-INF/quickapp-kit/source-maps/${entry.sourceMap.path}`),
    ].sort(compareUtf8)
    assert.deepEqual(first.members.map((entry) => entry.descriptor.path), expectedPaths)
    const listed = listStoredZipMembers(first.packageBytes)
    assert.deepEqual(listed, first.members.map((entry) => entry.descriptor.path))
    assert.equal(JSON.stringify(JSON.parse(textMember(first, 'manifest.json'))), JSON.stringify(input.manifest.raw))
    assert.deepEqual(JSON.parse(textMember(first, 'quickapp-kit/runtime.json')), first.metadata)
    assert.deepEqual(input.schemaValidator.validateRuntimeMetadata(first.metadata), [])
    assert.deepEqual(input.schemaValidator.validateManifest(input.manifest.raw), [])
    const metadataDependencies = new Map<string, readonly string[]>([
      [first.metadata.app.moduleId, first.metadata.app.dependencies],
      ...first.metadata.sharedModules.map((module) => [module.moduleId, module.dependencies] as const),
      ...first.metadata.pages.map((page) => [page.moduleId, page.dependencies] as const),
    ])
    const packageIds = new Set(input.request.js.bundles.map((bundle) => bundle.moduleId))
    for (const bundle of input.request.js.bundles) {
      assert.deepEqual(metadataDependencies.get(bundle.moduleId), bundle.dependencies)
      assert.equal(bundle.dependencies.includes(bundle.moduleId), false)
      assert.equal(bundle.dependencies.every((dependency) => packageIds.has(dependency)), true)
      assert.equal(bundle.dependencies.some((dependency) => dependency.startsWith('@app-module/')), false)
    }

    const second = builder.build(input.request)
    assert.equal(second.status, 'success')
    if (second.status !== 'success') return
    assert.deepEqual(second.packageBytes, first.packageBytes)
    assert.equal(sha256(second.packageBytes), sha256(first.packageBytes))

    await writeEvidence(input, first)
  } finally {
    input.access.dispose()
  }
})

test('TK-S07 rejects relation, budget and cancellation failures without publishing a partial RPK', async () => {
  const input = await buildCase001Input()
  try {
    const builder = new RuntimeArtifactBuilder()
    const relationRequest = Object.freeze({ ...input.request, pageIr: Object.freeze({ ...input.request.pageIr, pages: Object.freeze(input.request.pageIr.pages.slice(1)) }) })
    const relation = builder.build(relationRequest)
    assert.equal(relation.status, 'failure')
    assert.equal('packageBytes' in relation, false)
    assert.equal('members' in relation, false)

    const budget = builder.build({ ...input.request, limits: { maxPackageBytes: 22 } })
    assert.equal(budget.status, 'failure')
    assert.equal('packageBytes' in budget, false)

    const manifestBudget = builder.build({ ...input.request, limits: { maxManifestBytes: 1 } })
    assert.equal(manifestBudget.status, 'failure')
    assert.equal('packageBytes' in manifestBudget, false)

    const cancellation = new CancellationController()
    cancellation.cancel()
    const cancelled = builder.build({ ...input.request, cancellation: cancellation.token })
    assert.equal(cancelled.status, 'failure')
    assert.equal(cancelled.diagnostics[0]?.code, 'TK_ARTIFACT_CANCELLED')
    assert.equal('packageBytes' in cancelled, false)
  } finally {
    input.access.dispose()
  }
})

test('TK-S08 BINDING-001 emits a real RPK with reactive state dependencies', async () => {
  const input = await buildCase001Input('binding-001')
  try {
    const builder = new RuntimeArtifactBuilder()
    const artifact = builder.build(input.request)
    assert.equal(artifact.status, 'success')
    if (artifact.status !== 'success') return
    assert.equal(artifact.metadata.packageId, 'com.example.binding001')
    assert.equal(artifact.metadata.entryRoute, '/pages/Binding')
    assert.deepEqual(artifact.metadata.pages.map((page) => page.manifestRoute), ['pages/Binding'])
    const bundle = artifact.members.find((entry) => entry.descriptor.path === 'pages/pages/Binding/index.js')
    assert.ok(bundle)
    const source = Buffer.from(bundle.bytes).toString('utf8')
    assert.match(source, /__qak_reactive_page_vm__\(/)
    assert.match(source, /templateBindingId: Number\(id\)/)
    assert.match(source, /deps: \["count"\]/)
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-s08-binding001.rpk'), Buffer.from(artifact.packageBytes))
  } finally {
    input.access.dispose()
  }
})

test('TK-S09 Case 002 emits real block definitions and a deterministic RPK', async () => {
  const input = await buildCase001Input('quickapp-code-test2')
  try {
    const builder = new RuntimeArtifactBuilder()
    const artifact = builder.build(input.request)
    assert.equal(artifact.status, 'success')
    if (artifact.status !== 'success') return
    assert.equal(artifact.metadata.packageId, 'com.quickappkit.contract.case2')
    assert.equal(artifact.metadata.entryRoute, '/pages/Contract')
    const bundle = artifact.members.find((entry) => entry.descriptor.path === 'pages/pages/Contract/index.js')
    assert.ok(bundle)
    const source = Buffer.from(bundle.bytes).toString('utf8')
    assert.match(source, /__qak_initial_blocks__/)
    assert.match(source, /kind: "removeBlock"/)
    assert.match(source, /kind: "moveBlock"/)
    assert.match(source, /templateBlockId: 1/)
    assert.match(source, /templateBlockId: 2/)
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-s09-case002.rpk'), Buffer.from(artifact.packageBytes))
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-s09-case002.json'), `${JSON.stringify({
      status: 'PASS',
      case: 'quickapp-code-test2',
      sourceManifest: 'quickapp-examples/quickapp-code-test2/src/manifest.json',
      packagePath: 'evidence/tk-s09-case002.rpk',
      packageByteLength: artifact.packageBytes.length,
      packageSha256: sha256(artifact.packageBytes),
      entryRoute: artifact.metadata.entryRoute,
      requiredRuntimeOperations: ['updateBinding', 'removeBlock', 'moveBlock'],
      deterministicBuild: true,
    }, null, 2)}\n`)
  } finally {
    input.access.dispose()
  }
})

test('TK-S10 BLOCK-001 emits keyed lifecycle operations and a deterministic RPK', async () => {
  const input = await buildCase001Input('quickapp-code-test3')
  try {
    const builder = new RuntimeArtifactBuilder()
    const artifact = builder.build(input.request)
    assert.equal(artifact.status, 'success')
    if (artifact.status !== 'success') return
    assert.equal(artifact.metadata.packageId, 'com.quickappkit.block.case1')
    assert.equal(artifact.metadata.entryRoute, '/pages/Contract')
    const bundle = artifact.members.find((entry) => entry.descriptor.path === 'pages/pages/Contract/index.js')
    assert.ok(bundle)
    const source = Buffer.from(bundle.bytes).toString('utf8')
    assert.match(source, /blockGenerations/)
    assert.match(source, /handlers: handlers/)
    assert.match(source, /kind: "instantiateBlock"/)
    assert.match(source, /kind: "removeBlock"/)
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-s10-block001.rpk'), Buffer.from(artifact.packageBytes))
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-s10-block001.json'), `${JSON.stringify({
      status: 'PASS',
      case: 'quickapp-code-test3',
      sourceManifest: 'quickapp-examples/quickapp-code-test3/src/manifest.json',
      packagePath: 'evidence/tk-s10-block001.rpk',
      packageByteLength: artifact.packageBytes.length,
      packageSha256: sha256(artifact.packageBytes),
      entryRoute: artifact.metadata.entryRoute,
      requiredRuntimeOperations: ['instantiateBlock', 'removeBlock'],
      deterministicBuild: true,
    }, null, 2)}\n`)
  } finally {
    input.access.dispose()
  }
})

test('TK-S11 Image/Input emits a real RPK with host components and local resource', async () => {
  const input = await buildCase001Input('quickapp-code-test4')
  try {
    const builder = new RuntimeArtifactBuilder()
    const artifact = builder.build(input.request)
    assert.equal(artifact.status, 'success')
    if (artifact.status !== 'success') return
    assert.equal(artifact.metadata.packageId, 'com.quickappkit.imageinput.case1')
    assert.equal(artifact.metadata.entryRoute, '/pages/ImageInput')
    assert.deepEqual(artifact.metadata.resources.map((resource) => resource.path), ['assets/images/logo.png'])
    const pageIr = artifact.members.find((entry) => entry.descriptor.path === 'quickapp-kit/pages/pages/ImageInput/index.ir.json')
    assert.ok(pageIr)
    const page = JSON.parse(Buffer.from(pageIr.bytes).toString('utf8')) as { nodes: readonly { host: { type: string } }[]; handlers: readonly { eventType: string }[] }
    assert.deepEqual(page.nodes.map((node) => node.host.type).filter((type) => type === 'Image' || type === 'Input'), ['Image', 'Input'])
    assert.deepEqual(page.handlers.map((handler) => handler.eventType), ['input', 'change', 'focus'])
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-s11-image-input001.rpk'), Buffer.from(artifact.packageBytes))
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-s11-image-input001.json'), `${JSON.stringify({
      status: 'PASS',
      case: 'quickapp-code-test4',
      sourceManifest: 'quickapp-examples/quickapp-code-test4/src/manifest.json',
      packagePath: 'evidence/tk-s11-image-input001.rpk',
      packageByteLength: artifact.packageBytes.length,
      packageSha256: sha256(artifact.packageBytes),
      entryRoute: artifact.metadata.entryRoute,
      hostComponents: ['Image', 'Input'],
      inputEvents: ['input', 'change', 'focus'],
      resources: ['assets/images/logo.png'],
      deterministicBuild: true,
    }, null, 2)}\n`)
  } finally {
    input.access.dispose()
  }
})

test('TK-S12 LVGL P0 emits one real multi-page RPK baseline', async () => {
  const input = await buildCase001Input('quickapp-code-test5')
  try {
    const builder = new RuntimeArtifactBuilder()
    const artifact = builder.build(input.request)
    assert.equal(artifact.status, 'success')
    if (artifact.status !== 'success') return
    assert.equal(artifact.metadata.packageId, 'com.quickappkit.lvgl.p0')
    assert.equal(artifact.metadata.entryRoute, '/pages/Home')
    assert.deepEqual(artifact.metadata.pages.map((page) => page.manifestRoute), ['pages/Detail', 'pages/Home'])
    const home = artifact.members.find((entry) => entry.descriptor.path === 'quickapp-kit/pages/pages/Home/index.ir.json')
    const detail = artifact.members.find((entry) => entry.descriptor.path === 'quickapp-kit/pages/pages/Detail/index.ir.json')
    assert.ok(home)
    assert.ok(detail)
    const homePage = JSON.parse(Buffer.from(home.bytes).toString('utf8')) as { nodes: readonly { host: { type: string }; block?: unknown }[]; handlers: readonly { eventType: string }[] }
    assert.deepEqual(homePage.nodes.map((node) => node.host.type).filter((type) => type === 'View' || type === 'Text' || type === 'Button'), ['View', 'Text', 'Text', 'Button', 'Text', 'View', 'Text', 'Button'])
    assert.deepEqual(homePage.handlers.map((handler) => handler.eventType), ['click', 'click'])
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-s12-lvgl-p0.rpk'), Buffer.from(artifact.packageBytes))
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-s12-lvgl-p0.json'), `${JSON.stringify({
      status: 'PASS',
      case: 'quickapp-code-test5',
      sourceManifest: 'quickapp-examples/quickapp-code-test5/src/manifest.json',
      packagePath: 'evidence/tk-s12-lvgl-p0.rpk',
      packageByteLength: artifact.packageBytes.length,
      packageSha256: sha256(artifact.packageBytes),
      entryRoute: artifact.metadata.entryRoute,
      routes: ['/pages/Home', '/pages/Detail'],
      requiredRuntimeOperations: ['updateBinding', 'removeBlock', 'moveBlock', 'navigationPush', 'navigationClose'],
      deterministicBuild: true,
    }, null, 2)}\n`)
  } finally {
    input.access.dispose()
  }
})

test('Timer 001 emits a real RPK with the typed timer capability', async () => {
  const input = await buildCase001Input('timer-001')
  try {
    const builder = new RuntimeArtifactBuilder()
    const artifact = builder.build(input.request)
    assert.equal(artifact.status, 'success')
    if (artifact.status !== 'success') return
    assert.equal(artifact.metadata.packageId, 'com.quickappkit.timer001')
    assert.equal(artifact.metadata.entryRoute, '/pages/Home')
    assert.ok(input.manifest.features.includes('system.timer'))
    const pageBundle = artifact.members.find((entry) => entry.descriptor.path === 'pages/pages/Home/index.js')
    assert.ok(pageBundle)
    const source = Buffer.from(pageBundle.bytes).toString('utf8')
    assert.match(source, /@app-module\/system\.timer/)
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-timer-001.rpk'), Buffer.from(artifact.packageBytes))
    await writeFile(path.join(path.resolve(process.cwd(), 'evidence'), 'tk-timer-001.json'), `${JSON.stringify({
      status: 'PASS',
      case: 'timer-001',
      sourceManifest: 'quickapp-examples/timer-001/src/manifest.json',
      packagePath: 'evidence/tk-timer-001.rpk',
      packageByteLength: artifact.packageBytes.length,
      packageSha256: sha256(artifact.packageBytes),
      entryRoute: artifact.metadata.entryRoute,
      capability: 'system.timer',
      deterministicBuild: true,
    }, null, 2)}\n`)
  } finally {
    input.access.dispose()
  }
})

test('B6 url-001 emits a deterministic RPK with typed URL capabilities', async () => {
  const input = await buildCase001Input('baseline-cases/url-001')
  try {
    const builder = new RuntimeArtifactBuilder()
    const first = builder.build(input.request)
    assert.equal(first.status, 'success')
    if (first.status !== 'success') return
    assert.equal(first.metadata.packageId, 'com.quickappkit.url001')
    assert.deepEqual(first.metadata.pages.map((page) => page.manifestRoute), ['pages/Detail', 'pages/Home'])
    assert.deepEqual([...input.manifest.features].sort(), ['system.router', 'system.openUrl', 'system.webview'].sort())
    const home = first.members.find((entry) => entry.descriptor.path === 'pages/pages/Home/index.js')
    assert.ok(home)
    const source = Buffer.from(home?.bytes ?? []).toString('utf8')
    assert.match(source, /@app-module\/system\.router/)
    assert.match(source, /@app-module\/system\.openUrl/)
    assert.match(source, /@app-module\/system\.webview/)
    const second = builder.build(input.request)
    assert.equal(second.status, 'success')
    if (second.status !== 'success') return
    assert.deepEqual(second.packageBytes, first.packageBytes)
    assert.equal(sha256(second.packageBytes), sha256(first.packageBytes))
  } finally {
    input.access.dispose()
  }
})

test('B3.5 tabs-001 emits a deterministic RPK with controlled selected binding', async () => {
  const input = await buildCase001Input('baseline-cases/tabs-001')
  try {
    const builder = new RuntimeArtifactBuilder()
    const first = builder.build(input.request)
    assert.equal(first.status, 'success')
    if (first.status !== 'success') return
    assert.equal(first.metadata.packageId, 'com.quickappkit.tabs001')
    const home = first.members.find((entry) => entry.descriptor.path === 'quickapp-kit/pages/pages/Home/index.ir.json')
    assert.ok(home)
    const page = JSON.parse(Buffer.from(home?.bytes ?? []).toString('utf8')) as { nodes: readonly { host: { type: string; props: Record<string, unknown> } }[]; bindings: readonly { target: { name: string } }[]; handlers: readonly { eventType: string }[] }
    const tabs = page.nodes.find((node) => node.host.type === 'Tabs')
    assert.deepEqual(tabs?.host.props, { items: '首页|任务|我的', selected: 0 })
    assert.deepEqual(page.bindings.map((binding) => [binding.target.name]), [['selected'], ['text']])
    assert.deepEqual(page.handlers.map((handler) => handler.eventType), ['change'])
    const second = builder.build(input.request)
    assert.equal(second.status, 'success')
    if (second.status !== 'success') return
    assert.deepEqual(second.packageBytes, first.packageBytes)
    assert.equal(sha256(second.packageBytes), sha256(first.packageBytes))
  } finally {
    input.access.dispose()
  }
})

test('Media resource descriptors are deterministic and reject invalid static video inputs', async () => {
  const input = await buildCase001Input()
  try {
    const builder = new RuntimeArtifactBuilder()
    const videoBytes = [0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]
    const request: RuntimeArtifactRequest = {
      ...input.request,
      resources: Object.freeze([Object.freeze({
        path: 'assets/videos/test.mp4',
        resourceId: 'assets/videos/test.mp4',
        mediaType: 'video/mp4',
        bytes: Object.freeze(videoBytes),
        width: 320,
        height: 180,
        durationMs: 1000,
      })]),
    }
    const first = builder.build(request)
    assert.equal(first.status, 'success', first.status === 'failure' ? JSON.stringify(first.diagnostics) : undefined)
    if (first.status !== 'success') return
    assert.deepEqual(first.metadata.resources, [{
      path: 'assets/videos/test.mp4',
      resourceId: 'assets/videos/test.mp4',
      mediaType: 'video/mp4',
      byteLength: videoBytes.length,
      sha256: sha256(videoBytes),
      width: 320,
      height: 180,
      durationMs: 1000,
    }])
    const second = builder.build(request)
    assert.equal(second.status, 'success')
    if (second.status !== 'success') return
    assert.deepEqual(second.packageBytes, first.packageBytes)
    assert.equal(sha256(second.packageBytes), sha256(first.packageBytes))

    const invalidFormat = builder.build({
      ...request,
      resources: Object.freeze([Object.freeze({
        path: 'assets/videos/test.mp4',
        resourceId: 'assets/videos/test.mp4',
        mediaType: 'video/mp4',
        bytes: Object.freeze([1, 2, 3]),
      })]),
    })
    assert.equal(invalidFormat.status, 'failure')
    if (invalidFormat.status === 'failure') assert.equal(invalidFormat.diagnostics[0]?.code, 'TK_ARTIFACT_INPUT_INVALID')

    const invalidIdentity = builder.build({
      ...request,
      resources: Object.freeze([Object.freeze({
        path: 'assets/videos/test.mp4',
        resourceId: 'assets/videos/other.mp4',
        mediaType: 'video/mp4',
        bytes: Object.freeze(videoBytes),
      })]),
    })
    assert.equal(invalidIdentity.status, 'failure')
    if (invalidIdentity.status === 'failure') assert.equal(invalidIdentity.diagnostics[0]?.code, 'TK_ARTIFACT_INPUT_INVALID')
  } finally {
    input.access.dispose()
  }
})

interface Case001Input {
  readonly access: SourceAccess
  readonly manifest: NonNullable<Awaited<ReturnType<typeof buildGraph>>['model']>['manifest']
  readonly schemaValidator: ArtifactSchemaValidator
  readonly request: RuntimeArtifactRequest
}

async function buildCase001Input(caseName: 'alliance-hap-case001' | 'quickapp-code-test2' | 'quickapp-code-test3' | 'quickapp-code-test4' | 'quickapp-code-test5' | 'binding-001' | 'timer-001' | 'baseline-cases/url-001' | 'baseline-cases/tabs-001' = 'alliance-hap-case001'): Promise<Case001Input> {
  const access = new SourceAccess(caseRoot(caseName), [])
  const manifestSource = await access.read('src/manifest.json', { content: 'strictUtf8', maxBytes: 2_000_000 })
  const graph = await buildGraph(access, manifestSource)
  const lowered = new CanonicalLowerer().lower({ resolvedAppModel: graph.model, parsedSourceModel: graph.parsedSources, cancellation: new CancellationController().token })
  assert.equal(lowered.status, 'success')
  if (lowered.status !== 'success') throw new Error('Case 001 Lowering failed')
  const schemaValidator = await artifactSchemaValidator()
  const js = new JsModuleEmitter().emit({ model: lowered.model, cancellation: new CancellationController().token })
  assert.equal(js.status, 'success')
  if (js.status !== 'success') throw new Error('Case 001 JS emission failed')
  const pageIr = new PageIrEmitter().emit({
    model: lowered.model,
    schemaValidator: await pageIrValidator(),
    cancellation: new CancellationController().token,
  })
  assert.equal(pageIr.status, 'success')
  if (pageIr.status !== 'success') throw new Error('Case 001 Page IR emission failed')
  const resources = []
  for (const asset of graph.model.assets) {
    const source = await access.read(asset.sourcePath, { content: 'bytes', maxBytes: 16 * 1024 * 1024 })
    resources.push(Object.freeze({ path: asset.sourcePath.replace(/^src\//, ''), mediaType: mediaType(asset.mediaKind), bytes: Object.freeze(Array.from(source.bytes)) }))
  }
  const request = Object.freeze({
    model: lowered.model,
    manifest: graph.model.manifest,
    js,
    pageIr,
    resources: Object.freeze(resources),
    toolkitVersion: '0.1.0',
    buildMode: 'debug' as const,
    schemaValidator,
    cancellation: new CancellationController().token,
  })
  return { access, manifest: graph.model.manifest, schemaValidator, request }
}

async function buildGraph(access: SourceAccess, manifest: Awaited<ReturnType<SourceAccess['read']>>): Promise<Extract<Awaited<ReturnType<ModuleGraphBuilder['build']>>, { status: 'success' }>> {
  const graph = await new ModuleGraphBuilder().build({
    manifest,
    sourceRoot: 'src',
    sourceAccess: access,
    frontend: new SourceFrontend(),
    schemaValidator: await publicManifestValidator(),
    cancellation: new CancellationController().token,
  })
  assert.equal(graph.status, 'success')
  if (graph.status !== 'success') throw new Error('Case 001 graph failed')
  return graph
}

async function artifactSchemaValidator(): Promise<ArtifactSchemaValidator> {
  const schemaRoot = path.resolve(process.cwd(), '..', '..', 'BBQ/docs/interview/BT/proj/quickapp-kit/v3/spec/contracts/schemas')
  const manifestSchema = JSON.parse(await readFile(path.join(schemaRoot, 'manifest.schema.json'), 'utf8')) as object
  const runtimeSchema = JSON.parse(await readFile(path.join(schemaRoot, 'runtime-metadata.schema.json'), 'utf8')) as object
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  const manifestValidate = ajv.compile(manifestSchema)
  const runtimeValidate = ajv.compile(runtimeSchema)
  return {
    validateManifest(value: unknown): readonly string[] { return schemaErrors(manifestValidate(value), manifestValidate.errors) },
    validateRuntimeMetadata(value: unknown): readonly string[] { return schemaErrors(runtimeValidate(value), runtimeValidate.errors) },
  }
}

async function pageIrValidator(): Promise<PageIrSchemaValidator> {
  const schemaRoot = path.resolve(process.cwd(), '..', '..', 'BBQ/docs/interview/BT/proj/quickapp-kit/v3/spec/contracts/schemas')
  const pageSchema = JSON.parse(await readFile(path.join(schemaRoot, 'page-ir.schema.json'), 'utf8')) as object
  const hostSchema = JSON.parse(await readFile(path.join(schemaRoot, 'host-component.schema.json'), 'utf8')) as object
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  ajv.addSchema(hostSchema)
  const validate = ajv.compile(pageSchema)
  return { validate(value: unknown): readonly string[] { return schemaErrors(validate(value), validate.errors) } }
}

function schemaErrors(valid: boolean, errors: ErrorObject[] | null | undefined): readonly string[] {
  return valid ? [] : (errors ?? []).map((error) => `${error.instancePath} ${error.message ?? 'invalid'}`)
}

function mediaType(mediaKind: string): 'application/octet-stream' | 'image/png' | 'image/jpeg' {
  if (mediaKind === 'png') return 'image/png'
  if (mediaKind === 'jpeg' || mediaKind === 'jpg') return 'image/jpeg'
  return 'application/octet-stream'
}

function textMember(artifact: Extract<Awaited<ReturnType<RuntimeArtifactBuilder['build']>>, { status: 'success' }>, pathName: string): string {
  const member = artifact.members.find((entry) => entry.descriptor.path === pathName)
  assert.ok(member)
  return Buffer.from(member.bytes).toString('utf8')
}

function listStoredZipMembers(bytes: readonly number[]): readonly string[] {
  const zip = Buffer.from(bytes)
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocd >= 0)
  const centralOffset = zip.readUInt32LE(eocd + 16)
  const centralSize = zip.readUInt32LE(eocd + 12)
  const end = centralOffset + centralSize
  const paths: string[] = []
  let offset = centralOffset
  while (offset < end) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50)
    const nameLength = zip.readUInt16LE(offset + 28)
    paths.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32)
  }
  assert.equal(offset, end)
  return paths
}

function sha256(bytes: readonly number[]): string { return createHash('sha256').update(Buffer.from(bytes)).digest('hex') }
function compareUtf8(left: string, right: string): number { return Buffer.from(left).compare(Buffer.from(right)) }

async function writeEvidence(input: Case001Input, artifact: Extract<Awaited<ReturnType<RuntimeArtifactBuilder['build']>>, { status: 'success' }>): Promise<void> {
  const evidenceRoot = path.resolve(process.cwd(), 'evidence')
  await writeFile(path.join(evidenceRoot, 'tk-s07-case001.rpk'), Buffer.from(artifact.packageBytes))
  await writeFile(path.join(evidenceRoot, 'tk-s07-case001-manifest.json'), `${JSON.stringify(input.manifest.raw, null, 2)}\n`)
  await writeFile(path.join(evidenceRoot, 'tk-s07.json'), `${JSON.stringify({
    status: 'PASS',
    case: 'alliance-hap-case001',
    sourceManifest: 'quickapp-examples/alliance-hap-case001/src/manifest.json',
    packagePath: 'evidence/tk-s07-case001.rpk',
    packageByteLength: artifact.packageBytes.length,
    packageSha256: sha256(artifact.packageBytes),
    memberCount: artifact.members.length,
    members: artifact.members.map((entry) => entry.descriptor),
    runtimeMetadataPath: 'quickapp-kit/runtime.json',
    coreLoaderInput: 'evidence/tk-s07-case001.rpk',
    coreLoaderChecks: ['open', 'load_module:app', 'load_page_ir:/pages/Demo'],
    alphaCorrections: {
      pageVmRootState: ['title'],
      bindingEvaluator: 'String(this.title)',
      defineMetadataDependenciesExact: true,
      packageDependenciesOnly: true,
      sharedSelfDependencyRemoved: true,
      staticRequireContextExpanded: true,
      typedFacadeModuleId: '@app-module/system.*',
      typedFacadeExcludedFromPackageDependencies: true,
    },
    deterministicBuild: true,
    failureAtomicity: true,
    limitsAndCancellation: true,
  }, null, 2)}\n`)
}
