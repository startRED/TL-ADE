import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { AdeError } from '../../journal/errors.ts'

const require = createRequire(import.meta.url)

export interface ChatHit {
  project: string
  /** "atual" ou o nome do arquivo da conversa arquivada. */
  conversation: string
  turn: string
  role: 'user' | 'assistant'
  at: string
  /** Trecho com os termos achados entre « ». */
  snippet: string
}

const WORD = /[\p{L}\p{N}_]+/gu

/**
 * Texto livre em consulta FTS5 que nunca quebra (lição da sanitização do Hermes, mais estrita): cada palavra
 * vira termo entre aspas e "frase entre aspas" continua frase; nenhum operador do FTS5 passa.
 */
export function ftsQuery(raw: string, joiner = ' '): string {
  const terms: string[] = []
  const rest = raw.slice(0, 300).replace(/"([^"]*)"/g, (_all, phrase: string) => {
    const words = phrase.match(WORD)
    if (words) terms.push(`"${words.join(' ')}"`)
    return ' '
  })
  for (const w of rest.match(WORD) ?? []) terms.push(`"${w}"`)
  return terms.join(joiner)
}

function conversations(p: { id: string; path: string }): Array<{ name: string; file: string }> {
  const dir = path.join(p.path, '.ade', 'chat')
  const archive = path.join(dir, 'arquivo')
  const list = [{ name: 'atual', file: path.join(dir, `${p.id}.json`) }]
  if (fs.existsSync(archive)) {
    for (const f of fs.readdirSync(archive).sort()) if (f.endsWith('.json')) list.push({ name: f.slice(0, -5), file: path.join(archive, f) })
  }
  return list.filter((c) => fs.existsSync(c.file))
}

/**
 * Busca nas conversas atuais e arquivadas dos projetos abertos, mais relevantes primeiro. O índice FTS5 é
 * montado na memória a cada busca, a partir dos arquivos duráveis do chat: nada a sincronizar.
 * ponytail: remonta tudo por busca; índice persistente quando as conversas passarem de dezenas de milhares de turnos.
 */
export function searchChats(projects: Array<{ id: string; path: string }>, raw: unknown, limit = 10): ChatHit[] {
  if (typeof raw !== 'string') throw new AdeError('busca_invalida', 'Informe o texto da busca em q.', 2)
  const match = ftsQuery(raw)
  if (!match) return []
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  try {
    db.exec('CREATE VIRTUAL TABLE t USING fts5(text, project UNINDEXED, conversation UNINDEXED, turn UNINDEXED, role UNINDEXED, at UNINDEXED)')
    const insert = db.prepare('INSERT INTO t VALUES (?, ?, ?, ?, ?, ?)')
    db.transaction(() => {
      for (const p of projects) {
        for (const c of conversations(p)) {
          const turns = JSON.parse(fs.readFileSync(c.file, 'utf8'))?.turns
          if (!Array.isArray(turns)) throw new AdeError('chat_historico_invalido', `Histórico do chat corrompido em ${c.file}.`, 2)
          for (const t of turns) insert.run(String(t.text ?? ''), p.id, c.name, String(t.id), t.role, String(t.at))
        }
      }
    })()
    const query = db.prepare("SELECT project, conversation, turn, role, at, snippet(t, 0, '«', '»', '…', 16) AS snippet FROM t WHERE t MATCH ? ORDER BY rank LIMIT ?")
    const rows: ChatHit[] = query.all(match, limit)
    // Nada com todos os termos: tenta com qualquer um deles (fallback OR do Hermes).
    return rows.length > 0 || !match.includes(' ') ? rows : query.all(ftsQuery(raw, ' OR '), limit)
  } finally {
    db.close()
  }
}
