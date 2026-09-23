import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { deliveryMetrics, gitCommitsSince, renderDeliveryMetrics } from '../src/telemetry/delivery.ts'
import { main } from '../src/cli/report.ts'
import { digest16 } from '../src/journal/canonical.ts'
import { openJournal } from '../src/journal/journal.ts'
import { buildRuntimeStamp } from '../src/journal/stamp.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const ENGINE = (mission: string, story: string) =>
  `ade: parte ${story}\n\nADE-Missao: ${mission}\nADE-Parte: ${story}\nADE-Rodada: 1\nADE-Modelo: claude-opus-5-5\nADE-Chamada: 7`

const approved = (at: string) => ({ kind: 'decision', at, data: { decision: 'plan_approved', digest: 'd' } })
const done = (unit: string, at: string, commit: string | null, status = 'delivered') => ({ kind: 'story_done', at, data: { unit, status, commit } })
const review = (unit: string, round: number) => ({ kind: 'review_result', at: '2026-09-20T11:00:00Z', data: { unit, round } })

const EVENTS = [
  { kind: 'decision', at: '2026-09-20T10:00:00Z', data: { decision: 'briefing_approved', digest: 'b' } },
  approved('2026-09-20T10:20:00Z'),
  review('S1', 1),
  done('S1', '2026-09-20T11:00:00Z', 'aaa111'),
  review('S2', 1), review('S2', 2), review('S2', 3),
  review('S3', 1), review('S3', 2),
  done('S3', '2026-09-20T12:00:00Z', 'bbb222'),
]

const MISSION_COMMITS = [
  { sha: 'aaa111', date: '2026-09-20T11:00:00Z', message: ENGINE('m-1', 'S1'), files: ['src/a.ts', 'src/b.ts'] },
  { sha: 'bbb222', date: '2026-09-20T12:00:00Z', message: ENGINE('m-1', 'S3'), files: ['src/c.ts'] },
]

let tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs) removeTmpDir(dir)
  tmpDirs = []
})

describe('medição de entrega no relatório', () => {
  test('ca1_mostra_20_min_ate_a_aprovacao_e_2_h_ate_a_entrega', () => {
    const metrics = deliveryMetrics(EVENTS, MISSION_COMMITS)
    expect(metrics.to_plan_approval_ms).toBe(20 * 60_000)
    expect(metrics.to_delivery_ms).toBe(2 * 3_600_000)
    const text = renderDeliveryMetrics(metrics)
    expect(text).toContain('até a aprovação do plano: 20 min')
    expect(text).toContain('até a entrega aprovada: 2 h')
  })

  test('ca2_lista_as_rodadas_de_revisao_de_cada_parte', () => {
    const metrics = deliveryMetrics(EVENTS, MISSION_COMMITS)
    expect(metrics.rounds_by_part).toEqual({ S1: 1, S2: 3, S3: 2 })
    const text = renderDeliveryMetrics(metrics)
    expect(text).toContain('| S1 | 1 |')
    expect(text).toContain('| S2 | 3 |')
    expect(text).toContain('| S3 | 2 |')
  })

  test('ca3_commit_do_usuario_posterior_em_arquivo_do_motor_conta_como_correcao', () => {
    const user = { sha: 'ccc333', date: '2026-09-20T13:00:00Z', message: 'conserta o botão', files: ['src/b.ts', 'README.md'] }
    const metrics = deliveryMetrics(EVENTS, [user, ...MISSION_COMMITS])
    expect(metrics.user_corrections).toEqual([{ sha: 'ccc333', files: ['src/b.ts'], parts: ['S1'] }])
    expect(renderDeliveryMetrics(metrics)).toContain('| ccc333 | src/b.ts | S1 |')
  })

  test('ca4_commit_de_outra_missao_ou_do_usuario_fora_dos_arquivos_da_missao_nao_conta', () => {
    const otherMission = { sha: 'ddd444', date: '2026-09-20T13:00:00Z', message: ENGINE('m-2', 'S9'), files: ['src/a.ts'] }
    const untouched = { sha: 'eee555', date: '2026-09-20T13:30:00Z', message: 'docs', files: ['docs/x.md'] }
    const before = { sha: 'fff666', date: '2026-09-20T10:30:00Z', message: 'antes do motor', files: ['src/c.ts'] }
    const metrics = deliveryMetrics(EVENTS, [untouched, otherMission, ...MISSION_COMMITS, before])
    expect(metrics.user_corrections).toEqual([])
    expect(renderDeliveryMetrics(metrics)).toContain('correções do usuário: nenhuma')
  })

  test('ca5_missao_sem_parte_entregue_mostra_ainda_nao_entregue_sem_falhar', () => {
    const events = [
      approved('2026-09-20T10:00:00Z'),
      review('S1', 1),
      done('S1', '2026-09-20T10:40:00Z', null, 'awaiting_operator'),
    ]
    const metrics = deliveryMetrics(events, [])
    expect(metrics.to_delivery_ms).toBeNull()
    expect(renderDeliveryMetrics(metrics)).toContain('até a entrega aprovada: ainda não entregue')
  })

  test('borda_data_de_commit_invalida_falha_alto', () => {
    const bad = { sha: 'ccc333', date: 'ontem', message: 'x', files: ['src/b.ts'] }
    expect(() => deliveryMetrics(EVENTS, [bad, ...MISSION_COMMITS])).toThrow(/data/)
  })

  test('leitura_do_git_usa_maxbuffer_explicito_e_parseia_sha_data_mensagem_e_arquivos', async () => {
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> = []
    const out = `\x1eaaa111\x1f2026-09-20T11:00:00+00:00\x1f${ENGINE('m-1', 'S1')}\n\x1f\n\nsrc/a.ts\nsrc/b.ts\n\x1eccc333\x1f2026-09-20T13:00:00+00:00\x1fconserta\n\x1f\n\nsrc/b.ts\n`
    const git = { run: async (args: string[], options: Record<string, unknown> = {}) => { calls.push({ args, options }); return { code: 0, stdout: Buffer.from(out), stderr: '', text: out.trim() } } }
    const commits = await gitCommitsSince(git, '2026-09-20T10:00:00Z')
    expect(calls[0].options.maxBuffer).toEqual(expect.any(Number))
    expect(calls[0].args).toContain('--since=2026-09-20T10:00:00Z')
    expect(commits).toEqual([
      { sha: 'aaa111', date: '2026-09-20T11:00:00+00:00', message: ENGINE('m-1', 'S1'), files: ['src/a.ts', 'src/b.ts'] },
      { sha: 'ccc333', date: '2026-09-20T13:00:00+00:00', message: 'conserta', files: ['src/b.ts'] },
    ])
  })

  test('borda_git_fora_de_repositorio_mostra_correcoes_indisponiveis', async () => {
    const git = { run: async () => ({ code: 128, stdout: Buffer.alloc(0), stderr: 'not a git repository', text: '' }) }
    expect(await gitCommitsSince(git, '2026-09-20T10:00:00Z')).toBeNull()
    const text = renderDeliveryMetrics(deliveryMetrics(EVENTS, []), false)
    expect(text).toContain('correções do usuário: indisponível')
    expect(text).not.toContain('correções do usuário: nenhuma')
  })

  test('ade_report_mostra_a_secao_de_medicao_com_commits_lidos_do_git', async () => {
    const root = makeTmpDir('ade-delivery-test-')
    tmpDirs.push(root)
    const missionDir = path.join(root, '.ade', 'missions', 'm-1')
    let current = new Date()
    const journal = openJournal({ missionDir, runtimeStamp: buildRuntimeStamp({ configDigest: digest16({}), capabilitiesDigest: digest16({}) }), now: () => current })
    for (const { at, ...event } of EVENTS) {
      current = new Date(at)
      await journal.append(event)
    }
    await journal.close()
    const reads: Array<{ repoDir: string; since: string }> = []
    const readCommits = async (repoDir: string, since: string) => {
      reads.push({ repoDir, since })
      return [{ sha: 'ccc333', date: '2026-09-20T13:00:00Z', message: 'conserta', files: ['src/c.ts'] }, ...MISSION_COMMITS]
    }
    const sink = { write: () => {} }
    const code = await main(['--mission', missionDir], { env: {}, stdout: sink, stderr: sink, readCommits, quotaPort: { readReceipt: async () => null } })
    expect(code).toBe(0)
    expect(reads).toEqual([{ repoDir: path.resolve(root), since: '2026-09-20T10:00:00Z' }])
    const report = readFileSync(path.join(missionDir, 'report.md'), 'utf8')
    expect(report).toContain('## Medição de entrega')
    expect(report).toContain('até a aprovação do plano: 20 min')
    expect(report).toContain('| ccc333 | src/c.ts | S3 |')
  })
})
