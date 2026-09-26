import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { parseAgyQuota, parseClaudeRateLimit, readCodexRateLimit, refreshQuotaReceipts } from '../src/adapters/local/official-quota.ts'
import { createLocalQuotaPort } from '../src/adapters/local/quota.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-quota-')); dirs.push(d); return d }

// Formatos reais observados em 23/09/2026 (claude -p --output-format stream-json; ~/.codex/sessions).
const CLAUDE_OUT = [
  '{"type":"system","subtype":"init"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.03,"resetsAt":1790216400},"seven_day":{"utilization":0.13,"resetsAt":1790668800}}}}',
  '{"type":"result","result":"ok"}',
].join('\n')
const CODEX_LINE = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 81.0, window_minutes: 10080, resets_at: 1790411038 }, secondary: null, plan_type: 'prolite' } } })

describe('cota oficial dos planos', () => {
  test('lê a semana e as 5 h do rate_limit_event do claude', () => {
    expect(parseClaudeRateLimit(CLAUDE_OUT)).toEqual({
      seven_day: { used_percent: 13, resets_at: new Date(1790668800 * 1000).toISOString() },
      five_hour: { used_percent: 3, resets_at: new Date(1790216400 * 1000).toISOString() },
    })
    expect(parseClaudeRateLimit('{"type":"result"}')).toBeNull()
  })

  test('lê a janela semanal da sessão mais nova do codex', () => {
    const home = tmp()
    const day = path.join(home, '.codex', 'sessions', '2026', '09', '23')
    fs.mkdirSync(day, { recursive: true })
    fs.writeFileSync(path.join(day, 'rollout.jsonl'), `{"type":"x"}\n${CODEX_LINE}\n`)
    expect(readCodexRateLimit(home)?.seven_day).toEqual({ used_percent: 81, resets_at: new Date(1790411038 * 1000).toISOString() })
    expect(readCodexRateLimit(tmp())).toBeNull()
  })

  test('lê a semana e as 5 h do grupo Gemini no /quota do agy e ignora o grupo Claude e GPT', () => {
    // formato real de `agy -p /quota --output-format json` (1.2.9, 24/09/2026)
    const out = JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
      { name: 'Gemini Models', buckets: [
        { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.5300685167312622, reset_time: '2026-09-26T13:49:53Z' },
        { id: 'gemini-5h', window: '5h', remaining_fraction: 0.9407551288604736, reset_time: '2026-09-24T19:17:55Z' },
      ] },
      { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 0, reset_time: '2026-09-26T14:08:44Z' }] },
    ] } } })
    expect(parseAgyQuota(out)).toEqual({
      seven_day: { used_percent: 47, resets_at: '2026-09-26T13:49:53.000Z' },
      five_hour: { used_percent: 6, resets_at: '2026-09-24T19:17:55.000Z' },
    })
    expect(parseAgyQuota('jetski: no output produced')).toBeNull()
  })

  test('grava um recibo oficial por família que a porta do motor aceita', async () => {
    const home = tmp()
    const now = Date.parse('2026-09-23T22:00:00Z')
    const written = await refreshQuotaReceipts({ home, now, readClaude: async () => CLAUDE_OUT, readCodex: () => ({ seven_day: { used_percent: 81, resets_at: '2026-09-26T08:23:58.000Z' }, observed_at: '2026-09-23T21:50:00.000Z' }), probeCodex: async () => { throw new Error('leitura recente não sonda') }, readAgy: async () => '' })
    expect(written.map((r) => [r.family, r.used_percent])).toEqual([['claude', 13], ['codex', 81]])
    const port = createLocalQuotaPort({ receiptPath: path.join(home, '.ade', 'quota-receipt.json') })
    expect(await port.readReceipt({ family: 'claude', now })).toMatchObject({ source: 'official', family: 'claude', used_percent: 13, reserved_percent: 0 })
    expect(await port.readReceipt({ family: 'codex', now })).toMatchObject({ family: 'codex', used_percent: 81 })
    expect(await port.readReceipt({ family: 'agy', now })).toBeNull()
  })
  // 25/09: as chamadas do motor ao codex são efêmeras e não gravam sessão; a leitura ficou em 81% de dois dias antes
  // (26% reais, semana já virada) e o motor pulava o Codex por passar do teto. Leitura velha dispara a sonda.
  test('leitura_velha_do_codex_dispara_a_sonda_e_grava_a_nova', async () => {
    const home = tmp()
    const now = Date.parse('2026-09-25T13:00:00Z')
    let probed = 0
    const readCodex = () => probed === 0
      ? { seven_day: { used_percent: 81, resets_at: '2026-09-26T08:23:58.000Z' }, observed_at: '2026-09-23T20:58:43.000Z' }
      : { seven_day: { used_percent: 26, resets_at: '2026-10-02T08:23:58.000Z' }, observed_at: '2026-09-25T12:59:00.000Z' }
    const written = await refreshQuotaReceipts({ home, now, readClaude: async () => '', readCodex, probeCodex: async () => { probed++ }, readAgy: async () => '' })
    expect(probed).toBe(1)
    expect(written.map((r) => [r.family, r.used_percent])).toEqual([['codex', 26]])
    // sonda que não trouxe leitura nova: o número de outra semana não vira recibo
    const old = () => ({ seven_day: { used_percent: 81, resets_at: '2026-09-26T08:23:58.000Z' }, observed_at: '2026-09-23T20:58:43.000Z' })
    const stale = await refreshQuotaReceipts({ home: tmp(), now, readClaude: async () => '', readCodex: old, probeCodex: async () => {}, readAgy: async () => '' })
    expect(stale).toEqual([])
  })
  // 26/09: o painel relia a cada 3 min, mas a sonda só rodava com leitura de mais de 30 min: o Codex ficava atrasado
  test('leitura_do_codex_com_mais_de_5_min_sonda_e_sem_sonda_nova_ainda_vale_ate_30_min', async () => {
    const now = Date.parse('2026-09-26T14:40:00Z')
    const at = (min: number) => ({ seven_day: { used_percent: 39, resets_at: '2026-10-01T03:17:24.000Z' }, observed_at: new Date(now - min * 60_000).toISOString() })
    let probed = 0
    await refreshQuotaReceipts({ home: tmp(), now, readClaude: async () => '', readCodex: () => at(3), probeCodex: async () => { probed++ }, readAgy: async () => '' })
    expect(probed).toBe(0)
    // sonda que falha: a leitura de 8 min ainda é desta semana e vira recibo
    const written = await refreshQuotaReceipts({ home: tmp(), now, readClaude: async () => '', readCodex: () => at(8), probeCodex: async () => { probed++; throw new Error('codex fora') }, readAgy: async () => '' })
    expect(probed).toBe(1)
    expect(written.map((r) => [r.family, r.used_percent])).toEqual([['codex', 39]])
  })
})
