// Entrada fina do build do painel: compila packages/web e só promove o build que passou (ADR 0034).
import { fileURLToPath } from 'node:url'
import { buildWebPanel } from '../src/panel/web-build.ts'

const result = await buildWebPanel({ webDir: fileURLToPath(new URL('../packages/web', import.meta.url)) })
if (result.promoted) {
  process.stdout.write(`Painel promovido: ${result.distDir}\n`)
  if (result.error) process.stderr.write(`Aviso: ${result.error}\n`)
} else {
  process.stderr.write(`Build do painel falhou; continua servido: ${result.distDir || 'index.html da raiz'}\n${result.error}\n`)
  process.exitCode = 1
}
