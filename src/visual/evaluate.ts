import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { captureVisualSurface } from './browser.ts'
import { runVisualGates } from './gates.ts'
import { judgeVisual } from './judge.ts'
import { createImpeccableDetector } from './impeccable.ts'
import { startServe } from './browser.ts'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Executa o ciclo completo do Frontend Quality Engine (FQE).
 */
export async function runFrontendQuality({
  story,
  tree,
  config = {},
  capabilities = {},
  round = 1,
  missionDir,
  deps = {},
}: {
        story: any
        tree: string
        config?: any
        capabilities?: any
        round?: number
        missionDir?: string
        deps?: {
            captureSurface?: typeof captureVisualSurface
            runGates?: typeof runVisualGates
            judge?: typeof judgeVisual
            page?: any
            browser?: any
            detector?: any
            startServe?: typeof startServe
            dispatchJudge?: (pack: any) => Promise<any>
            checkerResolved?: { exe: string; prefixArgs: string[] } | null
            agyResolved?: { exe: string; prefixArgs: string[] } | null
            // fila de juízes montada pelo motor (empresas com cota, a melhor primeiro)
            visualJudges?: Array<{ family: string; model_id: string; effort?: string | null; resolved?: { exe: string; prefixArgs: string[] } | null }>
            resolved?: { exe: string; prefixArgs: string[] }
            workerEnv?: Record<string, string>
        }
    }): Promise<{
    status: 'pass' | 'rework' | 'awaiting_operator'
    reason?: 'visual_degraded' | 'fqe_unavailable' | 'visual_cut_not_met'
    evaluation?: any
    defects?: any[]
    captures?: any[]
    gateResults?: any
}> {
  const contract = story?.contract ?? {}
  // (1) Histórias sem interface não passam pelo FQE e continuam no fluxo antigo sem custo
  if (!contract.needs_ui) {
    return { status: 'pass' }
  }

  if (!missionDir) {
    throw new TypeError('missionDir é obrigatório para runFrontendQuality')
  }

  const visualConfig = config.visual ?? {}
  if (visualConfig.enabled === false) {
    return { status: 'awaiting_operator', reason: 'fqe_unavailable' }
  }

  // (12) e (13): Verificação de ambiente e detector
  if (capabilities?.fqe_unavailable || capabilities?.impeccable?.engine_version_match === false) {
    return { status: 'awaiting_operator', reason: 'fqe_unavailable' }
  }

  const url = visualConfig.url || 'http://127.0.0.1:4173'
  const hasServe = Boolean(visualConfig.url || visualConfig.serve_command)
  if (!hasServe) {
    return { status: 'awaiting_operator', reason: 'visual_degraded' }
  }

  const captureFn = deps.captureSurface ?? captureVisualSurface
  const runGatesFn = deps.runGates ?? runVisualGates
  const judgeFn = deps.judge ?? judgeVisual

  const routes = visualConfig.routes || ['/']
  const widths = visualConfig.widths || [1280, 390]
  const themes = visualConfig.themes || ['light', 'dark']

  const detector =
    deps.detector ??
    createImpeccableDetector({
      engineVersion: visualConfig.impeccable?.engine_version,
      urlMode: capabilities?.impeccable?.url_mode || visualConfig.impeccable?.url_mode,
    })

  let serve = null
  // 1. Serve e captura com Playwright como biblioteca; cada página é inspecionada antes do contexto fechar.
  let captures = []
  try {
    // tela que precisa de build (o painel servido do dist) monta a versão da worktree antes de servir
    if (Array.isArray(visualConfig.build_command) && visualConfig.build_command.length > 0) {
      const [bin, ...args] = visualConfig.build_command
      await execFileAsync(bin, args, { cwd: story.worktreeDir || missionDir, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: (visualConfig.build_timeout_s || 300) * 1000 })
    }
    if (visualConfig.serve_command) {
      serve = await (deps.startServe ?? startServe)({
        command: visualConfig.serve_command,
        cwd: story.worktreeDir || missionDir,
        url,
        timeoutSeconds: visualConfig.ready_timeout_s || 30,
      })
    }
    captures = await captureFn({
      browser: deps.browser,
      url,
      routes,
      widths,
      themes,
      tree,
      missionDir,
      inspectPage: (evidence) => runGatesFn({ ...evidence, config, detector }),
    })
  } catch {
    return { status: 'awaiting_operator', reason: 'visual_degraded' }
  } finally {
    await serve?.stop()
  }

  if (!captures || captures.length === 0) {
    return { status: 'awaiting_operator', reason: 'visual_degraded' }
  }

  // Registra evidências duráveis em artifacts/visual/<tree>/
  const outDir = path.join(missionDir, 'artifacts', 'visual', tree)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, `captures-r${round}.json`), JSON.stringify(captures, null, 2), 'utf8')

  // Dublês antigos não executam inspectPage; no fluxo real toda captura traz sua inspeção.
  const inspected = captures.map((capture) => capture.inspection).filter(Boolean)
  const gateRuns = inspected.length > 0
    ? inspected
    : [await runGatesFn({ page: deps.page, route: typeof routes[0] === 'string' ? routes[0] : routes[0].path, width: widths[0], theme: themes[0], config, detector })]
  const gateRes = {
    ok: gateRuns.every((result) => result.ok),
    results: gateRuns.map((result) => result.results),
    artifacts: gateRuns.map((result) => result.artifacts),
    defects: gateRuns.flatMap((result) => result.defects || []),
  }

  fs.writeFileSync(path.join(outDir, `gates-r${round}.json`), JSON.stringify(gateRes, null, 2), 'utf8')

  // (5): Se portões determinísticos reprovam, o juiz NÃO é chamado. Quantas passadas cabem é o motor que decide.
  if (!gateRes.ok) {
    return {
      status: 'rework',
      defects: uniqueDefects(gateRes.defects || []),
      gateResults: gateRes.results,
      captures,
    }
  }

  // 3. Juiz multimodal (chamado somente após D1–D6 verdes)
  const designBrief = story.design_brief || config.design_briefs?.[story.id] || {}
  const judgeRole = visualConfig.judge || { family: 'codex', model_id: 'gpt-5.6-terra' }
  const binaryOf = (family: string) => (family === 'codex' ? deps.checkerResolved : family === 'agy' ? deps.agyResolved : deps.resolved) ?? null
  // juiz fixo na config manda; senão a fila do motor; sem fila, o Codex padrão
  const judges = visualConfig.judge
    ? [{ ...visualConfig.judge, resolved: binaryOf(visualConfig.judge.family) }]
    : deps.visualJudges?.length ? deps.visualJudges : [{ ...judgeRole, resolved: binaryOf(judgeRole.family) ?? deps.resolved ?? null }]

  let evaluation
  try {
    evaluation = await judgeFn({
    captures,
    task: contract.task || '',
    designBrief,
    judge: judgeRole,
    judges,
    // chegou ao juiz com os portões verdes: se o D3 rodou, o contraste já está medido
    contrastMeasured: (visualConfig.gates || ['D3']).includes('D3') && inspected.length > 0,
    round,
    storyId: story.id,
    detectorInfo: {
      engine_version: visualConfig.impeccable?.engine_version || '0.1.5',
      url_mode: capabilities?.impeccable?.url_mode || 'ok',
    },
    makerFamily: contract.roles?.maker?.family,
    deps: {
      dispatchJudge: deps.dispatchJudge,
      resolved: deps.checkerResolved ?? deps.resolved,
      cwd: story.worktreeDir || missionDir,
      missionDir,
      env: deps.workerEnv,
      requireDispatch: true,
    },
    })
  } catch {
    return { status: 'awaiting_operator', reason: 'fqe_unavailable', captures, gateResults: gateRes.results }
  }

  fs.writeFileSync(path.join(outDir, `eval-r${round}.json`), JSON.stringify(evaluation, null, 2), 'utf8')

  if (evaluation.verdict === 'pass') {
    return {
      status: 'pass',
      evaluation,
      captures,
      gateResults: gateRes.results,
    }
  }

  if (evaluation.verdict === 'unknown') {
    return {
      status: 'awaiting_operator',
      reason: 'visual_cut_not_met',
      evaluation,
      defects: evaluation.defects,
      captures,
      gateResults: gateRes.results,
    }
  }

  // Reprovado no juiz: envia defeitos em lote para rework
  return {
    status: 'rework',
    evaluation,
    defects: evaluation.defects,
    captures,
    gateResults: gateRes.results,
  }
}

/** O mesmo defeito aparece em cada largura e tema capturados; o maker recebe cada um uma vez. */
function uniqueDefects(defects: any[]): any[] {
  const seen = new Set<string>()
  return defects.filter((d) => {
    const key = `${d.id} ${String(d.where).replace(/ [d+px]/, '')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
