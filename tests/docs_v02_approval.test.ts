import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const APPROVAL_PATH = fileURLToPath(new URL('../docs/plans/v02-local-aprovacao.md', import.meta.url))
const PROPOSAL_PATH = fileURLToPath(new URL('../docs/plans/v02-local-proposta.md', import.meta.url))
const PREFIX = Buffer.from('<!-- proposta:utf8:inicio -->\n')
const SUFFIX = Buffer.from('\n<!-- proposta:utf8:fim -->')
const DECISION_IDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'] as const

type DecisionId = typeof DECISION_IDS[number]
type RecordId = DecisionId | 'minuta_adr_0024'
type RecordRow = {
  id: RecordId
  estado: 'pendente' | 'aprovado' | 'recusado' | 'aprovada' | 'recusada'
  resposta: string
  origem: string
  data: string
  proposta_sha256: string
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function occurrenceCount(haystack: Buffer, needle: Buffer): number {
  let count = 0
  let offset = 0
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1
    offset += needle.length
  }
  return count
}

function extractSubmittedBlob(consultation: Buffer): Buffer | null {
  if (occurrenceCount(consultation, PREFIX) !== 1 || occurrenceCount(consultation, SUFFIX) !== 1) {
    return null
  }
  const start = consultation.indexOf(PREFIX) + PREFIX.length
  const end = consultation.indexOf(SUFFIX, start)
  return end < start ? null : consultation.subarray(start, end)
}

function proposalHashField(text: string): string {
  return text.match(/^proposta_sha256: `([0-9a-f]{64})`$/m)?.[1] ?? ''
}

function markdownRows(text: string, heading: string): RecordRow[] {
  const start = text.indexOf(heading)
  const next = text.indexOf('\n## ', start + heading.length)
  const section = start < 0 ? '' : text.slice(start, next < 0 ? undefined : next)
  const lines = section.split(/\r?\n/).filter((line) => line.startsWith('|'))
  if (lines.length < 3) return []
  const cells = (line: string) => line.split('|').slice(1, -1).map((cell) => cell.trim())
  const headers = cells(lines[0])
  return lines.slice(2).map((line) => {
    const values = cells(line)
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
    return {
      id: row.id as RecordId,
      estado: row.estado as RecordRow['estado'],
      resposta: row['resposta literal'],
      origem: row.origem,
      data: row.data,
      proposta_sha256: row.proposta_sha256,
    }
  })
}

function recordFixture(
  resposta: string,
  origem: string,
  data: string,
  submittedHash: string,
  responseHash: string,
): RecordRow[] {
  const applicable = resposta.length > 0 && responseHash === submittedHash
  const approvesAll = /aprovo D1 a D6/i.test(resposta)
  const approvedIds = /\baprovo\b/i.test(resposta)
    ? new Set([...resposta.matchAll(/\bD[1-6]\b/g)].map((match) => match[0]))
    : new Set<string>()
  const rejects = (id: DecisionId) => new RegExp(`\\brecuso ${id}\\b`, 'i').test(resposta)
  const approves = (id: DecisionId) => approvesAll || approvedIds.has(id)
  const answered = (state: RecordRow['estado']) => state !== 'pendente'
  const decisions = DECISION_IDS.map((id): RecordRow => {
    const estado = applicable && rejects(id) ? 'recusado' : applicable && approves(id) ? 'aprovado' : 'pendente'
    return {
      id,
      estado,
      resposta: answered(estado) ? resposta : 'não recebida',
      origem: answered(estado) ? origem : 'não recebida',
      data: answered(estado) ? data : 'não recebida',
      proposta_sha256: submittedHash,
    }
  })
  const minuteApproved = /aprovo expressamente a minuta do ADR 0024/i.test(resposta)
  const minuteRejected = /recuso expressamente a minuta do ADR 0024/i.test(resposta)
  const minuteState = applicable && minuteRejected
    ? 'recusada'
    : applicable && minuteApproved
      ? 'aprovada'
      : 'pendente'
  decisions.push({
    id: 'minuta_adr_0024',
    estado: minuteState,
    resposta: minuteState === 'pendente' ? 'não recebida' : resposta,
    origem: minuteState === 'pendente' ? 'não recebida' : origem,
    data: minuteState === 'pendente' ? 'não recebida' : data,
    proposta_sha256: submittedHash,
  })
  return decisions
}

describe('registro de aprovação da proposta local v0.2', () => {
  test('CA1 extrai o blob byte a byte e vincula seu SHA-256 ao campo registrado', () => {
    const blob = Buffer.from('abc', 'utf8')
    const expectedHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    const fixture = Buffer.concat([PREFIX, blob, SUFFIX])
    expect(extractSubmittedBlob(fixture)).toEqual(blob)
    expect(sha256(extractSubmittedBlob(fixture) ?? Buffer.alloc(0))).toBe(expectedHash)

    const changed = Buffer.concat([PREFIX, Buffer.from('abc\n'), SUFFIX])
    expect(sha256(extractSubmittedBlob(changed) ?? Buffer.alloc(0))).not.toBe(expectedHash)
    expect(extractSubmittedBlob(Buffer.concat([fixture, PREFIX]))).toBeNull()

    expect(existsSync(APPROVAL_PATH), 'registro de aprovação ausente').toBe(true)
    const approval = readFileSync(APPROVAL_PATH)
    const proposal = readFileSync(PROPOSAL_PATH)
    const submitted = extractSubmittedBlob(approval)
    expect(submitted).toEqual(proposal)
    expect(sha256(submitted ?? Buffer.alloc(0))).toBe(proposalHashField(approval.toString('utf8')))
    expect(approval.toString('utf8')).toContain('consulta inválida: delimitador presente na proposta')
  })

  test('CA2 registra somente decisões inequívocas e a aprovação expressa separada da minuta', () => {
    const hash = 'a'.repeat(64)
    const resposta = 'Aprovo D1 e D3 e aprovo expressamente a minuta do ADR 0024'
    const rows = recordFixture(resposta, 'fixture:mensagem-001', '2026-09-19', hash, hash)
    const byId = new Map(rows.map((row) => [row.id, row]))

    expect(byId.get('D1')?.estado).toBe('aprovado')
    expect(byId.get('D3')?.estado).toBe('aprovado')
    expect(byId.get('minuta_adr_0024')?.estado).toBe('aprovada')
    for (const id of ['D1', 'D3', 'minuta_adr_0024'] as const) {
      expect(byId.get(id)).toMatchObject({ resposta, origem: 'fixture:mensagem-001', data: '2026-09-19' })
      expect(byId.get(id)?.proposta_sha256).toBe(hash)
    }
    for (const id of ['D2', 'D4', 'D5', 'D6'] as const) expect(byId.get(id)?.estado).toBe('pendente')

    const refusal = recordFixture('Recuso D2', 'fixture:mensagem-002', '2026-09-19', hash, hash)
    expect(refusal.find((row) => row.id === 'D2')?.estado).toBe('recusado')

    const approval = existsSync(APPROVAL_PATH) ? readFileSync(APPROVAL_PATH, 'utf8') : ''
    const actualRows = [
      ...markdownRows(approval, '## Decisões D1–D6'),
      ...markdownRows(approval, '## Aprovação separada da minuta'),
    ]
    expect(actualRows.map((row) => row.id)).toEqual([...DECISION_IDS, 'minuta_adr_0024'])
    expect(actualRows.map((row) => row.estado)).toEqual([
      'pendente', 'pendente', 'pendente', 'pendente', 'pendente', 'pendente', 'pendente',
    ])
    for (const row of actualRows) {
      expect(row).toMatchObject({ resposta: 'não recebida', origem: 'não recebida', data: 'não recebida' })
      expect(row.proposta_sha256).toBe(proposalHashField(approval))
    }
  })

  test('CA3 mantém bloqueios para resposta ausente, parcial, sem minuta expressa ou com hash divergente', () => {
    const hash = 'b'.repeat(64)
    const absent = recordFixture('', 'fixture:mensagem-003', '2026-09-19', hash, hash)
    expect(absent.every((row) => row.estado === 'pendente')).toBe(true)

    const partial = recordFixture('Aprovo D1', 'fixture:mensagem-004', '2026-09-19', hash, hash)
    expect(partial.find((row) => row.id === 'D1')?.estado).toBe('aprovado')
    expect(partial.filter((row) => row.id !== 'D1').every((row) => row.estado === 'pendente')).toBe(true)

    const decisionsOnly = recordFixture('Aprovo D1 a D6', 'fixture:mensagem-005', '2026-09-19', hash, hash)
    expect(decisionsOnly.filter((row) => row.id !== 'minuta_adr_0024').every((row) => row.estado === 'aprovado')).toBe(true)
    expect(decisionsOnly.find((row) => row.id === 'minuta_adr_0024')?.estado).toBe('pendente')

    const wrongHash = recordFixture(
      'Aprovo D1 a D6 e a minuta do ADR 0024',
      'fixture:mensagem-006',
      '2026-09-19',
      hash,
      'c'.repeat(64),
    )
    expect(wrongHash.every((row) => row.estado === 'pendente')).toBe(true)

    const approval = existsSync(APPROVAL_PATH) ? readFileSync(APPROVAL_PATH, 'utf8') : ''
    expect(approval).toContain('Ausência, resposta parcial ou hash divergente mantém os itens não autorizados bloqueados.')
    expect(approval).toContain('Mudança solicitada não aprova a versão alterada')
    expect(approval).toContain('fechamento comprovado do Slice 1')
  })
})
