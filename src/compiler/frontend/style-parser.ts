import postcss, { type Node as PostCssNode, type Root } from 'postcss'
import lessSyntax from 'postcss-less'
import { ErrorCodes } from '../../diagnostics/error-codes.js'
import { FrontendIssue } from './frontend-issue.js'
import { SourceCoordinateMap } from './source-coordinate-map.js'
import type {
  FrontendFeatureUsage,
  FrontendLimits,
  SourceSpan,
  StyleNodeSyntax,
  UnresolvedReference,
} from './types.js'

interface LocatedPostCssNode extends PostCssNode {
  readonly name?: string
  readonly selector?: string
  readonly prop?: string
  readonly value?: string
  readonly params?: string
  readonly nodes?: readonly LocatedPostCssNode[]
}

export interface StyleParseResult {
  readonly stylesheet: readonly StyleNodeSyntax[]
  readonly references: readonly UnresolvedReference[]
  readonly featureUsage: readonly FrontendFeatureUsage[]
}

export function parseStyle(
  text: string,
  sourcePath: string,
  coordinates: SourceCoordinateMap,
  baseOffset: number,
  limits: FrontendLimits,
  language: 'css' | 'less',
): StyleParseResult {
  let root: Root
  try {
    root = language === 'less'
      ? lessSyntax.parse(text, { from: sourcePath })
      : postcss.parse(text, { from: sourcePath })
  } catch (error) {
    const offset = postCssOffset(error, text)
    throw issue(ErrorCodes.styleSyntaxError, 'Style syntax is invalid', coordinates, baseOffset + offset, baseOffset + Math.min(text.length, offset + 1))
  }
  const references: UnresolvedReference[] = []
  const features: FrontendFeatureUsage[] = []
  let nodes = 0

  const normalize = (node: LocatedPostCssNode, depth: number): StyleNodeSyntax => {
    const span = postCssSpan(node, coordinates, baseOffset, text.length)
    nodes += 1
    if (nodes > limits.maxAstNodes || depth > limits.maxDepth) {
      throw new FrontendIssue(ErrorCodes.frontendLimitExceeded, 'Style syntax tree exceeds configured limits', span, 'Reduce stylesheet complexity or raise the explicit frontend limit.')
    }
    if (node.selector !== undefined && node.selector.length > limits.maxSelectorLength) {
      throw new FrontendIssue(ErrorCodes.frontendLimitExceeded, 'Selector exceeds configured length limit', span, 'Shorten the selector or raise the explicit frontend limit.')
    }
    rejectUnsupportedStyle(node, span)
    recordFeatures(node, span, language, features)
    if (node.type === 'atrule' && node.name === 'import') {
      const specifier = localStyleSpecifier(node.params ?? '')
      if (specifier === undefined) {
        throw new FrontendIssue(ErrorCodes.styleFeatureUnsupported, 'Style import must use one local literal path', span, 'Use a quoted relative @import path.')
      }
      references.push(Object.freeze({ kind: 'styleImport', ownerSourcePath: sourcePath, specifier, span }))
    }
    if (node.type === 'decl' && node.value !== undefined) {
      for (const found of findUrls(node.value)) {
        if (!found.local) {
          throw new FrontendIssue(ErrorCodes.styleFeatureUnsupported, 'Remote, data, or dynamic style URLs are not supported in V1', span, 'Use a quoted relative asset URL.')
        }
        references.push(Object.freeze({ kind: 'styleUrl', ownerSourcePath: sourcePath, specifier: found.value, span }))
      }
    }
    return Object.freeze({
      type: node.type,
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(node.selector === undefined ? {} : { selector: node.selector }),
      ...(node.prop === undefined ? {} : { property: node.prop }),
      ...(node.value === undefined ? {} : { value: node.value }),
      ...(node.params === undefined ? {} : { params: node.params }),
      span,
      children: Object.freeze((node.nodes ?? []).map((child) => normalize(child, depth + 1))),
    })
  }

  const stylesheet = Object.freeze((root.nodes as LocatedPostCssNode[]).map((node) => normalize(node, 1)))
  if (references.length > limits.maxReferences) {
    throw issue(ErrorCodes.frontendLimitExceeded, 'Style reference count exceeds configured limit', coordinates, baseOffset, baseOffset + text.length)
  }
  return { stylesheet, references: Object.freeze(references), featureUsage: Object.freeze(features) }
}

function rejectUnsupportedStyle(node: LocatedPostCssNode, span: SourceSpan): void {
  if (node.type === 'atrule' && (node.name === 'media' || node.name === 'keyframes')) {
    throw new FrontendIssue(ErrorCodes.styleFeatureUnsupported, `@${node.name} is not supported in V1`, span, 'Remove the unsupported style feature.')
  }
  if (node.type === 'decl' && node.prop !== undefined && (node.prop.startsWith('--') || node.prop === 'animation' || node.prop === 'animation-name')) {
    throw new FrontendIssue(ErrorCodes.styleFeatureUnsupported, `Style property ${node.prop} is not supported in V1`, span, 'Remove the unsupported style feature.')
  }
}

function recordFeatures(node: LocatedPostCssNode, span: SourceSpan, language: 'css' | 'less', output: FrontendFeatureUsage[]): void {
  if (node.type === 'rule') {
    output.push(usage('style.css-class/descendant-rule', span))
    if (language === 'less' && node.parent?.type === 'rule') output.push(usage('style.less-nested-selector', span))
    if (language === 'less' && node.selector?.includes('(')) output.push(usage('style.less-mixin-declare-call', span))
  }
  if (node.type === 'atrule' && node.name === 'import') output.push(usage('style.less-local-import', span))
  if (language === 'less' && node.type === 'atrule' && (node as LocatedPostCssNode & { variable?: boolean }).variable === true) output.push(usage('style.less-variable', span))
  if (language === 'less' && node.type === 'atrule' && (node as LocatedPostCssNode & { mixin?: boolean }).mixin === true) output.push(usage('style.less-mixin-declare-call', span))
  if (node.type === 'decl') {
    if (/[+*/-]\s*@?[a-z0-9.(]/i.test(node.value ?? '')) output.push(usage('style.less-arithmetic', span))
    if (node.prop !== undefined && /^(margin|padding|border|background|font)$/i.test(node.prop)) output.push(usage('style.css-shorthand', span))
  }
}

function localStyleSpecifier(params: string): string | undefined {
  const match = /^\s*(['"])(\.\.?\/[^'"{}]+)\1\s*$/.exec(params)
  return match?.[2]
}

function findUrls(value: string): readonly { value: string; local: boolean }[] {
  const results: Array<{ value: string; local: boolean }> = []
  const pattern = /url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi
  for (const match of value.matchAll(pattern)) {
    const candidate = match[2]?.trim() ?? ''
    results.push({ value: candidate, local: candidate.startsWith('.') && !candidate.includes('{') })
  }
  if (/url\(/i.test(value) && results.length === 0) results.push({ value: value, local: false })
  return results
}

function postCssSpan(node: PostCssNode, coordinates: SourceCoordinateMap, base: number, textLength: number): SourceSpan {
  const start = node.source?.start?.offset ?? 0
  const endInclusive = node.source?.end?.offset ?? start
  return coordinates.span(base + start, base + Math.min(textLength, endInclusive + 1))
}

function postCssOffset(error: unknown, text: string): number {
  if (typeof error !== 'object' || error === null) return text.length
  const input = (error as { input?: { offset?: unknown } }).input
  return typeof input?.offset === 'number' ? input.offset : text.length
}

function usage(featureId: string, span: SourceSpan): FrontendFeatureUsage {
  return Object.freeze({ featureId, span })
}

function issue(code: string, message: string, coordinates: SourceCoordinateMap, start: number, end: number): FrontendIssue {
  return new FrontendIssue(code, message, coordinates.span(start, Math.max(start, end)), 'Fix the stylesheet before continuing the build.')
}
