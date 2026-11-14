// Transpile the real production modules, with no bundling or replacement logic.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const root = new URL('../', import.meta.url)
const output = new URL('./.build/', import.meta.url)
mkdirSync(output, { recursive: true })
for (const name of ['installation-auth', 'wire-contracts']) {
  const source = new URL(`src/${name}.ts`, root)
  const result = transformSync(readFileSync(source, 'utf8'), {
    sourcefile: fileURLToPath(source),
    loader: 'ts',
    target: 'es2022',
    format: 'esm',
    sourcemap: 'inline',
    sourcesContent: true,
  })
  writeFileSync(new URL(`${name}.js`, output), result.code)
}
