import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const PUBLICATION_PATH = fileURLToPath(new URL('../docs/plans/v02-local-publicacao.md', import.meta.url))
const ADR_0012_PATH = fileURLToPath(new URL('../docs/adr/0012-engine-dono-de-worktree-e-processo.md', import.meta.url))
const ADR_0013_PATH = fileURLToPath(new URL('../docs/adr/0013-painel-projecao-takeover-por-comando-pty-depois.md', import.meta.url))

const COMMIT_REF = '90d6ae5faf9b72cbf5e4d0632ec8612bd6d5fa91'
const BLOB_0012 = 'ee36558062e07bc5e45cd59ae362d9005e2a4a0f'
const BLOB_0013 = 'd4c6fcfd017f72acb1ab32275a75602e2fb4c489'

const ADR_0012_LF = '486835fb73467394cb21737dfd8130cb3e50ce4aa62bfe0827cdf20f593bd754'
const ADR_0012_CRLF = '45d05f4dfe4b4df519c8c3f31e27bf2de089dc213c8fdf0da26cc1c3fb1f9835'
const ADR_0012_CRLF_FIXTURE = 'f6e497a7a8792c87c4df43d29fb22d5930a08e90e98b1689eb5939586b02be7f'

const ADR_0013_LF = '5fa1ea54f9674a75cd2ba02863c3666eaf5163ce96476cf30a9f9aa828e33ffd'
const ADR_0013_CRLF = '203e92cb9315355de822bf5e6466db4b69724d035b161647639c1ce96e738892'
const ADR_0013_CRLF_FIXTURE = '63b906efd82a8b717ada6871ba17d23d40491db36e30c61319cf8fa7b6046357'

const ALLOWED_HASHES: Record<'0012' | '0013', string[]> = {
  '0012': [ADR_0012_LF, ADR_0012_CRLF, ADR_0012_CRLF_FIXTURE],
  '0013': [ADR_0013_LF, ADR_0013_CRLF, ADR_0013_CRLF_FIXTURE],
}

const DIAGNOSTIC_DIVERGENT = 'Integridade divergente; restauração não autorizada'

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function publication(): string {
  return existsSync(PUBLICATION_PATH) ? readFileSync(PUBLICATION_PATH, 'utf8') : ''
}

function section(text: string, start: string, end?: string): string {
  const from = text.indexOf(start)
  if (from < 0) return ''
  if (!end) return text.slice(from)
  const to = text.indexOf(end, from + start.length)
  return to < 0 ? text.slice(from) : text.slice(from, to)
}

function checkIntegrity(bytes: Buffer, allowedHashes: string[]): { ok: boolean; diagnostic: string; hash: string } {
  const hash = sha256(bytes)
  if (!allowedHashes.includes(hash)) {
    return { ok: false, diagnostic: DIAGNOSTIC_DIVERGENT, hash }
  }
  return { ok: true, diagnostic: 'ok', hash }
}

describe('publicação e integridade dos ADRs aceitos v0.2', () => {
  test('CA1 registro publicado encontra o commit de referência e os identificadores de blob dos dois ADRs', () => {
    expect(existsSync(PUBLICATION_PATH), 'registro de publicação ausente').toBe(true)
    const text = publication()
    const refSection = section(text, '## Referência', '\n## Integridade')
    expect(refSection).toContain(COMMIT_REF)
    expect(refSection).toContain('docs/adr/0012-engine-dono-de-worktree-e-processo.md')
    expect(refSection).toContain(BLOB_0012)
    expect(refSection).toContain('docs/adr/0013-painel-projecao-takeover-por-comando-pty-depois.md')
    expect(refSection).toContain(BLOB_0013)
    expect(refSection).toContain('leitura local desta compilação')
  })

  test('CA2 bytes reais e fixtures LF e CRLF dos ADRs 0012 e 0013 têm integridade aceita pela lista permitida', () => {
    expect(existsSync(PUBLICATION_PATH), 'registro de publicação ausente').toBe(true)
    const text = publication()
    const integritySection = section(text, '## Integridade', '\n## Limite do contrato')
    expect(integritySection).toContain(ADR_0012_LF)
    expect(integritySection).toContain(ADR_0012_CRLF)
    expect(integritySection).toContain(ADR_0013_LF)
    expect(integritySection).toContain(ADR_0013_CRLF)

    const adrs = [
      { id: '0012' as const, path: ADR_0012_PATH, lf: ADR_0012_LF },
      { id: '0013' as const, path: ADR_0013_PATH, lf: ADR_0013_LF },
    ]

    for (const { id, path, lf } of adrs) {
      expect(existsSync(path), `${path} deve existir`).toBe(true)
      const bytes = readFileSync(path)
      const allowed = ALLOWED_HASHES[id]

      // Bytes reais
      const realResult = checkIntegrity(bytes, allowed)
      expect(realResult.ok).toBe(true)
      expect(allowed).toContain(realResult.hash)

      // Fixture LF
      const fixtureLF = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
      const lfResult = checkIntegrity(fixtureLF, allowed)
      expect(lfResult.ok).toBe(true)
      expect(lfResult.hash).toBe(lf)

      // Fixture CRLF
      const fixtureCRLF = Buffer.from(bytes.toString('utf8').replace(/(?<!\r)\n/g, '\r\n'), 'utf8')
      const crlfResult = checkIntegrity(fixtureCRLF, allowed)
      expect(crlfResult.ok).toBe(true)
      expect(allowed).toContain(crlfResult.hash)
    }
  })

  test('CA3 buffer de ADR com byte adicional é rejeitado com mensagem de restauração não autorizada', () => {
    expect(existsSync(PUBLICATION_PATH), 'registro de publicação ausente').toBe(true)
    const text = publication()
    const integritySection = section(text, '## Integridade', '\n## Limite do contrato')
    expect(integritySection).toContain(DIAGNOSTIC_DIVERGENT)

    const adrs = [
      { id: '0012' as const, path: ADR_0012_PATH },
      { id: '0013' as const, path: ADR_0013_PATH },
    ]

    for (const { id, path } of adrs) {
      const bytes = readFileSync(path)
      const corrupted = Buffer.concat([bytes, Buffer.from('!')])
      const result = checkIntegrity(corrupted, ALLOWED_HASHES[id])
      expect(result.ok).toBe(false)
      expect(result.diagnostic).toBe(DIAGNOSTIC_DIVERGENT)
    }
  })

  test('CA4 registro distingue preservação verificada de restauração não executada e bloqueia divergência futura', () => {
    expect(existsSync(PUBLICATION_PATH), 'registro de publicação ausente').toBe(true)
    const text = publication()
    const limitSection = section(text, '## Limite do contrato')
    expect(limitSection).toContain('preservação verificada')
    expect(limitSection).toContain('restauração não executada')
    expect(limitSection).toContain('divergência futura')
    expect(limitSection).toContain('bloqueia alterações dependentes')
    expect(limitSection).toContain('não autoriza restaurar arquivos')
    expect(limitSection).toContain('nem enfraquecer provas')
  })
})
