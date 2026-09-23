import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { digest16 } from '../src/journal/canonical.ts'

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

// Provas da dívida zerada (v2): relógio injetado, diretivas proibidas e zero diagnóstico
describe('debt zero gate', () => {
  function listFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) return listFiles(fullPath)
      return entry.isFile() ? [fullPath] : []
    })
  }

  function oxlintBin(): string {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'node_modules/oxlint/package.json'), 'utf8'))
    const binRel: string = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.oxlint ?? '')
    return path.join(ROOT, 'node_modules/oxlint', binRel)
  }

  // Roda um script do package.json sem shell: "node <args>" vira process.execPath <args>
  function runPackageScript(name: string) {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const script: string = pkg.scripts?.[name] ?? ''
    const [bin, ...args] = script.split(/\s+/).filter(Boolean)
    expect(bin, `script ${name} deve começar com node`).toBe('node')
    const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return { ...result, output: `status: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr ?? ''}` }
  }

  // AC1: o typecheck da raiz sai 0 e não imprime nenhum diagnóstico TS
  test('typecheck_exits_zero_with_zero_diagnostics_at_root', () => {
    const result = runPackageScript('typecheck')
    const diagnostics = `${result.stdout}\n${result.stderr ?? ''}`.split('\n').filter((line) => /error TS\d+/.test(line))
    expect(diagnostics, result.output).toEqual([])
    expect(result.status, result.output).toBe(0)
  }, 300000)

  // AC5: o portão roda os scripts typecheck e lint do package.json na raiz e ambos saem 0
  test('gate_runs_root_typecheck_and_lint_scripts_and_both_exit_zero', () => {
    const typecheck = runPackageScript('typecheck')
    const lint = runPackageScript('lint')
    expect({ typecheck: typecheck.status, lint: lint.status }, `${typecheck.output}\n${lint.output}`).toEqual({ typecheck: 0, lint: 0 })
  }, 300000)

  // AC2: lint sobre src e tests sai 0 sem nenhum aviso nem erro
  test('lint_exits_zero_with_zero_diagnostics_over_src_and_tests', () => {
    const result = spawnSync(
      process.execPath,
      [oxlintBin(), '--deny-warnings', '--format', 'unix', 'src', 'tests'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
    const output = `status: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr ?? ''}`
    expect(result.status, output).toBe(0)
    expect(result.stdout, output).not.toMatch(/\[(Error|Warning)\//)
  }, 120000)

  // Borda do AC2: um único aviso já derruba o portão com --deny-warnings
  test('lint_gate_fails_on_single_warning', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'ade-lint-warn-'))
    try {
      const warnFile = path.join(tmpDir, 'warn.js')
      writeFileSync(warnFile, 'const sobra = 1\n', 'utf8')
      const result = spawnSync(
        process.execPath,
        [oxlintBin(), '--deny-warnings', warnFile],
        { cwd: tmpDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
      )
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr ?? ''}`).toContain('no-unused-vars')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 120000)

  // AC4: nenhuma diretiva de supressão em src e tests, e strict segue ligado
  test('no_suppression_directives_in_src_and_tests_and_strict_stays_true', () => {
    const directive = /(?:\/\/|\/\*)\s*(?:@ts-(?:ignore|expect-error|nocheck)|(?:ox|es)lint-disable)/
    expect(directive.test('// @ts-' + 'ignore')).toBe(true)
    expect(directive.test('/* oxlint-' + 'disable no-debugger */')).toBe(true)
    expect(directive.test("['oxlint-disable']")).toBe(false)
    const files = [...listFiles(path.join(ROOT, 'src')), ...listFiles(path.join(ROOT, 'tests'))]
      .filter((file) => !file.includes(`${path.sep}vendor${path.sep}`))
    expect(files.length).toBeGreaterThan(0)
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, i) => directive.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])
    )
    expect(hits).toEqual([])

    const tsconfig = JSON.parse(readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'))
    expect(tsconfig.compilerOptions?.strict).toBe(true)
    for (const loosen of ['noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'noImplicitThis']) {
      expect(tsconfig.compilerOptions?.[loosen], `tsconfig afrouxa ${loosen}`).not.toBe(false)
    }
  })

  // AC3: as provas de cota passam com o relógio do sistema adiantado em um ano
  test('quota_proofs_pass_with_system_clock_one_year_ahead', () => {
    const oneYearMs = 365 * 24 * 60 * 60 * 1000
    // Troca o Date global do processo e dos workers: Date.now() e new Date() andam um ano à frente.
    const shiftClock = 'data:text/javascript,' + encodeURIComponent(`const O = Date; const D = ${oneYearMs}
      globalThis.Date = class extends O {
        constructor(...a) { if (a.length) super(...a); else super(O.now() + D) }
        static now() { return O.now() + D }
      }`)
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'tests/budget-controls.test.ts',
        'tests/engine-quota.test.ts',
        '-t',
        'ca4_quota_receipt_validation_and_rejection|CA1_recibo_oficial|CA3_reserva_e_duravel',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', NODE_OPTIONS: `--import=${shiftClock}`, VITEST: undefined, VITEST_WORKER_ID: undefined, VITEST_POOL_ID: undefined },
      }
    )
    const output = `status: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr ?? ''}`
    expect(result.status, output).toBe(0)
    expect(result.stdout, output).toMatch(/Tests\s+\S*3 passed/)
  }, 180000)
})
