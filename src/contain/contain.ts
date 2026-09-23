import path from 'node:path'
import { UnexpectedTreeStateError } from '../journal/errors.ts'
import { pathWithin, scanBytes, scanFile, scanText } from './secrets.ts'

/**
 * Precedência fixa das violações do contain.
 */
export const PRECEDENCE: readonly ['secret','sensitive_path','scope','no_changes'] = ([
  'secret',
  'sensitive_path',
  'scope',
  'no_changes',
] as const)

/**
 * Limite fixo de bytes do diff integral. Não é configurável por quem chama:
 * varredura de segredo só vale sobre o diff inteiro (decisão do plano).
 */
const DIFF_MAX_BUFFER: number = 2 ** 31

/**
 * Caminhos padrão considerados sensíveis na árvore.
 */
export const DEFAULT_SENSITIVE_PATHS: readonly string[] = Object.freeze([
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/id_rsa',
  '**/.ssh/**',
  '**/.aws/**',
  '**/secrets/**',
])

/**
 * Compara um caminho relativo contra um padrão glob.
 *
 */
export function matchesGlob(pattern: string, relPath: string): boolean {
  if (typeof pattern !== 'string' || typeof relPath !== 'string') {
    return false
  }
  const normPattern = pattern.replace(/\\/g, '/')
  const normPath = relPath.replace(/\\/g, '/')
  const escaped = normPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?|\*/g, (m) => {
      if (m === '**/') return '(?:.*/)?'
      if (m === '**') return '.*'
      return '[^/]*'
    })
  const re = new RegExp(`^${escaped}$`)
  return re.test(normPath)
}

export type ContainViolation = {
  kind: 'secret' | 'sensitive_path' | 'scope' | 'no_changes'
  path: string | null
  pattern: string | null
  source: 'diff' | 'file' | null
}

export type ContainResult = {
  ok: boolean
  reason: 'secret' | 'sensitive_path' | 'scope' | 'no_changes' | null
  failureClass: 'security' | 'scope' | 'semantic' | null
  status: 'stop' | 'restore' | 'park' | 'rework' | 'continue'
  action: 'stop_batch' | 'restore' | 'park' | 'rework' | 'continue'
  violations: ContainViolation[]
  findings: ContainViolation[]
  changedPaths: string[]
  dirty_paths: string[]
  quarantineRef: string | null
  restoredTree: string | null
}

/**
 * Divide o texto do diff integral em seções por arquivo, cada uma com o caminho relativo
 * extraído do cabeçalho `+++ b/<path>` (ou `--- a/<path>` quando o arquivo foi apagado).
 *
 */
function splitDiffByFile(diffText: string): Array<{ path: string|null; text: string }> {
  const sections: Array<{ path: string|null; lines: string[] }> = []
  let current: { path: string|null; lines: string[] }|null = null
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { path: null, lines: [] }
      sections.push(current)
    }
    if (!current) {
      continue
    }
    current.lines.push(line)
    if (current.path === null && line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      if (p !== '/dev/null') {
        current.path = p.startsWith('b/') ? p.slice(2) : p
      }
    }
    if (current.path === null && line.startsWith('--- ')) {
      const p = line.slice(4).trim()
      if (p !== '/dev/null') {
        current.path = p.startsWith('a/') ? p.slice(2) : p
      }
    }
  }
  return sections.map((s) => ({ path: s.path, text: s.lines.join('\n') }))
}

/**
 * Coloca a árvore atual em quarentena sob refs/ade/quarantine/<unitId>/<n>.
 *
 */
async function quarantine(git: any, unitId: string): Promise<string> {
  const tree = await git.worktreeTree()
  const commit = (
    await git.run(['commit-tree', tree, '-m', 'ade quarantine ' + unitId], {
      maxBuffer: 1 << 20,
    })
  ).text
  const forEachRefRes = await git.run(
    ['for-each-ref', '--format=%(refname)', 'refs/ade/quarantine/' + unitId],
    { maxBuffer: 1 << 20 },
  )
  const rawText = typeof forEachRefRes.text === 'string' ? forEachRefRes.text : ''
  const lines = rawText
    ? rawText
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean)
    : []
  const prefix = 'refs/ade/quarantine/' + unitId + '/'
  let maxN = 0
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      const suffix = line.slice(prefix.length)
      const num = Number.parseInt(suffix, 10)
      if (!Number.isNaN(num) && String(num) === suffix && num > maxN) {
        maxN = num
      }
    }
  }
  const n = maxN + 1
  const ref = 'refs/ade/quarantine/' + unitId + '/' + n
  await git.run(['update-ref', ref, commit], { maxBuffer: 1 << 20 })
  return ref
}

export type ContainInput = {
  git?: any
  unitId?: string
  treeBefore?: string
  scopePaths?: string[]
  doNotTouch?: string[]
  sensitivePaths?: string[]
  scopeViolationCount?: number
  diffMaxBuffer?: number
}

/**
 * Executa a contenção pós-fato sobre a árvore e o diff.
 *
 */
export async function contain(input: ContainInput): Promise<ContainResult> {
  if (!input || typeof input !== 'object') {
    throw new TypeError('input inválido')
  }
  const { git } = input
  if (!git || typeof git !== 'object') {
    throw new TypeError('git inválido')
  }
  if (!Array.isArray(input.scopePaths)) {
    throw new TypeError('scopePaths inválido')
  }
  const { unitId } = input
  if (typeof unitId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(unitId)) {
    throw new TypeError('unitId inválido')
  }
  const head = await git.headInfo()
  if (!head || !head.commit) {
    throw new UnexpectedTreeStateError('worktree sem HEAD', { unitId })
  }

  const changedPaths = [...await git.dirtyPaths()].sort((a, b) => a.localeCompare(b))
  if (changedPaths.length === 0) {
    return {
      ok: false,
      status: 'rework',
      reason: 'no_changes',
      failureClass: 'semantic',
      action: 'rework',
      violations: [
        {
          kind: 'no_changes',
          path: null,
          pattern: null,
          source: null,
        },
      ],
      findings: [
        {
          kind: 'no_changes',
          path: null,
          pattern: null,
          source: null,
        },
      ],
      changedPaths: [],
      dirty_paths: [],
      quarantineRef: null,
      restoredTree: null,
    }
  }

  const diffMaxBuffer = input.diffMaxBuffer ?? DIFF_MAX_BUFFER
  const res = await git.run(
    ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--text', 'HEAD', '--'],
    { maxBuffer: diffMaxBuffer },
  )
  if (res.stdout.length >= diffMaxBuffer) {
    throw new UnexpectedTreeStateError('diff truncado por maxBuffer', {
      unitId,
      bytes: res.stdout.length,
    })
  }

  const violations: ContainViolation[] = []

  const wholeDiffFindings = scanBytes(res.stdout)
  const diffSections = splitDiffByFile(res.stdout.toString('latin1'))
  for (const section of diffSections) {
    const diffFindings = scanText(section.text)
    for (const f of diffFindings) {
      violations.push({
        kind: 'secret',
        path: section.path,
        pattern: f.pattern,
        source: 'diff',
      })
    }
  }

  if (wholeDiffFindings.length > 0) {
    for (const f of wholeDiffFindings) {
      const alreadyReported = violations.some(
        (v) => v.kind === 'secret' && v.pattern === f.pattern,
      )
      if (!alreadyReported) {
        violations.push({
          kind: 'secret',
          path: null,
          pattern: f.pattern,
          source: 'diff',
        })
      }
    }
  }

  const sensitive = input.sensitivePaths ?? DEFAULT_SENSITIVE_PATHS
  for (const rel of changedPaths) {
    const absPath = path.resolve(git.worktreeDir, rel)
    if (!pathWithin(git.worktreeDir, absPath)) {
      continue
    }

    const fileFindings = scanFile(absPath)
    for (const f of fileFindings) {
      violations.push({
        kind: 'secret',
        path: rel,
        pattern: f.pattern,
        source: 'file',
      })
    }

    const isSensitive = sensitive.some((pattern) => matchesGlob(pattern, rel))
    if (isSensitive) {
      violations.push({
        kind: 'sensitive_path',
        path: rel,
        pattern: null,
        source: null,
      })
    }

    const inScope = input.scopePaths.some((pattern) => matchesGlob(pattern, rel))
    const isDoNotTouch = (input.doNotTouch ?? []).some((pattern) => matchesGlob(pattern, rel))
    if (!inScope || isDoNotTouch) {
      violations.push({
        kind: 'scope',
        path: rel,
        pattern: null,
        source: null,
      })
    }
  }

  violations.sort((a, b) => {
    const precA = PRECEDENCE.indexOf(a.kind)
    const precB = PRECEDENCE.indexOf(b.kind)
    if (precA !== precB) {
      return precA - precB
    }
    if (a.path === null && b.path !== null) {
      return -1
    }
    if (a.path !== null && b.path === null) {
      return 1
    }
    if (a.path !== null && b.path !== null) {
      const cmp = a.path.localeCompare(b.path)
      if (cmp !== 0) {
        return cmp
      }
    }
    const patA = a.pattern ?? ''
    const patB = b.pattern ?? ''
    const patCmp = patA.localeCompare(patB)
    if (patCmp !== 0) {
      return patCmp
    }
    const srcA = a.source ?? ''
    const srcB = b.source ?? ''
    return srcA.localeCompare(srcB)
  })

  if (violations.length === 0) {
    return {
      ok: true,
      status: 'continue',
      reason: null,
      failureClass: null,
      action: 'continue',
      violations: [],
      findings: [],
      changedPaths,
      dirty_paths: changedPaths,
      quarantineRef: null,
      restoredTree: null,
    }
  }

  const reason = violations[0].kind

  if (reason === 'secret' || reason === 'sensitive_path') {
    const quarantineRef = await quarantine(git, unitId)
    return {
      ok: false,
      status: 'stop',
      reason,
      failureClass: 'security',
      action: 'stop_batch',
      violations,
      findings: violations,
      changedPaths,
      dirty_paths: changedPaths,
      quarantineRef,
      restoredTree: null,
    }
  }

  if (reason === 'scope') {
    const scopeViolationCount = input.scopeViolationCount ?? 0
    if (scopeViolationCount === 0) {
      if (typeof input.treeBefore !== 'string' || input.treeBefore.length === 0) {
        throw new TypeError('treeBefore inválido')
      }
      const restoreRes = await git.restore(input.treeBefore, { label: unitId })
      return {
        ok: false,
        status: 'restore',
        reason: 'scope',
        failureClass: 'scope',
        action: 'restore',
        violations,
        findings: violations,
        changedPaths,
        dirty_paths: changedPaths,
        quarantineRef: null,
        restoredTree: restoreRes.tree,
      }
    }
    return {
      ok: false,
      status: 'park',
      reason: 'scope',
      failureClass: 'scope',
      action: 'park',
      violations,
      findings: violations,
      changedPaths,
      dirty_paths: changedPaths,
      quarantineRef: null,
      restoredTree: null,
    }
  }

  return {
    ok: false,
    status: 'rework',
    reason: 'no_changes',
    failureClass: 'semantic',
    action: 'rework',
    violations,
    findings: violations,
    changedPaths,
    dirty_paths: changedPaths,
    quarantineRef: null,
    restoredTree: null,
  }
}
