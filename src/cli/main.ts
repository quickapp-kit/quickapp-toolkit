import { randomUUID } from 'node:crypto'
import { ErrorCodes } from '../diagnostics/error-codes.js'
import type { JsonValue } from '../application/contracts.js'
import type { CancellationToken } from '../application/cancellation.js'
import { ToolkitFault } from '../application/fault.js'
import type { InvocationContext } from '../application/use-case-ports.js'
import type { ToolkitApplicationService } from '../application/toolkit-application-service.js'
import { createDefaultCommandRegistry, cliFault, type CommandRegistry } from './command-registry.js'
import { assertCliDiagnosticResult } from './cli-diagnostic-result.js'
import { parseCommonOptions } from './common-options.js'
import { exitCodeFor } from './exit-code-mapper.js'
import { renderResult } from './result-renderer.js'
import type { CliDiagnosticResult, CliExecution, CliIo, OutputFormat, RenderableResult } from './types.js'

export const TOOLKIT_VERSION = '0.1.0'

export interface RunCliOptions {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly service: ToolkitApplicationService<JsonValue, unknown, JsonValue, unknown, JsonValue>
  readonly cancellation: CancellationToken
  readonly io: CliIo
  readonly registry?: CommandRegistry
  readonly noColorEnvironment?: boolean
  readonly createInvocationId?: () => `inv:${string}`
  readonly createRunId?: () => `run:${string}`
}

export async function runCli(options: RunCliOptions): Promise<CliExecution> {
  const registry = options.registry ?? createDefaultCommandRegistry()
  const invocationId = options.createInvocationId?.() ?? `inv:${randomUUID()}`
  const runId = options.createRunId?.() ?? `run:${randomUUID()}`
  let format: OutputFormat = detectRequestedFormat(options.argv)

  try {
    const first = options.argv[0]
    if (first === undefined || first === '--help') {
      options.io.writeStdout(topLevelHelp(registry))
      return { exitCode: 0 }
    }
    if (first === '--version') {
      options.io.writeStdout(`${TOOLKIT_VERSION}\n`)
      return { exitCode: 0 }
    }
    if (first.startsWith('-')) throw cliFault(ErrorCodes.cliUnknownCommand, `Unknown command: ${first}`)

    const contribution = registry.get(first)
    if (!contribution) throw cliFault(ErrorCodes.cliUnknownCommand, `Unknown command: ${first}`)
    const parsed = parseCommonOptions(options.argv.slice(1), options.noColorEnvironment ?? false)
    format = parsed.common.format
    if (parsed.common.help) {
      const result = helpResult(contribution.name, invocationId, contribution.usage)
      writeRendered(options.io, renderResult(result, format, parsed.common.color))
      return { exitCode: 0, result }
    }

    const request = contribution.parse(parsed.operationTokens, parsed.common)
    const context: InvocationContext = {
      invocationId,
      runId,
      cwd: options.cwd,
      cancellation: options.cancellation,
    }
    const result = await contribution.invoke(options.service, request, context)
    writeRendered(options.io, renderResult(result, format, parsed.common.color))
    return { exitCode: exitCodeFor(result, options.cancellation.reason), result }
  } catch (error) {
    const result = cliFailure(invocationId, error)
    try {
      writeRendered(options.io, renderResult(result, format, false))
    } catch {
      return { exitCode: 70, result }
    }
    return { exitCode: exitCodeFor(result), result }
  }
}

function cliFailure(invocationId: `inv:${string}`, error: unknown): CliDiagnosticResult {
  const diagnostic =
    error instanceof ToolkitFault
      ? error.diagnostic
      : {
          severity: 'error' as const,
          code: ErrorCodes.internalError,
          phase: 'internal',
          message: 'An internal Toolkit error occurred',
        }
  const result: CliDiagnosticResult = {
    schemaVersion: 1,
    kind: 'cliDiagnostic',
    status: 'failure',
    invocationId,
    failure: {
      kind: error instanceof ToolkitFault && error.kind === 'usage' ? 'usage' : 'internal',
      code: diagnostic.code,
    },
    diagnostics: [diagnostic],
  }
  assertCliDiagnosticResult(result)
  return result
}

function helpResult(
  operation: 'build' | 'inspect' | 'run',
  invocationId: `inv:${string}`,
  text: string,
): RenderableResult {
  return {
    schemaVersion: 1,
    operation,
    status: 'success',
    invocationId,
    data: { kind: 'help', text },
    diagnostics: [],
  }
}

function detectRequestedFormat(argv: readonly string[]): OutputFormat {
  const index = argv.lastIndexOf('--format')
  return index >= 0 && argv[index + 1] === 'json' ? 'json' : 'human'
}

function topLevelHelp(registry: CommandRegistry): string {
  const commands = registry.list().map((command) => `  ${command.name.padEnd(8)} ${command.summary}`).join('\n')
  return `Usage: quickapp <command> [options]\n\nCommands:\n${commands}\n\nOptions:\n  --help     Show help\n  --version  Show version\n`
}

function writeRendered(io: CliIo, output: { readonly stdout: string; readonly stderr: string }): void {
  if (output.stdout) io.writeStdout(output.stdout)
  if (output.stderr) io.writeStderr(output.stderr)
}
