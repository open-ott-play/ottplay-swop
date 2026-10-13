// Transpile the real production modules, with no bundling or replacement logic.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = new URL('../', import.meta.url)
const output = new URL('./.build/', import.meta.url)
mkdirSync(output, { recursive: true })
for (const name of ['installation-auth', 'wire-contracts']) {
  const source = new URL(`src/${name}.ts`, root)
  const result = ts.transpileModule(readFileSync(source, 'utf8'), {
    fileName: fileURLToPath(source),
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      inlineSourceMap: true,
      inlineSources: true,
    },
  })
  writeFileSync(new URL(`${name}.js`, output), result.outputText)
}
