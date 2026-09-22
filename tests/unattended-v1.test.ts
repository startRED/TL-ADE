import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { dispatchCodex } from '../src/adapters/codex/index.js'
import { approvedReviewAction } from './helpers/checker-double.js'
import { computeObservedInputDigest } from '../src/engine.js'
import { guardExternalEffects } from '../src/engine/loop.js'
import { createGitPort } from '../src/git/gitport.js'
import { digest16 } from '../src/journal/canonical.js'
import { openJournal, readJournal } from '../src/journal/journal.js'
import { loadPlan } from '../src/engine/plan-load.js'
import { terminateProcessTree } from '../src/runner/spawn.js'
import { main as reportMain } from '../src/cli/report.js'
import { runCommand } from '../src/cli/run.js'
import { makeRepo, removeRepo } from './helpers/git-repo.js'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'

const repoDirs: string[] = []
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of repoDirs.splice(0)) {
    try {
      removeRepo(dir)
    } catch {}
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      removeTmpDir(dir)
    } catch {}
  }
})

interface StorySpec {
  id: string
  dependsOn?: string[]
  /** Conteúdo escrito pelo maker; string vazia estaciona a unidade por no_changes. */
  output?: string
}

interface NightOptions {
  stories: StorySpec[]
  baselineExit?: number
  withGates?: boolean
  withRollbackRef?: boolean
  maxParkedUnits?: number
  maxWallClockSeconds?: number
  permittedEffects?: string[]
}

function evalScript(filename: string): string {
  return [
    "import fs from 'node:fs'",
    'let ok = false',
    'try {',
    `  ok = fs.readFileSync('src/${filename}', 'utf8').includes('ok')`,
    '} catch {}',
    'const total = { numTotalTests: 1, numPassedTests: ok ? 1 : 0, numFailedTests: ok ? 0 : 1 }',
    'process.stdout.write(JSON.stringify(total) + "\\n")',
    'process.exit(ok ? 0 : 1)',
  ].join('\n')
}

/**
 * Repositório git temporário, plano aprovado e cenário da CLI falsa para uma noite desatendida.
 * Nenhuma rede, nenhum binário real de modelo: só a CLI falsa do próprio projeto.
 */
function setupNight(options: NightOptions) {
  const repo = makeRepo()
  repoDirs.push(repo.dir)

  fs.mkdirSync(path.join(repo.dir, 'tests'), { recursive: true })
  // `node_modules` presente satisfaz a porta de dependências do preflight já existente.
  fs.mkdirSync(path.join(repo.dir, 'node_modules'), { recursive: true })
  fs.writeFileSync(
    path.join(repo.dir, 'tests/baseline.mjs'),
    `process.exit(${options.baselineExit ?? 0})\n`,
    'utf8',
  )
  for (const story of options.stories) {
    fs.writeFileSync(
      path.join(repo.dir, `tests/check-${story.id.toLowerCase()}.mjs`),
      evalScript(`${story.id.toLowerCase()}.txt`),
      'utf8',
    )
  }
  fs.writeFileSync(
    path.join(repo.dir, 'package.json'),
    JSON.stringify({ name: 'night-repo', scripts: { test: 'node tests/baseline.mjs' } }, null, 2),
    'utf8',
  )
  repo.git(['add', '-A'])
  repo.git(['commit', '-m', 'commit inicial'])

  const missionId = `mission-night-${Date.now().toString(36)}`
  const missionDir = path.join(repo.dir, '.ade', 'missions', missionId)
  const storiesDir = path.join(missionDir, 'stories')
  fs.mkdirSync(storiesDir, { recursive: true })

  for (const story of options.stories) {
    const checkFile = `tests/check-${story.id.toLowerCase()}.mjs`
    const evalSpec = {
      id: 'E1',
      kind: 'script',
      cmd: ['node', checkFile],
      expect_exit: 0,
      timeout_s: 120,
      max_output_bytes: 65536,
      evidence: [checkFile],
      strictness: { mode: 'must_fail_before' },
      author: 'operator',
    }
    // O schema do contrato exige `then` no cenário; como chave de objeto literal ela dispara
    // unicorn/no-thenable, então o campo é atribuído depois.
    const scenario = {
      id: 'C1',
      given: 'initial state',
      when: 'maker writes the file',
      verifiers: ['E1'],
      evals: ['E1'],
      ...JSON.parse('{"then":"eval check passes"}'),
    }
    const contract = {
      format_version: 2,
      id: story.id,
      title: `Story ${story.id}`,
      complexity: 'bounded',
      needs_ui: false,
      task: `Create src/${story.id.toLowerCase()}.txt with ok`,
      workspace: { kind: 'git', root: '.' },
      risk: { level: 'normal', surfaces: [], evidence: [] },
      guardrails: { scope_paths: ['src/**', 'tests/**'], do_not_touch: ['.ade/**'], autonomy: 'safe' },
      requirements: [{ id: 'R1', ears: 'WHEN check runs THE SYSTEM SHALL pass.' }],
      scenarios: [scenario],
      verifiers: [evalSpec],
      evals: [evalSpec],
      skills: [],
      roles: {
        maker: { family: 'claude', model_id: 'claude-sonnet-5' },
        checker_round: { family: 'codex', model_id: 'codex-1' },
      },
      budget: { max_model_calls: 6, max_rework_rounds: 2 },
      ...(story.dependsOn?.length ? { depends_on: story.dependsOn } : {}),
    }
    fs.writeFileSync(path.join(storiesDir, `${story.id}.json`), JSON.stringify(contract, null, 2), 'utf8')
  }

  const discovery = {
    repo: { head: 'HEAD', dirty: false },
    scripts: { test: 'node tests/baseline.mjs' },
    languages: [{ name: 'javascript', share: 1 }],
    anchors: [{ path: 'src/**' }, { path: 'tests/**' }],
    ui: { present: false },
  }
  const planObj = {
    format_version: 2,
    id: 'plan-night',
    mission_id: missionId,
    immutable_digest: '0123456789abcdef',
    intent: 'Criar os arquivos da noite',
    briefing: { discovery },
    authorization: {
      autonomy: 'safe',
      permitted_effects: options.permittedEffects ?? [],
      eligible_skills: [],
    },
    phases: [{ epics: [{ stories: options.stories.map((s) => s.id) }] }],
    mission_budget: {
      max_usd: 50,
      max_wall_clock_seconds: options.maxWallClockSeconds ?? 28800,
      max_parked_units: options.maxParkedUnits ?? 3,
    },
    budget: { max_model_calls: 18, max_rework_rounds: 2 },
  }
  const planPath = path.join(missionDir, 'plan.json')
  fs.writeFileSync(planPath, JSON.stringify(planObj, null, 2), 'utf8')

  if (options.withGates !== false) {
    fs.writeFileSync(
      path.join(missionDir, 'gates.json'),
      JSON.stringify(
        [{ id: 'baseline', argv: ['node', 'tests/baseline.mjs'], when: 'always', expect_exit: 0, timeout_s: 60 }],
        null,
        2,
      ),
      'utf8',
    )
  }

  fs.writeFileSync(
    path.join(missionDir, 'context.json'),
    JSON.stringify({ request: 'noite', discovery, questions: [], answers: [], decisions: [] }, null, 2),
    'utf8',
  )

  const capsDir = path.join(repo.dir, '.ade')
  fs.mkdirSync(capsDir, { recursive: true })
  fs.writeFileSync(
    path.join(capsDir, 'capabilities.json'),
    JSON.stringify({ probe_ok: true, probed_at: new Date().toISOString() }, null, 2),
    'utf8',
  )

  if (options.withRollbackRef !== false) {
    const head = repo.git(['rev-parse', 'HEAD']).trim()
    repo.git(['update-ref', `refs/ade/rollback/${missionId}`, head])
  }

  const loaded = loadPlan(planPath)

  const scenarioDir = makeTmpDir('ade-night-scenario-')
  tmpDirs.push(scenarioDir)

  const makerActions = options.stories.map((story) => {
    const files: Record<string, string> = {}
    const content = story.output ?? 'ok\n'
    if (content !== '') files[`src/${story.id.toLowerCase()}.txt`] = content
    return {
      files,
      result: {
        format_version: 1,
        story_id: story.id,
        state: 'done',
        phase: 'green',
        round: 1,
        tree_before: '0123456789abcdef',
        tree_after: 'fedcba9876543210',
        eval_records: [],
        gate_records: [],
        passes: true,
        reason: 'ok',
        sources: ['contract'],
      },
      stdout: JSON.stringify({
        total_cost_usd: 0.01,
        structured_output: {
          format_version: 1,
          story_id: story.id,
          state: 'done',
          phase: 'green',
          round: 1,
          passes: true,
        },
      }),
    }
  })
  fs.writeFileSync(path.join(scenarioDir, 'maker.json'), JSON.stringify(makerActions, null, 2), 'utf8')
  fs.writeFileSync(
    path.join(scenarioDir, 'checker.json'),
    JSON.stringify(options.stories.map(() => approvedReviewAction()), null, 2),
    'utf8',
  )

  let clockMs = Date.now()
  const now = () => clockMs
  const advanceClock = (ms: number) => {
    clockMs += ms
  }

  const quotaCalls: string[] = []
  const quotaPort = {
    readReceipt: async () => {
      quotaCalls.push(new Date(clockMs).toISOString())
      return {
        source: 'official',
        family: 'claude',
        used_percent: 0,
        reserved_percent: 0,
        observed_at: new Date(clockMs).toISOString(),
        weekly_reset_at: new Date(clockMs + 86_400_000).toISOString(),
      }
    },
  }

  // O Checker real precisa da revisão do momento (árvore e digest observados agora).
  const dispatchCodexWrapper = async (opts: any) => {
    const wtPort = createGitPort({ worktreeDir: opts.cwd })
    const tree = await wtPort.worktreeTree()
    const changedPaths = await wtPort.dirtyPaths()
    const digest = computeObservedInputDigest({ tree, changedPaths })
    const checkerFile = path.join(scenarioDir, 'checker.json')
    let actions: any[] = []
    try {
      actions = JSON.parse(fs.readFileSync(checkerFile, 'utf8'))
    } catch {}
    const countFile = path.join(scenarioDir, 'checker.count')
    let count = 0
    if (fs.existsSync(countFile)) count = parseInt(fs.readFileSync(countFile, 'utf8').trim(), 10) || 0
    if (!actions[count]) actions[count] = approvedReviewAction()
    actions[count].result.input_revision = { tree, digest }
    actions[count].result.evidence = [
      {
        criterion: 'R1',
        result_ref: 'eval:E1',
        input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    ]
    actions[count].result.sources = ['eval:E1']
    fs.writeFileSync(checkerFile, JSON.stringify(actions, null, 2), 'utf8')
    return dispatchCodex(opts)
  }

  const env = {
    CI: 'true',
    ADE_HOME: repo.dir,
    ADE_FAKE_CLI: '1',
    ADE_FAKE_SCENARIO: scenarioDir,
  } as NodeJS.ProcessEnv

  return {
    repo,
    missionId,
    missionDir,
    planPath,
    loaded,
    scenarioDir,
    env,
    quotaPort,
    quotaCalls,
    advanceClock,
    now,
    deps: {
      env,
      quotaPort,
      dispatchCodex: dispatchCodexWrapper,
      now,
    },
  }
}

/** Grava no journal a aprovação congelada do plano, como `ade approve` faria. */
async function approvePlan(fixture: ReturnType<typeof setupNight>) {
  const journal = openJournal({ missionDir: fixture.missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  const contractDigests: Record<string, string> = {}
  for (const story of fixture.loaded.stories) contractDigests[story.id] = digest16(story.contract)
  await journal.append({
    kind: 'decision',
    source: 'operator',
    data: {
      decision: 'plan_approved',
      digest: digest16(fixture.loaded.plan),
      summary_digest: digest16({ plan: digest16(fixture.loaded.plan), contracts: contractDigests }),
      contract_digests: contractDigests,
      eligible_skills: fixture.loaded.plan.authorization.eligible_skills,
      permitted_effects: fixture.loaded.plan.authorization.permitted_effects,
    },
  })
  await journal.close()
}

function journalEvents(missionDir: string) {
  return readJournal(path.join(missionDir, 'journal.jsonl')).events
}

// (1) Precondição dura falha: o lote é recusado com exit 2, as falhas ficam no journal e
// nenhuma chamada de modelo é despachada.
test('test_criterio_1_precondicao_dura_falha_recusa_lote_com_exit_2_e_sem_chamada_paga', async () => {
  const fixture = setupNight({
    stories: [{ id: 'S1' }],
    baselineExit: 1,
    withGates: false,
    withRollbackRef: false,
  })
  await approvePlan(fixture)

  const dispatchClaude = vi.fn()
  const exitCode = await runCommand(
    { plan: fixture.planPath, repo: fixture.repo.dir, acceptStaleVersion: false, unattended: true },
    { ...fixture.deps, dispatchClaude },
  )

  expect(exitCode).toBe(2)
  expect(dispatchClaude).not.toHaveBeenCalled()
  expect(fixture.quotaCalls).toEqual([])

  const refused = journalEvents(fixture.missionDir).find((e: any) => e.kind === 'unattended_refused')
  expect(refused).toBeTruthy()
  const failedIds = (refused as any).data.failures.map((f: any) => f.id).sort()
  expect(failedIds).toEqual(['eval_baseline_green', 'gates_active', 'rollback_point'])
  for (const failure of (refused as any).data.failures) {
    expect(typeof failure.reason).toBe('string')
    expect(failure.reason.length).toBeGreaterThan(0)
  }
}, 60_000)

// (2) Backlog aprovado esgotado sem paradas: exit 0 e resumo do lote com as unidades concluídas.
test('test_criterio_2_backlog_sem_paradas_sai_exit_0_e_resume_unidades_concluidas', async () => {
  const fixture = setupNight({ stories: [{ id: 'S1' }, { id: 'S2' }] })
  await approvePlan(fixture)

  const exitCode = await runCommand(
    { plan: fixture.planPath, repo: fixture.repo.dir, acceptStaleVersion: false, unattended: true },
    fixture.deps,
  )

  expect(exitCode).toBe(0)
  const events = journalEvents(fixture.missionDir)
  const batch = events.find((e: any) => e.kind === 'batch_summary') as any
  expect(batch).toBeTruthy()
  expect(batch.data.completed_units).toEqual(['S1', 'S2'])
  expect(batch.data.parked_units).toEqual([])
  expect(batch.data.stop_reason).toBe(null)
  const summary = events.find((e: any) => e.kind === 'telemetry' && e.data?.scope === 'mission_summary') as any
  expect(summary.data.outcome).toBe('completed')
}, 180_000)

// (3) Noite com unidade parada: exit 3 e relatório com motivo e caminho absoluto por unidade parada.
test('test_criterio_3_noite_com_parada_sai_exit_3_e_relatorio_traz_motivo_e_caminho_absoluto', async () => {
  const fixture = setupNight({ stories: [{ id: 'S1', output: '' }, { id: 'S2' }] })
  await approvePlan(fixture)

  const exitCode = await runCommand(
    { plan: fixture.planPath, repo: fixture.repo.dir, acceptStaleVersion: false, unattended: true },
    fixture.deps,
  )

  expect(exitCode).toBe(3)

  const parked = journalEvents(fixture.missionDir).filter((e: any) => e.kind === 'unit_parked') as any[]
  expect(parked.map((e) => e.data.unit)).toEqual(['S1'])
  expect(parked[0].data.reason).toBe('no_changes')
  expect(path.isAbsolute(parked[0].data.evidence_path)).toBe(true)

  const outPath = path.join(fixture.missionDir, 'night-report.md')
  const reportCode = await reportMain(['--mission', fixture.missionDir, '--out', outPath], {
    stdout: () => {},
    stderr: () => {},
  })
  expect(reportCode).toBe(0)
  const report = fs.readFileSync(outPath, 'utf8')
  expect(report).toContain('Unidades paradas')
  expect(report).toContain('no_changes')
  expect(report).toContain(parked[0].data.evidence_path)
}, 180_000)

// (4) Orçamento de parede esgotado com story em curso: a story chega ao checkpoint sem efeito
// repetido e é o lote que para, não a story abortada no meio do efeito.
test('test_criterio_4_orcamento_de_parede_para_o_lote_sem_abortar_a_story_em_curso', async () => {
  const fixture = setupNight({
    stories: [{ id: 'S1' }, { id: 'S2' }],
    maxWallClockSeconds: 3600,
  })
  await approvePlan(fixture)
  // A parede estoura durante a primeira story: o relógio avança na reserva de cota dela.
  const quotaPort = {
    readReceipt: async (...args: any[]) => {
      const receipt = await fixture.quotaPort.readReceipt(...(args as []))
      fixture.advanceClock(10 * 3600 * 1000)
      return receipt
    },
  }

  const exitCode = await runCommand(
    { plan: fixture.planPath, repo: fixture.repo.dir, acceptStaleVersion: false, unattended: true },
    { ...fixture.deps, quotaPort },
  )

  expect(exitCode).toBe(3)
  const events = journalEvents(fixture.missionDir)
  const stopped = events.find((e: any) => e.kind === 'batch_stopped') as any
  expect(stopped.data.reason).toBe('wall_clock_exhausted')
  // A story em curso terminou o próprio efeito: comitada, uma única vez.
  const done = events.filter((e: any) => e.kind === 'story_done' && e.data?.unit === 'S1')
  expect(done).toHaveLength(1)
  expect((done[0] as any).data.status).toBe('committed')
  // A story seguinte nunca foi reivindicada.
  expect(events.some((e: any) => e.kind === 'story_started' && e.data?.unit === 'S2')).toBe(false)
  expect(fixture.quotaCalls).toHaveLength(1)
}, 180_000)

// (5) Teto de unidades estacionadas atingido: o lote para em vez de reivindicar mais trabalho.
test('test_criterio_5_teto_de_unidades_estacionadas_para_o_lote', async () => {
  const fixture = setupNight({
    stories: [{ id: 'S1', output: '' }, { id: 'S2' }],
    maxParkedUnits: 1,
  })
  await approvePlan(fixture)

  const exitCode = await runCommand(
    { plan: fixture.planPath, repo: fixture.repo.dir, acceptStaleVersion: false, unattended: true },
    fixture.deps,
  )

  expect(exitCode).toBe(3)
  const events = journalEvents(fixture.missionDir)
  const stopped = events.find((e: any) => e.kind === 'batch_stopped') as any
  expect(stopped.data.reason).toBe('max_parked_units')
  expect(events.some((e: any) => e.kind === 'story_started' && e.data?.unit === 'S2')).toBe(false)
}, 180_000)

// (6) Unidade bloqueada aguarda operador: as independentes já aprovadas continuam, as dependentes
// dela não rodam e o motor não concede aprovação nova.
test('test_criterio_6_unidade_bloqueada_estaciona_independentes_seguem_dependentes_nao_rodam', async () => {
  const fixture = setupNight({
    stories: [{ id: 'S1', output: '' }, { id: 'S2' }, { id: 'S3', dependsOn: ['S1'] }],
  })
  await approvePlan(fixture)

  const exitCode = await runCommand(
    { plan: fixture.planPath, repo: fixture.repo.dir, acceptStaleVersion: false, unattended: true },
    fixture.deps,
  )

  expect(exitCode).toBe(3)
  const events = journalEvents(fixture.missionDir)
  const started = events
    .filter((e: any) => e.kind === 'story_started')
    .map((e: any) => e.data.unit)
  expect(started).toContain('S2')
  expect(started).not.toContain('S3')

  const parked = events.filter((e: any) => e.kind === 'unit_parked') as any[]
  expect(parked.map((e) => e.data.unit)).toEqual(['S1'])

  const batch = events.find((e: any) => e.kind === 'batch_summary') as any
  expect(batch.data.completed_units).toEqual(['S2'])
  expect(batch.data.parked_units).toEqual(['S1'])

  // Nenhuma aprovação nova concedida pelo motor durante a noite.
  const approvals = events.filter(
    (e: any) => e.kind === 'decision' && e.data?.decision === 'plan_approved',
  )
  expect(approvals).toHaveLength(1)
  expect((approvals[0] as any).source).toBe('operator')
}, 180_000)

// (7) Efeito externo fora do `permitted_effects` aprovado é recusado antes de acontecer.
test('test_criterio_7_efeito_externo_fora_do_permitted_effects_e_recusado_antes_de_acontecer', async () => {
  const appended: any[] = []
  const journal = { append: async (event: any) => { appended.push(event); return event } }
  const step = vi.fn(async (_spec: any, effectFn: any) => ({ status: 'ok', result: await effectFn() }))
  const effectFn = vi.fn(async () => 'efeito')

  const guarded = guardExternalEffects({ step, journal, permittedEffects: ['push'] })

  await expect(
    guarded({ id: 'S1:pr', effect_class: 'pull_request', input: {} }, effectFn),
  ).rejects.toThrow(/open_pr/)
  expect(effectFn).not.toHaveBeenCalled()
  expect(step).not.toHaveBeenCalled()
  const refused = appended.find((e) => e.kind === 'effect_refused')
  expect(refused.data).toMatchObject({
    effect_class: 'pull_request',
    required_effect: 'open_pr',
    permitted_effects: ['push'],
    reason: 'effect_not_permitted',
  })

  // O efeito aprovado atravessa o guarda sem recusa; efeito interno também.
  await guarded({ id: 'S1:push', effect_class: 'push', input: {} }, effectFn)
  await guarded({ id: 'S1:commit', effect_class: 'local_commit', input: {} }, effectFn)
  expect(step).toHaveBeenCalledTimes(2)
})

// (8) `taskkill` recusado pelo sistema: o motor usa o fallback limitado e grava a forma usada,
// sem que decisão alguma dependa do resultado.
test('test_criterio_8_taskkill_recusado_usa_fallback_limitado_e_grava_terminated_by', async () => {
  const eperm = Object.assign(new Error('acesso negado'), { code: 'EPERM' })
  const killed: Array<[number, string]> = []

  const fallback = await terminateProcessTree({
    pid: 4321,
    platform: 'win32',
    timeoutMs: 0,
    isAlive: () => true,
    now: () => 0,
    sleep: async () => {},
    execFileSync: () => {
      throw eperm
    },
    kill: (pid, signal) => {
      killed.push([pid, signal])
    },
  })

  expect(fallback.terminated_by).toBe('job_fallback')
  expect(killed).toEqual([[4321, 'SIGKILL']])

  // Falha não tratada pelo fallback (erro inesperado) registra `failed` e preserva o erro.
  const failed = await terminateProcessTree({
    pid: 4321,
    platform: 'win32',
    timeoutMs: 0,
    isAlive: () => true,
    now: () => 0,
    sleep: async () => {},
    execFileSync: () => {
      throw new Error('erro desconhecido')
    },
    kill: (pid, signal) => {
      killed.push([pid, signal])
    },
  })
  expect(['taskkill', 'job_fallback', 'already_exited', 'sigkill', 'failed']).toContain(failed.terminated_by)
  expect(failed.terminated_by).toBe('failed')
  expect(failed.error).toBe('erro desconhecido')
  expect(killed).toHaveLength(1)
})

// (9) `ade run` sem `--unattended` mantém o comportamento atual: nenhuma precondição dura recusa
// o lote e a unidade é despachada como antes.
test('test_criterio_9_run_sem_unattended_mantem_comportamento_atual', async () => {
  const fixture = setupNight({
    stories: [{ id: 'S1' }],
    baselineExit: 1,
    withGates: false,
    withRollbackRef: false,
  })
  await approvePlan(fixture)

  const exitCode = await runCommand(
    { plan: fixture.planPath, repo: fixture.repo.dir, acceptStaleVersion: false },
    fixture.deps,
  )

  expect(exitCode).toBe(0)
  const events = journalEvents(fixture.missionDir)
  expect(events.some((e: any) => e.kind === 'unattended_refused')).toBe(false)
  expect(events.some((e: any) => e.kind === 'story_started' && e.data?.unit === 'S1')).toBe(true)
}, 180_000)
