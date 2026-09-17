import fs from 'node:fs'
import path from 'node:path'

/**
 * @typedef {Object} SecretFinding
 * @property {string} pattern
 * @property {number} offset
 * @property {string} preview
 */

/**
 * @typedef {Object} SecretPattern
 * @property {string} id
 * @property {RegExp} re
 */

/**
 * Teto máximo de achados devolvidos por varredura.
 * @type {number}
 */
export const MAX_FINDINGS = 50

/**
 * Padrões de segredos conhecidos monitorados pelo containment.
 * @type {readonly SecretPattern[]}
 */
export const SECRET_PATTERNS = Object.freeze([
  { id: 'aws_access_key_id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'openai_api_key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { id: 'github_token', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { id: 'pem_private_key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  {
    id: 'dotenv_secret',
    re: /^[+\- \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*[ \t]*=[ \t]*["']?\S+/gm,
  },
])

/**
 * Varre texto em busca de segredos conhecidos.
 *
 * @param {string} text
 * @returns {SecretFinding[]}
 */
export function scanText(text) {
  if (typeof text !== 'string') {
    throw new TypeError('texto inválido')
  }
  if (text.length === 0) {
    return []
  }

  /** @type {SecretFinding[]} */
  const findings = []

  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags)
    let m
    while ((m = re.exec(text)) !== null) {
      findings.push({
        pattern: p.id,
        offset: m.index,
        preview: m[0].slice(0, 4) + '…',
      })
    }
  }

  findings.sort((a, b) => {
    if (a.offset !== b.offset) {
      return a.offset - b.offset
    }
    return a.pattern.localeCompare(b.pattern)
  })

  return findings.slice(0, MAX_FINDINGS)
}

/**
 * Varre buffer de bytes (tratado como latin1) em busca de segredos.
 *
 * @param {Buffer} buf
 * @returns {SecretFinding[]}
 */
export function scanBytes(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('buffer inválido')
  }
  return scanText(buf.toString('latin1'))
}

/**
 * Varre arquivo no disco em busca de segredos. Devolve lista vazia se
 * o arquivo não existir ou se for diretório.
 *
 * @param {string} absPath
 * @returns {SecretFinding[]}
 */
export function scanFile(absPath) {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return []
  }
  try {
    const stat = fs.statSync(absPath)
    if (!stat.isFile()) {
      return []
    }
    const buf = fs.readFileSync(absPath)
    return scanBytes(buf)
  } catch {
    return []
  }
}

/**
 * Verifica se um caminho candidato está contido dentro do diretório raiz.
 *
 * @param {string} rootDir
 * @param {string} candidate
 * @returns {boolean}
 */
export function pathWithin(rootDir, candidate) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new TypeError('rootDir inválido')
  }
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new TypeError('candidate inválido')
  }

  let root = path.resolve(rootDir.replace(/\\/g, '/'))
  let cand = path.resolve(root, candidate.replace(/\\/g, '/'))

  if (process.platform === 'win32') {
    root = root.toLowerCase()
    cand = cand.toLowerCase()
  }

  const rel = path.relative(root, cand)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
