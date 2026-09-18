import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.js'
import { safeId, writeRawArtifact } from '../gates/output.js'
import { digest16 } from '../journal/canonical.js'
import { redactText } from './redact.js'

/**
 * Ordem fixa das seções do Context Pack.
 * @type {readonly string[]}
 */
export const SECTION_ORDER = Object.freeze(['contract', 'policy', 'story'])

/**
 * Tetos por seção, em bytes UTF-8.
 * @type {Readonly<Record<string, number>>}
 */
export const SECTION_CAPS = Object.freeze({
  contract: 32000,
  policy: 8000,
  story: 24000,
})

const DEFAULT_MAX_PACK_BYTES = 120000

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isExistingDirectory(dir) {
  const stat = fs.statSync(dir, { throwIfNoEntry: false })
  return stat !== undefined && stat.isDirectory()
}

// Em modo `u`, um par substituto bem formado é um único code point; só o surrogate isolado casa.
const LONE_SURROGATE = /\p{Surrogate}/u

/**
 * @param {string} message
 * @returns {AdeError}
 */
function invalidInput(message) {
  return new AdeError('invalid_pack_section', message, 2)
}

/**
 * Recusa opções, missionDir, stepId e limits inválidos antes de qualquer gravação.
 *
 * @param {unknown} options
 * @returns {void}
 */
function validateOptions(options) {
  if (!isPlainObject(options)) {
    throw invalidInput('opções inválidas: objeto ausente')
  }
  const { missionDir, stepId, limits, savedBytes } = options
  if (typeof missionDir !== 'string' || missionDir === '' || !isExistingDirectory(missionDir)) {
    throw invalidInput('missionDir inválido')
  }
  // safeId preserva '.', então um stepId como '..' viraria segmento de caminho proibido.
  if (typeof stepId !== 'string' || stepId === '' || safeId(stepId).endsWith('.')) {
    throw invalidInput('stepId inválido')
  }
  if (savedBytes !== undefined && (typeof savedBytes !== 'number' || !Number.isSafeInteger(savedBytes) || savedBytes < 0)) {
    throw invalidInput('savedBytes inválido')
  }
  if (limits === undefined) {
    return
  }
  if (!isPlainObject(limits)) {
    throw invalidInput('limits inválido')
  }
  for (const key of Object.keys(limits)) {
    if (key !== 'max_pack_bytes' && key !== 'section_bytes') {
      throw invalidInput(`limits.${key} inválido`)
    }
  }
  if (limits.max_pack_bytes !== undefined && !isPositiveInteger(limits.max_pack_bytes)) {
    throw invalidInput('limits.max_pack_bytes inválido')
  }
  const sectionBytes = limits.section_bytes
  if (sectionBytes === undefined) {
    return
  }
  if (!isPlainObject(sectionBytes)) {
    throw invalidInput('limits.section_bytes inválido')
  }
  for (const [key, value] of Object.entries(sectionBytes)) {
    if (!SECTION_ORDER.includes(key) || !isPositiveInteger(value)) {
      throw invalidInput(`limits.section_bytes.${key} inválido`)
    }
  }
}

/**
 * @param {unknown} sections
 * @returns {void}
 */
function validateSections(sections) {
  if (!sections || typeof sections !== 'object') {
    throw new AdeError('invalid_pack_section', 'seções inválidas: objeto ausente', 2)
  }
  const record = /** @type {Record<string, unknown>} */ (sections)
  for (const key of Object.keys(record)) {
    if (!SECTION_ORDER.includes(key)) {
      throw new AdeError('invalid_pack_section', `seção desconhecida: ${key}`, 2)
    }
  }
  for (const name of SECTION_ORDER) {
    const body = record[name]
    if (typeof body !== 'string' || body.includes('=== ade:section ') || LONE_SURROGATE.test(body)) {
      throw new AdeError('invalid_pack_section', `seção inválida: ${name}`, 2)
    }
  }
}

/**
 * @param {string} name
 * @returns {string}
 */
function sectionHeader(name) {
  return `=== ade:section ${name} ===\n`
}

/**
 * @param {Record<string, string>} sections
 * @returns {string}
 */
function buildRawPack(sections) {
  return SECTION_ORDER.map((name) => sectionHeader(name) + sections[name] + '\n').join('')
}

/**
 * Separa de volta os corpos de cada seção a partir do texto do pack montado.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function splitPackSections(text) {
  /** @type {Record<string, string>} */
  const bodies = {}
  for (let i = 0; i < SECTION_ORDER.length; i++) {
    const name = SECTION_ORDER[i]
    const marker = sectionHeader(name)
    const start = text.indexOf(marker)
    const bodyStart = start + marker.length
    const nextName = SECTION_ORDER[i + 1]
    const nextIdx = nextName ? text.indexOf(sectionHeader(nextName), bodyStart) : -1
    const bodyEnd = nextIdx === -1 ? text.length : nextIdx
    bodies[name] = text.slice(bodyStart, bodyEnd).replace(/\n$/, '')
  }
  return bodies
}

/**
 * Corta `body` no maior prefixo cujo tamanho em bytes UTF-8 não passa de `maxBytes`,
 * recuando a fronteira do corte para nunca partir um par substituto (surrogate pair) ao meio.
 *
 * @param {string} body
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateToByteLimit(body, maxBytes) {
  if (maxBytes <= 0) {
    return ''
  }
  let low = 0
  let high = body.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(body.slice(0, mid)) <= maxBytes) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  let k = low
  if (k > 0 && k < body.length) {
    const code = body.charCodeAt(k - 1)
    if (code >= 0xd800 && code <= 0xdbff) {
      k--
    }
  }
  return body.slice(0, k)
}

/**
 * Aplica o teto de bytes de uma seção: devolve o corpo intacto se couber, corta com
 * ponteiro quando a seção admite truncagem, ou recusa quando é contract ou policy.
 *
 * @param {string} name
 * @param {string} body
 * @param {number} cap
 * @param {string} ref
 * @returns {string}
 */
function capSection(name, body, cap, ref) {
  const bytes = Buffer.byteLength(body)
  if (bytes <= cap) {
    return body
  }
  if (name === 'contract' || name === 'policy') {
    throw new AdeError('pack_budget_exceeded', `seção ${name} tem ${Buffer.byteLength(body)} bytes e excede o teto de ${cap} bytes`, 2)
  }
  const totalChars = body.length
  const pointer = `\n[... truncated, ${totalChars} chars total; full content on demand at ${ref}]`
  const maxPrefixBytes = cap - Buffer.byteLength(pointer)
  if (maxPrefixBytes < 0) {
    throw new AdeError('pack_budget_exceeded', `seção ${name}: teto ${cap} não comporta o ponteiro de truncagem`, 2)
  }
  const prefix = truncateToByteLimit(body, maxPrefixBytes)
  return prefix + pointer
}

/**
 * Grava por arquivo temporário + rename, para que um leitor nunca veja o arquivo pela metade.
 *
 * @param {string} filePath
 * @param {string} text
 * @returns {void}
 */
function writeFileAtomic(filePath, text) {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(tmpPath, text, 'utf8')
  fs.renameSync(tmpPath, filePath)
}

/**
 * @typedef {Object} CompilePackOptions
 * @property {string} missionDir
 * @property {string} stepId
 * @property {{contract: string, policy: string, story: string}} sections
 * @property {{max_pack_bytes?: number, section_bytes?: Partial<Record<string, number>>}} [limits]
 * @property {number} [savedBytes]
 */

/**
 * @typedef {Object} CompilePackResult
 * @property {string} pack_path
 * @property {string} manifest_path
 * @property {{sections: Array<{section: string, ref: string, bytes: number, digest: string, truncated: boolean}>, bytes: number, digest: string, redactions: Array<{pattern: string, count: number}>, dedup: {contract_bytes: number, saved_bytes: number}}} manifest
 */

/**
 * Monta o Context Pack a partir das três seções, redige segredos uma única vez,
 * aplica os tetos por seção e grava pack.md, manifest.json e os corpos íntegros como artefatos.
 *
 * @param {CompilePackOptions} options
 * @returns {CompilePackResult}
 */
export function compilePack(options) {
  validateOptions(options)
  const { missionDir, stepId, sections, limits, savedBytes } = options
  validateSections(sections)

  const id = safeId(stepId)
  const sectionCaps = { ...SECTION_CAPS, ...limits?.section_bytes }
  const maxPackBytes = limits?.max_pack_bytes ?? DEFAULT_MAX_PACK_BYTES

  const rawPack = buildRawPack(sections)
  const { text: redactedPack, redactions } = redactText(rawPack)
  const redactedBodies = splitPackSections(redactedPack)

  /** @type {Record<string, string>} */
  const finalBodies = {}
  for (const name of SECTION_ORDER) {
    const cap = /** @type {number} */ (sectionCaps[name])
    finalBodies[name] = capSection(name, redactedBodies[name], cap, `art:packs/${id}/${name}`)
  }

  const finalPackText = SECTION_ORDER.map((name) => sectionHeader(name) + finalBodies[name] + '\n').join('')
  const totalBytes = Buffer.byteLength(finalPackText)
  if (totalBytes > maxPackBytes) {
    throw new AdeError('pack_budget_exceeded', `pack excede ${maxPackBytes} bytes`, 2)
  }

  const manifest = {
    sections: SECTION_ORDER.map((name) => ({
      section: name,
      ref: `art:packs/${id}/${name}`,
      bytes: Buffer.byteLength(finalBodies[name]),
      digest: digest16(finalBodies[name]),
      truncated: finalBodies[name] !== redactedBodies[name],
    })),
    bytes: totalBytes,
    digest: digest16(finalPackText),
    redactions,
    dedup: {
      contract_bytes: Buffer.byteLength(finalBodies.contract),
      saved_bytes: savedBytes ?? 0,
    },
  }

  const packDir = path.join(missionDir, 'artifacts', 'packs', id)
  const packPath = path.join(packDir, 'pack.md')
  const manifestPath = path.join(packDir, 'manifest.json')
  // Os corpos integrais redigidos saem primeiro; writeRawArtifact cria e confere
  // a contenção física de artifacts/packs/<id>, onde pack.md e manifest.json vão depois.
  for (const name of SECTION_ORDER) {
    writeRawArtifact({ missionDir, ref: `packs/${id}/${name}`, text: redactedBodies[name] })
  }
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2))
  writeFileAtomic(packPath, finalPackText)

  return { pack_path: packPath, manifest_path: manifestPath, manifest }
}
