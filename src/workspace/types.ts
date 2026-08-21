import type { JsonValue } from '../application/contracts.js'

export interface ConfigValue<T> {
  readonly value: T
  readonly source: 'default' | 'config' | 'request'
  readonly location?: string
}

export interface ResolvedWorkspaceConfig {
  readonly sourceRoot: ConfigValue<string>
  readonly outputRoot: ConfigValue<string>
  readonly cacheRoot: ConfigValue<string>
}

export interface ResolvedToolkitConfig {
  readonly schemaVersion: 1
  readonly workspace: ResolvedWorkspaceConfig
  readonly build: Readonly<Record<string, JsonValue>>
  readonly inspect: Readonly<Record<string, JsonValue>>
  readonly run: Readonly<Record<string, JsonValue>>
}

export interface WorkspaceOverrides {
  readonly sourceRoot?: string
  readonly outputRoot?: string
  readonly cacheRoot?: string
}

export interface SourceEntry {
  readonly logicalPath: string
  readonly kind: 'file' | 'directory'
  readonly byteLength?: number
}

export interface SourceUnit {
  readonly logicalPath: string
  readonly contentKind: 'bytes' | 'utf8'
  readonly bytes: Readonly<Uint8Array>
  readonly text?: string
  readonly byteLength: number
  readonly sha256: string
}

export interface ReadPolicy {
  readonly content: 'bytes' | 'strictUtf8'
  readonly maxBytes: number
}

export interface ListPolicy {
  readonly maxEntries: number
}

export interface WorkspaceContext {
  readonly root: string
  readonly logicalRoot: '.'
  readonly configPath?: string
  readonly sourceRoot: string
  readonly outputRoot: string
  readonly cacheRoot: string
  readonly manifestPath: string
  readonly manifest: SourceUnit
  readonly config: ResolvedToolkitConfig
}
