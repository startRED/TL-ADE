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

function isWithinAgentsLimit(bytes: number): boolean {
  return bytes > 0 && bytes <= 8192
}

const READ_BEFORE_PATHS = [
  'PROJECT_CHARTER.md',
  'docs/plans/slice-1.md',
  'docs/adr/README.md',
  'docs/development-method.md',
]

describe('AGENTS.md e CLAUDE.md', () => {
  test('agents_md_stays_under_8kb', () => {
    expect(isWithinAgentsLimit(8192)).toBe(true)
    expect(isWithinAgentsLimit(8193)).toBe(false)
    expect(isWithinAgentsLimit(0)).toBe(false)

    const agentsPath = path.join(ROOT, 'AGENTS.md')
    expect(existsSync(agentsPath), 'AGENTS.md deve existir na raiz').toBe(true)

    const content = readFileSync(agentsPath)
    const size = Buffer.byteLength(content)
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThanOrEqual(8192)
    expect(isWithinAgentsLimit(size)).toBe(true)
  })

  test('claude_md_is_single_line_pointing_to_agents_md', () => {
    const claudePath = path.join(ROOT, 'CLAUDE.md')
    expect(existsSync(claudePath), 'CLAUDE.md deve existir na raiz').toBe(true)

    const content = readFileSync(claudePath, 'utf8')
    expect(content.trim()).toBe('@AGENTS.md')

    const nonEmptyLines = content.split(/\r?\n/).filter((line) => line.trim().length > 0)
    expect(nonEmptyLines).toHaveLength(1)
  })

  test('agents_md_routes_to_proof_commands_rules_and_existing_docs', () => {
    const agentsPath = path.join(ROOT, 'AGENTS.md')
    expect(existsSync(agentsPath), 'AGENTS.md deve existir na raiz').toBe(true)

    const content = readFileSync(agentsPath, 'utf8')

    const proofCommands = [
      'node node_modules/vitest/vitest.mjs run',
      'node node_modules/typescript/bin/tsc --noEmit',
      'npm run lint',
    ]
    for (const cmd of proofCommands) {
      expect(content).toContain(cmd)
    }

    const requiredTriggers = ['npx', 'proto/', 'maxBuffer', 'JSDoc', 'src/journal/errors.js']
    for (const trigger of requiredTriggers) {
      expect(content).toContain(trigger)
    }

    for (const docPath of READ_BEFORE_PATHS) {
      expect(content).toContain(docPath)
      expect(
        existsSync(path.join(ROOT, docPath)),
        `${docPath} listado em "Leia antes" deve existir no disco`,
      ).toBe(true)
    }
  })

  test('ci_workflow_scripts_exist_in_package_json', () => {
    const sampleWorkflow = 'steps:\n  - run: npm run coverage\n'
    const sampleScripts: Record<string, string> = { test: 'vitest' }
    const sampleMatches = [...sampleWorkflow.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1])
    const missingInSample = sampleMatches.filter((name) => !(name in sampleScripts))
    expect(missingInSample).toContain('coverage')

    expect(existsSync(CI_WORKFLOW_PATH), '.github/workflows/ci.yml deve existir').toBe(true)
    const ciContent = readFileSync(CI_WORKFLOW_PATH, 'utf8')

    const packageJsonPath = path.join(ROOT, 'package.json')
    expect(existsSync(packageJsonPath), 'package.json deve existir').toBe(true)
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(pkg.scripts, 'package.json deve conter scripts').toBeDefined()
    expect(pkg.scripts?.test, 'package.json deve conter script test').toBeDefined()

    const extractedScripts = [...ciContent.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1])
    expect(extractedScripts.length).toBeGreaterThan(0)

    for (const scriptName of extractedScripts) {
      expect(
        pkg.scripts,
        `Script "${scriptName}" do CI deve existir em package.json.scripts`,
      ).toHaveProperty(scriptName)
    }
  })
})

function findJsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...findJsFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath)
    }
  }
  return files
}

describe('execFile explicit maxBuffer guard', () => {
  test('every_git_execfile_declares_an_explicit_maxbuffer', () => {
    const srcDir = path.join(ROOT, 'src')
    const files = findJsFiles(srcDir)

    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      // Aplica a arquivos que importam execFile de child_process
      if (!/import\s*\{[^}]*\bexecFile\b(?!\s+as)/.test(content)) {
        continue
      }
      let idx = 0
      while ((idx = content.indexOf('execFile(', idx)) !== -1) {
        const snippet = content.slice(idx, idx + 400)
        expect(snippet).toContain('maxBuffer')
        expect(snippet).not.toContain('shell: true')
        idx += 'execFile('.length
      }
    }
  })
})


