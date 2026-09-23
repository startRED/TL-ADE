import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AdeError } from '../src/journal/errors.ts'

export const VARIANTS = ['ok_without_cost', 'unknown_fields', 'truncated_json', 'ansi_noise']

const ANSI_PREFIX = Buffer.from('\x1b[2K\x1b[1G', 'utf8')
const ANSI_SUFFIX = Buffer.from('\x1b[0m\n', 'utf8')

/**
 * @param {Buffer} _stdoutBuf
 * @param {any} parsed cópia própria do stdout base já parseado; pode ser mutada
 * @returns {Buffer}
 */
function transformOkWithoutCost(_stdoutBuf, parsed) {
  delete parsed.total_cost_usd
  if (parsed.modelUsage && typeof parsed.modelUsage === 'object') {
    for (const usage of Object.values(parsed.modelUsage)) {
      if (usage && typeof usage === 'object') {
        delete usage.costUSD
        delete usage.costBasis
      }
    }
  }
  return Buffer.from(JSON.stringify(parsed), 'utf8')
}

/**
 * @param {Buffer} _stdoutBuf
 * @param {any} parsed cópia própria do stdout base já parseado; pode ser mutada
 * @returns {Buffer}
 */
function transformUnknownFields(_stdoutBuf, parsed) {
  parsed.ade_unknown_field = { nested: true }
  if (parsed.modelUsage && typeof parsed.modelUsage === 'object') {
    for (const usage of Object.values(parsed.modelUsage)) {
      if (usage && typeof usage === 'object') {
        usage.ade_unknown_field = { nested: true }
      }
    }
  }
  return Buffer.from(JSON.stringify(parsed), 'utf8')
}

/**
 * Corta o stdout na metade exata em bytes. Se o prefixo ainda for JSON válido (ex.: objeto
 * completo seguido de espaços), o último byte vira `{`, o que deixa um objeto sem fechar ou uma
 * string sem fim, sem mudar o tamanho.
 *
 * @param {Buffer} stdoutBuf
 * @returns {Buffer}
 */
function transformTruncatedJson(stdoutBuf) {
  const truncated = Buffer.from(stdoutBuf.subarray(0, Math.floor(stdoutBuf.length / 2)))
  if (isValidJson(truncated)) {
    truncated[truncated.length - 1] = 0x7b
  }
  return truncated
}

/**
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isValidJson(buf) {
  try {
    JSON.parse(buf.toString('utf8'))
    return true
  } catch (err) {
    if (err instanceof SyntaxError) return false
    throw err
  }
}

/**
 * @param {Buffer} stdoutBuf
 * @returns {Buffer}
 */
function transformAnsiNoise(stdoutBuf) {
  return Buffer.concat([ANSI_PREFIX, stdoutBuf, ANSI_SUFFIX])
}

/** @type {Record<string, (stdoutBuf: Buffer, parsed: any) => Buffer>} */
const TRANSFORMS = {
  ok_without_cost: transformOkWithoutCost,
  unknown_fields: transformUnknownFields,
  truncated_json: transformTruncatedJson,
  ansi_noise: transformAnsiNoise,
}

/**
 * Lê um arquivo da base. Arquivo ausente é transcript incompleto, não ENOENT nativo.
 *
 * @param {string} baseDirPath
 * @param {string} file
 * @returns {Buffer}
 */
function readBaseFile(baseDirPath, file) {
  const filePath = path.join(baseDirPath, file)
  try {
    return readFileSync(filePath)
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      throw new AdeError('transcript_missing', 'transcript base ausente: ' + filePath, 2)
    }
    throw err
  }
}

/**
 * @param {string} filePath
 * @param {Buffer} buf
 * @returns {any}
 */
function parseBaseJson(filePath, buf) {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new AdeError('invalid_argument', 'transcript base inválido: ' + filePath + ': ' + err.message, 2)
    }
    throw err
  }
}

/**
 * Deriva as quatro variantes de transcript a partir de `ok_with_structured_output`.
 *
 * @param {{ baseDir: string }} opts
 * @returns {Promise<string[]>}
 */
export async function deriveTranscripts(opts) {
  const { baseDir } = opts ?? {}
  if (typeof baseDir !== 'string' || baseDir === '') {
    throw new AdeError('invalid_argument', 'baseDir inválido', 2)
  }

  const baseDirPath = path.join(baseDir, 'ok_with_structured_output')
  if (!existsSync(baseDirPath)) {
    throw new AdeError('transcript_missing', 'transcript base ausente: ' + baseDirPath, 2)
  }

  // Lê e valida toda a base antes de escrever qualquer variante: base malformada não cria nada.
  const argvBuf = readBaseFile(baseDirPath, 'argv.json')
  const stdinBuf = readBaseFile(baseDirPath, 'stdin.txt')
  const stderrBuf = readBaseFile(baseDirPath, 'stderr.txt')
  const exitBuf = readBaseFile(baseDirPath, 'exit.txt')
  const stdoutBuf = readBaseFile(baseDirPath, 'stdout.json')
  const metaBuf = readBaseFile(baseDirPath, 'meta.json')
  const metaBase = parseBaseJson(path.join(baseDirPath, 'meta.json'), metaBuf)
  const stdoutJson = parseBaseJson(path.join(baseDirPath, 'stdout.json'), stdoutBuf)

  const stdouts = VARIANTS.map((name) => TRANSFORMS[name](stdoutBuf, structuredClone(stdoutJson)))

  for (const [i, name] of VARIANTS.entries()) {
    const dir = path.join(baseDir, name)
    mkdirSync(dir, { recursive: true })

    writeFileSync(path.join(dir, 'argv.json'), argvBuf)
    writeFileSync(path.join(dir, 'stdin.txt'), stdinBuf)
    writeFileSync(path.join(dir, 'stderr.txt'), stderrBuf)
    writeFileSync(path.join(dir, 'exit.txt'), exitBuf)
    writeFileSync(path.join(dir, 'stdout.json'), stdouts[i])
    writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify(
        { ...metaBase, name, derived_from: 'ok_with_structured_output', transform: name },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  }

  return VARIANTS
}

/**
 * Devolve o valor de `--base-dir`, ou null se a opção não foi passada. Opção sem valor é entrada
 * inválida.
 *
 * @param {string[]} argv
 * @returns {string|null}
 */
function parseBaseDirArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-dir') {
      const value = argv[i + 1]
      if (typeof value !== 'string' || value === '') {
        throw new AdeError('invalid_argument', '--base-dir exige um valor', 2)
      }
      return value
    }
  }
  return null
}

/**
 * @param {string[]} argv
 * @param {{ stderr?: {write: (s: string) => void}, baseDir?: string }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stderr = deps.stderr ?? process.stderr

  try {
    const baseDir =
      deps.baseDir ??
      parseBaseDirArg(argv) ??
      fileURLToPath(new URL('../fixtures/transcripts/claude/', import.meta.url))
    const names = await deriveTranscripts({ baseDir })
    stderr.write('variantes derivadas: ' + names.join(', ') + '\n')
    return 0
  } catch (err) {
    if (err instanceof AdeError) {
      stderr.write(err.message + '\n')
      return err.exitCode
    }
    throw err
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
