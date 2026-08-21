import { getNodeValue, parseTree, printParseErrorCode, type Node as JsonNode, type ParseError } from 'jsonc-parser'
import { ErrorCodes } from '../../diagnostics/error-codes.js'
import type { Diagnostic } from '../../diagnostics/diagnostic.js'
import type { SourceUnit } from '../../workspace/types.js'
import { deepFreeze } from '../immutable.js'
import { SourceCoordinateMap } from '../frontend/source-coordinate-map.js'
import type { SourceSpan } from '../frontend/types.js'
import type { ExcludedWidget, ManifestResult, ManifestSchemaValidator, ResolvedManifest, ResolvedPage } from './types.js'

export function parseManifest(source: SourceUnit, sourceRoot: string, schemaValidator: ManifestSchemaValidator): ManifestResult {
  const text = source.text ?? ''
  const coordinates = new SourceCoordinateMap(text)
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true })
  if (errors.length > 0 || root === undefined) {
    const error = errors[0]
    return failure(diagnostic(ErrorCodes.manifestInvalidJson, `Manifest is not strict JSON${error === undefined ? '' : `: ${printParseErrorCode(error.error)}`}`, source.logicalPath, coordinates.span(error?.offset ?? 0, Math.min(text.length, (error?.offset ?? 0) + Math.max(1, error?.length ?? 1)))))
  }
  if (root.type !== 'object') return failure(diagnostic(ErrorCodes.manifestSchemaInvalid, 'Manifest root must be an object', source.logicalPath, coordinates.span(root.offset, root.offset + root.length)))

  const duplicate = findDuplicateProperty(root)
  if (duplicate !== undefined) return failure(diagnostic(ErrorCodes.manifestDuplicateKey, `Manifest contains duplicate key: ${duplicate.key}`, source.logicalPath, coordinates.span(duplicate.node.offset, duplicate.node.offset + duplicate.node.length)))
  const value = getNodeValue(root) as unknown
  const schemaErrors = schemaValidator.validate(value)
  if (schemaErrors.length > 0) return failure(diagnostic(ErrorCodes.manifestSchemaInvalid, `Manifest does not satisfy the public schema: ${schemaErrors.join('; ')}`, source.logicalPath, coordinates.span(root.offset, root.offset + root.length)))
  if (!isRecord(value)) return failure(diagnostic(ErrorCodes.manifestSchemaInvalid, 'Manifest root must be an object', source.logicalPath, coordinates.span(root.offset, root.offset + root.length)))

  const router = value.router
  if (!isRecord(router) || !isRecord(router.pages) || typeof router.entry !== 'string') return failure(diagnostic(ErrorCodes.manifestSchemaInvalid, 'Manifest router is invalid', source.logicalPath, coordinates.span(root.offset, root.offset + root.length)))
  const pages: ResolvedPage[] = []
  for (const manifestRoute of Object.keys(router.pages).sort(compareUtf8)) {
    const page = router.pages[manifestRoute]
    if (!validRoute(manifestRoute) || !isRecord(page) || typeof page.component !== 'string' || !validSegment(page.component)) {
      return failure(diagnostic(ErrorCodes.routeInvalid, `Invalid page route or component: ${manifestRoute}`, source.logicalPath, spanAt(root, ['router', 'pages', manifestRoute], coordinates)))
    }
    pages.push(Object.freeze({
      manifestRoute,
      runtimeRoute: `/${manifestRoute}`,
      component: page.component,
      sourcePath: `${sourceRoot}/${manifestRoute}/${page.component}.ux`,
      moduleId: `@quickapp-kit/page/${manifestRoute}`,
    }))
  }
  if (!validRoute(router.entry) || !pages.some((page) => page.manifestRoute === router.entry)) {
    return failure(diagnostic(ErrorCodes.routeEntryNotFound, `Entry route is not a normal page: ${router.entry}`, source.logicalPath, spanAt(root, ['router', 'entry'], coordinates)))
  }

  const featureValues = Array.isArray(value.features) ? value.features : []
  const features: string[] = []
  for (const entry of featureValues) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !/^system\.[A-Za-z][A-Za-z0-9_.]*$/.test(entry.name) || features.includes(entry.name)) {
      return failure(diagnostic(ErrorCodes.manifestSchemaInvalid, 'Manifest features must contain unique system.* names', source.logicalPath, spanAt(root, ['features'], coordinates)))
    }
    features.push(entry.name)
  }
  features.sort(compareUtf8)
  const widgets = isRecord(router.widgets) ? router.widgets : {}
  const excludedWidgets: ExcludedWidget[] = Object.keys(widgets).sort(compareUtf8).map((manifestKey) => Object.freeze({
    manifestKey,
    code: ErrorCodes.widgetExcluded,
    span: spanAt(root, ['router', 'widgets', manifestKey], coordinates),
  }))
  const warnings = excludedWidgets.map((widget) => diagnostic(ErrorCodes.widgetExcluded, `Widget is excluded from V1: ${widget.manifestKey}`, source.logicalPath, widget.span, 'Remove the Widget or compile it with a later product version.', 'warning'))
  const manifest: ResolvedManifest = deepFreeze({
    packageName: value.package as string,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    versionName: value.versionName as string,
    versionCode: value.versionCode as number,
    minPlatformVersion: value.minPlatformVersion as number,
    entry: router.entry,
    pages: Object.freeze(pages),
    features: Object.freeze(features),
    permissions: Array.isArray(value.permissions) ? [...value.permissions] : [],
    ...(value.display === undefined ? {} : { display: value.display }),
    ...(typeof value.icon === 'string' ? { icon: value.icon } : {}),
    raw: { ...value },
  })
  return { status: 'success', manifest, excludedWidgets: Object.freeze(excludedWidgets), diagnostics: Object.freeze(warnings) }
}

function findDuplicateProperty(node: JsonNode): { key: string; node: JsonNode } | undefined {
  if (node.type === 'object') {
    const seen = new Set<string>()
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0]
      const valueNode = property.children?.[1]
      const key = keyNode === undefined ? undefined : getNodeValue(keyNode)
      if (keyNode !== undefined && typeof key === 'string') {
        if (seen.has(key)) return { key, node: keyNode }
        seen.add(key)
      }
      if (valueNode !== undefined) {
        const duplicate = findDuplicateProperty(valueNode)
        if (duplicate !== undefined) return duplicate
      }
    }
  } else if (node.type === 'array') {
    for (const child of node.children ?? []) {
      const duplicate = findDuplicateProperty(child)
      if (duplicate !== undefined) return duplicate
    }
  }
  return undefined
}

function spanAt(root: JsonNode, path: readonly string[], coordinates: SourceCoordinateMap): SourceSpan {
  let node: JsonNode | undefined = root
  for (const segment of path) {
    if (node?.type !== 'object') break
    const property: JsonNode | undefined = node.children?.find((child) => {
      const keyNode = child.children?.[0]
      return keyNode !== undefined && getNodeValue(keyNode) === segment
    })
    node = property?.children?.[1]
  }
  return node === undefined ? coordinates.span(root.offset, root.offset + root.length) : coordinates.span(node.offset, node.offset + node.length)
}

function validRoute(value: string): boolean {
  return !value.startsWith('/') && !value.endsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(validSegment)
}

function validSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0')
}

function diagnostic(code: string, message: string, file: string, span: SourceSpan, hint = 'Fix the manifest before continuing the build.', severity: 'error' | 'warning' = 'error'): Diagnostic {
  return { severity, code, phase: 'manifest', message, file, range: { start: span.start, end: span.end }, hint }
}

function failure(item: Diagnostic): ManifestResult {
  return { status: 'failure', diagnostics: Object.freeze([item]) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right))
}
