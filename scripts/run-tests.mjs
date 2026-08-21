import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(file)))
    else if (entry.isFile() && file.endsWith('.test.js')) files.push(file)
  }
  return files
}

const filter = process.argv[2]
const files = (await filesUnder('.test-dist/test'))
  .filter((file) => !filter || path.basename(file).includes(filter))
  .sort()

if (files.length === 0) throw new Error(`No tests matched${filter ? `: ${filter}` : ''}`)

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1)
})
