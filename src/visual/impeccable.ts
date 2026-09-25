import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const PINNED_ENGINE_VERSION = '0.1.5'

/**
 * Binário do motor do Impeccable: IMPECCABLE_BIN, senão o cache da versão fixada que o lançador da skill baixa
 * (~/.impeccable/bin/<versão>/). Null quando não há motor instalado.
 */
export function resolveImpeccableBin(version: string = PINNED_ENGINE_VERSION, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  if (env.IMPECCABLE_BIN && fs.existsSync(env.IMPECCABLE_BIN)) return env.IMPECCABLE_BIN
  const exe = process.platform === 'win32' ? 'impeccable.exe' : 'impeccable'
  const cached = path.join(env.IMPECCABLE_HOME || path.join(home, '.impeccable'), 'bin', version, exe)
  return fs.existsSync(cached) ? cached : null
}

/**
 * Executa a sonda do Impeccable para verificar a versão instalada e o suporte ao modo de URL.
 */
export async function probeImpeccable(options: {
    bin?: string | null
    /** Binário do cache da versão fixada; padrão: o que resolveImpeccableBin acha (nenhum quando exec é dublê). */
    cachedBin?: string | null
    expectedVersion?: string
    execFn?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr?: string; exitCode?: number }>
} = {}): Promise<{
    ok: boolean
    engine_version: string | null
    version_match: boolean
    url_mode: 'ok' | 'unsupported'
    error?: string
}> {
  const expected = options.expectedVersion || PINNED_ENGINE_VERSION
  // O cache do lançador guarda o motor em ~/.impeccable/bin/<versão do motor>/; o --version desse binário é o do
  // pacote da CLI (4.0.0), não o do motor. Sem isto a sonda procurava "impeccable" no PATH, achava nada e o FQE
  // inteiro caía em modo degradado (missão real de anexos, 25/09).
  const cached = options.bin || process.env.IMPECCABLE_BIN ? null : options.cachedBin !== undefined ? options.cachedBin : options.execFn ? null : resolveImpeccableBin(expected)
  const bin = options.bin || process.env.IMPECCABLE_BIN || cached || 'impeccable'
  const exec =
    options.execFn ||
    (async (cmd, args) => {
      try {
        const { stdout, stderr } = await execFileAsync(cmd, args, { windowsHide: true })
        return { stdout, stderr, exitCode: 0 }
      } catch (err) {
        const code = (err as any).code
        return {
          stdout: String((err as any).stdout || ''),
          stderr: String((err as any).stderr || ''),
          exitCode: typeof code === 'number' ? code : 1,
        }
      }
    })

  try {
    const verRes = await exec(bin, ['--version'])
    if (verRes.exitCode !== 0 && !verRes.stdout) {
      return {
        ok: false,
        engine_version: null,
        version_match: false,
        url_mode: 'unsupported',
        error: `impeccable não respondeu a --version: ${verRes.stderr || 'binário ausente'}`,
      }
    }

    const verMatch = (verRes.stdout || '').match(/(\d+\.\d+\.\d+)/)
    const detectedVersion = cached ? expected : verMatch ? verMatch[1] : verRes.stdout.trim()
    const versionMatch = detectedVersion === expected

    if (!versionMatch) {
      return {
        ok: false,
        engine_version: detectedVersion,
        version_match: false,
        url_mode: 'unsupported',
        error: `ENGINE_VERSION divergente do pin: detectado ${detectedVersion}, esperado ${expected}`,
      }
    }

    // Sonda de modo URL
    let urlMode = ('unsupported' as 'ok' | 'unsupported')
    try {
      const urlProbeRes = await exec(bin, ['detect', '--json', 'http://127.0.0.1:0/probe'])
      // Se aceitou o argumento de URL sem erro operacional de sintaxe (exit code 0 ou 2 de achados)
      // erro de navegação (a porta 0 da sonda é recusada: net::ERR_UNSAFE_PORT) prova que o motor aceitou o endereço
      if (urlProbeRes.exitCode === 0 || urlProbeRes.exitCode === 2 || /net::ERR_|ECONNREFUSED/.test(`${urlProbeRes.stderr ?? ''}${urlProbeRes.stdout ?? ''}`)) {
        urlMode = 'ok'
      } else if (urlProbeRes.stderr && /invalid|unsupported|protocol/i.test(urlProbeRes.stderr)) {
        urlMode = 'unsupported'
      }
    } catch {
      urlMode = 'unsupported'
    }

    return {
      ok: true,
      engine_version: detectedVersion,
      version_match: true,
      url_mode: urlMode,
    }
  } catch (err) {
    return {
      ok: false,
      engine_version: null,
      version_match: false,
      url_mode: 'unsupported',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Cria adaptador do detector estético para executar D5.
 */
export function createImpeccableDetector(config: {
    engineVersion?: string
    urlMode?: 'ok' | 'unsupported'
    ignores?: string[]
    detectorFn?: (params: any) => Promise<any>
    bin?: string | null
    execFn?: (cmd: string, args: string[]) => Promise<{ stdout: string }>
} = {}) {
  const engineVersion = config.engineVersion || PINNED_ENGINE_VERSION
  const bin = config.bin === undefined ? resolveImpeccableBin(engineVersion) : config.bin
  // Sem modo declarado, o motor instalado decide: antes o padrão era sempre o fallback e o detector real nunca rodava
  const urlMode = config.urlMode || (bin ? 'ok' : 'unsupported')
  const ignores = new Set(config.ignores || [])
  const exec = config.execFn ?? ((cmd: string, args: string[]) => execFileAsync(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }).catch((err: any) => {
    // saída 2 = achados; o JSON vem no stdout do mesmo jeito
    if (typeof err?.stdout === 'string' && err.stdout.trim().startsWith('[')) return { stdout: err.stdout }
    throw err
  }))
  // o motor abre o próprio navegador por URL e largura; os temas da mesma largura reaproveitam a varredura
  const scans = new Map<string, Promise<any[]>>()

  return {
    engineVersion,
    urlMode,
    async detect(params: any) {
      if (config.detectorFn) {
        return config.detectorFn(params)
      }

      // Se url_mode for unsupported, aplica o fallback documentado
      if (urlMode === 'unsupported') {
        const page = params.page
        const issues = []
        if (page && typeof page.evaluate === 'function') {
          const domIssues = await page
            .evaluate(() => {
              const list = []
              if (document.querySelector('.eyebrow, .kicker, [data-kicker], .hero-eyebrow-chip')) {
                list.push({
                  rule: 'kicker-above-heading',
                  category: 'slop',
                  severity: 'error',
                  message: 'Kicker/eyebrow detectado acima de heading',
                })
              }
              return list
            })
            .catch(() => [])

          for (const iss of domIssues) {
            if (!ignores.has(iss.rule)) {
              issues.push(iss)
            }
          }
        }

        return {
          mode: 'fallback',
          engine_version: engineVersion,
          url_mode: 'unsupported',
          issues,
        }
      }

      const url = typeof params.page?.url === 'function' ? params.page.url() : params.url
      if (!bin || !url) throw new Error('motor do Impeccable ou URL da página ausente')
      const viewport = `${params.width || 1280}x${params.width === 390 ? 844 : 800}`
      const key = `${url} ${viewport}`
      if (!scans.has(key)) {
        scans.set(key, exec(bin, ['detect', '--json', '--no-advisory', '--viewport', viewport, url]).then(({ stdout }) => {
          const found = JSON.parse(stdout || '[]')
          return Array.isArray(found) ? found : []
        }))
      }
      const found = await scans.get(key)!
      const issues = found
        .map((f: any) => ({ rule: f.antipattern, category: f.category, severity: f.severity, message: `${f.name}: ${f.snippet}` }))
        .filter((iss: any) => !ignores.has(iss.rule))
      return {
        mode: 'url',
        engine_version: engineVersion,
        url_mode: 'ok',
        issues,
      }
    },
  }
}
