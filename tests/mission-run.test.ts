import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { dispatchClaude } from '../src/adapters/claude/index.js'
import { dispatchCodex } from '../src/adapters/codex/index.js'
import { approvedReviewAction, makeCheckerDouble } from './helpers/checker-double.js'
import { checkCanary, plantCanary } from '../src/contain/canary.js'
import { contain } from '../src/contain/contain.js'
import { computeObservedInputDigest, runStory } from '../src/engine.js'
import { loadPlan } from '../src/engine/plan-load.js'
import { prepareStory } from '../src/engine/prepare.js'
import { nextReady, runSequentialMission } from '../src/engine/schedule.js'
import { createEvalRunner } from '../src/evals/eval-runner.js'
import { createGateRunner } from '../src/gates/gates.js'
import { createGitPort } from '../src/git/gitport.js'
import { digest16 } from '../src/journal/canonical.js'
import { openJournal, readJournal } from '../src/journal/journal.js'
import { approveMission, replanRemaining } from '../src/mission/plan-lifecycle.js'
import { compilePack } from '../src/pack/pack.js'
import { reconcileAll } from '../src/step/reconcile.js'
import { createStepRunner } from '../src/step/step.js'
import { makeRepo, removeRepo } from './helpers/git-repo.js'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI_PATH = path.join(ROOT, 'src/adapters/fake/cli.js')

let repoDirs: string[] = []
let tmpDirs: string[] = []
let openJournals: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const j of openJournals) {
    try {
      await j.close()
    } catch {}
  }
  openJournals = []

  for (const dir of repoDirs) {
    try {
      removeRepo(dir)
    } catch {}
  }
  repoDirs = []

  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir)
    } catch {}
  }
  tmpDirs = []
})

function createCheckScript(filename: string): string {
  return [
    "import fs from 'node:fs'",
    'let ok = false',
    'try {',
    `  const content = fs.readFileSync('src/${filename}', 'utf8')`,
    "  ok = content.includes('ok')",
    '} catch {}',
    'if (ok) {',
    '  process.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }) + "\\n")',
    '  process.exit(0)',
    '} else {',
    '  process.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 0, numFailedTests: 1 }) + "\\n")',
    '  process.exit(1)',
    '}',
  ].join('\n')
}

interface SetupOptions {
  dependencies?: Record<string, string[]>
  makerOutputs?: Record<string, string>
  planBudgetCalls?: number
  storyBudgetCalls?: number
  approved?: boolean
  briefing?: Record<string, any>
}

async function setupThreeStoryFixture(options: SetupOptions = {}) {
  const repo = makeRepo()
  repoDirs.push(repo.dir)

  fs.mkdirSync(path.join(repo.dir, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(repo.dir, 'tests/check-s1.mjs'), createCheckScript('s1.txt'), 'utf8')
  fs.writeFileSync(path.join(repo.dir, 'tests/check-s2.mjs'), createCheckScript('s2.txt'), 'utf8')
  fs.writeFileSync(path.join(repo.dir, 'tests/check-s3.mjs'), createCheckScript('s3.txt'), 'utf8')

  const genericCheckCode = [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "import { execSync } from 'node:child_process'",
    "let target = 's1.txt'",
    "try {",
    "  const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim()",
    "  const match = branch.match(/S(\\d+)/i)",
    "  if (match) target = `s${match[1]}.txt`",
    "  else {",
    "    const m2 = path.basename(process.cwd()).match(/S(\\d+)/i)",
    "    if (m2) target = `s${m2[1]}.txt`",
    "  }",
    "} catch {",
    "  const m2 = path.basename(process.cwd()).match(/S(\\d+)/i)",
    "  if (m2) target = `s${m2[1]}.txt`",
    "}",
    "let ok = false",
    "try {",
    "  const content = fs.readFileSync(path.join('src', target), 'utf8')",
    "  ok = content.includes('ok')",
    "} catch {}",
    "if (ok) {",
    '  process.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }) + "\\n")',
    "  process.exit(0)",
    "} else {",
    '  process.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 0, numFailedTests: 1 }) + "\\n")',
    "  process.exit(1)",
    "}",
  ].join('\n')
  fs.writeFileSync(path.join(repo.dir, 'tests/check.mjs'), genericCheckCode, 'utf8')
  fs.writeFileSync(
    path.join(repo.dir, 'package.json'),
    JSON.stringify({ name: 'test-repo', scripts: { test: 'node tests/check.mjs' } }, null, 2),
    'utf8',
  )
  repo.git(['add', '-A'])
  repo.git(['commit', '-m', 'commit inicial'])

  const missionId = `mission-${Date.now().toString(36)}`
  const missionDir = path.join(repo.dir, '.ade', 'missions', missionId)
  const storiesDir = path.join(missionDir, 'stories')
  fs.mkdirSync(storiesDir, { recursive: true })

  const storyIds = ['S1', 'S2', 'S3']
  const depsMap = options.dependencies ?? { S1: [], S2: ['S1'], S3: ['S2'] }

  for (const id of storyIds) {
    const filename = `${id.toLowerCase()}.txt`
    const checkFile = `tests/check-${id.toLowerCase()}.mjs`
    const contract = {
      format_version: 2,
      id,
      title: `Story ${id}`,
      complexity: 'bounded',
      needs_ui: false,
      task: `Create src/${filename} with ok`,
      workspace: { kind: 'git', root: '.' },
      risk: { level: 'normal', surfaces: [], evidence: [] },
      guardrails: {
        scope_paths: ['src/**', 'tests/**'],
        do_not_touch: ['.ade/**'],
        autonomy: 'safe',
      },
      requirements: [{ id: 'R1', ears: `WHEN check runs THE SYSTEM SHALL pass.` }],
      scenarios: [
        {
          id: 'C1',
          given: `initial state without ${filename}`,
          when: `maker creates ${filename} with ok`,
          then: 'eval check passes',
          verifiers: ['E1'],
          evals: ['E1'],
        },
      ],
      verifiers: [
        {
          id: 'E1',
          kind: 'script',
          cmd: ['node', checkFile],
          expect_exit: 0,
          timeout_s: 120,
          max_output_bytes: 65536,
          evidence: [checkFile],
          strictness: { mode: 'must_fail_before' },
          author: 'operator',
        },
      ],
      evals: [
        {
          id: 'E1',
          kind: 'script',
          cmd: ['node', checkFile],
          expect_exit: 0,
          timeout_s: 120,
          max_output_bytes: 65536,
          evidence: [checkFile],
          strictness: { mode: 'must_fail_before' },
          author: 'operator',
        },
      ],
      skills: [],
      roles: {
        maker: { family: 'claude', model_id: 'claude-sonnet-5' },
        checker_round: { family: 'codex', model_id: 'codex-1' },
      },
      budget: {
        max_model_calls: options.storyBudgetCalls ?? 6,
        max_rework_rounds: 2,
      },
      ...(depsMap[id]?.length ? { depends_on: depsMap[id] } : {}),
    }

    fs.writeFileSync(path.join(storiesDir, `${id}.json`), JSON.stringify(contract, null, 2), 'utf8')
  }

  const planObj = {
    format_version: 2,
    id: 'plan-1',
    mission_id: missionId,
    immutable_digest: '0123456789abcdef',
    intent: 'Criar src/s1.txt, src/s2.txt e src/s3.txt com ok',
    briefing: options.briefing ?? {
      discovery: {
        repo: { head: 'HEAD', dirty: false },
        scripts: { test: 'node tests/check.mjs' },
        languages: [{ name: 'javascript', share: 1 }],
        anchors: [{ path: 'src/**' }, { path: 'tests/**' }],
        ui: { present: false },
      },
    },
    authorization: {
      autonomy: 'safe',
      permitted_effects: [],
      eligible_skills: [],
    },
    phases: [
      {
        epics: [
          {
            stories: storyIds,
          },
        ],
      },
    ],
    mission_budget: {
      max_usd: 50,
      max_wall_clock_seconds: 28800,
      max_parked_units: 3,
    },
    budget: {
      max_model_calls: options.planBudgetCalls ?? 18,
      max_rework_rounds: 2,
    },
  }
  const planPath = path.join(missionDir, 'plan.json')
  fs.writeFileSync(planPath, JSON.stringify(planObj, null, 2), 'utf8')

  fs.writeFileSync(
    path.join(missionDir, 'context.json'),
    JSON.stringify(
      {
        request: 'Criar src/s1.txt, src/s2.txt e src/s3.txt com ok',
        discovery: {
          repo: { head: 'HEAD', dirty: false },
          scripts: { test: 'node tests/check.mjs' },
          languages: [{ name: 'javascript', share: 1 }],
          anchors: [{ path: 'src/**' }, { path: 'tests/**' }],
          ui: { present: false },
        },
        questions: [],
        answers: [],
        decisions: [],
      },
      null,
      2,
    ),
    'utf8',
  )

  const loaded = loadPlan(planPath)

  const scenarioDir = makeTmpDir('ade-fake-scenario-')
  tmpDirs.push(scenarioDir)

  const makerOutputs = options.makerOutputs ?? {
    S1: 'ok\n',
    S2: 'ok\n',
    S3: 'ok\n',
  }

  // Define maker actions for all 3 stories
  const makerActions: any[] = []
  for (const id of storyIds) {
    const filename = `src/${id.toLowerCase()}.txt`
    const content = makerOutputs[id]
    const files: Record<string, string> = {}
    if (content !== undefined && content !== '') {
      files[filename] = content
    }
    makerActions.push({
      files,
      result: {
        format_version: 1,
        story_id: id,
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
          story_id: id,
          state: 'done',
          phase: 'green',
          round: 1,
          passes: true,
        },
      }),
    })
  }
  fs.writeFileSync(path.join(scenarioDir, 'maker.json'), JSON.stringify(makerActions, null, 2), 'utf8')

  // Checker actions: approves all stories
  const checkerActions = storyIds.map(() => approvedReviewAction())
  fs.writeFileSync(path.join(scenarioDir, 'checker.json'), JSON.stringify(checkerActions, null, 2), 'utf8')


  const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  openJournals.push(journal)

  if (options.approved !== false) {
    // Registra aprovação congelada do plano no journal
    const contractDigests: Record<string, string> = {}
    for (const story of loaded.stories) {
      contractDigests[story.id] = digest16(story.contract)
    }
    await journal.append({
      kind: 'decision',
      source: 'operator',
      data: {
        decision: 'plan_approved',
        digest: digest16(loaded.plan),
        summary_digest: digest16({ plan: digest16(loaded.plan), contracts: contractDigests }),
        contract_digests: contractDigests,
        eligible_skills: loaded.plan.authorization.eligible_skills,
        permitted_effects: loaded.plan.authorization.permitted_effects,
      },
    })
  }

  const { step } = createStepRunner({ journal, missionDir })

  const deps = {
    journal,
    step,
    runtimeStamp: '1:aaaaaaaa:bbbbbbbb',
    gitPortFor: (dir: string) => createGitPort({ worktreeDir: dir }),
    prepareStory,
    createEvalRunner,
    createGateRunner,
    compilePack,
    contain,
    plantCanary,
    checkCanary,
    dispatchClaude,
    dispatchCodex: async (opts: any) => {
      const wtPort = createGitPort({ worktreeDir: opts.cwd })
      const tree = await wtPort.worktreeTree()
      const changedPaths = await wtPort.dirtyPaths()
      const digest = computeObservedInputDigest({
        tree,
        changedPaths,
      })
      const checkerFile = path.join(scenarioDir, 'checker.json')
      let actions: any[] = []
      if (fs.existsSync(checkerFile)) {
        try { actions = JSON.parse(fs.readFileSync(checkerFile, 'utf8')) } catch {}
      }
      const countFile = path.join(scenarioDir, 'checker.count')
      let count = 0
      if (fs.existsSync(countFile)) {
        count = parseInt(fs.readFileSync(countFile, 'utf8').trim(), 10) || 0
      }
      if (!actions[count]) {
        actions[count] = approvedReviewAction()
      }
      actions[count].result.input_revision = { tree, digest }
      let storyContract: any = null
      if (opts.missionDir && opts.unit) {
        const storyContractPath = path.join(opts.missionDir, 'stories', `${opts.unit}.json`)
        if (fs.existsSync(storyContractPath)) {
          try { storyContract = JSON.parse(fs.readFileSync(storyContractPath, 'utf8')) } catch {}
        }
      }
      const evalId = storyContract?.evals?.[0]?.id || storyContract?.verifiers?.[0]?.id || 'E1'
      const ref = `eval:${evalId}`
      actions[count].result.evidence = [
        {
          criterion: 'R1',
          result_ref: ref,
          input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      ]
      actions[count].result.sources = [ref]
      fs.writeFileSync(checkerFile, JSON.stringify(actions, null, 2), 'utf8')
      try {
        return await dispatchCodex(opts)
      } catch (err) {
        console.error('DISPATCH_CODEX_ERROR:', err)
        throw err
      }
    },
    reconcileAll,
    resolved: {
      exe: process.execPath,
      prefixArgs: [CLI_PATH],
    },
    workerEnv: {
      ADE_FAKE_SCENARIO: scenarioDir,
      ADE_FAKE_ROLE: 'maker',
    },
    quotaPort: {
      readReceipt: async () => ({
        source: 'official',
        family: 'claude',
        used_percent: 0,
        reserved_percent: 0,
        observed_at: new Date().toISOString(),
        weekly_reset_at: new Date(Date.now() + 86400000).toISOString(),
      }),
    },
    capabilities: { probe_ok: true },
    env: { CI: 'true', ADE_FAKE_CLI: '1' } as NodeJS.ProcessEnv,
    now: () => Date.now(),
    preflight: async () => ({
      ready: true,
      failures: [],
      checks: [{ id: 'proof_target', status: 'ready', reason: null }],
      calls_avoided: 0,
    }),
    discovery: {
      repo: { head: 'HEAD', dirty: false },
      scripts: { test: 'node tests/check.mjs' },
      languages: [{ name: 'javascript', share: 1 }],
      anchors: [{ path: 'src/**' }, { path: 'tests/**' }],
      ui: { present: false },
    },
    runStory,
    nextReady,
    replanRemaining,
    loadPlan,
    acquireLease: async () => ({ release: async () => {} }),
  }

  return {
    repo,
    loaded,
    planPath,
    missionDir,
    scenarioDir,
    deps,
  }
}

describe('v0.3: Executar e retomar missão sequencial', { timeout: 80_000 }, () => {
  // Critério (1): Dado um plano aprovado com várias stories dependentes, quando ade run --plan é executado,
  // então cada story roda somente depois de suas dependências, uma por vez, e a missão termina apenas quando todas estiverem concluídas.
  test('test_criterio_1_execucao_sequencial_com_dependencias_ate_encerramento_completo', async () => {
    const fixture = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
    })

    const result = await runSequentialMission(fixture.deps, {
      loaded: fixture.loaded,
      repoDir: fixture.repo.dir,
      missionDir: fixture.missionDir,
    })

    expect(result.status).toBe('completed')
    expect(result.exitCode).toBe(0)
    expect(result.completedStories).toEqual(['S1', 'S2', 'S3'])

    // Verifica que os commits foram criados na ordem correta
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const storyDoneEvents = events.filter((e) => e.kind === 'story_done' && (e.data?.status === 'committed' || e.data?.status === 'delivered'))
    expect(storyDoneEvents.map((e) => e.unit || e.data?.unit)).toEqual(['S1', 'S2', 'S3'])
  })

  // Critério (2): Dada uma interrupção antes, durante ou depois de uma story, quando o mesmo comando é executado novamente,
  // então intenções ambíguas são reconciliadas, efeitos e chamadas já consumidos não se repetem, a story atual continua do checkpoint seguro e as seguintes prosseguem normalmente.
  test('test_criterio_2_interrupcao_reconcilia_sem_repetir_efeitos_e_retoma_ate_o_fim', async () => {
    const fixture = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
    })

    // Simula interrupção após S1 completar e antes de S2 comitar (com intenção aberta para S2)
    // 1. Roda apenas S1
    const s1Result = await runStory(fixture.deps, {
      loaded: fixture.loaded,
      story: fixture.loaded.stories[0],
      repoDir: fixture.repo.dir,
      missionDir: fixture.missionDir,
    })
    expect(s1Result.status).toBe('delivered')

    // 2. Registra intenção de step para S2 simulando crash
    await fixture.deps.journal.append({
      kind: 'step_intent',
      step_id: 'S2:r1:maker',
      effect_class: 'model_call',
      input_digest: '0123456789abcdef',
    })

    // Retoma a missão sequencial
    const resumedResult = await runSequentialMission(fixture.deps, {
      loaded: fixture.loaded,
      repoDir: fixture.repo.dir,
      missionDir: fixture.missionDir,
    })

    expect(resumedResult.status).toBe('completed')
    expect(resumedResult.exitCode).toBe(0)
    expect(resumedResult.completedStories).toContain('S1')
    expect(resumedResult.completedStories).toContain('S2')
    expect(resumedResult.completedStories).toContain('S3')

    // Reconciliação foi gravada no journal
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.some((e) => e.kind === 'run_resumed')).toBe(true)
  })

  // Critério (3): Dadas stories já concluídas e ligadas aos digests preservados, quando uma missão replanejada ou retomada roda,
  // então elas são ignoradas sem nova reserva, pacote, chamada, revisão ou commit.
  test('test_criterio_3_stories_concluidas_e_preservadas_sao_ignoradas_na_retomada', async () => {
    const fixture = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
    })

    // Marca S1 como já preservada/concluída no journal
    await fixture.deps.journal.append({
      kind: 'decision',
      source: 'operator',
      data: {
        decision: 'stories_preserved',
        preserved: [
          {
            unit: 'S1',
            status: 'committed',
            commit: 'commit-s1-already-done',
            digest: digest16(fixture.loaded.stories[0].contract),
            from_mission: 'prior-mission',
          },
        ],
      },
    })

    // S1 já foi executada na missão anterior, então o contador do cenário começa em 1
    fs.writeFileSync(path.join(fixture.scenarioDir, 'maker.count'), '1\n', 'utf8')
    fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.count'), '1\n', 'utf8')

    const initialReservedCalls = (await readJournal(path.join(fixture.missionDir, 'journal.jsonl'))).events.filter(
      (e) => e.kind === 'budget_reserved' && (e.unit === 'S1' || e.data?.unit === 'S1'),
    ).length

    const result = await runSequentialMission(fixture.deps, {
      loaded: fixture.loaded,
      repoDir: fixture.repo.dir,
      missionDir: fixture.missionDir,
    })

    expect(result.status).toBe('completed')
    expect(result.exitCode).toBe(0)

    // S1 não deve ter recebido nenhuma nova reserva de chamada
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const finalReservedCallsS1 = events.filter(
      (e) => e.kind === 'budget_reserved' && (e.unit === 'S1' || e.data?.unit === 'S1'),
    ).length
    expect(finalReservedCallsS1).toBe(initialReservedCalls)

    // S1 foi ignorada e preservada
    const s1Done = events.filter((e) => e.kind === 'story_done' && (e.unit === 'S1' || e.data?.unit === 'S1'))
    // Não foi gerado novo story_done commitado para S1 nesta execução
    expect(s1Done).toHaveLength(0)
  })

  // Critério (4): Dada uma story que produz no_changes, quando ainda não houve replanejamento por esse motivo,
  // então somente ela e suas sucessoras pendentes são recompiladas e a execução continua;
  // se o novo contrato também não produzir alteração, a missão fica aguardando o operador sem laço automático.
  test('test_criterio_4_no_changes_replaneja_uma_vez_e_estaciona_na_reincidencia', async () => {
    // Cenário 1: S2 produz no_changes na primeira tentativa, é replanejada e sucedida
    const fixture1 = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
      makerOutputs: { S1: 'ok\n', S2: '', S3: 'ok\n' }, // S2 sem alterações
    })

    // Mock do replanRemaining para simular recompilação com correção
    let replanCalled = false
    const originalReplan = fixture1.deps.replanRemaining
    fixture1.deps.replanRemaining = async (opts: any, deps: any) => {
      replanCalled = true
      // Na segunda tentativa o maker cria o arquivo correto
      fs.writeFileSync(
        path.join(fixture1.scenarioDir, 'maker.json'),
        JSON.stringify([
          { files: { 'src/s2.txt': 'ok\n' }, result: { format_version: 1, story_id: 'S2', state: 'done', phase: 'green', round: 1, passes: true }, stdout: '{}' },
          { files: { 'src/s3.txt': 'ok\n' }, result: { format_version: 1, story_id: 'S3', state: 'done', phase: 'green', round: 1, passes: true }, stdout: '{}' },
        ]),
        'utf8',
      )
      fs.writeFileSync(path.join(fixture1.scenarioDir, 'maker.count'), '0\n', 'utf8')
      fs.writeFileSync(path.join(fixture1.scenarioDir, 'checker.count'), '0\n', 'utf8')
      return originalReplan(opts, deps)
    }

    const result1 = await runSequentialMission(fixture1.deps, {
      loaded: fixture1.loaded,
      repoDir: fixture1.repo.dir,
      missionDir: fixture1.missionDir,
    })

    expect(replanCalled).toBe(true)
    expect(result1.status).toBe('awaiting_operator')
    expect(result1.reason).toBe('approval_missing')

    // Cenário 2: Reincidência de no_changes após replanejamento estaciona sem laço
    const fixture2 = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
      makerOutputs: { S1: 'ok\n', S2: '', S3: 'ok\n' },
      briefing: { replan_count: 1 },
    })

    const result2 = await runSequentialMission(fixture2.deps, {
      loaded: fixture2.loaded,
      repoDir: fixture2.repo.dir,
      missionDir: fixture2.missionDir,
    })

    expect(result2.status).toBe('awaiting_operator')
    expect(result2.exitCode).toBe(3)
    expect(result2.reason).toBe('no_changes')
  })

  // Critério (5): Dada uma story bloqueada, com dependência falha ou aprovação ausente ou divergente,
  // quando o scheduler a encontra, então nenhuma story dependente é iniciada e o estado informa o motivo e a próxima ação.
  test('test_criterio_5_story_bloqueada_dependencia_falha_ou_aprovacao_divergente_bloqueia_dependentes', async () => {
    // 1. Dependência falha / bloqueada
    const fixture = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
    })

    // Simula falha em S1 (awaiting_operator por preflight)
    await fixture.deps.journal.append({
      kind: 'story_done',
      unit: 'S1',
      data: {
        unit: 'S1',
        status: 'awaiting_operator',
        reason: 'preflight_failed',
        commit: null,
      },
    })

    const result = await runSequentialMission(fixture.deps, {
      loaded: fixture.loaded,
      repoDir: fixture.repo.dir,
      missionDir: fixture.missionDir,
    })

    expect(result.status).toBe('awaiting_operator')
    expect(result.exitCode).toBe(3)
    expect(result.reason).toBe('dependency_failed')
    // S2 e S3 não foram iniciadas
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.some((e) => e.unit === 'S2' || e.data?.unit === 'S2')).toBe(false)
    expect(events.some((e) => e.unit === 'S3' || e.data?.unit === 'S3')).toBe(false)

    // 2. Aprovação divergente (digest mismatch)
    const fixture2 = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
    })

    // Adultera um contrato após a aprovação
    fixture2.loaded.stories[1].contract.task = 'tarefa adulterada maliciosamente'

    const result2 = await runSequentialMission(fixture2.deps, {
      loaded: fixture2.loaded,
      repoDir: fixture2.repo.dir,
      missionDir: fixture2.missionDir,
    })

    expect(result2.status).toBe('awaiting_operator')
    expect(result2.exitCode).toBe(3)
    expect(result2.reason).toBe('approval_divergent')

    // 3. Aprovação ausente sempre bloqueia o despacho
    const fixture3 = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
      approved: false,
    })

    const result3 = await runSequentialMission(fixture3.deps, {
      loaded: fixture3.loaded,
      repoDir: fixture3.repo.dir,
      missionDir: fixture3.missionDir,
    })

    expect(result3.status).toBe('awaiting_operator')
    expect(result3.exitCode).toBe(3)
    expect(result3.reason).toBe('approval_missing')
  })

  // Critério (6): Dado o cenário rápido trivial em repositório temporário, quando a missão completa é executada com CLIs falsas,
  // então a primeira edição ocorre dentro do limite contratado, não há perguntas e o número total de chamadas respeita o orçamento.
  test('test_criterio_6_cenario_rapido_trivial_com_clis_falsas_respeita_orcamento_e_limites', async () => {
    const fixture = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
      planBudgetCalls: 10,
    })

    let modelCallsCount = 0
    const originalDispatch = fixture.deps.dispatchClaude
    fixture.deps.dispatchClaude = async (opts: any) => {
      modelCallsCount++
      return originalDispatch(opts)
    }

    const result = await runSequentialMission(fixture.deps, {
      loaded: fixture.loaded,
      repoDir: fixture.repo.dir,
      missionDir: fixture.missionDir,
    })

    expect(result.status).toBe('completed')
    expect(result.exitCode).toBe(0)
    // Número total de chamadas respeita o orçamento do plano
    expect(modelCallsCount).toBeLessThanOrEqual(10)
    expect(modelCallsCount).toBe(3) // 1 por story
  })

  test('test_criterio_1_replanejamento_sem_aprovacao_exata_nao_despacha_e_recusa_digest_reconstruido', async () => {
    const fixture = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
      makerOutputs: { S1: 'ok\n', S2: '', S3: 'ok\n' },
    })

    const originalReplan = fixture.deps.replanRemaining
    fixture.deps.replanRemaining = async (opts: any, deps: any) => {
      fs.writeFileSync(
        path.join(fixture.scenarioDir, 'maker.json'),
        JSON.stringify([
          { files: { 'src/s2.txt': 'ok\n' }, result: { format_version: 1, story_id: 'S2', state: 'done', phase: 'green', round: 1, passes: true }, stdout: '{}' },
          { files: { 'src/s3.txt': 'ok\n' }, result: { format_version: 1, story_id: 'S3', state: 'done', phase: 'green', round: 1, passes: true }, stdout: '{}' },
        ]),
        'utf8',
      )
      fs.writeFileSync(path.join(fixture.scenarioDir, 'maker.count'), '0\n', 'utf8')
      fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.count'), '0\n', 'utf8')
      return originalReplan(opts, deps)
    }

    const result = await runSequentialMission(fixture.deps, {
      loaded: fixture.loaded,
      repoDir: fixture.repo.dir,
      missionDir: fixture.missionDir,
    })

    expect(result.status).toBe('awaiting_operator')
    expect(result.exitCode).toBe(3)
    expect(result.reason).toBe('approval_missing')

    const missionsDir = path.join(fixture.repo.dir, '.ade', 'missions')
    const missionDirs = fs.readdirSync(missionsDir).filter((d) => d !== path.basename(fixture.missionDir))
    expect(missionDirs.length).toBeGreaterThan(0)
    const newMissionDir = path.join(missionsDir, missionDirs[0])
    const { events } = readJournal(path.join(newMissionDir, 'journal.jsonl'))
    const approval = events.find((e) => e.kind === 'decision' && e.data?.decision === 'plan_approved')
    expect(approval).toBeUndefined()
    expect(events.some((e) => e.kind === 'story_started' || e.kind === 'budget_reserved')).toBe(false)
    const preserved = events.find((e) => e.kind === 'decision' && e.data?.decision === 'stories_preserved')
    expect(preserved).toBeDefined()
    expect(preserved?.data?.replan_from).toBe(path.basename(fixture.missionDir))

    const newPlanPath = path.join(newMissionDir, 'plan.json')
    const newPlan = JSON.parse(fs.readFileSync(newPlanPath, 'utf8'))
    const approved = await approveMission({
      repoDir: fixture.repo.dir,
      missionId: newPlan.mission_id,
      expectedDigest: digest16(newPlan),
      source: 'operator',
    })
    expect(approved.approved).toBe(true)

    newPlan.briefing.replan_count += 1
    fs.writeFileSync(newPlanPath, JSON.stringify(newPlan, null, 2), 'utf8')
    const replacementJournal = openJournal({ missionDir: newMissionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    openJournals.push(replacementJournal)
    fixture.deps.journal = replacementJournal
    fixture.deps.step = createStepRunner({ journal: replacementJournal, missionDir: newMissionDir }).step
    const divergent = await runSequentialMission(fixture.deps, {
      loaded: loadPlan(newPlanPath),
      repoDir: fixture.repo.dir,
      missionDir: newMissionDir,
    })
    expect(divergent.reason).toBe('approval_divergent')
  })

  test('test_criterio_2_no_changes_preserva_ramos_independentes_sem_recompila_los', async () => {
    // S1 é raiz; S2 e S3 dependem de S1.
    // S1 roda e conclui. S2 roda e produz no_changes.
    // S3 é ramo pendente não afetado (depende de S1 já concluída, não de S2).
    const fixture = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S1'] },
      makerOutputs: { S1: 'ok\n', S2: '', S3: 'ok\n' },
      planBudgetCalls: 4,
    })

    const originalReplan = fixture.deps.replanRemaining
    fixture.deps.replanRemaining = async (opts: any, deps: any) => {
      fs.writeFileSync(
        path.join(fixture.scenarioDir, 'maker.json'),
        JSON.stringify([
          { files: { 'src/s2.txt': 'ok\n' }, result: { format_version: 1, story_id: 'S2', state: 'done', phase: 'green', round: 1, passes: true }, stdout: '{}' },
          { files: { 'src/s3.txt': 'ok\n' }, result: { format_version: 1, story_id: 'S3', state: 'done', phase: 'green', round: 1, passes: true }, stdout: '{}' },
        ]),
        'utf8',
      )
      fs.writeFileSync(path.join(fixture.scenarioDir, 'maker.count'), '0\n', 'utf8')
      fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.count'), '0\n', 'utf8')
      return originalReplan(opts, deps)
    }

    const result = await runSequentialMission(fixture.deps, {
      loaded: fixture.loaded,
      repoDir: fixture.repo.dir,
      missionDir: fixture.missionDir,
    })

    expect(result.status).toBe('awaiting_operator')
    expect(result.exitCode).toBe(3)
    expect(result.reason).toBe('approval_missing')
    expect(result.completedStories).toContain('S1')

    // Afirma que o contrato de S3 mantém o digest original na missão nova
    const missionsDir = path.join(fixture.repo.dir, '.ade', 'missions')
    const missionDirs = fs.readdirSync(missionsDir).filter((d) => d !== path.basename(fixture.missionDir))
    expect(missionDirs.length).toBeGreaterThan(0)
    const newMissionDir = path.join(missionsDir, missionDirs[0])
    const originalS3Digest = digest16(fixture.loaded.stories.find((s) => s.id === 'S3')!.contract)
    const newS3Contract = JSON.parse(fs.readFileSync(path.join(newMissionDir, 'stories', 'S3.json'), 'utf8'))
    expect(digest16(newS3Contract)).toBe(originalS3Digest)

    const newPlanPath = path.join(newMissionDir, 'plan.json')
    const newPlan = JSON.parse(fs.readFileSync(newPlanPath, 'utf8'))
    const approved = await approveMission({
      repoDir: fixture.repo.dir,
      missionId: newPlan.mission_id,
      expectedDigest: digest16(newPlan),
      source: 'operator',
    })
    expect(approved.approved).toBe(true)
    const replacementJournal = openJournal({ missionDir: newMissionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
    openJournals.push(replacementJournal)
    fixture.deps.journal = replacementJournal
    fixture.deps.step = createStepRunner({ journal: replacementJournal, missionDir: newMissionDir }).step

    const resumed = await runSequentialMission(fixture.deps, {
      loaded: loadPlan(newPlanPath),
      repoDir: fixture.repo.dir,
      missionDir: newMissionDir,
    })
    expect(resumed.status).toBe('completed')
    expect(resumed.completedStories).toEqual(expect.arrayContaining(['S1', 'S2', 'S3']))
    const oldCalls = readJournal(path.join(fixture.missionDir, 'journal.jsonl')).events
      .filter((event) => event.kind === 'budget_reserved').length
    const newCalls = readJournal(path.join(newMissionDir, 'journal.jsonl')).events
      .filter((event) => event.kind === 'budget_reserved').length
    expect(oldCalls + newCalls).toBe(4)
  })

  test('no_changes_com_colisao_de_id_preserva_ramo_e_conclui_sem_replan_failed', async () => {
    // Cenário onde o replanejamento produz story cujo id colidiria com o ramo preservado
    const fixture = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S1'] },
      makerOutputs: { S1: 'ok\n', S2: '', S3: 'ok\n' },
    })

    const originalReplan = fixture.deps.replanRemaining
    fixture.deps.replanRemaining = async (opts: any, deps: any) => {
      fs.writeFileSync(
        path.join(fixture.scenarioDir, 'maker.json'),
        JSON.stringify([
          { files: { 'src/s2.txt': 'ok\n' }, result: { format_version: 1, story_id: 'S2', state: 'done', phase: 'green', round: 1, passes: true }, stdout: '{}' },
          { files: { 'src/s3.txt': 'ok\n' }, result: { format_version: 1, story_id: 'S3', state: 'done', phase: 'green', round: 1, passes: true }, stdout: '{}' },
          { files: { 'src/s4.txt': 'ok\n' }, result: { format_version: 1, story_id: 'S4', state: 'done', phase: 'green', round: 1, passes: true }, stdout: '{}' },
        ]),
        'utf8',
      )
      fs.writeFileSync(path.join(fixture.scenarioDir, 'maker.count'), '0\n', 'utf8')
      fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.count'), '0\n', 'utf8')
      const res = await originalReplan(opts, deps)
      // Simula recompilação que colide com S3
      if (res.replannedStories.length > 0) {
        const oldId = res.replannedStories[0].id
        if (oldId !== 'S3') {
          res.replannedStories[0].id = 'S3'
          const newStoriesDir = path.join(fixture.repo.dir, '.ade', 'missions', res.missionId, 'stories')
          const oldFile = path.join(newStoriesDir, `${oldId}.json`)
          const newFile = path.join(newStoriesDir, 'S3.json')
          if (fs.existsSync(oldFile)) {
            const data = JSON.parse(fs.readFileSync(oldFile, 'utf8'))
            data.id = 'S3'
            fs.writeFileSync(newFile, JSON.stringify(data, null, 2), 'utf8')
            fs.rmSync(oldFile, { force: true })
          }
        }
      }
      return res
    }

    const result = await runSequentialMission(fixture.deps, {
      loaded: fixture.loaded,
      repoDir: fixture.repo.dir,
      missionDir: fixture.missionDir,
    })

    expect(result.status).toBe('awaiting_operator')
    expect(result.reason).not.toBe('replan_failed')
  })

  test('test_criterio_3_orcamento_exato_de_n_chamadas_completa_n_stories_sem_rejeicao', async () => {
    // 3 stories lineares com teto do plano exatamente igual a 3 chamadas
    const fixture = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
      planBudgetCalls: 3,
    })

    const result = await runSequentialMission(fixture.deps, {
      loaded: fixture.loaded,
      repoDir: fixture.repo.dir,
      missionDir: fixture.missionDir,
    })

    expect(result.status, JSON.stringify(result)).toBe('completed')
    expect(result.exitCode).toBe(0)
    expect(result.completedStories).toEqual(['S1', 'S2', 'S3'])
  })

  test('journal_corrompido_em_read_events_lanca_erro_ou_sai_com_codigo_2', async () => {
    const fixture = await setupThreeStoryFixture({
      dependencies: { S1: [], S2: ['S1'], S3: ['S2'] },
    })

    const jPath = path.join(fixture.missionDir, 'journal.jsonl')
    fs.appendFileSync(jPath, '{"invalid_json":\n', 'utf8')

    await expect(
      runSequentialMission(fixture.deps, {
        loaded: fixture.loaded,
        repoDir: fixture.repo.dir,
        missionDir: fixture.missionDir,
      }),
    ).rejects.toThrow()
  })
})
