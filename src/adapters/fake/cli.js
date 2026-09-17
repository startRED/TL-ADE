import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AdeError } from '../../journal/errors.js'

/**
 * @typedef {Object} FakeAction
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {number} [exit]
 * @property {Record<string, unknown>} [result]
 */

/**
 * @typedef {Object} RunFakeCliDeps
 * @property {string} [cwd]
 * @property {() => string} [now]
 */

const ALLOWED_ACTION_KEYS = new Set(['stdout', 'stderr', 'exit', 'result'])

/**
 * Valida se uma ação do cenário segue estritamente o contrato da story.
 *
 * @param {unknown} acao Ação a ser validada.
 * @param {string} scenarioFile Caminho do arquivo para mensagem de erro.
 * @returns {void}
 */
function validateAction(acao, scenarioFile) {
  if (!acao || typeof acao !== 'object' || Array.isArray(acao)) {
    throw new AdeError('fake_scenario_invalid', 'cenário inválido: ' + scenarioFile, 2)
  }
  for (const key of Object.keys(acao)) {
    if (!ALLOWED_ACTION_KEYS.has(key)) {
      throw new AdeError('fake_scenario_invalid', 'cenário inválido: ' + scenarioFile, 2)
    }
  }
  /** @type {Record<string, unknown>} */
  const rec = /** @type {Record<string, unknown>} */ (acao)
  if (rec.stdout !== undefined && typeof rec.stdout !== 'string') {
    throw new AdeError('fake_scenario_invalid', 'cenário inválido: ' + scenarioFile, 2)
  }
  if (rec.stderr !== undefined && typeof rec.stderr !== 'string') {
    throw new AdeError('fake_scenario_invalid', 'cenário inválido: ' + scenarioFile, 2)
  }
  if (
    rec.exit !== undefined &&
    (typeof rec.exit !== 'number' || !Number.isSafeInteger(rec.exit) || rec.exit < 0)
  ) {
    throw new AdeError('fake_scenario_invalid', 'cenário inválido: ' + scenarioFile, 2)
  }
  if (
    rec.result !== undefined &&
    (typeof rec.result !== 'object' || rec.result === null || Array.isArray(rec.result))
  ) {
    throw new AdeError('fake_scenario_invalid', 'cenário inválido: ' + scenarioFile, 2)
  }
}

/**
 * Grava texto em arquivo duravelmente via tmp + fsync + rename.
 *
 * @param {string} file Caminho do arquivo de destino.
 * @param {string} text Conteúdo a ser gravado.
 * @returns {void}
 */
function writeDurable(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  /** @type {number | undefined} */
  let fd
  try {
    fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
      fd = undefined
    }
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // ignora erro ao fechar fd
      }
      fd = undefined
    }
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // ignora erro ao remover tmp se já inexistente
    }
    throw err
  }
}

/**
 * Lê o contador do papel no cenário. Devolve 0 se o arquivo não existir (ENOENT).
 * Lança TypeError se os argumentos forem inválidos ou se o conteúdo não for um inteiro não negativo.
 *
 * @param {string} scenarioDir Diretório absoluto do cenário.
 * @param {string} role Papel do agente.
 * @returns {number} O contador lido (base 0).
 */
export function readCounter(scenarioDir, role) {
  if (typeof scenarioDir !== 'string' || !scenarioDir) {
    throw new TypeError('scenarioDir inválido')
  }
  if (typeof role !== 'string' || !role) {
    throw new TypeError('role inválido')
  }
  const file = path.join(scenarioDir, `${role}.count`)
  /** @type {string} */
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return 0
    }
    throw err
  }
  const raw = text.trim()
  const val = Number.parseInt(raw, 10)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(val) || val < 0) {
    throw new TypeError('contador inválido')
  }
  return val
}

/**
 * Incrementa o contador em disco e devolve o índice consumido (base 0).
 *
 * @param {string} scenarioDir Diretório absoluto do cenário.
 * @param {string} role Papel do agente.
 * @returns {number} Índice consumido antes do incremento.
 */
export function bumpCounter(scenarioDir, role) {
  const i = readCounter(scenarioDir, role)
  const file = path.join(scenarioDir, `${role}.count`)
  writeDurable(file, String(i + 1) + '\n')
  return i
}

/**
 * Executa a CLI falsa a partir de argumentos de linha de comando e variáveis de ambiente.
 *
 * @param {string[]} argv Argumentos de linha de comando (sem executável nem script).
 * @param {Record<string, string | undefined>} env Variáveis de ambiente fornecidas.
 * @param {RunFakeCliDeps} [deps] Dependências opcionais injetáveis.
 * @returns {Promise<number>} Código de saída do processo.
 */
export async function runFakeCli(argv, env, deps = {}) {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
    throw new TypeError('argv inválido')
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('env inválido')
  }
  for (const key of Object.keys(env)) {
    const val = env[key]
    if (val !== undefined && typeof val !== 'string') {
      throw new TypeError('env inválido')
    }
  }
  if (deps !== undefined && (typeof deps !== 'object' || deps === null || Array.isArray(deps))) {
    throw new TypeError('deps inválido')
  }
  const { cwd = process.cwd(), now } = deps ?? {}
  if (typeof cwd !== 'string' || !cwd) {
    throw new TypeError('cwd inválido')
  }
  if (now !== undefined && typeof now !== 'function') {
    throw new TypeError('now inválido')
  }

  if (!env.ADE_FAKE_SCENARIO) {
    process.stderr.write('ADE_FAKE_SCENARIO ausente\n')
    return 2
  }
  if (!env.ADE_FAKE_RESULT_FILE) {
    process.stderr.write('ADE_FAKE_RESULT_FILE ausente\n')
    return 2
  }

  const scenarioDir = env.ADE_FAKE_SCENARIO
  const role = env.ADE_FAKE_ROLE ?? 'maker'
  const scenarioFile = path.join(scenarioDir, `${role}.json`)

  /** @type {string} */
  let scenarioRaw
  try {
    scenarioRaw = fs.readFileSync(scenarioFile, 'utf8')
  } catch {
    throw new AdeError('fake_scenario_invalid', 'cenário inválido: ' + scenarioFile, 2)
  }

  /** @type {unknown} */
  let acoes
  try {
    acoes = JSON.parse(scenarioRaw)
  } catch {
    throw new AdeError('fake_scenario_invalid', 'cenário inválido: ' + scenarioFile, 2)
  }

  if (!Array.isArray(acoes) || acoes.length === 0) {
    throw new AdeError('fake_scenario_invalid', 'cenário inválido: ' + scenarioFile, 2)
  }

  for (const acao of acoes) {
    validateAction(acao, scenarioFile)
  }

  const i = bumpCounter(scenarioDir, role)
  /** @type {FakeAction} */
  const acao = /** @type {FakeAction} */ (acoes[Math.min(i, acoes.length - 1)] ?? {})

  let packContent = ''
  for (const arg of argv) {
    if (typeof arg !== 'string') continue
    const candidate = path.resolve(cwd, arg)
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile()) {
        packContent = fs.readFileSync(candidate, 'utf8')
        break
      }
    } catch {
      // continua procurando primeiro arquivo existente
    }
  }

  const packPath = path.join(scenarioDir, `${role}-${i}.pack.md`)
  fs.writeFileSync(packPath, packContent, 'utf8')

  const envPath = path.join(scenarioDir, `${role}-${i}.env.json`)
  fs.writeFileSync(envPath, JSON.stringify(Object.keys(env).sort(), null, 2) + '\n', 'utf8')

  const argvPath = path.join(scenarioDir, `${role}-${i}.argv.json`)
  fs.writeFileSync(argvPath, JSON.stringify(argv, null, 2) + '\n', 'utf8')

  if (acao.stdout !== undefined && acao.stdout !== null) {
    process.stdout.write(String(acao.stdout))
  }
  if (acao.stderr !== undefined && acao.stderr !== null) {
    process.stderr.write(String(acao.stderr))
  }

  const resultFile = env.ADE_FAKE_RESULT_FILE
  const resultDir = path.dirname(resultFile)
  fs.mkdirSync(resultDir, { recursive: true })
  const resultData = acao.result ?? { status: 'ok', role, call: i }
  fs.writeFileSync(resultFile, JSON.stringify(resultData) + '\n', 'utf8')

  return acao.exit ?? 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runFakeCli(process.argv.slice(2), process.env)
    .then((c) => process.exit(c))
    .catch((err) => {
      if (err instanceof AdeError && typeof err.exitCode === 'number') {
        process.stderr.write(err.message + '\n')
        process.exit(err.exitCode)
      }
      process.stderr.write(String(err?.message ?? err) + '\n')
      process.exit(1)
    })
}
