import { readdirSync, readFileSync } from 'node:fs'
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
    const suppression = /@ts-ignore|@ts-expect-error|@ts-nocheck|oxlint-disable|eslint-disable/
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
