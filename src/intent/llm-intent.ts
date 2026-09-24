// Cérebro do pedido com IA de verdade: entender (e perguntar), briefing de pedido grande e plano com critérios.
// Os prompts e os formatos vêm da demo (proto/server.mjs: intentPrompt, briefPrompt, planPrompt), que entende e
// planeja pedidos reais há semanas; aqui a resposta de cada etapa vira as mesmas estruturas que o painel e o
// `ade run --plan` já consomem (perguntas do intake, ProductBriefing, plano e contratos validados).
import fs from 'node:fs'
import path from 'node:path'
import { buildChains } from '../models/chains.ts'
import { readModelSettings } from '../models/settings.ts'
import { AdeError } from '../journal/errors.ts'
import { getProjectDiscovery } from '../mission/plan-lifecycle.ts'
import type { IntentPort, Understanding } from '../panel/intake.ts'
import { LARGE_COMPLEXITIES, versionPlanOf, type ProductBriefing } from './briefing.ts'
import { compileIntent, verifierPaths } from './compiler.ts'
import { applyInterviewAnswer } from './interview.ts'
import { refsModelCall, type ModelCall, type ModelRef } from './plan-critic.ts'

export type Ask = (call: ModelCall) => Promise<unknown>

/** Sem planos configurados em Modelos: o Claude mais forte entende e planeja, o Codex é a reserva (como na demo). */
export const DEFAULT_INTENT_REFS: ModelRef[] = [
  { family: 'claude', model_id: 'claude-opus-5-5', effort: 'medium' },
  { family: 'codex', model_id: 'gpt-5.6-sol', effort: 'medium' },
]

const COMPLEXITY = ['trivial', 'bounded', 'feature', 'subsystem', 'project']
const str = { type: 'string' }
const strs = { type: 'array', items: str }

const QUESTION = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'question', 'why', 'options', 'allow_other'],
  properties: {
    id: str,
    question: str,
    why: str,
    allow_other: { type: 'boolean' },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: { type: 'object', additionalProperties: false, required: ['label', 'hint'], properties: { label: str, hint: str } },
    },
  },
}

export const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'complexity', 'difficulty', 'domains', 'needs_ui', 'questions'],
  properties: {
    title: str,
    summary: str,
    complexity: { type: 'string', enum: COMPLEXITY },
    difficulty: { type: 'string', enum: ['easy', 'normal', 'hard'] },
    domains: strs,
    needs_ui: { type: 'boolean' },
    questions: { type: 'array', maxItems: 5, items: QUESTION },
  },
}

export const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'goal', 'users', 'in_scope', 'out_of_scope', 'done_means', 'constraints', 'versions'],
  properties: {
    title: str,
    goal: str,
    users: str,
    in_scope: strs,
    out_of_scope: strs,
    done_means: strs,
    constraints: strs,
    versions: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'object', additionalProperties: false, required: ['name', 'goal', 'includes'], properties: { name: str, goal: str, includes: strs } },
    },
  },
}

const CRITERION = { type: 'object', additionalProperties: false, required: ['given', 'when', 'then'], properties: { given: str, when: str, then: str } }

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'explanation', 'decisions', 'stories'],
  properties: {
    title: str,
    summary: str,
    explanation: str,
    decisions: strs,
    stories: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'request', 'acceptance', 'scope_paths', 'do_not_touch', 'depends_on', 'test_file', 'skills'],
        properties: {
          id: str,
          title: str,
          request: str,
          acceptance: { type: 'array', minItems: 1, maxItems: 8, items: CRITERION },
          scope_paths: strs,
          do_not_touch: strs,
          depends_on: strs,
          test_file: str,
          skills: strs,
        },
      },
    },
  },
}

type IntentAnswer = { title: string; summary: string; complexity: string; difficulty: string; domains: string[]; needs_ui: boolean; questions: Array<{ id: string; question: string; why: string; allow_other: boolean; options: Array<{ label: string; hint: string }> }> }
type PlanAnswer = { title: string; summary: string; explanation: string; decisions: string[]; stories: Array<{ id: string; title: string; request: string; acceptance: Array<{ given: string; when: string; then: string }>; scope_paths: string[]; do_not_touch: string[]; depends_on: string[]; test_file: string; skills?: string[] }> }

function readConfig(repoDir: string): any {
  const p = path.join(repoDir, '.ade', 'config.json')
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : undefined
}

/** Quem entende e planeja: papel intent_compiler do config; senão a fila "plan" dos planos do usuário; senão o padrão. */
export function intentRefs(repoDir: string, adeConfig = readConfig(repoDir), now = Date.now()): ModelRef[] {
  const role = adeConfig?.roles?.intent_compiler
  if (role?.primary) return [role.primary, ...(role.fallbacks ?? [])]
  const settings = readModelSettings(repoDir)
  if (Object.keys(settings.plans).length > 0) {
    const slots = buildChains({ ...settings, now }).chains.plan
    if (slots.length > 0) return slots.map((s) => ({ family: s.family, model_id: s.model, effort: s.effort }))
  }
  return DEFAULT_INTENT_REFS
}

/** O que a IA precisa saber do projeto sem explorar: nome, raiz, comando de prova e documentos de regra. */
function projectBlock(repoDir: string): string {
  const discovery = getProjectDiscovery(repoDir)
  let root: string[] = []
  try {
    root = fs.readdirSync(repoDir).filter((n) => !n.startsWith('.git') && n !== 'node_modules').slice(0, 40)
  } catch {
    root = []
  }
  const docs = ['AGENTS.md', 'CLAUDE.md', 'README.md'].filter((n) => fs.existsSync(path.join(repoDir, n)))
  const test = discovery.scripts?.test ? `npm test → ${discovery.scripts.test}` : 'nenhum comando de prova no package.json'
  return [
    `Projeto: ${path.basename(repoDir)} em ${repoDir}. Itens na raiz: ${root.join(', ') || 'nenhum (pasta vazia)'}.`,
    `Provas: ${test}.`,
    docs.length ? `Leia primeiro ${docs.join(', ')}: as regras do repositório (pastas proibidas, comandos, o que está fora do escopo) valem mais que o pedido.` : '',
  ].filter(Boolean).join('\n')
}

function answersBlock(questions: any[] = [], answers: Record<string, string> = {}): string {
  if (questions.length === 0) return ''
  const lines = questions.map((q) => {
    const d = applyInterviewAnswer({}, q, answers[q.id], { allowWritten: true }).decision
    const label = q.options?.find((o: any) => o.id === d.value)?.label ?? d.value
    return `${q.text} → ${label}${d.origin === 'usuario' ? '' : ' (recomendação adotada; o usuário não escolheu)'}`
  })
  return `ESCOLHAS DO USUÁRIO NA ENTREVISTA (obrigatórias): ${lines.join(' | ')}`
}

export function intentPrompt(request: string, repoDir: string): string {
  return [
    'Você é a primeira IA da TL-ADE: entende o pedido do usuário antes de qualquer plano. Responda em português no JSON exigido. Faça no máximo 3 leituras do projeto; o planejador explora depois.',
    `Pedido: ${request}`,
    projectBlock(repoDir),
    '- title: até 8 palavras, o nome do que será feito.',
    '- summary: até 2 frases curtas para um usuário leigo que não programa, sem sigla nem termo técnico: o que ele vai ter no fim e as escolhas que você fez quando o pedido é vago.',
    '- complexity: trivial (1 arquivo, correção) | bounded (1 a 3 partes pequenas) | feature (4 a 6 partes de UM subsistema) | subsystem (mais de 6 partes, ou mais de um subsistema) | project (vários subsistemas ou fases). Na dúvida entre feature e subsystem, escolha subsystem.',
    '- difficulty: easy | normal | hard. domains: subconjunto de frontend, design, backend, api, database, testing, security, a11y, docs, devops, mais a linguagem principal. needs_ui: se há tela.',
    '- questions: entrevista curta para o usuário (leigo) escolher o jeito do resultado antes do plano. trivial: nenhuma. bounded: até 2, só se a resposta muda o resultado. feature: de 2 a 5. subsystem/project: de 3 a 5, cobrindo para quem é, o que entra primeiro e o que significa pronto.',
    '  Cada pergunta: id curto (q1…), question (uma frase simples, sem termo técnico), why (por que importa, uma frase), options (2 a 4; a PRIMEIRA é sempre a recomendada; label com até 6 palavras + hint de uma frase), allow_other (se vale escrever outra resposta).',
    '  Nunca pergunte o que a pasta já responde nem o que você decide bem sozinho. Frases do pedido que são perguntas ao assistente (e não decisões do produto) não viram pergunta: ignore-as.',
  ].join('\n')
}

export function briefPrompt(request: string, repoDir: string, understanding: Understanding, answers: string): string {
  return [
    'Você é o Intent Compiler da TL-ADE escrevendo o BRIEFING de um pedido grande, antes de qualquer plano. O usuário é leigo e deu pouco contexto: transforme o pedido num documento de produto com o que ENTRA, o que FICA DE FORA e o que significa PRONTO, dividido em versões que cabem em uma missão cada.',
    `Pedido: ${request}`,
    `Entendimento prévio: ${understanding.summary}`,
    answers,
    projectBlock(repoDir),
    'Leia no máximo 8 arquivos. O que JÁ EXISTE não entra em in_scope; regras do repositório vão em constraints.',
    'O usuário vai LER isto na tela: cada item é UMA frase de até 20 palavras, sem caminhos de arquivo nem nomes de função (isso vai em constraints).',
    '- title (≤8 palavras); goal (2 frases leigas: o que o usuário vai conseguir fazer no fim); users (uma frase).',
    '- in_scope: só os resultados pedidos, curtos e verificáveis; out_of_scope: exclusões relevantes; done_means: critérios para verificar a entrega. Sem ampliar o pedido para preencher listas.',
    '- constraints: regras do repositório e do usuário (aqui pode citar caminhos), até 10.',
    '- versions (1 a 8) em ordem de construção: a PRIMEIRA é a menor versão já útil; as seguintes são incrementos. Cada uma: name (v1, v2… ou o nome do roadmap do projeto), goal (até 15 palavras), includes (itens de in_scope copiados iguais). Todo item de in_scope aparece em exatamente uma versão.',
  ].filter(Boolean).join('\n')
}

export function planPrompt(request: string, repoDir: string, understanding: Understanding, answers: string, briefingBlock: string, skills: Array<{ id: string; summary: string }> = []): string {
  return [
    'Você é o Intent Compiler da TL-ADE. Transforme o pedido do usuário em um plano executável por outra IA, em português, no JSON exigido.',
    `Pedido: ${request}`,
    briefingBlock,
    `Entendimento prévio (outra IA): ${understanding.summary}`,
    answers,
    projectBlock(repoDir),
    'Explore o projeto só o necessário (Glob, Read, Grep) para citar caminhos reais. Depois produza:',
    '- title (≤8 palavras) e summary (2 frases: o que será entregue).',
    '- explanation: 3 a 6 linhas curtas para um usuário leigo, sem termos técnicos: o que ele vai ter no fim, o que cada parte entrega em uma frase e o que você assumiu por conta própria.',
    '- decisions: cada uma "X, porque Y"; quando havia alternativa real, "; descartado: Z".',
    '- stories: partes pequenas, na ordem de construção (trivial ou bounded: 1 a 3; feature: 2 a 6). Cada uma com id (S1, S2…), title (≤8 palavras), request (o que fazer, 1 a 3 frases, para quem implementa), acceptance, scope_paths, do_not_touch, depends_on (ids de partes ANTERIORES), test_file e skills.',
    '- acceptance: 2 a 6 critérios, cada um {given, when, then} ("Dado…, quando…, então…" sem essas palavras), de comportamento observável pelo usuário ou por uma prova automatizada sem rede, CLI ou serviço real (use dublês). Nunca fixe implementação: nome de variável, valor exato de estilo, estrutura interna.',
    '- scope_paths: arquivos que a parte pode criar ou mudar (caminhos reais do projeto ou novos). do_not_touch: o que não pode mudar. test_file: o arquivo de prova, num lugar que o comando de provas realmente roda.',
    skills.length > 0
      ? ['- skills: até 3 ids desta lista que ajudam quem escreve a prova e o código daquela parte; [] se nenhuma serve.', ...skills.map((k) => `  - ${k.id}: ${k.summary}`)].join('\n')
      : '- skills: [] (o projeto não tem catálogo de skills).',
    '- Menor código que resolve: reuse o que já existe, depois a biblioteca padrão, depois a plataforma (CSS antes de JS, elemento nativo antes de componente). Nada de camada ou configuração que nenhuma parte usa.',
    '- Nenhuma parte manda commitar, dar push ou rodar a suíte inteira: o motor faz isso depois das provas e da revisão.',
  ].filter(Boolean).join('\n')
}

const OTHER_LABEL = 'Responder com minhas palavras'

/** Perguntas da IA no formato do intake: ids nas opções, a primeira recomendada, "outra resposta" e "não sei". */
export function toIntakeQuestions(questions: IntentAnswer['questions']): any[] {
  return questions.slice(0, 5).map((q, qi) => {
    const id = /^[a-z0-9_-]{1,12}$/i.test(q.id) ? q.id : `q${qi + 1}`
    return {
      id,
      unknown_ref: id,
      kind: 'product_choice',
      text: q.question,
      why: q.why,
      options: [
        ...q.options.map((o, i) => ({ id: `${id}-o${i + 1}`, label: o.label, why: o.hint, ...(i === 0 ? { recommended: true } : {}) })),
        ...(q.allow_other ? [{ id: `${id}-outra`, label: OTHER_LABEL, free_text: true }] : []),
        { id: 'dont_know', label: 'Não sei (a TL-ADE decide)' },
      ],
      default_if_unknown: `${id}-o1`,
    }
  })
}

const uniq = (xs: string[]) => Array.from(new Set(xs.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())))

/** Um contrato do compilador ganha o que a IA planejou: título, tarefa, critérios, requisitos e escopo reais. */
function withStory(contract: any, story: PlanAnswer['stories'][number], index: number, deliverable: string, idOf: Map<string, string>, catalog: Set<string>): any {
  const n = index + 1
  const verifierIds: string[] = contract.scenarios?.[0]?.verifiers ?? []
  const negative = (contract.scenarios ?? []).filter((sc: any) => String(sc.id).endsWith('-neg'))
  const evidence = verifierPaths(contract.verifiers ?? [])
  const deps = story.depends_on.map((d) => idOf.get(d)).filter((d): d is string => !!d && Number(d.slice(1)) < n)
  return {
    ...contract,
    title: story.title.slice(0, 80),
    task: String(contract.task).replace(deliverable, story.request),
    requirements: story.acceptance.map((a, j) => ({ id: `R${n}.${j + 1}`, ears: `WHEN ${a.when} THE SYSTEM SHALL ${a.then}` })),
    scenarios: [
      ...story.acceptance.map((a, j) => ({ id: `C${n}.${j + 1}`, given: a.given, when: a.when, then: a.then, verifiers: verifierIds })),
      ...negative,
    ],
    guardrails: {
      ...contract.guardrails,
      scope_paths: uniq([...story.scope_paths, story.test_file, ...evidence]).length > 0 ? uniq([...story.scope_paths, story.test_file, ...evidence]) : contract.guardrails.scope_paths,
      do_not_touch: uniq([...contract.guardrails.do_not_touch, ...story.do_not_touch]),
    },
    // skill que a IA inventou ou que saiu do catálogo não entra
    skills: uniq(story.skills ?? []).filter((id) => catalog.has(id)).slice(0, 3),
    ...(deps.length > 0 ? { depends_on: deps } : {}),
  }
}

function asIntent(raw: unknown): IntentAnswer {
  const r = raw as IntentAnswer
  if (!r || typeof r.summary !== 'string' || !COMPLEXITY.includes(r.complexity) || !Array.isArray(r.questions)) {
    throw new AdeError('intencao_invalida', 'A IA não devolveu o entendimento do pedido no formato esperado.', 2)
  }
  return r
}

function asPlan(raw: unknown): PlanAnswer {
  const r = raw as PlanAnswer
  if (!r || !Array.isArray(r.stories) || r.stories.length === 0 || r.stories.some((s) => !s?.title || !Array.isArray(s.acceptance) || s.acceptance.length === 0)) {
    throw new AdeError('plano_invalido', 'A IA não devolveu partes com critérios no plano.', 2)
  }
  return r
}

/**
 * Porta de intenção com IA. `askFor(repoDir)` dá a chamada ao modelo (injetável nas provas); o padrão usa a fila
 * de intentRefs com Claude, Codex ou agy em modo leitura.
 */
export function createLlmIntent({ askFor = (repoDir: string) => refsModelCall(intentRefs(repoDir), 'intent', { repoDir }) }: { askFor?: (repoDir: string) => Ask } = {}): IntentPort {
  return {
    async compile({ request, repoDir, missionId, options, eligibleSkills, answers, briefing, questions: stored, understanding: known }) {
      // "Pesquisar fatos" ligado nas opções: entender, briefing e plano podem buscar na internet e dizem a fonte
      const web = options?.research === true
      const webNote = web ? '\n\nPesquisa na internet ligada: quando o pedido depender de fato de fora do projeto (API, versão, preço, regra), confirme na web antes de decidir e cite a fonte (URL) na decisão.' : ''
      const ask0 = askFor(repoDir)
      const ask: Ask = (call) => ask0({ ...call, prompt: call.prompt + webNote, ...(web ? { web } : {}) })
      let understanding = known
      let questions = stored ?? []
      if (!understanding) {
        const intent = asIntent(await ask({ missionId, stepId: 'entender', prompt: intentPrompt(request, repoDir), schema: INTENT_SCHEMA, maxTurns: 6 }))
        understanding = { title: intent.title, summary: intent.summary, complexity: intent.complexity, difficulty: intent.difficulty, domains: intent.domains, needs_ui: intent.needs_ui }
        questions = toIntakeQuestions(intent.questions)
        if (questions.length > 0 && !answers) return { questions, understanding }
      }
      const answered = answersBlock(questions, answers ?? {})
      const large = LARGE_COMPLEXITIES.has(understanding.complexity) || understanding.difficulty === 'hard'
      if (!briefing && large) {
        const product = await ask({ missionId, stepId: 'briefing', prompt: briefPrompt(request, repoDir, understanding, answered), schema: BRIEF_SCHEMA, maxTurns: 14 }) as ProductBriefing
        return { briefing: product, understanding }
      }

      const version = briefing ? versionPlanOf(briefing, 0) : null
      const briefingBlock = briefing && version
        ? `BRIEFING APROVADO PELO USUÁRIO (vale mais que o pedido): objetivo ${briefing.goal}. Construa AGORA só a versão ${briefing.versions[0].name}: ${briefing.versions[0].goal}. Entra: ${version.deliverables.join('; ')}. Fora do escopo: ${briefing.out_of_scope.join('; ')}. Restrições: ${briefing.constraints.join('; ')}.`
        : ''
      const plan = asPlan(await ask({ missionId, stepId: 'planejar', prompt: planPrompt(version?.request ?? request, repoDir, understanding, answered, briefingBlock, eligibleSkills ?? []), schema: PLAN_SCHEMA, maxTurns: 16 }))

      const stories = plan.stories.slice(0, 8)
      const idOf = new Map(stories.map((s, i) => [s.id, `S${i + 1}`]))
      const deliverables = stories.map((s, i) => `S${i + 1} ${s.title}`)
      const decisions = questions.map((q) => applyInterviewAnswer({}, q, answers?.[q.id], { allowWritten: true }).decision)
      const compiled = await compileIntent({
        request: version?.request ?? request,
        discovery: getProjectDiscovery(repoDir),
        unknowns: [],
        interview: questions,
        decisions,
        classification: { complexity: understanding.complexity, domains: understanding.domains, confidence: 1, rationale: understanding.summary } as any,
        deliverables,
        adeConfig: readConfig(repoDir),
      })
      const catalog = new Set((eligibleSkills ?? []).map((k) => k.id))
      let contracts = compiled.contracts.map((c, i) => withStory(c, stories[i], i, deliverables[i], idOf, catalog))
      for (const q of questions) contracts = contracts.map((c) => applyInterviewAnswer(c, q, answers?.[q.id], { allowWritten: true }).contract)
      compiled.plan.authorization.eligible_skills = uniq(contracts.flatMap((c) => c.skills))
      if (version) Object.assign(compiled.plan.briefing, version.briefing)
      return { plan: compiled.plan, contracts, understanding: { ...understanding, title: plan.title, summary: plan.summary, explanation: plan.explanation, decisions: plan.decisions } }
    },
  }
}

export const llmIntent = createLlmIntent()
