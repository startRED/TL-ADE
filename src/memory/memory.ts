import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.ts'
import { scanSkill } from '../skills/skillguard.ts'

/**
 * Memória persistente entre conversas, no formato do Hermes Agent: dois arquivos de texto em ~/.ade/memory,
 * MEMORY.md (fatos do ambiente e do trabalho) e USER.md (quem é a pessoa), com entradas separadas por "\n§\n"
 * e teto de caracteres por arquivo. O modelo grava pedindo na resposta; a TL-ADE aplica, confere e mostra.
 */
export type MemoryTarget = 'memoria' | 'usuario'
export const MEMORY_TARGETS: readonly MemoryTarget[] = ['memoria', 'usuario']
export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memoria: 2200, usuario: 1375 }

export type MemoryOp =
  | { op: 'add'; target: MemoryTarget; text: string }
  | { op: 'replace'; target: MemoryTarget; old: string; text: string }
  | { op: 'remove'; target: MemoryTarget; old: string }

const DELIMITER = '\n§\n'
const FILES: Record<MemoryTarget, string> = { memoria: 'MEMORY.md', usuario: 'USER.md' }
const TITLES: Record<MemoryTarget, string> = { memoria: 'MEMÓRIA (suas notas sobre o ambiente e o trabalho)', usuario: 'PERFIL DA PESSOA (quem ela é e como prefere trabalhar)' }

// Injeção e vazamento, além dos padrões do SkillGuard (lição threat_patterns do Hermes).
const INJECTION = [
  /\b(ignore|disregard|forget)\b.{0,20}\b(previous|prior|above|all)\b.{0,20}\binstructions?\b/i,
  /\b(ignore|esque[çc]a|desconsidere)\b.{0,20}\binstru[çc][õo]es\b/i,
  /\bsystem prompt\b/i,
]

const fileOf = (home: string, target: MemoryTarget) => path.join(home, '.ade', 'memory', FILES[target])
const invalid = (message: string) => new AdeError('memoria_invalida', message, 2)

export function readMemory(home: string, target: MemoryTarget): string[] {
  const file = fileOf(home, target)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(DELIMITER).map((e) => e.trim()).filter(Boolean)
}

const sizeOf = (entries: string[]) => entries.join(DELIMITER).length

/** Motivo de recusa de uma entrada nova, ou null se ela pode entrar. */
export function unsafeReason(text: string): string | null {
  const { findings } = scanSkill({ files: { 'MEMORY.md': text } })
  if (findings.length > 0) return `padrão bloqueado (${findings.join(', ')})`
  return INJECTION.some((r) => r.test(text) || r.test(text.normalize('NFKC'))) ? 'parece instrução para o modelo, não fato' : null
}

/** Uma entrada pelo trecho: nenhum ou mais de um casamento é erro, para não trocar a entrada errada. */
function locate(entries: string[], old: string): number {
  if (!old.trim()) throw invalid('Diga o trecho da entrada a trocar ou apagar.')
  const exact = entries.indexOf(old.trim())
  if (exact >= 0) return exact
  const hits = entries.flatMap((e, i) => (e.includes(old) ? [i] : []))
  if (hits.length === 0) throw invalid(`Nenhuma entrada contém "${old}".`)
  if (hits.length > 1) throw invalid(`Mais de uma entrada contém "${old}"; use um trecho mais longo.`)
  return hits[0]
}

/**
 * Aplica as operações de uma vez: o teto é conferido só no resultado final (dá para liberar espaço e somar
 * na mesma resposta), e qualquer erro deixa os arquivos como estavam.
 */
export function applyMemoryOps(home: string, ops: MemoryOp[]): Record<MemoryTarget, string[]> {
  const next: Record<MemoryTarget, string[]> = { memoria: readMemory(home, 'memoria'), usuario: readMemory(home, 'usuario') }
  for (const op of ops) {
    if (!MEMORY_TARGETS.includes(op.target)) throw invalid(`Alvo inválido: use ${MEMORY_TARGETS.join(' ou ')}.`)
    const entries = next[op.target]
    if (op.op !== 'remove') {
      const text = op.text.trim()
      if (!text) throw invalid('Entrada de memória vazia.')
      if (text.includes('§')) throw invalid('Entrada de memória não pode conter §.')
      const reason = unsafeReason(text)
      if (reason) throw invalid(`Memória recusada: ${reason}.`)
      if (op.op === 'add') {
        if (!entries.includes(text)) entries.push(text)
      } else entries[locate(entries, op.old)] = text
    } else entries.splice(locate(entries, op.old), 1)
  }
  for (const target of MEMORY_TARGETS) {
    const used = sizeOf(next[target])
    if (used > MEMORY_LIMITS[target]) {
      throw invalid(`A ${target} ficaria com ${used}/${MEMORY_LIMITS[target]} caracteres. Junte ou apague entradas antigas antes de somar.`)
    }
  }
  for (const target of MEMORY_TARGETS) {
    const file = fileOf(home, target)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, next[target].join(DELIMITER))
    fs.renameSync(tmp, file)
  }
  return next
}

/** Operações vindas do painel ({ ops: [...] }), conferidas campo a campo. */
export function parseMemoryOps(body: unknown): MemoryOp[] {
  const ops = (body as { ops?: unknown })?.ops
  if (!Array.isArray(ops) || ops.length === 0) throw invalid('Envie ops com pelo menos uma operação.')
  return ops.map((raw) => {
    const { op, target, text, old } = (raw ?? {}) as Record<string, unknown>
    if (!MEMORY_TARGETS.includes(target as MemoryTarget)) throw invalid(`Alvo inválido: use ${MEMORY_TARGETS.join(' ou ')}.`)
    const str = (v: unknown, name: string) => {
      if (typeof v !== 'string') throw invalid(`${name} deve ser texto.`)
      return v
    }
    if (op === 'add') return { op, target: target as MemoryTarget, text: str(text, 'text') }
    if (op === 'replace') return { op, target: target as MemoryTarget, old: str(old, 'old'), text: str(text, 'text') }
    if (op === 'remove') return { op, target: target as MemoryTarget, old: str(old, 'old') }
    throw invalid('op deve ser add, replace ou remove.')
  })
}

/** Bloco da memória para o prompt, com o uso de cada arquivo (o modelo vê quando precisa consolidar). */
export function memoryPromptBlock(home: string): string {
  const rule = '═'.repeat(46)
  const blocks = MEMORY_TARGETS.map((target) => {
    const entries = readMemory(home, target).filter((e) => !unsafeReason(e))
    const used = sizeOf(entries)
    const pct = Math.round((used / MEMORY_LIMITS[target]) * 100)
    return [rule, `${TITLES[target]} [${pct}% — ${used}/${MEMORY_LIMITS[target]}]`, rule, entries.join(DELIMITER) || '(vazia)'].join('\n')
  })
  return [
    ...blocks,
    [
      'Para guardar um fato que vale para TODAS as próximas conversas, escreva no fim da resposta uma destas marcas (a TL-ADE aplica e tira do texto):',
      '<memoria alvo="usuario">A pessoa prefere respostas curtas</memoria>  (soma uma entrada)',
      '<memoria alvo="memoria" troca="trecho da entrada antiga">entrada nova inteira</memoria>  (troca a entrada)',
      '<memoria alvo="memoria" apaga="trecho da entrada"/>  (apaga a entrada)',
      'alvo="usuario" é quem a pessoa é e como prefere trabalhar; alvo="memoria" é fato do ambiente, das ferramentas e do trabalho. Um fato vai para um só.',
      'Escreva fatos declarativos ("A pessoa prefere X"), nunca ordens para você mesmo. Não guarde o óbvio, dados brutos, progresso de tarefa nem nada que se descobre de novo fácil. Perto do teto, troque ou junte entradas antigas em vez de deixar de guardar.',
    ].join('\n'),
  ].join('\n\n')
}

const MARK = /<memoria\s+alvo="([^"]*)"(?:\s+(troca|apaga)="([^"]*)")?\s*(?:\/>|>([\s\S]*?)<\/memoria>)/g

/** Marcas de memória da resposta viram operações; o texto volta sem elas. */
export function extractMemoryOps(answer: string): { text: string; ops: MemoryOp[] } {
  const ops: MemoryOp[] = []
  const text = answer.replace(MARK, (_all, alvo: string, kind: string | undefined, old: string | undefined, body: string | undefined) => {
    const target = alvo as MemoryTarget
    if (kind === 'apaga') ops.push({ op: 'remove', target, old: old ?? '' })
    else if (kind === 'troca') ops.push({ op: 'replace', target, old: old ?? '', text: body ?? '' })
    else ops.push({ op: 'add', target, text: body ?? '' })
    return ''
  })
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), ops }
}

/** Resumo em português de cada operação, para a pessoa ver o que foi guardado. */
export function describeMemoryOp(op: MemoryOp): string {
  const [em, de] = op.target === 'usuario' ? ['no perfil', 'do perfil'] : ['na memória', 'da memória']
  if (op.op === 'add') return `Guardei ${em}: ${op.text.trim()}`
  if (op.op === 'replace') return `Atualizei ${em}: ${op.text.trim()}`
  return `Apaguei ${de} a entrada com "${op.old}"`
}
