import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'
import vitestConfig from '../vitest.config.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

// Diretórios do núcleo durável convertidos nesta parte.
const CORE_DIRS = [
  'journal', 'lease', 'step', 'runner', 'contain', 'git', 'workspace',
  'schema', 'artifacts', 'pack', 'evidence', 'docs', 'telemetry',
]

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
}

const coreFiles = CORE_DIRS.flatMap((d) => listFiles(path.join(ROOT, 'src', d)))
const coreTsFiles = coreFiles.filter((f) => f.endsWith('.ts'))
const rel = (f: string) => path.relative(ROOT, f).replaceAll('\\', '/')
const jsdocType = /@(param|returns?|type|property|prop|template)\s*\{|@typedef\b|@callback\b/

describe('migração TS do núcleo durável', () => {
  test('ca1_core_dirs_have_no_js_and_every_ts_compiles_under_strict', () => {
    expect(coreFiles.filter((f) => /\.(c|m)?js$/.test(f)).map(rel)).toEqual([])
    expect(coreTsFiles.length).toBeGreaterThanOrEqual(34)

    const configPath = path.join(ROOT, 'tsconfig.json')
    const { config } = ts.readConfigFile(configPath, ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT)
    expect(parsed.options.strict).toBe(true)
    const program = ts.createProgram(coreTsFiles, parsed.options)
    const coreSet = new Set(coreTsFiles.map((f) => path.resolve(f)))
    const errors = ts.getPreEmitDiagnostics(program)
      .filter((d) => d.file && coreSet.has(path.resolve(d.file.fileName)))
      .map((d) => `${rel(d.file!.fileName)}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
    expect(errors).toEqual([])
  }, 120_000)

  test('ca2_durability_coverage_globs_measure_ts_sources_only', () => {
    const include = vitestConfig.test?.coverage?.include ?? []
    expect(include).toEqual([
      'src/journal/**/*.ts',
      'src/step/**/*.ts',
      'src/lease/**/*.ts',
      'src/git/**/*.ts',
      'src/runner/**/*.ts',
      'src/contain/**/*.ts',
    ])
  })

  test('ca3_converted_files_carry_no_suppression_directives', () => {
    expect(coreTsFiles.length).toBeGreaterThanOrEqual(34)
    const suppression = new RegExp(['@ts-' + 'ignore', '@ts-' + 'expect-error', '@ts-' + 'nocheck', 'oxlint-' + 'disable', 'eslint-' + 'disable'].join('|'))
    expect(coreTsFiles.filter((f) => suppression.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([])
  })

  test('ca4_converted_files_have_no_jsdoc_type_annotations', () => {
    expect(coreTsFiles.length).toBeGreaterThanOrEqual(34)
    const offenders = coreTsFiles.flatMap((f) =>
      readFileSync(f, 'utf8').split('\n')
        .map((line, i) => (jsdocType.test(line) ? `${rel(f)}:${i + 1}` : null))
        .filter((x): x is string => x !== null),
    )
    expect(offenders).toEqual([])
  })

  test('ca4_detector_flags_jsdoc_types_and_ignores_plain_descriptions', () => {
    expect(jsdocType.test(' * @param {string} nome')).toBe(true)
    expect(jsdocType.test(' * @returns {Promise<void>}')).toBe(true)
    expect(jsdocType.test(' * @typedef {Object} Coisa')).toBe(true)
    expect(jsdocType.test(' * @param nome descrição sem tipo')).toBe(false)
  })
})

// Diretórios do motor convertidos na segunda parte; engine.ts entra como arquivo solto.
const ENGINE_DIRS = ['engine', 'adapters', 'review', 'gates', 'evals', 'mission']
const engineFiles = [
  ...ENGINE_DIRS.flatMap((d) => listFiles(path.join(ROOT, 'src', d))),
  ...['engine.js', 'engine.ts'].map((f) => path.join(ROOT, 'src', f)).filter((f) => existsSync(f)),
]
const engineTsFiles = engineFiles.filter((f) => f.endsWith('.ts'))

describe('migração TS do motor, adaptadores e revisão', () => {
  test('ca1_engine_dirs_have_no_js_and_no_jsdoc_types', () => {
    expect(engineFiles.filter((f) => /\.(c|m)?js$/.test(f)).map(rel)).toEqual([])
    expect(engineTsFiles.length).toBeGreaterThanOrEqual(34)
    const offenders = engineTsFiles.flatMap((f) =>
      readFileSync(f, 'utf8').split('\n')
        .map((line, i) => (jsdocType.test(line) ? `${rel(f)}:${i + 1}` : null))
        .filter((x): x is string => x !== null),
    )
    expect(offenders).toEqual([])
  })

  test('ca2_engine_interfaces_keep_their_signatures_as_ts_modules', async () => {
    const engine = await import('../src/engine.ts')
    const schedule = await import('../src/engine/schedule.ts')
    const resume = await import('../src/engine/resume.ts')
    const deliver = await import('../src/engine/deliver.ts')
    expect(engine.runStory).toBeTypeOf('function')
    expect(engine.runStory.length).toBe(2)
    expect(engine.runSequentialMission).toBe(schedule.runSequentialMission)
    expect(schedule.runSequentialMission.length).toBe(2)
    expect(resume.resumeMission.length).toBe(1)
    expect(deliver.deliverStory.length).toBe(1)
  })

  test('ca3_engine_ts_compiles_under_strict_without_suppression', () => {
    expect(engineTsFiles.length).toBeGreaterThanOrEqual(34)
    const suppression = new RegExp(['@ts-' + 'ignore', '@ts-' + 'expect-error', '@ts-' + 'nocheck', 'oxlint-' + 'disable', 'eslint-' + 'disable'].join('|'))
    expect(engineTsFiles.filter((f) => suppression.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([])

    const { config } = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT)
    expect(parsed.options.strict).toBe(true)
    const program = ts.createProgram(engineTsFiles, parsed.options)
    const engineSet = new Set(engineTsFiles.map((f) => path.resolve(f)))
    const errors = ts.getPreEmitDiagnostics(program)
      .filter((d) => d.file && engineSet.has(path.resolve(d.file.fileName)))
      .map((d) => `${rel(d.file!.fileName)}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
    expect(errors).toEqual([])
  }, 180_000)
})

// Borda convertida na terceira parte; ao fim dela src não tem mais JS de produção.
const EDGE_DIRS = ['intent', 'context', 'skills', 'visual', 'panel', 'cli']
const VENDOR_AXE = 'src/visual/vendor/axe.min.js'
const edgeTsFiles = EDGE_DIRS.flatMap((d) => listFiles(path.join(ROOT, 'src', d))).filter((f) => f.endsWith('.ts'))

function runBin(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'bin', 'ade.js'), ...args], { cwd: ROOT, maxBuffer: 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout, stderr })
    })
  })
}

describe('migração TS da borda e fim do JS', () => {
  test('ca1_src_scan_finds_only_vendor_axe_as_js', () => {
    const js = listFiles(path.join(ROOT, 'src')).filter((f) => /\.(c|m)?js$/.test(f)).map(rel)
    expect(js).toEqual([VENDOR_AXE])
    expect(edgeTsFiles.length).toBeGreaterThanOrEqual(57)
  })

  test('ca2_bin_help_exits_zero_without_build_step', async () => {
    expect(readFileSync(path.join(ROOT, 'bin', 'ade.js'), 'utf8')).toContain("'../src/cli/index.ts'")
    const help = await runBin(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('uso: ade <run|')
  }, 90_000)

  test('ca2_bin_unknown_command_still_fails_with_usage', async () => {
    const bad = await runBin(['comando-que-nao-existe'])
    expect(bad.code).toBe(4)
    expect(bad.stderr).toContain('uso: ade <run|')
  }, 90_000)

  test('ca3_tsconfig_keeps_strict_and_stops_checking_production_js', () => {
    const { config } = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile)
    expect(config.compilerOptions.strict).toBe(true)
    expect(config.include).not.toContain('src/**/*.js')
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT)
    expect(parsed.options.strict).toBe(true)
    const srcJs = parsed.fileNames.map(rel).filter((f) => f.startsWith('src/') && /\.(c|m)?js$/.test(f))
    expect(srcJs).toEqual([])
  })

  test('ca4_edge_ts_compiles_under_strict_without_suppression_or_jsdoc_types', () => {
    expect(edgeTsFiles.length).toBeGreaterThanOrEqual(57)
    const suppression = new RegExp(['@ts-' + 'ignore', '@ts-' + 'expect-error', '@ts-' + 'nocheck', 'oxlint-' + 'disable', 'eslint-' + 'disable'].join('|'))
    expect(edgeTsFiles.filter((f) => suppression.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([])
    const offenders = edgeTsFiles.flatMap((f) =>
      readFileSync(f, 'utf8').split('\n')
        .map((line, i) => (jsdocType.test(line) ? `${rel(f)}:${i + 1}` : null))
        .filter((x): x is string => x !== null),
    )
    expect(offenders).toEqual([])

    const { config } = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT)
    const program = ts.createProgram(edgeTsFiles, parsed.options)
    expect(program.getSourceFile(path.join(ROOT, VENDOR_AXE))).toBeUndefined()
    const edgeSet = new Set(edgeTsFiles.map((f) => path.resolve(f)))
    const errors = ts.getPreEmitDiagnostics(program)
      .filter((d) => d.file && edgeSet.has(path.resolve(d.file.fileName)))
      .map((d) => `${rel(d.file!.fileName)}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
    expect(errors).toEqual([])
  }, 180_000)
})
