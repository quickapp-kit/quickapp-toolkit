import { parse, parseExpressionAt, type Node as AcornNode, type Token } from 'acorn'
import { ErrorCodes } from '../../diagnostics/error-codes.js'
import { FrontendIssue } from './frontend-issue.js'
import { SourceCoordinateMap } from './source-coordinate-map.js'
import { SyntaxNormalizer } from './syntax-normalizer.js'
import type {
  FrontendFeatureUsage,
  FrontendLimits,
  SourceSpan,
  SyntaxNode,
  UnresolvedReference,
} from './types.js'

interface AstNode {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly [key: string]: unknown
}

export interface JavaScriptParseResult {
  readonly syntax: SyntaxNode
  readonly references: readonly UnresolvedReference[]
  readonly featureUsage: readonly FrontendFeatureUsage[]
}

export function parseJavaScript(
  text: string,
  sourcePath: string,
  coordinates: SourceCoordinateMap,
  baseOffset: number,
  limits: FrontendLimits,
  requireDefaultExport: boolean,
): JavaScriptParseResult {
  const comments: Array<{ type: string; value: string; start: number; end: number }> = []
  const tokens: Token[] = []
  let program: AcornNode
  try {
    program = parse(text, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: false,
      locations: false,
      onComment: (block, value, start, end) => comments.push({ type: block ? 'BlockComment' : 'LineComment', value, start, end }),
      onToken: tokens,
    })
  } catch (error) {
    const offset = parserOffset(error, text.length)
    throw issue(ErrorCodes.scriptSyntaxError, 'JavaScript syntax is invalid', coordinates, baseOffset + offset, baseOffset + Math.min(text.length, offset + 1))
  }
  if (tokens.length > limits.maxTokens) {
    throw issue(ErrorCodes.frontendLimitExceeded, 'JavaScript token count exceeds configured limit', coordinates, baseOffset, baseOffset + text.length)
  }

  const root = program as AstNode
  if (requireDefaultExport && countNodes(root, 'ExportDefaultDeclaration') !== 1) {
    throw issue(
      ErrorCodes.scriptDefaultExportRequired,
      'App and Page scripts require exactly one export default declaration',
      coordinates,
      baseOffset,
      baseOffset + text.length,
    )
  }

  const references: UnresolvedReference[] = []
  const features: FrontendFeatureUsage[] = []
  walk(root, (node) => {
    if (node.type === 'ExportDefaultDeclaration') features.push(usage('script.es-import-export-default', spanFor(node, coordinates, baseOffset)))
    if (['Property', 'ArrowFunctionExpression', 'AssignmentPattern', 'TemplateLiteral'].includes(node.type)) {
      features.push(usage('script.object-method/arrow/default-param/template-literal', spanFor(node, coordinates, baseOffset)))
    }
    if (node.type === 'ForInStatement' || node.type === 'AwaitExpression' || node.type === 'NewExpression' && isIdentifierNamed(node.callee, 'Promise')) {
      features.push(usage('script.promise/prototype-member/for-in', spanFor(node, coordinates, baseOffset)))
    }
    if (node.type === 'ImportExpression') {
      throw issue(ErrorCodes.scriptModuleReferenceUnsupported, 'Dynamic import is not supported in V1', coordinates, baseOffset + node.start, baseOffset + node.end)
    }
    if (node.type === 'ImportDeclaration') {
      const source = node.source
      const specifier = literalString(source)
      if (specifier === undefined) {
        throw issue(ErrorCodes.scriptModuleReferenceUnsupported, 'Import source must be a string literal', coordinates, baseOffset + node.start, baseOffset + node.end)
      }
      references.push(referenceFor(specifier, 'scriptImport', sourcePath, spanFor(source, coordinates, baseOffset)))
      features.push(usage('script.es-import-export-default', spanFor(node, coordinates, baseOffset)))
    }
    if (node.type !== 'CallExpression') return
    const callee = node.callee as AstNode | undefined
    const args = Array.isArray(node.arguments) ? node.arguments : []
    if (callee?.type === 'Identifier' && callee.name === 'require') {
      const specifier = literalString(args[0])
      if (specifier === undefined || args.length !== 1) {
        throw issue(ErrorCodes.scriptModuleReferenceUnsupported, 'require() requires one string literal', coordinates, baseOffset + node.start, baseOffset + node.end)
      }
      references.push(referenceFor(specifier, 'scriptRequire', sourcePath, spanFor(args[0], coordinates, baseOffset)))
      features.push(usage('script.commonjs-require-literal', spanFor(node, coordinates, baseOffset)))
      return
    }
    if (isRequireContext(callee)) {
      const directory = literalString(args[0])
      const recursive = literalBoolean(args[1])
      const regexp = regexpLiteral(args[2])
      if (directory === undefined || recursive === undefined || regexp === undefined || args.length !== 3) {
        throw issue(ErrorCodes.scriptModuleReferenceUnsupported, 'require.context() requires literal directory, boolean and RegExp arguments', coordinates, baseOffset + node.start, baseOffset + node.end)
      }
      references.push(Object.freeze({
        kind: 'scriptContext',
        ownerSourcePath: sourcePath,
        specifier: directory,
        span: spanFor(node, coordinates, baseOffset),
        context: Object.freeze({ recursive, regexpSource: regexp.pattern, regexpFlags: regexp.flags }),
      }))
      features.push(usage('script.require-context-literal', spanFor(node, coordinates, baseOffset)))
    }
  })

  if (references.length > limits.maxReferences) {
    throw issue(ErrorCodes.frontendLimitExceeded, 'JavaScript reference count exceeds configured limit', coordinates, baseOffset, baseOffset + text.length)
  }
  validateSpecifiers(references, coordinates, baseOffset, text.length)

  if (containsIdentifier(root, 'global')) features.push(usage('script.global-injection', spanFor(root, coordinates, baseOffset)))
  const normalizer = new SyntaxNormalizer(coordinates, baseOffset, limits)
  const normalized = normalizer.normalize(program)
  const commentNodes = comments.map((comment) => normalizer.synthetic(comment.type, comment.start, comment.end, { value: comment.value }))
  const tokenNodes = tokens.map((token) => normalizer.synthetic('Token', token.start, token.end, {
    label: token.type.label,
    ...((token as Token & { value?: unknown }).value === undefined ? {} : { value: String((token as Token & { value?: unknown }).value) }),
  }))
  return {
    syntax: Object.freeze({
      ...normalized,
      fields: Object.freeze({ ...normalized.fields, comments: Object.freeze(commentNodes), tokens: Object.freeze(tokenNodes) }),
    }),
    references: Object.freeze(references),
    featureUsage: Object.freeze(features),
  }
}

export function parseJavaScriptExpression(
  expression: string,
  coordinates: SourceCoordinateMap,
  absoluteStart: number,
  limits: FrontendLimits,
): SyntaxNode {
  if (expression.length === 0 || expression.length > limits.maxExpressionLength) {
    throw issue(expression.length === 0 ? ErrorCodes.templateSyntaxError : ErrorCodes.frontendLimitExceeded, 'Template expression is empty or exceeds configured limit', coordinates, absoluteStart, absoluteStart + expression.length)
  }
  let node: AcornNode
  try {
    node = parseExpressionAt(expression, 0, { ecmaVersion: 'latest' })
  } catch (error) {
    const offset = parserOffset(error, expression.length)
    throw issue(ErrorCodes.templateSyntaxError, 'Template expression is invalid', coordinates, absoluteStart + offset, absoluteStart + Math.min(expression.length, offset + 1))
  }
  const end = (node as AstNode).end
  if (expression.slice(end).trim().length > 0) {
    throw issue(ErrorCodes.templateSyntaxError, 'Template expression contains trailing syntax', coordinates, absoluteStart + end, absoluteStart + expression.length)
  }
  return new SyntaxNormalizer(coordinates, absoluteStart, limits).normalize(node)
}

function referenceFor(specifier: string, kind: 'scriptImport' | 'scriptRequire', ownerSourcePath: string, span: SourceSpan): UnresolvedReference {
  return Object.freeze({
    kind: specifier.startsWith('@system.') ? 'capability' : kind,
    ownerSourcePath,
    specifier,
    span,
  })
}

function validateSpecifiers(references: readonly UnresolvedReference[], coordinates: SourceCoordinateMap, base: number, length: number): void {
  for (const reference of references) {
    if (reference.kind === 'scriptContext') {
      if (!reference.specifier.startsWith('.')) throw issue(ErrorCodes.scriptModuleReferenceUnsupported, 'Context directory must be relative', coordinates, base, base + length)
      continue
    }
    if (reference.kind === 'capability') continue
    if (!reference.specifier.startsWith('.') || reference.specifier.includes('\\') || /^[a-z]+:/i.test(reference.specifier)) {
      throw new FrontendIssue(
        ErrorCodes.scriptModuleReferenceUnsupported,
        `Unsupported module specifier: ${reference.specifier}`,
        reference.span,
        'Use a relative module path or a declared @system capability.',
      )
    }
  }
}

function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit)
    return
  }
  if (!isAstNode(value)) return
  visit(value)
  for (const [key, child] of Object.entries(value)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue
    walk(child, visit)
  }
}

function countNodes(root: AstNode, type: string): number {
  let count = 0
  walk(root, (node) => { if (node.type === type) count += 1 })
  return count
}

function containsIdentifier(root: AstNode, name: string): boolean {
  let found = false
  walk(root, (node) => { if (node.type === 'Identifier' && node.name === name) found = true })
  return found
}

function isRequireContext(node: AstNode | undefined): boolean {
  if (node?.type !== 'MemberExpression' || node.computed === true) return false
  const object = node.object as AstNode | undefined
  const property = node.property as AstNode | undefined
  return object?.type === 'Identifier' && object.name === 'require' && property?.type === 'Identifier' && property.name === 'context'
}

function isIdentifierNamed(value: unknown, name: string): boolean {
  return isAstNode(value) && value.type === 'Identifier' && value.name === name
}

function literalString(value: unknown): string | undefined {
  return isAstNode(value) && value.type === 'Literal' && typeof value.value === 'string' ? value.value : undefined
}

function literalBoolean(value: unknown): boolean | undefined {
  return isAstNode(value) && value.type === 'Literal' && typeof value.value === 'boolean' ? value.value : undefined
}

function regexpLiteral(value: unknown): { pattern: string; flags: string } | undefined {
  if (!isAstNode(value) || value.type !== 'Literal' || typeof value.regex !== 'object' || value.regex === null) return undefined
  const regex = value.regex as { pattern?: unknown; flags?: unknown }
  return typeof regex.pattern === 'string' && typeof regex.flags === 'string' ? { pattern: regex.pattern, flags: regex.flags } : undefined
}

function spanFor(value: unknown, coordinates: SourceCoordinateMap, baseOffset: number): SourceSpan {
  if (!isAstNode(value)) return coordinates.span(baseOffset, baseOffset)
  return coordinates.span(baseOffset + value.start, baseOffset + value.end)
}

function usage(featureId: string, span: SourceSpan): FrontendFeatureUsage {
  return Object.freeze({ featureId, span })
}

function isAstNode(value: unknown): value is AstNode {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<AstNode>
  return typeof candidate.type === 'string' && typeof candidate.start === 'number' && typeof candidate.end === 'number'
}

function parserOffset(error: unknown, fallback: number): number {
  if (typeof error !== 'object' || error === null) return fallback
  const position = (error as { pos?: unknown }).pos
  return typeof position === 'number' ? position : fallback
}

function issue(code: string, message: string, coordinates: SourceCoordinateMap, start: number, end: number): FrontendIssue {
  return new FrontendIssue(code, message, coordinates.span(start, Math.max(start, end)), 'Fix the source syntax before continuing the build.')
}
