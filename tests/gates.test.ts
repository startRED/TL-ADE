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
