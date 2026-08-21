import { ErrorCodes } from '../diagnostics/error-codes.js'
import { ToolkitFault } from '../application/fault.js'
import type { BuildRequest } from '../application/use-case-ports.js'
import type { CliCommandContribution } from './types.js'

export class CommandRegistry {
  readonly #commands = new Map<CliCommandContribution['name'], CliCommandContribution>()

  register(contribution: CliCommandContribution): void {
    if (this.#commands.has(contribution.name)) {
      throw new Error(`Duplicate command contribution: ${contribution.name}`)
    }
    this.#commands.set(contribution.name, contribution)
  }

  get(name: string): CliCommandContribution | undefined {
    return this.#commands.get(name as CliCommandContribution['name'])
  }

  list(): readonly CliCommandContribution[] {
    return [...this.#commands.values()].sort((left, right) => left.name.localeCompare(right.name))
  }
}

export interface CommandOverrides {
  readonly inspect?: CliCommandContribution
  readonly run?: CliCommandContribution
}

export function createDefaultCommandRegistry(overrides: CommandOverrides = {}): CommandRegistry {
  const registry = new CommandRegistry()
  registry.register(buildContribution)
  registry.register(overrides.inspect ?? reservedContribution('inspect'))
  registry.register(overrides.run ?? reservedContribution('run'))
  return registry
}

const buildContribution: CliCommandContribution = {
  name: 'build',
  summary: 'Build a QuickApp Kit Workspace',
  usage: 'quickapp build [workspace] [--config <path>] [--format <human|json>] [--no-color]',
  parse(tokens, common): BuildRequest {
    if (tokens.some((token) => token.startsWith('-'))) {
      throw cliFault(ErrorCodes.cliInvalidArgument, `Unknown build option: ${tokens.find((token) => token.startsWith('-'))}`)
    }
    if (tokens.length > 1) {
      throw cliFault(ErrorCodes.cliInvalidArgument, 'build accepts at most one Workspace path')
    }
    return {
      ...(tokens[0] === undefined ? {} : { workspace: tokens[0] }),
      ...(common.config === undefined ? {} : { config: common.config }),
    }
  },
  async invoke(service, request, context) {
    return service.build(request as BuildRequest, context)
  },
}

function reservedContribution(name: 'inspect' | 'run'): CliCommandContribution {
  return {
    name,
    summary: `${name} command contract is installed by TK-S08`,
    usage: `quickapp ${name} <TK-S08 operands> [common options]`,
    parse(tokens, common) {
      return { tokens: [...tokens], ...(common.config === undefined ? {} : { config: common.config }) }
    },
    async invoke(service, request, context) {
      return name === 'inspect' ? service.inspect(request, context) : service.run(request, context)
    },
  }
}

export function cliFault(code: string, message: string): ToolkitFault {
  return new ToolkitFault('usage', {
    severity: 'error',
    code,
    phase: 'cli',
    message,
  })
}
