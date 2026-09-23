import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { parseClaudeRateLimit, readCodexRateLimit, refreshQuotaReceipts } from '../src/adapters/local/official-quota.ts'
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

  test('grava um recibo oficial por família que a porta do motor aceita', async () => {
    const home = tmp()
    const now = Date.parse('2026-09-23T22:00:00Z')
    const written = await refreshQuotaReceipts({ home, now, readClaude: async () => CLAUDE_OUT, readCodex: () => ({ seven_day: { used_percent: 81, resets_at: '2026-09-26T08:23:58.000Z' }, observed_at: '2026-09-23T21:00:00.000Z' }) })
    expect(written.map((r) => [r.family, r.used_percent])).toEqual([['claude', 13], ['codex', 81]])
    const port = createLocalQuotaPort({ receiptPath: path.join(home, '.ade', 'quota-receipt.json') })
    expect(await port.readReceipt({ family: 'claude', now })).toMatchObject({ source: 'official', family: 'claude', used_percent: 13, reserved_percent: 0 })
    expect(await port.readReceipt({ family: 'codex', now })).toMatchObject({ family: 'codex', used_percent: 81 })
    expect(await port.readReceipt({ family: 'agy', now })).toBeNull()
  })
})
