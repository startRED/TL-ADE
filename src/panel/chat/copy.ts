import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGitPort, type GitPort } from '../../git/gitport.ts'
import { AdeError } from '../../journal/errors.ts'
import type { DiffFile } from '../units.ts'

/** Motivos em português das travas do chat (lições de proto/chat-changes.mjs e proto/server.mjs). */
export const MESSAGES = {
  busy: 'Tem uma missão rodando nesta pasta. Espere ela terminar para aprovar.',
  dirty: 'A pasta tem alterações suas ainda não commitadas. Commite ou descarte antes de aprovar.',
  stale: 'O projeto mudou depois desta proposta. Peça a mudança de novo.',
  noHead: 'A pasta precisa ter pelo menos um commit antes de o chat propor mudanças.',
  pending: 'Decida o cartão anterior (Aprovar ou Recusar) antes de perguntar de novo.',
  chatBusy: 'O chat ainda está respondendo a pergunta anterior.',
} as const

// A cópia assina os próprios commits: o projeto não precisa ter identidade git configurada.
const IDENTITY = ['-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local']
const MAX = { maxBuffer: 1 << 26 }

export interface Collected { head: string; tree: string; files: DiffFile[] }

/** Linhas marcadas do patch de um arquivo; a linha @@ de cada trecho entra como contexto. */
function hunkLines(patch: string): DiffFile['lines'] {
  const lines: DiffFile['lines'] = []
  let inHunk = false
  for (const line of patch.split('\n')) {
    // Troca de tipo (arquivo ↔ link) sai em dois patches: o cabeçalho do segundo não é linha de trecho.
    if (line.startsWith('diff --git ')) inHunk = false
    else if (line.startsWith('@@')) {
      inHunk = true
      lines.push({ kind: 'ctx', text: line })
    } else if (inHunk && line !== '' && line !== '\\ No newline at end of file') {
      lines.push({ kind: line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx', text: line.slice(1) })
    }
  }
  return lines
}

/** Portas git do projeto e da cópia; uma por pasta, porque cada porta aloca a própria pasta de hooks. */
export function createChatGit() {
  const ports = new Map<string, GitPort>()
  const port = (dir: string) => {
    let p = ports.get(dir)
    if (!p) ports.set(dir, (p = createGitPort({ worktreeDir: dir })))
    return p
  }

  const treeOf = async (dir: string, rev: string) => (await port(dir).run(['rev-parse', `${rev}^{tree}`], MAX)).text

  /** Árvore com tudo o que está na cópia, até o que o .gitignore esconde; parte do índice real, como worktreeTree. */
  async function fullTree(wt: string): Promise<string> {
    const git = port(wt)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-chat-idx-'))
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') }
    try {
      const real = await git.gitPath('index')
      if (fs.existsSync(real)) {
        fs.copyFileSync(real, env.GIT_INDEX_FILE)
        fs.utimesSync(env.GIT_INDEX_FILE, 1, 1)
      }
      await git.run(['add', '-A', '--force'], { ...MAX, env })
      return (await git.run(['write-tree'], { ...MAX, env })).text
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  /** Guarda o que a cópia tem além de `base`, inclusive arquivo ignorado, em refs/ade/descartada/<hora>; nunca apaga sem guardar. */
  async function preserve(wt: string, base: string): Promise<string | null> {
    const git = port(wt)
    const tree = await fullTree(wt)
    if (tree === await treeOf(wt, base)) return null
    const commit = (await git.run([...IDENTITY, 'commit-tree', tree, '-p', base, '-m', 'ade chat: proposta descartada'], MAX)).text
    const ref = `refs/ade/descartada/${new Date().toISOString().replace(/[-:.]/g, '')}`
    // Valor antigo vazio: a ref não pode existir, então duas descartadas no mesmo milissegundo falham alto.
    await git.run(['update-ref', ref, commit, ''], MAX)
    return ref
  }

  /** Devolve a cópia a `commit` por inteiro, sem sobra do agente, nem ignorada nem commitada (I20: clean antes). */
  async function restore(wt: string, commit: string): Promise<void> {
    await port(wt).run(['clean', '-ffdxq'], MAX)
    await port(wt).run(['reset', '-q', '--hard', commit], MAX)
  }

  return {
    /** Cópia git (worktree destacado) do HEAD do projeto; sobra de turno anterior vai para ref antes. Devolve esse HEAD. */
    async prepare(repoDir: string, wt: string): Promise<string> {
      const project = port(repoDir)
      const head = (await project.headInfo()).commit
      if (!head) throw new AdeError('chat_sem_commit', MESSAGES.noHead, 5)
      // .ade fica fora do git do projeto: senão o lease e a própria cópia deixariam a pasta "suja".
      const excludePath = await project.gitPath('info/exclude')
      const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : ''
      if (!current.split(/\r?\n/).includes('/.ade/')) {
        fs.mkdirSync(path.dirname(excludePath), { recursive: true })
        fs.writeFileSync(excludePath, `${current}${current && !current.endsWith('\n') ? '\n' : ''}/.ade/\n`, 'utf8')
      }
      if (fs.existsSync(path.join(wt, '.git'))) {
        await preserve(wt, 'HEAD')
        await restore(wt, head)
      } else {
        await project.run(['worktree', 'prune'], MAX)
        fs.mkdirSync(path.dirname(wt), { recursive: true })
        await project.run(['worktree', 'add', '--detach', wt, head], MAX)
      }
      return head
    },

    /** Mudanças da cópia contra o `head` de quando ela foi preparada, mesmo que o agente tenha commitado; null se nada mudou. */
    async collect(wt: string, head: string): Promise<Collected | null> {
      const git = port(wt)
      const tree = await git.worktreeTree()
      const base = await treeOf(wt, head)
      if (tree === base) return null
      const range = ['--no-renames', base, tree]
      // Nomes pela saída -z, que o git não cita, e o patch de cada um à parte: acento, aspas e espaço chegam intactos.
      const names = (await git.run(['diff', '--name-only', '-z', ...range], MAX)).stdout.toString('utf8').split('\0').filter(Boolean)
      const files: DiffFile[] = []
      for (const file of names) {
        const patch = await git.run(['diff', '--no-color', '--no-ext-diff', ...range, '--', `:(literal)${file}`], MAX)
        files.push({ file, lines: hunkLines(patch.stdout.toString('utf8')) })
      }
      return { head, tree, files }
    },

    /** Motivo que impede aplicar a proposta agora, ou null (lição canApprove). */
    async blockedReason(repoDir: string, proposalHead: string, missionRunning: boolean): Promise<string | null> {
      if (missionRunning) return MESSAGES.busy
      const project = port(repoDir)
      if ((await project.run(['status', '--porcelain'], MAX)).text) return MESSAGES.dirty
      if ((await project.headInfo()).commit !== proposalHead) return MESSAGES.stale
      return null
    },

    /** Commita a árvore proposta sobre o HEAD da cópia e avança o projeto só por fast-forward. */
    async apply(repoDir: string, proposal: { head: string; tree: string; summary: string }): Promise<string> {
      const message = `chat: ${proposal.summary.length > 72 ? `${proposal.summary.slice(0, 71)}…` : proposal.summary}`
      const project = port(repoDir)
      const commit = (await project.run([...IDENTITY, 'commit-tree', proposal.tree, '-p', proposal.head, '-m', message], MAX)).text
      await project.run(['merge', '--ff-only', '-q', commit], MAX)
      return commit
    },

    /** Guarda numa ref o que a cópia tem além de `base` e a devolve a `base`. */
    async discard(wt: string, base: string): Promise<string | null> {
      if (!fs.existsSync(path.join(wt, '.git'))) return null
      const ref = await preserve(wt, base)
      await restore(wt, base)
      return ref
    },
  }
}
