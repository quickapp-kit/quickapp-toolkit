import type { Diagnostic } from '../diagnostics/diagnostic.js'
import { assertRenderableResult } from './cli-diagnostic-result.js'
import type { RenderableResult, OutputFormat } from './types.js'

export interface RenderedOutput {
  readonly stdout: string
  readonly stderr: string
}

export function renderResult(result: RenderableResult, format: OutputFormat, color: boolean): RenderedOutput {
  assertRenderableResult(result)
  if (format === 'json') return { stdout: `${JSON.stringify(result)}\n`, stderr: '' }

  const diagnostics = result.diagnostics.map((diagnostic) => renderDiagnostic(diagnostic, color)).join('\n')
  if (result.status === 'success') {
    const data = humanData(result.data)
    return {
      stdout: `${data}\n`,
      stderr: diagnostics.length === 0 ? '' : `${diagnostics}\n`,
    }
  }
  return { stdout: '', stderr: diagnostics.length === 0 ? '' : `${diagnostics}\n` }
}

function humanData(data: unknown): string {
  if (typeof data === 'string') return data
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).kind === 'help' &&
    typeof (data as Record<string, unknown>).text === 'string'
  ) {
    return (data as Record<string, string>).text ?? ''
  }
  return JSON.stringify(data, null, 2)
}

function renderDiagnostic(diagnostic: Diagnostic, color: boolean): string {
  const location = diagnostic.file
    ? `${diagnostic.file}${diagnostic.range ? `:${diagnostic.range.start.line}:${diagnostic.range.start.column}` : ''}: `
    : ''
  const label = `${diagnostic.severity.toUpperCase()} ${diagnostic.code}`
  const renderedLabel = color ? colorize(diagnostic.severity, label) : label
  return `${location}${renderedLabel}: ${diagnostic.message}${diagnostic.hint ? `\n  hint: ${diagnostic.hint}` : ''}`
}

function colorize(severity: Diagnostic['severity'], text: string): string {
  const code = severity === 'error' ? 31 : severity === 'warning' ? 33 : 36
  return `\u001B[${code}m${text}\u001B[0m`
}
