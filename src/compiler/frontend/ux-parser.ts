import { parseFragment } from 'parse5'
import { ErrorCodes } from '../../diagnostics/error-codes.js'
import { FrontendIssue } from './frontend-issue.js'
import { parseJavaScript, parseJavaScriptExpression } from './javascript-parser.js'
import { SourceCoordinateMap } from './source-coordinate-map.js'
import { parseStyle, type StyleParseResult } from './style-parser.js'
import type {
  FrontendFeatureUsage,
  FrontendLimits,
  ParsedUxSource,
  SourceSpan,
  TemplateAttributeSyntax,
  TemplateChildSyntax,
  TemplateElementSyntax,
} from './types.js'

interface HtmlLocation {
  readonly startOffset: number
  readonly endOffset: number
  readonly startTag?: HtmlLocation
  readonly endTag?: HtmlLocation
  readonly attrs?: Readonly<Record<string, HtmlLocation>>
}

interface HtmlNode {
  readonly nodeName: string
  readonly tagName?: string
  readonly value?: string
  readonly attrs?: readonly { readonly name: string; readonly value: string }[]
  readonly childNodes?: readonly HtmlNode[]
  readonly content?: { readonly childNodes?: readonly HtmlNode[] }
  readonly sourceCodeLocation?: HtmlLocation | null
}

export function parseUx(
  text: string,
  sourcePath: string,
  sourceSha256: string,
  sourceKind: 'appUx' | 'pageUx',
  coordinates: SourceCoordinateMap,
  limits: FrontendLimits,
): ParsedUxSource {
  const recoveryErrors: unknown[] = []
  const document = parseFragment(text, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => recoveryErrors.push(error),
  }) as unknown as HtmlNode
  if (recoveryErrors.length > 0) {
    const first = recoveryErrors[0] as { startOffset?: number; endOffset?: number }
    throw issue(ErrorCodes.uxFragmentInvalid, 'UX fragment syntax is invalid', coordinates, first.startOffset ?? 0, first.endOffset ?? Math.min(1, text.length))
  }
  const sections = new Map<string, HtmlNode>()
  for (const node of document.childNodes ?? []) {
    if (node.nodeName === '#comment' || (node.nodeName === '#text' && (node.value ?? '').trim() === '')) continue
    const name = node.tagName
    if (name === undefined || !['template', 'script', 'style'].includes(name)) {
      throw issue(ErrorCodes.uxFragmentInvalid, 'UX top level only permits template, script, and style fragments', coordinates, location(node).startOffset, location(node).endOffset)
    }
    if (sections.has(name)) throw issue(ErrorCodes.uxFragmentDuplicate, `Duplicate ${name} fragment`, coordinates, location(node).startOffset, location(node).endOffset)
    validateFragmentAttributes(node, name, coordinates)
    sections.set(name, node)
  }

  const templateSection = sections.get('template')
  const scriptSection = sections.get('script')
  const styleSection = sections.get('style')
  if (sourceKind === 'appUx' && templateSection !== undefined) {
    throw issue(ErrorCodes.uxFragmentInvalid, 'App UX cannot contain a template fragment in V1', coordinates, location(templateSection).startOffset, location(templateSection).endOffset)
  }
  if (sourceKind === 'pageUx' && templateSection === undefined) {
    throw issue(ErrorCodes.uxTemplateRequired, 'Page UX requires one template fragment', coordinates, 0, Math.min(1, text.length))
  }
  if (scriptSection === undefined) {
    throw issue(ErrorCodes.uxScriptRequired, 'App and Page UX require one script fragment', coordinates, 0, Math.min(1, text.length))
  }

  const scriptRange = contentRange(scriptSection)
  const script = parseJavaScript(text.slice(scriptRange.start, scriptRange.end), sourcePath, coordinates, scriptRange.start, limits, true)
  const style = styleSection === undefined ? undefined : parseUxStyle(styleSection, text, sourcePath, coordinates, limits)
  const template = templateSection === undefined ? undefined : parseTemplate(templateSection, text, coordinates, limits)
  return Object.freeze({
    sourcePath,
    sourceKind,
    sourceSha256,
    references: Object.freeze([...script.references, ...(style?.references ?? [])]),
    featureUsage: Object.freeze([
      usage(sourceKind === 'appUx' ? 'ux.fragment.app-script-optional-style' : 'ux.fragment.page-template-script-style', coordinates.span(0, text.length)),
      ...script.featureUsage,
      ...(style?.featureUsage ?? []),
      ...(template?.featureUsage ?? []),
    ]),
    ...(template === undefined ? {} : { template: Object.freeze({ root: template.root }) }),
    script: script.syntax,
    ...(style === undefined ? {} : { style: style.stylesheet }),
  })
}

function parseUxStyle(section: HtmlNode, fullText: string, sourcePath: string, coordinates: SourceCoordinateMap, limits: FrontendLimits): StyleParseResult {
  const range = contentRange(section)
  const lang = section.attrs?.find((attribute) => attribute.name === 'lang')?.value
  return parseStyle(fullText.slice(range.start, range.end), sourcePath, coordinates, range.start, limits, lang === 'less' ? 'less' : 'css')
}

function parseTemplate(section: HtmlNode, fullText: string, coordinates: SourceCoordinateMap, limits: FrontendLimits): { root: TemplateElementSyntax; featureUsage: readonly FrontendFeatureUsage[] } {
  const children = section.content?.childNodes ?? []
  const roots = children.filter((node) => node.nodeName !== '#comment' && !(node.nodeName === '#text' && (node.value ?? '').trim() === ''))
  if (roots.length !== 1 || roots[0]?.tagName === undefined) {
    const range = contentRange(section)
    throw issue(ErrorCodes.templateMultipleRoots, 'Template requires exactly one root element', coordinates, range.start, range.end)
  }
  const features: FrontendFeatureUsage[] = []
  return { root: normalizeElement(roots[0], fullText, coordinates, limits, features, 1), featureUsage: Object.freeze(features) }
}

function normalizeElement(node: HtmlNode, fullText: string, coordinates: SourceCoordinateMap, limits: FrontendLimits, features: FrontendFeatureUsage[], depth: number): TemplateElementSyntax {
  const nodeLocation = location(node)
  const span = coordinates.span(nodeLocation.startOffset, nodeLocation.endOffset)
  if (depth > limits.maxDepth) throw new FrontendIssue(ErrorCodes.frontendLimitExceeded, 'Template depth exceeds configured limit', span, 'Reduce template nesting.')
  const rawTagName = node.tagName ?? ''
  // parse5 follows HTML parsing rules and normalizes QuickApp <image> to <img>.
  const tagName = rawTagName === 'img' ? 'image' : rawTagName
  if (!['div', 'text', 'image', 'input', 'switch', 'slider', 'picker', 'list', 'scroll', 'video', 'tabs', 'a'].includes(tagName)) throw new FrontendIssue(ErrorCodes.templateFeatureUnsupported, `Template tag <${rawTagName}> is not supported in V1`, span, 'Use a V1-supported template tag.')
  features.push(usage('template.tag.div/text/image/input/switch/slider/picker/list/scroll/video/tabs/a', span))
  const attributes = (node.attrs ?? []).map((attribute) => normalizeAttribute(node, attribute, fullText, coordinates, limits, features))
  const children: TemplateChildSyntax[] = []
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#comment') continue
    if (child.nodeName === '#text') {
      const childLocation = location(child)
      const childSpan = coordinates.span(childLocation.startOffset, childLocation.endOffset)
      const value = child.value ?? ''
      const interpolations = parseInterpolations(value, childLocation.startOffset, coordinates, limits)
      children.push(Object.freeze({ kind: 'text', value, span: childSpan, interpolations, ignorableWhitespace: value.trim() === '' }))
      continue
    }
    if (child.tagName !== undefined) children.push(normalizeElement(child, fullText, coordinates, limits, features, depth + 1))
  }
  const startTag = nodeLocation.startTag
  const rawStartTag = startTag === undefined ? '' : fullText.slice(startTag.startOffset, startTag.endOffset)
  return Object.freeze({
    kind: 'element',
    tagName,
    attributes: Object.freeze(attributes),
    children: Object.freeze(children),
    selfClosing: /\/\s*>$/.test(rawStartTag),
    span,
  })
}

function normalizeAttribute(
  owner: HtmlNode,
  attribute: { readonly name: string; readonly value: string },
  fullText: string,
  coordinates: SourceCoordinateMap,
  limits: FrontendLimits,
  features: FrontendFeatureUsage[],
): TemplateAttributeSyntax {
  const attributeLocation = location(owner).attrs?.[attribute.name] ?? location(owner).startTag ?? location(owner)
  const span = coordinates.span(attributeLocation.startOffset, attributeLocation.endOffset)
  const name = attribute.name.toLowerCase()
  if (!['class', 'type', 'value', 'checked', 'enabled', 'min', 'max', 'step', 'mode', 'range', 'items', 'selected', 'src', 'poster', 'autoplay', 'controls', 'muted', 'href', 'open-mode', 'onclick', 'oninput', 'onchange', 'onfocus', 'onscroll', 'onscrollend', 'onscrolltop', 'onscrollbottom', 'onprepared', 'onstart', 'onpause', 'onfinish', 'onerror', 'ontimeupdate', 'if', 'for', 'tid'].includes(name)) {
    throw new FrontendIssue(ErrorCodes.templateFeatureUnsupported, `Template attribute ${name} is not supported in V1`, span, 'Use only V1-supported attributes and directives.')
  }
  if (name === 'class' && attribute.value.includes('{{')) throw new FrontendIssue(ErrorCodes.templateFeatureUnsupported, 'Dynamic class is not supported in V1', span, 'Use a static class value.')
  if (['onclick', 'oninput', 'onchange', 'onfocus', 'onscroll', 'onscrollend', 'onscrolltop', 'onscrollbottom', 'onprepared', 'onstart', 'onpause', 'onfinish', 'onerror', 'ontimeupdate'].includes(name) && !/^[$A-Z_a-z][$\w]*$/.test(attribute.value)) throw new FrontendIssue(ErrorCodes.templateFeatureUnsupported, `${name} must name one static VM method`, span, 'Use an identifier such as onTimeUpdate.')
  if (['class', 'type', 'value', 'src', 'poster', 'autoplay', 'controls', 'muted', 'href', 'open-mode', 'items', 'selected'].includes(name)) features.push(usage('template.attr.class/type/value/src/video/a/tabs', span))
  if (['onclick', 'oninput', 'onchange', 'onfocus', 'onscroll', 'onscrollend', 'onscrolltop', 'onscrollbottom', 'onprepared', 'onstart', 'onpause', 'onfinish', 'onerror', 'ontimeupdate'].includes(name)) features.push(usage(`template.event.${name}`, span))
  if (name === 'if') {
    const expression = directiveExpression(attribute.value, attributeLocation, fullText, coordinates, limits, ErrorCodes.templateSyntaxError)
    features.push(usage('template.directive.if', span))
    return Object.freeze({ name, rawValue: attribute.value, span, directive: 'if', expression })
  }
  if (name === 'selected' && attribute.value.includes('{{')) {
    const expression = directiveExpression(attribute.value, attributeLocation, fullText, coordinates, limits, ErrorCodes.templateSyntaxError)
    return Object.freeze({ name, rawValue: attribute.value, span, expression })
  }
  if (name === 'for') {
    const match = /^\{\{\s*\(([$A-Z_a-z][$\w]*),\s*([$A-Z_a-z][$\w]*)\)\s+in\s+([\s\S]+?)\s*\}\}$/.exec(attribute.value)
    if (match === null || match[1] === match[2]) throw new FrontendIssue(ErrorCodes.templateForInvalid, 'for must use {{ (index, item) in expression }} with distinct aliases', span, 'Use the frozen V1 for directive shape.')
    const expressionText = match[3] ?? ''
    const valueOffset = fullText.indexOf(attribute.value, attributeLocation.startOffset)
    const expressionOffset = valueOffset + attribute.value.indexOf(expressionText)
    const expression = parseJavaScriptExpression(expressionText, coordinates, expressionOffset, limits)
    features.push(usage('template.directive.for-tid', span))
    return Object.freeze({ name, rawValue: attribute.value, span, directive: 'for', expression, forAliases: Object.freeze({ index: match[1] ?? '', item: match[2] ?? '' }) })
  }
  return Object.freeze({ name, rawValue: attribute.value, span })
}

function parseInterpolations(text: string, absoluteStart: number, coordinates: SourceCoordinateMap, limits: FrontendLimits): readonly ReturnType<typeof parseJavaScriptExpression>[] {
  const nodes: ReturnType<typeof parseJavaScriptExpression>[] = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor)
    if (open < 0) break
    const close = text.indexOf('}}', open + 2)
    if (close < 0 || text.indexOf('{{', open + 2) >= 0 && text.indexOf('{{', open + 2) < close) {
      throw issue(ErrorCodes.templateSyntaxError, 'Template interpolation is not closed or is nested', coordinates, absoluteStart + open, absoluteStart + text.length)
    }
    const raw = text.slice(open + 2, close)
    const leading = raw.length - raw.trimStart().length
    const expression = raw.trim()
    nodes.push(parseJavaScriptExpression(expression, coordinates, absoluteStart + open + 2 + leading, limits))
    cursor = close + 2
  }
  if (text.includes('}}', cursor)) throw issue(ErrorCodes.templateSyntaxError, 'Template interpolation has an unmatched closing delimiter', coordinates, absoluteStart + cursor, absoluteStart + text.length)
  return Object.freeze(nodes)
}

function directiveExpression(value: string, attributeLocation: HtmlLocation, fullText: string, coordinates: SourceCoordinateMap, limits: FrontendLimits, code: string) {
  const match = /^\{\{([\s\S]*)\}\}$/.exec(value)
  if (match === null || (match[1] ?? '').trim() === '') throw new FrontendIssue(code, 'Directive requires one {{ expression }} value', coordinates.span(attributeLocation.startOffset, attributeLocation.endOffset), 'Use one valid JavaScript expression.')
  const raw = match[1] ?? ''
  const expression = raw.trim()
  const valueOffset = fullText.indexOf(value, attributeLocation.startOffset)
  const expressionOffset = valueOffset + 2 + (raw.length - raw.trimStart().length)
  return parseJavaScriptExpression(expression, coordinates, expressionOffset, limits)
}

function validateFragmentAttributes(node: HtmlNode, name: string, coordinates: SourceCoordinateMap): void {
  for (const attribute of node.attrs ?? []) {
    if (name === 'style' && attribute.name === 'lang' && attribute.value === 'less') continue
    const range = location(node).attrs?.[attribute.name] ?? location(node)
    throw issue(ErrorCodes.uxFragmentInvalid, `Unsupported ${name} fragment attribute: ${attribute.name}`, coordinates, range.startOffset, range.endOffset)
  }
}

function contentRange(node: HtmlNode): { start: number; end: number } {
  const nodeLocation = location(node)
  return { start: nodeLocation.startTag?.endOffset ?? nodeLocation.startOffset, end: nodeLocation.endTag?.startOffset ?? nodeLocation.endOffset }
}

function location(node: HtmlNode): HtmlLocation {
  const nodeLocation = node.sourceCodeLocation
  if (nodeLocation === undefined || nodeLocation === null) return { startOffset: 0, endOffset: 0 }
  return nodeLocation
}

function usage(featureId: string, span: SourceSpan): FrontendFeatureUsage {
  return Object.freeze({ featureId, span })
}

function issue(code: string, message: string, coordinates: SourceCoordinateMap, start: number, end: number): FrontendIssue {
  return new FrontendIssue(code, message, coordinates.span(start, Math.max(start, end)), 'Fix the UX source before continuing the build.')
}
