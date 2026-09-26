import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createGitPort } from '../git/gitport.ts'
import { UnexpectedTreeStateError } from '../journal/errors.ts'
import { removeWorktreeKept } from './preserve.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Calcula o hash SHA-256 de package-lock.json no diretório ou null se inexistente.
 */
function lockHash(dir: string): string | null {
  const p = path.join(dir, 'package-lock.json')
  return fs.existsSync(p) ? createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null
}

/**
 * Vincula node_modules da base ao worktree por junction (Windows) ou dir (outros).
 */
export function linkNodeModules(repoDir: string, worktreeDir: string): 'linked' | 'absent' | 'already_present' {
  if (fs.existsSync(path.join(worktreeDir, 'node_modules'))) return 'already_present'
  if (!fs.existsSync(path.join(repoDir, 'node_modules'))) return 'absent'
  fs.symlinkSync(
    path.join(repoDir, 'node_modules'),
    path.join(worktreeDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  return 'linked'
}

interface PrepareStoryOptions {
  repoDir: string
  missionId: string
  storyId: string
  /** Pasta das worktrees; ausente, `.ade/wt` do projeto. Trilhos paralelos passam `lanesDir` (fora do projeto). */
  worktreesDir?: string
}

interface PrepareReadyResult {
  status: 'ready'
  worktreeDir: string
  branch: string
  baseCommit: string | null
  treeBefore: string
  nodeModules: 'linked' | 'absent' | 'already_present'
  prepareDependencyMs: number
}

interface PrepareRefusedResult {
  status: 'refused'
  reason: 'dirty_unit_branch'
  exitCode: number
  paths: string[]
}

interface PrepareAwaitingOperatorResult {
  status: 'awaiting_operator'
  reason: 'takeover_open' | 'stale_branch' | 'branch_in_use' | 'environment' | 'research_unknown_parked' | 'visual_rework_budget_exhausted'
  exitCode: number
  worktreeDir: string
  branch: string
}

type PrepareStoryResult = PrepareReadyResult | PrepareRefusedResult | PrepareAwaitingOperatorResult

/**
 * Prepara o worktree e a branch para execução da story.
 * Formato completo (substitui o incremental da story s4).
 */
export async function prepareStory(options: PrepareStoryOptions): Promise<PrepareStoryResult> {
  if (
    !options ||
    typeof options !== 'object' ||
    typeof options.repoDir !== 'string' ||
    options.repoDir.length === 0 ||
    typeof options.missionId !== 'string' ||
    !ID_PATTERN.test(options.missionId) ||
    options.missionId.includes('..') ||
    typeof options.storyId !== 'string' ||
    !ID_PATTERN.test(options.storyId) ||
    options.storyId.includes('..')
  ) {
    throw new TypeError('parâmetro de prepare inválido')
  }

  if (options.worktreesDir !== undefined && (typeof options.worktreesDir !== 'string' || !path.isAbsolute(options.worktreesDir))) {
    throw new TypeError('parâmetro de prepare inválido')
  }
  const { repoDir, missionId, storyId } = options
  const branch = `ade/${missionId}/${storyId}`
  const worktreesDir = options.worktreesDir ?? path.join(repoDir, '.ade', 'wt')
  const worktreeDir = path.join(worktreesDir, storyId)
  const basePort = createGitPort({ worktreeDir: repoDir })

  if ((options as Record<string, any>).contract?.unknowns?.some((unknown: any) => unknown.parked === true || unknown.resolved_by === 'parked')) {
    return {
      status: 'awaiting_operator',
      reason: 'research_unknown_parked',
      exitCode: 3,
      worktreeDir,
      branch,
    }
  }

  // Ordem de precedência das guardas: takeover_open -> dirty_unit_branch -> stale_branch -> branch_in_use.
  // A guarda de árvore suja é por worktree, não global (engine-durability §17): edição pendente do operador
  // na base não para a missão, porque a unidade nasce do HEAD commitado na própria worktree.

  if (fs.existsSync(path.join(worktreeDir, '.ade', 'takeover.json'))) {
    return {
      status: 'awaiting_operator',
      reason: 'takeover_open',
      exitCode: 3,
      worktreeDir,
      branch,
    }
  }

  // Reserva de 1 rodada de rework para o FQE em histórias visuais (critério 3)
  const isVisual = Boolean(
    (options as Record<string, any>).contract?.needs_ui || (options as Record<string, any>).needsUi,
  )
  if (isVisual) {
    const reworkLimit =
      (options as Record<string, any>).contract?.budget?.max_rework_rounds ??
      (options as Record<string, any>).budget?.max_rework_rounds
    const callLimit = (options as Record<string, any>).contract?.budget?.max_model_calls
    if ((reworkLimit !== undefined && reworkLimit < 1) || (callLimit !== undefined && callLimit < 2)) {
      return {
        status: 'awaiting_operator',
        reason: 'visual_rework_budget_exhausted',
        exitCode: 3,
        worktreeDir,
        branch,
      }
    }
  }

  const excludePath = await basePort.gitPath('info/exclude')
  fs.mkdirSync(path.dirname(excludePath), { recursive: true })
  const excludeContent = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : ''
  const excludeLines = excludeContent.split(/\r?\n/)
  if (!excludeLines.includes('/.ade/')) {
    const separator = excludeContent.length > 0 && !excludeContent.endsWith('\n') ? '\n' : ''
    fs.writeFileSync(excludePath, `${excludeContent}${separator}/.ade/\n`, 'utf8')
  }

  
  // Ids de parte se repetem entre missões (S1, S2…): a pasta ocupada por uma parte de outra missão (parada) é
  // liberada, com a árvore dela guardada antes em refs/ade/checkpoints; o ramo dela continua no git.
  if (fs.existsSync(worktreeDir)) {
    const occupantPort = createGitPort({ worktreeDir })
    const occupant = (await occupantPort.headInfo()).branch
    if (occupant?.startsWith('ade/') && !occupant.startsWith(`ade/${missionId}/`)) {
      await removeWorktreeKept({ gitPort: basePort, wtPort: occupantPort, worktreeDir, label: `kept/${occupant.slice(4)}` })
    }
  }

  // Sobra de worktree removido (inclusive o que o passo acima acabou de liberar): a pasta não tem mais o .git e só guarda atalhos (o node_modules ligado ao do projeto).
  // O git nela sobe até o repositório principal e responde "main"; a sobra é apagada tirando só os atalhos, nunca o
  // conteúdo para onde apontam (25/09, missão real).
  if (fs.existsSync(worktreeDir) && !fs.existsSync(path.join(worktreeDir, '.git'))) {
    const leftovers = fs.readdirSync(worktreeDir, { withFileTypes: true })
    if (leftovers.every((d) => d.isSymbolicLink())) {
      for (const d of leftovers) fs.rmSync(path.join(worktreeDir, d.name), { force: true })
      fs.rmdirSync(worktreeDir)
    }
  }

  let wtPort: ReturnType<typeof createGitPort>
  if (fs.existsSync(worktreeDir)) {
    wtPort = createGitPort({ worktreeDir })
    const wtHead = await wtPort.headInfo()
    if (wtHead.branch !== branch) {
      throw new UnexpectedTreeStateError(
        `worktree já associado à branch ${wtHead.branch ?? 'detached'}, esperada ${branch}`,
        { worktreeDir, expectedBranch: branch, actualBranch: wtHead.branch },
      )
    }
    const dirtyUnit = await wtPort.dirtyPaths()
    if (dirtyUnit.length > 0) {
      return {
        status: 'refused',
        reason: 'dirty_unit_branch',
        exitCode: 2,
        paths: dirtyUnit,
      }
    }
  } else {
    const probe = await basePort.run(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      { maxBuffer: 1 << 20, okCodes: [0, 1, 128] },
    )
    const branchExists = probe.code === 0

    if (branchExists) {
      const anc = await basePort.run(
        ['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD'],
        { maxBuffer: 1 << 20, okCodes: [0, 1] },
      )
      if (anc.code !== 0) {
        return {
          status: 'awaiting_operator',
          reason: 'stale_branch',
          exitCode: 3,
          worktreeDir,
          branch,
        }
      }

      const list = (
        await basePort.run(['worktree', 'list', '--porcelain'], { maxBuffer: 1 << 24 })
      ).stdout.toString('utf8')

      /** @param p */
      const norm = (p: string) =>
        process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)

      const blocks = list.split(/(?:\r?\n){2,}/)
      for (const block of blocks) {
        const lines = block.trim().split(/\r?\n/)
        let wtPath = ''
        let wtBranch = ''
        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            wtPath = line.slice(9).trim()
          } else if (line.startsWith('branch ')) {
            wtBranch = line.slice(7).trim()
          }
        }
        if (wtBranch === `refs/heads/${branch}` && norm(wtPath) !== norm(worktreeDir)) {
          return {
            status: 'awaiting_operator',
            reason: 'branch_in_use',
            exitCode: 3,
            worktreeDir,
            branch,
          }
        }
      }
    }

    fs.mkdirSync(worktreesDir, { recursive: true })
    const addArgs = branchExists
      ? ['worktree', 'add', worktreeDir, branch]
      : ['worktree', 'add', '-b', branch, worktreeDir, 'HEAD']
    await basePort.run(addArgs, { maxBuffer: 1 << 24 })
    wtPort = createGitPort({ worktreeDir })
  }

  const baseCommit = (await basePort.headInfo()).commit
  const treeBefore = await wtPort.worktreeTree()

  const t0 = Date.now()
  const baseHash = lockHash(repoDir)
  const wtHash = lockHash(worktreeDir)

  
  let nodeModules: 'linked' | 'absent' | 'already_present'

  if (baseHash === null && wtHash === null) {
    nodeModules = 'absent'
  } else if (baseHash !== wtHash) {
    return {
      status: 'awaiting_operator',
      reason: 'environment',
      exitCode: 3,
      worktreeDir,
      branch,
    }
  } else {
    nodeModules = linkNodeModules(repoDir, worktreeDir)
  }

  if (nodeModules === 'linked') {
    const currentExclude = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : ''
    const currentLines = currentExclude.split(/\r?\n/)
    if (!currentLines.includes('/node_modules')) {
      const sep = currentExclude.length > 0 && !currentExclude.endsWith('\n') ? '\n' : ''
      fs.writeFileSync(excludePath, `${currentExclude}${sep}/node_modules\n`, 'utf8')
    }
  }

  const prepareDependencyMs = Date.now() - t0

  return {
    status: ('ready'),
    worktreeDir,
    branch,
    baseCommit,
    treeBefore,
    nodeModules,
    prepareDependencyMs,
  }
}
