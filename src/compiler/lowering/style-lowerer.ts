import type { CancellationToken } from '../../application/cancellation.js'
import { ErrorCodes } from '../../diagnostics/error-codes.js'
import type { ParsedSource, SourceSpan, StyleNodeSyntax } from '../frontend/types.js'
import type { GraphEdge, ResolvedAppModel } from '../module-graph/types.js'
import { LoweringBudget } from './budget.js'
import { LoweringIssue } from './lowering-issue.js'
import type { CanonicalLength, CanonicalStyle } from './types.js'

export interface StyleTarget {
  readonly sourcePath: string
  readonly span: SourceSpan
  readonly classes: readonly string[]
  readonly ancestors: readonly (readonly string[])[]
  style: CanonicalStyle
}

interface Selector {
  readonly compounds: readonly (readonly string[])[]
  readonly specificity: number
}

interface Declaration {
  readonly property: string
  readonly value: string
  readonly file: string
  readonly span: SourceSpan
  readonly selectors: readonly Selector[]
  readonly specificity: number
  readonly order: number
}

interface Mixin {
  readonly name: string
  readonly parameters: readonly string[]
  readonly declarations: readonly StyleNodeSyntax[]
  readonly file: string
  readonly span: SourceSpan
}

export interface StyleLoweringRequest {
  readonly ownerModuleId: string
  readonly rootSourcePath: string
  readonly rootSource: ParsedSource
  readonly model: ResolvedAppModel
  readonly parsedSources: ReadonlyMap<string, ParsedSource>
  readonly targets: readonly StyleTarget[]
  readonly budget: LoweringBudget
  readonly cancellation: CancellationToken
}

const HOST_PROPERTIES = new Set([
  'width', 'height', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'flex-direction', 'justify-content', 'align-items', 'background-color', 'color',
  'border-radius', 'font-size', 'text-align',
])

export function lowerStyles(request: StyleLoweringRequest): void {
  const resolver = new StyleResolver(request)
  const declarations: Declaration[] = []
  resolver.flattenRoot(declarations)
  const winners = new Map<StyleTarget, Map<string, Declaration>>()

  for (const declaration of declarations) {
    request.cancellation.throwIfCancelled()
    for (const target of request.targets) {
      request.budget.charge('selectorMatches', 1, declaration.file, declaration.span)
      if (!declaration.selectors.some((selector) => matches(selector, target))) continue
      const targetWinners = winners.get(target) ?? new Map<string, Declaration>()
      const previous = targetWinners.get(declaration.property)
      if (previous === undefined || declaration.specificity > previous.specificity ||
        declaration.specificity === previous.specificity && declaration.order > previous.order) {
        targetWinners.set(declaration.property, declaration)
      }
      winners.set(target, targetWinners)
    }
  }

  for (const target of request.targets) {
    request.cancellation.throwIfCancelled()
    const canonical: Record<string, unknown> = {}
    for (const [property, declaration] of winners.get(target) ?? []) {
      applyDeclaration(canonical, property, declaration.value, declaration.file, declaration.span, request.budget)
    }
    target.style = Object.freeze(canonical) as CanonicalStyle
  }
}

class StyleResolver {
  readonly #request: StyleLoweringRequest
  readonly #variables = new Map<string, string>()
  readonly #mixins = new Map<string, Mixin>()
  readonly #activeImports = new Set<string>()
  #order = 0

  constructor(request: StyleLoweringRequest) {
    this.#request = request
  }

  flattenRoot(output: Declaration[]): void {
    if (this.#request.rootSource.sourcePath !== this.#request.rootSourcePath) {
      this.fail(ErrorCodes.loweringInputInvalid, 'Style source identity does not match its path', this.#request.rootSourcePath, sourceSpan(this.#request.rootSource))
    }
    this.flattenNodes(this.#request.rootSourcePath, styleNodes(this.#request.rootSource), [], output)
  }

  flattenSource(sourcePath: string, source: ParsedSource, parents: readonly string[], output: Declaration[]): void {
    if (this.#activeImports.has(sourcePath)) {
      this.fail(ErrorCodes.loweringStyleEvaluationFailed, 'Style import cycle reached during Lowering: ' + sourcePath, sourcePath, sourceSpan(source))
    }
    this.#activeImports.add(sourcePath)
    this.flattenNodes(sourcePath, styleNodes(source), parents, output)
    this.#activeImports.delete(sourcePath)
  }

  flattenNodes(sourcePath: string, nodes: readonly StyleNodeSyntax[], parents: readonly string[], output: Declaration[]): void {
    for (const node of nodes) {
      this.#request.cancellation.throwIfCancelled()
      this.#request.budget.charge('workQueue', 1, sourcePath, node.span)
      if (node.type === 'atrule' && node.name === 'import') {
        const target = this.resolveImport(sourcePath, node)
        const parsed = this.#request.parsedSources.get(target)
        if (parsed === undefined) this.fail(ErrorCodes.loweringInputInvalid, 'Resolved Style source is missing: ' + target, sourcePath, node.span)
        this.#request.budget.charge('lessExpansionSteps', 1, sourcePath, node.span)
        this.flattenSource(target, parsed, parents, output)
        continue
      }
      if (isVariable(node)) {
        this.#variables.set(node.name as string, node.value ?? node.params ?? '')
        continue
      }
      if (node.type === 'rule' && node.selector !== undefined && isMixinSelector(node.selector)) {
        const mixin = parseMixin(node, sourcePath)
        this.#mixins.set(mixin.name, mixin)
        continue
      }
      if (node.type !== 'rule' || node.selector === undefined) {
        if (node.type === 'decl') this.fail(ErrorCodes.loweringStyleUnsupported, 'Declaration is outside a supported selector', sourcePath, node.span)
        if (node.type === 'atrule') this.fail(ErrorCodes.loweringStyleUnsupported, 'Unsupported style at-rule: @' + (node.name ?? ''), sourcePath, node.span)
        continue
      }
      const selectors = combineSelectors(parents, node.selector, sourcePath, node.span)
      this.flattenRule(sourcePath, node, selectors, output)
    }
  }

  flattenRule(sourcePath: string, node: StyleNodeSyntax, selectors: readonly string[], output: Declaration[]): void {
    const parsedSelectors = selectors.map((selector) => parseSelector(selector, sourcePath, node.span))
    this.#request.budget.charge('styleRules', 1, sourcePath, node.span)
    for (const child of node.children) {
      this.#request.cancellation.throwIfCancelled()
      this.#request.budget.charge('workQueue', 1, sourcePath, child.span)
      if (child.type === 'decl') {
        this.#request.budget.charge('styleDeclarations', 1, sourcePath, child.span)
        const property = child.property
        if (property === undefined || !HOST_PROPERTIES.has(property)) {
          this.fail(ErrorCodes.loweringStyleUnsupported, 'Unsupported Host Style property: ' + (property ?? ''), sourcePath, child.span)
        }
        output.push({
          property,
          value: this.resolveValue(child.value ?? '', sourcePath, child.span),
          file: sourcePath,
          span: child.span,
          selectors: parsedSelectors,
          specificity: Math.max(...parsedSelectors.map((item) => item.specificity)),
          order: this.#order++,
        })
        continue
      }
      if (child.type === 'atrule' && child.name !== undefined) {
        const mixin = this.#mixins.get(child.name)
        if (mixin === undefined) this.fail(ErrorCodes.loweringStyleEvaluationFailed, 'Unknown Style mixin: ' + child.name, sourcePath, child.span)
        this.#request.budget.charge('lessExpansionSteps', 1, sourcePath, child.span)
        const args = splitArguments(child.params ?? '', sourcePath, child.span)
        if (args.length !== mixin.parameters.length) this.fail(ErrorCodes.loweringStyleEvaluationFailed, 'Style mixin argument count is invalid', sourcePath, child.span)
        const saved = new Map(this.#variables)
        for (let index = 0; index < mixin.parameters.length; index += 1) {
          this.#variables.set(mixin.parameters[index] as string, args[index] as string)
        }
        for (const declaration of mixin.declarations) {
          this.#request.budget.charge('styleDeclarations', 1, sourcePath, declaration.span)
          const property = declaration.property
          if (property === undefined || !HOST_PROPERTIES.has(property)) {
            this.fail(ErrorCodes.loweringStyleUnsupported, 'Unsupported Host Style property in mixin', sourcePath, declaration.span)
          }
          output.push({
            property,
            value: this.resolveValue(declaration.value ?? '', sourcePath, declaration.span),
            file: sourcePath,
            span: declaration.span,
            selectors: parsedSelectors,
            specificity: Math.max(...parsedSelectors.map((item) => item.specificity)),
            order: this.#order++,
          })
        }
        this.#variables.clear()
        for (const [name, value] of saved) this.#variables.set(name, value)
        continue
      }
      if (child.type === 'rule' && child.selector !== undefined) {
        this.flattenRule(sourcePath, child, combineSelectors(selectors, child.selector, sourcePath, child.span), output)
        continue
      }
      this.fail(ErrorCodes.loweringStyleUnsupported, 'Unsupported nested Style node', sourcePath, child.span)
    }
  }

  resolveImport(sourcePath: string, node: StyleNodeSyntax): string {
    const specifier = node.params?.match(/^\s*['"]([^'"]+)['"]\s*$/)?.[1]
    if (specifier === undefined) this.fail(ErrorCodes.loweringStyleEvaluationFailed, 'Style import is not a literal', sourcePath, node.span)
    const matches = this.#request.model.graph.edges.filter((edge: GraphEdge) =>
      edge.fromModuleId === this.#request.ownerModuleId &&
      edge.kind === 'style' &&
      edge.specifier === specifier &&
      edge.references.some((reference) => reference.sourcePath === sourcePath))
    const targets = [...new Set(matches.map((edge) => edge.target))].sort(compareText)
    if (targets.length !== 1) this.fail(ErrorCodes.loweringInputInvalid, 'Style import has no unique resolved target: ' + specifier, sourcePath, node.span)
    return targets[0] as string
  }

  resolveValue(value: string, sourcePath: string, span: SourceSpan): string {
    let current = value.trim()
    for (let index = 0; index < 32 && /@[A-Za-z_][\w-]*/.test(current); index += 1) {
      this.#request.budget.charge('lessExpansionSteps', 1, sourcePath, span)
      current = current.replace(/@([A-Za-z_][\w-]*)/g, (_match, name: string) => {
        const replacement = this.#variables.get(name)
        if (replacement === undefined) this.fail(ErrorCodes.loweringStyleEvaluationFailed, 'Unresolved Less variable: @' + name, sourcePath, span)
        return replacement
      })
    }
    if (/@[A-Za-z_][\w-]*/.test(current)) this.fail(ErrorCodes.loweringStyleEvaluationFailed, 'Less variable expansion exceeded bounded depth', sourcePath, span)
    return evaluateArithmetic(current, sourcePath, span, this.#request.budget)
  }

  fail(code: string, message: string, file: string, span: SourceSpan): never {
    throw new LoweringIssue(code, message, file, span)
  }
}

function styleNodes(source: ParsedSource): readonly StyleNodeSyntax[] {
  if (source.sourceKind === 'style') return source.stylesheet
  if (source.sourceKind === 'pageUx') return source.style ?? []
  return []
}

function sourceSpan(source: ParsedSource): SourceSpan {
  if (source.sourceKind === 'pageUx' && source.template !== undefined) return source.template.root.span
  if (source.sourceKind === 'style') return source.stylesheet[0]?.span ?? emptySpan()
  return source.sourceKind === 'sharedJs' ? source.program.span : source.script.span
}

function emptySpan(): SourceSpan {
  return Object.freeze({ startByte: 0, endByte: 0, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } })
}

function isVariable(node: StyleNodeSyntax): boolean {
  return node.type === 'atrule' && node.name !== undefined && node.name !== 'import' &&
    node.children.length === 0 && node.value !== undefined && !node.name.includes('(')
}

function isMixinSelector(selector: string): boolean {
  return /^\s*\.[A-Za-z_][\w-]*\s*\([^)]*\)\s*$/.test(selector)
}

function parseMixin(node: StyleNodeSyntax, file: string): Mixin {
  const match = /^\s*\.([A-Za-z_][\w-]*)\s*\(([^)]*)\)\s*$/.exec(node.selector ?? '')
  if (match === null) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Invalid Less mixin declaration', file, node.span)
  const params = (match[2] ?? '').trim() === '' ? [] : (match[2] ?? '').split(',').map((item) => item.trim().replace(/^@/, ''))
  if (params.some((item) => !/^[A-Za-z_][\w-]*$/.test(item))) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Invalid Less mixin parameter', file, node.span)
  return Object.freeze({ name: match[1] as string, parameters: Object.freeze(params), declarations: node.children, file, span: node.span })
}

function combineSelectors(parents: readonly string[], childText: string, file: string, span: SourceSpan): readonly string[] {
  if (childText.includes('&')) throw new LoweringIssue(ErrorCodes.loweringStyleUnsupported, 'Selector parent replacement is not supported in V1', file, span)
  const children = splitSelectors(childText, file, span)
  if (parents.length === 0) return children
  return Object.freeze(parents.flatMap((parent) => children.map((child) => parent + ' ' + child)))
}

function splitSelectors(value: string, file: string, span: SourceSpan): readonly string[] {
  const selectors = value.split(',').map((item) => item.trim()).filter(Boolean)
  if (selectors.length === 0) throw new LoweringIssue(ErrorCodes.loweringStyleUnsupported, 'Empty selector is not supported', file, span)
  return Object.freeze(selectors)
}

function parseSelector(text: string, file: string, span: SourceSpan): Selector {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  const compounds = tokens.map((token) => {
    const classes = token.match(/\.[A-Za-z_][\w-]*/g)
    if (classes === null || classes.join('') !== token) throw new LoweringIssue(ErrorCodes.loweringStyleUnsupported, 'Unsupported V1 selector: ' + text, file, span)
    return Object.freeze(classes.map((item) => item.slice(1)))
  })
  return Object.freeze({ compounds: Object.freeze(compounds), specificity: compounds.reduce((sum, item) => sum + item.length, 0) })
}

function matches(selector: Selector, target: StyleTarget): boolean {
  const chain = [...target.ancestors, target.classes]
  let index = chain.length - 1
  for (let selectorIndex = selector.compounds.length - 1; selectorIndex >= 0; selectorIndex -= 1) {
    const compound = selector.compounds[selectorIndex] as readonly string[]
    let found = false
    for (; index >= 0; index -= 1) {
      if (compound.every((className) => (chain[index] as readonly string[]).includes(className))) {
        found = true
        index -= 1
        break
      }
    }
    if (!found) return false
  }
  return true
}

function splitArguments(value: string, file: string, span: SourceSpan): string[] {
  const trimmed = value.trim().replace(/^\(/, '').replace(/\)$/, '')
  if (trimmed === '') return []
  if (trimmed.includes('(') || trimmed.includes(')')) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Nested Less mixin arguments are not supported', file, span)
  return trimmed.split(',').map((item) => item.trim())
}

function evaluateArithmetic(raw: string, file: string, span: SourceSpan, budget: LoweringBudget): string {
  const value = raw.trim()
  const parts = value.split(/\s+/)
  if (parts.length === 1) return value
  if (parts.length !== 3 || !['+', '-', '*', '/'].includes(parts[1] as string)) return value
  budget.charge('lessExpansionSteps', 1, file, span)
  const left = operand(parts[0] as string)
  const right = operand(parts[2] as string)
  if (left === undefined || right === undefined) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Invalid Less arithmetic: ' + raw, file, span)
  const operator = parts[1]
  if ((operator === '*' || operator === '/') && left.unit !== '' && right.unit !== '') throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Less arithmetic combines two units', file, span)
  if (operator === '/' && right.value === 0) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Less arithmetic divides by zero', file, span)
  const result = operator === '+' ? left.value + right.value : operator === '-' ? left.value - right.value : operator === '*' ? left.value * right.value : left.value / right.value
  const unit = left.unit || right.unit
  if (!Number.isFinite(result)) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Less arithmetic is not finite', file, span)
  return String(result) + unit
}

function operand(value: string): { readonly value: number; readonly unit: '' | 'px' | '%' } | undefined {
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|%)?$/.exec(value)
  if (match === null) return undefined
  return { value: Number(match[1]), unit: (match[2] ?? '') as '' | 'px' | '%' }
}

function applyDeclaration(output: Record<string, unknown>, property: string, value: string, file: string, span: SourceSpan, budget: LoweringBudget): void {
  switch (property) {
    case 'width':
    case 'height':
      output[property] = length(value, file, span, false)
      return
    case 'margin': {
      const values = expandFour(splitLengthList(value, file, span, budget), file, span)
      output.marginTop = length(values[0] as string, file, span, true)
      output.marginRight = length(values[1] as string, file, span, true)
      output.marginBottom = length(values[2] as string, file, span, true)
      output.marginLeft = length(values[3] as string, file, span, true)
      return
    }
    case 'margin-top': output.marginTop = length(value, file, span, true); return
    case 'margin-right': output.marginRight = length(value, file, span, true); return
    case 'margin-bottom': output.marginBottom = length(value, file, span, true); return
    case 'margin-left': output.marginLeft = length(value, file, span, true); return
    case 'flex-direction': output.flexDirection = enumValue(value, ['row', 'column'], file, span); return
    case 'justify-content': output.justifyContent = enumValue(value, ['flex-start', 'center', 'flex-end', 'space-between'], file, span); return
    case 'align-items': output.alignItems = enumValue(value, ['flex-start', 'center', 'flex-end', 'stretch'], file, span); return
    case 'text-align': output.textAlign = enumValue(value, ['left', 'center', 'right'], file, span); return
    case 'background-color': output.backgroundColor = color(value, file, span); return
    case 'color': output.color = color(value, file, span); return
    case 'border-radius': output.borderRadius = scalarPx(value, file, span); return
    case 'font-size': output.fontSize = scalarPx(value, file, span); return
    default:
      budget.charge('styleDeclarations', 1, file, span)
      throw new LoweringIssue(ErrorCodes.loweringStyleUnsupported, 'Unsupported Host Style property: ' + property, file, span)
  }
}

function splitLengthList(value: string, file: string, span: SourceSpan, budget: LoweringBudget): string[] {
  const matches = value.match(/-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|%)?(?:\s*[+*/-]\s*-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|%)?)?/g)
  if (matches === null || matches.join('').replace(/\s/g, '') !== value.replace(/\s/g, '')) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Invalid margin shorthand: ' + value, file, span)
  return matches.map((item) => evaluateArithmetic(item, file, span, budget))
}

function expandFour(values: readonly string[], file: string, span: SourceSpan): [string, string, string, string] {
  if (values.length === 1) return [values[0] as string, values[0] as string, values[0] as string, values[0] as string]
  if (values.length === 2) return [values[0] as string, values[1] as string, values[0] as string, values[1] as string]
  if (values.length === 3) return [values[0] as string, values[1] as string, values[2] as string, values[1] as string]
  if (values.length === 4) return [values[0] as string, values[1] as string, values[2] as string, values[3] as string]
  throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Margin shorthand must have one to four values', file, span)
}

function length(value: string, file: string, span: SourceSpan, allowNegative: boolean): CanonicalLength {
  const item = operand(value)
  if (item === undefined || item.unit === '' && item.value !== 0 || !allowNegative && item.value < 0) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Invalid Host Length: ' + value, file, span)
  return Object.freeze({ value: item.value, unit: item.unit === '%' ? 'percent' : 'logical-px' })
}

function scalarPx(value: string, file: string, span: SourceSpan): number {
  const item = operand(value)
  if (item === undefined || item.unit === '%' || item.value < 0) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Invalid non-negative px value: ' + value, file, span)
  return item.value
}

function color(value: string, file: string, span: SourceSpan): string {
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Invalid V1 color: ' + value, file, span)
  return value.toUpperCase()
}

function enumValue<T extends string>(value: string, allowed: readonly T[], file: string, span: SourceSpan): T {
  if (!allowed.includes(value as T)) throw new LoweringIssue(ErrorCodes.loweringStyleEvaluationFailed, 'Invalid Host enum value: ' + value, file, span)
  return value as T
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right))
}
