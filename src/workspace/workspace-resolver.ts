import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { ErrorCodes } from '../diagnostics/error-codes.js'
import type { CancellationToken } from '../application/cancellation.js'
import { SourceAccess } from './source-access.js'
import type { ConfigSectionValidator } from './config-resolver.js'
import { resolveConfig } from './config-resolver.js'
import type { WorkspaceContext, WorkspaceOverrides } from './types.js'
import {
  canonicalizePotentialPath,
  isDirectory,
  isRegularFile,
  isWithin,
  workspaceFault,
} from './path-utils.js'

export interface ResolveWorkspaceRequest {
  readonly cwd: string
  readonly workspace?: string
  readonly config?: string
  readonly overrides?: WorkspaceOverrides
}

export interface WorkspaceResolution {
  readonly context: WorkspaceContext
  readonly sourceAccess: SourceAccess
}

export class WorkspaceResolver {
  readonly #sectionValidators: Partial<
    Record<'build' | 'inspect' | 'run', ConfigSectionValidator>
  >

  constructor(
    sectionValidators: Partial<Record<'build' | 'inspect' | 'run', ConfigSectionValidator>> = {},
  ) {
    this.#sectionValidators = sectionValidators
  }

  async resolve(request: ResolveWorkspaceRequest, cancellation: CancellationToken): Promise<WorkspaceResolution> {
    cancellation.throwIfCancelled()
    const cwd = await realpath(request.cwd)
    const root = request.workspace
      ? await this.#resolveExplicitRoot(cwd, request.workspace)
      : await this.#discoverRoot(cwd)
    cancellation.throwIfCancelled()

    const configResolution = await resolveConfig({
      root,
      cwd,
      ...(request.config === undefined ? {} : { explicitConfig: request.config }),
      ...(request.overrides === undefined ? {} : { overrides: request.overrides }),
      sectionValidators: this.#sectionValidators,
    })
    const sourceRoot = await canonicalizePotentialPath(
      path.join(root, ...configResolution.config.workspace.sourceRoot.value.split('/')),
    )
    const outputRoot = await canonicalizePotentialPath(
      path.join(root, ...configResolution.config.workspace.outputRoot.value.split('/')),
    )
    const cacheRoot = await canonicalizePotentialPath(
      path.join(root, ...configResolution.config.workspace.cacheRoot.value.split('/')),
    )
    this.#validateRoots(root, sourceRoot, outputRoot, cacheRoot)
    if (!(await isDirectory(sourceRoot))) {
      throw workspaceFault(ErrorCodes.workspaceMarkerMissing, 'Configured sourceRoot must be a directory')
    }

    const manifestPath = path.join(sourceRoot, 'manifest.json')
    if (!(await isRegularFile(manifestPath))) {
      throw workspaceFault(ErrorCodes.workspaceMarkerMissing, 'Workspace manifest not found: sourceRoot/manifest.json')
    }

    const sourceAccess = new SourceAccess(root, [outputRoot, cacheRoot])
    try {
      const manifestLogicalPath = path.relative(root, manifestPath).split(path.sep).join('/')
      const manifest = await sourceAccess.read(manifestLogicalPath, {
        content: 'strictUtf8',
        maxBytes: 1024 * 1024,
      })
      return {
        context: {
          root,
          logicalRoot: '.',
          ...(configResolution.path === undefined ? {} : { configPath: configResolution.path }),
          sourceRoot,
          outputRoot,
          cacheRoot,
          manifestPath,
          manifest,
          config: configResolution.config,
        },
        sourceAccess,
      }
    } catch (error) {
      sourceAccess.dispose()
      throw error
    }
  }

  async #resolveExplicitRoot(cwd: string, input: string): Promise<string> {
    const candidate = path.resolve(cwd, input)
    if (!(await isDirectory(candidate))) {
      throw workspaceFault(ErrorCodes.workspaceMarkerMissing, `Explicit Workspace is not a directory: ${input}`)
    }
    if (!(await hasRootMarker(candidate))) {
      throw workspaceFault(ErrorCodes.workspaceMarkerMissing, `Explicit Workspace has no root marker: ${input}`)
    }
    return realpath(candidate)
  }

  async #discoverRoot(cwd: string): Promise<string> {
    let candidate = cwd
    while (true) {
      if (await hasRootMarker(candidate)) return realpath(candidate)
      const parent = path.dirname(candidate)
      if (parent === candidate) break
      candidate = parent
    }
    throw workspaceFault(ErrorCodes.workspaceNotFound, `No Workspace found from cwd: ${cwd}`)
  }

  #validateRoots(root: string, sourceRoot: string, outputRoot: string, cacheRoot: string): void {
    for (const candidate of [sourceRoot, outputRoot, cacheRoot]) {
      if (!isWithin(root, candidate)) {
        throw workspaceFault(ErrorCodes.workspacePathEscape, 'Workspace path resolves outside the root')
      }
    }
    const pairs: readonly [string, string][] = [
      [sourceRoot, outputRoot],
      [sourceRoot, cacheRoot],
      [outputRoot, cacheRoot],
    ]
    if (pairs.some(([left, right]) => isWithin(left, right) || isWithin(right, left))) {
      throw workspaceFault(ErrorCodes.workspacePathConflict, 'sourceRoot, outputRoot and cacheRoot must not overlap')
    }
  }
}

async function hasRootMarker(directory: string): Promise<boolean> {
  return (
    (await isRegularFile(path.join(directory, 'quickapp.config.json'))) ||
    (await isRegularFile(path.join(directory, 'src', 'manifest.json')))
  )
}
