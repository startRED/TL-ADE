import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadPlan } from '../engine/plan-load.ts'
import { createEvalRunner, loadDogfoodCatalog } from '../evals/eval-runner.ts'
import { AdeError } from '../journal/errors.ts'

const DOGFOOD_DIR = path.resolve(fileURLToPath(new URL('../../fixtures/dogfood', import.meta.url)))

// O comando lê a árvore de trabalho como está: não há snapshot git a conferir.
const WORKING_TREE = 'working-tree'

function isInsideDogfoodDir(p: string | undefined): boolean {
  if (typeof p !== 'string') return false
  const abs = path.resolve(p)
  const rel = path.relative(DOGFOOD_DIR, abs)
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * A suíte de dogfood roda só no comando de provas do repositório; `ade eval` recusa
 * tanto o id de uma tarefa do catálogo quanto qualquer caminho dentro da pasta da suíte.
 */
function refuseDogfoodTarget(target: string, plan: string | undefined): void {
  const insideSuite = [target, plan].some(isInsideDogfoodDir)
  const ids = loadDogfoodCatalog(path.join(DOGFOOD_DIR, 'catalog.json')).map((t) => t.id)
  if (insideSuite || ids.includes(target)) {
    throw new AdeError(
      'dogfood_target_refused',
      `alvo recusado: ${target}: a suíte de dogfood não é acessível por ade eval; ela roda só no comando de provas do repositório`,
      4,
    )
  }
}

/**
 * Ponto de entrada do comando `ade eval <story>`: roda, sobre a árvore de trabalho, só os evals
 * declarados no contrato da story.
 */
export async function main(argv: string[], deps: {
    stdout?: { write: (s: string) => void } | ((s: string) => void)
    stderr?: { write: (s: string) => void } | ((s: string) => void);
    [key: string]: any
} = {}): Promise<number> {
  const stdout =
    typeof deps.stdout === 'function'
      ? { write: deps.stdout }
      : (deps.stdout ?? process.stdout)
  const stderr =
    typeof deps.stderr === 'function'
      ? { write: deps.stderr }
      : (deps.stderr ?? process.stderr)

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      plan: { type: 'string' },
      repo: { type: 'string' },
    },
  })

  const [storyId] = positionals
  if (positionals.length !== 1) {
    stderr.write('uso: ade eval <story> --plan <arquivo> [--repo <pasta>]\n')
    return 4
  }
  refuseDogfoodTarget(storyId, values.plan)
  if (!values.plan) {
    stderr.write('uso: ade eval <story> --plan <arquivo> [--repo <pasta>]\n')
    return 4
  }

  const story = loadPlan(values.plan, { mode: 'read' }).stories.find((s) => s.id === storyId)
  if (!story) {
    throw new AdeError('story_not_found', `story ${storyId} não está no plano ${values.plan}`, 4)
  }
  // Os evals crus do contrato: a normalização do plano só converte `cmd` em `argv` para a classe script
  
  const rawEvals: any[] = story.contract.evals?.length > 0 ? story.contract.evals : (story.contract.verifiers ?? [])

  const missionDir = mkdtempSync(path.join(os.tmpdir(), 'ade-eval-'))
  try {
    const { runEval } = createEvalRunner({
      step: async (_spec, effectFn) => ({ result: await effectFn() }),
      missionDir,
      gitPort: {
        worktreeDir: path.resolve(values.repo ?? process.cwd()),
        worktreeTree: async () => WORKING_TREE,
      },
    })

    const resultados = []
    for (const [idx, raw] of rawEvals.entries()) {
      const record = await runEval({
        eval: { ...raw, id: raw.id ?? `E${idx + 1}`, argv: raw.argv ?? raw.cmd },
        phase: 'green',
        tree: WORKING_TREE,
        unit: storyId,
      })
      resultados.push({ eval_id: record.eval_id, phase: record.phase, status: record.verdict })
    }

    stdout.write(JSON.stringify({ story: storyId, resultados }) + '\n')
    return resultados.every((r) => r.status === 'green') ? 0 : 1
  } finally {
    rmSync(missionDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
