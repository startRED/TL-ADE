import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'

const execFileAsync = promisify(execFile)
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ADR_DIR = path.join(ROOT, 'docs', 'adr')
const ADR_0030 = path.join(ADR_DIR, '0030-typescript-no-motor-e-build-do-painel.md')
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

// Hashes de HEAD antes da v2 (os mesmos registrados em docs_v1_activation).
const FROZEN_ADRS: Record<string, string> = {
  '0023-js-esm-com-jsdoc-e-checkjs.md': 'ac3132c5907ed9a59df99e8ae820efd8036ca79bf34ea59ce0bb7164a37c90bb',
  '0027-ativacao-da-v04b-painel-local.md': '81ef0340dfc3e47797e6acf55e3076685a1dc56b3ff7027e9d348474f83ea026',
}

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Projeto temporário que herda o tsconfig da raiz, com os arquivos dados em src/. */
function mixedProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ade-v2-ts-'))
  tmpDirs.push(dir)
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    extends: path.join(ROOT, 'tsconfig.json').replaceAll('\\', '/'),
    compilerOptions: { typeRoots: [path.join(ROOT, 'node_modules', '@types').replaceAll('\\', '/')] },
    include: ['src/**/*.ts', 'src/**/*.js'],
  }))
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, 'src', name), body)
  return dir
}

async function run(args: string[], cwd: string): Promise<{ code: number, out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, { cwd, maxBuffer: 8 * 1024 * 1024 })
    return { code: 0, out: stdout + stderr }
  } catch (error) {
    const e = error as { code?: number, stdout?: string, stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('ADR 0030: TypeScript no motor e build do painel', () => {
  test('ca1_adr_0030_accepted_amends_0023_and_0027_which_stay_byte_identical', () => {
    expect(existsSync(ADR_0030), 'ADR 0030 deve existir').toBe(true)
    const adr = readFileSync(ADR_0030, 'utf8')
    expect(adr).toMatch(/^# ADR 0030\b/m)
    expect(adr).toMatch(/^\*\*Status:\*\* Aceito/m)
    expect(adr).toContain('ADR 0023')
    expect(adr).toContain('ADR 0027')
    expect(adr).toMatch(/emenda/i)

    for (const [name, hash] of Object.entries(FROZEN_ADRS)) {
      const digest = createHash('sha256').update(readFileSync(path.join(ADR_DIR, name))).digest('hex')
      expect(digest, `${name} não pode mudar`).toBe(hash)
    }
  })

  test('ca2_agents_md_declares_strict_ts_front_build_only_in_web_and_keeps_prohibitions', () => {
    const agents = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('src/**/*.ts')
    expect(agents).toMatch(/TypeScript estrito/)
    expect(agents).toMatch(/build.*packages\/web/)
    expect(agents).toContain('ADR 0030')
    // A proibição antiga de converter para .ts sai.
    expect(agents).not.toContain('Converter arquivo para `.ts`')
    // Proibições que continuam.
    expect(agents).toContain('Nunca use `npx`')
    expect(agents).toMatch(/`maxBuffer` explícito e sem `shell`/)
    for (const directive of ['ts-ignore', 'ts-expect-error', 'ts-nocheck', 'oxlint-disable']) {
      expect(agents).toContain(directive)
    }
    expect(agents).toMatch(/afrouxar `strict`/)
  })

  test('ca3_ts_and_js_import_each_other_with_ts_extension_under_tsc_and_node_without_build', async () => {
    const dir = mixedProject({
      'soma.ts': "import { dobro } from './dobro.js'\nexport function soma(a: number, b: number): number { return dobro(a) + b }\n",
      'dobro.js': '/** @param {number} n */\nexport function dobro(n) { return n * 2 }\n',
      'main.js': "import { soma } from './soma.ts'\nconsole.log(`soma=${soma(2, 3)}`)\n",
    })

    const tsc = await run([TSC, '--noEmit', '-p', 'tsconfig.json'], dir)
    expect(tsc.out).toBe('')
    expect(tsc.code).toBe(0)

    const node = await run(['src/main.js'], dir)
    expect(node.code).toBe(0)
    expect(node.out.trim()).toBe('soma=7')
  }, 60_000)

  test('ca3_edge_non_erasable_syntax_is_rejected_by_typecheck', async () => {
    const dir = mixedProject({ 'cor.ts': 'export enum Cor { Verde }\n' })
    const tsc = await run([TSC, '--noEmit', '-p', 'tsconfig.json'], dir)
    expect(tsc.code).not.toBe(0)
    expect(tsc.out).toContain('TS1294')
  }, 60_000)

  test('ca4_tsconfig_keeps_strict_and_enables_erasable_syntax_only', () => {
    const tsconfig = JSON.parse(readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'))
    expect(tsconfig.compilerOptions.strict).toBe(true)
    expect(tsconfig.compilerOptions.erasableSyntaxOnly).toBe(true)
    expect(tsconfig.compilerOptions.allowImportingTsExtensions).toBe(true)
    expect(tsconfig.compilerOptions.noEmit).toBe(true)
    expect(tsconfig.include).toEqual(expect.arrayContaining(['src/**/*.ts', 'src/**/*.js']))

    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.engines.node).toBe('>=24')
  })

  test('ca5_adr_index_lists_0030_as_accepted', () => {
    const index = readFileSync(path.join(ADR_DIR, 'README.md'), 'utf8')
    expect(index).toMatch(/\| \[0030\]\(0030-typescript-no-motor-e-build-do-painel\.md\) \|.*\| Aceito/)
  })
})
