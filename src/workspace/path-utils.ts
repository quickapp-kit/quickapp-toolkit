import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { ErrorCodes } from '../diagnostics/error-codes.js'
import { ToolkitFault } from '../application/fault.js'

export function workspaceFault(code: string, message: string, file?: string): ToolkitFault {
  return new ToolkitFault('workspace', {
    severity: 'error',
    code,
    phase: 'workspace',
    message,
    ...(file === undefined ? {} : { file }),
  })
}

export function configFault(code: string, message: string, file?: string): ToolkitFault {
  return new ToolkitFault('config', {
    severity: 'error',
    code,
    phase: 'config',
    message,
    ...(file === undefined ? {} : { file }),
  })
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function toLogicalPath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/')
}

export function validateLogicalPath(logicalPath: string): void {
  if (
    logicalPath.length === 0 ||
    logicalPath.includes('\\') ||
    logicalPath.includes('\0') ||
    path.posix.isAbsolute(logicalPath)
  ) {
    throw workspaceFault(ErrorCodes.workspacePathEscape, `Invalid logical path: ${logicalPath}`)
  }
  const segments = logicalPath.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw workspaceFault(ErrorCodes.workspacePathEscape, `Invalid logical path: ${logicalPath}`)
  }
}

export async function canonicalizePotentialPath(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate)
  const suffix: string[] = []
  while (true) {
    try {
      const canonicalParent = await realpath(cursor)
      return path.join(canonicalParent, ...suffix.reverse())
    } catch (error) {
      if (!isMissing(error)) throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      suffix.push(path.basename(cursor))
      cursor = parent
    }
  }
}

export async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
