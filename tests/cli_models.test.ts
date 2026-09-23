import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'
import { main } from '../src/cli/models.ts'
import { readManualQuota } from '../src/models/settings.ts'

const NOW = Date.parse('2026-09-21T00:00:00Z')
let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) removeTmpDir(d)
  dirs = []
})

function repo(config: Record<string, unknown> = { stories_dir: 'x' }) {
  const dir = makeTmpDir('cli-models-')
  dirs.push(dir)
  mkdirSync(path.join(dir, '.ade'), { recursive: true })
  writeFileSync(path.join(dir, '.ade', 'config.json'), JSON.stringify(config))
  return dir
}
const sink = () => { const s = { text: '', write(t: string) { s.text += t } }; return s }
const noOfficial = { readReceipt: async () => null }
async function run(dir: string, ...args: string[]) {
  const stdout = sink()
  const stderr = sink()
  const code = await main([...args, '--repo', dir], { stdout, stderr, now: () => NOW, quotaPort: noOfficial })
  return { code, out: stdout.text, err: stderr.text }
}
const config = (dir: string) => JSON.parse(readFileSync(path.join(dir, '.ade', 'config.json'), 'utf8'))

describe('ade models', () => {
  test('CA10: plan, block e unblock mudam só a chave models; desconhecidos saem com 2', async () => {
    const dir = repo()
    expect((await run(dir, 'plan', 'claude', 'max20')).code).toBe(0)
    expect((await run(dir, 'block', 'gpt-6-astra')).code).toBe(0)
    expect(config(dir)).toEqual({ stories_dir: 'x', models: { plans: { claude: 'max20' }, blocked: ['gpt-6-astra'], effort: {} } })
    expect((await run(dir, 'unblock', 'gpt-6-astra')).code).toBe(0)
    expect(config(dir).models.blocked).toEqual([])
    const before = readFileSync(path.join(dir, '.ade', 'config.json'), 'utf8')
    expect((await run(dir, 'plan', 'claude', 'ultra')).code).toBe(2)
    expect((await run(dir, 'plan', 'openai', 'plus')).code).toBe(2)
    expect((await run(dir, 'block', 'gpt-9')).code).toBe(2)
    expect(readFileSync(path.join(dir, '.ade', 'config.json'), 'utf8')).toBe(before)
  })

  test('CA7: esforço fixado grava; esforço fora da lista sai com 2 sem alterar a configuração', async () => {
    const dir = repo()
    expect((await run(dir, 'effort', 'impl', 'high')).code).toBe(0)
    expect(config(dir).models.effort).toEqual({ impl: 'high' })
    const before = readFileSync(path.join(dir, '.ade', 'config.json'), 'utf8')
    expect((await run(dir, 'effort', 'impl', 'ultra')).code).toBe(2)
    expect((await run(dir, 'effort', 'nada', 'high')).code).toBe(2)
    expect(readFileSync(path.join(dir, '.ade', 'config.json'), 'utf8')).toBe(before)
  })

  test('CA9: cota à mão vale até a renovação como manual; fora de 0 a 100 ou data inválida sai com 2 sem gravar', async () => {
    const dir = repo()
    const r = await run(dir, 'quota', 'agy', '40', '--resets', '2026-09-28T00:00:00Z')
    expect(r.code).toBe(0)
    expect(r.out).toBe('Google: 40% (manual, renova 28/09)\n')
    expect(readManualQuota(dir, NOW).agy).toEqual({ used: 40, resets_at: '2026-09-28T00:00:00.000Z', source: 'manual' })
    expect(readManualQuota(dir, Date.parse('2026-09-28T00:00:01Z')).agy).toBeUndefined()
    const other = repo()
    expect((await run(other, 'quota', 'agy', '140', '--resets', '2026-09-28T00:00:00Z')).code).toBe(2)
    expect((await run(other, 'quota', 'agy', '40', '--resets', 'amanhã')).code).toBe(2)
    expect((await run(other, 'quota', 'agy', '40')).code).toBe(2)
    expect(existsSync(path.join(other, '.ade', 'quota-manual.json'))).toBe(false)
  })

  test('CA11: sem argumentos mostra planos, cota com origem e a fila de cada papel com o porquê', async () => {
    const dir = repo({ models: { plans: { claude: 'max20', codex: 'plus', agy: 'ai_pro' } } })
    await run(dir, 'quota', 'agy', '40', '--resets', '2026-09-28T00:00:00Z')
    const r = await run(dir)
    expect(r.code).toBe(0)
    expect(r.out).toContain('Claude: Max 20x · cota estimada pelo plano')
    expect(r.out).toContain('Google: AI Pro · cota 40% (manual, renova 28/09)')
    expect(r.out).toContain('código comum (impl)')
    expect(r.out).toContain('correção (escada) (fix)')
    expect(r.out).toMatch(/1\. Opus 5\.5 \(\w+\): nota [\d.]+ · inteligência \d+ · .* · cota projetada/)
    // a leitura oficial vence a manual da mesma empresa
    const stdout = sink()
    const official = { readReceipt: async ({ family }: { family: string }) => family === 'agy' ? { used_percent: 70, weekly_reset_at: '2026-09-27T00:00:00Z' } : null }
    await main(['--repo', dir], { stdout, stderr: sink(), now: () => NOW, quotaPort: official })
    expect(stdout.text).toContain('Google: AI Pro · cota 70% (oficial, renova 27/09)')
  })
})
