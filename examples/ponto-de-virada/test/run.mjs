// Roda as provas em node:test e imprime o resumo JSON que o motor da TL-ADE lê.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { run } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(dir, f))
let passed = 0
let failed = 0
for await (const ev of run({ files })) {
  if (ev.data?.details?.type === 'suite') continue
  if (ev.type === 'test:pass') passed++
  if (ev.type === 'test:fail') failed++
}
process.stdout.write(JSON.stringify({ numTotalTests: passed + failed, numPassedTests: passed, numFailedTests: failed }) + '\n')
process.exitCode = failed > 0 ? 1 : 0
