import { ErrorCodes } from '../diagnostics/error-codes.js'
import { cliFault } from './command-registry.js'
import type { CommonOptions, OutputFormat } from './types.js'

export interface ParsedCommonOptions {
  readonly common: CommonOptions
  readonly operationTokens: readonly string[]
}

export function parseCommonOptions(tokens: readonly string[], noColorEnvironment: boolean): ParsedCommonOptions {
  let config: string | undefined
  let format: OutputFormat = 'human'
  let color = !noColorEnvironment
  let help = false
  let optionsEnded = false
  const seen = new Set<string>()
  const operationTokens: string[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (optionsEnded) {
      operationTokens.push(token)
      continue
    }
    if (token === '--') {
      optionsEnded = true
      continue
    }
    if (token === '--config' || token === '--format') {
      assertSingle(seen, token)
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw cliFault(ErrorCodes.cliMissingArgument, `${token} requires a value`)
      }
      index += 1
      if (token === '--config') config = value
      else if (value === 'human' || value === 'json') format = value
      else throw cliFault(ErrorCodes.cliInvalidArgument, `Invalid --format: ${value}`)
      continue
    }
    if (token === '--no-color' || token === '--help') {
      assertSingle(seen, token)
      if (token === '--no-color') color = false
      else help = true
      continue
    }
    operationTokens.push(token)
  }

  return {
    common: {
      ...(config === undefined ? {} : { config }),
      format,
      color,
      help,
    },
    operationTokens,
  }
}

function assertSingle(seen: Set<string>, option: string): void {
  if (seen.has(option)) {
    throw cliFault(ErrorCodes.cliConflictingOption, `Option may only be specified once: ${option}`)
  }
  seen.add(option)
}
