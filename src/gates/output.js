import fs from 'node:fs'
import path from 'node:path'

/**
 * Tetos de bytes do extrato para o modelo por tipo de gate.
 * @type {Readonly<Record<string, number>>}
 */
export const EXTRACT_CAPS = Object.freeze({
  test: 8192,
  lint: 8192,
  typecheck: 8192,
  build: 8192,
  git: 4096,
})

/**
 * Limite máximo em bytes para o identificador rawRef.
 * @type {number}
 */
export const MAX_RAW_REF_BYTES = 1024

/**
 * Sanitiza identificadores trocando qualquer caractere fora de [A-Za-z0-9._-] por '_'.
 *
 * @param {string} id
 * @returns {string}
 */
export function safeId(id) {
  if (typeof id !== 'string') {
    throw new TypeError('id precisa ser string')
  }
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * @typedef {Object} WriteRawArtifactOptions
 * @property {string} missionDir
 * @property {string} ref
 * @property {string} text
 */

/**
 * @typedef {Object} WriteRawArtifactResult
 * @property {string} rawPath
 * @property {number} bytes
 */

/**
 * Grava o texto bruto em <missionDir>/artifacts/<ref>.log criando os diretórios necessários.
 * Valida que ref seja um caminho relativo estruturado que não escape de <missionDir>/artifacts.
 *
 * @param {WriteRawArtifactOptions} options
 * @returns {WriteRawArtifactResult}
 */
export function writeRawArtifact({ missionDir, ref, text }) {
  if (!missionDir || typeof missionDir !== 'string') {
    throw new TypeError('missionDir precisa ser string')
  }
  if (!ref || typeof ref !== 'string') {
    throw new TypeError('ref precisa ser string')
  }
  if (typeof text !== 'string') {
    throw new TypeError('text precisa ser string')
  }

  if (ref.includes('\\')) {
    throw new TypeError('ref inválido: separadores alternativos não permitidos')
  }
  if (ref.startsWith('/') || ref.endsWith('/')) {
    throw new TypeError('ref inválido: caminho precisa ser relativo sem barras nas pontas')
  }

  const segments = ref.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new TypeError(`ref inválido: segmento não permitido '${seg}'`)
    }
    if (seg.includes(':')) {
      throw new TypeError(`ref inválido: caractere ':' não permitido no segmento '${seg}'`)
    }
    if (/[ .]$/.test(seg)) {
      // Windows remove espaços e pontos finais ao materializar o nome no sistema de
      // arquivos, então um segmento como '.. ' ou '...' pode ser gravado como '..'
      // e escapar de <missionDir>/artifacts mesmo passando na checagem lexical acima.
      throw new TypeError(`ref inválido: segmento não pode terminar em espaço ou ponto '${seg}'`)
    }
  }

  const artifactsDir = path.resolve(missionDir, 'artifacts')
  const rawPath = path.resolve(artifactsDir, ...segments) + '.log'

  const relativePath = path.relative(artifactsDir, rawPath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new TypeError('ref inválido: caminho tenta escapar de artifacts')
  }

  fs.mkdirSync(path.dirname(rawPath), { recursive: true })
  fs.writeFileSync(rawPath, text, 'utf8')

  return {
    rawPath,
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

/**
 * Retorna o maior buffer prefixo que seja UTF-8 válido com no máximo maxBytes.
 * Remove bytes de continuação incompletos se cortado no meio de caractere multi-byte.
 *
 * @param {Buffer} buf
 * @param {number} maxBytes
 * @returns {Buffer}
 */
function truncateUtf8Buffer(buf, maxBytes) {
  if (maxBytes <= 0) {
    return Buffer.alloc(0)
  }
  if (buf.byteLength <= maxBytes) {
    return buf
  }
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--
  }
  return Buffer.from(buf.subarray(0, end))
}

/**
 * Retorna o sufixo UTF-8 válido com no máximo maxBytes.
 *
 * @param {Buffer} buf
 * @param {number} maxBytes
 * @returns {string}
 */
function takeLastBytesUtf8(buf, maxBytes) {
  if (buf.byteLength <= maxBytes) {
    return buf.toString('utf8')
  }
  let start = buf.byteLength - maxBytes
  while (start < buf.byteLength && (buf[start] & 0xc0) === 0x80) {
    start++
  }
  return buf.subarray(start).toString('utf8')
}

/**
 * @typedef {'success' | 'warning' | 'error'} ExtractStatus
 */

/**
 * @typedef {Object} BuildExtractOptions
 * @property {string} kind
 * @property {number|null} exitCode
 * @property {number} expectExit
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} rawRef
 * @property {number} bytesRaw
 */

/**
 * @typedef {Object} BuildExtractResult
 * @property {ExtractStatus} status
 * @property {string} summary
 * @property {string} excerpt
 * @property {string[]} next_actions
 * @property {string[]} artifacts
 * @property {string} raw_ref
 * @property {number} bytes_raw
 * @property {number} bytes_model
 */

/**
 * Constrói o extrato padronizado para entrega ao modelo, aplicando teto por tipo de gate.
 *
 * @param {BuildExtractOptions} options
 * @returns {BuildExtractResult}
 */
export function buildExtract({ kind, exitCode, expectExit, stdout, stderr, rawRef, bytesRaw }) {
  if (typeof kind !== 'string' || !kind) {
    throw new TypeError('kind precisa ser string não vazia')
  }
  if (typeof rawRef !== 'string' || !rawRef) {
    throw new TypeError('rawRef precisa ser string não vazia')
  }
  if (typeof stdout !== 'string') {
    throw new TypeError('stdout precisa ser string')
  }
  if (typeof stderr !== 'string') {
    throw new TypeError('stderr precisa ser string')
  }

  const cap = EXTRACT_CAPS[kind] ?? 8192
  const maxRawRefBytes = Math.min(MAX_RAW_REF_BYTES, cap - 64)
  if (Buffer.byteLength(rawRef, 'utf8') > maxRawRefBytes) {
    throw new TypeError(`rawRef excede o tamanho máximo permitido (${maxRawRefBytes} bytes) para o teto de ${cap}`)
  }

  /** @type {ExtractStatus} */
  let status
  if (exitCode !== expectExit) {
    status = 'error'
  } else {
    const allText = `${stdout}\n${stderr}`
    if (/\bwarn(ing)?s?\b/i.test(allText)) {
      status = 'warning'
    } else {
      status = 'success'
    }
  }

  const summary = `${kind} exit=${exitCode} esperado=${expectExit} bytes=${bytesRaw}`

  let excerpt
  if (status !== 'error') {
    const stdoutBuf = Buffer.from(stdout, 'utf8')
    excerpt = takeLastBytesUtf8(stdoutBuf, 600)
  } else {
    const full = `${stderr}\n${stdout}`
    const fullBuf = Buffer.from(full, 'utf8')
    const fullBytes = fullBuf.byteLength

    if (fullBytes <= cap) {
      excerpt = full
    } else {
      let n = Math.max(0, fullBytes - cap)
      /** @type {Buffer<ArrayBufferLike>} */
      let prefixBuf = Buffer.alloc(0)
      let marker = ''

      for (let pass = 0; pass < 3; pass++) {
        marker = `\n[...cortado: ${n} bytes em ${rawRef}]`
        const markerBytes = Buffer.byteLength(marker, 'utf8')
        const targetPrefixBytes = Math.max(0, cap - markerBytes)
        prefixBuf = truncateUtf8Buffer(fullBuf, targetPrefixBytes)
        const newN = fullBytes - prefixBuf.byteLength
        if (newN === n) {
          break
        }
        n = newN
      }

      marker = `\n[...cortado: ${fullBytes - prefixBuf.byteLength} bytes em ${rawRef}]`
      let excerptBuf = Buffer.concat([prefixBuf, Buffer.from(marker, 'utf8')])

      while (excerptBuf.byteLength > cap && prefixBuf.byteLength > 0) {
        prefixBuf = truncateUtf8Buffer(prefixBuf, prefixBuf.byteLength - 1)
        marker = `\n[...cortado: ${fullBytes - prefixBuf.byteLength} bytes em ${rawRef}]`
        excerptBuf = Buffer.concat([prefixBuf, Buffer.from(marker, 'utf8')])
      }

      excerpt = excerptBuf.toString('utf8')
    }
  }

  const bytesModel = Buffer.byteLength(excerpt, 'utf8')

  return {
    status,
    summary,
    excerpt,
    next_actions: status === 'error' ? [`ade show ${rawRef}`] : [],
    artifacts: [rawRef],
    raw_ref: rawRef,
    bytes_raw: bytesRaw,
    bytes_model: bytesModel,
  }
}
