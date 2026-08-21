export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface SourcePosition {
  readonly line: number
  readonly column: number
}

export interface SourceRange {
  readonly start: SourcePosition
  readonly end: SourcePosition
}

export interface Diagnostic {
  readonly severity: DiagnosticSeverity
  readonly code: string
  readonly phase: string
  readonly message: string
  readonly file?: string
  readonly range?: SourceRange
  readonly hint?: string
}

const PHASE_ORDER = new Map([
  ['cli', 0],
  ['workspace', 1],
  ['config', 2],
  ['build', 3],
  ['inspect', 4],
  ['run', 5],
  ['internal', 6],
])

function compareText(left: string | undefined, right: string | undefined): number {
  return Buffer.from(left ?? '').compare(Buffer.from(right ?? ''))
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics
    .map((diagnostic, sequence) => ({ diagnostic, sequence }))
    .sort((left, right) => {
      const phase =
        (PHASE_ORDER.get(left.diagnostic.phase) ?? 100) -
        (PHASE_ORDER.get(right.diagnostic.phase) ?? 100)
      if (phase !== 0) return phase

      const file = compareText(left.diagnostic.file, right.diagnostic.file)
      if (file !== 0) return file

      const leftLine = left.diagnostic.range?.start.line ?? 0
      const rightLine = right.diagnostic.range?.start.line ?? 0
      if (leftLine !== rightLine) return leftLine - rightLine

      const leftColumn = left.diagnostic.range?.start.column ?? 0
      const rightColumn = right.diagnostic.range?.start.column ?? 0
      if (leftColumn !== rightColumn) return leftColumn - rightColumn

      const code = compareText(left.diagnostic.code, right.diagnostic.code)
      return code !== 0 ? code : left.sequence - right.sequence
    })
    .map(({ diagnostic }) => diagnostic)
}

export class DiagnosticCollector {
  readonly #diagnostics: Diagnostic[] = []

  add(diagnostic: Diagnostic): void {
    this.#diagnostics.push(diagnostic)
  }

  addAll(diagnostics: readonly Diagnostic[]): void {
    this.#diagnostics.push(...diagnostics)
  }

  snapshot(): readonly Diagnostic[] {
    return sortDiagnostics(this.#diagnostics)
  }
}
