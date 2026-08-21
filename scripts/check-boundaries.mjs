import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const roots = ['src/cli', 'src/workspace', 'src/application', 'src/compiler/frontend', 'src/compiler/manifest', 'src/compiler/module-graph', 'src/compiler/lowering', 'src/compiler/emitter', 'src/compiler/artifact']
const forbidden = new Map([
  ['src/cli', ['/compiler/', '/runtime/', '/artifact/', '/rpk/']],
  ['src/workspace', ['/cli/', '/compiler/', '/runtime/']],
  ['src/application', ['/cli/']],
  ['src/compiler/frontend', ['/manifest/', '/module-graph/', '/lowering/', '/emitter/', '/artifact/']],
  ['src/compiler/manifest', ["from 'acorn'", "from 'parse5'", "from 'postcss'", "from 'postcss-less'", '/lowering/', '/emitter/', '/artifact/']],
  ['src/compiler/module-graph', ["from 'acorn'", "from 'parse5'", "from 'postcss'", "from 'postcss-less'", '/lowering/', '/emitter/', '/artifact/']],
  ['src/compiler/lowering', ['/emitter/', '/artifact/', '/runtime/', '/rpk/']],
  ['src/compiler/emitter', ['/artifact/', '/runtime/', '/rpk/']],
  ['src/compiler/artifact', ['/runtime/', '/rpk/']],
])

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(file)))
    else if (entry.isFile() && file.endsWith('.ts')) files.push(file)
  }
  return files
}

const violations = []
const publicEntry = await readFile('src/index.ts', 'utf8')
if (publicEntry.includes("./cli/")) {
  violations.push('src/index.ts: CLI Adapter must not be exported by the Application Service package entry')
}
for (const root of roots) {
  for (const file of await filesUnder(root)) {
    const source = await readFile(file, 'utf8')
    for (const token of forbidden.get(root) ?? []) {
      if (source.includes(token)) violations.push(`${file}: forbidden dependency ${token}`)
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('Architecture boundaries: PASS\n')
}
