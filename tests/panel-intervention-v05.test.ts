import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readMissionControl, requestMissionControl } from '../src/engine/control.js'
import { resumeMission } from '../src/engine/resume.js'
import { runSequentialMission } from '../src/engine/schedule.js'
import { digest16 } from '../src/journal/canonical.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { buildRuntimeStamp } from '../src/journal/stamp.ts'
import { acquireLease } from '../src/lease/lease.ts'
import { projectMissionFromSources } from '../src/panel/projection.js'
import { createTakeoverSession } from '../src/panel/pty.js'
import { startServer } from '../src/panel/server.js'
import { readPanelSnapshot, rebuildProjection } from '../src/panel/sqlite-index.js'

const MISSION_ID = 'mission-tko'
const runtimeStamp = buildRuntimeStamp({ configDigest: 'a'.repeat(16), capabilitiesDigest: 'b'.repeat(16) })
const HOSTILE = '<script>alert(1)</script>\x1b]52;c;ZXZpbA==\x07\x1b]0;titulo falso\x07\x1b[31mvermelho\x1b[0m'

let tmpDirs: string[] = []
let servers: Array<{ close: () => Promise<void> }> = []
let sockets: net.Socket[] = []

afterEach(async () => {
  for (const s of sockets) s.destroy()
  sockets = []
  for (const s of servers) await s.close()
  servers = []
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs = []
})

function contractOf(id: string, deps: string[] = []) {
  return { id, task: `tarefa ${id}`, depends_on: deps, budget: { max_model_calls: 2 } }
}

/**
 * Missão aprovada: S1 concluída com commit, S2 iniciada no worktree próprio com sessão do Maker
 * registrada. `state` define até onde o controle chegou (RUNNING, DRAINING ou STOPPED).
 */
async function setupMission(state: 'RUNNING' | 'DRAINING' | 'STOPPED' = 'STOPPED') {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-tko-'))
  tmpDirs.push(repoDir)
  const missionDir = path.join(repoDir, '.ade', 'missions', MISSION_ID)
  const worktree = path.join(repoDir, '.ade', 'wt', 'S2')
  fs.mkdirSync(worktree, { recursive: true })
  fs.mkdirSync(missionDir, { recursive: true })
  const plan = {
    mission_id: MISSION_ID,
    intent: 'duas stories com takeover',
    budget: { max_model_calls: 6 },
    mission_budget: { max_usd: 5 },
    authorization: { autonomy: 'controlled', eligible_skills: [], permitted_effects: [] },
    phases: [{ epics: [{ id: 'E1', title: 'Épico', stories: ['S1', 'S2'] }] }],
    research_findings: [
      { id: 'rf-u1', ref: 'research-finding:rf-u1', kind: 'research_finding', confidence: 0.8, data: { answer: 'Node 22 é LTS' } },
    ],
  }
  fs.writeFileSync(path.join(missionDir, 'plan.json'), JSON.stringify(plan, null, 2))
  const stories = [
    { id: 'S1', contract: contractOf('S1') },
    { id: 'S2', contract: contractOf('S2', ['S1']) },
  ]
  const loaded: any = { plan, stories }
  const journal = openJournal({ missionDir, runtimeStamp })
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
  await journal.append({ kind: 'budget_reserved', data: { unit: 'S1' } })
  await journal.append({ kind: 'model_call', data: { unit: 'S1', cost_usd: 0.25 } })
  await journal.append({ kind: 'story_done', data: { unit: 'S1', status: 'committed', commit: 'c-S1' } })
  await journal.append({ kind: 'story_started', data: { unit: 'S2', worktree_dir: worktree, tree_before: 't0' } })
  await journal.append({
    kind: 'step_intent',
    step_id: 'S2-maker-1',
    effect_class: 'model_call',
    input_digest: 'c'.repeat(16),
    worktree,
    session_ref: 'sess-S2',
    data: { unit: 'S2' },
  })
  await journal.append({ kind: 'step_result', step_id: 'S2-maker-1', effect_class: 'model_call', status: 'ok' })
  if (state !== 'RUNNING') {
    await journal.append({ kind: 'mission_control', data: { state: 'DRAINING', action: 'pause', request_id: 'ctl-1', reason: 'pause' } })
  }
  if (state === 'STOPPED') {
    await journal.append({
      kind: 'mission_control',
      data: { state: 'STOPPED', action: 'pause', request_id: 'ctl-1', reason: 'pause', checkpoint_ref: `journal:${journal.lastSeq}` },
    })
  }
  await journal.close()
  return { repoDir, missionDir, worktree, loaded, planDigest }
}

function events(missionDir: string) {
  return readJournal(path.join(missionDir, 'journal.jsonl')).events
}

function kinds(missionDir: string) {
  return events(missionDir).map((e: any) => e.kind)
}

/** Dublês de fronteira: PTY, taskkill e verificação de processo vivo. */
function terminalDeps(missionDir: string, { taskkillFails = false } = {}) {
  const spawned: any[] = []
  const taskkill: any[] = []
  const ptyAdapter = {
    spawn(file: string, args: string[], opts: any) {
      const pty: any = new EventEmitter()
      pty.pid = 4242
      pty.killed = false
      pty.written = [] as string[]
      pty.kinds_at_spawn = kinds(missionDir)
      pty.onData = (cb: (d: string) => void) => {
        pty.on('data', cb)
        return { dispose: () => pty.off('data', cb) }
      }
      pty.onExit = (cb: (e: any) => void) => {
        pty.on('exit', cb)
        return { dispose: () => pty.off('exit', cb) }
      }
      pty.write = (d: string) => pty.written.push(d)
      pty.kill = () => {
        pty.killed = true
      }
      spawned.push({ file, args, opts, pty })
      return pty
    },
  }
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    taskkill.push({ cmd, args, opts })
    if (taskkillFails) throw Object.assign(new Error('Acesso negado'), { status: 1 })
    return ''
  }
  return {
    spawned,
    taskkill,
    deps: {
      ptyAdapter,
      platform: 'win32',
      execFileSync,
      isAlive: () => true,
      resolveBinary: () => ({ exe: 'claude', prefixArgs: [] }),
    },
  }
}

async function serve(repoDir: string, port: number, deps: any = {}) {
  const server: any = await startServer({ repoDir, port, openBrowser: false, deps })
  servers.push(server)
  return server
}

function post(server: any, action: string, body: unknown, { token = server.sessionToken, origin = `http://127.0.0.1:${server.port}` } = {}) {
  const qs = token ? `?session=${token}` : ''
  return fetch(`http://127.0.0.1:${server.port}/api/actions/${action}${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function snapshotOf(server: any) {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/snapshot?session=${server.sessionToken}`)
  expect(res.status).toBe(200)
  return (await res.json()).selectedMission
}

/** Cliente WebSocket mínimo: handshake, frames do servidor e envio de frames mascarados. */
function openWs(port: number, pathQuery: string, origin = `http://127.0.0.1:${port}`) {
  const socket = net.connect({ port, host: '127.0.0.1' })
  sockets.push(socket)
  const key = randomBytes(16).toString('base64')
  const frames: Array<{ opcode: number, payload: Buffer }> = []
  let buf = Buffer.alloc(0)
  let upgraded = false
  const status = new Promise<string>((resolve) => {
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buf.subarray(0, end).toString()
        buf = buf.subarray(end + 4)
        upgraded = true
        resolve(head.split('\r\n')[0])
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        if (buf.length < off + len) return
        frames.push({ opcode: buf[0] & 0x0f, payload: buf.subarray(off, off + len) })
        buf = buf.subarray(off + len)
      }
    })
    socket.on('close', () => resolve('closed'))
    socket.on('error', () => resolve('error'))
  })
  socket.write([
    `GET ${pathQuery} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    `Origin: ${origin}`,
    '',
    '',
  ].join('\r\n'))
  const send = (text: string) => {
    const payload = Buffer.from(text)
    const mask = randomBytes(4)
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
    socket.write(Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, masked]))
  }
  return { socket, status, frames, send, accept: createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') }
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

async function takeover(server: any, planDigest: string) {
  const res = await post(server, 'takeover', { mission_id: MISSION_ID, story_id: 'S2', digest: planDigest })
  expect(res.status).toBe(200)
  return res.json()
}

function terminalPath(t: any, story = 'S2') {
  return `/api/terminal?session=${t.terminal_token}&mission=${MISSION_ID}&story=${story}`
}

function runStoryStub(calls: string[]) {
  return async (deps: any, { story }: any) => {
    calls.push(story.id)
    await deps.journal.append({ kind: 'budget_reserved', data: { unit: story.id } })
    await deps.journal.append({ kind: 'story_done', data: { unit: story.id, status: 'committed', commit: `c-${story.id}` } })
    return { status: 'committed', commit: `c-${story.id}`, exitCode: 0 }
  }
}

describe('intervenção pelo painel (v0.5)', () => {
  test('criterio_1_painel_apresenta_estado_story_checkpoint_custos_e_pesquisas_sem_estado_do_navegador', async () => {
    const running = await setupMission('RUNNING')
    expect(projectMissionFromSources({ missionDir: running.missionDir }).runtime_state).toBe('RUNNING')
    const draining = await setupMission('DRAINING')
    expect(projectMissionFromSources({ missionDir: draining.missionDir }).runtime_state).toBe('DRAINING')

    const m = await setupMission('STOPPED')
    const server = await serve(m.repoDir, 4241)
    const mission = await snapshotOf(server)
    expect(mission.runtime_state).toBe('STOPPED')
    expect(mission.current_story).toBe('S2')
    const stopped = events(m.missionDir).at(-1) as any
    expect(mission.checkpoint).toEqual({ ref: stopped.data.checkpoint_ref, seq: stopped.seq, at: stopped.at })
    expect(mission.consumed_usd).toBe(0.25)
    expect(mission.research).toEqual([{ id: 'rf-u1', ref: 'research-finding:rf-u1', confidence: 0.8, data: { answer: 'Node 22 é LTS' } }])
    expect(mission.takeover).toEqual({ active: false, story_id: null, intervention_needed: false })
  })

  test('criterio_2_pausa_confirma_draining_e_stopped_e_recusa_token_origem_corpo_digest_e_transicao_sem_alterar', async () => {
    const m = await setupMission('RUNNING')
    const server = await serve(m.repoDir, 4242)
    const body = { mission_id: MISSION_ID, digest: m.planDigest }
    const before = fs.readFileSync(path.join(m.missionDir, 'journal.jsonl'), 'utf8')

    expect((await post(server, 'pause', body, { token: '' })).status).toBe(401)
    expect((await post(server, 'pause', body, { origin: 'http://evil.example' })).status).toBe(403)
    expect((await post(server, 'pause', '{nao json')).status).toBe(400)
    expect((await post(server, 'pause', { mission_id: MISSION_ID, digest: '0000000000000000' })).status).toBe(400)
    expect((await post(server, 'resume', body)).status).toBe(200) // RUNNING: retomada idempotente, sem pedido
    expect(readMissionControl({ missionDir: m.missionDir }).requested_action).toBeNull()
    expect(fs.readFileSync(path.join(m.missionDir, 'journal.jsonl'), 'utf8')).toBe(before)

    const ok = await post(server, 'pause', body)
    expect(ok.status).toBe(200)
    expect((await post(server, 'resume', body)).status).toBe(409) // pausa pendente: transição ilegal
    expect(fs.readFileSync(path.join(m.missionDir, 'journal.jsonl'), 'utf8')).toBe(before)

    // O escritor ativo consome o pedido e drena até STOPPED.
    const journal = openJournal({ missionDir: m.missionDir, runtimeStamp })
    const calls: string[] = []
    const res = await runSequentialMission(
      { journal, runStory: runStoryStub(calls), runtimeStamp, assertApprovedPlan: () => {}, lease: { dir: 'x' } } as any,
      { loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir },
    )
    await journal.close()
    expect(res.status).toBe('stopped')
    expect(calls).toEqual([])
    await rebuildProjection({ repoDir: m.repoDir })
    const mission = await snapshotOf(server)
    expect(mission.runtime_state).toBe('STOPPED')
    expect(mission.interventions.map((i: any) => i.state)).toEqual(['DRAINING', 'STOPPED'])
  })

  test('criterio_3_retomada_so_informa_execucao_apos_revalidacao_e_falha_preserva_stopped', async () => {
    const m = await setupMission('STOPPED')
    const server = await serve(m.repoDir, 4243)
    const res = await post(server, 'resume', { mission_id: MISSION_ID, digest: m.planDigest })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.state).toBe('STOPPED')
    expect(json.action).toBe('resume')

    const journal = openJournal({ missionDir: m.missionDir, runtimeStamp })
    const calls: string[] = []
    const refused = await resumeMission({
      loaded: m.loaded,
      repoDir: m.repoDir,
      missionDir: m.missionDir,
      deps: { journal, runStory: runStoryStub(calls), runtimeStamp, assertApprovedPlan: () => {} },
    })
    expect(refused.reason).toBe('lease_missing')
    expect(calls).toEqual([])
    await rebuildProjection({ repoDir: m.repoDir })
    expect((await snapshotOf(server)).runtime_state).toBe('STOPPED')

    await resumeMission({
      loaded: m.loaded,
      repoDir: m.repoDir,
      missionDir: m.missionDir,
      deps: { journal, runStory: runStoryStub(calls), runtimeStamp, assertApprovedPlan: () => {}, lease: { dir: 'x' } },
    })
    await journal.close()
    expect(calls).toEqual(['S2'])
    await rebuildProjection({ repoDir: m.repoDir })
    expect((await snapshotOf(server)).runtime_state).toBe('RUNNING')
  })

  test('criterio_4_takeover_abre_mesma_sessao_no_mesmo_worktree_registra_antes_e_bloqueia_worker', async () => {
    const running = await setupMission('RUNNING')
    const t0 = terminalDeps(running.missionDir)
    const s0 = await serve(running.repoDir, 4244, t0.deps)
    const early = await post(s0, 'takeover', { mission_id: MISSION_ID, story_id: 'S2', digest: running.planDigest })
    expect(early.status).toBe(409)
    expect(t0.spawned).toEqual([])

    const m = await setupMission('STOPPED')
    const t = terminalDeps(m.missionDir)
    const server = await serve(m.repoDir, 4245, t.deps)
    expect((await post(server, 'takeover', { mission_id: MISSION_ID, story_id: 'S1', digest: m.planDigest })).status).toBe(409)
    const tk = await takeover(server, m.planDigest)
    expect(tk.story_id).toBe('S2')
    expect(tk.session_ref).toBe('sess-S2')
    expect(typeof tk.terminal_token).toBe('string')
    expect(tk.terminal_token).not.toBe(server.sessionToken)
    expect(t.spawned).toHaveLength(1)
    expect(t.spawned[0].file).toBe('claude')
    expect(t.spawned[0].args).toEqual(['--resume', 'sess-S2'])
    expect(t.spawned[0].opts.cwd).toBe(m.worktree)
    expect(t.spawned[0].pty.kinds_at_spawn.at(-1)).toBe('human_takeover')
    const tkEvent = events(m.missionDir).at(-1) as any
    expect(tkEvent.session_ref).toBe('sess-S2')
    expect(tkEvent.worktree).toBe(m.worktree)
    expect(tkEvent.data.unit).toBe('S2')

    // Operador no controle: retomada recusada, scheduler não despacha e o lease da missão está preso.
    await expect(
      requestMissionControl({ repoDir: m.repoDir, missionId: MISSION_ID, action: 'resume', expectedDigest: m.planDigest, source: 'cli' }),
    ).rejects.toMatchObject({ code: 'control_invalid_transition' })
    const journal = openJournal({ missionDir: m.missionDir, runtimeStamp })
    const calls: string[] = []
    const res = await runSequentialMission(
      { journal, runStory: runStoryStub(calls), runtimeStamp, assertApprovedPlan: () => {}, lease: { dir: 'x' } } as any,
      { loaded: m.loaded, repoDir: m.repoDir, missionDir: m.missionDir },
    )
    await journal.close()
    expect(res.status).toBe('stopped')
    expect(calls).toEqual([])
    await expect(acquireLease({ missionDir: m.missionDir })).rejects.toBeTruthy()
  })

  test('criterio_5_fechar_navegador_ou_cair_canal_nao_devolve_controle', async () => {
    const m = await setupMission('STOPPED')
    const t = terminalDeps(m.missionDir)
    const server = await serve(m.repoDir, 4246, t.deps)
    const tk = await takeover(server, m.planDigest)
    const ws = openWs(4246, terminalPath(tk))
    expect(await ws.status).toBe('HTTP/1.1 101 Switching Protocols')
    ws.send('ls\r')
    await tick()
    expect(t.spawned[0].pty.written).toEqual(['ls\r'])
    ws.socket.destroy()
    await tick(150)

    expect(kinds(m.missionDir)).not.toContain('human_release')
    expect(t.taskkill).toEqual([])
    expect(t.spawned[0].pty.killed).toBe(false)
    expect(readMissionControl({ missionDir: m.missionDir }).state).toBe('STOPPED')
    await rebuildProjection({ repoDir: m.repoDir })
    expect((await snapshotOf(server)).takeover.active).toBe(true)

    const again = openWs(4246, terminalPath(tk))
    expect(await again.status).toBe('HTTP/1.1 101 Switching Protocols')
  })

  test('criterio_6_release_salva_checkpoint_registra_human_release_e_retoma_sem_repetir_efeitos', async () => {
    const m = await setupMission('STOPPED')
    const t = terminalDeps(m.missionDir)
    const server = await serve(m.repoDir, 4247, t.deps)
    await takeover(server, m.planDigest)
    const res = await post(server, 'release', { mission_id: MISSION_ID, story_id: 'S2', digest: m.planDigest })
    expect(res.status).toBe(200)
    const json = await res.json()
    const evs = events(m.missionDir)
    const release = evs.at(-1) as any
    expect(release.kind).toBe('human_release')
    expect(release.data.unit).toBe('S2')
    expect(json.checkpoint_ref).toBe(release.data.checkpoint_ref)
    expect(json.checkpoint_ref).toBe(`journal:${release.seq - 1}`)
    expect(t.taskkill.map((c) => [c.cmd, c.args])).toEqual([['taskkill', ['/T', '/F', '/PID', '4242']]])
    expect(t.spawned[0].pty.killed).toBe(false)
    expect(readMissionControl({ missionDir: m.missionDir }).requested_action).toBe('resume')

    const journal = openJournal({ missionDir: m.missionDir, runtimeStamp })
    const calls: string[] = []
    await resumeMission({
      loaded: m.loaded,
      repoDir: m.repoDir,
      missionDir: m.missionDir,
      deps: { journal, runStory: runStoryStub(calls), runtimeStamp, assertApprovedPlan: () => {}, lease: { dir: 'x' } },
    })
    await journal.close()
    expect(calls).toEqual(['S2'])
    expect(kinds(m.missionDir).filter((k) => k === 'model_call')).toHaveLength(1)
  })

  test('criterio_7_encerramento_windows_usa_taskkill_e_falha_mantem_parada_com_intervencao', async () => {
    const m = await setupMission('STOPPED')
    const t = terminalDeps(m.missionDir, { taskkillFails: true })
    const server = await serve(m.repoDir, 4248, t.deps)
    await takeover(server, m.planDigest)
    const res = await post(server, 'release', { mission_id: MISSION_ID, story_id: 'S2', digest: m.planDigest })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('takeover_terminate_failed')
    expect(t.taskkill[0].args).toEqual(['/T', '/F', '/PID', '4242'])
    expect(t.taskkill[0].opts.maxBuffer).toBeGreaterThan(0)
    expect(t.taskkill[0].opts.shell).toBeFalsy()
    expect(t.spawned[0].pty.killed).toBe(false)
    expect(kinds(m.missionDir)).not.toContain('human_release')
    expect(readMissionControl({ missionDir: m.missionDir })).toEqual({ state: 'STOPPED', requested_action: null, request_id: null })
    await rebuildProjection({ repoDir: m.repoDir })
    expect((await snapshotOf(server)).takeover).toEqual({ active: true, story_id: 'S2', intervention_needed: true })

    // A sessão isolada também nunca decide por pty.kill().
    const direct = terminalDeps(m.missionDir)
    const session = createTakeoverSession({ mission: MISSION_ID, story: 'S2', sessionRef: 'sess-S2', worktree: m.worktree, ...direct.deps, command: { exe: 'claude', prefixArgs: [] } })
    const closed = await session.close()
    expect(closed.terminated_by).toBe('taskkill')
    expect(direct.spawned[0].pty.killed).toBe(false)
  })

  test('criterio_8_saida_hostil_fica_confinada_em_frames_binarios_sem_osc_e_canal_exige_autorizacao_propria', async () => {
    const m = await setupMission('STOPPED')
    const t = terminalDeps(m.missionDir)
    const server = await serve(m.repoDir, 4249, t.deps)
    const tk = await takeover(server, m.planDigest)

    for (const bad of [
      `/api/terminal?session=${server.sessionToken}&mission=${MISSION_ID}&story=S2`,
      `/api/terminal?session=${tk.terminal_token}&mission=${MISSION_ID}&story=S1`,
      `/api/terminal?mission=${MISSION_ID}&story=S2`,
    ]) {
      expect(await openWs(4249, bad).status).toMatch(/^HTTP\/1\.1 40[13]/)
    }
    expect(await openWs(4249, terminalPath(tk), 'http://evil.example').status).toBe('HTTP/1.1 403 Forbidden')

    const ws = openWs(4249, terminalPath(tk))
    expect(await ws.status).toBe('HTTP/1.1 101 Switching Protocols')
    t.spawned[0].pty.emit('data', HOSTILE)
    t.spawned[0].pty.emit('data', 'x'.repeat(200 * 1024))
    await tick(150)
    expect(ws.frames.length).toBeGreaterThan(1)
    for (const f of ws.frames) {
      expect(f.opcode).toBe(0x2)
      expect(f.payload.length).toBeLessThanOrEqual(64 * 1024)
    }
    const first = ws.frames[0].payload.toString('utf8')
    expect(first).toBe('<script>alert(1)</script>\x1b[31mvermelho\x1b[0m')

    // OSC, OSC C1 e DCS divididos entre callbacks também saem.
    const before = ws.frames.length
    for (const piece of ['a\x1b', ']52;c;ZX', 'Zp\x1b', '\\b\x9d0;t', 'itulo\x9cc\x1bP', 'q\x1b', '\\d\x1b[1m']) {
      t.spawned[0].pty.emit('data', piece)
    }
    await tick(100)
    expect(ws.frames.slice(before).map((f) => f.payload.toString('utf8')).join('')).toBe('abcd\x1b[1m')

    const app = fs.readFileSync(path.join(process.cwd(), 'packages/web/app.js'), 'utf8')
    const terminalCode = app.slice(app.indexOf('function openTerminal'))
    expect(terminalCode).toContain('term.write(')
    expect(terminalCode.slice(0, terminalCode.indexOf('\n}\n'))).not.toMatch(/innerHTML|insertAdjacentHTML|eval\(/)
  })

  test('criterio_9_controles_acessiveis_com_nomes_foco_visivel_anuncio_e_bloqueio', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8')
    for (const [id, name] of [['ctlPause', 'Pausar'], ['ctlResume', 'Retomar'], ['ctlTakeover', 'Assumir'], ['ctlRelease', 'Devolver']]) {
      expect(html).toMatch(new RegExp(`<button[^>]*id="${id}"[^>]*>${name}`))
    }
    expect(html).toMatch(/id="controlStatus"[^>]*role="status"[^>]*aria-live="polite"|id="controlStatus"[^>]*aria-live="polite"/)
    expect(html).toMatch(/id="terminal"[^>]*role="region"[^>]*aria-label="Terminal/)
    const app = fs.readFileSync(path.join(process.cwd(), 'packages/web/app.js'), 'utf8')
    expect(app).toContain("setAttribute('aria-busy'")
    expect(app).toMatch(/\.disabled = /)
    const css = fs.readFileSync(path.join(process.cwd(), 'packages/web/styles.css'), 'utf8')
    expect(css).toMatch(/\.ctl[^{]*:focus-visible/)
  })

  test('criterio_10_snapshot_aprovacao_e_eventos_continuam_com_autenticacao_e_origem', async () => {
    const m = await setupMission('STOPPED')
    const t = terminalDeps(m.missionDir)
    const server = await serve(m.repoDir, 4250, t.deps)
    expect((await fetch(`http://127.0.0.1:4250/api/snapshot`)).status).toBe(401)
    expect((await snapshotOf(server)).id).toBe(MISSION_ID)
    const approve = await post(server, 'approve', { mission_id: MISSION_ID, digest: m.planDigest }, { origin: 'http://evil.example' })
    expect(approve.status).toBe(403)

    const ws = openWs(4250, `/api/events?since=0&session=${server.sessionToken}`)
    expect(await ws.status).toBe('HTTP/1.1 101 Switching Protocols')
    await tick(100)
    const replayed = ws.frames.map((f) => JSON.parse(f.payload.toString('utf8')))
    expect(replayed.map((e) => e.seq)).toEqual(events(m.missionDir).map((e: any) => e.seq))
    expect(ws.frames.every((f) => f.opcode === 0x1)).toBe(true)
  })

  test('criterio_11_reconstrucao_do_indice_preserva_estado_intervencoes_e_checkpoint', async () => {
    const m = await setupMission('STOPPED')
    const t = terminalDeps(m.missionDir)
    const server = await serve(m.repoDir, 4251, t.deps)
    await takeover(server, m.planDigest)
    await post(server, 'release', { mission_id: MISSION_ID, story_id: 'S2', digest: m.planDigest })
    await rebuildProjection({ repoDir: m.repoDir })
    const before = await snapshotOf(server)

    fs.rmSync(path.join(m.repoDir, '.ade', 'index.sqlite'), { force: true })
    const rebuilt = (await readPanelSnapshot({ repoDir: m.repoDir })).selectedMission
    expect(rebuilt.runtime_state).toBe('STOPPED')
    expect(rebuilt.interventions.map((i: any) => i.kind)).toEqual(['mission_control', 'mission_control', 'human_takeover', 'human_release'])
    expect(rebuilt.checkpoint).toEqual(before.checkpoint)
    expect(rebuilt.checkpoint.ref).toBe((events(m.missionDir).at(-1) as any).data.checkpoint_ref)
    expect(rebuilt.takeover).toEqual({ active: false, story_id: null, intervention_needed: false })
    expect(rebuilt).toEqual(before)
  })
})
