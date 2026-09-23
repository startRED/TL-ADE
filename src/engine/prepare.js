import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createGitPort } from '../git/gitport.ts'
import { UnexpectedTreeStateError } from '../journal/errors.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Calcula o hash SHA-256 de package-lock.json no diretório ou null se inexistente.
 *
 * @param {string} dir
 * @returns {string | null}
 */
function lockHash(dir) {
  const p = path.join(dir, 'package-lock.json')
  return fs.existsSync(p) ? createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null
}

/**
 * Vincula node_modules da base ao worktree por junction (Windows) ou dir (outros).
 *
 * @param {string} repoDir
 * @param {string} worktreeDir
 * @returns {'linked' | 'absent' | 'already_present'}
 */
function linkNodeModules(repoDir, worktreeDir) {
  if (fs.existsSync(path.join(worktreeDir, 'node_modules'))) return 'already_present'
  if (!fs.existsSync(path.join(repoDir, 'node_modules'))) return 'absent'
  fs.symlinkSync(
    path.join(repoDir, 'node_modules'),
    path.join(worktreeDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  return 'linked'
}

/**
 * @typedef {Object} PrepareStoryOptions
 * @property {string} repoDir
 * @property {string} missionId
 * @property {string} storyId
 */

/**
 * @typedef {Object} PrepareReadyResult
 * @property {'ready'} status
 * @property {string} worktreeDir
 * @property {string} branch
 * @property {string | null} baseCommit
 * @property {string} treeBefore
 * @property {'linked' | 'absent' | 'already_present'} nodeModules
 * @property {number} prepareDependencyMs
 */

/**
 * @typedef {Object} PrepareRefusedResult
 * @property {'refused'} status
 * @property {'dirty_worktree' | 'dirty_unit_branch'} reason
 * @property {number} exitCode
 * @property {string[]} paths
 */

/**
 * @typedef {Object} PrepareAwaitingOperatorResult
 * @property {'awaiting_operator'} status
 * @property {'takeover_open' | 'stale_branch' | 'branch_in_use' | 'environment' | 'research_unknown_parked' | 'visual_rework_budget_exhausted'} reason
 * @property {number} exitCode
 * @property {string} worktreeDir
 * @property {string} branch
 */

/**
 * @typedef {PrepareReadyResult | PrepareRefusedResult | PrepareAwaitingOperatorResult} PrepareStoryResult
 */

/**
 * Prepara o worktree e a branch para execução da story.
 * Formato completo (substitui o incremental da story s4).
 *
 * @param {PrepareStoryOptions} options
 * @returns {Promise<PrepareStoryResult>}
 */
export async function prepareStory(options) {
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

  const { repoDir, missionId, storyId } = options
  const branch = `ade/${missionId}/${storyId}`
  const worktreeDir = path.join(repoDir, '.ade', 'wt', storyId)
  const basePort = createGitPort({ worktreeDir: repoDir })

  if (/** @type {any} */ (options).contract?.unknowns?.some((/** @type {any} */ unknown) => unknown.parked === true || unknown.resolved_by === 'parked')) {
    return {
      status: 'awaiting_operator',
      reason: 'research_unknown_parked',
      exitCode: 3,
      worktreeDir,
      branch,
    }
  }

  // Ordem de precedência das guardas: dirty_worktree -> takeover_open -> dirty_unit_branch -> stale_branch -> branch_in_use
  const dirty = (await basePort.dirtyPaths()).filter(
    (p) => !p.startsWith('.ade/') && !p.startsWith('.ade\\') && p !== '.ade',
  )
  if (dirty.length > 0) {
    return {
      status: 'refused',
      reason: 'dirty_worktree',
      exitCode: 2,
      paths: dirty,
    }
  }

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
    /** @type {any} */ (options).contract?.needs_ui || /** @type {any} */ (options).needsUi,
  )
  if (isVisual) {
    const reworkLimit =
      /** @type {any} */ (options).contract?.budget?.max_rework_rounds ??
      /** @type {any} */ (options).budget?.max_rework_rounds
    const callLimit = /** @type {any} */ (options).contract?.budget?.max_model_calls
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

  /** @type {ReturnType<typeof createGitPort>} */
  let wtPort
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

      /** @param {string} p */
      const norm = (p) =>
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

    fs.mkdirSync(path.join(repoDir, '.ade', 'wt'), { recursive: true })
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

  /** @type {'linked' | 'absent' | 'already_present'} */
  let nodeModules

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
    status: /** @type {const} */ ('ready'),
    worktreeDir,
    branch,
    baseCommit,
    treeBefore,
    nodeModules,
    prepareDependencyMs,
  }
}
