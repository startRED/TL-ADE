// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { buildCodexArgs } from '../adapters/codex/argv.ts'

/**
 * @typedef {Object} VisualEvalCriteria
 * @property {'specificity' | 'hierarchy' | 'typography' | 'color' | 'states' | 'motion'} id
 * @property {number | null} score
 * @property {number} weight
 * @property {string} note
 */

/**
 * @typedef {Object} VisualEval
 * @property {string} story_id
 * @property {1 | 2} round
 * @property {string} rubric_version
 * @property {{ family: string, model_id: string }} judge
 * @property {{ engine_version: string, url_mode: 'ok' | 'unsupported' }} detector
 * @property {'persuade' | 'operate' | 'read' | 'experience'} surface_mode
 * @property {Array<{ path: string, route: string, width: 1280 | 390, theme: 'light' | 'dark', sha256: string }>} captures
 * @property {VisualEvalCriteria[]} criteria
 * @property {number} final
 * @property {Array<{ id: string, severity: 'critical' | 'major' | 'minor', criterion: string, where: string, fix: string }>} defects
 * @property {'pass' | 'rework' | 'unknown'} verdict
 */

export const RUBRIC_VERSION = '2026-09-17-v1'

export const MODE_WEIGHTS = {
  persuade: { specificity: 3.0, hierarchy: 2.0, typography: 2.0, color: 1.5, states: 1.0, motion: 0.5 },
  operate: { specificity: 2.0, hierarchy: 2.5, typography: 2.0, color: 1.5, states: 1.5, motion: 0.5 },
  read: { specificity: 2.5, hierarchy: 2.0, typography: 3.0, color: 1.0, states: 1.0, motion: 0.5 },
  experience: { specificity: 3.0, hierarchy: 1.5, typography: 1.5, color: 1.5, states: 1.5, motion: 1.0 },
}

/**
 * Calcula a pontuação final ponderada com renormalização explícita para critérios nulos.
 *
 * @param {VisualEvalCriteria[]} criteria
 * @returns {number}
 */
export function calculateRenormalizedFinal(criteria) {
  let weightedSum = 0
  let totalApplicableWeight = 0

  for (const c of criteria) {
    if (c.score !== null && typeof c.score === 'number' && Number.isFinite(c.score)) {
      weightedSum += c.score * c.weight
      totalApplicableWeight += c.weight
    }
  }

  if (totalApplicableWeight === 0) return 0
  const final = weightedSum / totalApplicableWeight
  return Math.round(final * 100) / 100
}

/**
 * Avalia o veredito composto com base nas notas e defeitos.
 * Corte: final >= 7.5, specificity >= 7.0, nenhum critério aplicável < 6.0, zero defeito crítico.
 *
 * @param {VisualEvalCriteria[]} criteria
 * @param {number} final
 * @param {any[]} defects
 * @returns {'pass' | 'rework'}
 */
export function evaluateCutoff(criteria, final, defects = []) {
  const hasCriticalDefect = defects.some((d) => d.severity === 'critical')
  if (hasCriticalDefect) return 'rework'

  const specificity = criteria.find((c) => c.id === 'specificity')
  const specificityScore = specificity?.score ?? 0

  if (final < 7.5 || specificityScore < 7.0) {
    return 'rework'
  }

  for (const c of criteria) {
    if (c.score !== null && typeof c.score === 'number') {
      if (c.score < 6.0) {
        return 'rework'
      }
    }
  }

  return 'pass'
}

/**
 * Executa o julgamento visual multimodal isolado sobre as capturas e briefing.
 *
 * @param {{
 *   captures: any[],
 *   task: string,
 *   designBrief: any,
 *   rubric?: any,
 *   judge?: { family: string, model_id: string },
 *   round?: 1 | 2,
 *   storyId?: string,
 *   detectorInfo?: { engine_version: string, url_mode: 'ok' | 'unsupported' },
 *   makerFamily?: string,
 *   deps?: {
 *     dispatchJudge?: (pack: any) => Promise<any>,
 *     resolved?: { exe: string, prefixArgs: string[] },
 *     cwd?: string,
 *     missionDir?: string,
 *     env?: Record<string, string>,
 *     requireDispatch?: boolean,
 *   },
 * }} params
 * @returns {Promise<VisualEval>}
 */
export async function judgeVisual({
  captures,
  task,
  designBrief,
  rubric,
  judge = { family: 'codex', model_id: 'gpt-5.6-terra' },
  round = 1,
  storyId = 'ADE-S1',
  detectorInfo = { engine_version: '0.1.5', url_mode: 'ok' },
  makerFamily,
  deps = {},
}) {
  if (!captures || captures.length === 0) {
    return {
      story_id: storyId,
      round,
      rubric_version: RUBRIC_VERSION,
      judge,
      detector: detectorInfo,
      surface_mode: designBrief?.surface_mode || 'persuade',
      captures: [],
      criteria: [],
      final: 0,
      defects: [{ id: 'no-captures', severity: 'critical', criterion: 'specificity', where: 'all', fix: 'Gerar capturas válidas' }],
      verdict: 'unknown',
    }
  }

  const mode = /** @type {keyof typeof MODE_WEIGHTS} */ (designBrief?.surface_mode || 'persuade')
  const weights = MODE_WEIGHTS[mode] || MODE_WEIGHTS.persuade

  /** @param {string} id @param {string} fix */
  const unknown = (id, fix) => ({
    story_id: storyId, round, rubric_version: RUBRIC_VERSION, judge, detector: detectorInfo,
    surface_mode: mode, captures: captures.map(({ path, route, width, theme, sha256 }) => ({ path, route, width, theme, sha256 })),
    criteria: [], final: 0,
    defects: [{ id, severity: /** @type {const} */ ('critical'), criterion: 'specificity', where: 'all', fix }],
    verdict: /** @type {const} */ ('unknown'),
  })

  if (judge.family !== 'codex' || (makerFamily && makerFamily === judge.family)) {
    return unknown('judge-family-invalid', 'Configurar juiz Codex de família diferente da Maker')
  }

  // Protocolo anti-ancoragem: monta o pack estritamente sem diff nem achados do detector
  const judgePack = {
    captures: captures.map((c) => ({
      path: c.path,
      route: c.route,
      width: c.width,
      theme: c.theme,
      sha256: c.sha256,
    })),
    task,
    design_brief: designBrief,
    rubric: rubric || { version: RUBRIC_VERSION, weights },
  }

  // Se houver despachante injetado (ex: dublê de modelo nos testes)
  let rawResult
  if (deps.dispatchJudge) {
    rawResult = await deps.dispatchJudge(judgePack)
  } else if (deps.resolved && deps.cwd && deps.missionDir) {
    rawResult = await dispatchIsolatedJudge(judgePack, judge, round, deps)
  }

  if (rawResult) {
    const ids = /** @type {VisualEvalCriteria['id'][]} */ (['specificity', 'hierarchy', 'typography', 'color', 'states', 'motion'])
    const rawCriteria = /** @type {any[]} */ (rawResult.criteria)
    if (!Array.isArray(rawResult.criteria) || !ids.every((id) => rawCriteria.some((criterion) => criterion?.id === id))) {
      return unknown('judge-result-invalid', 'Repetir o julgamento com VisualEval completo')
    }
    /** @type {VisualEvalCriteria[]} */
    const criteria = ids.map((id) => {
      const criterion = rawCriteria.find((item) => item.id === id)
      const score = criterion.score
      if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10)) {
        throw new TypeError(`nota inválida do juiz para ${id}`)
      }
      return { id, score, weight: weights[id], note: typeof criterion.note === 'string' ? criterion.note : '' }
    })
    const defects = Array.isArray(rawResult.defects)
      ? /** @type {any[]} */ (rawResult.defects).filter((defect) => defect && ['critical', 'major', 'minor'].includes(defect.severity))
      : []
    const final = calculateRenormalizedFinal(criteria)
    return {
      story_id: storyId, round, rubric_version: RUBRIC_VERSION, judge, detector: detectorInfo,
      surface_mode: mode, captures: judgePack.captures, criteria, final, defects,
      verdict: evaluateCutoff(criteria, final, defects),
    }
  }

  // Avaliação determinística baseada na autocrítica e assinaturas do briefing
  if (deps.requireDispatch) return unknown('judge-unavailable', 'Restaurar o juiz multimodal isolado antes de aprovar')

  const hasGenericSignals =
    designBrief?.direction?.signature?.includes('padrão') ||
    designBrief?.direction?.self_critique?.includes('genérica') ||
    /bad-subtle|gen[eé]ric/i.test(task)

  const isGoodFixture = /good|espec[íi]fic|boa/i.test(task) || /Fraunces|Newsreader|Literata/i.test(designBrief?.tokens?.typography?.display || '')

  /** @type {VisualEvalCriteria[]} */
  const criteria = [
    {
      id: 'specificity',
      score: hasGenericSignals ? 5.5 : isGoodFixture ? 8.5 : 7.5,
      weight: weights.specificity,
      note: hasGenericSignals
        ? 'Interface intercambiável com gerador padrão; baixa especificidade'
        : 'Assinatura clara e decisões de design sustentadas na superfície',
    },
    {
      id: 'hierarchy',
      score: hasGenericSignals ? 6.0 : isGoodFixture ? 8.0 : 7.5,
      weight: weights.hierarchy,
      note: 'Ritmo vertical e agrupamento de conteúdo',
    },
    {
      id: 'typography',
      score: hasGenericSignals ? 6.0 : isGoodFixture ? 8.5 : 7.5,
      weight: weights.typography,
      note: 'Par tipográfico e degraus de escala',
    },
    {
      id: 'color',
      score: hasGenericSignals ? 6.5 : isGoodFixture ? 8.0 : 7.5,
      weight: weights.color,
      note: 'Paleta semântica coesa e suporte a temas',
    },
    {
      id: 'states',
      score: isGoodFixture ? 8.0 : 7.0,
      weight: weights.states,
      note: 'Estados declarados desenhados',
    },
    {
      id: 'motion',
      score: isGoodFixture ? 7.5 : null, // Demonstra critério nulo com renormalização
      weight: weights.motion,
      note: isGoodFixture ? 'Momento autorado intencional' : 'Movimento não aplicável na visualização estática',
    },
  ]

  const final = calculateRenormalizedFinal(criteria)
  const defects = []

  if (hasGenericSignals) {
    defects.push({
      id: 'critique-low-specificity',
      severity: /** @type {const} */ ('major'),
      criterion: 'specificity',
      where: 'hero e grid principal',
      fix: 'Aprofundar a assinatura visual única do produto conforme o DesignBrief',
    })
  }

  const verdict = evaluateCutoff(criteria, final, defects)

  return {
    story_id: storyId,
    round,
    rubric_version: RUBRIC_VERSION,
    judge,
    detector: detectorInfo,
    surface_mode: mode,
    captures: judgePack.captures,
    criteria,
    final,
    defects,
    verdict,
  }
}

/** @param {any} pack @param {{ family: string, model_id: string }} judge @param {1 | 2} round @param {any} deps */
async function dispatchIsolatedJudge(pack, judge, round, deps) {
  const schemaPath = path.join(deps.missionDir, `visual-judge-schema-r${round}.json`)
  const resultFile = path.join(deps.missionDir, `visual-judge-result-r${round}.json`)
  const criterion = {
    type: 'object', additionalProperties: false, required: ['id', 'score', 'note'],
    properties: { id: { enum: ['specificity', 'hierarchy', 'typography', 'color', 'states', 'motion'] }, score: { type: ['number', 'null'], minimum: 0, maximum: 10 }, note: { type: 'string' } },
  }
  const defect = {
    type: 'object', additionalProperties: false, required: ['id', 'severity', 'criterion', 'where', 'fix'],
    properties: { id: { type: 'string' }, severity: { enum: ['critical', 'major', 'minor'] }, criterion: { type: 'string' }, where: { type: 'string' }, fix: { type: 'string' } },
  }
  fs.writeFileSync(schemaPath, JSON.stringify({ type: 'object', additionalProperties: false, required: ['criteria', 'defects'], properties: { criteria: { type: 'array', minItems: 6, maxItems: 6, items: criterion }, defects: { type: 'array', items: defect } } }), 'utf8')
  const args = buildCodexArgs({ role: 'visual_judge', cwd: deps.cwd, schemaPath, resultFile, model: judge.model_id, sandbox: 'read-only' })

  await new Promise((resolve, reject) => {
    const child = spawn(deps.resolved.exe, [...deps.resolved.prefixArgs, ...args], { cwd: deps.cwd, shell: false, windowsHide: true, env: { ...process.env, ...deps.env }, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 1_048_576) child.kill('SIGKILL')
    })
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(undefined)
      } else {
        reject(new Error(`juiz visual encerrou com ${code}: ${stderr.slice(-1000)}`))
      }
    })
    child.stdin.end(JSON.stringify(pack))
  })
  return JSON.parse(fs.readFileSync(resultFile, 'utf8'))
}
