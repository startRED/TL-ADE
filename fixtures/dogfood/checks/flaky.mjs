// Dublê instável: vermelho só na segunda execução da tripla.
if (process.env.ADE_DOGFOOD_RUN === '2') {
  process.stderr.write('falha na execução 2\n')
  process.exit(1)
}
process.stdout.write('ok\n')
