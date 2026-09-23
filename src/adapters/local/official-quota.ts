// Cota oficial de cada plano, lida de onde cada CLI realmente informa (o mesmo desenho da demo, proto/server.mjs):
// Claude: o evento rate_limit_event que o próprio CLI devolve numa chamada em stream-json; Codex: o rate_limits que
// cada sessão grava em ~/.codex/sessions. O resultado vira os recibos ~/.ade/quota-<família>.json que o motor exige
// antes de uma chamada paga (source 'official').
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBinary } from '../../runner/resolve-binary.ts'

export type QuotaWindow = { used_percent: number; resets_at: string }
export type QuotaReceipt = { source: 'official'; family: string; used_percent: number; reserved_percent: number; observed_at: string; weekly_reset_at: string; five_hour?: QuotaWindow | null }

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString()

/** Janela da semana (e a de 5 h) do último rate_limit_event de uma saída stream-json do claude; null sem evento. */
export function parseClaudeRateLimit(stdout: string): { seven_day: QuotaWindow; five_hour: QuotaWindow | null } | null {
  let last: any = null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('"rate_limit_event"')) continue
    try {
      const ev = JSON.parse(line)
      if (ev?.type === 'rate_limit_event' && ev.rate_limit_info?.unifiedWindows) last = ev.rate_limit_info.unifiedWindows
    } catch {
      // linha partida: ignora
    }
  }
  const win = (w: any): QuotaWindow | null => (w && typeof w.utilization === 'number' && typeof w.resetsAt === 'number' ? { used_percent: Math.round(w.utilization * 100), resets_at: iso(w.resetsAt) } : null)
  const seven = win(last?.seven_day)
  return seven ? { seven_day: seven, five_hour: win(last?.five_hour) } : null
}

/** Janela semanal do rate_limits mais novo nas sessões do Codex (a de mais de 5 h); null sem sessão legível. */
export function readCodexRateLimit(home = os.homedir()): { seven_day: QuotaWindow; observed_at: string } | null {
  const root = path.join(home, '.codex', 'sessions')
  const files: Array<{ full: string; m: number }> = []
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory() && depth < 3) walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ full, m: fs.statSync(full).mtimeMs })
    }
  }
  walk(root, 0)
  for (const { full, m } of files.sort((a, b) => b.m - a.m).slice(0, 12)) {
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter((l) => l.includes('"rate_limits"'))
    for (const line of lines.reverse()) {
      try {
        const rl = JSON.parse(line)?.payload?.rate_limits
        const week = [rl?.primary, rl?.secondary].find((w: any) => w && typeof w.used_percent === 'number' && w.window_minutes > 300 && typeof w.resets_at === 'number')
        if (week) return { seven_day: { used_percent: Math.round(week.used_percent), resets_at: iso(week.resets_at) }, observed_at: new Date(m).toISOString() }
      } catch {
        // linha partida: tenta a anterior
      }
    }
  }
  return null
}

/** Chamada mínima do claude (modelo leve) só para ler o rate_limit_event; o prompt vai pela entrada padrão. */
function claudeProbe(): Promise<string> {
  const { exe, prefixArgs } = resolveBinary('claude')
  const args = [...prefixArgs, '-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--model', 'claude-haiku-4-5', '--no-session-persistence']
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill(), 90_000)
    child.once('error', (err) => { clearTimeout(timer); reject(err) })
    child.once('exit', () => { clearTimeout(timer); resolve(out) })
    child.stdin.end('Responda só: ok')
  })
}

/**
 * Lê a cota oficial do Claude e do Codex e grava um recibo por família em ~/.ade/quota-<família>.json.
 * Família sem leitura fica sem recibo (o motor então não gasta aquele plano às cegas). Devolve os recibos gravados.
 */
export async function refreshQuotaReceipts({ home = os.homedir(), now = Date.now(), readClaude = claudeProbe, readCodex = readCodexRateLimit }: {
  home?: string
  now?: number
  readClaude?: () => Promise<string>
  readCodex?: (home: string) => ReturnType<typeof readCodexRateLimit>
} = {}): Promise<QuotaReceipt[]> {
  const dir = path.join(home, '.ade')
  fs.mkdirSync(dir, { recursive: true })
  const written: QuotaReceipt[] = []
  const write = (receipt: QuotaReceipt) => {
    fs.writeFileSync(path.join(dir, `quota-${receipt.family}.json`), JSON.stringify(receipt, null, 2))
    written.push(receipt)
  }
  const claude = parseClaudeRateLimit(await readClaude().catch(() => ''))
  if (claude) write({ source: 'official', family: 'claude', used_percent: claude.seven_day.used_percent, reserved_percent: 0, observed_at: new Date(now).toISOString(), weekly_reset_at: claude.seven_day.resets_at, five_hour: claude.five_hour })
  const codex = readCodex(home)
  if (codex) write({ source: 'official', family: 'codex', used_percent: codex.seven_day.used_percent, reserved_percent: 0, observed_at: codex.observed_at, weekly_reset_at: codex.seven_day.resets_at })
  return written
}
