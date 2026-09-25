import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.ts'

export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** Teto do corpo de POST /requests: 10 anexos em base64 (+1/3) e folga para o texto. */
export const REQUEST_BODY_LIMIT = Math.ceil(MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES * 4 / 3) + 1024 * 1024

export interface Attachment { name: string; bytes: Buffer }
export interface AttachmentRecord { name: string; size: number; path: string }

const SIGNATURES: Record<string, Buffer[] | null> = {
  '.png': [Buffer.from('89504e470d0a1a0a', 'hex')],
  '.jpg': [Buffer.from('ffd8ff', 'hex')],
  '.jpeg': [Buffer.from('ffd8ff', 'hex')],
  '.gif': [Buffer.from('GIF87a'), Buffer.from('GIF89a')],
  '.webp': [Buffer.from('RIFF')],
  '.pdf': [Buffer.from('%PDF-')],
  '.txt': null,
  '.md': null,
}

const invalid = (message: string) => new AdeError('anexo_invalido', message, 2)

function saneName(raw: string, used: Set<string>): string {
  const base = raw.split(/[/\\]/).pop()!.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[.\s]+/, '').trim().slice(0, 120) || 'anexo'
  const ext = path.extname(base)
  let name = base
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${path.basename(base, ext)}-${i}${ext}`
  used.add(name.toLowerCase())
  return name
}

/** Valida a lista vinda do painel ({name, data base64}); lança 400 em português. */
export function parseAttachments(input: unknown): Attachment[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw invalid('Anexos devem vir em lista.')
  if (input.length > MAX_ATTACHMENTS) throw invalid(`Limite de ${MAX_ATTACHMENTS} arquivos por pedido.`)
  const used = new Set<string>()
  return input.map((item) => {
    if (!item || typeof item.name !== 'string' || typeof item.data !== 'string') throw invalid('Anexo sem nome ou conteúdo.')
    const bytes = Buffer.from(item.data, 'base64')
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw invalid(`O arquivo "${item.name}" passa do limite de 10 MB.`)
    const name = saneName(item.name, used)
    const ext = path.extname(name).toLowerCase()
    const sigs = SIGNATURES[ext]
    const typeOk = sigs !== undefined && (sigs === null || sigs.some((s) => bytes.subarray(0, s.length).equals(s)))
      && (ext !== '.webp' || bytes.subarray(8, 12).toString('latin1') === 'WEBP')
    if (!typeOk) throw invalid(`Tipo do arquivo "${item.name}" não é aceito (use PNG, JPEG, GIF, WebP, PDF, .txt ou .md).`)
    return { name, bytes }
  })
}

/** Grava em <missionDir>/attachments; o nome já saneado nunca sai da pasta. */
export function saveAttachments(missionDir: string, files: Attachment[]): AttachmentRecord[] {
  if (!files.length) return []
  const dir = path.join(missionDir, 'attachments')
  fs.mkdirSync(dir, { recursive: true })
  return files.map(({ name, bytes }) => {
    const target = path.resolve(dir, name)
    if (path.dirname(target) !== path.resolve(dir)) throw invalid('Nome de anexo inválido.')
    fs.writeFileSync(target, bytes)
    return { name, size: bytes.length, path: `attachments/${name}` }
  })
}
