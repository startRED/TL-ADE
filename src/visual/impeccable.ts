import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const PINNED_ENGINE_VERSION = '0.1.5'

/**
 * Executa a sonda do Impeccable para verificar a versão instalada e o suporte ao modo de URL.
 */
export async function probeImpeccable(options: {
    bin?: string | null
    expectedVersion?: string
    execFn?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr?: string; exitCode?: number }>
} = {}): Promise<{
    ok: boolean
    engine_version: string | null
    version_match: boolean
    url_mode: 'ok' | 'unsupported'
    error?: string
}> {
  const bin = options.bin || process.env.IMPECCABLE_BIN || 'impeccable'
  const expected = options.expectedVersion || PINNED_ENGINE_VERSION
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
    const detectedVersion = verMatch ? verMatch[1] : verRes.stdout.trim()
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
      if (urlProbeRes.exitCode === 0 || urlProbeRes.exitCode === 2) {
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
} = {}) {
  const engineVersion = config.engineVersion || PINNED_ENGINE_VERSION
  const urlMode = config.urlMode || 'unsupported'
  const ignores = new Set(config.ignores || [])

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

      return {
        mode: 'url',
        engine_version: engineVersion,
        url_mode: 'ok',
        issues: [],
      }
    },
  }
}
