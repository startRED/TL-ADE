import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../../journal/errors.ts'
import { writeJsonAtomic } from '../../mission/plan-lifecycle.ts'
import { applyMemoryOps, describeMemoryOp, extractMemoryOps, memoryPromptBlock } from '../../memory/memory.ts'
import { CATALOG, EFFORTS, FAMILIES, type Effort, type Family } from '../../models/catalog.ts'
import { chatSkills } from '../options.ts'
import type { ActivityKind } from '../open-projects.ts'
import type { DiffFile } from '../units.ts'
import { createChatGit, MESSAGES } from './copy.ts'

export type ProposalStatus = 'pendente' | 'aprovada' | 'recusada'

interface StoredProposal {
  status: ProposalStatus
  summary: string
  files: DiffFile[]
  head: string
  tree: string
  commit?: string
  discarded_ref?: string
}

interface StoredTurn { id: string; role: 'user' | 'assistant'; text: string; at: string; proposal?: StoredProposal; skills?: string[]; memory?: string[] }

export interface ChatTurnView {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  proposal?: { status: ProposalStatus; summary: string; files: DiffFile[]; blocked_reason?: string }
  /** Skills do catálogo que entraram na pergunta. */
  skills?: string[]
  /** O que a resposta guardou, trocou ou apagou na memória (ou por que não guardou). */
  memory?: string[]
}

export interface ChatAgentInput {
  family: Family
  model?: string
  effort?: Effort
  cwd: string
  prompt: string
  /** Memória persistente e skills escolhidas para a pergunta, já montadas em texto. */
  context?: string
  history: Array<{ role: 'user' | 'assistant'; text: string }>
}

/** Porta do agente de chat: roda na cópia e devolve a resposta em texto. */
export type ChatAgent = (input: ChatAgentInput) => Promise<{ text: string }>

interface Project { id: string; path: string }

const historyPath = (p: Project) => path.join(p.path, '.ade', 'chat', `${p.id}.json`)
const copyPath = (p: Project) => path.join(p.path, '.ade', 'chat', 'wt', p.id)
const archiveDir = (p: Project) => path.join(p.path, '.ade', 'chat', 'arquivo')
/** A cada tantas perguntas a pessoa, o prompt lembra o modelo de revisar o que vale guardar (nudge do Hermes). */
const MEMORY_NUDGE_EVERY = 10
const conflict = (code: string, message: string) => new AdeError(code, message, 5)
const invalid = (message: string) => new AdeError('chat_pergunta_invalida', message, 2)

/** Primeira linha útil da resposta (sem marcação), ou o pedido; até 120 caracteres (lição proposalSummary). */
function summaryOf(answer: string, request: string): string {
  const first = answer.split(/\r?\n/).map((l) => l.trim().replace(/^(?:#{1,6}|>|[-*_`])\s+/, '').trim()).find(Boolean)
  const text = first ?? request.replace(/\s+/g, ' ').trim()
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

function parseQuestion(body: any): Omit<ChatAgentInput, 'cwd' | 'history'> {
  const text = body?.text
  if (typeof text !== 'string' || !text.trim()) throw invalid('Escreva a pergunta antes de enviar.')
  const family = body.family
  if (!FAMILIES.includes(family)) throw invalid(`Empresa inválida: use ${FAMILIES.join(', ')}.`)
  const { model, effort } = body
  if (model !== undefined && !CATALOG.some((m) => m.family === family && m.model === model)) throw invalid(`Modelo ${String(model)} não é da empresa ${family}.`)
  if (effort !== undefined && !EFFORTS.includes(effort)) throw invalid(`Esforço inválido: use ${EFFORTS.join(', ')}.`)
  return { family, model, effort, prompt: text.trim() }
}

/**
 * Chat por projeto: cada pergunta roda o agente numa cópia git do projeto (.ade/chat/wt/<id>), e a resposta
 * que muda arquivos vira proposta que o usuário aprova (commit no projeto) ou recusa (árvore guardada em ref).
 * O histórico é durável em .ade/chat/<id>.json; as operações de um projeto passam em fila.
 */
export function createChat({ agent, homeDir, catalogDir, beginActivity, missionRunning, onError }: {
  agent: ChatAgent
  /** Pasta pessoal onde fica a memória (~/.ade/memory). */
  homeDir: string
  /** Catálogo de skills sincronizado. */
  catalogDir: string
  beginActivity: (projectId: string, kind: ActivityKind) => () => void
  missionRunning: (projectId: string) => boolean
  onError: (message: string) => void
}) {
  const git = createChatGit()
  const busy = new Set<string>()
  const queues = new Map<string, Promise<unknown>>()

  function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (queues.get(key) ?? Promise.resolve()).then(fn)
    queues.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  function load(p: Project): StoredTurn[] {
    const file = historyPath(p)
    if (!fs.existsSync(file)) return []
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(data?.turns)) throw new AdeError('chat_historico_invalido', `Histórico do chat corrompido em ${file}.`, 2)
    return data.turns
  }

  const save = (p: Project, turns: StoredTurn[]) => writeJsonAtomic(historyPath(p), { turns })
  const pendingOf = (turns: StoredTurn[]) => turns.find((t) => t.proposal?.status === 'pendente')

  function decidable(turns: StoredTurn[], id: unknown): StoredTurn & { proposal: StoredProposal } {
    const turn = turns.find((t) => t.id === id && t.proposal)
    if (!turn?.proposal) throw new AdeError('chat_proposal_not_found', 'Proposta não encontrada.', 2)
    if (turn.proposal.status !== 'pendente') throw conflict('chat_proposta_decidida', 'Esta proposta já foi decidida.')
    return turn as StoredTurn & { proposal: StoredProposal }
  }

  /** Memória, skills da pergunta e, de tempos em tempos, o lembrete de revisar a memória. */
  function contextOf(p: Project, prompt: string, history: ChatAgentInput['history']): { context: string; skills: string[] } {
    let skills: Array<{ id: string; content: string }> = []
    try {
      skills = chatSkills(catalogDir, p.path, prompt)
    } catch (err) {
      // Catálogo divergente ou inválido não derruba a conversa: a pergunta vai sem skill.
      onError(`ade serve: skills do chat de ${p.id} indisponíveis: ${err instanceof Error ? err.message : String(err)}\n`)
    }
    const asked = history.filter((t) => t.role === 'user').length + 1
    const parts = [memoryPromptBlock(homeDir)]
    if (asked % MEMORY_NUDGE_EVERY === 0) {
      parts.push('Antes de responder, revise a conversa: se a pessoa corrigiu seu jeito de trabalhar ou contou algo durável sobre ela ou o ambiente, guarde com a marca <memoria>.')
    }
    for (const s of skills) parts.push(`Skill "${s.id}" (escolhida para esta pergunta; siga o que servir):\n${s.content.trim()}`)
    return { context: parts.join('\n\n'), skills: skills.map((s) => s.id) }
  }

  /** Aplica as marcas de memória da resposta; a falha vira aviso no turno, nunca derruba a resposta. */
  function remember(answer: string): { text: string; memory?: string[] } {
    const { text, ops } = extractMemoryOps(answer)
    if (ops.length === 0) return { text }
    try {
      applyMemoryOps(homeDir, ops)
      return { text, memory: ops.map(describeMemoryOp) }
    } catch (err) {
      return { text, memory: [`Não guardei na memória: ${err instanceof Error ? err.message : String(err)}`] }
    }
  }

  async function runTurn(p: Project, question: Omit<ChatAgentInput, 'cwd' | 'history'>, history: ChatAgentInput['history']) {
    const wt = copyPath(p)
    let head: string | undefined
    let reply: StoredTurn
    try {
      head = await git.prepare(p.path, wt)
      const { context, skills } = contextOf(p, question.prompt, history)
      const { text: raw } = await agent({ ...question, cwd: wt, history, context })
      if (typeof raw !== 'string') throw new Error('o agente não devolveu texto')
      const collected = await git.collect(wt, head)
      const { text, memory } = remember(raw)
      reply = { id: `T-${crypto.randomUUID()}`, role: 'assistant', text, at: new Date().toISOString() }
      if (skills.length > 0) reply.skills = skills
      if (memory) reply.memory = memory
      if (collected) reply.proposal = { status: 'pendente', summary: summaryOf(text, question.prompt), ...collected }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      onError(`ade serve: o chat de ${p.id} falhou: ${message}\n`)
      reply = { id: `T-${crypto.randomUUID()}`, role: 'assistant', text: `O agente falhou: ${message}`, at: new Date().toISOString() }
      // Sobra de escrita do agente que falhou não vira proposta, mas também não se perde.
      await git.discard(wt, head ?? 'HEAD').catch((e) => onError(`ade serve: não foi possível guardar a cópia do chat de ${p.id}: ${e instanceof Error ? e.message : String(e)}\n`))
    }
    await serialized(p.path, async () => save(p, [...load(p), reply]))
  }

  return {
    read: async (p: Project): Promise<{ busy: boolean; turns: ChatTurnView[] }> => {
      const turns = load(p)
      const view: ChatTurnView[] = []
      for (const { id, role, text, at, proposal, skills, memory } of turns) {
        const turn: ChatTurnView = { id, role, text, at }
        if (skills) turn.skills = skills
        if (memory) turn.memory = memory
        if (proposal) {
          turn.proposal = { status: proposal.status, summary: proposal.summary, files: proposal.files }
          const reason = proposal.status === 'pendente' ? await git.blockedReason(p.path, proposal.head, missionRunning(p.id)) : null
          if (reason) turn.proposal.blocked_reason = reason
        }
        view.push(turn)
      }
      return { busy: busy.has(p.path), turns: view }
    },

    /** Aceita a pergunta (202) e roda o turno como atividade do projeto, liberada mesmo se o agente falhar. */
    ask: (p: Project, body: unknown): Promise<void> => {
      const question = parseQuestion(body)
      return serialized(p.path, async () => {
        if (busy.has(p.path)) throw conflict('chat_ocupado', MESSAGES.chatBusy)
        const turns = load(p)
        if (pendingOf(turns)) throw conflict('chat_proposta_pendente', MESSAGES.pending)
        const release = beginActivity(p.id, 'chat')
        busy.add(p.path)
        try {
          save(p, [...turns, { id: `T-${crypto.randomUUID()}`, role: 'user', text: question.prompt, at: new Date().toISOString() }])
        } catch (err) {
          busy.delete(p.path)
          release()
          throw err
        }
        const history = turns.map(({ role, text }) => ({ role, text }))
        runTurn(p, question, history)
          .catch((err) => onError(`ade serve: falha ao gravar o chat de ${p.id}: ${err instanceof Error ? err.message : String(err)}\n`))
          .finally(() => {
            busy.delete(p.path)
            release()
          })
      })
    },

    approve: (p: Project, id: unknown) => serialized(p.path, async () => {
      const turns = load(p)
      const turn = decidable(turns, id)
      const reason = await git.blockedReason(p.path, turn.proposal.head, missionRunning(p.id))
      if (reason) throw conflict('chat_aprovacao_travada', reason)
      const commit = await git.apply(p.path, turn.proposal)
      turn.proposal.commit = commit
      turn.proposal.status = 'aprovada'
      save(p, turns)
      // Só depois de gravada a aprovação a cópia vai para o commit; sobra ignorada do agente fica numa ref.
      // O commit já está no projeto: falha aqui não desfaz a aprovação, e o próximo turno (prepare) termina a limpeza.
      await git.discard(copyPath(p), commit).catch((e) => onError(`ade serve: aprovado, mas a cópia do chat de ${p.id} não foi limpa: ${e instanceof Error ? e.message : String(e)}\n`))
      return { ok: true, commit }
    }),

    reject: (p: Project, id: unknown) => serialized(p.path, async () => {
      const turns = load(p)
      const turn = decidable(turns, id)
      const ref = await git.discard(copyPath(p), turn.proposal.head)
      if (ref) turn.proposal.discarded_ref = ref
      turn.proposal.status = 'recusada'
      save(p, turns)
      return { ok: true, ref }
    }),

    /**
     * Começa conversa nova: a atual vai para .ade/chat/arquivo (a busca continua achando) e a proposta
     * pendente é guardada numa ref antes do descarte.
     */
    clear: (p: Project) => serialized(p.path, async () => {
      if (busy.has(p.path)) throw conflict('chat_ocupado', MESSAGES.chatBusy)
      const turns = load(p)
      const pending = pendingOf(turns)?.proposal
      const ref = pending ? await git.discard(copyPath(p), pending.head) : null
      if (turns.length > 0) writeJsonAtomic(path.join(archiveDir(p), `${p.id}-${Date.now()}.json`), { turns })
      save(p, [])
      return { ok: true, ref }
    }),
  }
}

export type ChatService = ReturnType<typeof createChat>
