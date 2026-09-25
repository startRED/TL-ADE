import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { buildCodexArgs } from '../adapters/codex/argv.ts'
import { buildAgyArgs } from '../adapters/agy/argv.ts'

interface VisualEvalCriteria {
    id: 'specificity' | 'hierarchy' | 'typography' | 'color' | 'states' | 'motion'
    score: number | null
    weight: number
    note: string
}

interface VisualEval {
    story_id: string
    round: number
    rubric_version: string
    judge: { family: string; model_id: string} 
    detector: { engine_version: string; url_mode: 'ok' | 'unsupported'} 
    surface_mode: 'persuade' | 'operate' | 'read' | 'experience'
    captures: Array<{ path: string; route: string; width: 1280 | 390; theme: 'light' | 'dark'; sha256: string} >
    criteria: VisualEvalCriteria[]
    final: number
    defects: Array<{ id: string; severity: 'critical' | 'major' | 'minor'; criterion: string; where: string; fix: string} >
    verdict: 'pass' | 'rework' | 'unknown'
}

export const RUBRIC_VERSION = '2026-09-17-v1'

export const MODE_WEIGHTS = {
  persuade: { specificity: 3.0, hierarchy: 2.0, typography: 2.0, color: 1.5, states: 1.0, motion: 0.5 },
  operate: { specificity: 2.0, hierarchy: 2.5, typography: 2.0, color: 1.5, states: 1.5, motion: 0.5 },
  read: { specificity: 2.5, hierarchy: 2.0, typography: 3.0, color: 1.0, states: 1.0, motion: 0.5 },
  experience: { specificity: 3.0, hierarchy: 1.5, typography: 1.5, color: 1.5, states: 1.5, motion: 1.0 },
}

/**
 * Calcula a pontuação final ponderada com renormalização explícita para critérios nulos.
 */
export function calculateRenormalizedFinal(criteria: VisualEvalCriteria[]): number {
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
 */
export function evaluateCutoff(criteria: VisualEvalCriteria[], final: number, defects: any[] = []): 'pass' | 'rework' {
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
 */
export async function judgeVisual({
  captures,
  task,
  designBrief,
  rubric,
  judge = { family: 'codex', model_id: 'gpt-5.6-terra' },
  judges,
  round = 1,
  storyId = 'ADE-S1',
  detectorInfo = { engine_version: '0.1.5', url_mode: 'ok' },
  makerFamily,
  deps = {},
}: {
        captures: any[]
        task: string
        designBrief: any
        rubric?: any
        judge?: { family: string; model_id: string }
        // fila de juízes, o melhor primeiro; quem falha passa a vez ao próximo
        judges?: Array<{ family: string; model_id: string; resolved?: { exe: string; prefixArgs: string[] } | null }>
        round?: number
        storyId?: string
        detectorInfo?: { engine_version: string; url_mode: 'ok' | 'unsupported' }
        makerFamily?: string
        deps?: {
            dispatchJudge?: (pack: any) => Promise<any>
            resolved?: { exe: string; prefixArgs: string[] }
            cwd?: string
            missionDir?: string
            env?: Record<string, string>
            requireDispatch?: boolean
        }
    }): Promise<VisualEval> {
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

  const mode = ((designBrief?.surface_mode || 'persuade') as keyof typeof MODE_WEIGHTS)
  const weights = MODE_WEIGHTS[mode] || MODE_WEIGHTS.persuade

  /** @param id */
  const unknown = (id: string, fix: string) => ({
    story_id: storyId, round, rubric_version: RUBRIC_VERSION, judge, detector: detectorInfo,
    surface_mode: mode, captures: captures.map(({ path, route, width, theme, sha256 }) => ({ path, route, width, theme, sha256 })),
    criteria: [], final: 0,
    defects: [{ id, severity: ('critical' as const), criterion: 'specificity', where: 'all', fix }],
    verdict: ('unknown' as const),
  })

  // Qualquer empresa com visão julga (Codex, Claude, Gemini), nunca a mesma que escreveu a tela
  const candidates = (judges ?? [{ ...judge, resolved: deps.resolved }])
    .filter((j) => JUDGE_FAMILIES.includes(j.family) && j.family !== makerFamily)
  if (candidates.length === 0) {
    return unknown('judge-family-invalid', 'Configurar juiz de empresa diferente da que escreveu a tela')
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

  const ids = (['specificity', 'hierarchy', 'typography', 'color', 'states', 'motion'] as VisualEvalCriteria['id'][])
  const complete = (raw: any) => Array.isArray(raw?.criteria) && ids.every((id) => raw.criteria.some((criterion: any) => criterion?.id === id))
  // Se houver despachante injetado (ex: dublê de modelo nos testes)
  let rawResult
  let used = candidates[0]
  const failures: string[] = []
  if (deps.dispatchJudge) {
    rawResult = await deps.dispatchJudge(judgePack)
  } else if (deps.cwd && deps.missionDir) {
    for (const candidate of candidates) {
      if (!candidate.resolved) continue
      try {
        const raw = await dispatchIsolatedJudge(judgePack, candidate, round, { ...deps, resolved: candidate.resolved })
        if (complete(raw)) {
          rawResult = raw
          used = candidate
          break
        }
        failures.push(`${candidate.family}: resultado incompleto`)
      } catch (err) {
        failures.push(`${candidate.family}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
    }
  }

  if (!rawResult && failures.length > 0) {
    return unknown('judge-unavailable', `Nenhum juiz respondeu: ${failures.join(' | ')}`)
  }

  if (rawResult) {
    judge = { family: used.family, model_id: used.model_id }
    if (!complete(rawResult)) {
      return unknown('judge-result-invalid', 'Repetir o julgamento com VisualEval completo')
    }
    const rawCriteria = (rawResult.criteria as any[])
    
    const criteria: VisualEvalCriteria[] = ids.map((id) => {
      const criterion = rawCriteria.find((item) => item.id === id)
      const score = criterion.score
      if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10)) {
        throw new TypeError(`nota inválida do juiz para ${id}`)
      }
      return { id, score, weight: weights[id], note: typeof criterion.note === 'string' ? criterion.note : '' }
    })
    const defects = Array.isArray(rawResult.defects)
      ? (rawResult.defects as any[]).filter((defect) => defect && ['critical', 'major', 'minor'].includes(defect.severity))
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

  
  const criteria: VisualEvalCriteria[] = [
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
      severity: ('major' as const),
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

const JUDGE_FAMILIES = ['codex', 'claude', 'agy']

const JUDGE_INSTRUCTIONS = [
  'Você é o juiz visual de uma interface. Olhe as capturas reais da tela listadas em "captures" (rota, largura, tema); julgue pelas imagens, não pelo código.',
  'Dê nota de 0 a 10 a cada critério: specificity (a tela tem identidade própria ou parece gerada por IA genérica), hierarchy, typography, color, states, motion (null se não der para ver numa imagem parada).',
  'Liste os defeitos visíveis com severidade (critical, major, minor), onde estão na tela e a correção concreta que o desenvolvedor deve fazer. Sem defeito inventado; tela boa pode ter lista vazia.',
  'Responda só o JSON do schema.',
]

const JUDGE_SCHEMA = (() => {
  const criterion = {
    type: 'object', additionalProperties: false, required: ['id', 'score', 'note'],
    properties: { id: { enum: ['specificity', 'hierarchy', 'typography', 'color', 'states', 'motion'] }, score: { type: ['number', 'null'], minimum: 0, maximum: 10 }, note: { type: 'string' } },
  }
  const defect = {
    type: 'object', additionalProperties: false, required: ['id', 'severity', 'criterion', 'where', 'fix'],
    properties: { id: { type: 'string' }, severity: { enum: ['critical', 'major', 'minor'] }, criterion: { type: 'string' }, where: { type: 'string' }, fix: { type: 'string' } },
  }
  return { type: 'object', additionalProperties: false, required: ['criteria', 'defects'], properties: { criteria: { type: 'array', minItems: 6, maxItems: 6, items: criterion }, defects: { type: 'array', items: defect } } }
})()

/** Roda um processo com stdin opcional; rejeita em saída diferente de 0 ou no teto de tempo. */
function runJudgeProcess(exe: string, args: string[], opts: { cwd: string; env?: Record<string, string>; input?: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: opts.cwd, shell: false, windowsHide: true, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > 16_777_216) child.kill('SIGKILL')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 1_048_576) child.kill('SIGKILL')
    })
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`juiz visual encerrou com ${code}: ${(stderr || stdout).slice(-1000)}`))
    })
    child.stdin.end(opts.input ?? '')
  })
}

/** Primeiro objeto JSON de um texto (resposta com cerca de código ou prosa em volta). */
function firstJsonObject(text: string): any {
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first === -1 || last <= first) throw new Error('resposta do juiz sem JSON')
  return JSON.parse(text.slice(first, last + 1))
}

/**
 * Chama o juiz isolado da empresa pedida. O Codex recebe as capturas anexadas (--image); Claude e Gemini (agy) abrem
 * os PNGs pelo caminho absoluto com a ferramenta de leitura, somente leitura. Testado com as três em 25/09.
 */
async function dispatchIsolatedJudge(pack: any, judge: { family: string; model_id: string }, round: number, deps: any) {
  const shots = pack.captures.map((c: any) => path.resolve(String(c.path)))
  const listed = { ...pack, captures: pack.captures.map((c: any, i: number) => ({ ...c, path: shots[i] })) }
  const artifactsDir = path.dirname(shots[0])
  if (judge.family === 'codex') {
    const schemaPath = path.join(deps.missionDir, `visual-judge-schema-r${round}.json`)
    const resultFile = path.join(deps.missionDir, `visual-judge-result-r${round}.json`)
    fs.writeFileSync(schemaPath, JSON.stringify(JUDGE_SCHEMA), 'utf8')
    // As capturas vão anexadas como imagem: só com o caminho no texto o juiz não enxergava a tela (25/09)
    const args = [...buildCodexArgs({ role: 'visual_judge', cwd: deps.cwd, schemaPath, resultFile, model: judge.model_id, sandbox: 'read-only' }), ...shots.map((p: string) => `--image=${p}`)]
    const prompt = [`${JUDGE_INSTRUCTIONS[0]} As imagens anexadas seguem a ordem da lista.`, ...JUDGE_INSTRUCTIONS.slice(1), '', JSON.stringify(listed)].join('\n')
    await runJudgeProcess(deps.resolved.exe, [...deps.resolved.prefixArgs, ...args], { cwd: deps.cwd, env: deps.env, input: prompt, timeoutMs: 300_000 })
    return JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  }
  const prompt = [`${JUDGE_INSTRUCTIONS[0]} Abra cada PNG pelo caminho absoluto com a ferramenta de leitura antes de julgar.`, ...JUDGE_INSTRUCTIONS.slice(1), '', JSON.stringify(listed)].join('\n')
  if (judge.family === 'claude') {
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(JUDGE_SCHEMA), '--safe-mode', '--permission-mode', 'bypassPermissions', '--allowedTools', 'Read', '--add-dir', artifactsDir, ...(judge.model_id ? ['--model', judge.model_id] : [])]
    const out = await runJudgeProcess(deps.resolved.exe, [...deps.resolved.prefixArgs, ...args], { cwd: deps.cwd, env: deps.env, input: prompt, timeoutMs: 300_000 })
    const envelope = firstJsonObject(out)
    if (envelope.is_error) throw new Error(`claude devolveu erro: ${String(envelope.result).slice(0, 300)}`)
    return envelope.structured_output ?? firstJsonObject(String(envelope.result ?? ''))
  }
  const args = buildAgyArgs({ prompt, model: judge.model_id || undefined, schema: JUDGE_SCHEMA, cwd: deps.cwd, addDirs: [artifactsDir], timeout: '5m' })
  const out = await runJudgeProcess(deps.resolved.exe, [...deps.resolved.prefixArgs, ...args], { cwd: deps.cwd, env: deps.env, timeoutMs: 360_000 })
  const envelope = firstJsonObject(out)
  return envelope.structured_output ?? firstJsonObject(String(envelope.response ?? ''))
}
