import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  drainMission,
  installShutdownDrain,
  readMissionControl,
  requestMissionControl,
} from '../src/engine/control.js'
import { resumeMission } from '../src/engine/resume.js'
import { runSequentialMission } from '../src/engine/schedule.js'
import { digest16 } from '../src/journal/canonical.js'
import { openJournal, readJournal } from '../src/journal/journal.js'
import { buildRuntimeStamp } from '../src/journal/stamp.js'
import { startServer } from '../src/panel/server.js'
import { terminateProcessTree } from '../src/runner/spawn.js'

const MISSION_ID = 'mission-ctl'
const runtimeStamp = buildRuntimeStamp({ configDigest: 'a'.repeat(16), capabilitiesDigest: 'b'.repeat(16) })

let tmpDirs: string[] = []
let journals: Array<{ close: () => Promise<void> }> = []
let servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const s of servers) await s.close()
  servers = []
  for (const j of journals) {
    try {
      await j.close()
    } catch {
      // journal já fechado pela própria prova
    }
  }
  journals = []
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs = []
})

function contractOf(id: string, deps: string[] = []) {
  return { id, task: `tarefa ${id}`, depends_on: deps, budget: { max_model_calls: 2 } }
}

/** Monta uma missão aprovada com duas stories sequenciais (S2 depende de S1). */
async function setupMission({ maxCalls = 4 }: { maxCalls?: number } = {}) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-ctl-'))
  tmpDirs.push(repoDir)
  const missionDir = path.join(repoDir, '.ade', 'missions', MISSION_ID)
  fs.mkdirSync(missionDir, { recursive: true })
  const plan = {
    mission_id: MISSION_ID,
    intent: 'duas stories',
    budget: { max_model_calls: maxCalls },
    authorization: { eligible_skills: [], permitted_effects: [] },
  }
  fs.writeFileSync(path.join(missionDir, 'plan.json'), JSON.stringify(plan, null, 2))
  const stories = [
    { id: 'S1', contract: contractOf('S1') },
    { id: 'S2', contract: contractOf('S2', ['S1']) },
  ]
  const loaded: any = { plan, stories }
  const journal = openJournal({ missionDir, runtimeStamp })
  journals.push(journal)
  const contracts = Object.fromEntries(stories.map((s) => [s.id, digest16(s.contract)]))
  const planDigest = digest16(plan)
  await journal.append({
    kind: 'decision',
    data: {
      decision: 'plan_approved',
      digest: planDigest,
      contract_digests: contracts,
      eligible_skills: [],
      permitted_effects: [],
      summary_digest: digest16({ plan: planDigest, contracts }),
    },
  })
  return { repoDir, missionDir, loaded, journal, planDigest: digest16(JSON.parse(fs.readFileSync(path.join(missionDir, 'plan.json'), 'utf8'))) }
}

/** Dublê do runStory: reserva uma chamada e conclui a story com commit, registrando quem rodou. */
function makeRunStory(calls: string[], during?: (storyId: string) => Promise<void> | void) {
  return async (deps: any, { story }: any) => {
    calls.push(story.id)
    await deps.journal.append({ kind: 'budget_reserved', data: { unit: story.id } })
    if (during) await during(story.id)
    await deps.journal.append({ kind: 'story_done', data: { unit: story.id, status: 'committed', commit: `c-${story.id}` } })
    return { status: 'committed', commit: `c-${story.id}`, exitCode: 0 }
  }
}

function baseDeps(journal: any, runStory: any) {
  return { journal, runStory, runtimeStamp, assertApprovedPlan: () => {}, lease: { dir: 'lease-fake' } }
}

function controlEvents(missionDir: string) {
  return readJournal(path.join(missionDir, 'journal.jsonl')).events.filter((e: any) => e.kind === 'mission_control')
}

function count(missionDir: string, kind: string) {
  return readJournal(path.join(missionDir, 'journal.jsonl')).events.filter((e: any) => e.kind === kind).length
}

/** Pausa S1 no meio e deixa a missão STOPPED. */
async function pausedAfterS1() {
  const m = await setupMission()
  const calls: string[] = []
  const res = await runSequentialMission(
    baseDeps(m.journal, makeRunStory(calls, async () => {
      await requestMissionControl({ repoDir: m.repoDir, missionId: MISSION_ID, action: 'pause', expectedDigest: m.planDigest, source: 'panel' })
    })) as any,
    { loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir },
  )
  return { ...m, calls, res }
}

describe('controle cooperativo da missão (v0.5)', () => {
  test('criterio_1_pausa_autenticada_passa_a_draining_nao_reivindica_nova_story_e_termina_stopped', async () => {
    const { missionDir, calls, res } = await pausedAfterS1()
    expect(calls).toEqual(['S1'])
    expect(res.status).toBe('stopped')
    expect(res.exitCode).toBe(3)
    const states = controlEvents(missionDir).map((e: any) => e.data.state)
    expect(states).toEqual(['DRAINING', 'STOPPED'])
    const stopped = controlEvents(missionDir)[1]
    const storyDone = readJournal(path.join(missionDir, 'journal.jsonl')).events.find((e: any) => e.kind === 'story_done')
    expect(stopped.data.checkpoint_ref).toBe(`journal:${stopped.seq - 1}`)
    expect(storyDone!.seq).toBeLessThan(stopped.seq)
    expect(res.checkpointRef).toBe(stopped.data.checkpoint_ref)
    expect(readMissionControl({ missionDir })).toEqual({ state: 'STOPPED', requested_action: null, request_id: null })
  })

  test('criterio_1_painel_so_aceita_pausa_com_sessao_autenticada', async () => {
    const m = await setupMission()
    const server: any = await startServer({ repoDir: m.repoDir, port: 4237, openBrowser: false })
    servers.push(server)
    const body = JSON.stringify({ mission_id: MISSION_ID, digest: m.planDigest })
    const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4237' }
    const anon = await fetch('http://127.0.0.1:4237/api/actions/pause', { method: 'POST', headers, body })
    expect(anon.status).not.toBe(200)
    expect(readMissionControl({ missionDir: m.missionDir }).requested_action).toBeNull()

    const ok = await fetch(`http://127.0.0.1:4237/api/actions/pause?session=${server.sessionToken}`, { method: 'POST', headers, body })
    expect(ok.status).toBe(200)
    const json = await ok.json()
    expect(json.action).toBe('pause')
    expect(readMissionControl({ missionDir: m.missionDir })).toEqual({ state: 'RUNNING', requested_action: 'pause', request_id: json.request_id })

    const bad = await fetch(`http://127.0.0.1:4237/api/actions/resume?session=${server.sessionToken}`, { method: 'POST', headers, body })
    expect(bad.status).toBe(409)
  })

  test('criterio_2_retomada_com_contrato_inalterado_readquire_lease_e_continua_sem_repetir_efeitos', async () => {
    const m = await pausedAfterS1()
    const before = count(m.missionDir, 'budget_reserved')
    expect(before).toBe(1)
    const req = await requestMissionControl({ repoDir: m.repoDir, missionId: MISSION_ID, action: 'resume', expectedDigest: m.planDigest, source: 'panel' })
    const calls: string[] = []
    const res = await resumeMission({ loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir, deps: baseDeps(m.journal, makeRunStory(calls)) } as any)
    expect(res.status).toBe('completed')
    expect(calls).toEqual(['S2'])
    expect(count(m.missionDir, 'budget_reserved')).toBe(2)
    expect(count(m.missionDir, 'story_done')).toBe(2)
    const running = controlEvents(m.missionDir).at(-1)
    expect(running!.data).toMatchObject({ state: 'RUNNING', action: 'resume', request_id: req.request_id })
    expect(readMissionControl({ missionDir: m.missionDir })).toEqual({ state: 'RUNNING', requested_action: null, request_id: null })
  })

  test('criterio_3_plano_autorizacao_orcamento_ou_lease_divergente_mantem_missao_parada', async () => {
    const cases: Array<[string, (m: any, deps: any) => void]> = [
      ['approval_divergent', (m) => { m.loaded.plan = { ...m.loaded.plan, intent: 'outra intenção' } }],
      ['approval_divergent', (m) => {
        m.loaded.plan = { ...m.loaded.plan, authorization: { eligible_skills: [], permitted_effects: ['push'] } }
      }],
      ['lease_missing', (_m, deps) => { delete deps.lease }],
    ]
    for (const [reason, mutate] of cases) {
      const m = await pausedAfterS1()
      await requestMissionControl({ repoDir: m.repoDir, missionId: MISSION_ID, action: 'resume', expectedDigest: m.planDigest, source: 'cli' })
      const calls: string[] = []
      const deps: any = baseDeps(m.journal, makeRunStory(calls))
      mutate(m, deps)
      const res = await resumeMission({ loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir, deps } as any)
      expect(res.status).toBe('awaiting_operator')
      expect(res.reason).toBe(reason)
      expect(calls).toEqual([])
      expect(readMissionControl({ missionDir: m.missionDir }).state).toBe('STOPPED')
      expect(readMissionControl({ missionDir: m.missionDir }).requested_action).toBe('resume')
    }

    // Orçamento: teto de 1 chamada já consumido por S1.
    const m = await setupMission({ maxCalls: 1 })
    const calls: string[] = []
    await runSequentialMission(
      baseDeps(m.journal, makeRunStory(calls, async () => {
        await requestMissionControl({ repoDir: m.repoDir, missionId: MISSION_ID, action: 'pause', expectedDigest: m.planDigest, source: 'panel' })
      })) as any,
      { loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir },
    )
    await requestMissionControl({ repoDir: m.repoDir, missionId: MISSION_ID, action: 'resume', expectedDigest: m.planDigest, source: 'panel' })
    const res = await resumeMission({ loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir, deps: baseDeps(m.journal, makeRunStory(calls)) } as any)
    expect(res.status).toBe('awaiting_operator')
    expect(res.reason).toBe('budget_exhausted')
    expect(calls).toEqual(['S1'])
    expect(readMissionControl({ missionDir: m.missionDir }).state).toBe('STOPPED')
  })

  test('criterio_4_falha_entre_draining_e_checkpoint_e_reconciliada_por_outro_processo_sem_perda_nem_duplicacao', async () => {
    const m = await setupMission()
    const calls: string[] = []
    await makeRunStory(calls)({ journal: m.journal }, { story: m.loaded.stories[0] })
    const req = await requestMissionControl({ repoDir: m.repoDir, missionId: MISSION_ID, action: 'pause', expectedDigest: m.planDigest, source: 'panel' })
    // Processo antigo gravou DRAINING e morreu antes do checkpoint.
    await m.journal.append({ kind: 'mission_control', data: { state: 'DRAINING', action: 'pause', request_id: req.request_id, reason: 'pause' } })
    await m.journal.close()
    expect(readMissionControl({ missionDir: m.missionDir }).state).toBe('DRAINING')

    const journal2 = openJournal({ missionDir: m.missionDir, runtimeStamp })
    journals.push(journal2)
    const reconciled: string[] = []
    const deps: any = {
      ...baseDeps(journal2, makeRunStory(calls)),
      reconcileAll: async () => {
        reconciled.push('ok')
        return [{ step_id: 'S1-maker', verdict: 'ok', reason: 'receipt_exited' }]
      },
    }
    const res = await resumeMission({ loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir, deps } as any)
    expect(res.status).toBe('stopped')
    expect(reconciled).toEqual(['ok'])
    expect(calls).toEqual(['S1'])
    expect(controlEvents(m.missionDir).map((e: any) => e.data.state)).toEqual(['DRAINING', 'DRAINING', 'STOPPED'])
    expect(readMissionControl({ missionDir: m.missionDir })).toEqual({ state: 'STOPPED', requested_action: null, request_id: null })

    await requestMissionControl({ repoDir: m.repoDir, missionId: MISSION_ID, action: 'resume', expectedDigest: m.planDigest, source: 'panel' })
    const done = await resumeMission({ loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir, deps: baseDeps(journal2, makeRunStory(calls)) } as any)
    expect(done.status).toBe('completed')
    expect(calls).toEqual(['S1', 'S2'])
    expect(count(m.missionDir, 'budget_reserved')).toBe(2)
  })

  test('criterio_5_sinal_de_encerramento_usa_a_mesma_drenagem_cooperativa', async () => {
    const m = await setupMission()
    const proc = new EventEmitter()
    const seen: string[] = []
    const shutdown = installShutdownDrain(proc, (sig: string) => seen.push(sig))
    const calls: string[] = []
    const res = await runSequentialMission(
      { ...baseDeps(m.journal, makeRunStory(calls, () => { proc.emit('SIGTERM') })), shutdown } as any,
      { loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir },
    )
    expect(res.status).toBe('stopped')
    expect(res.reason).toBe('shutdown:SIGTERM')
    expect(seen).toEqual(['SIGTERM'])
    expect(calls).toEqual(['S1'])
    expect(controlEvents(m.missionDir).map((e: any) => [e.data.state, e.data.reason])).toEqual([
      ['DRAINING', 'shutdown:SIGTERM'],
      ['STOPPED', 'shutdown:SIGTERM'],
    ])
    shutdown.dispose()
    expect(proc.listenerCount('SIGTERM')).toBe(0)
    expect(proc.listenerCount('SIGINT')).toBe(0)
  })

  test('criterio_6_arvore_windows_sem_encerramento_cooperativo_e_encerrada_por_taskkill_apos_prazo', async () => {
    let clock = 0
    const execCalls: any[] = []
    const res = await terminateProcessTree({
      pid: 4321,
      platform: 'win32',
      timeoutMs: 500,
      isAlive: () => true,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms },
      execFileSync: (cmd: string, args: string[], opts: any) => { execCalls.push([cmd, args, opts]) },
    } as any)
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0][0]).toBe('taskkill')
    expect(execCalls[0][1]).toEqual(['/T', '/F', '/PID', '4321'])
    expect(execCalls[0][2].maxBuffer).toBeGreaterThan(0)
    expect(execCalls[0][2].shell).toBeUndefined()
    expect(res).toMatchObject({ pid: 4321, platform: 'win32', cooperative: false, terminated_by: 'taskkill' })
    expect(res.waited_ms).toBeGreaterThanOrEqual(500)

    // Encerramento cooperativo dentro do prazo não chama taskkill.
    let alive = 2
    const coop = await terminateProcessTree({
      pid: 4322, platform: 'win32', timeoutMs: 500,
      isAlive: () => alive-- > 0, now: () => clock, sleep: async (ms: number) => { clock += ms },
      execFileSync: () => { throw new Error('não deveria chamar') },
    } as any)
    expect(coop).toMatchObject({ cooperative: true, terminated_by: 'cooperative_exit' })

    // taskkill recusado (EPERM) usa o fallback limitado e grava a forma usada, sem pty.kill().
    const killed: any[] = []
    const failed = await terminateProcessTree({
      pid: 4323, platform: 'win32', timeoutMs: 0,
      isAlive: () => true, now: () => clock, sleep: async () => {},
      execFileSync: () => { throw Object.assign(new Error('Acesso negado'), { code: 'EPERM' }) },
      kill: (pid: number, signal: string) => { killed.push([pid, signal]) },
    } as any)
    expect(failed).toMatchObject({ cooperative: false, terminated_by: 'job_fallback' })
    expect(killed).toEqual([[4323, 'SIGKILL']])

    await expect(terminateProcessTree({ pid: -1, platform: 'win32', timeoutMs: 10 } as any)).rejects.toThrow()
  })

  test('criterio_7_solicitacoes_repetidas_ou_concorrentes_sao_idempotentes_e_transicoes_invalidas_recusadas', async () => {
    const m = await setupMission()
    const input = { repoDir: m.repoDir, missionId: MISSION_ID, expectedDigest: m.planDigest, source: 'panel' }
    const reqs = await Promise.all([1, 2, 3, 4, 5].map(() => requestMissionControl({ ...input, action: 'pause' })))
    expect(new Set(reqs.map((r: any) => r.request_id)).size).toBe(1)

    await expect(requestMissionControl({ ...input, action: 'resume' })).rejects.toMatchObject({ code: 'control_invalid_transition' })
    await expect(requestMissionControl({ ...input, action: 'explodir' } as any)).rejects.toMatchObject({ code: 'control_action_invalid' })
    await expect(requestMissionControl({ ...input, action: 'pause', expectedDigest: '0000000000000000' })).rejects.toMatchObject({ code: 'control_digest_mismatch' })
    await expect(requestMissionControl({ ...input, action: 'pause', missionId: '../fora' })).rejects.toMatchObject({ code: 'control_mission_invalid' })

    // DRAINING recusa retomada.
    await m.journal.append({ kind: 'mission_control', data: { state: 'DRAINING', action: 'pause', request_id: reqs[0].request_id, reason: 'pause' } })
    await expect(requestMissionControl({ ...input, action: 'resume' })).rejects.toMatchObject({ code: 'control_invalid_transition' })

    const drained = await drainMission({
      journal: m.journal,
      checkpoint: async () => 'journal:3',
      stopClaiming: () => {},
      reason: 'pause',
      requestId: reqs[0].request_id,
    } as any)
    expect(drained).toEqual({ state: 'STOPPED', checkpoint_ref: 'journal:3' })
    // Pedido de pausa já consumido pelo journal não trava a retomada.
    expect(readMissionControl({ missionDir: m.missionDir }).requested_action).toBeNull()

    const again = await requestMissionControl({ ...input, action: 'pause' })
    expect(again).toMatchObject({ state: 'STOPPED', idempotent: true })
    const r1 = await requestMissionControl({ ...input, action: 'resume' })
    const r2 = await requestMissionControl({ ...input, action: 'resume' })
    expect(r2.request_id).toBe(r1.request_id)
    await expect(requestMissionControl({ ...input, action: 'pause' })).rejects.toMatchObject({ code: 'control_invalid_transition' })

    const { events, tornTail } = readJournal(path.join(m.missionDir, 'journal.jsonl'))
    expect(tornTail).toBeNull()
    expect(events.map((e: any) => e.seq)).toEqual(events.map((_: any, i: number) => i + 1))
  })

  test('criterio_8_missao_sem_controle_segue_o_fluxo_existente_ate_concluir', async () => {
    const m = await setupMission()
    const calls: string[] = []
    const res = await runSequentialMission(baseDeps(m.journal, makeRunStory(calls)) as any, {
      loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir,
    })
    expect(res.status).toBe('completed')
    expect(calls).toEqual(['S1', 'S2'])
    expect(controlEvents(m.missionDir)).toEqual([])

    // Missão parada não é despachada por chamada direta ao scheduler.
    const p = await pausedAfterS1()
    const again: string[] = []
    const res2 = await runSequentialMission(baseDeps(p.journal, makeRunStory(again)) as any, {
      loaded: p.loaded, repoDir: p.repoDir, missionDir: p.missionDir,
    })
    expect(res2).toMatchObject({ status: 'stopped', reason: 'mission_stopped' })
    expect(again).toEqual([])
  })
})
