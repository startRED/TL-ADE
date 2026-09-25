import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.ts'
import { safeId, writeRawArtifact } from '../gates/output.ts'
import { digest16 } from '../journal/canonical.ts'
import { screenResearchFinding } from './firewall.ts'
import { redactText } from './redact.ts'

/**
 * Ordem fixa das seções do Context Pack.
 */
export const SECTION_ORDER: readonly string[] = Object.freeze(['contract', 'policy', 'story', 'retrieved', 'skills'])

/**
 * Tetos por seção, em bytes UTF-8.
 */
export const SECTION_CAPS: Readonly<Record<string,number>> = Object.freeze({
  contract: 32000,
  policy: 8000,
  story: 24000,
  retrieved: 6000,
  // skills pesadas (impeccable, taste) entram inteiras: decisão de Erick 2026-09-25, sem teto por skill
  skills: 320000,
})

const DEFAULT_MAX_PACK_BYTES = 400000

function isPlainObject(value: unknown): value is Record<string,unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isExistingDirectory(dir: string): boolean {
  const stat = fs.statSync(dir, { throwIfNoEntry: false })
  return stat !== undefined && stat.isDirectory()
}

// Em modo `u`, um par substituto bem formado é um único code point; só o surrogate isolado casa.
const LONE_SURROGATE = /\p{Surrogate}/u

function invalidInput(message: string): AdeError {
  return new AdeError('invalid_pack_section', message, 2)
}

/**
 * Recusa opções, missionDir, stepId e limits inválidos antes de qualquer gravação.
 *
 */
function validateOptions(options: unknown): void {
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

function validateSections(sections: unknown): void {
  if (!sections || typeof sections !== 'object') {
    throw new AdeError('invalid_pack_section', 'seções inválidas: objeto ausente', 2)
  }
  const record = (sections as Record<string, unknown>)
  for (const key of Object.keys(record)) {
    if (!SECTION_ORDER.includes(key)) {
      throw new AdeError('invalid_pack_section', `seção desconhecida: ${key}`, 2)
    }
  }
  for (const name of SECTION_ORDER) {
    let body = record[name]
    if (body === undefined && (name === 'skills' || name === 'retrieved')) {
      body = ''
      record[name] = ''
    }
    if (typeof body !== 'string' || body.includes('=== ade:section ') || LONE_SURROGATE.test(body)) {
      throw new AdeError('invalid_pack_section', `seção inválida: ${name}`, 2)
    }
  }
}

function sectionHeader(name: string): string {
  return `=== ade:section ${name} ===\n`
}

/**
 * Bytes de cada seção como ela aparece no pack.md (cabeçalho, corpo e quebra final), para que a
 * soma das seções da telemetria feche com `manifest.bytes`.
 *
 */
export function telemetrySections(manifest: { sections: Array<{ section: string; bytes: number; digest: string }> }): Array<{ section: string; bytes: number; digest: string }> {
  return manifest.sections.map((s) => ({
    section: s.section,
    bytes: Buffer.byteLength(sectionHeader(s.section)) + s.bytes + 1,
    digest: s.digest,
  }))
}

function buildRawPack(sections: Record<string,string>): string {
  // Sem dado recuperado a seção nem aparece: o pack sem pesquisa mantém o formato anterior.
  return SECTION_ORDER.filter((name) => name !== 'retrieved' || sections[name] !== '')
    .map((name) => sectionHeader(name) + sections[name] + '\n')
    .join('')
}

/**
 * Mede, sem gravar nada, quantos bytes o pack ocuparia com estas seções.
 *
 */
export function measurePackBytes(sections: { contract: string; policy: string; story: string; retrieved?: string; skills?: string }): number {
  validateSections(sections)
  return Buffer.byteLength(buildRawPack(sections), 'utf8')
}

/**
 * Separa de volta os corpos de cada seção a partir do texto do pack montado.
 *
 */
function splitPackSections(text: string): Record<string,string> {
  const bodies: Record<string,string> = {}
  for (let i = 0; i < SECTION_ORDER.length; i++) {
    const name = SECTION_ORDER[i]
    const marker = sectionHeader(name)
    const start = text.indexOf(marker)
    if (start === -1) {
      bodies[name] = ''
      continue
    }
    const bodyStart = start + marker.length
    const nextIdx =
      SECTION_ORDER.slice(i + 1)
        .map((next) => text.indexOf(sectionHeader(next), bodyStart))
        .find((idx) => idx !== -1) ?? -1
    const bodyEnd = nextIdx === -1 ? text.length : nextIdx
    bodies[name] = text.slice(bodyStart, bodyEnd).replace(/\n$/, '')
  }
  return bodies
}

/**
 * Corta `body` no maior prefixo cujo tamanho em bytes UTF-8 não passa de `maxBytes`,
 * recuando a fronteira do corte para nunca partir um par substituto (surrogate pair) ao meio.
 *
 */
function truncateToByteLimit(body: string, maxBytes: number): string {
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
 */
function capSection(name: string, body: string, cap: number, ref: string): string {
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
 */
function writeFileAtomic(filePath: string, text: string): void {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(tmpPath, text, 'utf8')
  fs.renameSync(tmpPath, filePath)
}

export type CompilePackOptions = {
  missionDir: string
  stepId: string
  sections: {contract: string, policy: string, story: string, retrieved?: string, skills?: string}
  limits?: {max_pack_bytes?: number, section_bytes?: Partial<Record<string, number>>}
  savedBytes?: number
  skills?: Array<{name: string, source: string, sha256: string, bytes: number, cited?: boolean}>
  artifactRefs?: string[]
}

export type CompilePackResult = {
  pack_path: string
  manifest_path: string
  manifest: {sections: Array<{section: string, ref: string, bytes: number, digest: string, truncated: boolean}>, bytes: number, digest: string, redactions: Array<{pattern: string, count: number}>, dedup: {contract_bytes: number, saved_bytes: number}}
}

/**
 * Monta o Context Pack a partir das seções, redige segredos uma única vez,
 * aplica os tetos por seção e grava pack.md, manifest.json e os corpos íntegros como artefatos.
 *
 */
export function compilePack(options: CompilePackOptions): CompilePackResult {
  validateOptions(options)
  const { missionDir, stepId, sections: providedSections, limits, savedBytes } = options
  const planPath = path.join(missionDir, 'plan.json')
  const findings: any[] = fs.existsSync(planPath)
    ? (JSON.parse(fs.readFileSync(planPath, 'utf8')).briefing?.research_findings ?? [])
    : []
  const screenedResearch = findings.map((finding) => screenResearchFinding(finding, { missionDir }))
  const researchText = screenedResearch.map((item) => item.fencedText).join('\n\n')
  const sections = {
    ...providedSections,
    ...(researchText
      ? { retrieved: [providedSections.retrieved, researchText].filter(Boolean).join('\n\n') }
      : {}),
  }
  validateSections(sections)
  const names = SECTION_ORDER.filter((name) => name !== 'retrieved' || sections.retrieved !== '')

  const id = safeId(stepId)
  const sectionCaps = { ...SECTION_CAPS, ...limits?.section_bytes }
  const maxPackBytes = limits?.max_pack_bytes ?? DEFAULT_MAX_PACK_BYTES

  const rawPack = buildRawPack(sections)
  const { text: redactedPack, redactions } = redactText(rawPack)
  const redactedBodies = splitPackSections(redactedPack)

  const finalBodies: Record<string,string> = {}
  for (const name of names) {
    const cap = (sectionCaps[name] as number)
    finalBodies[name] = capSection(name, redactedBodies[name], cap, `art:packs/${id}/${name}`)
  }

  const finalPackText = names.map((name) => sectionHeader(name) + finalBodies[name] + '\n').join('')
  const totalBytes = Buffer.byteLength(finalPackText)
  if (totalBytes > maxPackBytes) {
    throw new AdeError('pack_budget_exceeded', `pack excede ${maxPackBytes} bytes`, 2)
  }

  const manifest = {
    sections: names.map((name) => ({
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
    ...(options.skills ? { skills: options.skills } : {}),
    ...((options.artifactRefs || screenedResearch.length > 0)
      ? { artifact_refs: [...(options.artifactRefs || []), ...screenedResearch.map((item) => item.rawRef)] }
      : {}),
    ...(screenedResearch.length > 0
      ? {
          research_sources: screenedResearch.map((item) => ({
            ref: item.rawRef,
            digest: item.digest,
            source: `source:research@sha256:${item.digest}`,
          })),
        }
      : {}),
  }

  const packDir = path.join(missionDir, 'artifacts', 'packs', id)
  const packPath = path.join(packDir, 'pack.md')
  const manifestPath = path.join(packDir, 'manifest.json')
  // Os corpos integrais redigidos saem primeiro; writeRawArtifact cria e confere
  // a contenção física de artifacts/packs/<id>, onde pack.md e manifest.json vão depois.
  for (const name of names) {
    writeRawArtifact({ missionDir, ref: `packs/${id}/${name}`, text: redactedBodies[name] })
  }
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2))
  writeFileAtomic(packPath, finalPackText)

  return { pack_path: packPath, manifest_path: manifestPath, manifest }
}

/** Pack da chamada para a telemetria: seções com bytes e digest, ou o pack inteiro quando o manifesto não as lista. */
export function packTelemetry(manifest: any) {
  if (Array.isArray(manifest?.sections)) return { sections: telemetrySections(manifest), bytes: manifest.bytes }
  return { sections: [{ section: 'pack', bytes: manifest.bytes, digest: String(manifest.digest ?? '') }], bytes: manifest.bytes }
}
