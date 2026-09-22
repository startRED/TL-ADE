// Roda o caso nomeado no primeiro argumento; exceção não tratada sai com código 1.
export async function runCase(cases) {
  const name = process.argv[2]
  if (!Object.hasOwn(cases, name)) {
    process.stderr.write(`caso desconhecido: ${name}\n`)
    process.exit(2)
  }
  await cases[name]()
  process.stdout.write(`ok ${name}\n`)
}
