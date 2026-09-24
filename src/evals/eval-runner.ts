import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { AdeError } from '../journal/errors.ts'
import { runContained } from '../gates/command.ts'
import { EXTRACT_CAPS, safeId, writeRawArtifact } from '../gates/output.ts'
import { classifyGreen, classifyRed, parseReporterJson, parseRunnerSummary } from './classify.ts'
import { validateScenarioStrictness } from './strictness.ts'

interface EvalDef {
  id: string
  argv: string[]
  kind: string
  expect_exit: number
  timeout_s: number
  max_output_bytes: number
  strictness: { mode: 'must_fail_before' | 'additive' | 'mutate'} 
}

interface GitPort {
  worktreeDir: string
  worktreeTree: () => Promise<string>
}

interface EvalRecord {
  eval_id: string
  phase: string
  tree: string
  argv: string[]
  exit_code: number | null
  expect_exit: number
  num_total_tests: number | null
  red_reason: 'assertion' | 'missing_target' | 'compile_error' | 'environment' | null
  strictness_mode: string
  verdict: string
  warnings: string[]
  stdout_excerpt: string
  stderr_excerpt: string
  raw_ref: string | null
  duration_ms: number
}

const VALID_STRICTNESS_MODES = new Set(['must_fail_before', 'additive', 'mutate'])
/** Teto mínimo de uma prova: o do contrato vale só acima disso (a suíte inteira do projeto leva minutos). */
const EVAL_TIMEOUT_FLOOR_S = 600

/**
 * Corta o texto no teto de bytes do kind, mantendo o início e anexando a marca de corte
 * dentro do próprio teto; nunca parte caractere UTF-8 multi-byte.
 */
function capExcerpt(text: string, cap: number, rawRef: string): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= cap) {
    return text
  }
  // o número de bytes cortados nunca passa de buf.byteLength, então reservar a marca
  // com esse valor garante que a marca real cabe no espaço reservado
  const markerBytes = Buffer.byteLength(`
[...cortado: ${buf.byteLength} bytes em ${rawRef}]`, 'utf8')
  let end = Math.max(0, cap - markerBytes)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--
  }
  return `${buf.subarray(0, end).toString('utf8')}
[...cortado: ${buf.byteLength - end} bytes em ${rawRef}]`
}

/**
 * Teto de bytes do extrato do eval: o menor entre o teto do kind (8192 por padrão) e o
 * `max_output_bytes` do próprio eval.
 */
function excerptCap(evalDef: EvalDef): number {
  return Math.min(EXTRACT_CAPS[evalDef.kind] ?? 8192, evalDef.max_output_bytes)
}

/**
 * Valida se o comando inicial de eval é permitido (`node`, caminho absoluto `.exe` ou o binário node).
 */
function validateCmd0(cmd0: unknown): void {
  // 'node' literal, caminho absoluto `.exe`, ou o próprio binário (`process.execPath`), que no
  // Linux/macOS é `/…/bin/node` sem extensão. `win32.isAbsolute` aceita `C:\…` e `/…` em qualquer SO:
  // a regra de paridade vale igual nos dois (o CI Linux recusava os dois casos).
  const isValid =
    cmd0 === 'node' ||
    (typeof cmd0 === 'string' &&
      path.win32.isAbsolute(cmd0) &&
      (cmd0.toLowerCase().endsWith('.exe') || path.basename(cmd0) === 'node'))

  if (!isValid) {
    throw new TypeError('argv inválido: cmd[0] precisa ser node')
  }
}

/**
 * Valida os argumentos e todos os campos obrigatórios de EvalDef.
 */
function validateRunEvalOptions(options: any): void {
  if (!options || typeof options !== 'object') {
    throw new TypeError('opções de runEval precisam ser um objeto')
  }

  const { eval: evalDef, phase, tree, unit } = options

  if (typeof phase !== 'string' || (phase !== 'red' && phase !== 'green')) {
    throw new TypeError("phase precisa ser 'red' ou 'green'")
  }
  if (typeof tree !== 'string' || !tree.trim()) {
    throw new TypeError('tree precisa ser string não vazia')
  }
  if (typeof unit !== 'string' || !unit.trim()) {
    throw new TypeError('unit precisa ser string não vazia')
  }

  if (!evalDef || typeof evalDef !== 'object') {
    throw new TypeError('eval precisa ser um objeto')
  }
  if (typeof evalDef.id !== 'string' || !evalDef.id.trim()) {
    throw new TypeError('eval.id é obrigatório e precisa ser string não vazia')
  }
  if (
    !Array.isArray(evalDef.argv) ||
    evalDef.argv.length === 0 ||
    !evalDef.argv.every((a: any) => typeof a === 'string')
  ) {
    throw new TypeError('eval.argv é obrigatório e precisa ser array de strings não vazio')
  }
  validateCmd0(evalDef.argv[0])
  if (typeof evalDef.kind !== 'string' || !evalDef.kind.trim()) {
    throw new TypeError('eval.kind é obrigatório e precisa ser string não vazia')
  }
  if (typeof evalDef.expect_exit !== 'number' || !Number.isInteger(evalDef.expect_exit)) {
    throw new TypeError('eval.expect_exit é obrigatório e precisa ser um número inteiro')
  }
  if (typeof evalDef.timeout_s !== 'number' || evalDef.timeout_s <= 0) {
    throw new TypeError('eval.timeout_s é obrigatório e precisa ser número positivo')
  }
  if (!Number.isInteger(evalDef.max_output_bytes) || evalDef.max_output_bytes < 256) {
    throw new TypeError('eval.max_output_bytes precisa ser inteiro >= 256')
  }
  if (!evalDef.strictness || typeof evalDef.strictness !== 'object') {
    throw new TypeError('eval.strictness é obrigatório e precisa ser um objeto')
  }
  if (!VALID_STRICTNESS_MODES.has(evalDef.strictness.mode)) {
    throw new TypeError(
      `strictness.mode inválido: ${evalDef.strictness.mode}. Permitidos: must_fail_before, additive, mutate`
    )
  }

  const { scenario } = options
  if (scenario !== undefined) {
    if (!scenario || typeof scenario !== 'object') {
      throw new TypeError('scenario precisa ser um objeto quando informado')
    }
    if (typeof scenario.id !== 'string' || !scenario.id.trim()) {
      throw new TypeError('scenario.id é obrigatório e precisa ser string não vazia')
    }
    if (!Array.isArray(scenario.evals)) {
      throw new TypeError('scenario.evals é obrigatório e precisa ser array')
    }
  }
}

/**
 * Cenário efetivo do eval: o eval executado sempre pertence ao próprio cenário; sem cenário
 * informado, ele é o único eval do cenário (e um additive sozinho não tem companheiro).
 */
function effectiveScenario(evalDef: EvalDef, scenario: { id: string; evals: any[] } | undefined): { id: string; evals: any[] } {
  if (!scenario) {
    return { id: evalDef.id, evals: [evalDef] }
  }
  return {
    id: scenario.id,
    evals: scenario.evals.includes(evalDef) ? scenario.evals : [...scenario.evals, evalDef],
  }
}

/**
 * Constrói o objeto literal do EvalRecord com defaults obrigatórios mesclados.
 */
export function buildEvalRecord(base: Partial<EvalRecord> & { eval_id: string; phase: string; tree: string; argv: string[]; expect_exit: number; strictness_mode: string; verdict: string }): EvalRecord {
  if (!base || typeof base !== 'object') {
    throw new TypeError('base precisa ser um objeto')
  }
  return {
    eval_id: base.eval_id,
    phase: base.phase,
    tree: base.tree,
    argv: base.argv,
    exit_code: base.exit_code ?? null,
    expect_exit: base.expect_exit,
    num_total_tests: base.num_total_tests ?? null,
    red_reason: base.red_reason ?? null,
    strictness_mode: base.strictness_mode,
    verdict: base.verdict,
    warnings: base.warnings ?? [],
    stdout_excerpt: base.stdout_excerpt ?? '',
    stderr_excerpt: base.stderr_excerpt ?? '',
    raw_ref: base.raw_ref ?? null,
    duration_ms: base.duration_ms ?? 0,
  }
}

/**
 * Constrói o input durável de step para runEval.
 */
export function buildStepInput({ eval: evalDef, phase, tree, scenario }: { eval: EvalDef; phase: string; tree: string; scenario?: { id: string; evals: Array<{ kind?: string; strictness?: { mode?: string } }> } | null }): Record<string, any> {
  return {
    argv: evalDef.argv,
    phase,
    tree,
    expect_exit: evalDef.expect_exit,
    timeout_s: evalDef.timeout_s,
    max_output_bytes: evalDef.max_output_bytes,
    strictness_mode: evalDef.strictness.mode,
    scenario: scenario
      ? {
          id: scenario.id,
          evals: scenario.evals.map(({ kind, strictness }) => ({
            kind,
            mode: strictness?.mode,
          })),
        }
      : null,
  }
}

interface CreateEvalRunnerOptions {
  step: (spec: any, effectFn: () => Promise<any>) => Promise<any>
  missionDir: string
  gitPort: GitPort
}

interface RunEvalOptions {
  eval: EvalDef
  phase: 'red' | 'green'
  tree: string
  unit: string
  scenario?: { id: string; evals: any[]} 
}

/**
 * Cria o executor de evals duráveis.
 */
export function createEvalRunner({ step, missionDir, gitPort }: CreateEvalRunnerOptions): { runEval: (options: RunEvalOptions) => Promise<EvalRecord> } {
  if (typeof step !== 'function') {
    throw new TypeError('step precisa ser uma função')
  }
  if (!missionDir || typeof missionDir !== 'string') {
    throw new TypeError('missionDir precisa ser string')
  }
  if (
    !gitPort ||
    typeof gitPort !== 'object' ||
    typeof gitPort.worktreeDir !== 'string' ||
    typeof gitPort.worktreeTree !== 'function'
  ) {
    throw new TypeError('gitPort inválido')
  }

  /**
   * Executa o processo contido do eval, grava o artefato bruto e classifica a fase vermelha;
   * compartilhado entre as fases vermelha e verde, que só divergem na classificação final.
   */
  async function executeEval(evalDef: EvalDef, phase: 'red' | 'green', safeEvalId: string): Promise<{ contained: any; raw_ref: string; red_reason: 'assertion' | 'missing_target' | 'compile_error' | 'environment' | null; num_total_tests: number | null }> {
    const contained = await runContained({
      argv: evalDef.argv,
      cwd: gitPort.worktreeDir,
      // ponytail: piso fixo de 10 min; o compilador de intenção dava 30s à suíte inteira, que leva minutos, e a
      // prova morria por tempo nas duas fases. Medir a duração da suíte no preparo se o piso ficar curto.
      timeoutS: Math.max(evalDef.timeout_s, EVAL_TIMEOUT_FLOOR_S),
    })

    const artRef = `evals/${safeEvalId}/${phase}`
    writeRawArtifact({
      missionDir,
      ref: artRef,
      text: contained.stdout + '\n' + contained.stderr,
    })
    const raw_ref = `art:${artRef}`

    const report = parseReporterJson(contained.stdout) ?? parseRunnerSummary(`${contained.stdout}\n${contained.stderr}`)
    const { red_reason, num_total_tests } = classifyRed({
      exitCode: contained.exitCode,
      expectExit: evalDef.expect_exit,
      timedOut: contained.timedOut,
      stdout: contained.stdout,
      stderr: contained.stderr,
      report,
    })

    return { contained, raw_ref, red_reason, num_total_tests }
  }

  /**
   * Executa a avaliação do eval.
   */
  async function runEval(options: RunEvalOptions): Promise<EvalRecord> {
    validateRunEvalOptions(options)

    const { eval: evalDef, phase, tree, unit, scenario } = options
    const strictnessMode = evalDef.strictness.mode

    /** @param warning */
    const refuse = (warning: string) =>
      buildEvalRecord({
        eval_id: evalDef.id,
        phase,
        tree,
        argv: evalDef.argv,
        expect_exit: evalDef.expect_exit,
        strictness_mode: strictnessMode,
        verdict: 'refused',
        warnings: [warning],
      })

    // Mutate exige o Checker que comenta a guarda, que ainda não existe: recusado nas duas fases
    if (strictnessMode === 'mutate') {
      return refuse('strictness_mutate_not_supported')
    }

    const currentTree = await gitPort.worktreeTree()
    if (currentTree !== tree) {
      return refuse('worktree_tree_mismatch')
    }

    const safeEvalId = safeId(evalDef.id)
    const stepId = `eval:${safeEvalId}:${phase}:${tree}`

    // A fase verde roda pelo mesmo step eval_run mas não valida cenário nem tem atalho additive:
    // strictness é regra da fase vermelha, a prova verde vale para todo eval
    if (phase === 'green') {
      const stepOutput = await step(
        {
          unit,
          id: stepId,
          effect_class: 'eval_run',
          input: buildStepInput({ eval: evalDef, phase, tree, scenario }),
          // Queda no meio da prova é reconciliada restaurando esta árvore; sem ela a missão travava para sempre.
          intent_context: { tree_before: tree },
          worktree: gitPort.worktreeDir,
        },
        async () => {
          const { contained, raw_ref, red_reason, num_total_tests } = await executeEval(
            evalDef,
            phase,
            safeEvalId
          )
          const { verdict, warnings } = classifyGreen({ red_reason })
          const cap = excerptCap(evalDef)

          return buildEvalRecord({
            eval_id: evalDef.id,
            phase,
            tree,
            argv: evalDef.argv,
            exit_code: contained.exitCode,
            expect_exit: evalDef.expect_exit,
            num_total_tests,
            red_reason,
            strictness_mode: strictnessMode,
            verdict,
            warnings,
            stdout_excerpt: capExcerpt(contained.stdout, cap, raw_ref),
            stderr_excerpt: capExcerpt(contained.stderr, cap, raw_ref),
            raw_ref,
            duration_ms: contained.durationMs,
          })
        }
      )

      return buildEvalRecord(stepOutput.result)
    }

    if (strictnessMode === 'additive') {
      let verdict = 'additive_warning'
      let warnings = ['additive: mudança puramente aditiva, sem prova vermelha']

      const scenarioToCheck = effectiveScenario(evalDef, scenario)
      if (validateScenarioStrictness(scenarioToCheck).ok === false) {
        verdict = 'refused'
        warnings = ['additive sem eval negative ou mutate no mesmo cenário']
      }

      const record = buildEvalRecord({
        eval_id: evalDef.id,
        phase,
        tree,
        argv: evalDef.argv,
        expect_exit: evalDef.expect_exit,
        strictness_mode: strictnessMode,
        verdict,
        red_reason: null,
        warnings,
        exit_code: null,
        num_total_tests: null,
        raw_ref: null,
        duration_ms: 0,
      })

      const stepOutput = await step(
        {
          unit,
          id: stepId,
          effect_class: 'eval_run',
          input: buildStepInput({ eval: evalDef, phase, tree, scenario }),
          // Queda no meio da prova é reconciliada restaurando esta árvore; sem ela a missão travava para sempre.
          intent_context: { tree_before: tree },
          worktree: gitPort.worktreeDir,
        },
        async () => record
      )

      return buildEvalRecord(stepOutput.result)
    }

    // Para outros modos (ex: must_fail_before), um cenário com additive sem companheiro recusa antes de executar
    if (scenario) {
      const scenarioCheck = validateScenarioStrictness(effectiveScenario(evalDef, scenario))
      if (!scenarioCheck.ok) {
        return refuse(scenarioCheck.code as string)
      }
    }

    const stepOutput = await step(
      {
        unit,
        id: stepId,
        effect_class: 'eval_run',
        input: buildStepInput({ eval: evalDef, phase, tree, scenario }),
        intent_context: { tree_before: tree },
        worktree: gitPort.worktreeDir,
      },
      async () => {
        const { contained, raw_ref, red_reason, num_total_tests } = await executeEval(
          evalDef,
          phase,
          safeEvalId
        )

        
        let verdict: string
        
        const warnings: string[] = []

        if (red_reason === null && contained.exitCode === evalDef.expect_exit) {
          verdict = 'eval_born_green'
        } else if (red_reason === 'assertion') {
          verdict = 'red_valid'
        } else {
          verdict = 'downgraded_additive'
          warnings.push(`red_reason=${red_reason} rebaixado para additive`)
        }

        const cap = excerptCap(evalDef)

        return buildEvalRecord({
          eval_id: evalDef.id,
          phase,
          tree,
          argv: evalDef.argv,
          exit_code: contained.exitCode,
          expect_exit: evalDef.expect_exit,
          num_total_tests,
          red_reason,
          strictness_mode: strictnessMode,
          verdict,
          warnings,
          stdout_excerpt: capExcerpt(contained.stdout, cap, raw_ref),
          stderr_excerpt: capExcerpt(contained.stderr, cap, raw_ref),
          raw_ref,
          duration_ms: contained.durationMs,
        })
      }
    )

    return buildEvalRecord(stepOutput.result)
  }

  return { runEval }
}

/** Grupos da suíte de dogfood da v1, na ordem do relatório. */
export const DOGFOOD_GROUPS = ['tradutor', 'jornadas', 'visual', 'estritez', 'durabilidade']

const DOGFOOD_RUNS = 3

interface DogfoodTask {
  id: string
  grupo: 'tradutor' | 'jornadas' | 'visual' | 'estritez' | 'durabilidade'
  runs: 3
  argv: string[]
  timeout_s?: number
}

interface DogfoodResult {
  id: string
  grupo: string
  runs: Array<{ run: number; status: 'green' | 'red'; exit_code: number | null} >
  status: 'approved' | 'rejected'
  divergent_runs: number[]
  message: string
}

/**
 * Valida uma tarefa de dogfood; tarefa malformada é entrada inválida (exit 4).
 */
function assertDogfoodTask(task: any): DogfoodTask {
  const id = typeof task?.id === 'string' && task.id.trim() ? task.id : null
  if (!id) {
    throw new AdeError('dogfood_task_invalid', 'tarefa de dogfood sem id', 4)
  }
  if (!DOGFOOD_GROUPS.includes(task.grupo)) {
    throw new AdeError('dogfood_task_invalid', `tarefa ${id}: grupo inválido: ${task.grupo}`, 4)
  }
  if (task.runs !== DOGFOOD_RUNS) {
    throw new AdeError('dogfood_task_invalid', `tarefa ${id}: runs precisa ser ${DOGFOOD_RUNS}`, 4)
  }
  if (!Array.isArray(task.argv) || !task.argv.every((a: any) => typeof a === 'string')) {
    throw new AdeError('dogfood_task_invalid', `tarefa ${id}: argv precisa ser array de strings`, 4)
  }
  if (task.argv[0] !== 'node' || task.argv.length < 2) {
    throw new AdeError('dogfood_task_invalid', `tarefa ${id}: argv precisa ser node <script>`, 4)
  }
  return task
}

/**
 * Lê e valida o catálogo versionado da suíte: 20 a 50 tarefas, ids únicos, os cinco grupos.
 */
export function loadDogfoodCatalog(catalogPath: string): DogfoodTask[] {
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  } catch (err) {
    throw new AdeError('dogfood_catalog_invalid', `catálogo de dogfood ilegível: ${catalogPath}: ${err instanceof Error ? err.message : String(err)}`, 4)
  }
  
  const tasks: DogfoodTask[] = Array.isArray(doc?.tasks) ? doc.tasks.map(assertDogfoodTask) : []
  if (tasks.length < 20 || tasks.length > 50) {
    throw new AdeError('dogfood_catalog_invalid', `catálogo de dogfood precisa de 20 a 50 tarefas, tem ${tasks.length}`, 4)
  }
  if (new Set(tasks.map((t: DogfoodTask) => t.id)).size !== tasks.length) {
    throw new AdeError('dogfood_catalog_invalid', 'catálogo de dogfood com id repetido', 4)
  }
  const missing = DOGFOOD_GROUPS.filter((g) => !tasks.some((t: DogfoodTask) => t.grupo === g))
  if (missing.length > 0) {
    throw new AdeError('dogfood_catalog_invalid', `catálogo de dogfood sem o grupo: ${missing.join(', ')}`, 4)
  }
  return tasks
}

/**
 * Recusa remoto de entrega fora da pasta temporária do sistema ou que não seja repositório bare:
 * a suíte nunca entrega em repositório real.
 */
export function assertTempRemote(remote: unknown): string {
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep
  const resolved = typeof remote === 'string' ? path.resolve(remote) : ''
  const isLexicalInside =
    process.platform === 'win32'
      ? resolved.toLowerCase().startsWith(tmpRoot.toLowerCase())
      : resolved.startsWith(tmpRoot)
  if (!resolved || !isLexicalInside || !fs.existsSync(resolved)) {
    throw new AdeError('dogfood_remote_invalid', `remoto de dogfood precisa ser repositório bare existente em ${tmpRoot}: ${String(remote)}`, 4)
  }

  let realResolved
  let realTmpRoot
  try {
    realResolved = fs.realpathSync(resolved)
    realTmpRoot = fs.realpathSync(os.tmpdir())
  } catch {
    throw new AdeError('dogfood_remote_invalid', `remoto de dogfood precisa ser repositório bare existente em ${tmpRoot}: ${String(remote)}`, 4)
  }

  const realTmpPrefix = realTmpRoot.endsWith(path.sep) ? realTmpRoot : realTmpRoot + path.sep
  const isRealInside =
    process.platform === 'win32'
      ? realResolved.toLowerCase().startsWith(realTmpPrefix.toLowerCase())
      : realResolved.startsWith(realTmpPrefix)
  if (!isRealInside) {
    throw new AdeError('dogfood_remote_invalid', `remoto de dogfood precisa ser repositório bare existente em ${realTmpPrefix}: ${String(remote)}`, 4)
  }

  let isBare = false
  try {
    const out = execFileSync('git', ['--git-dir', realResolved, 'rev-parse', '--is-bare-repository'], {
      encoding: 'utf8',
      maxBuffer: 1 << 20,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    isBare = out === 'true'
  } catch {
    isBare = false
  }

  if (!isBare) {
    throw new AdeError('dogfood_remote_invalid', `remoto de dogfood precisa ser repositório Git bare existente em ${realTmpPrefix}: ${String(remote)}`, 4)
  }

  return realResolved
}

/**
 * Executa a tarefa três vezes; aprovada só quando as três passam. A execução divergente é a
 * minoria quando o resultado se divide.
 */
export async function runDogfoodTask(task: DogfoodTask, { cwd, remote }: { cwd: string; remote: string }): Promise<DogfoodResult> {
  assertDogfoodTask(task)
  const remoteDir = assertTempRemote(remote)

  
  const runs: DogfoodResult['runs'] = []
  for (let run = 1; run <= DOGFOOD_RUNS; run++) {
    const contained = await runContained({
      argv: task.argv,
      cwd,
      timeoutS: task.timeout_s ?? 60,
      // git só fala o transporte file: nenhuma entrega sai da máquina
      env: { ADE_DOGFOOD_RUN: String(run), ADE_DOGFOOD_REMOTE: remoteDir, GIT_ALLOW_PROTOCOL: 'file' },
    })
    runs.push({ run, status: contained.exitCode === 0 ? 'green' : 'red', exit_code: contained.exitCode })
  }

  const green = runs.filter((r) => r.status === 'green').length
  const minority = green * 2 > DOGFOOD_RUNS ? 'red' : 'green'
  const divergent_runs = green === 0 || green === DOGFOOD_RUNS ? [] : runs.filter((r) => r.status === minority).map((r) => r.run)
  const status = green === DOGFOOD_RUNS ? 'approved' : 'rejected'
  const message =
    status === 'approved'
      ? `APROVADA ${task.id} (grupo ${task.grupo}): verde 3/3`
      : divergent_runs.length > 0
        ? `REPROVADA ${task.id} (grupo ${task.grupo}): instável, verde ${green}/3, execução ${divergent_runs.join(', ')} divergiu`
        : `REPROVADA ${task.id} (grupo ${task.grupo}): vermelha nas 3 execuções`

  return { id: task.id, grupo: task.grupo, runs, status, divergent_runs, message }
}

/**
 * Roda a suíte inteira; aprovada só quando todas as tarefas são aprovadas.
 */
export async function runDogfoodSuite(tasks: DogfoodTask[], options: { cwd: string; remote: string }): Promise<{ approved: boolean; results: DogfoodResult[]; report: string }> {
  tasks.forEach(assertDogfoodTask)
  assertTempRemote(options?.remote)
  
  const results: DogfoodResult[] = []
  for (const task of tasks) {
    results.push(await runDogfoodTask(task, options))
  }
  return {
    approved: results.every((r) => r.status === 'approved'),
    results,
    report: results.map((r) => r.message).join('\n'),
  }
}
