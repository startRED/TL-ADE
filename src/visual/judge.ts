import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { buildCodexArgs } from '../adapters/codex/argv.ts'
import { CLAUDE_ISOLATION_ENV, isolationArgs, writeIsolationSettings } from '../adapters/claude/isolation.ts'

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

export const RUBRIC_VERSION = '2026-09-25-v6'

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

/** Nota final que aprova sozinha; polir além disso é pedido do operador. */
export const PASS_FINAL = 7.5
/** Abaixo disso o critério tem problema real (5 = funcional e genérico na escala da rubrica). */
export const PASS_CRITERION_MIN = 5

/**
 * Avalia o veredito composto com base nas notas e defeitos.
 * Corte (rubrica v2, 25/09): final >= 7,5, nenhum critério aplicável abaixo de 5 e zero defeito crítico. A exigência
 * de especificidade >= 7 saiu: em tela de ferramenta ela é gosto, não problema.
 */
export function evaluateCutoff(criteria: VisualEvalCriteria[], final: number, defects: any[] = []): 'pass' | 'rework' {
  if (defects.some((d) => d.severity === 'critical')) return 'rework'
  if (final < PASS_FINAL) return 'rework'
  return criteria.some((c) => typeof c.score === 'number' && c.score < PASS_CRITERION_MIN) ? 'rework' : 'pass'
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
  contrastMeasured = false,
  previous = null,
  round = 1,
  storyId = 'ADE-S1',
  detectorInfo = { engine_version: '0.1.5', url_mode: 'ok' },
  deps = {},
}: {
        captures: any[]
        task: string
        designBrief: any
        rubric?: any
        judge?: { family: string; model_id: string }
        // fila de juízes, o melhor primeiro; quem falha passa a vez ao próximo
        judges?: Array<{ family: string; model_id: string; effort?: string | null; resolved?: { exe: string; prefixArgs: string[] } | null }>
        // o portão D3 (axe-core) mediu o contraste antes do juiz e passou
        contrastMeasured?: boolean
        // avaliação da passada anterior da mesma tela
        previous?: any
        round?: number
        storyId?: string
        detectorInfo?: { engine_version: string; url_mode: 'ok' | 'unsupported' }
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

  // Julgar imagem não é revisar o próprio código: quem escreveu a tela também julga. Um juiz por empresa (Codex e
  // Claude), em paralelo, e as duas opiniões se cruzam (25/09, pedido do operador).
  const panel: NonNullable<typeof judges> = []
  for (const j of judges ?? [{ ...judge, resolved: deps.resolved }]) {
    if (JUDGE_FAMILIES.includes(j.family) && !panel.some((p) => p.family === j.family)) panel.push(j)
  }
  if (panel.length === 0) {
    return unknown('judge-family-invalid', 'Configurar um juiz Codex ou Claude')
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
    ...(contrastMeasured ? { contrast_measured: true } : {}),
    ...(previous?.criteria ? { previous_round: { final: previous.final, scores: Object.fromEntries(previous.criteria.map((c: any) => [c.id, c.score])), asked_fixes: (previous.defects ?? []).map((d: any) => d.fix) } } : {}),
    design_brief: designBrief,
    rubric: rubric || { version: RUBRIC_VERSION, weights },
  }

  const ids = (['specificity', 'hierarchy', 'typography', 'color', 'states', 'motion'] as VisualEvalCriteria['id'][])
  const complete = (raw: any) => Array.isArray(raw?.criteria) && ids.every((id) => raw.criteria.some((criterion: any) => criterion?.id === id))
  // Se houver despachante injetado (ex: dublê de modelo nos testes)
  const opinions: Array<{ family: string; model_id: string; raw: any }> = []
  const failures: string[] = []
  if (deps.dispatchJudge) {
    opinions.push({ ...panel[0], raw: await deps.dispatchJudge(judgePack) })
  } else if (deps.cwd && deps.missionDir) {
    const results = await Promise.all(panel.map(async (member) => {
      if (!member.resolved) return null
      try {
        const raw = await dispatchIsolatedJudge(judgePack, member, round, { ...deps, resolved: member.resolved })
        if (complete(raw)) return { family: member.family, model_id: member.model_id, raw }
        failures.push(`${member.family}: resultado incompleto`)
      } catch (err) {
        failures.push(`${member.family}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
      }
      return null
    }))
    for (const r of results) if (r) opinions.push(r)
  }

  if (opinions.length === 0 && failures.length > 0) {
    return unknown('judge-unavailable', `Nenhum juiz respondeu: ${failures.join(' | ')}`)
  }

  if (opinions.length > 0) {
    if (!opinions.every((o) => complete(o.raw))) {
      return unknown('judge-result-invalid', 'Repetir o julgamento com VisualEval completo')
    }
    judge = { family: opinions.map((o) => o.family).join('+'), model_id: opinions.map((o) => o.model_id).join('+') }
    // sem briefing que diga o tipo de tela, vale o que o juiz viu (o padrão "persuade" pesava identidade em painel)
    const surface = (designBrief?.surface_mode || opinions.map((o) => o.raw.surface).find((m) => m in MODE_WEIGHTS) || mode) as keyof typeof MODE_WEIGHTS
    const surfaceWeights = MODE_WEIGHTS[surface]
    const scored = opinions.map((o) => ({ family: o.family, criteria: scoreCriteria(o.raw, ids, surfaceWeights) }))
    const tag = (family: string, text: string) => (opinions.length > 1 ? `${family}: ${text}` : text)
    // cruzamento: média por critério entre quem deu nota; as notas de cada juiz ficam no texto
    const criteria: VisualEvalCriteria[] = ids.map((id) => {
      const own = scored.map((j) => ({ family: j.family, c: j.criteria.find((c) => c.id === id)! }))
      const given = own.filter((o) => o.c.score !== null)
      const score = given.length === 0 ? null : Math.round((given.reduce((sum, o) => sum + (o.c.score as number), 0) / given.length) * 10) / 10
      const spread = given.length > 1 ? ` (notas ${given.map((o) => `${o.family} ${o.c.score}`).join(', ')})` : ''
      return { id, score, weight: surfaceWeights[id], note: own.map((o) => tag(o.family, o.c.note)).join(' || ') + spread }
    })
    // defeitos: a união dos dois, cada um com quem apontou; o que os dois viram no mesmo critério vem primeiro
    const all = opinions.flatMap((o) => (Array.isArray(o.raw.defects) ? o.raw.defects : [])
      .filter((defect: any) => defect && ['critical', 'major', 'minor'].includes(defect.severity))
      .map((defect: any) => ({ ...defect, id: opinions.length > 1 ? `${o.family}:${defect.id}` : defect.id, _family: o.family })))
    const bothSaw = (d: any) => all.some((other: any) => other._family !== d._family && other.criterion === d.criterion)
    const rank = { critical: 0, major: 1, minor: 2 } as Record<string, number>
    const defects = all
      .sort((x: any, y: any) => Number(bothSaw(y)) - Number(bothSaw(x)) || rank[x.severity] - rank[y.severity])
      .map(({ _family, ...d }: any) => d)
    const final = calculateRenormalizedFinal(criteria)
    return {
      story_id: storyId, round, rubric_version: RUBRIC_VERSION, judge, detector: detectorInfo,
      surface_mode: surface, captures: judgePack.captures, criteria, final, defects,
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

const JUDGE_FAMILIES = ['codex', 'claude']

/** Ponto de partida de toda nota: tela funcional, correta e genérica. */
export const RUBRIC_BASE = 5

/**
 * Rubrica v2 (25/09). A v1 dava só o nome dos critérios e os juízes davam notas de 3,7 a 7,9 à mesma tela. Agora cada
 * nota parte da mesma base e só anda com ajuste preso ao que se vê na captura; a correção diz elemento, propriedade e
 * valor, para o maker executar sem adivinhar.
 */
const JUDGE_INSTRUCTIONS = [
  'Você é o juiz visual de uma interface. Julgue só o que se vê nas capturas listadas em "captures" (rota, largura, tema), não o código nem o que a tela poderia ter. Seja realista: nem generoso, nem punitivo por gosto pessoal.',
  'Captura com rota "fim da jornada Cx" é a tela ao fim do fluxo do critério Cx (por exemplo, já com anexos ou itens criados): julgue esses estados por ela, não peça como defeito um estado que já aparece numa delas.',
  '',
  `ESCALA (igual para todo critério): 0-2 quebrado (conteúdo cortado, sobreposto ou ilegível); 3-4 problema que qualquer usuário nota; ${RUBRIC_BASE} funcional e correto, mas genérico, cara de modelo pronto; 6 correto com algum cuidado; 7 bom, poucos ajustes; 8 muito bom, decisões próprias e consistentes; 9-10 referência de mercado (raro).`,
  '',
  `COMO PONTUAR: cada critério começa em ${RUBRIC_BASE}. Em "adjustments" liste cada ponto que sobe ou desce a nota: delta entre -3 e +3 (passos de 0,5) e a observação concreta (o quê, onde, em qual largura/tema). Sem observação visível, sem ajuste. O mesmo problema desconta num critério só. "score" é ${RUBRIC_BASE} mais a soma dos deltas.`,
  '',
  'TIPO DE TELA: diga em "surface" o que ela é e julgue pelo que uma tela boa desse tipo precisa: operate (ferramenta, painel, formulário, app de trabalho: clareza, densidade, ação óbvia), persuade (página de venda ou apresentação: identidade, impacto, chamada), read (documento, artigo, docs: leitura longa confortável), experience (jogo, peça interativa: atmosfera, resposta visual).',
  '',
  'CRITÉRIOS (o que olhar):',
  '- specificity: a tela tem identidade própria que combina com a tarefa, ou parece modelo pronto/gerado por IA (card branco centralizado, botão pílula roxo, gradiente decorativo, ícone genérico, emoji como ícone)? Sobe: marca, voz e decisões visuais coerentes com o produto. Desce: clichês de IA, elementos intercambiáveis com qualquer app.',
  '- hierarchy: a ação principal é óbvia em um segundo? Ordem de leitura, agrupamento por proximidade, ritmo de espaçamento consistente, uso do espaço da tela nas duas larguras. Desce: duas ações com o mesmo peso, área vazia dominante sem propósito, elementos colados na borda em 390 px.',
  '- typography: escala com poucos tamanhos bem separados, pesos com função, corpo com pelo menos 14 px no celular e 15-16 px no desktop, linha com até ~75 caracteres, altura de linha confortável, família coerente (mono só com motivo).',
  '- color: contraste de texto (AA: 4,5:1 corpo, 3:1 texto grande), paleta pequena com papéis claros (fundo, superfície, texto, acento, erro), acento usado com parcimônia, tema escuro de verdade quando a tarefa pede os dois temas. Com contrast_measured: true no pacote, o contraste AA já foi medido com axe-core e passou: não desconte contraste por estimativa visual (o olho erra a razão), só texto que esteja ilegível na imagem.',
  '- states: só os estados visíveis nas capturas ou exigidos pela tarefa e visíveis numa tela parada (vazio, preenchido, foco, desabilitado, erro, carregando, arquivo anexado). Estado de interação que uma captura não mostra (hover, arrastando) não desconta; se a tarefa exige um estado e a tela não dá nenhum sinal dele, desconta.',
  '- motion: null, a menos que a captura mostre indício de movimento.',
  '',
  'DEFEITOS: todo ajuste negativo de -1 ou pior vira um defeito. severity: critical = impede ou quebra o uso (cortado, sobreposto, ilegível, contraste abaixo de 3:1 em texto); major = o usuário nota e a tarefa piora; minor = polimento. "where": elemento e largura/tema. "fix": ação executável com elemento, propriedade e valor-alvo (ex.: "texto de ajuda .hint: font-size 13px -> 15px e cor #a1a1aa -> #52525b"; "botão Anexar: estilo secundário com borda 1px e fundo transparente, Enviar fica o único preenchido"). Nada de "melhorar a identidade" sem dizer como.',
  '',
  'PROIBIDO SUGERIR (o detector Impeccable reprova sozinho e a passada se perde; teste de 25/09): rótulo, kicker ou eyebrow acima do título; texto em degradê; paleta de IA (degradê roxo/violeta, ciano ou turquesa neon sobre fundo escuro); borda colorida lateral acima de 1px em card ou aviso; sombra dura deslocada sem desfoque; vidro ou blur decorativo; emoji ou glifo no lugar de ícone; monoespaçada como fantasia de técnico; cards iguais de ícone + título + texto como estrutura; números de seção 01/02/03 sem função. Identidade vem de tipografia, espaçamento, cor própria contida e voz do produto.',
  '',
  'CAMINHO ATÉ 7,5: só apontar o que está errado deixa a tela em 5 (correta e genérica). Para cada critério com nota abaixo de 7,5, ponha também em "defects" a mudança concreta que o levaria a 7,5, pensando no que uma tela boa desse tipo teria (severity major se o critério está abaixo de 6, minor entre 6 e 7,5). Diga o que construir ou trocar, com elemento e valor, nunca só "melhorar".',
  '',
  'PASSADA ANTERIOR: com "previous_round" no pacote, esta tela já foi julgada e o desenvolvedor recebeu "asked_fixes". Confira nas capturas o que foi feito: correção feita e boa conta a favor no critério; não peça o contrário de uma correção pedida antes, a menos que ela tenha piorado a tela (diga por quê); repita só o que continua faltando. Não ancore a nota na anterior: julgue a tela de agora.',
  '',
  'Responda só o JSON do schema.',
]

const JUDGE_SCHEMA = (() => {
  const adjustment = {
    type: 'object', additionalProperties: false, required: ['delta', 'observation'],
    properties: { delta: { type: 'number', minimum: -3, maximum: 3 }, observation: { type: 'string' } },
  }
  const criterion = {
    type: 'object', additionalProperties: false, required: ['id', 'score', 'note', 'adjustments'],
    properties: { id: { enum: ['specificity', 'hierarchy', 'typography', 'color', 'states', 'motion'] }, score: { type: ['number', 'null'], minimum: 0, maximum: 10 }, note: { type: 'string' }, adjustments: { type: 'array', items: adjustment } },
  }
  const defect = {
    type: 'object', additionalProperties: false, required: ['id', 'severity', 'criterion', 'where', 'fix'],
    properties: { id: { type: 'string' }, severity: { enum: ['critical', 'major', 'minor'] }, criterion: { type: 'string' }, where: { type: 'string' }, fix: { type: 'string' } },
  }
  return { type: 'object', additionalProperties: false, required: ['surface', 'criteria', 'defects'], properties: { surface: { enum: ['operate', 'persuade', 'read', 'experience'] }, criteria: { type: 'array', minItems: 6, maxItems: 6, items: criterion }, defects: { type: 'array', items: defect } } }
})()

/** Notas de um juiz: na rubrica v2 a nota é a base mais os ajustes observados, não um número solto. */
function scoreCriteria(raw: any, ids: VisualEvalCriteria['id'][], weights: Record<string, number>): VisualEvalCriteria[] {
  return ids.map((id) => {
    const criterion = raw.criteria.find((item: any) => item.id === id)
    const note = typeof criterion.note === 'string' ? criterion.note : ''
    if (criterion.score !== null && Array.isArray(criterion.adjustments)) {
      const adjustments = (criterion.adjustments as any[]).filter((a) => typeof a?.delta === 'number' && Number.isFinite(a.delta))
      const score = Math.min(10, Math.max(0, Math.round((RUBRIC_BASE + adjustments.reduce((sum, a) => sum + a.delta, 0)) * 10) / 10))
      const detail = adjustments.map((a) => `${a.delta > 0 ? '+' : ''}${a.delta} ${String(a.observation ?? '')}`).join('; ')
      return { id, score, weight: weights[id], note: detail ? `${note} [base ${RUBRIC_BASE}; ${detail}]` : note }
    }
    const score = criterion.score
    if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10)) {
      throw new TypeError(`nota inválida do juiz para ${id}`)
    }
    return { id, score, weight: weights[id], note }
  })
}

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
 * Chama o juiz isolado da empresa pedida. O Codex recebe as capturas anexadas (--image); o Claude abre os PNGs pelo
 * caminho absoluto com Read, somente leitura. A resposta bruta fica na missão para auditar cada ponto da nota.
 */
async function dispatchIsolatedJudge(pack: any, judge: { family: string; model_id: string; effort?: string | null }, round: number, deps: any) {
  const shots = pack.captures.map((c: any) => path.resolve(String(c.path)))
  const listed = { ...pack, captures: pack.captures.map((c: any, i: number) => ({ ...c, path: shots[i] })) }
  const artifactsDir = path.dirname(shots[0])
  const keep = (raw: any) => {
    fs.writeFileSync(path.join(deps.missionDir, `visual-judge-raw-r${round}-${judge.family}.json`), JSON.stringify(raw, null, 2), 'utf8')
    return raw
  }
  if (judge.family === 'codex') {
    const schemaPath = path.join(deps.missionDir, `visual-judge-schema-r${round}.json`)
    const resultFile = path.join(deps.missionDir, `visual-judge-result-r${round}.json`)
    fs.writeFileSync(schemaPath, JSON.stringify(JUDGE_SCHEMA), 'utf8')
    // As capturas vão anexadas como imagem: só com o caminho no texto o juiz não enxergava a tela (25/09)
    const args = [...buildCodexArgs({ role: 'visual_judge', cwd: deps.cwd, schemaPath, resultFile, model: judge.model_id, effort: judge.effort ?? undefined, sandbox: 'read-only' }), ...shots.map((p: string) => `--image=${p}`)]
    const prompt = [...JUDGE_INSTRUCTIONS, 'As imagens anexadas seguem a ordem da lista "captures".', '', JSON.stringify(listed)].join('\n')
    await runJudgeProcess(deps.resolved.exe, [...deps.resolved.prefixArgs, ...args], { cwd: deps.cwd, env: deps.env, input: prompt, timeoutMs: 300_000 })
    return keep(JSON.parse(fs.readFileSync(resultFile, 'utf8')))
  }
  const prompt = [...JUDGE_INSTRUCTIONS, 'Abra cada PNG pelo caminho absoluto com a ferramenta Read antes de julgar.', '', JSON.stringify(listed)].join('\n')
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(JUDGE_SCHEMA), ...isolationArgs(writeIsolationSettings(deps.cwd), 'none'), '--permission-mode', 'bypassPermissions', '--allowedTools', 'Read', '--add-dir', artifactsDir, ...(judge.model_id ? ['--model', judge.model_id] : []), ...(judge.effort ? ['--effort', judge.effort] : [])]
  const out = await runJudgeProcess(deps.resolved.exe, [...deps.resolved.prefixArgs, ...args], { cwd: deps.cwd, env: { ...(deps.env ?? process.env), ...CLAUDE_ISOLATION_ENV }, input: prompt, timeoutMs: 300_000 })
  const envelope = firstJsonObject(out)
  if (envelope.is_error) throw new Error(`claude devolveu erro: ${String(envelope.result).slice(0, 300)}`)
  return keep(envelope.structured_output ?? firstJsonObject(String(envelope.result ?? '')))
}
