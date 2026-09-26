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
  /** A prova é a suíte inteira do projeto (script test do package.json), e ela já falha na base. */
  wholeSuite?: boolean
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
  if (options.wholeSuite) fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ scripts: { test: 'node tests/check.mjs' } }))
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
      scope_paths: options.wholeSuite ? ['src/**', 'tests/**', 'tests/proof.txt', 'package.json'] : options.proof ? ['src/**', 'tests/**', 'tests/proof.txt'] : ['src/**', 'tests/**'],
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
        evidence: options.wholeSuite ? ['package.json'] : ['tests/check.mjs'],
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
        evidence: options.wholeSuite ? ['package.json'] : ['tests/check.mjs'],
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
    ...(options.proof || options.wholeSuite ? [{ files: { 'tests/proof.txt': 'hello.txt precisa dizer ok\n' }, result: { format_version: 1, story_id: 'ADE-T1', state: 'done', phase: 'red', round: 1, tree_before: '0123456789abcdef', tree_after: 'fedcba9876543210', eval_records: [], gate_records: [], passes: false, reason: 'provas escritas', sources: ['contract'] }, stdout: fakeStdout }] : []),
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
    // 24/09: o revisor (Codex na sandbox dele) tentou rodar a suíte, bateu em EPERM e reprovou por "V1 sem verde"; o
    // resultado oficial das provas do motor vai no pacote e a política diz que ele vale.
    expect(reviewPack).toContain('"proof_results"')
    expect(reviewPack).toMatch(/"verdict": "green"/)
    expect(reviewPack).toContain('proof_results é o resultado oficial')
    // não há operador: requisito impossível dentro do escopo vai para deferred, não para reprovação (S2 girou 8 rodadas)
    expect(reviewPack).toContain('não há operador')
  }, 90_000)

  // 25/09, missão real: o primeiro modelo da cadeia de provas (agy) caiu com erro de schema e a parte parava em
  // proof_not_written; a nova tentativa ainda reaproveitava a chamada que falhou. Modelo com erro passa a vez ao
  // próximo da cadeia, cada um com passo próprio.
  test('escritor_de_prova_com_erro_passa_a_vez_ao_proximo_modelo_da_cadeia', async () => {
    const fixture = setupStoryFixture({ proof: true })
    const checker = fixture.deps.dispatchCodex
    ;(fixture.deps as any).quotaPort = { readReceipt: async ({ family }: { family: string }) => ({
      source: 'official', family, used_percent: 0, reserved_percent: 0,
      observed_at: new Date().toISOString(), weekly_reset_at: new Date(Date.now() + 86400000).toISOString(),
    }) }
    fixture.deps.dispatchCodex = async (opts: any) => String(opts.stepId).includes(':proof')
      ? { is_error: true, exit_code: 1, result_text: 'invalid --json-schema' }
      : checker(opts)
    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const written = events.find((e) => e.kind === 'decision' && (e.data as any).decision === 'proof_written')
    expect(written?.data).toMatchObject({ family: 'claude' })
    const proofSteps = events.filter((e) => e.kind === 'telemetry' && (e.data as any).role === 'prova').map((e) => (e.data as any).step_id)
    expect(proofSteps).toEqual(['ADE-T1:proof', 'ADE-T1:proof:w1'])
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

  // 24/09: chamada do modelo interrompida (processo morto) e reconciliada como cobrada volta do journal `ambiguous` e sem
  // resultado. O motor seguia com a árvore sem mudança (e derrubava o adaptador); agora chama de novo como nova tentativa.
  test('chamada_do_modelo_perdida_na_queda_e_refeita_como_nova_tentativa', async () => {
    const fixture = setupStoryFixture()
    await fixture.deps.journal.append({ kind: 'step_intent', step_id: 'ADE-T1:r1:maker', effect_class: 'model_call', input_digest: '0'.repeat(16), unit: 'ADE-T1' })
    await fixture.deps.journal.append({ kind: 'step_result', step_id: 'ADE-T1:r1:maker', effect_class: 'model_call', input_digest: '0'.repeat(16), status: 'ambiguous', reason: 'call_consumed', data: { reason: 'call_consumed', result: null }, unit: 'ADE-T1' })

    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.some((e) => e.kind === 'step_result' && e.step_id === 'ADE-T1:r1t1:maker' && e.status === 'ok')).toBe(true)
  }, 120_000)

  // 24/09: parecer recusado por formato virou rodada de código. Parecer inválido é falha do revisor: uma nova revisão
  // vem antes de abrir rodada, e a parte é entregue sem o modelo reescrever nada.
  test('parecer_invalido_pede_nova_revisao_sem_abrir_rodada_de_codigo', async () => {
    const fixture = setupStoryFixture()
    const invalid = approvedReviewAction()
    ;(invalid.result as any).evidence[0].result_ref = 'eval:NAO_RODOU'
    ;(invalid.result as any).sources = ['eval:NAO_RODOU']
    fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.json'), JSON.stringify([invalid, approvedReviewAction()], null, 2))

    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.some((e) => e.kind === 'decision' && (e.data as any).decision === 'review_invalid_retry')).toBe(true)
    expect(events.some((e) => String(e.step_id ?? '').includes(':r2:'))).toBe(false)
    // a segunda revisão recebe os erros da primeira
    const retryPack = fs.readFileSync(path.join(fixture.missionDir, 'artifacts', 'packs', 'ADE-T1_r1_review-pack-t1', 'pack.md'), 'utf8')
    expect(retryPack).toContain('previous_review_rejected_by_validation')
    expect(retryPack).toContain('eval:NAO_RODOU')
  }, 120_000)

  // 24/09, missão real (S2): a V1 era a suíte inteira e já falhava na base por vermelhas antigas; o vermelho "valeu" e a
  // etapa de provas não rodou (o modelo que escreve o código escreveu o próprio teste). Vermelho da suíte inteira antes
  // das provas não prova nada da parte: a etapa de provas roda.
  test('suite_inteira_ja_vermelha_na_base_ainda_passa_pela_etapa_de_provas', async () => {
    const fixture = setupStoryFixture({ wholeSuite: true })
    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.some((e) => e.kind === 'decision' && (e.data as any).decision === 'proof_written')).toBe(true)
    // 25/09, missão real de anexos: a suíte inteira no vermelho passou dos 600 s e estacionou a parte. Antes das provas
    // ela nem roda; depois, o vermelho roda só os testes escritos.
    const reds = events.filter((e) => (e.data as any)?.result?.phase === 'red').map((e) => (e.data as any).result.argv)
    expect(reds).toEqual([['node', 'tests/check.mjs', 'tests/proof.txt']])
  }, 120_000)

  // 24/09, missão real (S2): depois de a correção esgotar, a nova tentativa refazia as rodadas antigas pelo cache sobre a
  // worktree já no estado final (revisão obsoleta, modelo "sem mudança") e estacionava de novo. Agora começa rodada nova.
  test('nova_tentativa_depois_de_correcao_esgotada_comeca_rodada_nova_e_entrega', async () => {
    const fixture = setupStoryFixture()
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const base = JSON.parse(fs.readFileSync(makerFile, 'utf8'))[0]
    fs.writeFileSync(makerFile, JSON.stringify(['ok v1\n', 'ok v2\n', 'ok v3\n'].map((c) => ({ ...base, files: { 'src/hello.txt': c } }))))
    const changes = approvedReviewAction()
    Object.assign(changes.result as any, {
      verdict: 'changes_requested',
      requested_action: 'rework',
      action_items: [{ id: 'F1', severity: 'high', category: 'patch', problem: 'ainda falta', required_action: 'corrigir', target_role: 'maker', evidence_refs: ['eval:E1'], location: 'src/hello.txt' }],
    })
    ;(changes.result as any).handoff.next_action = 'rework'
    fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.json'), JSON.stringify([changes, changes, approvedReviewAction()]))

    const first = await runStory(fixture.deps, fixture.input)
    expect(first.status).toBe('awaiting_operator')
    await fixture.deps.journal.append({ kind: 'decision', unit: 'ADE-T1', data: { decision: 'unit_retry', unit: 'ADE-T1', previous_reason: first.reason } })

    const second = await runStory(fixture.deps, fixture.input)
    expect(second).toMatchObject({ status: 'delivered' })
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.some((e) => e.kind === 'decision' && (e.data as any).decision === 'retry_new_round')).toBe(true)
    expect(fs.readFileSync(path.join(fixture.repo.dir, 'src', 'hello.txt'), 'utf8')).toBe('ok v3\n')
  }, 180_000)

  // 25/09, missão real de anexos: a rodada 2 foi aprovada e o commit caiu. A retomada refazia desde a rodada 1 pelo cache,
  // a revisão da rodada 1 ficava obsoleta diante da árvore final e a parte estacionava. Agora retoma na rodada aprovada.
  test('aprovada_com_commit_caido_retoma_na_rodada_aprovada_e_entrega', async () => {
    const fixture = setupStoryFixture()
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const base = JSON.parse(fs.readFileSync(makerFile, 'utf8'))[0]
    fs.writeFileSync(makerFile, JSON.stringify(['ok v1\n', 'ok v2\n'].map((c) => ({ ...base, files: { 'src/hello.txt': c } }))))
    const changes = approvedReviewAction()
    Object.assign(changes.result as any, {
      verdict: 'changes_requested',
      requested_action: 'rework',
      action_items: [{ id: 'F1', severity: 'high', category: 'patch', problem: 'ainda falta', required_action: 'corrigir', target_role: 'maker', evidence_refs: ['eval:E1'], location: 'src/hello.txt' }],
    })
    ;(changes.result as any).handoff.next_action = 'rework'
    fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.json'), JSON.stringify([changes, approvedReviewAction()]))
    let commitFails = true
    const deps = {
      ...fixture.deps,
      gitPortFor: (dir: string) => {
        const port = createGitPort({ worktreeDir: dir })
        return { ...port, commit: async (o: any) => { if (commitFails) { commitFails = false; throw new Error('git commit saiu com 1') } return port.commit(o) } }
      },
    }
    await expect(runStory(deps, fixture.input)).rejects.toThrow(/git commit/)

    const second = await runStory(deps, fixture.input)
    expect(second).toMatchObject({ status: 'delivered' })
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.find((e) => e.kind === 'decision' && (e.data as any).decision === 'resume_approved_round')?.data).toMatchObject({ round: 2 })
    // o passo que veio do cache não é chamada nova: um model_started por chamada de verdade
    expect(events.filter((e) => e.kind === 'model_started' && (e.data as any).step_id === 'ADE-T1:r2:maker')).toHaveLength(1)
    expect(fs.readFileSync(path.join(fixture.repo.dir, 'src', 'hello.txt'), 'utf8')).toBe('ok v2\n')
  }, 180_000)

  // 26/09, missão real de anexos (S3): o motor caiu no verde da rodada 3 de polimento visual e, retomado, recomeçou na
  // rodada 1. A rodada 2 antiga veio do cache "sem mudança" (a árvore já era a final), a escada subiu o maker para
  // esforço alto e o teto de passadas visuais zerou. Parte sem revisão ainda retoma na última rodada do maker.
  test('queda_no_polimento_visual_retoma_na_mesma_rodada_sem_subir_a_escada', async () => {
    const fixture = setupStoryFixture()
    fixture.input.story.contract.needs_ui = true
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const base = JSON.parse(fs.readFileSync(makerFile, 'utf8'))[0]
    fs.writeFileSync(makerFile, JSON.stringify(['ok v1\n', 'ok v2\n', 'ok v3\n'].map((c) => ({ ...base, files: { 'src/hello.txt': c } }))))
    const rework = { status: 'rework', defects: [{ id: 'D1', severity: 'major', criterion: 'color', where: '/', fix: 'trocar a cor' }] }
    const fqe = vi.fn().mockResolvedValueOnce(rework).mockRejectedValueOnce(new Error('queda do motor'))
    await expect(runStory({ ...fixture.deps, runFrontendQuality: fqe } as any, fixture.input)).rejects.toThrow(/queda/)

    const fqe2 = vi.fn().mockResolvedValue({ status: 'pass' })
    const second = await runStory({ ...fixture.deps, runFrontendQuality: fqe2 } as any, fixture.input)
    expect(second).toMatchObject({ status: 'delivered' })
    expect(fqe2.mock.calls.map((c) => c[0].round)).toEqual([2])
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.find((e) => e.kind === 'decision' && (e.data as any).decision === 'resume_round')?.data).toMatchObject({ round: 2, visual_evals: 1, visual_stalls: 0 })
    expect(events.some((e) => e.kind === 'decision' && (e.data as any).decision === 'maker_ladder' && (e.data as any).outcome === 'no_change')).toBe(false)
    expect(fs.readFileSync(path.join(fixture.repo.dir, 'src', 'hello.txt'), 'utf8')).toBe('ok v2\n')
  }, 180_000)

  // 24/09, missão real (S2): o contrato pedia uma fonte que a validação fora do escopo recusa; o revisor aprovou o resto e
  // repetiu, rodada após rodada, o mesmo intent_gap para "human". A TL-ADE é autônoma e nenhuma rodada do maker decide
  // pelo humano ou pelo planejador: com só esse tipo de achado, a versão atual é entregue já na primeira revisão e o
  // achado fica registrado como adiado.
  test('conflito_de_plano_entrega_na_primeira_revisao_e_registra', async () => {
    const fixture = setupStoryFixture()
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const base = JSON.parse(fs.readFileSync(makerFile, 'utf8'))[0]
    fs.writeFileSync(makerFile, JSON.stringify(['ok v1\n', 'ok v2\n'].map((c) => ({ ...base, files: { 'src/hello.txt': c } }))))
    const gap = approvedReviewAction()
    Object.assign(gap.result as any, {
      verdict: 'changes_requested',
      requested_action: 'decide',
      action_items: [
        { id: 'F3', severity: 'high', category: 'intent_gap', problem: 'o contrato pede cinco fontes', required_action: 'decidir', target_role: 'human', evidence_refs: ['eval:E1'], location: 'src/hello.txt' },
        { id: 'F4', severity: 'high', category: 'bad_spec', problem: 'a fonte falha na validação', required_action: 'replanejar', target_role: 'planner', evidence_refs: ['eval:E1'], location: 'src/hello.txt' },
      ],
    })
    ;(gap.result as any).handoff.next_action = 'decide'
    fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.json'), JSON.stringify([gap]))

    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    expect(fs.readFileSync(path.join(fixture.repo.dir, 'src', 'hello.txt'), 'utf8')).toBe('ok v1\n')
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.filter((e) => e.kind === 'review_result')).toHaveLength(1)
    const deferred = events.find((e) => e.kind === 'decision' && (e.data as any).decision === 'intent_gap_deferred')
    expect((deferred?.data as any)?.findings?.map((f: any) => f.id)).toEqual(['F3', 'F4'])
  }, 180_000)

  // Retomada depois de queda (sem nova tentativa) numa parte que já teve revisão reprovada também começa rodada nova: o
  // replay das rodadas antigas sobre a worktree já no estado final deixava as revisões obsoletas (S2 da missão real).
  test('retomada_depois_de_revisao_reprovada_comeca_rodada_nova', async () => {
    const fixture = setupStoryFixture()
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const base = JSON.parse(fs.readFileSync(makerFile, 'utf8'))[0]
    fs.writeFileSync(makerFile, JSON.stringify(['ok v1\n', 'ok v2\n'].map((c) => ({ ...base, files: { 'src/hello.txt': c } }))))
    const changes = approvedReviewAction()
    Object.assign(changes.result as any, {
      verdict: 'changes_requested',
      requested_action: 'rework',
      action_items: [{ id: 'F1', severity: 'high', category: 'patch', problem: 'ainda falta', required_action: 'corrigir', target_role: 'maker', evidence_refs: ['eval:E1'], location: 'src/hello.txt' }],
    })
    ;(changes.result as any).handoff.next_action = 'rework'
    fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.json'), JSON.stringify([changes, approvedReviewAction()]))
    const realDispatch = fixture.deps.dispatchClaude
    let calls = 0
    fixture.deps.dispatchClaude = async (opts: any) => {
      if (++calls === 2) throw new Error('queda na rodada 2')
      return realDispatch(opts)
    }

    await expect(runStory(fixture.deps, fixture.input)).rejects.toThrow('queda na rodada 2')
    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.some((e) => e.kind === 'decision' && (e.data as any).decision === 'retry_new_round')).toBe(true)
  }, 180_000)

  // 24/09, missão real (S2, r9): o trabalho de uma rodada interrompida antes da revisão ficou na árvore; na rodada nova o
  // modelo não mudou mais nada e o motor estacionou, sem nunca revisar aquela árvore. Sem mudança, mas com árvore ainda
  // não revisada, a parte segue para o verde e a revisão.
  test('sem_mudanca_com_arvore_ainda_nao_revisada_segue_para_revisao', async () => {
    const fixture = setupStoryFixture()
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const base = JSON.parse(fs.readFileSync(makerFile, 'utf8'))[0]
    fs.writeFileSync(makerFile, JSON.stringify(['ok v1\n', 'ok v2\n', 'ok v2\n'].map((c) => ({ ...base, files: { 'src/hello.txt': c } }))))
    const changes = approvedReviewAction()
    Object.assign(changes.result as any, {
      verdict: 'changes_requested',
      requested_action: 'rework',
      action_items: [{ id: 'F1', severity: 'high', category: 'patch', problem: 'ainda falta', required_action: 'corrigir', target_role: 'maker', evidence_refs: ['eval:E1'], location: 'src/hello.txt' }],
    })
    ;(changes.result as any).handoff.next_action = 'rework'
    fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.json'), JSON.stringify([changes, approvedReviewAction()]))
    const original = fixture.deps.createEvalRunner
    let greens = 0
    fixture.deps.createEvalRunner = (opts: any) => {
      const runner = original(opts)
      return { ...runner, runEval: async (args: any) => {
        if (args.phase === 'green' && ++greens === 2) throw new Error('queda antes da revisão da r2')
        return runner.runEval(args)
      } }
    }

    await expect(runStory(fixture.deps, fixture.input)).rejects.toThrow('queda antes da revisão')
    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
  }, 180_000)

  // 25/09, missão real (S3): a parte começou, caiu no vermelho inicial e, na retomada, a etapa de provas foi pulada porque
  // a regra olhava "parte começou" em vez de "provas ainda não escritas".
  test('retomada_antes_das_provas_com_suite_inteira_ainda_passa_pela_etapa_de_provas', async () => {
    const fixture = setupStoryFixture({ wholeSuite: true })
    const original = fixture.deps.createEvalRunner
    let reds = 0
    fixture.deps.createEvalRunner = (opts: any) => {
      const runner = original(opts)
      return { ...runner, runEval: async (args: any) => {
        if (args.phase === 'red' && ++reds === 1) throw new Error('queda no vermelho inicial')
        return runner.runEval(args)
      } }
    }
    await expect(runStory(fixture.deps, fixture.input)).rejects.toThrow('queda no vermelho inicial')
    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.some((e) => e.kind === 'decision' && (e.data as any).decision === 'proof_written')).toBe(true)
  }, 120_000)

  // Revisão aprovada com itens adiados (requisito impossível dentro do escopo): o motor registra os adiados para o
  // relatório, e a parte entra sem rodada extra.
  test('aprovacao_com_itens_adiados_registra_os_adiados', async () => {
    const fixture = setupStoryFixture()
    const approved = approvedReviewAction()
    ;(approved.result as any).deferred = [{ id: 'D1', severity: 'high', category: 'intent_gap', problem: 'a quinta fonte exige mudar o validador', required_action: 'decidir depois', target_role: 'human', evidence_refs: ['eval:E1'], location: 'src/hello.txt' }]
    fs.writeFileSync(path.join(fixture.scenarioDir, 'checker.json'), JSON.stringify([approved]))
    const result = await runStory(fixture.deps, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const d = events.find((e) => e.kind === 'decision' && (e.data as any).decision === 'review_deferred')
    expect((d?.data as any)?.items?.[0]?.id).toBe('D1')
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

  // Sempre autônoma (25/09): visual sem veredito não estaciona mais; a parte segue para o revisor e entrega
  test('engine_fqe_sem_veredito_segue_para_o_revisor_sem_estacionar', async () => {
    const fixture = setupStoryFixture()
    fixture.input.story.contract.needs_ui = true

    const mockRunFQE = vi.fn().mockResolvedValue({
      status: 'awaiting_operator',
      reason: 'visual_cut_not_met',
      evaluation: { final: 6.8, verdict: 'unknown' },
    })

    const depsWithFQE = { ...fixture.deps, runFrontendQuality: mockRunFQE }
    const result = await runStory(depsWithFQE, fixture.input)
    expect(result.status).toBe('delivered')
    expect(mockRunFQE).toHaveBeenCalledTimes(1)
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.find((e) => e.kind === 'decision' && (e.data as any).decision === 'visual_continue')?.data).toMatchObject({ next: 'checker_without_visual_pass' })
  }, 60_000)

  // Os juízes variam uns 0,3 de uma vez para outra: uma passada sem ganho não para; duas seguidas (6 → 6,1 → 6,2) encerram
  // as passadas antes do teto e a parte segue para o revisor
  test('engine_fqe_duas_passadas_sem_ganho_param_e_seguem_para_o_revisor', async () => {
    const fixture = setupStoryFixture()
    fixture.input.story.contract.needs_ui = true
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const base = JSON.parse(fs.readFileSync(makerFile, 'utf8'))[0]
    fs.writeFileSync(makerFile, JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ ...base, files: { 'src/hello.txt': `ok v${i + 1}\n` } }))))
    const defect = { id: 'x', severity: 'major', criterion: 'hierarchy', where: 'topo', fix: 'Enviar como única ação preenchida' }
    const mockRunFQE = vi.fn()
    for (const final of [6, 6.1, 6.2]) mockRunFQE.mockResolvedValueOnce({ status: 'rework', evaluation: { final, verdict: 'rework', criteria: [] }, defects: [defect] })
    const depsWithFQE = { ...fixture.deps, runFrontendQuality: mockRunFQE }
    const result = await runStory(depsWithFQE, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    expect(mockRunFQE).toHaveBeenCalledTimes(3)
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.find((e) => e.kind === 'decision' && (e.data as any).decision === 'visual_continue')?.data).toMatchObject({ next: 'checker_no_visual_gain' })
  }, 60_000)

  // 26/09: o pedido de correção cortava o problema em 220 caracteres e descartava evidence_refs; os prints ficavam na pasta
  // da missão, fora do alcance do maker. Agora vão copiados para .ade/evidence da worktree e o problema chega inteiro.
  test('engine_fqe_prints_e_problema_longo_chegam_ao_maker', async () => {
    const fixture = setupStoryFixture()
    fixture.input.story.contract.needs_ui = true
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const base = JSON.parse(fs.readFileSync(makerFile, 'utf8'))[0]
    fs.writeFileSync(makerFile, JSON.stringify([1, 2].map((i) => ({ ...base, files: { 'src/hello.txt': `ok v${i}\n` } }))))
    const shot = path.join(fixture.missionDir, 'tela-390-dark.png')
    fs.writeFileSync(shot, 'png')
    const longWhere = `topo ${'x'.repeat(300)} FIM-DO-ONDE`
    const mockRunFQE = vi.fn()
      .mockResolvedValueOnce({ status: 'rework', evaluation: { final: 5, verdict: 'rework', criteria: [] }, captures: [{ path: shot }], defects: [{ id: 'x', severity: 'major', criterion: 'hierarchy', where: longWhere, fix: 'Enviar como única ação preenchida' }] })
      .mockResolvedValue({ status: 'pass', evaluation: { final: 7.8, verdict: 'pass', criteria: [] } })
    const depsWithFQE = { ...fixture.deps, runFrontendQuality: mockRunFQE }
    const result = await runStory(depsWithFQE, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const worktreeDir = events.map((e) => (e.data as any)?.worktree_dir).find(Boolean)
    expect(fs.existsSync(path.join(worktreeDir, '.ade', 'evidence', 'r1', 'tela-390-dark.png'))).toBe(true)
    const packs = fs.readdirSync(fixture.missionDir, { recursive: true }).map(String).map((p) => path.join(fixture.missionDir, p)).filter((p) => fs.statSync(p).isFile())
    const rework = packs.map((p) => fs.readFileSync(p, 'utf8')).find((t) => t.includes('Enviar como única ação preenchida') && t.includes('open_findings'))
    expect(rework).toContain('FIM-DO-ONDE')
    expect(rework).toContain('.ade/evidence/r1/tela-390-dark.png')
  }, 60_000)

  // 25/09, pedido do operador: passadas conforme necessário. Subindo a cada passada, passa das 3 rodadas de correção da
  // parte (não passa pela escada nem troca de modelo) e cada juiz recebe a avaliação anterior
  test('engine_fqe_passadas_flexiveis_seguem_enquanto_a_nota_sobe', async () => {
    const fixture = setupStoryFixture()
    fixture.input.story.contract.needs_ui = true
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const base = JSON.parse(fs.readFileSync(makerFile, 'utf8'))[0]
    fs.writeFileSync(makerFile, JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ ...base, files: { 'src/hello.txt': `ok v${i + 1}\n` } }))))
    const defect = { id: 'x', severity: 'minor', criterion: 'typography', where: 'dica', fix: 'dica em 15px' }
    const mockRunFQE = vi.fn()
    for (const final of [5, 5.5, 6, 6.6, 7.2]) mockRunFQE.mockResolvedValueOnce({ status: 'rework', evaluation: { final, verdict: 'rework', criteria: [] }, defects: [defect] })
    mockRunFQE.mockResolvedValue({ status: 'pass', evaluation: { final: 7.8, verdict: 'pass', criteria: [] } })
    const depsWithFQE = { ...fixture.deps, runFrontendQuality: mockRunFQE }
    const result = await runStory(depsWithFQE, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    expect(mockRunFQE).toHaveBeenCalledTimes(6)
    expect(mockRunFQE.mock.calls[0][0].story.previous_visual_eval).toBeNull()
    expect(mockRunFQE.mock.calls[5][0].story.previous_visual_eval).toMatchObject({ final: 7.2 })
    // o passo minor do caminho até 7,5 chega ao maker (antes virava low e o pedido de correção o descartava)
    const packs = fs.readdirSync(fixture.missionDir, { recursive: true }).map(String).map((p) => path.join(fixture.missionDir, p)).filter((p) => fs.statSync(p).isFile())
    expect(packs.some((p) => fs.readFileSync(p, 'utf8').includes('dica em 15px'))).toBe(true)
  }, 120_000)

  // Múltiplas passadas: reprovação visual volta ao maker com os defeitos; a passada seguinte aprova e a parte entrega
  test('engine_fqe_reprovado_volta_ao_maker_e_segunda_passada_aprova', async () => {
    const fixture = setupStoryFixture()
    fixture.input.story.contract.needs_ui = true
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const base = JSON.parse(fs.readFileSync(makerFile, 'utf8'))[0]
    fs.writeFileSync(makerFile, JSON.stringify(['ok v1\n', 'ok v2\n'].map((c) => ({ ...base, files: { 'src/hello.txt': c } }))))
    const mockRunFQE = vi.fn()
      .mockResolvedValueOnce({ status: 'rework', defects: [{ id: 'D6', severity: 'critical', criterion: 'hierarchy', where: '/ [390px] (textarea)', fix: 'Caber em 390px' }] })
      .mockResolvedValue({ status: 'pass' })

    const depsWithFQE = { ...fixture.deps, runFrontendQuality: mockRunFQE }
    const result = await runStory(depsWithFQE, fixture.input)
    expect(result).toMatchObject({ status: 'delivered' })
    expect(mockRunFQE).toHaveBeenCalledTimes(2)
    expect(mockRunFQE.mock.calls.map((c) => c[0].round)).toEqual([1, 2])
    // o pedido de correção leva o defeito visual com texto, não um achado vazio
    const packs = fs.readdirSync(fixture.missionDir, { recursive: true }).map(String).filter((p) => p.includes('r2'))
    const texts = packs.map((p) => path.join(fixture.missionDir, p)).filter((p) => fs.statSync(p).isFile()).map((p) => fs.readFileSync(p, 'utf8'))
    expect(texts.some((t) => t.includes('Caber em 390px') && t.includes('Avaliação visual (hierarchy)'))).toBe(true)
  }, 60_000)
})

// Jornadas de usuário (26/09): a prova de parte com tela escreve também o roteiro de navegador, que o motor guarda fora
// da worktree (o maker não afrouxa) e roda antes dos portões e dos juízes.
describe('jornada de usuário no motor', () => {
  const JOURNEY = { journeys: [{ criterio: 'C1', steps: [{ goto: '/' }, { click: { role: 'button', name: 'Enviar' } }, { expect_text: 'Salvo' }] }] }
  const failure = (tag: string) => ({
    criterio: 'C1', step_index: 2, step: { click: { role: 'button', name: 'Enviar' } }, error: 'locator.click: Timeout 5000ms exceeded.',
    console: ['error: salvar quebrou'], failed_requests: ['500 GET /api/salvar'], dom: '<main><button>Mandar</button></main>',
    screenshot: `/m/journey-${tag}.png`, trace: `/m/journey-${tag}-trace.zip`, url: 'http://127.0.0.1:4173/',
  })
  const journeyFail = (tag: string) => ({ status: 'rework', reason: 'journey_failed', journey: { status: 'fail', failure: failure(tag), needs_data: [] }, defects: [{ id: 'journey-C1', severity: 'critical', criterion: 'journey', where: 'C1 passo 2', fix: 'x' }] })
  const packTexts = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).map((p) => path.join(dir, p))
    .filter((p) => fs.statSync(p).isFile() && p.endsWith('.md')).map((p) => fs.readFileSync(p, 'utf8'))

  function uiProofFixture(extra: Array<Record<string, unknown>> = []) {
    const fixture = setupStoryFixture({ proof: true })
    fixture.input.story.contract.needs_ui = true
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const actions = JSON.parse(fs.readFileSync(makerFile, 'utf8'))
    actions[0].files['.ade/journey.json'] = JSON.stringify(JOURNEY)
    fs.writeFileSync(makerFile, JSON.stringify([...actions, ...extra.map((e) => ({ ...actions[1], ...e }))]))
    return { fixture, base: actions[1] }
  }

  test('prova_de_parte_com_tela_grava_o_roteiro_oficial_e_roteiro_que_ja_passa_fica_como_regressao', async () => {
    const { fixture } = uiProofFixture()
    const runJourneyCheck = vi.fn().mockResolvedValue({ status: 'pass', needs_data: [] })
    const result = await runStory({ ...fixture.deps, runFrontendQuality: vi.fn().mockResolvedValue({ status: 'pass' }), runJourneyCheck } as any, fixture.input)
    expect(result.status).toBe('delivered')
    const official = path.join(fixture.missionDir, 'artifacts', 'journeys', 'ADE-T1.json')
    expect(JSON.parse(fs.readFileSync(official, 'utf8'))).toEqual(JOURNEY)
    expect(runJourneyCheck.mock.calls[0][0]).toMatchObject({ file: official })
    // a prova recebe o pedido e o formato do roteiro
    const proofPack = fs.readFileSync(path.join(fixture.missionDir, 'artifacts', 'packs', 'ADE-T1_proof_pack', 'pack.md'), 'utf8')
    expect(proofPack).toContain('roteiro de navegador (.ade/journey.json)')
    expect(proofPack).toContain('needs_data')
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.find((e) => e.kind === 'decision' && (e.data as any).decision === 'journey_not_red')?.data).toMatchObject({ counts_as_proof: false })
  }, 90_000)

  test('mesmo_passo_quebrando_duas_vezes_avisa_que_o_roteiro_pode_estar_errado_e_a_prova_reescreve_uma_vez', async () => {
    const { fixture, base } = uiProofFixture()
    const stdout = JSON.parse(base.stdout)
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const actions = JSON.parse(fs.readFileSync(makerFile, 'utf8'))
    actions.push(
      { ...base, files: { 'src/hello.txt': 'ok v2\n' } },
      { ...base, files: { 'src/hello.txt': 'ok v3\n' }, stdout: JSON.stringify({ ...stdout, result: 'ROTEIRO ERRADO: o critério não pede o botão Enviar' }) },
      { ...base, files: { '.ade/journey.json': JSON.stringify({ journeys: [{ ...JOURNEY.journeys[0], steps: [{ goto: '/' }, { expect_text: 'Salvo' }] }] }) } },
    )
    fs.writeFileSync(makerFile, JSON.stringify(actions))
    const fqe = vi.fn().mockResolvedValueOnce(journeyFail('r1')).mockResolvedValueOnce(journeyFail('r2')).mockResolvedValue({ status: 'pass' })
    const result = await runStory({ ...fixture.deps, runFrontendQuality: fqe } as any, fixture.input)
    expect(result.status).toBe('delivered')
    expect(fqe).toHaveBeenCalledTimes(3)
    const texts = packTexts(fixture.missionDir)
    // o maker recebe o passo, o console, as requisições com erro, o DOM e o print/trace
    expect(texts.some((t) => t.includes('Jornada do critério C1 quebrou no passo 2') && t.includes('salvar quebrou') && t.includes('500 GET /api/salvar') && t.includes('Mandar') && t.includes('journey-r1-trace.zip'))).toBe(true)
    expect(texts.some((t) => t.includes('o roteiro pode estar errado') && t.includes('ROTEIRO ERRADO'))).toBe(true)
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const decisions = events.filter((e) => e.kind === 'decision').map((e) => (e.data as any).decision)
    // sem serve na config o vermelho do roteiro não é conferido, e a missão segue
    expect(decisions).toContain('journey_red_unchecked')
    expect(decisions.filter((d) => d === 'journey_rewritten')).toHaveLength(1)
    const official = JSON.parse(fs.readFileSync(path.join(fixture.missionDir, 'artifacts', 'journeys', 'ADE-T1.json'), 'utf8'))
    expect(official.journeys[0].steps).toHaveLength(2)
  }, 120_000)

  // 26/09, missão real de anexos: a prova marcou os cinco critérios da tela como needs_data, sem nenhum passo, e a jornada
  // não conferiu nada; a tela subia com o campo do pedido à mostra. Roteiro sem passo nenhum volta à prova uma vez, antes
  // da primeira passada visual, para ela escrever os passos lendo o código da tela.
  test('roteiro_sem_nenhum_passo_volta_a_prova_antes_da_primeira_passada_visual', async () => {
    const { fixture, base } = uiProofFixture()
    const makerFile = path.join(fixture.scenarioDir, 'maker.json')
    const actions = JSON.parse(fs.readFileSync(makerFile, 'utf8'))
    actions[0].files['.ade/journey.json'] = JSON.stringify({ journeys: [{ criterio: 'C1', needs_data: true, steps: [] }] })
    actions.push({ ...base, files: { '.ade/journey.json': JSON.stringify(JOURNEY) } })
    fs.writeFileSync(makerFile, JSON.stringify(actions))
    const fqe = vi.fn().mockResolvedValue({ status: 'pass' })
    const result = await runStory({ ...fixture.deps, runFrontendQuality: fqe } as any, fixture.input)
    expect(result.status).toBe('delivered')
    const official = JSON.parse(fs.readFileSync(path.join(fixture.missionDir, 'artifacts', 'journeys', 'ADE-T1.json'), 'utf8'))
    expect(official).toEqual(JOURNEY)
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.filter((e) => e.kind === 'decision' && (e.data as any).decision === 'journey_rewritten').map((e) => (e.data as any).reason_to_rewrite)).toEqual(['sem_passos'])
    const texts = packTexts(fixture.missionDir)
    expect(texts.some((t) => t.includes('nenhum critério tem passos'))).toBe(true)
  }, 120_000)

  test('jornada_ainda_falhando_no_fim_das_passadas_vai_ao_revisor_como_achado_bloqueante', async () => {
    const { fixture } = uiProofFixture()
    fs.writeFileSync(path.join(fixture.repo.dir, '.ade', 'config.json'), JSON.stringify({ visual: { max_rounds: 1 } }))
    const fqe = vi.fn().mockResolvedValue(journeyFail('r1'))
    const result = await runStory({ ...fixture.deps, runFrontendQuality: fqe } as any, fixture.input)
    expect(result.status).toBe('delivered')
    const reviewPack = fs.readFileSync(path.join(fixture.missionDir, 'artifacts', 'packs', 'ADE-T1_r1_review-pack', 'pack.md'), 'utf8')
    const prior = JSON.parse(/"prior_findings": (\[[\s\S]*?\n {4}\])/.exec(reviewPack)![1])
    expect(prior[0]).toMatchObject({ severity: 'high' })
    expect(prior[0].problem).toContain('Jornada do critério C1 quebrou no passo 2')
    expect(prior[0].evidence_refs).toContain('/m/journey-r1.png')
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(events.some((e) => e.kind === 'decision' && (e.data as any).decision === 'journey_unresolved')).toBe(true)
  }, 90_000)
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
