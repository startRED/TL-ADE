import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const CHARTER_PATH = fileURLToPath(new URL('../PROJECT_CHARTER.md', import.meta.url))
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CI_WORKFLOW_PATH = path.join(ROOT, '.github/workflows/ci.yml')

const ROOT_ALLOWLIST = new Set([
  // Versionados (18)
  '.github',
  '.gitignore',
  '.oxlintrc.json',
  'AGENTS.md',
  'CLAUDE.md',
  'PROJECT_CHARTER.md',
  'PROMPT.md',
  'README.md',
  'docs',
  'fixtures',
  'package.json',
  'package-lock.json',
  'proto',
  'schemas',
  'src',
  'tests',
  'tsconfig.json',
  'vitest.config.mjs',
  // Locais ignorados (6)
  '.git',
  '.claude',
  '.ade',
  '.ade-attachments',
  '.ade-vitest.json',
  'node_modules',
])

function unexpectedRootEntries(entries: string[]): string[] {
  return entries.filter((name) => !ROOT_ALLOWLIST.has(name))
}

// AC4: PROJECT_CHARTER.md existe na raiz e diz o que a ADE é, o que não é e o
// que não pode entrar no código nesta fatia.
describe('PROJECT_CHARTER.md', () => {
  test('project_charter_declares_what_ade_is_is_not_and_scope_limits', () => {
    expect(existsSync(CHARTER_PATH)).toBe(true)

    const charter = readFileSync(CHARTER_PATH, 'utf8')
    const normalized = charter.toLowerCase()

    // o que a ADE é
    expect(normalized).toContain('a ade é')
    // o que a ADE não é
    expect(normalized).toContain('não é')
    // o que não pode entrar no código nesta fatia (regra de ampliação de escopo)
    expect(normalized).toContain('fatia')
    expect(normalized).toContain('src/')
  })
})

describe('root directory guard', () => {
  test('root_directory_contains_only_allowlisted_entries', () => {
    const entries = readdirSync(ROOT)
    const unexpected = unexpectedRootEntries(entries)
    expect(unexpected, `Entradas inesperadas na raiz: ${unexpected.join(', ')}`).toEqual([])
  })

  test('root_guard_reports_entries_outside_allowlist', () => {
    expect(unexpectedRootEntries(['src', 'tmp.txt'])).toEqual(['tmp.txt'])
    expect(unexpectedRootEntries([])).toEqual([])
    expect(unexpectedRootEntries(['node_modules', '.git', '.claude'])).toEqual([])
    expect(unexpectedRootEntries(['Src', 'AGENTS.md'])).toEqual(['Src'])
  })
})

describe('ci workflow', () => {
  test('ci_workflow_runs_three_gates_on_windows_and_linux_node_22_and_24', () => {
    expect(existsSync(CI_WORKFLOW_PATH), '.github/workflows/ci.yml deve existir').toBe(true)

    const content = readFileSync(CI_WORKFLOW_PATH, 'utf8')
    expect(content).toContain('windows-latest')
    expect(content).toContain('ubuntu-latest')
    expect(content).toContain('22')
    expect(content).toContain('24')
    expect(content).toContain('npm ci')
    expect(content).toContain('npm run typecheck')
    expect(content).toContain('npm run lint')
    expect(content).toContain('npm test')
    expect(content).not.toContain('npx')
  })
})

