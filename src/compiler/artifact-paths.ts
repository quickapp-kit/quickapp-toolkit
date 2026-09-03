import { createHash } from 'node:crypto'

function pageBundle(manifestRoute: string): string {
  return `${manifestRoute}/index.js`
}

function pageIr(manifestRoute: string): string {
  return `${manifestRoute}/index.ir.json`
}

function sharedBundle(moduleId: string): string {
  const hash = createHash('sha256').update(moduleId, 'utf8').digest('hex')
  return `shared/${hash}.js`
}

function frameworkBundle(moduleId: string): string {
  return `shared/${moduleId.replace(/[^A-Za-z0-9_.-]/g, '_')}.js`
}

function sourceMap(bundlePath: string): string {
  return `META-INF/source-maps/${bundlePath}.map`
}

export const ArtifactPaths = Object.freeze({
  manifest: 'manifest.json',
  appBundle: 'app.js',
  runtimeMetadata: 'META-INF/runtime.json',
  pageBundle,
  pageIr,
  sharedBundle,
  frameworkBundle,
  sourceMap,
})
