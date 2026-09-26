import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { CLAUDE_ISOLATION_ENV, isolationArgs, isolationSettings, writeIsolationSettings } from '../src/adapters/claude/isolation.ts'
import { buildClaudeArgs } from '../src/adapters/claude/argv.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SID = '11111111-2222-4333-8444-555555555555'

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'vendor' ? [] : srcFiles(p)
    return /\.(ts|js|mjs)$/.test(e.name) ? [p] : []
  })
}

describe('isolamento do claude sem --safe-mode (ADR 0044)', () => {
  const tmps: string[] = []
  afterEach(() => { for (const d of tmps.splice(0)) removeTmpDir(d) })

  // A cópia de trilho fica sob ~/.ade/lanes: subindo as pastas o Claude Code lia o ~/.claude/CLAUDE.md do operador.
  test('isolation_excludes_instruction_files_of_every_ancestor_but_not_of_cwd', () => {
    const cwd = path.join(ROOT, 'a', 'b')
    const { claudeMdExcludes, autoMemoryEnabled } = isolationSettings(cwd)
    const fwd = (p: string) => p.split(path.sep).join('/')
    expect(autoMemoryEnabled).toBe(false)
    expect(claudeMdExcludes).toContain(fwd(path.join(ROOT, 'a', 'CLAUDE.md')))
    expect(claudeMdExcludes).toContain(fwd(path.join(ROOT, 'a', '.claude', 'CLAUDE.md')))
    expect(claudeMdExcludes).toContain(fwd(path.join(ROOT, 'AGENTS.md')))
    expect(claudeMdExcludes).toContain(fwd(path.join(path.parse(ROOT).root, 'CLAUDE.md')))
    expect(claudeMdExcludes.some((p) => p.startsWith(fwd(cwd) + '/'))).toBe(false)
  })

  test('isolation_of_filesystem_root_excludes_nothing', () => {
    expect(isolationSettings(path.parse(ROOT).root).claudeMdExcludes).toEqual([])
  })

  // O casamento do glob é por texto: "e:/" e "E:/" são caminhos diferentes para ele.
  test('isolation_lists_both_drive_letter_cases_on_windows_paths', () => {
    const list = isolationSettings('e:\\proj\\wt').claudeMdExcludes
    if (path.sep !== '\\') return
    expect(list).toContain('e:/proj/CLAUDE.md')
    expect(list).toContain('E:/proj/CLAUDE.md')
  })

  test('isolation_settings_file_is_stable_per_cwd_and_holds_the_settings', () => {
    const dir = makeTmpDir('ade-iso-')
    tmps.push(dir)
    const a = writeIsolationSettings(path.join(dir, 'wt1'), dir)
    const again = writeIsolationSettings(path.join(dir, 'wt1'), dir)
    const b = writeIsolationSettings(path.join(dir, 'wt2'), dir)
    expect(again).toBe(a)
    expect(b).not.toBe(a)
    expect(JSON.parse(fs.readFileSync(a, 'utf8'))).toEqual(isolationSettings(path.join(dir, 'wt1')))
  })

  test('isolation_args_load_only_project_sources_strict_mcp_and_the_settings_file', () => {
    expect(isolationArgs('/s.json')).toEqual(['--setting-sources', 'project', '--strict-mcp-config', '--exclude-dynamic-system-prompt-sections', '--settings', '/s.json'])
    expect(isolationArgs('/s.json', 'none').slice(0, 2)).toEqual(['--setting-sources', ''])
    expect(CLAUDE_ISOLATION_ENV).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
  })

  test('maker_and_checker_args_carry_isolation_and_never_safe_mode', () => {
    for (const role of ['maker', 'checker_round']) {
      const args = buildClaudeArgs({ sessionId: SID, packPath: '/p/pack.md', maxBudgetUsd: 1, settingsPath: '/p/iso.json', role })
      expect(args).not.toContain('--safe-mode')
      const at = args.indexOf('--setting-sources')
      expect(args.slice(at, at + 6)).toEqual(isolationArgs('/p/iso.json'))
    }
  })

  // --safe-mode também desliga as skills do projeto e as nativas (run, verify) e os hooks que o motor passa.
  test('no_source_file_spawns_claude_with_safe_mode', () => {
    const offenders = srcFiles(path.join(ROOT, 'src')).filter((f) => /['"]--safe-mode['"]/.test(fs.readFileSync(f, 'utf8')))
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([])
  })
})
