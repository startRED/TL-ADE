import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { dispatchClaude } from '../src/adapters/claude/index.ts'
import { checkCanary, plantCanary } from '../src/contain/canary.ts'
import { contain } from '../src/contain/contain.ts'
import { runStory } from '../src/engine.ts'
import { loadPlan } from '../src/engine/plan-load.ts'
import { prepareStory } from '../src/engine/prepare.ts'
import { createEvalRunner } from '../src/evals/eval-runner.ts'
import { createGateRunner } from '../src/gates/gates.ts'
import { createGitPort } from '../src/git/gitport.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { compilePack } from '../src/pack/pack.ts'
import { reconcileAll } from '../src/step/reconcile.ts'
import { createStepRunner } from '../src/step/step.ts'
import { approvedReviewAction, makeCheckerDouble, TRUE_DIGEST, TRUE_TREE } from './helpers/checker-double.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI_PATH = path.join(ROOT, 'src/adapters/fake/cli.ts')
const SCENARIO_C1_JSON =
  '{"id":"C1","given":"initial state without hello.txt","when":"maker creates hello.txt with ok",' +
  '"then":"eval check passes","verifiers":["E1"],"evals":["E1"]}'

let repoDirs: string[] = []
let tmpDirs: string[] = []
let openJournals: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const j of openJournals) {
    try {
      await j.close()
    } catch {
      // Ignora falhas no teardown
    }
  }
  openJournals = []

  for (const dir of repoDirs) {
    try {
      removeRepo(dir)
    } catch {
      // Ignora falhas no teardown
    }
  }
  repoDirs = []

  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir)
    } catch {
      // Ignora falhas no teardown
    }
  }
  tmpDirs = []
})

function changesRequestedReviewAction(): { result: Record<string, unknown>; stdout: string } {
  return {
    result: {
      format_version: 2,
      contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      input_revision: { tree: TRUE_TREE, digest: TRUE_DIGEST },
      verdict: 'changes_requested',
      action_items: [
        {
          code: 'defect_found',
          severity: 'blocking',
          problem: 'reprovação do checker para teste de não entrega',
          evidence_refs: ['file:src/hello.txt'],
        },
      ],
      deferred: [],
      rejected: [],
      evidence: [],
      requested_action: 'rework',
      sources: ['file:src/hello.txt'],
      summary: 'changes requested by independent review',
      handoff: {
        claims: [],
        unknowns: [],
        questions_for_owner: [],
        deltas: [],
        next_action: 'rework',
        notes: 'changes requested',
      },
    },
    stdout: JSON.stringify({ total_cost_usd: 0.01 }),
  }
}

interface SetupFixtureOptions {
  checkerAction?: any
}

function setupStoryFixture(options: SetupFixtureOptions = {}) {
  const repo = makeRepo()
  repoDirs.push(repo.dir)

  const checkCode = [
    "import fs from 'node:fs'",
    'let ok = false',
    'try {',
    "  const content = fs.readFileSync('src/hello.txt', 'utf8')",
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

  fs.mkdirSync(path.join(repo.dir, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(repo.dir, 'tests/check.mjs'), checkCode, 'utf8')
  repo.git(['add', '-A'])
  repo.git(['commit', '-m', 'commit inicial'])

  const planDir = makeTmpDir('ade-engine-plan-')
  tmpDirs.push(planDir)

  const planObj = {
    format_version: 2,
    id: 'plan-1',
    mission_id: 'mission-1',
    immutable_digest: '0123456789abcdef',
    authorization: {
      autonomy: 'safe',
      permitted_effects: [],
      eligible_skills: [],
    },
    phases: [
      {
        epics: [
          {
            stories: ['ADE-T1'],
          },
        ],
      },
    ],
    mission_budget: {
      max_usd: 10,
      max_wall_clock_seconds: 28800,
      max_parked_units: 3,
    },
    budget: {
      max_model_calls: 6,
      max_rework_rounds: 1,
    },
  }
  fs.writeFileSync(path.join(planDir, 'plan.json'), JSON.stringify(planObj, null, 2), 'utf8')

  const storiesDir = path.join(planDir, 'stories')
  fs.mkdirSync(storiesDir, { recursive: true })

  const contractObj = {
    format_version: 2,
    id: 'ADE-T1',
    title: 'Trivial Story',
    complexity: 'bounded',
    task: 'Create src/hello.txt with ok',
    workspace: {
      kind: 'git',
      root: '.',
    },
    risk: {
      level: 'normal',
      surfaces: [],
      evidence: [],
    },
    guardrails: {
      scope_paths: ['src/**', 'tests/**'],
      do_not_touch: ['.ade/**'],
      autonomy: 'safe',
    },
    requirements: [
      {
        id: 'R1',
        ears: 'WHEN check runs THE SYSTEM SHALL pass.',
      },
    ],
    scenarios: [JSON.parse(SCENARIO_C1_JSON)],
    verifiers: [
      {
        id: 'E1',
        kind: 'script',
        cmd: ['node', 'tests/check.mjs'],
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 65536,
        evidence: ['tests/check.mjs'],
        strictness: {
          mode: 'must_fail_before',
        },
        author: 'operator',
      },
    ],
    evals: [
      {
        id: 'E1',
        kind: 'script',
        cmd: ['node', 'tests/check.mjs'],
        expect_exit: 0,
        timeout_s: 120,
        max_output_bytes: 65536,
        evidence: ['tests/check.mjs'],
        strictness: {
          mode: 'must_fail_before',
        },
        author: 'operator',
      },
    ],
    skills: [],
    roles: {
      maker: {
        family: 'claude',
        model_id: 'claude-sonnet-5',
      },
      checker_round: {
        family: 'codex',
        model_id: 'codex-1',
      },
    },
    budget: {
      max_model_calls: 6,
      max_rework_rounds: 1,
    },
  }
  fs.writeFileSync(
    path.join(storiesDir, 'ADE-T1.json'),
    JSON.stringify(contractObj, null, 2),
    'utf8',
  )

  const loaded = loadPlan(path.join(planDir, 'plan.json'))
  const story = loaded.stories[0]

  const scenarioDir = makeTmpDir('ade-engine-fake-')
  tmpDirs.push(scenarioDir)

  const fakeStdout = JSON.stringify({
    total_cost_usd: 0.01,
    structured_output: {
      format_version: 1,
      story_id: 'ADE-T1',
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
  })

  const makerActions = [
    {
      files: {
        'src/hello.txt': 'ok\n',
      },
      result: {
        format_version: 1,
        story_id: 'ADE-T1',
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
      stdout: fakeStdout,
    },
  ]
  fs.writeFileSync(
    path.join(scenarioDir, 'maker.json'),
    JSON.stringify(makerActions, null, 2),
    'utf8',
  )

  const checkerAction = options.checkerAction ?? approvedReviewAction()
  fs.writeFileSync(
    path.join(scenarioDir, 'checker.json'),
    JSON.stringify([checkerAction], null, 2),
    'utf8',
  )

  const missionDir = path.join(repo.dir, '.ade', 'missions', loaded.plan.mission_id)
  fs.mkdirSync(missionDir, { recursive: true })

  const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  openJournals.push(journal)

  const { step } = createStepRunner({ journal, missionDir })

  const deps = {
    journal,
    step,
    gitPortFor: (dir: string) => createGitPort({ worktreeDir: dir }),
    prepareStory,
    createEvalRunner,
    createGateRunner,
    compilePack,
    contain,
    plantCanary,
    checkCanary,
    dispatchClaude,
    dispatchCodex: makeCheckerDouble({
      scenarioDir,
      contractRevision: (story as any).contract_revision,
    }),
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
        observed_at: new Date(Date.now()).toISOString(),
        weekly_reset_at: new Date(Date.now() + 86400000).toISOString(),
      }),
    },
    capabilities: {
      probe_ok: true,
    },
    env: process.env,
    now: () => Date.now(),
    preflight: async () => ({
      ready: true,
      failures: [],
      checks: [
        { id: 'proof_target', status: 'ready', reason: null },
        { id: 'dependencies', status: 'ready', reason: null },
        { id: 'build', status: 'ready', reason: null },
        { id: 'worktree', status: 'ready', reason: null },
        { id: 'input', status: 'ready', reason: null },
        { id: 'credential', status: 'ready', reason: null },
        { id: 'disk', status: 'ready', reason: null },
        { id: 'external_access', status: 'ready', reason: null },
      ],
      calls_avoided: 0,
    }),
  }

  const input = {
    loaded,
    story,
    repoDir: repo.dir,
    missionDir,
  }

  return {
    repo,
    missionDir,
    scenarioDir,
    deps,
    input,
  }
}

describe('engine delivery', () => {
  // CA1: caminho falso completo implementação → provas → revisão → entrega
  test('caminho_falso_completo_implementacao_provas_revisao_entrega', async () => {
    const fixture = setupStoryFixture()

    const result = await runStory(fixture.deps, fixture.input)

    expect(result.status).toBe('delivered')
    expect(result.exitCode).toBe(0)
    expect(result.commit).toBeTruthy()
    expect((result as any).delivered).toBe(true)

    // Base branch (HEAD do repositório) foi atualizada para o commit entregue
    expect(fixture.repo.git(['rev-parse', 'HEAD']).trim()).toBe(result.commit)

    // Commit da parte traz a medida como trailers Git.
    const trailers = fixture.repo.git(['log', '-1', '--format=%(trailers:only,unfold)']).trim().split('\n')
    expect(trailers.slice(0, 3)).toEqual(['ADE-Criterios: 1', 'ADE-Arquivos: 1', 'ADE-Rodadas: 1'])
    expect(trailers[3]).toMatch(/^ADE-USD: \d+\.\d{2}$/)

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const deliveryStep = events.find(
      (e) => e.kind === 'step_result' && e.effect_class === 'local_merge',
    )
    expect(deliveryStep).toBeDefined()
    expect(deliveryStep?.status).toBe('ok')

    const storyDone = events.find((e) => e.kind === 'story_done')
    expect(storyDone).toBeDefined()
    expect((storyDone?.data as any)?.status).toBe('delivered')
    expect((storyDone?.data as any)?.delivered).toBe(true)
  }, 60_000)

  // CA2: local_merge ff-only quando a base não mudou
  test('local_merge_ff_only_quando_a_base_nao_mudou', async () => {
    const fixture = setupStoryFixture()
    const baseCommit = fixture.repo.git(['rev-parse', 'main']).trim()

    const result = await runStory(fixture.deps, fixture.input)

    expect(result.status).toBe('delivered')
    expect(fixture.repo.git(['rev-parse', 'main']).trim()).toBe(result.commit)

    // Fast-forward only: histórico linear, exatamente 1 commit novo na base
    expect(fixture.repo.git(['rev-list', '--count', `${baseCommit}..main`]).trim()).toBe('1')

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const deliveryStep = events.find(
      (e) => e.kind === 'step_result' && e.effect_class === 'local_merge',
    )
    expect(deliveryStep).toBeDefined()
    expect(deliveryStep?.status).toBe('ok')
    expect(deliveryStep?.data?.reason).toBe('fast_forward_merged')
  }, 60_000)

  // CA3 (24/09, missão real): a base andou durante a parte (outro commit no main) e a entrega parava em base_diverged
  // esperando o operador. Sem conflito, o commit revisado é rebaseado sobre a base nova na worktree da parte e entregue.
  test('base_alterada_sem_conflito_rebaseia_e_entrega', async () => {
    const fixture = setupStoryFixture()
    const originalPrepare = fixture.deps.prepareStory
    fixture.deps.prepareStory = async (opts: any) => {
      const prep = await originalPrepare(opts)
      fs.writeFileSync(path.join(fixture.repo.dir, 'outro.txt'), 'commit concorrente\n')
      fixture.repo.git(['add', 'outro.txt'])
      fixture.repo.git(['commit', '-m', 'commit concorrente na base'])
      return prep
    }

    const result = await runStory(fixture.deps, fixture.input)

    expect(result.status).toBe('delivered')
    expect(fixture.repo.git(['log', '-1', '--format=%s', 'main~1']).trim()).toBe('commit concorrente na base')
    expect(fs.existsSync(path.join(fixture.repo.dir, 'outro.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(fixture.repo.dir, 'src', 'hello.txt'), 'utf8')).toContain('ok')
  }, 60_000)

  // Base que mexeu no mesmo arquivo da parte: o rebase conflita, é abortado, e a parte para com o commit preservado.
  test('base_alterada_com_conflito_preserva_branch_e_explica_intervencao', async () => {
    const fixture = setupStoryFixture()
    const originalPrepare = fixture.deps.prepareStory
    fixture.deps.prepareStory = async (opts: any) => {
      const prep = await originalPrepare(opts)
      fs.mkdirSync(path.join(fixture.repo.dir, 'src'), { recursive: true })
      fs.writeFileSync(path.join(fixture.repo.dir, 'src', 'hello.txt'), 'da base\n')
      fixture.repo.git(['add', 'src/hello.txt'])
      fixture.repo.git(['commit', '-m', 'commit concorrente no mesmo arquivo'])
      return prep
    }
    const baseAfterConcurrent = () => fixture.repo.git(['rev-parse', 'main']).trim()

    const result = await runStory(fixture.deps, fixture.input)

    expect(result.status).toBe('awaiting_operator')
    expect(result.reason).toBe('base_diverged')
    const missionId = fixture.input.loaded.plan.mission_id
    const storyBranchCommit = fixture.repo.git(['rev-parse', `ade/${missionId}/ADE-T1`]).trim()
    expect(baseAfterConcurrent()).not.toBe(storyBranchCommit)
    expect(fixture.repo.git(['log', '-1', '--format=%s', 'main']).trim()).toBe('commit concorrente no mesmo arquivo')
    const wt = path.join(fixture.repo.dir, '.ade', 'wt', 'ADE-T1')
    expect(fs.existsSync(path.join(wt, '.git')) && fixture.repo.git(['-C', wt, 'status', '--porcelain']).trim()).toBe('')
  }, 60_000)

  // Base com edição pendente do operador (guarda por worktree, §17): arquivo alheio à parte não impede a
  // entrega e continua intacto; arquivo que a parte também escreve faz o git recusar o fast-forward, e a
  // entrega fica parada com o commit preservado em vez de lançar ou sobrescrever a edição.
  test('base_suja_entrega_sem_tocar_edicao_do_operador', async () => {
    const fixture = setupStoryFixture()
    fs.writeFileSync(path.join(fixture.repo.dir, 'operador.txt'), 'rascunho\n')

    const result = await runStory(fixture.deps, fixture.input)

    expect(result.status).toBe('delivered')
    expect(fs.readFileSync(path.join(fixture.repo.dir, 'operador.txt'), 'utf8')).toBe('rascunho\n')
  }, 60_000)

  test('base_suja_no_mesmo_arquivo_nao_sobrescreve_e_nao_lanca', async () => {
    const fixture = setupStoryFixture()
    fs.mkdirSync(path.join(fixture.repo.dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(fixture.repo.dir, 'src', 'hello.txt'), 'do operador\n')

    const result = await runStory(fixture.deps, fixture.input)

    expect(result.status).toBe('awaiting_operator')
    expect(result.reason).toBe('base_local_changes')
    expect(result.commit).toBeTruthy()
    expect(fs.readFileSync(path.join(fixture.repo.dir, 'src', 'hello.txt'), 'utf8')).toBe('do operador\n')
  }, 60_000)

  // CA4: interrupção após efeito reconcilia antes de repetir
  test('interrupcao_apos_efeito_reconcilia_antes_de_repetir', async () => {
    const fixture = setupStoryFixture()
    const baseCommit = fixture.repo.git(['rev-parse', 'main']).trim()

    // Simula commit revisado existente e já aplicado em main antes da queda
    const reviewedCommit = fixture.repo.git([
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      baseCommit,
      '-m',
      'commit revisado',
    ]).trim()
    fixture.repo.git(['update-ref', 'refs/heads/main', reviewedCommit])

    // Intenção de local_merge aberta no journal antes do crash
    await fixture.deps.journal.append({
      kind: 'step_intent',
      step_id: 'ADE-T1:deliver',
      effect_class: 'local_merge',
      input_digest: '0000000000000000',
      intent_context: {
        base_before: baseCommit,
        head_after: reviewedCommit,
        branch_after: 'main',
      },
    })

    const basePort = fixture.deps.gitPortFor(fixture.repo.dir)
    const ffSpy = vi.spyOn(basePort, 'fastForward')

    const result = await runStory(fixture.deps, fixture.input)

    expect(result.status).toBe('delivered')
    expect((result as any).delivered).toBe(true)
    expect(ffSpy).not.toHaveBeenCalled()

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const deliveryResult = events.find(
      (e) => e.kind === 'step_result' && e.step_id === 'ADE-T1:deliver',
    )
    expect(deliveryResult).toBeDefined()
    expect(deliveryResult?.status).toBe('ok')
    expect((deliveryResult as any)?.reconciled).toBe(true)
  }, 60_000)

  // CA5: reprovação nunca entrega
  test('reprovacao_nunca_entrega', async () => {
    const fixture = setupStoryFixture({
      checkerAction: changesRequestedReviewAction(),
    })
    const baseCommit = fixture.repo.git(['rev-parse', 'main']).trim()

    const result = await runStory(fixture.deps, fixture.input)

    expect(result.status).toBe('awaiting_operator')
    expect((result as any).delivered).toBe(false)
    expect(fixture.repo.git(['rev-parse', 'main']).trim()).toBe(baseCommit)

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const deliveryEvents = events.filter(
      (e) => e.effect_class === 'local_merge' || e.effect_class === 'push',
    )
    expect(deliveryEvents).toHaveLength(0)

    const storyDone = events.find((e) => e.kind === 'story_done')
    expect(storyDone).toBeDefined()
    expect((storyDone?.data as any)?.delivered).toBe(false)
  }, 60_000)

  // CA6: remoto local e adapters falsos, sem publicação pública e sem executar git push
  test('remoto_local_e_adapters_falsos_sem_publicacao_publica_e_sem_git_push', async () => {
    const fixture = setupStoryFixture()
    const bareDir = makeTmpDir('ade-bare-remote-')
    tmpDirs.push(bareDir)
    execFileSync('git', ['init', '--bare', bareDir], { encoding: 'utf8' })

    // Adiciona o bare local como remote origin
    fixture.repo.git(['remote', 'add', 'origin', bareDir])

    const result = await runStory(fixture.deps, fixture.input)

    expect(result.status).toBe('delivered')
    expect((result as any).delivered).toBe(true)

    // Sem publicação remota nem git push proibido no bare
    const bareBranches = execFileSync('git', ['--git-dir', bareDir, 'branch', '--list'], {
      encoding: 'utf8',
    }).trim()
    expect(bareBranches).toBe('')

    // Entrega foi concluída localmente via local_merge
    expect(fixture.repo.git(['rev-parse', 'main']).trim()).toBe(result.commit)
  }, 60_000)
})

// Entrega anterior que parou sem mexer na base (base_diverged) era reaproveitada para sempre: a parte ficava parada mesmo
// depois de o rebase ou o operador resolverem a divergência. Ela é refeita.
describe('nova tentativa de entrega', () => {
  test('entrega_anterior_sem_efeito_e_refeita', async () => {
    const { deliverStory } = await import('../src/engine/deliver.ts')
    const appended: any[] = []
    const events = [
      { kind: 'step_intent', step_id: 'S1:deliver', effect_class: 'local_merge' },
      { kind: 'step_result', step_id: 'S1:deliver', effect_class: 'local_merge', status: 'ambiguous', data: { reason: 'base_diverged', result: null } },
    ]
    const gitPort: any = {
      headInfo: async () => ({ commit: 'b'.repeat(40), branch: 'main' }),
      readLocalRef: async (ref: string) => (ref === 'MERGE_HEAD' ? null : 'b'.repeat(40)),
      fastForward: async () => ({ commit: 'c'.repeat(40) }),
    }
    const out = await deliverStory({
      journal: { append: async (e: any) => (appended.push(e), e) },
      events,
      gitPort,
      storyId: 'S1',
      baseRef: 'main',
      baseBefore: 'b'.repeat(40),
      reviewedCommit: 'c'.repeat(40),
    })
    expect(out).toMatchObject({ delivered: true, commit: 'c'.repeat(40) })
  })
})
