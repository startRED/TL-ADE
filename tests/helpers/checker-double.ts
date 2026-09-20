import fs from 'node:fs'
import path from 'node:path'
import { dispatchCodex } from '../../src/adapters/codex/index.js'
import { computeObservedInputDigest } from '../../src/engine.js'
import { createGitPort } from '../../src/git/gitport.js'

// Marcadores que o cenário do Checker falso usa no lugar da árvore e do digest verdadeiros:
// só o runtime conhece esses valores, e quem os preenche é a prova, nunca o motor.
export const TRUE_TREE = 'TRUE_TREE'
export const TRUE_DIGEST = 'TRUE_DIGEST'

/**
 * Dublê do Checker para as provas: antes de despachar, troca os marcadores do cenário pela
 * árvore observada no worktree e pelo digest correspondente, de modo que o portão de resultado
 * obsoleto do motor continue valendo de verdade.
 */
export function makeCheckerDouble(options: {
  scenarioDir: string
  contractRevision?: string
}): (opts: any) => Promise<any> {
  return async (opts: any) => {
    const wtPort = createGitPort({ worktreeDir: opts.cwd })
    const tree = await wtPort.worktreeTree()
    const changedPaths = await wtPort.dirtyPaths()
    const digest = computeObservedInputDigest({
      tree,
      changedPaths,
      contractRevision: options.contractRevision,
    })

    const checkerFile = path.join(options.scenarioDir, 'checker.json')
    if (fs.existsSync(checkerFile)) {
      const actions = JSON.parse(fs.readFileSync(checkerFile, 'utf8'))
      for (const action of actions) {
        const rev = action?.result?.input_revision
        if (!rev) continue
        if (rev.tree === TRUE_TREE) rev.tree = tree
        if (rev.digest === TRUE_DIGEST) rev.digest = digest
      }
      fs.writeFileSync(checkerFile, JSON.stringify(actions, null, 2), 'utf8')
    }

    return dispatchCodex(opts)
  }
}

/** Revisão aprovada mínima (formato 2) para cenários do Checker falso. */
export function approvedReviewAction(): { result: Record<string, unknown>; stdout: string } {
  return {
    result: {
      format_version: 2,
      contract_revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      input_revision: { tree: TRUE_TREE, digest: TRUE_DIGEST },
      verdict: 'approved',
      action_items: [],
      deferred: [],
      rejected: [],
      evidence: [
        {
          criterion: 'R1',
          result_ref: 'eval:E1',
          input_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      ],
      requested_action: 'verify',
      sources: ['eval:E1'],
      summary: 'approved by independent review',
      handoff: {
        claims: [],
        unknowns: [],
        questions_for_owner: [],
        deltas: [],
        next_action: 'verify',
        notes: 'approved',
      },
    },
    stdout: JSON.stringify({ total_cost_usd: 0.01 }),
  }
}
