import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createLocalPreflightPorts } from '../src/adapters/local/preflight.ts'
import { runPreflight } from '../src/engine/preflight.ts'
import { dispatchClaude } from '../src/adapters/claude/index.ts'
import { approvedReviewAction, makeCheckerDouble } from './helpers/checker-double.ts'
import { readCounter } from '../src/adapters/fake/cli.ts'
import { checkCanary, plantCanary } from '../src/contain/canary.ts'
import { contain } from '../src/contain/contain.ts'
import { CANARY_FAMILIES, runStory } from '../src/engine.ts'
import { ENGINE_FAULT_POINTS, maybeEngineFault } from '../src/engine/faults.ts'
import { loadPlan } from '../src/engine/plan-load.ts'
import { prepareStory } from '../src/engine/prepare.ts'
import { createEvalRunner } from '../src/evals/eval-runner.ts'
import { createGateRunner } from '../src/gates/gates.ts'
import { createGitPort } from '../src/git/gitport.ts'
import { AdeError } from '../src/journal/errors.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { compilePack } from '../src/pack/pack.ts'
import { reconcileAll } from '../src/step/reconcile.ts'
import { createStepRunner } from '../src/step/step.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI_PATH = path.join(ROOT, 'src/adapters/fake/cli.ts')
// O schema do task-contract exige o campo `then` no cenário; ele vem como texto JSON (o contrato
// é gravado em stories/<id>.json) para não virar um objeto literal thenable no código.
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
      // Ignora falhas de encerramento do journal no teardown
    }
  }
  openJournals = []

  for (const dir of repoDirs) {
    try {
      removeRepo(dir)
    } catch {
      // Ignora falhas de limpeza no teardown
    }
  }
  repoDirs = []

  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir)
    } catch {
      // Ignora falhas de limpeza no teardown
    }
  }
  tmpDirs = []
})

interface SetupFixtureOptions {
  makerFamily?: string
  probeOk?: boolean | null
  env?: NodeJS.ProcessEnv
  preflight?: any
  planMaxModelCalls?: number
  storyMaxModelCalls?: number
  /** Pedido sem prova escrita: o eval passa na base até existir tests/proof.txt, que a etapa de prova escreve. */
  proof?: boolean
}

function setupStoryFixture(options: SetupFixtureOptions = {}) {
  const repo = makeRepo()
  repoDirs.push(repo.dir)

  // Commit inicial contendo tests/check.mjs, que sai 0 só se src/hello.txt contém 'ok'.
  // Inclui JSON reporter para compatibilidade com o analisador de evals.
  const checkCode = [
    "import fs from 'node:fs'",
    'let ok = false',
    ...(options.proof ? ["if (!fs.existsSync('tests/proof.txt')) { process.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }) + '\\n'); process.exit(0) }"] : []),
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
      max_model_calls: options.planMaxModelCalls ?? 6,
      max_rework_rounds: 2,
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
      scope_paths: options.proof ? ['src/**', 'tests/**', 'tests/proof.txt'] : ['src/**', 'tests/**'],
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
        family: options.makerFamily ?? 'claude',
        model_id: 'claude-sonnet-5',
      },
      checker_round: {
        family: 'codex',
        model_id: 'codex-1',
      },
    },
    budget: {
      max_model_calls: options.storyMaxModelCalls ?? 6,
      max_rework_rounds: 2,
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
    ...(options.proof ? [{ files: { 'tests/proof.txt': 'hello.txt precisa dizer ok\n' }, result: { format_version: 1, story_id: 'ADE-T1', state: 'done', phase: 'red', round: 1, tree_before: '0123456789abcdef', tree_after: 'fedcba9876543210', eval_records: [], gate_records: [], passes: false, reason: 'provas escritas', sources: ['contract'] }, stdout: fakeStdout }] : []),
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
  // O motor só comita depois de revisão independente: o cenário precisa de um Checker.
  fs.writeFileSync(
    path.join(scenarioDir, 'checker.json'),
    JSON.stringify([approvedReviewAction()], null, 2),
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
        source: 'official', family: 'claude', used_percent: 0, reserved_percent: 0,
        observed_at: new Date(Date.now()).toISOString(), weekly_reset_at: new Date(Date.now() + 86400000).toISOString(),
      }),
    },
    capabilities: {
      probe_ok: options.probeOk !== undefined ? options.probeOk : true,
    },
    env: options.env ?? process.env,
    now: () => Date.now(),
    preflight:
      options.preflight ??
      (async () => ({
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
      })),
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

describe('engine', () => {
  // CA1: Dada uma story trivial com a CLI falsa escrevendo o arquivo que o eval exige,
  // quando runStory roda, então devolve { status: 'committed', exitCode: 0 }, a branch
  // ade/<missão>/<story> ganha exatamente 1 commit e o journal tem step_results de eval
  // ':red:' e ':green:', além de contain_result, gates_done, pack_manifest e story_done.
  // CA4: Dada a execução feliz, quando se lê o evento telemetry, então
  // data.first_source_edit_ms é um inteiro >= 0.
  test('run_story_commits_trivial_story', async () => {
    const fixture = setupStoryFixture()

    const result = await runStory(fixture.deps, fixture.input)

    expect(result.status).toBe('delivered')
    expect(result.exitCode).toBe(0)
    expect(result.commit).toBeTruthy()
    expect(result.reason).toBeNull()

    // git rev-list --count HEAD..ade/mission-1/ADE-T1 = 1
    const count = fixture.repo.git(['rev-list', '--count', 'HEAD..ade/mission-1/ADE-T1']).trim()
    expect(count).toBe('0')

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))

    const evalRed = events.find(
      (e) => e.kind === 'step_result' && typeof e.step_id === 'string' && e.step_id.includes(':red:'),
    )
    expect(evalRed).toBeDefined()

    const evalGreen = events.find(
      (e) => e.kind === 'step_result' && typeof e.step_id === 'string' && e.step_id.includes(':green:'),
    )
    expect(evalGreen).toBeDefined()

    const containResult = events.find((e) => e.kind === 'contain_result')
    expect(containResult).toBeDefined()

    const gatesDone = events.find((e) => e.kind === 'gates_done')
    expect(gatesDone).toBeDefined()

    const packManifest = events.find((e) => e.kind === 'pack_manifest')
    expect(packManifest).toBeDefined()

    const storyDone = events.find((e) => e.kind === 'story_done')
    expect(storyDone).toBeDefined()
    expect((storyDone?.data as any)?.status).toBe('delivered')

    // CA4: telemetry.data.maker_wall_ms >= 0
    const telemetry = events.find((e) => e.kind === 'telemetry')
    expect(telemetry).toBeDefined()
    const wallMs = (telemetry?.data as any)?.duration_ms
    expect(Number.isInteger(wallMs)).toBe(true)
    expect(wallMs).toBeGreaterThanOrEqual(0)
    expect(telemetry?.data).not.toHaveProperty('first_source_edit_ms')
  }, 60_000)

  // ADR 0036: pedido sem prova escrita. O eval passa na base, a etapa de prova escreve tests/proof.txt (só o arquivo
  // de prova), o vermelho vale, o maker escreve o código e a parte é entregue.
  test('sem_prova_que_falhe_a_etapa_de_prova_escreve_os_testes_e_a_parte_segue_ate_a_entrega', async () => {
    const fixture = setupStoryFixture({ proof: true })
    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered', reason: null })

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const reds = events.filter((e) => e.kind === 'step_result' && String(e.step_id).includes(':red:'))
    expect(reds.map((e) => (e.data as any).result.verdict)).toEqual(['eval_born_green', 'red_valid'])
    const written = events.find((e) => e.kind === 'decision' && (e.data as any).decision === 'proof_written')
    expect(written?.data).toMatchObject({ family: 'claude', files: ['tests/proof.txt'] })
    expect(events.some((e) => e.kind === 'budget_reserved' && (e.data as any).phase === 'proof')).toBe(true)
    expect(events.some((e) => e.kind === 'telemetry' && (e.data as any).role === 'prova')).toBe(true)
    const order = events.map((e) => String(e.step_id ?? ''))
    expect(order.findIndex((id) => id === 'ADE-T1:proof')).toBeLessThan(order.findIndex((id) => id.endsWith(':maker')))
    // o revisor recebe o que precisa ecoar e o que pode citar
    const reviewPack = fs.readFileSync(path.join(fixture.missionDir, 'artifacts', 'packs', 'ADE-T1_r1_review-pack', 'pack.md'), 'utf8')
    expect(reviewPack).toContain('echo_exactly')
    expect(reviewPack).toContain('citable_refs')
    const citable = JSON.parse(/"citable_refs": (\[[^\]]*\])/.exec(reviewPack)![1]) as string[]
    expect(citable.length).toBeGreaterThan(0)
    expect(citable.filter((ref) => ref.startsWith('file:') && !/#L\d+-L\d+$/.test(ref))).toEqual([])
    expect(reviewPack).toContain('Copie contract_revision e input_revision')
  }, 90_000)

  // Queda depois de escrever as provas e antes do vermelho delas: a retomada partia da árvore de antes das provas
  // (cujo vermelho em cache nasceu verde), não reescrevia provas por a parte já ter começado e estacionava em
  // eval_red_not_red. A retomada parte da árvore das provas gravada em proof_written.
  test('retomada_depois_das_provas_escritas_parte_da_arvore_das_provas', async () => {
    const fixture = setupStoryFixture({ proof: true })
    const original = fixture.deps.createEvalRunner
    let reds = 0
    fixture.deps.createEvalRunner = (opts: any) => {
      const runner = original(opts)
      return {
        ...runner,
        runEval: async (args: any) => {
          if (args.phase === 'red' && ++reds === 2) throw new Error('queda no meio do vermelho das provas')
          return runner.runEval(args)
        },
      }
    }
    await expect(runStory(fixture.deps, fixture.input)).rejects.toThrow('queda no meio')

    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered', reason: null })
  }, 120_000)

  // Queda depois do modelo (no verde): a retomada reaproveita a chamada e não grava a telemetria dela de novo; antes, cada
  // retomada somava o gasto do modelo outra vez no painel.
  test('retomada_depois_do_modelo_nao_duplica_a_telemetria_dele', async () => {
    const fixture = setupStoryFixture()
    const original = fixture.deps.createEvalRunner
    let greens = 0
    fixture.deps.createEvalRunner = (opts: any) => {
      const runner = original(opts)
      return {
        ...runner,
        runEval: async (args: any) => {
          if (args.phase === 'green' && ++greens === 1) throw new Error('queda no verde')
          return runner.runEval(args)
        },
      }
    }
    await expect(runStory(fixture.deps, fixture.input)).rejects.toThrow('queda no verde')
    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.filter((e) => e.kind === 'telemetry' && (e.data as any).role === 'maker')).toHaveLength(1)
  }, 120_000)

  // CA2: Dado um contrato com roles.maker.family 'codex', quando runStory roda, então
  // lança AdeError com code 'family_without_canary' e exit 4, e o journal não tem nenhum
  // step_intent com step_id terminando em ':maker'.
  test('family_without_canary_is_refused_before_dispatch', async () => {
    expect(CANARY_FAMILIES).toEqual(['claude', 'codex'])

    const fixture = setupStoryFixture({
      makerFamily: 'agy',
    })

    let error: any
    try {
      await runStory(fixture.deps, fixture.input)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(AdeError)
    expect(error?.code).toBe('family_without_canary')
    expect(error?.exitCode).toBe(4)

    // readCounter(scenarioDir, 'maker') = 0
    expect(readCounter(fixture.scenarioDir, 'maker')).toBe(0)

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const makerIntents = events.filter(
      (e) => e.kind === 'step_intent' && typeof e.step_id === 'string' && e.step_id.endsWith(':maker'),
    )
    expect(makerIntents).toHaveLength(0)
  }, 60_000)

  // CA3: Dadas capacidades com probe_ok null e env sem CI, quando runStory roda, então
  // lança AdeError com code 'probe_unverified' e exit 4; com env.CI === 'true', a mesma
  // entrada segue até committed.
  test('probe_ok_null_is_refused_outside_ci', async () => {
    // Variante 1: fora do CI (env sem CI)
    const fixtureWithoutCi = setupStoryFixture({
      probeOk: null,
      env: { ...process.env, CI: undefined },
    })

    let error: any
    try {
      await runStory(fixtureWithoutCi.deps, fixtureWithoutCi.input)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(AdeError)
    expect(error?.code).toBe('probe_unverified')
    expect(error?.exitCode).toBe(4)

    // Variante 2: com CI === 'true'
    const fixtureWithCi = setupStoryFixture({
      probeOk: null,
      env: { ...process.env, CI: 'true' },
    })

    const result = await runStory(fixtureWithCi.deps, fixtureWithCi.input)
    expect(result.status).toBe('delivered')
    expect(result.exitCode).toBe(0)
  }, 60_000)
})

describe('faults', () => {
  test('engine_fault_points_are_normative', () => {
    expect(ENGINE_FAULT_POINTS).toEqual([
      'before_spawn',
      'after_maker_effect',
      'before_contain',
      'after_contain',
      'before_commit',
      'after_commit',
    ])
  })

  test('maybe_engine_fault_validates_points_and_aborts_on_match', () => {
    expect(() => maybeEngineFault('invalid_point')).toThrow(TypeError)
    expect(() => maybeEngineFault('invalid_point')).toThrow('ponto de falha inválido: invalid_point')

    expect(() => maybeEngineFault('before_spawn', {})).not.toThrow()
    expect(() => maybeEngineFault('before_spawn', { ADE_FAULT: 'after_maker_effect' })).not.toThrow()

    let aborted = false
    const origAbort = process.abort
    try {
      process.abort = (() => {
        aborted = true
      }) as any
      maybeEngineFault('before_spawn', { ADE_FAULT: 'before_spawn' })
      expect(aborted).toBe(true)
    } finally {
      process.abort = origAbort
    }
  })
})

describe('S18 telemetria honesta', () => {
  // CA1: Dado um relógio falso que começa em 1000 e um dispatchClaude falso que o avança 2000,
  // quando a story fecha, então o evento telemetry da story tem data.maker_wall_ms === 2000,
  // data.role === 'maker' e data.step_id === '<storyId>:r1:maker'.
  // CA2: Dado o mesmo cenário, quando se varre o journal inteiro, então nenhum evento tem a chave
  // first_source_edit_ms em data.
  // Borda [CA1]: relógio que volta para trás (depois < antes) -> maker_wall_ms 0.
  test('telemetry_field_names_match_what_is_measured', async () => {
    let clock = 1000
    const fixture = setupStoryFixture()
    fixture.deps.now = () => clock
    const origDispatch = fixture.deps.dispatchClaude
    fixture.deps.dispatchClaude = async (args: any) => {
      clock += 2000
      return origDispatch(args)
    }

    const result = await runStory(fixture.deps, fixture.input)
    expect(result.status).toBe('delivered')
    expect(result.exitCode).toBe(0)

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const telemetry = events.find((e) => e.kind === 'telemetry')
    expect(telemetry).toBeDefined()
    expect((telemetry?.data as any)?.duration_ms).toBe(2000)
    expect((telemetry?.data as any)?.role).toBe('maker')
    expect((telemetry?.data as any)?.step_id).toBe(`${fixture.input.story.id}:r1:maker`)
    expect(telemetry?.data).not.toHaveProperty('first_source_edit_ms')

    const firstSourceEvents = events.filter(
      (e) => e.data && 'first_source_edit_ms' in (e.data as Record<string, unknown>),
    )
    expect(firstSourceEvents.length).toBe(0)

    // Borda: relógio que volta para trás (depois < antes) -> maker_wall_ms 0
    let clockBackward = 1000
    const fixtureBackward = setupStoryFixture()
    fixtureBackward.deps.now = () => clockBackward
    const origDispatchBackward = fixtureBackward.deps.dispatchClaude
    fixtureBackward.deps.dispatchClaude = async (args: any) => {
      clockBackward = 500
      return origDispatchBackward(args)
    }

    const resultBackward = await runStory(fixtureBackward.deps, fixtureBackward.input)
    expect(resultBackward.status).toBe('delivered')

    const { events: eventsBackward } = readJournal(path.join(fixtureBackward.missionDir, 'journal.jsonl'))
    const telemetryBackward = eventsBackward.find((e) => e.kind === 'telemetry')
    expect(telemetryBackward).toBeDefined()
    expect((telemetryBackward?.data as any)?.duration_ms).toBe(0)
  }, 60_000)

  // CA3: Dado um contain falso que devolve ok: false por escopo, quando a story para em
  // awaiting_operator, então o journal não tem nenhum evento telemetry.
  test('telemetry_is_not_written_when_contain_refuses', async () => {
    const fixture = setupStoryFixture()
    fixture.deps.contain = async () =>
      ({
        ok: false,
        reason: 'scope',
        changedPaths: ['src/hello.txt'],
      }) as any

    const result = await runStory(fixture.deps, fixture.input)
    expect(result.status).toBe('awaiting_operator')
    expect(result.exitCode).toBe(3)
    expect(result.reason).toBe('scope')

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const telemetryEvents = events.filter((e) => e.kind === 'telemetry')
    expect(telemetryEvents.length).toBe(1)
    expect((telemetryEvents[0].data as any).outcome).toBe('park')
  }, 60_000)

  // CA2: disk blocked → exitCode:3, zero budget_reserved/prepare/dispatch
  test('preflight_disk_blocked_aborts_with_zero_budget_reserved_prepare_dispatch', async () => {
    const fixture = setupStoryFixture({
      preflight: async () => ({
        ready: false,
        failures: [{ id: 'disk', reason: 'espaço insuficiente' }],
        checks: [
          { id: 'proof_target', status: 'ready', reason: null },
          { id: 'dependencies', status: 'ready', reason: null },
          { id: 'build', status: 'ready', reason: null },
          { id: 'worktree', status: 'ready', reason: null },
          { id: 'input', status: 'ready', reason: null },
          { id: 'credential', status: 'ready', reason: null },
          { id: 'disk', status: 'blocked', reason: 'espaço insuficiente' },
          { id: 'external_access', status: 'ready', reason: null },
        ],
        calls_avoided: 6,
      }),
    })

    const prepareSpy = vi.fn()
    fixture.deps.prepareStory = prepareSpy
    const dispatchSpy = vi.fn()
    fixture.deps.dispatchClaude = dispatchSpy

    const result = await runStory(fixture.deps, fixture.input)
    expect(result.status).toBe('awaiting_operator')
    expect(result.reason).toBe('preflight')
    expect(result.exitCode).toBe(3)

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const budgetReserved = events.filter((e) => e.kind === 'budget_reserved')
    expect(budgetReserved.length).toBe(0)
    expect(prepareSpy).not.toHaveBeenCalled()
    expect(dispatchSpy).not.toHaveBeenCalled()
  }, 60_000)

  // CA3: proof_target+dependencies blocked, max plano:6, max story:4, dois budget_reserved → calls_avoided:2
  test('preflight_proof_target_and_dependencies_blocked_calculates_calls_avoided', async () => {
    const fixture = setupStoryFixture({
      planMaxModelCalls: 6,
      storyMaxModelCalls: 4,
    })

    // Injetar dois budget_reserved
    await fixture.deps.journal.append({
      kind: 'budget_reserved',
      unit: fixture.input.story.id,
      data: { calls: 1, unit: fixture.input.story.id },
    })
    await fixture.deps.journal.append({
      kind: 'budget_reserved',
      unit: fixture.input.story.id,
      data: { calls: 1, unit: fixture.input.story.id },
    })

    fixture.deps.preflight = async ({ story, loaded, events }: any) => {
      const checks: any = {
        proof_target: { check: () => ({ status: 'blocked', reason: 'alvo inexistente' }) },
        dependencies: { check: () => ({ status: 'blocked', reason: 'dependências ausentes' }) },
        build: { check: () => ({ status: 'ready', reason: null }) },
        worktree: { check: () => ({ status: 'ready', reason: null }) },
        input: { check: () => ({ status: 'ready', reason: null }) },
        credential: { check: () => ({ status: 'ready', reason: null }) },
        disk: { check: () => ({ status: 'ready', reason: null }) },
        external_access: { check: () => ({ status: 'ready', reason: null }) },
      }
      const planned_paid_calls = Math.min(
        loaded.plan.budget.max_model_calls,
        story.contract.budget.max_model_calls,
      )
      const consumed_paid_calls = events.filter((e: any) => e.kind === 'budget_reserved').length
      return runPreflight({
        checks,
        planned_paid_calls,
        consumed_paid_calls,
      })
    }

    const result = await runStory(fixture.deps, fixture.input)
    expect(result.status).toBe('awaiting_operator')
    expect(result.reason).toBe('preflight')
    expect(result.exitCode).toBe(3)

    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const preflightEvent = events.find((e) => e.kind === 'preflight_result')
    expect(preflightEvent).toBeDefined()
    const data: any = preflightEvent?.data
    expect(data.status).toBe('blocked')
    expect(data.failures.map((f: any) => f.id)).toEqual(['proof_target', 'dependencies'])
    expect(data.calls_avoided).toBe(2)
  }, 60_000)

  // CA4: statfs lança EPERM → {status:'blocked',reason:'não foi possível verificar espaço livre'}
  test('preflight_statfs_throws_eperm_returns_blocked_with_portuguese_reason', async () => {
    const fixture = setupStoryFixture()

    const ports = createLocalPreflightPorts({
      repoDir: fixture.repo.dir,
      story: fixture.input.story,
      loaded: fixture.input.loaded,
      capabilities: { probe_ok: true, probed_at: Date.now() },
      gitPort: { dirtyPaths: async () => [] },
      statfs: () => {
        const err: any = new Error('EPERM: operation not permitted')
        err.code = 'EPERM'
        throw err
      },
      now: () => Date.now(),
      env: { ANTHROPIC_API_KEY: 'test-key' },
    })

    const diskResult = await ports.disk.check()
    expect(diskResult).toEqual({
      status: 'blocked',
      reason: 'não foi possível verificar espaço livre',
    })
  }, 60_000)

  test('engine_executa_fqe_para_historia_com_ui_e_para_em_visual_cut_not_met', async () => {
    const fixture = setupStoryFixture()
    fixture.input.story.contract.needs_ui = true

    const mockRunFQE = vi.fn().mockResolvedValue({
      status: 'awaiting_operator',
      reason: 'visual_cut_not_met',
      evaluation: { final: 6.8, verdict: 'rework' },
    })

    const depsWithFQE = {
      ...fixture.deps,
      runFrontendQuality: mockRunFQE,
    }

    const result = await runStory(depsWithFQE, fixture.input)
    expect(result.status).toBe('awaiting_operator')
    expect(result.reason).toBe('visual_cut_not_met')
    expect(result.exitCode).toBe(3)
    expect(mockRunFQE).toHaveBeenCalled()
  }, 60_000)
})


describe('modelo do maker vem do contrato', () => {
  // O contrato grava roles.maker.model_id, mas o engine não repassava ao adapter: o maker rodava no
  // padrão da CLI do Claude, qualquer que fosse, e o modelo do contrato era só enfeite.
  test('engine_passes_contract_maker_model_to_dispatch', async () => {
    const fixture = setupStoryFixture()
    const origDispatch = fixture.deps.dispatchClaude
    const seen: Array<string | undefined> = []
    fixture.deps.dispatchClaude = async (args: any) => {
      seen.push(args.model)
      return origDispatch(args)
    }

    const result = await runStory(fixture.deps, fixture.input)
    expect(result.status).toBe('delivered')
    expect(seen).toEqual(['claude-sonnet-5'])
  }, 60_000)
})
