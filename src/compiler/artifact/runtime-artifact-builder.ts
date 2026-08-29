import { createHash } from 'node:crypto'
import { ErrorCodes } from '../../diagnostics/error-codes.js'
import { sortDiagnostics, type Diagnostic } from '../../diagnostics/diagnostic.js'
import { deepFreeze } from '../immutable.js'
import { assertDeepFrozen } from '../lowering/syntax.js'
import type { CanonicalLoweredAppModel, CanonicalModuleEntry } from '../lowering/types.js'
import type { ResolvedManifest } from '../manifest/types.js'
import type { JsBundleArtifact, PageIrArtifact } from '../emitter/types.js'
import { ArtifactIssue } from './artifact-issue.js'
import { DEFAULT_ARTIFACT_LIMITS, type ArtifactDescriptor, type ArtifactLimits, type RuntimeArtifact, type RuntimeArtifactRequest, type RuntimeArtifactResult, type RuntimeMetadata, type RuntimeResourceInput, type RuntimeRpkMember } from './types.js'

const RPK_RUNTIME_PATH = 'quickapp-kit/runtime.json'
const FIXED_VERSION = {
  packageFormat: 'quickapp-kit-rpk-v1' as const,
  runtimeAbi: 'quickapp-kit-runtime-v1' as const,
  irVersion: 1 as const,
  jsModuleAbi: 'quickapp-kit-app-module-v1' as const,
}

export class RuntimeArtifactBuilder {
  build(request: RuntimeArtifactRequest): RuntimeArtifactResult {
    const limits = { ...DEFAULT_ARTIFACT_LIMITS, ...(request.limits ?? {}) }
    const diagnostics: Diagnostic[] = []
    try {
      request.cancellation.throwIfCancelled()
      assertDeepFrozen(request.model)
      assertDeepFrozen(request.manifest)
      assertDeepFrozen(request.js)
      assertDeepFrozen(request.pageIr)
      if (request.resources !== undefined) assertDeepFrozen(request.resources)
      const artifact = buildArtifact(request, limits)
      return deepFreeze(artifact)
    } catch (error) {
      if (error instanceof ArtifactIssue) diagnostics.push(error.diagnostic)
      else if (isCancellation(error)) diagnostics.push(cancelledDiagnostic())
      else diagnostics.push(invalidDiagnostic(error instanceof Error ? error.message : 'Runtime Artifact packaging failed'))
      return Object.freeze({ status: 'failure', diagnostics: Object.freeze(sortDiagnostics(diagnostics).slice(0, limits.maxDiagnostics)) })
    }
  }
}

function buildArtifact(request: RuntimeArtifactRequest, limits: ArtifactLimits): RuntimeArtifact {
  validateInput(request.model, request.manifest, request.js.bundles, request.pageIr.pages, limits)
  const jsById = new Map(request.js.bundles.map((bundle) => [bundle.moduleId, bundle]))
  const irByModuleId = new Map(request.pageIr.pages.map((page) => [page.moduleId, page]))
  const manifestPages = new Map(request.manifest.pages.map((page) => [page.manifestRoute, page]))
  const pages = [...request.model.pages].sort((left, right) => compareUtf8(left.manifestRoute, right.manifestRoute))
  const shared = [...request.model.sharedModules].sort((left, right) => compareUtf8(left.moduleId, right.moduleId))
  const appBundle = requiredBundle(jsById, request.model.appModule)
  const appDescriptor = descriptor('app.js', 'application/javascript', appBundle.content)
  if (appBundle.path !== appDescriptor.path) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, 'App Bundle path is not the Runtime Artifact path', appBundle.moduleId, undefined)

  const sharedDescriptors = shared.map((module) => {
    const bundle = requiredBundle(jsById, module)
    return { moduleId: module.moduleId, dependencies: [...bundle.dependencies], bundle: descriptor(bundle.path, 'application/javascript', bundle.content) }
  })
  const pageDescriptors = pages.map((page) => {
    const manifestPage = manifestPages.get(page.manifestRoute)
    const bundle = requiredBundle(jsById, page.module)
    const ir = irByModuleId.get(page.moduleId)
    if (manifestPage === undefined || ir === undefined) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Page relation is incomplete: ${page.manifestRoute}`, page.module.source.sourcePath, page.module.source.span)
    if (bundle.path !== `pages/${page.manifestRoute}/index.js`) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Page Bundle path is invalid: ${bundle.path}`, page.module.source.sourcePath, page.module.source.span)
    if (ir.path !== `quickapp-kit/pages/${page.manifestRoute}/index.ir.json` || ir.templateId !== page.templateId) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Page IR relation is invalid: ${page.manifestRoute}`, page.module.source.sourcePath, page.module.source.span)
    if (utf8ByteLength(ir.content) > limits.maxPageIrBytes) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, `Page IR exceeds the Core loading limit: ${page.manifestRoute}`, page.module.source.sourcePath, page.module.source.span)
    return {
      route: page.route,
      manifestRoute: page.manifestRoute,
      component: manifestPage.component,
      moduleId: page.moduleId,
      dependencies: [...bundle.dependencies],
      templateId: page.templateId,
      bundle: descriptor(bundle.path, 'application/javascript', bundle.content),
      pageIr: descriptor(ir.path, 'application/json', ir.content),
    }
  })
  const resources = (request.resources ?? []).slice().sort((left, right) => compareUtf8(left.path, right.path)).map((resource) => {
    const bytes = toBytes(resource.bytes)
    validateResource(resource, bytes, limits)
    const video = resource.mediaType === 'video/mp4' || resource.mediaType === 'video/webm'
    const metadata = video
      ? { resourceId: resource.resourceId ?? resource.path, width: resource.width, height: resource.height, durationMs: resource.durationMs }
      : {}
    return { descriptor: descriptor(resource.path, resource.mediaType, bytes, metadata), bytes }
  })
  const metadata: RuntimeMetadata = {
    schemaVersion: 1,
    ...FIXED_VERSION,
    packageId: request.manifest.packageName,
    toolkit: { name: 'quickapp-toolkit', version: request.toolkitVersion },
    buildMode: request.buildMode,
    entryRoute: `/${request.manifest.entry}`,
    app: { moduleId: request.model.appModule.moduleId, dependencies: [...appBundle.dependencies], bundle: appDescriptor },
    sharedModules: sharedDescriptors,
    pages: pageDescriptors,
    resources: resources.map((resource) => resource.descriptor),
  }
  const manifestBytes = jsonBytes(request.manifest.raw)
  const metadataBytes = jsonBytes(metadata)
  const metadataErrors = request.schemaValidator.validateRuntimeMetadata(metadata)
  if (metadataErrors.length > 0) throw new ArtifactIssue(ErrorCodes.artifactSchemaInvalid, `Runtime Metadata Schema rejected the output: ${metadataErrors.join('; ')}`)
  const manifestErrors = request.schemaValidator.validateManifest(request.manifest.raw)
  if (manifestErrors.length > 0) throw new ArtifactIssue(ErrorCodes.artifactSchemaInvalid, `Manifest Schema rejected the output: ${manifestErrors.join('; ')}`)
  if (metadataBytes.length > limits.maxMetadataBytes) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, 'Runtime Metadata exceeds the artifact limit')
  if (manifestBytes.length > limits.maxManifestBytes) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, 'Manifest exceeds the Core loading limit')

  const members: RuntimeRpkMember[] = [
    member('manifest.json', 'application/json', manifestBytes),
    member(RPK_RUNTIME_PATH, 'application/json', metadataBytes),
    member('app.js', 'application/javascript', toBytes(appBundle.content)),
    ...sharedDescriptors.map((entry) => member(entry.bundle.path, 'application/javascript', toBytes(requiredBundle(jsById, findModule(request.model, entry.moduleId)).content))),
    ...pageDescriptors.flatMap((page) => [
      member(page.bundle.path, 'application/javascript', toBytes(requiredBundle(jsById, findModule(request.model, page.moduleId)).content)),
      member(page.pageIr.path, 'application/json', toBytes(requiredPage(irByModuleId, page.moduleId).content)),
    ]),
    ...resources.map((resource) => member(resource.descriptor.path, resource.descriptor.mediaType, resource.bytes)),
    ...request.js.bundles.map((bundle) => member(`META-INF/quickapp-kit/source-maps/${bundle.path}.map`, 'application/json', toBytes(bundle.sourceMap.content))),
  ]
  const packageMembers = uniqueMembers(members, limits)
  const packageBytes = makeZip(packageMembers, limits)
  return {
    status: 'success',
    metadata,
    members: packageMembers,
    packageBytes,
  }
}

function validateInput(model: CanonicalLoweredAppModel, manifest: ResolvedManifest, bundles: readonly JsBundleArtifact[], pages: readonly PageIrArtifact[], limits: ArtifactLimits): void {
  if (model.modelVersion !== 1 || model.packageName !== manifest.packageName) throw new ArtifactIssue(ErrorCodes.artifactInputInvalid, 'Canonical model and verified Manifest identity differ')
  if (model.pages.length > limits.maxPages) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, 'Page count exceeds the Core loading limit')
  if (bundles.length !== 1 + model.sharedModules.length + model.pages.length || pages.length !== model.pages.length) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, 'S05/S06 output closure does not match the Canonical Lowered Model')
  const ids = new Set<string>()
  for (const module of [model.appModule, ...model.sharedModules, ...model.pages.map((page) => page.module)]) {
    if (ids.has(module.moduleId)) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Duplicate moduleId: ${module.moduleId}`, module.source.sourcePath, module.source.span)
    ids.add(module.moduleId)
  }
  validatePackageGraph(model)
  if (manifest.pages.length !== model.pages.length || manifest.pages.some((page) => !model.pages.some((candidate) => candidate.manifestRoute === page.manifestRoute))) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, 'Manifest and Canonical page closure differ')
  if (limits.maxMembers < 1 || limits.maxPages < 1 || limits.maxPackageBytes < 22 || limits.maxMemberBytes < 1 || limits.maxManifestBytes < 1 || limits.maxMetadataBytes < 1 || limits.maxPageIrBytes < 1 || limits.maxZipCentralDirectoryBytes < 1) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, 'Artifact limits are invalid')
}

function requiredBundle(index: ReadonlyMap<string, JsBundleArtifact>, module: CanonicalModuleEntry): JsBundleArtifact {
  const bundle = index.get(module.moduleId)
  if (bundle === undefined || bundle.moduleKind !== module.moduleKind) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Missing Bundle for module: ${module.moduleId}`, module.source.sourcePath, module.source.span)
  if (JSON.stringify(bundle.dependencies) !== JSON.stringify(module.dependencies)) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Bundle dependencies differ from the Canonical package graph: ${module.moduleId}`, module.source.sourcePath, module.source.span)
  return bundle
}

function validatePackageGraph(model: CanonicalLoweredAppModel): void {
  const modules = [model.appModule, ...model.sharedModules, ...model.pages.map((page) => page.module)]
  const byId = new Map(modules.map((module) => [module.moduleId, module]))
  for (const module of modules) {
    const sorted = [...new Set(module.dependencies)].sort(compareUtf8)
    if (JSON.stringify(sorted) !== JSON.stringify(module.dependencies)) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Module dependencies are not unique and deterministic: ${module.moduleId}`, module.source.sourcePath, module.source.span)
    for (const dependency of module.dependencies) {
      const target = byId.get(dependency)
      if (dependency === module.moduleId) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Module cannot depend on itself: ${module.moduleId}`, module.source.sourcePath, module.source.span)
      if (dependency.startsWith('@app-module/')) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Typed facade cannot enter package dependencies: ${dependency}`, module.source.sourcePath, module.source.span)
      if (target === undefined) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Package dependency is absent: ${dependency}`, module.source.sourcePath, module.source.span)
      const valid = module.moduleKind === 'page' ? target.moduleKind === 'app' || target.moduleKind === 'shared' : target.moduleKind === 'shared'
      if (!valid) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Invalid ${module.moduleKind} dependency: ${dependency}`, module.source.sourcePath, module.source.span)
    }
  }
}

function findModule(model: CanonicalLoweredAppModel, moduleId: string): CanonicalModuleEntry {
  const all = [model.appModule, ...model.sharedModules, ...model.pages.map((page) => page.module)]
  const module = all.find((candidate) => candidate.moduleId === moduleId)
  if (module === undefined) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Missing module for descriptor: ${moduleId}`)
  return module
}

function requiredPage(index: ReadonlyMap<string, PageIrArtifact>, moduleId: string): PageIrArtifact {
  const page = index.get(moduleId)
  if (page === undefined) throw new ArtifactIssue(ErrorCodes.artifactRelationInvalid, `Missing Page IR for module: ${moduleId}`)
  return page
}

function descriptor(path: string, mediaType: string, content: string | readonly number[], metadata: Readonly<Record<string, unknown>> = {}): ArtifactDescriptor {
  const bytes = typeof content === 'string' ? toBytes(content) : content
  assertPath(path)
  return Object.freeze({ path, mediaType, byteLength: bytes.length, sha256: sha256(bytes), ...metadata }) as ArtifactDescriptor
}

function validateResource(resource: RuntimeResourceInput, bytes: readonly number[], limits: ArtifactLimits): void {
  const mediaTypes = new Set(['application/octet-stream', 'image/png', 'image/jpeg', 'video/mp4', 'video/webm'])
  assertPath(resource.path)
  if (!mediaTypes.has(resource.mediaType)) throw new ArtifactIssue(ErrorCodes.artifactInputInvalid, `Unsupported resource MIME: ${resource.mediaType}`)
  if (bytes.length === 0) throw new ArtifactIssue(ErrorCodes.artifactInputInvalid, `Resource is empty: ${resource.path}`)
  if (bytes.length > limits.maxMemberBytes) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, `Resource exceeds the artifact member limit: ${resource.path}`)
  const video = resource.mediaType === 'video/mp4' || resource.mediaType === 'video/webm'
  if (video) {
    if (!resource.path.startsWith('assets/videos/')) throw new ArtifactIssue(ErrorCodes.artifactPathInvalid, `Static video must be under assets/videos/: ${resource.path}`)
    if (resource.resourceId !== undefined && resource.resourceId !== resource.path) throw new ArtifactIssue(ErrorCodes.artifactInputInvalid, `Video resourceId must equal path: ${resource.path}`)
    if (!hasSupportedVideoSignature(resource.mediaType, bytes)) throw new ArtifactIssue(ErrorCodes.artifactInputInvalid, `Video format does not match MIME: ${resource.path}`)
  }
  for (const [name, value] of [['width', resource.width], ['height', resource.height], ['durationMs', resource.durationMs]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || (name !== 'durationMs' && value === 0))) {
      throw new ArtifactIssue(ErrorCodes.artifactInputInvalid, `Invalid ${name} metadata: ${resource.path}`)
    }
  }
}

function hasSupportedVideoSignature(mediaType: RuntimeResourceInput['mediaType'], bytes: readonly number[]): boolean {
  if (mediaType === 'video/mp4') return bytes.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp'
  if (mediaType === 'video/webm') return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  return true
}

function member(path: string, mediaType: string, bytes: readonly number[]): RuntimeRpkMember {
  return Object.freeze({ descriptor: descriptor(path, mediaType, bytes), bytes: Object.freeze([...bytes]) })
}

function uniqueMembers(members: readonly RuntimeRpkMember[], limits: ArtifactLimits): RuntimeRpkMember[] {
  const sorted = [...members].sort((left, right) => compareUtf8(left.descriptor.path, right.descriptor.path))
  if (sorted.length > limits.maxMembers) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, 'Runtime RPK member count exceeds limit')
  const seen = new Set<string>()
  let total = 0
  for (const entry of sorted) {
    assertPath(entry.descriptor.path)
    if (seen.has(entry.descriptor.path)) throw new ArtifactIssue(ErrorCodes.artifactPathInvalid, `Duplicate Runtime RPK member: ${entry.descriptor.path}`)
    seen.add(entry.descriptor.path)
    if (entry.bytes.length > limits.maxMemberBytes) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, `Runtime RPK member exceeds limit: ${entry.descriptor.path}`)
    total += entry.bytes.length
  }
  if (total > 64 * 1024 * 1024) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, 'Runtime RPK expanded bytes exceed limit')
  return sorted
}

function makeZip(members: readonly RuntimeRpkMember[], limits: ArtifactLimits): readonly number[] {
  const output: number[] = []
  const records: Array<{ member: RuntimeRpkMember; offset: number; crc: number }> = []
  for (const entry of members) {
    const name = Buffer.from(entry.descriptor.path, 'utf8')
    const bytes = entry.bytes
    const offset = output.length
    const crc = crc32(bytes)
    appendU32(output, 0x04034b50)
    appendU16(output, 20)
    appendU16(output, 0x0800)
    appendU16(output, 0)
    appendU16(output, 0)
    appendU16(output, 0)
    appendU32(output, crc)
    appendU32(output, bytes.length)
    appendU32(output, bytes.length)
    appendU16(output, name.length)
    appendU16(output, 0)
    appendBytes(output, name)
    appendBytes(output, bytes)
    records.push({ member: entry, offset, crc })
  }
  const centralOffset = output.length
  for (const record of records) {
    const name = Buffer.from(record.member.descriptor.path, 'utf8')
    appendU32(output, 0x02014b50)
    appendU16(output, 20)
    appendU16(output, 20)
    appendU16(output, 0x0800)
    appendU16(output, 0)
    appendU16(output, 0)
    appendU16(output, 0)
    appendU32(output, record.crc)
    appendU32(output, record.member.bytes.length)
    appendU32(output, record.member.bytes.length)
    appendU16(output, name.length)
    appendU16(output, 0)
    appendU16(output, 0)
    appendU16(output, 0)
    appendU16(output, 0)
    appendU32(output, 0)
    appendU32(output, record.offset)
    appendBytes(output, name)
  }
  const centralBytes = output.length - centralOffset
  if (centralBytes > limits.maxZipCentralDirectoryBytes) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, 'ZIP central directory exceeds limit')
  appendU32(output, 0x06054b50)
  appendU16(output, 0)
  appendU16(output, 0)
  appendU16(output, records.length)
  appendU16(output, records.length)
  appendU32(output, centralBytes)
  appendU32(output, centralOffset)
  appendU16(output, 0)
  if (output.length > limits.maxPackageBytes) throw new ArtifactIssue(ErrorCodes.artifactLimitExceeded, 'Runtime RPK bytes exceed limit')
  return Object.freeze(output.slice())
}

function jsonBytes(value: unknown): number[] {
  const content = JSON.stringify(value)
  if (content === undefined) throw new ArtifactIssue(ErrorCodes.artifactInputInvalid, 'Artifact JSON value is not serializable')
  return toBytes(`${content}\n`)
}

function toBytes(value: string | readonly number[]): number[] { return typeof value === 'string' ? Array.from(Buffer.from(value, 'utf8')) : [...value] }
function sha256(bytes: readonly number[]): string { return createHash('sha256').update(Buffer.from(bytes)).digest('hex') }
function utf8ByteLength(value: string): number { return Buffer.byteLength(value, 'utf8') }
function compareUtf8(left: string, right: string): number { return Buffer.from(left).compare(Buffer.from(right)) }
function assertPath(path: string): void {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => part.length === 0 || part === '.' || part === '..') || utf8ByteLength(path) > 512) throw new ArtifactIssue(ErrorCodes.artifactPathInvalid, `Invalid Runtime Artifact path: ${path}`)
}
function appendU16(output: number[], value: number): void { output.push(value & 0xff, (value >>> 8) & 0xff) }
function appendU32(output: number[], value: number): void { output.push(value >>> 0 & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff) }
function appendBytes(output: number[], bytes: Iterable<number>): void {
  for (const byte of bytes) output.push(byte)
}
function crc32(bytes: readonly number[]): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function isCancellation(value: unknown): boolean { return value instanceof Error && value.name === 'OperationCancelledError' }
function cancelledDiagnostic(): Diagnostic { return Object.freeze({ severity: 'error', code: ErrorCodes.artifactCancelled, phase: 'build', message: 'Runtime Artifact packaging was cancelled', hint: 'Retry the build without cancellation.' }) }
function invalidDiagnostic(message: string): Diagnostic { return Object.freeze({ severity: 'error', code: ErrorCodes.artifactInputInvalid, phase: 'build', message, hint: 'Provide the verified immutable S05/S06 outputs and Manifest snapshot.' }) }
