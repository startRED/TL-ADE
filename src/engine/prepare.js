import fs from 'node:fs'
import path from 'node:path'
import { createGitPort } from '../git/gitport.js'
import { UnexpectedTreeStateError } from '../journal/errors.js'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

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
 */

/**
 * @typedef {Object} PrepareRefusedResult
 * @property {'refused'} status
 * @property {'dirty_worktree' | 'dirty_unit_branch'} reason
 * @property {number} exitCode
 * @property {string[]} paths
 */

/**
 * @typedef {PrepareReadyResult | PrepareRefusedResult} PrepareStoryResult
 */

/**
 * Prepara o worktree e a branch para execução da story.
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
    fs.mkdirSync(path.join(repoDir, '.ade', 'wt'), { recursive: true })
    await basePort.run(['worktree', 'add', '-b', branch, worktreeDir, 'HEAD'], {
      maxBuffer: 1 << 24,
    })
    wtPort = createGitPort({ worktreeDir })
  }

  const baseCommit = (await basePort.headInfo()).commit
  const treeBefore = await wtPort.worktreeTree()

  return {
    status: 'ready',
    worktreeDir,
    branch,
    baseCommit,
    treeBefore,
  }
}
