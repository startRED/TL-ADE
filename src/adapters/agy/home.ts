// Pasta pessoal só do motor para o agy (ADR 0045). O agy lê ~/.gemini/GEMINI.md como regra global do usuário
// (`<RULE[user_global]>`) e não tem flag que desligue isso; o prefixo pedindo para ignorar não tira o texto do contexto.
// Medido em 2026-09-26: com USERPROFILE/HOME numa pasta vazia o login continua valendo (fica no cofre do sistema, não
// na pasta) e nenhuma regra, skill ou MCP do usuário entra.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Variáveis para o ambiente das chamadas ao agy: a casa passa a ser `~/.ade/agy-home`. */
export function agyEnvExtras(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const home = path.join(env.ADE_HOME ?? os.homedir(), '.ade', 'agy-home')
  fs.mkdirSync(home, { recursive: true })
  return { USERPROFILE: home, HOME: home }
}
