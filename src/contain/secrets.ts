import fs from 'node:fs'
import path from 'node:path'

export type SecretFinding = {
  pattern: string
  offset: number
  preview: string
}

export type SecretPattern = {
  id: string
  re: RegExp
}

/**
 * Teto máximo de achados devolvidos por varredura.
 */
export const MAX_FINDINGS: number = 50

/**
 * Padrões de segredos conhecidos monitorados pelo containment.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
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
 */
export function scanText(text: string): SecretFinding[] {
  if (typeof text !== 'string') {
    throw new TypeError('texto inválido')
  }
  if (text.length === 0) {
    return []
  }

  const findings: SecretFinding[] = []

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
 */
export function scanBytes(buf: Buffer): SecretFinding[] {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('buffer inválido')
  }
  return scanText(buf.toString('latin1'))
}

/**
 * Varre arquivo no disco em busca de segredos. Devolve lista vazia se
 * o arquivo não existir ou se for diretório.
 *
 */
export function scanFile(absPath: string): SecretFinding[] {
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
 */
export function pathWithin(rootDir: string, candidate: string): boolean {
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
