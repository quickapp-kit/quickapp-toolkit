import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function withTempDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quickapp-toolkit-'))
  try {
    return await work(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function createWorkspace(
  root: string,
  manifest: Record<string, unknown> = { package: 'com.example.test' },
): Promise<void> {
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'manifest.json'), `${JSON.stringify(manifest)}\n`)
}

export function captureIo(): {
  readonly io: { writeStdout(text: string): void; writeStderr(text: string): void }
  stdout(): string
  stderr(): string
} {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      writeStdout: (text) => {
        stdout += text
      },
      writeStderr: (text) => {
        stderr += text
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}
