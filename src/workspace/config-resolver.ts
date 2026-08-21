import path from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import type { JsonValue } from '../application/contracts.js'
import { ErrorCodes } from '../diagnostics/error-codes.js'
import type {
  ConfigValue,
  ResolvedToolkitConfig,
  WorkspaceOverrides,
} from './types.js'
import { configFault, isMissing, isRegularFile, isWithin, toLogicalPath } from './path-utils.js'

export type ConfigSectionValidator = (
  value: Readonly<Record<string, unknown>>,
  section: 'build' | 'inspect' | 'run',
) => Readonly<Record<string, JsonValue>>

export interface ConfigResolverOptions {
  readonly root: string
  readonly cwd: string
  readonly explicitConfig?: string
  readonly overrides?: WorkspaceOverrides
  readonly sectionValidators?: Partial<Record<'build' | 'inspect' | 'run', ConfigSectionValidator>>
}

interface RawConfig {
  readonly schemaVersion: 1
  readonly workspace?: Readonly<Record<string, unknown>>
  readonly build?: Readonly<Record<string, unknown>>
  readonly inspect?: Readonly<Record<string, unknown>>
  readonly run?: Readonly<Record<string, unknown>>
}

const DEFAULTS = {
  sourceRoot: 'src',
  outputRoot: 'dist',
  cacheRoot: '.quickapp-kit/cache',
} as const

export interface ConfigResolution {
  readonly path?: string
  readonly config: ResolvedToolkitConfig
}

export async function resolveConfig(options: ConfigResolverOptions): Promise<ConfigResolution> {
  const configPath = await chooseConfigPath(options)
  const raw = configPath ? await parseConfig(options.root, configPath) : undefined
  const workspace = raw?.workspace ?? {}
  rejectUnknown(workspace, new Set(['sourceRoot', 'outputRoot', 'cacheRoot']), 'workspace')

  const configLogicalPath = configPath ? toLogicalPath(options.root, configPath) : undefined
  const sourceRoot = configValue(
    'sourceRoot',
    DEFAULTS.sourceRoot,
    workspace.sourceRoot,
    options.overrides?.sourceRoot,
    configLogicalPath,
  )
  const outputRoot = configValue(
    'outputRoot',
    DEFAULTS.outputRoot,
    workspace.outputRoot,
    options.overrides?.outputRoot,
    configLogicalPath,
  )
  const cacheRoot = configValue(
    'cacheRoot',
    DEFAULTS.cacheRoot,
    workspace.cacheRoot,
    options.overrides?.cacheRoot,
    configLogicalPath,
  )

  return {
    ...(configPath === undefined ? {} : { path: configPath }),
    config: {
      schemaVersion: 1,
      workspace: { sourceRoot, outputRoot, cacheRoot },
      build: validateSection('build', raw?.build, options.sectionValidators?.build),
      inspect: validateSection('inspect', raw?.inspect, options.sectionValidators?.inspect),
      run: validateSection('run', raw?.run, options.sectionValidators?.run),
    },
  }
}

async function chooseConfigPath(options: ConfigResolverOptions): Promise<string | undefined> {
  if (options.explicitConfig) {
    const input = path.resolve(options.cwd, options.explicitConfig)
    let canonical: string
    try {
      canonical = await realpath(input)
    } catch (error) {
      if (isMissing(error)) {
        throw configFault(ErrorCodes.configNotFound, `Configuration file not found: ${options.explicitConfig}`)
      }
      throw configFault(ErrorCodes.configInvalidValue, `Cannot resolve configuration: ${options.explicitConfig}`)
    }
    if (!isWithin(options.root, canonical)) {
      throw configFault(ErrorCodes.configInvalidValue, 'Configuration file must be inside the Workspace')
    }
    if (!(await isRegularFile(canonical))) {
      throw configFault(ErrorCodes.configInvalidValue, 'Configuration path must be a regular file')
    }
    return canonical
  }

  const defaultPath = path.join(options.root, 'quickapp.config.json')
  return (await isRegularFile(defaultPath)) ? await realpath(defaultPath) : undefined
}

async function parseConfig(root: string, configPath: string): Promise<RawConfig> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    throw configFault(
      ErrorCodes.configInvalidJson,
      'Configuration must be valid JSON',
      toLogicalPath(root, configPath),
    )
  }
  if (!isRecord(value)) {
    throw configFault(ErrorCodes.configInvalidValue, 'Configuration root must be an object')
  }
  rejectUnknown(value, new Set(['schemaVersion', 'workspace', 'build', 'inspect', 'run']), 'root')
  if (value.schemaVersion !== 1) {
    throw configFault(
      ErrorCodes.configVersionUnsupported,
      `Unsupported configuration schemaVersion: ${String(value.schemaVersion)}`,
      toLogicalPath(root, configPath),
    )
  }
  for (const key of ['workspace', 'build', 'inspect', 'run'] as const) {
    if (value[key] !== undefined && !isRecord(value[key])) {
      throw configFault(ErrorCodes.configInvalidValue, `Configuration ${key} must be an object`)
    }
  }
  return value as unknown as RawConfig
}

function configValue(
  name: string,
  defaultValue: string,
  configured: unknown,
  override: string | undefined,
  configPath: string | undefined,
): ConfigValue<string> {
  if (override !== undefined) return { value: validateRelativePath(name, override), source: 'request' }
  if (configured !== undefined) {
    if (typeof configured !== 'string') {
      throw configFault(ErrorCodes.configInvalidValue, `workspace.${name} must be a string`, configPath)
    }
    return {
      value: validateRelativePath(name, configured),
      source: 'config',
      ...(configPath === undefined ? {} : { location: `${configPath}#/workspace/${name}` }),
    }
  }
  return { value: defaultValue, source: 'default' }
}

function validateRelativePath(name: string, value: string): string {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw configFault(ErrorCodes.configInvalidValue, `workspace.${name} must be a safe relative path`)
  }
  return value
}

function validateSection(
  name: 'build' | 'inspect' | 'run',
  section: Readonly<Record<string, unknown>> | undefined,
  validator: ConfigSectionValidator | undefined,
): Readonly<Record<string, JsonValue>> {
  const value = section ?? {}
  if (validator) return validator(value, name)
  const unknown = Object.keys(value)
  if (unknown.length > 0) {
    throw configFault(ErrorCodes.configUnknownField, `No owner is installed for ${name}.${unknown[0]}`)
  }
  return {}
}

function rejectUnknown(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, scope: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort()[0]
  if (unknown) throw configFault(ErrorCodes.configUnknownField, `Unknown configuration field: ${scope}.${unknown}`)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
