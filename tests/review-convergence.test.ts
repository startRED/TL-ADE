import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { dispatchClaude } from '../src/adapters/claude/index.ts'
import { buildCodexArgs } from '../src/adapters/codex/argv.ts'
import { dispatchCodex } from '../src/adapters/codex/index.ts'
import { checkCanary, plantCanary } from '../src/contain/canary.ts'
import { contain } from '../src/contain/contain.ts'
import { computeObservedInputDigest, runStory } from '../src/engine.ts'
import { readCounter } from '../src/adapters/fake/cli.ts'
import { loadPlan } from '../src/engine/plan-load.ts'
import { prepareStory } from '../src/engine/prepare.ts'
import { createEvalRunner } from '../src/evals/eval-runner.ts'
import { createGateRunner } from '../src/gates/gates.ts'
import { createGitPort } from '../src/git/gitport.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { compilePack } from '../src/pack/pack.ts'
import { reconcileAll } from '../src/step/reconcile.ts'
import { createStepRunner } from '../src/step/step.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI_PATH = path.join(ROOT, 'src/adapters/fake/cli.ts')

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

interface FixtureOptions {
  makerRole?: { family: string; model_id: string }
  checkerRole?: { family: string; model_id: string; sandbox?: string }
  maxReworkRounds?: number
  makerActions?: any[]
  checkerActions?: any[]
  /** revisões do cenário como estão, sem a prova executável automática */
  rawChecker?: boolean
}

/**
 * Revisões com prova executável em cada achado que bloqueia (ADR 0047): o revisor dublê grava a prova na cópia e a cita.
 * Sem ela o achado seria rebaixado e o cenário não testaria a convergência.
 */
function provenActions(actions: any[]): any[] {
  const digest = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  return actions.map((action) => {
    const items = action?.result?.action_items ?? []
    const blocking = items.filter((f: any) => ['critical', 'high', 'medium'].includes(f.severity) && f.target_role === 'maker')
    if (blocking.length === 0) return action
    const files = { ...action.files }
    const evidence = [...(action.result.evidence ?? [])]
    const proven = items.map((f: any) => {
      if (!blocking.includes(f)) return f
      const ref = `artifact:.ade-review/${f.id}.json`
      files[`.ade-review/${f.id}.json`] = JSON.stringify({ argv: ['node', 'tests/check.mjs'], exit_code: 1, output: f.problem })
      evidence.push({ criterion: 'R1', result_ref: ref, input_digest: digest })
      return { ...f, evidence_refs: [...f.evidence_refs, ref] }
    })
    return { ...action, files, result: { ...action.result, action_items: proven, evidence } }
  })
}

function setupConvergenceFixture(options: FixtureOptions = {}) {
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
  repo.git(['commit', '-m', 'test: initial commit'])

  const planDir = path.join(repo.dir, '.ade')
  fs.mkdirSync(planDir, { recursive: true })
  const storiesDir = path.join(planDir, 'stories')
  fs.mkdirSync(storiesDir, { recursive: true })

  const planObj = {
    format_version: 2,
    id: 'plan-conv-1',
    mission_id: 'mission-conv-1',
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
            stories: ['ADE-C1'],
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
      max_model_calls: 10,
      max_rework_rounds: 2,
    },
  }
  fs.writeFileSync(path.join(planDir, 'plan.json'), JSON.stringify(planObj, null, 2), 'utf8')

  const makerRole = options.makerRole ?? { family: 'claude', model_id: 'claude-sonnet-5' }
  const checkerRole =
    options.checkerRole !== undefined
      ? options.checkerRole
      : { family: 'codex', model_id: 'gpt-5.6-terra' }

  const contractObj = {
    format_version: 2,
    id: 'ADE-C1',
    title: 'Story Convergence',
    complexity: 'bounded',
    task: 'Create src/hello.txt with ok',
    workspace: {
      kind: 'git',
      root: '.',
    },
    risk: {
      level: 'normal',
      surfaces: [],
      evidence: ['repo:tests/check.mjs'],
    },
    guardrails: {
      scope_paths: ['src/**', 'tests/**'],
      do_not_touch: ['.ade/**'],
      autonomy: 'safe',
    },
    requirements: [
      { id: 'R1', ears: 'WHEN check runs THE SYSTEM SHALL pass.' },
    ],
    scenarios: [
      Object.assign(
        {
          id: 'C1',
          given: 'initial state without hello.txt',
          when: 'maker creates hello.txt with ok',
          evals: ['E1'],
          verifiers: ['V1'],
        },
        JSON.parse('{"then":"eval check passes"}'),
      ),
    ],
    verifiers: [
      {
        id: 'V1',
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
    unknowns: [],
    evals: [
      {
        format_version: 1,
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
      maker: makerRole,
      ...(checkerRole ? { checker_round: checkerRole } : {}),
    },
    budget: {
      max_model_calls: 8,
      max_rework_rounds: options.maxReworkRounds ?? 2,
    },
  }
  fs.writeFileSync(
    path.join(storiesDir, 'ADE-C1.json'),
    JSON.stringify(contractObj, null, 2),
    'utf8',
  )

  const loaded = loadPlan(path.join(planDir, 'plan.json'))
  const story = loaded.stories[0]

  const scenarioDir = makeTmpDir('ade-conv-fake-')
  tmpDirs.push(scenarioDir)

  const defaultMakerActions = options.makerActions ?? [
    {
      files: { 'src/hello.txt': 'ok\n' },
      result: {
        format_version: 2,
        story_id: 'ADE-C1',
        contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        input_revision: {
          tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
          digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        },
        state: 'ready_for_verification',
        phase: 'green',
        requested_action: 'verify',
        round: 1,
        evidence: [
          {
            criterion: 'R1',
            result_ref: 'eval:E1',
            input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
        ],
        handoff: {
          claims: [],
          unknowns: [],
          questions_for_owner: [],
          deltas: [{ kind: 'added', ref: 'file:src/hello.txt#L1-L1' }],
          next_action: 'verify',
          notes: 'ready for verification',
        },
        sources: ['file:src/hello.txt#L1-L1'],
        reason: 'ok',
      },
      stdout: JSON.stringify({ total_cost_usd: 0.01 }),
    },
  ]
  fs.writeFileSync(path.join(scenarioDir, 'maker.json'), JSON.stringify(defaultMakerActions, null, 2), 'utf8')

  const defaultCheckerActions = options.checkerActions ? (options.rawChecker ? options.checkerActions : provenActions(options.checkerActions)) : [
    {
      result: {
        format_version: 2,
        contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        input_revision: {
          tree: 'WILL_BE_FILLED_BY_ENGINE_OR_TEST',
          digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        },
        verdict: 'approved',
        action_items: [],
        deferred: [],
        rejected: [],
        evidence: [
          {
            criterion: 'R1',
            result_ref: 'eval:E1',
            input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
        ],
        requested_action: 'verify',
        sources: ['eval:E1'],
        summary: 'approved by independent review',
        handoff: {
          claims: [],
          unknowns: [],
          questions_for_owner: [],
          deltas: [],
          next_action: 'verify',
          notes: 'approved',
        },
      },
      stdout: JSON.stringify({ total_cost_usd: 0.01 }),
    },
  ]
  fs.writeFileSync(path.join(scenarioDir, 'checker.json'), JSON.stringify(defaultCheckerActions, null, 2), 'utf8')

  const missionDir = path.join(repo.dir, '.ade', 'missions', loaded.plan.mission_id)
  fs.mkdirSync(missionDir, { recursive: true })

  const journal = openJournal({ missionDir, runtimeStamp: '1:aaaaaaaa:bbbbbbbb' })
  openJournals.push(journal)

  const { step } = createStepRunner({ journal, missionDir })

  const testDispatchCodex = async (opts: any) => {
    const wtPort = createGitPort({ worktreeDir: opts.cwd })
    const tree = await wtPort.worktreeTree()
    const dirty = await wtPort.dirtyPaths()
    const expectedDigest = computeObservedInputDigest({
      tree,
      changedPaths: dirty,
      contractRevision: (story as any).contract_revision,
    })

    const checkerFile = path.join(scenarioDir, 'checker.json')
    if (fs.existsSync(checkerFile)) {
      try {
        const raw = fs.readFileSync(checkerFile, 'utf8')
        const actions = JSON.parse(raw)
        const count = readCounter(scenarioDir, 'checker')
        const action = actions[Math.min(count, actions.length - 1)]
        if (action?.result?.input_revision) {
          const t = action.result.input_revision.tree
          if (t === 'AUTO_TREE' || t === 'WILL_BE_FILLED_BY_ENGINE_OR_TEST' || t === 'TRUE_TREE') {
            action.result.input_revision.tree = tree
          }
          const d = action.result.input_revision.digest
          if (
            d === 'AUTO_DIGEST' ||
            d === 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' ||
            d === 'TRUE_DIGEST'
          ) {
            action.result.input_revision.digest = expectedDigest
          }
        }
        fs.writeFileSync(checkerFile, JSON.stringify(actions, null, 2), 'utf8')
      } catch {}
    }
    return dispatchCodex(opts)
  }

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
    dispatchCodex: testDispatchCodex,
    reconcileAll,
    resolved: {
      exe: process.execPath,
      prefixArgs: [CLI_PATH],
    },
    workerEnv: {
      ADE_FAKE_SCENARIO: scenarioDir,
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
        { id: 'proof_target', status: 'ready' as const, reason: null },
        { id: 'dependencies', status: 'ready' as const, reason: null },
        { id: 'build', status: 'ready' as const, reason: null },
        { id: 'worktree', status: 'ready' as const, reason: null },
        { id: 'input', status: 'ready' as const, reason: null },
        { id: 'credential', status: 'ready' as const, reason: null },
        { id: 'disk', status: 'ready' as const, reason: null },
        { id: 'external_access', status: 'ready' as const, reason: null },
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

describe('Integrar revisão e correção que convergem', () => {
  // Critério 1: revisão de fornecedor elegível distinto, sem permissão de escrita
  test('revisao_de_fornecedor_elegivel_distinto_sem_permissao_de_escrita', async () => {
    // 1. Mesmo vendor/família (claude + claude) é recusado
    const sameFamilyFixture = setupConvergenceFixture({
      makerRole: { family: 'claude', model_id: 'claude-sonnet-5' },
      checkerRole: { family: 'claude', model_id: 'claude-opus-4' },
    })
    await expect(runStory(sameFamilyFixture.deps, sameFamilyFixture.input)).rejects.toThrow(
      /mesma família|vendor|distinct|same_family/i,
    )

    // 2. Checker com permissão de escrita é recusado
    expect(() =>
      buildCodexArgs({
        role: 'checker_round',
        cwd: 'C:/dummy',
        resultFile: 'C:/dummy/res.json',
        sandbox: 'workspace-write',
      }),
    ).toThrow(/escrita|read-only|permissão/i)

    // 3. Effort inválido em buildCodexArgs é recusado
    expect(() =>
      buildCodexArgs({
        role: 'checker_round',
        cwd: 'C:/dummy',
        resultFile: 'C:/dummy/res.json',
        effort: 'arbitrary_injection',
      }),
    ).toThrow(/effort inválido/i)
  }, 45000)

  // Critério 2: resultado obsoleto ou sem evidência não aprova
  test('resultado_obsoleto_ou_sem_evidencia_nao_aprova', async () => {
    // Checker emite resultado com tree obsoleta (não bate com a árvore verificada)
    const staleFixture = setupConvergenceFixture({
      checkerActions: [
        {
          result: {
            format_version: 2,
            contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            input_revision: {
              tree: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', // árvore obsoleta
              digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
            },
            verdict: 'approved',
            action_items: [],
            deferred: [],
            rejected: [],
            evidence: [
              {
                criterion: 'R1',
                result_ref: 'eval:E1',
                input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            ],
            requested_action: 'verify',
            sources: ['eval:E1'],
            summary: 'stale review result',
            handoff: {
              claims: [],
              unknowns: [],
              questions_for_owner: [],
              deltas: [],
              next_action: 'verify',
              notes: 'stale',
            },
          },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
      ],
    })

    const result = await runStory(staleFixture.deps, staleFixture.input)
    expect(result.status).toBe('awaiting_operator')
    expect(result.commit).toBeNull()
    expect(result.reason).toMatch(/stale|review_rejected|unapproved/i)
  }, 45000)

  // Critério 3: findings bloqueantes não corrigidos são detectados antes de reenviar o mesmo trabalho
  test('findings_bloqueantes_nao_corrigidos_sao_detectados_antes_de_reenviar_o_mesmo_trabalho', async () => {
    // Checker na rodada 1 pede correções com finding bloqueante.
    // Maker na rodada 2 não altera nada (mesma árvore / mesmos arquivos não corrigidos).
    const findingFixture = setupConvergenceFixture({
      makerActions: [
        {
          files: { 'src/hello.txt': 'ok\n' },
          result: { status: 'ready_for_verification' },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
        {
          // Rework não tocou nos arquivos apontados
          files: { 'src/hello.txt': 'ok\n' },
          result: { status: 'ready_for_verification' },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
      ],
      checkerActions: [
        {
          result: {
            format_version: 2,
            contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            input_revision: {
              tree: 'AUTO_TREE',
              digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
            },
            verdict: 'changes_requested',
            action_items: [
              {
                id: 'finding-blocking-1',
                severity: 'critical',
                category: 'patch',
                target_role: 'maker',
                location: 'src/hello.txt:1',
                problem: 'mensagem incompleta sem saudacao formal',
                evidence_refs: ['eval:E1'],
                required_action: 'ajustar saudacao para incluir nome formal',
              },
            ],
            deferred: [],
            rejected: [],
            evidence: [
              {
                criterion: 'R1',
                result_ref: 'eval:E1',
                input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            ],
            requested_action: 'rework',
            sources: ['eval:E1'],
            summary: 'changes requested for formal greeting',
            handoff: {
              claims: [],
              unknowns: [],
              questions_for_owner: [],
              deltas: [],
              next_action: 'rework',
              notes: 'correcao necessaria',
            },
          },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
      ],
    })

    const res = await runStory(findingFixture.deps, findingFixture.input)
    expect(res.status).toBe('awaiting_operator')
    expect(res.commit).toBeNull()
    expect(res.reason).toMatch(/unresolved_blocking_findings|stagnation|diff_oscillation/i)
  }, 45000)

  // Critério 4: limite de rework e estagnação encerram com diagnóstico
  test('limite_de_rework_e_estagnacao_encerram_com_diagnostico', async () => {
    // 1. Estagnação: mesmos findings retornados em rodadas consecutivas
    const stagFixture = setupConvergenceFixture({
      maxReworkRounds: 3,
      makerActions: [
        {
          files: { 'src/hello.txt': 'ok 1\n' },
          result: { status: 'ready_for_verification' },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
        {
          files: { 'src/hello.txt': 'ok 2\n' },
          result: { status: 'ready_for_verification' },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
      ],
      checkerActions: [
        {
          result: {
            format_version: 2,
            contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            input_revision: {
              tree: 'AUTO_TREE',
              digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
            },
            verdict: 'changes_requested',
            action_items: [
              {
                id: 'finding-1',
                severity: 'high',
                category: 'patch',
                target_role: 'maker',
                location: 'src/hello.txt:1',
                problem: 'erro repetido de formatacao',
                evidence_refs: ['eval:E1'],
                required_action: 'corrigir formatacao',
              },
            ],
            deferred: [],
            rejected: [],
            evidence: [
              {
                criterion: 'R1',
                result_ref: 'eval:E1',
                input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            ],
            requested_action: 'rework',
            sources: ['eval:E1'],
            summary: 'mesmo finding da rodada anterior',
            handoff: {
              claims: [],
              unknowns: [],
              questions_for_owner: [],
              deltas: [],
              next_action: 'rework',
              notes: 'stagnation',
            },
          },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
        {
          result: {
            format_version: 2,
            contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            input_revision: {
              tree: 'AUTO_TREE',
              digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
            },
            verdict: 'changes_requested',
            action_items: [
              {
                id: 'finding-1-rep',
                severity: 'high',
                category: 'patch',
                target_role: 'maker',
                location: 'src/hello.txt:1',
                problem: 'erro repetido de formatacao',
                evidence_refs: ['eval:E1'],
                required_action: 'corrigir formatacao',
              },
            ],
            deferred: [],
            rejected: [],
            evidence: [
              {
                criterion: 'R1',
                result_ref: 'eval:E1',
                input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            ],
            requested_action: 'rework',
            sources: ['eval:E1'],
            summary: 'mesmo finding da rodada anterior',
            handoff: {
              claims: [],
              unknowns: [],
              questions_for_owner: [],
              deltas: [],
              next_action: 'rework',
              notes: 'stagnation',
            },
          },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
      ],
    })

    const stagRes = await runStory(stagFixture.deps, stagFixture.input)
    expect(stagRes.status).toBe('awaiting_operator')
    expect(stagRes.reason).toBe('stagnation')

    // 2. Esgotamento de retrabalho: com max_rework_rounds = 2, permite exatamente 2 rodadas de correção
    const exhaustFixture = setupConvergenceFixture({
      maxReworkRounds: 2,
      makerActions: [
        {
          files: { 'src/hello.txt': 'ok 1\n' },
          result: { status: 'ready_for_verification' },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
        {
          files: { 'src/hello.txt': 'ok 2\n' },
          result: { status: 'ready_for_verification' },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
        {
          files: { 'src/hello.txt': 'ok 3\n' },
          result: { status: 'ready_for_verification' },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
      ],
      checkerActions: [
        {
          result: {
            format_version: 2,
            contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            input_revision: {
              tree: 'TRUE_TREE',
              digest: 'TRUE_DIGEST',
            },
            verdict: 'changes_requested',
            action_items: [
              {
                id: 'finding-1',
                severity: 'medium',
                category: 'patch',
                target_role: 'maker',
                location: 'src/hello.txt:1',
                // Achados distintos a cada rodada (o detector de estagnação normaliza números,
                // então textos que só mudam de dígito contam como o mesmo achado).
                problem: 'falta validação de entrada',
                evidence_refs: ['eval:E1'],
                required_action: 'validar a entrada',
              },
            ],
            deferred: [],
            rejected: [],
            evidence: [
              {
                criterion: 'R1',
                result_ref: 'eval:E1',
                input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            ],
            requested_action: 'rework',
            sources: ['eval:E1'],
            summary: 'r1 changes',
            handoff: {
              claims: [],
              unknowns: [],
              questions_for_owner: [],
              deltas: [],
              next_action: 'rework',
              notes: 'r1',
            },
          },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
        {
          result: {
            format_version: 2,
            contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            input_revision: {
              tree: 'TRUE_TREE',
              digest: 'TRUE_DIGEST',
            },
            verdict: 'changes_requested',
            action_items: [
              {
                id: 'finding-2',
                severity: 'medium',
                category: 'patch',
                target_role: 'maker',
                location: 'src/hello.txt:1',
                problem: 'mensagem de erro sem código de saída',
                evidence_refs: ['eval:E1'],
                required_action: 'devolver código de saída na mensagem',
              },
            ],
            deferred: [],
            rejected: [],
            evidence: [
              {
                criterion: 'R1',
                result_ref: 'eval:E1',
                input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            ],
            requested_action: 'rework',
            sources: ['eval:E1'],
            summary: 'r2 changes',
            handoff: {
              claims: [],
              unknowns: [],
              questions_for_owner: [],
              deltas: [],
              next_action: 'rework',
              notes: 'r2',
            },
          },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
        {
          result: {
            format_version: 2,
            contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            input_revision: {
              tree: 'TRUE_TREE',
              digest: 'TRUE_DIGEST',
            },
            verdict: 'changes_requested',
            action_items: [
              {
                id: 'finding-3',
                severity: 'medium',
                category: 'patch',
                target_role: 'maker',
                location: 'src/hello.txt:1',
                problem: 'ramo de saída sem prova que o cubra',
                evidence_refs: ['eval:E1'],
                required_action: 'cobrir o ramo com prova',
              },
            ],
            deferred: [],
            rejected: [],
            evidence: [
              {
                criterion: 'R1',
                result_ref: 'eval:E1',
                input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            ],
            requested_action: 'rework',
            sources: ['eval:E1'],
            summary: 'r3 changes',
            handoff: {
              claims: [],
              unknowns: [],
              questions_for_owner: [],
              deltas: [],
              next_action: 'rework',
              notes: 'r3',
            },
          },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
      ],
    })

    const exhaustRes = await runStory(exhaustFixture.deps, exhaustFixture.input)
    expect(exhaustRes.status).toBe('awaiting_operator')
    expect(exhaustRes.reason).toBe('rework_exhausted')

    const { events: exhaustEvents } = readJournal(path.join(exhaustFixture.missionDir, 'journal.jsonl'))
    const checkerReviews = exhaustEvents.filter((e) => e.kind === 'review_result')
    // Escada de um degrau: 2 rodadas reprovadas no degrau esgotam a escada (r1 + r2) antes do teto do contrato
    expect(checkerReviews.length).toBe(2)
  }, 120_000)

  // Critério 5: retomada reutiliza resultados duráveis e vincula aprovação à árvore verificada
  test('retomada_reutiliza_resultados_duraveis_e_vincula_a_arvore_verificada', async () => {
    // Configura execução onde rodada 1 pede rework, rodada 2 é aprovada
    const fixture = setupConvergenceFixture({
      maxReworkRounds: 2,
      makerActions: [
        {
          files: { 'src/hello.txt': 'ok 1\n' },
          result: { status: 'ready_for_verification' },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
        {
          files: { 'src/hello.txt': 'ok final\n' },
          result: { status: 'ready_for_verification' },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
      ],
      checkerActions: [
        {
          result: {
            format_version: 2,
            contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            input_revision: {
              tree: 'AUTO_TREE',
              digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
            },
            verdict: 'changes_requested',
            action_items: [
              {
                id: 'f1',
                severity: 'medium',
                category: 'patch',
                target_role: 'maker',
                location: 'src/hello.txt:1',
                problem: 'falta palavra final',
                evidence_refs: ['eval:E1'],
                required_action: 'inserir palavra final',
              },
            ],
            deferred: [],
            rejected: [],
            evidence: [
              {
                criterion: 'R1',
                result_ref: 'eval:E1',
                input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            ],
            requested_action: 'rework',
            sources: ['eval:E1'],
            summary: 'ajuste simples pedido',
            handoff: {
              claims: [],
              unknowns: [],
              questions_for_owner: [],
              deltas: [],
              next_action: 'rework',
              notes: 'rework',
            },
          },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
        {
          result: {
            format_version: 2,
            contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            input_revision: {
              tree: 'AUTO_TREE',
              digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
            },
            verdict: 'approved',
            action_items: [],
            deferred: [],
            rejected: [],
            evidence: [
              {
                criterion: 'R1',
                result_ref: 'eval:E1',
                input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            ],
            requested_action: 'verify',
            sources: ['eval:E1'],
            summary: 'aprovado formalmente',
            handoff: {
              claims: [],
              unknowns: [],
              questions_for_owner: [],
              deltas: [{ kind: 'changed', ref: 'file:src/hello.txt#L1-L1' }],
              next_action: 'verify',
              notes: 'approved',
            },
          },
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
      ],
    })

    const res = await runStory(fixture.deps, fixture.input)
    expect(res.status).toBe('delivered')
    expect(res.exitCode).toBe(0)
    expect(res.commit).toBeTruthy()

    // O commit é vinculado à árvore aprovada
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const checkerSteps = events.filter(
      (e) => e.kind === 'step_result' && typeof e.step_id === 'string' && e.step_id.includes(':checker'),
    )
    expect(checkerSteps.length).toBe(2)
  }, 120_000) // retomada com CLIs falsas; sob carga passava dos 45 s (26/09)

  // O Checker real lê o prompt pela entrada padrão (`codex exec -`): o adapter tem de entregar
  // ao worker exatamente o conteúdo do pack, e recusar o despacho quando não há o que revisar.
  test('adapter_codex_entrega_o_pack_pela_entrada_padrao', async () => {
    const dir = makeTmpDir('ade-codex-stdin-')
    const packPath = path.join(dir, 'pack.md')
    const packText = '# pack de revisão\nconteúdo exato entregue ao Checker\n'
    fs.writeFileSync(packPath, packText, 'utf8')

    let seen: any = null
    const runWorkerImpl = async (opts: any) => {
      seen = opts
      return { stdout: '', exitCode: 0 }
    }
    const step = async (_spec: any, effect: any) => ({
      step_id: 'ADE-T1:r1:checker',
      status: 'ok',
      result: await effect(),
    })
    const base = {
      step,
      unit: 'ADE-T1',
      stepId: 'ADE-T1:r1:checker',
      packPath,
      missionDir: dir,
      missionId: 'mission-1',
      cwd: dir,
      resultFile: path.join(dir, 'checker-result.json'),
      resolved: { exe: process.execPath, prefixArgs: [] },
      runWorkerImpl,
    }

    const out = await dispatchCodex(base as any)

    expect(seen).not.toBeNull()
    expect(seen.stdinData).toBe(packText)
    expect(seen.args).toContain('exec')
    expect(seen.args).toContain('-')
    // Adapter de revisão: nunca devolve resultado de unidade
    expect(out.unit_result).toBeNull()

    // Sem pack o despacho falha fechado, em vez de mandar EOF ao Codex
    await expect(dispatchCodex({ ...base, packPath: undefined } as any)).rejects.toThrow(/pack/i)

    // Papel fora de revisão e de quem escreve não é suportado por este adapter
    await expect(dispatchCodex({ ...base, role: 'planner' } as any)).rejects.toThrow(
      /papel sem suporte/i,
    )

    removeTmpDir(dir)
  })
})

// ADR 0047: o revisor roda comandos numa cópia descartável da árvore revisada e prova o que acha; achado que bloqueia
// sem prova executável é rebaixado e não gasta rodada.
describe('Revisor com comandos numa cópia descartável', () => {
  const review = (items: any[], extraEvidence: any[] = []) => ({
    format_version: 2,
    contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    input_revision: { tree: 'AUTO_TREE', digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
    verdict: 'changes_requested',
    action_items: items,
    deferred: [],
    rejected: [],
    evidence: [
      { criterion: 'R1', result_ref: 'eval:E1', input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
      ...extraEvidence,
    ],
    requested_action: 'rework',
    sources: ['eval:E1'],
    summary: 'mudanças pedidas',
    handoff: { claims: [], unknowns: [], questions_for_owner: [], deltas: [], next_action: 'rework', notes: 'x' },
  })
  const finding = (id: string, severity: string, refs: string[]) => ({
    id, severity, category: 'patch', target_role: 'maker', location: 'src/hello.txt:1', problem: 'saudação errada', evidence_refs: refs, required_action: 'corrigir a saudação',
  })

  test('revisor_roda_na_copia_e_achado_sem_prova_e_rebaixado_sem_gastar_rodada', async () => {
    const fixture = setupConvergenceFixture({
      rawChecker: true,
      checkerActions: [{ result: review([finding('F1', 'high', ['eval:E1'])]), stdout: JSON.stringify({ total_cost_usd: 0.01 }) }],
    })
    const seen: any[] = []
    const dispatch = fixture.deps.dispatchCodex
    fixture.deps.dispatchCodex = async (opts: any) => {
      seen.push({ cwd: opts.cwd, scratch: opts.scratch, sandbox: opts.sandbox, hello: fs.readFileSync(path.join(opts.cwd, 'src/hello.txt'), 'utf8') })
      return dispatch(opts)
    }
    const res = await runStory(fixture.deps, fixture.input)
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    const worktree = events.map((e: any) => e.data?.worktree_dir).find(Boolean)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ scratch: true, sandbox: 'workspace-write', hello: 'ok\n' })
    expect(path.resolve(seen[0].cwd)).not.toBe(path.resolve(worktree))
    // a cópia some no fim
    expect(fs.existsSync(seen[0].cwd)).toBe(false)
    const demoted = events.find((e: any) => e.kind === 'decision' && e.data?.decision === 'finding_demoted_no_evidence')
    expect(demoted?.data).toMatchObject({ findings: [{ id: 'F1', severity: 'high' }], next: 'deliver' })
    expect(res.status).toBe('delivered')
  }, 60000)

  test('achado_com_prova_executavel_volta_ao_maker_com_o_comando_e_a_saida', async () => {
    const proofRef = 'artifact:.ade-review/F1.json'
    const fixture = setupConvergenceFixture({
      rawChecker: true,
      makerActions: [1, 2].map((i) => ({ files: { 'src/hello.txt': `ok ${i}\n` }, result: { status: 'ready_for_verification' }, stdout: JSON.stringify({ total_cost_usd: 0.01 }) })),
      checkerActions: [
        {
          files: { '.ade-review/F1.json': JSON.stringify({ argv: ['node', 'tests/check.mjs'], exit_code: 1, output: 'numFailedTests: 1' }) },
          result: review([finding('F1', 'critical', [proofRef])], [{ criterion: 'R1', result_ref: proofRef, input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }]),
          stdout: JSON.stringify({ total_cost_usd: 0.01 }),
        },
        { result: { ...review([]), verdict: 'approved', requested_action: 'verify', handoff: { ...review([]).handoff, next_action: 'verify' } }, stdout: JSON.stringify({ total_cost_usd: 0.01 }) },
      ],
    })
    const res = await runStory(fixture.deps, fixture.input)
    const { events } = readJournal(path.join(fixture.missionDir, 'journal.jsonl'))
    expect(res.status).toBe('delivered')
    expect(events.some((e: any) => e.kind === 'decision' && e.data?.decision === 'finding_demoted_no_evidence')).toBe(false)
    expect(fs.existsSync(path.join(fixture.missionDir, 'review-proofs', 'r1', 'F1.json'))).toBe(true)
    const texts = fs.readdirSync(fixture.missionDir, { recursive: true }).map(String).map((p) => path.join(fixture.missionDir, p))
      .filter((p) => fs.statSync(p).isFile()).map((p) => fs.readFileSync(p, 'utf8'))
    expect(texts.some((t) => t.includes('`node tests/check.mjs` saiu 1') && t.includes('numFailedTests: 1'))).toBe(true)
  }, 60000)
})
