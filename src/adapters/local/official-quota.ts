// Cota oficial de cada plano, lida de onde cada CLI realmente informa (o mesmo desenho da demo, proto/server.mjs):
// Claude: o evento rate_limit_event que o próprio CLI devolve numa chamada em stream-json; Codex: o rate_limits que
// cada sessão grava em ~/.codex/sessions; Google: `agy -p /quota --output-format json`, que não gasta token nem abre conversa. O resultado vira os recibos ~/.ade/quota-<família>.json que o motor exige
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

/** Janela da semana (e a de 5 h) do grupo Gemini na resposta de `agy -p /quota --output-format json`; null sem leitura. */
export function parseAgyQuota(stdout: string): { seven_day: QuotaWindow; five_hour: QuotaWindow | null } | null {
  let groups: any[] = []
  try {
    groups = JSON.parse(stdout.slice(stdout.indexOf('{')))?.command?.data?.groups ?? []
  } catch {
    return null
  }
  // os modelos da família agy no catálogo são Gemini; o grupo "Claude and GPT" do agy é outra cota
  const gemini = groups.find((g: any) => /gemini/i.test(String(g?.name)))
  const win = (window: string): QuotaWindow | null => {
    const b = (gemini?.buckets ?? []).find((x: any) => x?.window === window && x?.disabled !== true)
    return b && typeof b.remaining_fraction === 'number' && typeof b.reset_time === 'string'
      ? { used_percent: Math.round((1 - b.remaining_fraction) * 100), resets_at: new Date(b.reset_time).toISOString() }
      : null
  }
  const seven = win('weekly')
  return seven ? { seven_day: seven, five_hour: win('5h') } : null
}

/** Comando de cota do agy: responde sem turno de modelo. Sem shell, o "/quota" chega como está. */
function agyProbe(): Promise<string> {
  const { exe, prefixArgs } = resolveBinary('agy')
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...prefixArgs, '-p', '/quota', '--output-format', 'json'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill(), 60_000)
    child.once('error', (err) => { clearTimeout(timer); reject(err) })
    child.once('exit', () => { clearTimeout(timer); resolve(out) })
  })
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
 * Chamada mínima do codex que grava sessão (sem --ephemeral): o `exec --json` não devolve a cota, só o arquivo da
 * sessão em ~/.codex/sessions traz o rate_limits. As chamadas do motor são efêmeras e não gravam nada, então sem esta
 * sonda a leitura ficava parada na última sessão manual (81% de dois dias antes contra 26% reais, 25/09).
 */
function codexProbe(): Promise<void> {
  const { exe, prefixArgs } = resolveBinary('codex')
  const args = [...prefixArgs, 'exec', '-', '--json', '--color', 'never', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'model_reasoning_effort="low"', '-c', 'windows.sandbox=unelevated', '-C', os.tmpdir()]
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { shell: false, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => child.kill(), 120_000)
    child.once('error', (err) => { clearTimeout(timer); reject(err) })
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.stdin.end('Responda só: ok')
  })
}

/** Leitura do Codex mais velha que isto dispara a sonda antes de gravar o recibo. */
export const CODEX_READING_MAX_AGE_MS = 30 * 60_000

/**
 * Lê a cota oficial do Claude, do Codex e do Google (agy) e grava um recibo por família em ~/.ade/quota-<família>.json.
 * Família sem leitura fica sem recibo (o motor então não gasta aquele plano às cegas). Devolve os recibos gravados.
 */
export async function refreshQuotaReceipts({ home = os.homedir(), now = Date.now(), readClaude = claudeProbe, readCodex = readCodexRateLimit, probeCodex = codexProbe, readAgy = agyProbe }: {
  home?: string
  now?: number
  readClaude?: () => Promise<string>
  readCodex?: (home: string) => ReturnType<typeof readCodexRateLimit>
  probeCodex?: () => Promise<void>
  readAgy?: () => Promise<string>
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
  let codex = readCodex(home)
  if (!codex || now - Date.parse(codex.observed_at) > CODEX_READING_MAX_AGE_MS) {
    await probeCodex().catch(() => undefined)
    codex = readCodex(home) ?? codex
  }
  // leitura que continua velha depois da sonda não vira recibo oficial: o motor não decide com o número de outra semana
  if (codex && now - Date.parse(codex.observed_at) <= CODEX_READING_MAX_AGE_MS) write({ source: 'official', family: 'codex', used_percent: codex.seven_day.used_percent, reserved_percent: 0, observed_at: codex.observed_at, weekly_reset_at: codex.seven_day.resets_at })
  const agy = parseAgyQuota(await readAgy().catch(() => ''))
  if (agy) write({ source: 'official', family: 'agy', used_percent: agy.seven_day.used_percent, reserved_percent: 0, observed_at: new Date(now).toISOString(), weekly_reset_at: agy.seven_day.resets_at, five_hour: agy.five_hour })
  return written
}
