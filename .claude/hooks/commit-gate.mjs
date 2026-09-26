// Portão de commit do repositório da TL-ADE: tipos, lint e as provas ligadas ao que mudou saem 0 antes de qualquer
// `git commit` (AGENTS.md). Determinístico: não depende de a IA lembrar. Nega pela saída JSON do PreToolUse.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Maker e revisor de missão carregam as configurações do projeto e o hook dispara antes da trava `Bash(git commit*)`
// deles (medido em 2026-09-26): nas pastas do motor (worktree em .ade/, trilho em ~/.ade/lanes, cópia do revisor em
// ade-review) o commit já é negado e rodar a suíte só gastaria o tempo da missão.
let input = {}
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
} catch {
  // sem entrada legível, confere como numa sessão comum
}
if (/[\\/](\.ade|ade-review)[\\/]/.test(String(input.cwd ?? ''))) process.exit(0)
// o `if` do settings.json também dispara em comando que o Claude Code não consegue analisar (com `$(...)`): só age
// quando o comando tem mesmo um `git commit`
if (input.tool_input?.command !== undefined && !/\bgit\b[^|;&]*\bcommit\b/.test(String(input.tool_input.command))) process.exit(0)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const steps = [
  ['tsc', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['lint', ['node_modules/oxlint/bin/oxlint', 'src', 'tests']],
  ['vitest --changed', ['node_modules/vitest/vitest.mjs', 'run', '--changed', '--passWithNoTests']],
]

for (const [name, args] of steps) {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`
      .replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-15).join('\n')
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Commit negado: ${name} falhou. Os três comandos de prova saem 0 antes do commit.\n${tail}`,
      },
    }))
    process.exit(0)
  }
}
