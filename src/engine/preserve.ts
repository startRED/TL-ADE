import fs from 'node:fs'
import { matchesGlob } from '../contain/contain.ts'
import type { GitPort } from '../git/gitport.ts'

/**
 * A árvore suja pertence à parte? Dentro do escopo, sempre. Parte interrompida (pausa, queda do motor
 * ou do PC no meio dela): é dela por construção, e arquivo fora do escopo é assunto do revisor, não
 * motivo para apagar o trabalho. Arquivo proibido (do_not_touch) nunca: aí a árvore tem mão de fora.
 * Lição da demo (m-mu8usf5z, v0.5 V05-01): o continuar ia descartar 16 arquivos no escopo por 1 fora dele.
 */
export function treeBelongs(files: string[], { scope = [], blocked = [], interrupted = false }: { scope?: string[]; blocked?: string[]; interrupted?: boolean }): boolean {
  if (files.some((f) => blocked.some((g) => matchesGlob(g, f)))) return false
  if (interrupted) return true
  return scope.length > 0 && files.every((f) => scope.some((g) => matchesGlob(g, f)))
}

/**
 * Retomada de parte interrompida: a árvore medida contra o `tree_before` da parte vai sempre para uma
 * ref sob refs/ade/. Se pertence à parte, fica no lugar e a parte recomeça sobre ela; se toca
 * do_not_touch, volta a `tree_before` e a árvore interrompida só fica na ref de descarte.
 */
export async function preserveInterruptedTree({ gitPort, treeBefore, label, scope, blocked }: { gitPort: GitPort; treeBefore: string; label: string; scope: string[]; blocked: string[] }): Promise<{ files: string[]; ref: string | null; reapplied: boolean }> {
  const files = await gitPort.dirtyPaths(treeBefore)
  if (files.length === 0) return { files, ref: null, reapplied: false }
  if (treeBelongs(files, { scope, blocked, interrupted: true })) {
    const { ref } = await gitPort.checkpoint(label)
    return { files, ref, reapplied: true }
  }
  const { discardedRef } = await gitPort.restoreTree(treeBefore, { label })
  return { files, ref: discardedRef, reapplied: false }
}

/**
 * Remove a worktree de uma parte guardando antes a árvore dela em refs/ade/checkpoints/<label>/<n>.
 * Devolve a ref.
 */
export async function removeWorktreeKept({ gitPort, wtPort, worktreeDir, label }: { gitPort: GitPort; wtPort: GitPort; worktreeDir: string; label: string }): Promise<string> {
  const { ref } = await wtPort.checkpoint(label)
  try {
    await gitPort.run(['worktree', 'remove', '--force', worktreeDir], { maxBuffer: 1 << 24 })
  } catch {
    // `worktree remove` recusa worktree com arquivos travados no Windows; a remoção direta
    // seguida de prune é o fallback, e falha dela sobe.
    fs.rmSync(worktreeDir, { recursive: true, force: true })
    await gitPort.run(['worktree', 'prune'], { maxBuffer: 1 << 24 })
  }
  return ref
}
