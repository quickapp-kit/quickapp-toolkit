import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { ErrorCodes } from '../diagnostics/error-codes.js'
import type { ListPolicy, ReadPolicy, SourceEntry, SourceUnit } from './types.js'
import {
  isMissing,
  isWithin,
  toLogicalPath,
  validateLogicalPath,
  workspaceFault,
} from './path-utils.js'

interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
}

interface CachedSource {
  readonly logicalPath: string
  readonly bytes: Uint8Array
  readonly byteLength: number
  readonly sha256: string
  readonly identity: FileIdentity
  text?: string
}

export class SourceAccess {
  readonly #root: string
  readonly #excludedRoots: readonly string[]
  readonly #cache = new Map<string, CachedSource>()
  readonly #canonicalOwners = new Map<string, string>()
  #disposed = false

  constructor(root: string, excludedRoots: readonly string[]) {
    this.#root = root
    this.#excludedRoots = excludedRoots
  }

  async stat(logicalPath: string): Promise<SourceEntry> {
    const { canonical, identity, isDirectory } = await this.#resolveEntry(logicalPath)
    this.#claimCanonical(canonical, logicalPath)
    return {
      logicalPath,
      kind: isDirectory ? 'directory' : 'file',
      ...(isDirectory ? {} : { byteLength: Number(identity.size) }),
    }
  }

  async list(logicalDirectory: string, policy: ListPolicy): Promise<readonly SourceEntry[]> {
    this.#assertActive()
    validateLimit(policy.maxEntries, 'maxEntries')
    const { canonical, isDirectory } = await this.#resolveEntry(logicalDirectory)
    if (!isDirectory) {
      throw workspaceFault(ErrorCodes.sourceNotRegular, `Not a directory: ${logicalDirectory}`, logicalDirectory)
    }
    this.#claimCanonical(canonical, logicalDirectory)
    const dirents = await readdir(canonical, { withFileTypes: true })
    if (dirents.length > policy.maxEntries) {
      throw workspaceFault(
        ErrorCodes.sourceTooLarge,
        `Directory exceeds maxEntries=${policy.maxEntries}: ${logicalDirectory}`,
        logicalDirectory,
      )
    }

    const entries: SourceEntry[] = []
    for (const dirent of dirents) {
      const childLogical = `${logicalDirectory}/${dirent.name}`
      const childAbsolute = path.join(canonical, dirent.name)
      const childCanonical = await realpath(childAbsolute)
      if (this.#isExcluded(childCanonical)) continue
      if (!isWithin(this.#root, childCanonical)) {
        throw workspaceFault(ErrorCodes.workspacePathEscape, `Path escapes Workspace: ${childLogical}`, childLogical)
      }
      this.#claimCanonical(childCanonical, childLogical)
      const childStat = await stat(childCanonical, { bigint: true })
      if (!childStat.isFile() && !childStat.isDirectory()) {
        throw workspaceFault(ErrorCodes.sourceNotRegular, `Not a regular file or directory: ${childLogical}`, childLogical)
      }
      entries.push({
        logicalPath: childLogical,
        kind: childStat.isDirectory() ? 'directory' : 'file',
        ...(childStat.isFile() ? { byteLength: Number(childStat.size) } : {}),
      })
    }
    return entries.sort((left, right) => Buffer.from(left.logicalPath).compare(Buffer.from(right.logicalPath)))
  }

  async read(logicalPath: string, policy: ReadPolicy): Promise<SourceUnit> {
    this.#assertActive()
    validateLimit(policy.maxBytes, 'maxBytes')
    validateLogicalPath(logicalPath)
    const cached = this.#cache.get(logicalPath)
    if (cached) return this.#materialize(cached, policy)

    const { canonical, identity, isDirectory } = await this.#resolveEntry(logicalPath)
    if (isDirectory) {
      throw workspaceFault(ErrorCodes.sourceNotRegular, `Not a regular file: ${logicalPath}`, logicalPath)
    }
    if (identity.size > BigInt(policy.maxBytes)) {
      throw workspaceFault(
        ErrorCodes.sourceTooLarge,
        `Source exceeds maxBytes=${policy.maxBytes}: ${logicalPath}`,
        logicalPath,
      )
    }
    this.#claimCanonical(canonical, logicalPath)

    let content: Buffer
    try {
      content = await readFile(canonical)
    } catch (error) {
      throw workspaceFault(ErrorCodes.sourceReadFailed, `Cannot read source: ${logicalPath}`, logicalPath)
    }
    const after = await this.#identity(canonical)
    if (!sameIdentity(identity, after)) {
      throw workspaceFault(ErrorCodes.workspaceChanged, `Source changed while reading: ${logicalPath}`, logicalPath)
    }
    const source: CachedSource = {
      logicalPath,
      bytes: Uint8Array.from(content),
      byteLength: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      identity,
    }
    this.#cache.set(logicalPath, source)
    return this.#materialize(source, policy)
  }

  async verifyUnchanged(): Promise<void> {
    this.#assertActive()
    for (const source of this.#cache.values()) {
      const absolutePath = path.join(this.#root, ...source.logicalPath.split('/'))
      let identity: FileIdentity
      try {
        identity = await this.#identity(absolutePath)
      } catch (error) {
        throw workspaceFault(ErrorCodes.workspaceChanged, `Source was removed: ${source.logicalPath}`, source.logicalPath)
      }
      if (!sameIdentity(source.identity, identity)) {
        throw workspaceFault(ErrorCodes.workspaceChanged, `Source changed during operation: ${source.logicalPath}`, source.logicalPath)
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#cache.clear()
    this.#canonicalOwners.clear()
  }

  get disposed(): boolean {
    return this.#disposed
  }

  async #resolveEntry(logicalPath: string): Promise<{
    canonical: string
    identity: FileIdentity
    isDirectory: boolean
  }> {
    this.#assertActive()
    validateLogicalPath(logicalPath)
    const absolutePath = path.join(this.#root, ...logicalPath.split('/'))
    let canonical: string
    try {
      canonical = await realpath(absolutePath)
    } catch (error) {
      if (isMissing(error)) {
        throw workspaceFault(ErrorCodes.sourceNotFound, `Source not found: ${logicalPath}`, logicalPath)
      }
      throw workspaceFault(ErrorCodes.sourceReadFailed, `Cannot resolve source: ${logicalPath}`, logicalPath)
    }
    if (!isWithin(this.#root, canonical) || this.#isExcluded(canonical)) {
      throw workspaceFault(ErrorCodes.workspacePathEscape, `Path escapes allowed Workspace input: ${logicalPath}`, logicalPath)
    }
    const fileStat = await stat(canonical, { bigint: true })
    if (!fileStat.isFile() && !fileStat.isDirectory()) {
      throw workspaceFault(ErrorCodes.sourceNotRegular, `Not a regular file or directory: ${logicalPath}`, logicalPath)
    }
    return {
      canonical,
      identity: identityFromStat(fileStat),
      isDirectory: fileStat.isDirectory(),
    }
  }

  async #identity(absolutePath: string): Promise<FileIdentity> {
    const fileStat = await stat(absolutePath, { bigint: true })
    if (!fileStat.isFile()) throw new Error('Not a regular file')
    return identityFromStat(fileStat)
  }

  #claimCanonical(canonical: string, logicalPath: string): void {
    const owner = this.#canonicalOwners.get(canonical)
    if (owner && owner !== logicalPath) {
      throw workspaceFault(
        ErrorCodes.workspacePathConflict,
        `Logical paths resolve to the same source: ${owner}, ${logicalPath}`,
        logicalPath,
      )
    }
    this.#canonicalOwners.set(canonical, logicalPath)
  }

  #materialize(source: CachedSource, policy: ReadPolicy): SourceUnit {
    if (source.byteLength > policy.maxBytes) {
      throw workspaceFault(
        ErrorCodes.sourceTooLarge,
        `Source exceeds maxBytes=${policy.maxBytes}: ${source.logicalPath}`,
        source.logicalPath,
      )
    }
    if (policy.content === 'strictUtf8' && source.text === undefined) {
      try {
        source.text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)
      } catch (error) {
        throw workspaceFault(
          ErrorCodes.sourceInvalidUtf8,
          `Source is not valid UTF-8: ${source.logicalPath}`,
          source.logicalPath,
        )
      }
    }
    return {
      logicalPath: source.logicalPath,
      contentKind: policy.content === 'strictUtf8' ? 'utf8' : 'bytes',
      bytes: Uint8Array.from(source.bytes),
      ...(policy.content === 'strictUtf8' ? { text: source.text as string } : {}),
      byteLength: source.byteLength,
      sha256: source.sha256,
    }
  }

  #isExcluded(candidate: string): boolean {
    return this.#excludedRoots.some((root) => isWithin(root, candidate))
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('SourceAccess is disposed')
  }
}

function validateLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
}

function identityFromStat(fileStat: Awaited<ReturnType<typeof stat>> & { dev: bigint }): FileIdentity {
  const bigintStat = fileStat as unknown as {
    dev: bigint
    ino: bigint
    size: bigint
    mtimeNs: bigint
  }
  return {
    dev: bigintStat.dev,
    ino: bigintStat.ino,
    size: bigintStat.size,
    mtimeNs: bigintStat.mtimeNs,
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs
}

export function workspaceRelativePath(root: string, absolutePath: string): string {
  return toLogicalPath(root, absolutePath)
}
