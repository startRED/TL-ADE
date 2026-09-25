import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runTurningPoint } from '../evals/turning-point.ts'
import { AdeError } from '../journal/errors.ts'

const ADE_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** `ade dogfood --example <dir> --out <arquivo.md> [--double]`: o Ponto de virada ponta a ponta. */
export async function main(argv: string[], deps: { stdout: { write: (s: string) => void } }): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: { example: { type: 'string' }, out: { type: 'string' }, double: { type: 'boolean' } },
  })
  if (!values.example || !values.out) {
    throw new AdeError('dogfood_args', 'uso: ade dogfood --example <dir> --out <arquivo.md> [--double]', 4)
  }
  const { exitCode, record } = await runTurningPoint({
    exampleDir: path.resolve(values.example),
    adeRepoDir: ADE_ROOT,
    outPath: path.resolve(values.out),
    mode: values.double ? 'double' : 'real',
  })
  deps.stdout.write(`dogfood ${record.resultado}${record.motivo ? ` (${record.motivo})` : ''}: registro em ${values.out}\n`)
  return exitCode
}
