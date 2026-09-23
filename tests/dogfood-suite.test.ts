import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { main } from '../src/cli/index.js'
import {
  assertTempRemote,
  DOGFOOD_GROUPS,
  loadDogfoodCatalog,
  runDogfoodSuite,
  runDogfoodTask,
} from '../src/evals/eval-runner.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CATALOG = path.join(ROOT, 'fixtures/dogfood/catalog.json')
const FLAKY_TASK = path.join(ROOT, 'fixtures/dogfood/flaky-task.json')

function makeBare(parent: string): string {
  const bare = path.join(parent, 'remote.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { maxBuffer: 1 << 20 })
  return bare
}

function capture() {
  let out = ''
  let err = ''
  return {
    deps: { stdout: (s: string) => (out += s), stderr: (s: string) => (err += s) },
    out: () => out,
    err: () => err,
  }
}

describe('suíte de dogfood da v1', () => {
  let tmp: string
  let bare: string
  let suite: Awaited<ReturnType<typeof runDogfoodSuite>>

  beforeAll(async () => {
    tmp = makeTmpDir('ade-dogfood-')
    bare = makeBare(tmp)
    suite = await runDogfoodSuite(loadDogfoodCatalog(CATALOG), { cwd: ROOT, remote: bare })
  }, 300_000)

  afterAll(() => {
    removeTmpDir(tmp)
  })

  // C1: catálogo com 20 a 50 tarefas, cinco grupos representados, cada tarefa declara o grupo.
  test('catalogo_tem_20_a_50_tarefas_e_os_cinco_grupos', () => {
    const tasks = loadDogfoodCatalog(CATALOG)
    expect(tasks.length).toBeGreaterThanOrEqual(20)
    expect(tasks.length).toBeLessThanOrEqual(50)
    expect(DOGFOOD_GROUPS).toEqual(['tradutor', 'jornadas', 'visual', 'estritez', 'durabilidade'])
    expect(new Set(tasks.map((t) => t.grupo))).toEqual(new Set(DOGFOOD_GROUPS))
    for (const t of tasks) {
      expect(DOGFOOD_GROUPS).toContain(t.grupo)
      expect(t.runs).toBe(3)
    }

    // Borda: catálogo com 19 tarefas é recusado como entrada inválida
    const short = path.join(tmp, 'short.json')
    const raw = JSON.parse(readFileSync(CATALOG, 'utf8'))
    writeFileSync(short, JSON.stringify({ ...raw, tasks: raw.tasks.slice(0, 19) }))
    expect(() => loadDogfoodCatalog(short)).toThrow(expect.objectContaining({ exitCode: 4 }))

    // Borda: tarefa sem grupo válido é recusada
    const noGroup = path.join(tmp, 'no-group.json')
    const tasksNoGroup = raw.tasks.map((t: any, i: number) => (i === 0 ? { ...t, grupo: 'outro' } : t))
    writeFileSync(noGroup, JSON.stringify({ ...raw, tasks: tasksNoGroup }))
    expect(() => loadDogfoodCatalog(noGroup)).toThrow(/grupo/)
  })

  // C2: tarefa determinística e correta executada três vezes é aprovada com três execuções verdes.
  test('tarefa_deterministica_aprovada_com_tres_execucoes_verdes', () => {
    expect(suite.approved).toBe(true)
    expect(suite.results).toHaveLength(loadDogfoodCatalog(CATALOG).length)
    for (const r of suite.results) {
      expect(r.status).toBe('approved')
      expect(r.runs).toEqual([
        { run: 1, status: 'green', exit_code: 0 },
        { run: 2, status: 'green', exit_code: 0 },
        { run: 3, status: 'green', exit_code: 0 },
      ])
    }
  })

  // C3: tarefa verde em duas de três é reprovada e a saída diz o grupo e a execução divergente.
  test('tarefa_instavel_reprovada_com_grupo_e_execucao_divergente', async () => {
    const flaky = JSON.parse(readFileSync(FLAKY_TASK, 'utf8'))
    const result = await runDogfoodTask(flaky, { cwd: ROOT, remote: bare })

    expect(result.status).toBe('rejected')
    expect(result.runs.map((r) => r.status)).toEqual(['green', 'red', 'green'])
    expect(result.divergent_runs).toEqual([2])
    expect(result.message).toContain(`grupo ${flaky.grupo}`)
    expect(result.message).toContain('execução 2')

    const report = await runDogfoodSuite([flaky], { cwd: ROOT, remote: bare })
    expect(report.approved).toBe(false)
    expect(report.report).toContain(flaky.id)
    expect(report.report).toContain(`grupo ${flaky.grupo}`)
    expect(report.report).toContain('execução 2')
  })

  // C4: `ade eval <story>` roda só os evals do contrato daquela story e devolve cada resultado.
  test('ade_eval_roda_somente_os_evals_do_contrato_da_story', async () => {
    const planDir = path.join(tmp, 'plan-eval')
    const repo = path.join(tmp, 'repo-eval')
    mkdirSync(path.join(planDir, 'stories'), { recursive: true })
    mkdirSync(path.join(repo, 'checks'), { recursive: true })
    const plan = JSON.parse(readFileSync(path.join(ROOT, 'plans/dogfood/journal-event-field.plan.json'), 'utf8'))
    plan.phases = [{ epics: [{ stories: ['S1', 'S2'] }] }]
    writeFileSync(path.join(planDir, 'plan.json'), JSON.stringify(plan))
    const base = JSON.parse(readFileSync(path.join(ROOT, 'plans/dogfood/stories/ADE-D1.json'), 'utf8'))
    const evalOf = (script: string) => ({ ...base.evals[0], cmd: ['node', `checks/${script}`], evidence: [`checks/${script}`] })
    const story = (id: string, scripts: string[]) => ({
      ...base,
      id,
      guardrails: { ...base.guardrails, scope_paths: ['checks/**'] },
      scenarios: [{ ...base.scenarios[0], evals: scripts.map((_, i) => `E${i + 1}`) }],
      evals: scripts.map(evalOf),
    })
    writeFileSync(path.join(planDir, 'stories/S1.json'), JSON.stringify(story('S1', ['pass.mjs', 'fail.mjs'])))
    writeFileSync(path.join(planDir, 'stories/S2.json'), JSON.stringify(story('S2', ['marker.mjs'])))
    const summary = (ok: boolean) =>
      `process.stdout.write(JSON.stringify({numTotalTests:1,numPassedTests:${ok ? 1 : 0},numFailedTests:${ok ? 0 : 1}})+'\\n');process.exit(${ok ? 0 : 1})`
    writeFileSync(path.join(repo, 'checks/pass.mjs'), summary(true))
    writeFileSync(path.join(repo, 'checks/fail.mjs'), summary(false))
    writeFileSync(path.join(repo, 'checks/marker.mjs'), `import fs from 'node:fs';fs.writeFileSync('S2-ran','x');${summary(true)}`)

    const io = capture()
    const code = await main(['eval', 'S1', '--plan', path.join(planDir, 'plan.json'), '--repo', repo], io.deps)

    expect(JSON.parse(io.out())).toEqual({
      story: 'S1',
      resultados: [
        { eval_id: 'E1', phase: 'green', status: 'green' },
        { eval_id: 'E2', phase: 'green', status: 'green_failed' },
      ],
    })
    expect(code).toBe(1)
    expect(existsSync(path.join(repo, 'S2-ran'))).toBe(false)

    // Borda: story ausente do plano é entrada inválida
    const missing = capture()
    expect(await main(['eval', 'S9', '--plan', path.join(planDir, 'plan.json'), '--repo', repo], missing.deps)).toBe(4)
    expect(missing.err()).toContain('S9')
  })

  // C5: `ade eval` apontado para tarefa da suíte de dogfood é recusado como entrada inválida.
  test('ade_eval_recusa_tarefa_da_suite_de_dogfood', async () => {
    const [first] = loadDogfoodCatalog(CATALOG)
    const io = capture()
    const code = await main(['eval', first.id], io.deps)
    expect(code).toBe(4)
    expect(io.out()).toBe('')
    expect(io.err()).toContain('suíte de dogfood não é acessível por ade eval')

    const byPath = capture()
    expect(await main(['eval', 'x', '--plan', CATALOG], byPath.deps)).toBe(4)
    expect(byPath.err()).toContain('suíte de dogfood não é acessível por ade eval')
  })

  // C6: sem rede, sem binário real de modelo, entrega só em repositório bare temporário.
  test('suite_sem_rede_sem_modelo_real_e_entrega_em_bare_temporario', async () => {
    // As entregas das jornadas chegaram ao bare temporário
    const heads = execFileSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/dogfood'], {
      encoding: 'utf8',
      maxBuffer: 1 << 20,
    })
    expect(heads).toContain('refs/heads/dogfood/')

    // Remoto fora da pasta temporária do sistema é recusado antes de rodar qualquer tarefa
    const tasks = loadDogfoodCatalog(CATALOG)
    await expect(runDogfoodSuite(tasks, { cwd: ROOT, remote: path.join(ROOT, 'remote.git') })).rejects.toMatchObject({
      exitCode: 4,
    })
    expect(path.resolve(bare).startsWith(path.resolve(os.tmpdir()))).toBe(true)

    // Remoto que não é git bare (mesmo dentro de tmp) é recusado
    const notBare = path.join(tmp, 'not-bare')
    mkdirSync(notBare, { recursive: true })
    expect(() => assertTempRemote(notBare)).toThrow(expect.objectContaining({ exitCode: 4 }))

    // Symlink ou junction dentro de tmp apontando para fora é recusado
    const linkOutside = path.join(tmp, 'link-outside')
    try {
      symlinkSync(ROOT, linkOutside, 'junction')
      expect(() => assertTempRemote(linkOutside)).toThrow(expect.objectContaining({ exitCode: 4 }))
    } catch {
      // ambiente sem suporte a symlink/junction
    }

    // Toda tarefa roda `node` sobre script versionado da suíte, sem módulo de rede nem CLI real de modelo
    const scriptsDir = path.join(ROOT, 'fixtures/dogfood/checks')
    for (const t of tasks) {
      expect(t.argv[0]).toBe('node')
      expect(t.argv[1].startsWith('fixtures/dogfood/checks/')).toBe(true)
    }
    for (const file of readdirSync(scriptsDir)) {
      const src = readFileSync(path.join(scriptsDir, file), 'utf8')
      expect(src).not.toMatch(/node:(net|http|https|tls|dgram)|\bfetch\(|['"](claude|codex|gemini)['"]/)
    }
  })
})
