import type { SourceSpan, SyntaxNode, SyntaxValue, TemplateAttributeSyntax, TemplateElementSyntax, TemplateTextSyntax } from '../frontend/types.js'
import type { CanonicalExpression, CanonicalModuleReference, CanonicalSourceLocation } from './types.js'

export function location(sourcePath: string, span: SourceSpan): CanonicalSourceLocation {
  return Object.freeze({ sourcePath, span })
}

export function nodeField(node: SyntaxNode, key: string): SyntaxNode | undefined {
  const value = node.fields[key]
  return isSyntaxNode(value) ? value : undefined
}

export function nodeArray(node: SyntaxNode, key: string): readonly SyntaxNode[] {
  const value = node.fields[key]
  return Array.isArray(value) ? value.filter(isSyntaxNode) : []
}

export function stringField(node: SyntaxNode, key: string): string | undefined {
  const value = node.fields[key]
  return typeof value === 'string' ? value : undefined
}

export function booleanField(node: SyntaxNode, key: string): boolean | undefined {
  const value = node.fields[key]
  return typeof value === 'boolean' ? value : undefined
}

export function isSyntaxNode(value: SyntaxValue | undefined): value is SyntaxNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as SyntaxNode
  return typeof candidate.type === 'string' && typeof candidate.span === 'object'
}

export function countSyntaxNodes(node: SyntaxNode): number {
  let count = 1
  for (const value of Object.values(node.fields)) {
    if (isSyntaxNode(value)) count += countSyntaxNodes(value)
    else if (Array.isArray(value)) for (const entry of value) if (isSyntaxNode(entry)) count += countSyntaxNodes(entry)
  }
  return count
}

export function collectIdentifiers(node: SyntaxNode): readonly string[] {
  const result = new Set<string>()
  walkSyntax(node, (current) => {
    if (current.type === 'Identifier') {
      const name = stringField(current, 'name')
      if (name !== undefined) result.add(name)
    }
  })
  return [...result].sort(compareUtf8)
}

export function walkSyntax(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node)
  for (const value of Object.values(node.fields)) {
    if (isSyntaxNode(value)) walkSyntax(value, visit)
    else if (Array.isArray(value)) for (const entry of value) if (isSyntaxNode(entry)) walkSyntax(entry, visit)
  }
}

export function defaultObjectProperties(program: SyntaxNode): readonly SyntaxNode[] {
  const body = nodeArray(program, 'body')
  const exportDefault = body.find((node) => node.type === 'ExportDefaultDeclaration')
  const declaration = exportDefault === undefined ? undefined : nodeField(exportDefault, 'declaration')
  if (declaration?.type !== 'ObjectExpression') return []
  return nodeArray(declaration, 'properties')
}

export function propertyName(property: SyntaxNode): string | undefined {
  const key = nodeField(property, 'key')
  if (key === undefined || booleanField(property, 'computed') === true) return undefined
  if (key.type === 'Identifier') return stringField(key, 'name')
  if (key.type === 'Literal') return stringField(key, 'value')
  return undefined
}

export function isCallableProperty(property: SyntaxNode): boolean {
  if (property.type !== 'Property') return false
  if (booleanField(property, 'method') === true) return true
  const value = nodeField(property, 'value')
  return value?.type === 'FunctionExpression' || value?.type === 'ArrowFunctionExpression'
}

export function buildMethodIndex(program: SyntaxNode): ReadonlyMap<string, SyntaxNode> {
  const output = new Map<string, SyntaxNode>()
  for (const property of defaultObjectProperties(program)) {
    if (property.type === 'SpreadElement') throw new Error('spread')
    const name = propertyName(property)
    if (name === undefined) {
      if (booleanField(property, 'computed') === true) throw new Error('computed')
      continue
    }
    if (!isCallableProperty(property)) continue
    if (output.has(name)) throw new Error(`duplicate:${name}`)
    output.set(name, property)
  }
  return output
}

export interface TextSegment {
  readonly literal: string
  readonly expression?: SyntaxNode
  readonly span: SourceSpan
}

export function textSegments(text: TemplateTextSyntax): readonly TextSegment[] {
  if (text.ignorableWhitespace) return []
  const segments: TextSegment[] = []
  const pattern = /\{\{([\s\S]*?)\}\}/g
  let cursor = 0
  let index = 0
  for (const match of text.value.matchAll(pattern)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const literal = text.value.slice(cursor, start)
    if (literal.length > 0) segments.push({ literal: normalizeNewlines(literal), span: text.span })
    const expression = text.interpolations[index]
    if (expression === undefined) throw new Error('interpolation-count')
    segments.push({ literal: '', expression, span: expression.span })
    cursor = end
    index += 1
  }
  const tail = text.value.slice(cursor)
  if (tail.length > 0) segments.push({ literal: normalizeNewlines(tail), span: text.span })
  if (index !== text.interpolations.length) throw new Error('interpolation-count')
  return Object.freeze(segments)
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

export function expression(sourcePath: string, ast: SyntaxNode, coercion: CanonicalExpression['coercion'], aliases: ReadonlySet<string>, stateSymbols: ReadonlySet<string>): CanonicalExpression {
  const identifiers = collectIdentifiers(ast)
  const lexicalBindings = identifiers.filter((name) => aliases.has(name))
  const stateBindings = identifiers.filter((name) => !aliases.has(name) && stateSymbols.has(name))
  return Object.freeze({ ast, coercion, lexicalBindings: Object.freeze(lexicalBindings), stateBindings: Object.freeze(stateBindings), source: location(sourcePath, ast.span) })
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right))
}

export function compareSpan(left: SourceSpan, right: SourceSpan): number {
  return left.startByte - right.startByte || left.endByte - right.endByte
}

export function referenceKey(reference: CanonicalModuleReference): string {
  return `${reference.kind}\0${reference.specifier}\0${reference.source.sourcePath}\0${reference.source.span.startByte}`
}

export function templateAttribute(element: TemplateElementSyntax, name: string): TemplateAttributeSyntax | undefined {
  return element.attributes.find((attribute) => attribute.name === name)
}

export function toDisplayString(value: unknown): string {
  if (value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new TypeError('Runtime value cannot be converted to a V1 display string')
}

export function assertDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
  const object = value as object
  if (seen.has(object)) return
  if (Object.prototype.toString.call(object) === '[object Map]' || Object.prototype.toString.call(object) === '[object Set]') {
    throw new TypeError('Mutable Map/Set is not a canonical immutable input')
  }
  if (!Object.isFrozen(object)) throw new TypeError('Canonical Lowering input is not deeply frozen')
  seen.add(object)
  if (isReadonlyMap(value)) {
    for (const [key, entry] of value) {
      assertDeepFrozen(key, seen)
      assertDeepFrozen(entry, seen)
    }
    return
  }
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor !== undefined && 'value' in descriptor) assertDeepFrozen(descriptor.value, seen)
  }
}

function isReadonlyMap(value: unknown): value is ReadonlyMap<unknown, unknown> {
  return typeof value === 'object' && value !== null && typeof (value as ReadonlyMap<unknown, unknown>).entries === 'function' && Object.prototype.toString.call(value) === '[object ImmutableMap]'
}
