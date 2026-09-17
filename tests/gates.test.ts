import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { digest16 } from '../src/journal/canonical.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

// Provas do portão de tipos sem build (checkJs)
describe('typecheck gate', () => {
  // AC1: tsconfig.json e package.json devidamente configurados sem passo de build
  test('typecheck_gate_is_configured_without_build', () => {
    const tsconfigPath = path.join(ROOT, 'tsconfig.json')
    expect(existsSync(tsconfigPath), 'tsconfig.json deve existir na raiz').toBe(true)

    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'))
    expect(tsconfig.compilerOptions?.allowJs).toBe(true)
    expect(tsconfig.compilerOptions?.checkJs).toBe(true)
    expect(tsconfig.compilerOptions?.strict).toBe(true)
    expect(tsconfig.compilerOptions?.noEmit).toBe(true)
    expect(tsconfig.compilerOptions?.module).toBe('NodeNext')
    expect(tsconfig.compilerOptions?.moduleResolution).toBe('NodeNext')
    expect(tsconfig.include).toContain('src/**/*.js')
    expect(tsconfig.include).toContain('tests/**/*.ts')

    const pkgPath = path.join(ROOT, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    expect(pkg.scripts?.typecheck).toBe('node node_modules/typescript/bin/tsc --noEmit')
    expect(pkg.devDependencies?.typescript).toBeDefined()
  })

  // AC2: node node_modules/typescript/bin/tsc --noEmit roda na raiz e sai com código 0
  test('typecheck_gate_exits_zero_over_src_and_tests', () => {
    const result = spawnSync(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '--noEmit'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
    const output = `status: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr ?? ''}`
    expect(result.status, output).toBe(0)
    expect(result.stdout).toBe('')
  }, 180000)

  // AC3: tsc falha em arquivo com erro de tipo contendo TS2322
  test('typecheck_gate_fails_on_type_error', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'ade-tsc-'))
    try {
      const badFile = path.join(tmpDir, 'bad.js')
      writeFileSync(badFile, "/** @type {number} */\nconst n = 'x'\n", 'utf8')

      const result = spawnSync(
        process.execPath,
        [
          'node_modules/typescript/bin/tsc',
          '--noEmit',
          '--allowJs',
          '--checkJs',
          '--strict',
          badFile,
        ],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
      )
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain('TS2322')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 180000)

  // AC4: sem supressões de tipos, src/ permanece .js e digest16({}) continua 44136fa355b3678a
  test('typecheck_gate_has_no_suppressions_and_src_stays_js', () => {
    function getFiles(dir: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true })
      const files: string[] = []
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          files.push(...getFiles(fullPath))
        } else if (entry.isFile()) {
          files.push(fullPath)
        }
      }
      return files
    }

    const srcFiles = getFiles(path.join(ROOT, 'src'))
    expect(srcFiles.length).toBeGreaterThan(0)
    for (const file of srcFiles) {
      expect(file.endsWith('.js'), `Arquivo em src/ não termina em .js: ${file}`).toBe(true)
    }

    const testFiles = getFiles(path.join(ROOT, 'tests'))
    expect(testFiles.length).toBeGreaterThan(0)

    const suppressions = [
      '@ts-' + 'ignore',
      '@ts-' + 'expect-error',
      '@ts-' + 'nocheck',
    ]

    for (const file of [...srcFiles, ...testFiles]) {
      const content = readFileSync(file, 'utf8')
      for (const directive of suppressions) {
        expect(
          content.includes(directive),
          `Arquivo contém diretiva proibida '${directive}': ${file}`
        ).toBe(false)
      }
    }

    expect(digest16({})).toBe('44136fa355b3678a')
  })
})

// Provas do portão de lint com oxlint
describe('lint gate', () => {
  // AC1: .oxlintrc.json e package.json devidamente configurados com regras padrão
  test('lint_gate_is_configured_with_default_rules', () => {
    const configPath = path.join(ROOT, '.oxlintrc.json')
    expect(existsSync(configPath), '.oxlintrc.json deve existir na raiz').toBe(true)

    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(config.categories?.correctness).toBe('error')

    expect(config.rules?.['no-unused-vars']).toBeDefined()
    const noUnusedVars = config.rules['no-unused-vars']
    expect(Array.isArray(noUnusedVars)).toBe(true)
    expect(noUnusedVars[0]).toBe('error')
    expect(noUnusedVars[1]?.argsIgnorePattern).toBe('^_')
    expect(noUnusedVars[1]?.varsIgnorePattern).toBe('^_')
    expect(noUnusedVars[1]?.caughtErrorsIgnorePattern).toBe('^_')

    const expectedIgnores = [
      'proto/**',
      'node_modules/**',
      'docs/**',
      'fixtures/**',
      'schemas/**',
    ]
    expect(config.ignorePatterns).toBeDefined()
    for (const pattern of expectedIgnores) {
      expect(
        config.ignorePatterns,
        `ignorePatterns deve conter ${pattern}`
      ).toContain(pattern)
    }

    const pkgPath = path.join(ROOT, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    expect(pkg.devDependencies?.oxlint).toBeDefined()
    expect(pkg.scripts?.lint).toBeDefined()
    expect(pkg.scripts.lint.startsWith('node node_modules/oxlint/')).toBe(true)
    expect(pkg.scripts.lint.endsWith(' src tests')).toBe(true)
    expect(pkg.scripts.lint.includes('npx')).toBe(false)
  })

  // AC2: bin do oxlint executa sobre src tests e sai com código 0
  test('lint_gate_exits_zero_over_src_and_tests', () => {
    const pkgPath = path.join(ROOT, 'node_modules/oxlint/package.json')
    expect(existsSync(pkgPath), 'node_modules/oxlint/package.json deve existir').toBe(true)

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const binRel: string = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.oxlint ?? '')
    const bin = path.join(ROOT, 'node_modules/oxlint', binRel)

    const result = spawnSync(
      process.execPath,
      [bin, 'src', 'tests'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
    const output = `status: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr ?? ''}`
    expect(result.status, output).toBe(0)
  }, 120000)

  // AC3: oxlint falha em arquivo contendo apenas debugger
  test('lint_gate_fails_on_debugger_statement', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'ade-lint-'))
    try {
      const badFile = path.join(tmpDir, 'bad.js')
      writeFileSync(badFile, 'debugger\n', 'utf8')

      const configPath = path.join(ROOT, '.oxlintrc.json')
      expect(existsSync(configPath), '.oxlintrc.json deve existir na raiz').toBe(true)

      const pkgPath = path.join(ROOT, 'node_modules/oxlint/package.json')
      expect(existsSync(pkgPath), 'node_modules/oxlint/package.json deve existir').toBe(true)

      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const binRel: string = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.oxlint ?? '')
      const bin = path.join(ROOT, 'node_modules/oxlint', binRel)

      const result = spawnSync(
        process.execPath,
        [bin, '-c', configPath, badFile],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
      )
      expect(result.status).not.toBe(0)
      const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      expect(combinedOutput).toContain('no-debugger')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 120000)

  // AC4: docs/roadmap.md registra o plugin anti-slop na linha 11 do backlog pós-v1
  test('roadmap_backlog_registers_anti_slop_plugin', () => {
    const roadmapPath = path.join(ROOT, 'docs/roadmap.md')
    expect(existsSync(roadmapPath), 'docs/roadmap.md deve existir').toBe(true)

    const content = readFileSync(roadmapPath, 'utf8')
    const lines = content.split('\n')
    const line11 = lines.find((line) => line.trim().startsWith('| 11 |'))
    expect(line11, 'Linha começando com | 11 | deve existir em docs/roadmap.md').toBeDefined()
    expect(line11).toContain('anti-slop')
  })
})
