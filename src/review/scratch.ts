// Cópia descartável da árvore revisada (ADR 0047). O revisor roda comandos e grava provas nela, nunca na worktree do
// maker. É uma worktree git sem ramo no HEAD do maker com a árvore revisada por cima, sem commit: o revisor vê as
// mudanças com `git diff HEAD`. O node_modules chega pelo mesmo atalho da worktree do maker (prepare.ts).
import fs from 'node:fs'
import path from 'node:path'
import { createGitPort, type GitPort } from '../git/gitport.ts'
import { linkNodeModules } from '../engine/prepare.ts'
import { isBlockingFinding, normalizeFinding } from './handoff.ts'

/** Pasta da cópia onde o revisor grava as provas; ele as cita como `artifact:.ade-review/<arquivo>`. */
export const PROOF_DIR = '.ade-review'

/** Prova executável: o comando (argv, sem shell), o código de saída e o trecho da saída que mostra o defeito. */
export type ReviewProof = { argv: string[]; exit_code: number; output: string }

export async function makeReviewCopy(opts: { wtPort: GitPort; tree: string; repoDir: string; dir: string }): Promise<void> {
  // sobra de revisão interrompida (queda do motor) no mesmo lugar
  await removeReviewCopy(opts.wtPort, opts.dir)
  fs.mkdirSync(path.dirname(opts.dir), { recursive: true })
  await opts.wtPort.run(['worktree', 'add', '--detach', opts.dir, 'HEAD'], { maxBuffer: 1 << 24 })
  const copy = createGitPort({ worktreeDir: opts.dir })
  // a árvore revisada nos arquivos e o índice de volta no HEAD: o mesmo estado da worktree do maker
  await copy.run(['read-tree', '-u', '--reset', opts.tree], { maxBuffer: 1 << 24 })
  await copy.run(['reset', '-q'], { maxBuffer: 1 << 24 })
  linkNodeModules(opts.repoDir, opts.dir)
}

export async function removeReviewCopy(wtPort: GitPort, dir: string): Promise<void> {
  // o atalho sai sozinho antes: apagar a cópia nunca pode descer no node_modules do projeto
  const link = path.join(dir, 'node_modules')
  if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(link, { force: true })
  if (fs.existsSync(dir)) {
    try {
      await wtPort.run(['worktree', 'remove', '--force', dir], { maxBuffer: 1 << 24 })
    } catch {
      // arquivo travado no Windows ou pasta que não é mais worktree: remoção direta
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  await wtPort.run(['worktree', 'prune'], { maxBuffer: 1 << 24 })
}

function isProof(p: any): p is ReviewProof {
  return Array.isArray(p?.argv) && p.argv.length > 0 && p.argv.every((a: unknown) => typeof a === 'string' && a !== '')
    && Number.isInteger(p.exit_code) && typeof p.output === 'string'
}

/** Refs `artifact:` de tudo que o revisor gravou (guardado em `dir`) e, entre elas, as provas executáveis. */
export function readReviewProofs(dir: string): { refs: string[]; proofs: Map<string, ReviewProof> } {
  const refs: string[] = []
  const proofs = new Map<string, ReviewProof>()
  let files: string[] = []
  try {
    files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => fs.statSync(path.join(dir, f)).isFile())
  } catch {
    return { refs, proofs }
  }
  for (const file of files.sort()) {
    const ref = `artifact:${PROOF_DIR}/${file.split(path.sep).join('/')}`
    refs.push(ref)
    if (!file.endsWith('.json')) continue
    try {
      // o Codex no Windows grava com BOM UTF-8, que o JSON.parse recusa (missão de rascunho, 26/09)
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, ''))
      if (isProof(parsed)) proofs.set(ref, { argv: parsed.argv, exit_code: parsed.exit_code, output: parsed.output })
    } catch {
      // JSON inválido não é prova; a ref continua existindo como arquivo
    }
  }
  return { refs, proofs }
}

/**
 * Achado que bloquearia precisa citar uma prova executável; sem ela vira `low` e não bloqueia. Com ela, a ação pedida
 * ao maker leva o comando e a saída, porque a cópia é apagada no fim da revisão (os arquivos ficam em `copiedTo`).
 */
// ponytail: a prova é conferida pela forma, não reexecutada; reexecutar o argv no motor se aparecer prova forjada
export function applyReviewProofs(findings: any[], proofs: Map<string, ReviewProof>, copiedTo: string): { findings: any[]; demoted: Array<{ id: string; severity: string }> } {
  const demoted: Array<{ id: string; severity: string }> = []
  const out = findings.map((finding, i) => {
    const normalized = normalizeFinding(finding, i)
    if (finding?.withdrawn === true || !isBlockingFinding(normalized)) return finding
    const cited = normalized.evidence_refs.filter((ref: string) => proofs.has(ref))
    if (cited.length === 0) {
      demoted.push({ id: normalized.id, severity: normalized.severity })
      return { ...finding, severity: 'low' }
    }
    const lines = cited.map((ref: string) => {
      const proof = proofs.get(ref) as ReviewProof
      return `Prova do revisor (${ref.replace(`artifact:${PROOF_DIR}/`, `${copiedTo}/`)}): \`${proof.argv.join(' ')}\` saiu ${proof.exit_code}. Saída: ${proof.output.slice(0, 800)}`
    })
    return { ...finding, required_action: [normalized.required_action, ...lines].join('\n') }
  })
  return { findings: out, demoted }
}
