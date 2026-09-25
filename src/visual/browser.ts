import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface Capture {
    route: string
    width: number
    theme: 'light' | 'dark'
    url: string
    path: string
    revision: string
    commit_sha: string
    at: string
    sha256: string
    inspection?: any
}

/**
 * Testa prontidão de uma URL HTTP/HTTPS com timeout.
 */
export async function waitForUrlReady(urlStr: string, timeoutMs: number = 15000): Promise<boolean> {
  const start = Date.now()
  const parsed = new URL(urlStr)
  const client = parsed.protocol === 'https:' ? https : http

  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const req = client.get(urlStr, { timeout: 1500 }, (res) => {
        // Considera pronto em qualquer resposta HTTP recebida
        resolve(res.statusCode !== undefined && res.statusCode < 500)
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })

    if (ready) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/**
 * Encerra um processo filho de forma segura e com suporte a árvore de processos no Windows.
 */
export async function terminateProcess(proc: import('node:child_process').ChildProcess): Promise<void> {
  if (!proc || proc.killed || proc.exitCode !== null) return
  const pid = proc.pid
  if (!pid) return

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
      })
      return
    } catch {
      // Se taskkill falhar, tenta terminação normal
    }
  }

  try {
    proc.kill('SIGTERM')
  } catch {
    // ignora
  }

  // Dá 500ms antes de forçar SIGKILL
  await new Promise((r) => setTimeout(r, 300))
  if (proc.exitCode === null) {
    try {
      proc.kill('SIGKILL')
    } catch {
      // ignora
    }
  }
}

/**
 * Inicia o comando de serve configurado sem shell e monitora a prontidão.
 */
export async function startServe(options: {
        command: string[] | string
        cwd: string
        url: string
        timeoutSeconds?: number
    }): Promise<{ process: import('node:child_process').ChildProcess | null; stop: () => Promise<void> }> {
  const { command, cwd, url, timeoutSeconds = 30 } = options
  let cmdArgs = Array.isArray(command) ? [...command] : String(command).split(' ').filter(Boolean)
  if (cmdArgs.length === 0) {
    throw new Error('Comando de serve não pode ser vazio')
  }

  const bin = cmdArgs[0]
  const args = cmdArgs.slice(1)

  const child = spawn(bin, args, {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await terminateProcess(child)
  }

  const ready = await waitForUrlReady(url, timeoutSeconds * 1000)
  if (!ready) {
    await stop()
    throw new Error(`Timeout aguardando prontidão do servidor em ${url} (${timeoutSeconds}s)`)
  }

  return {
    process: child,
    stop,
  }
}

/**
 * Captura superfícies visuais via Playwright como biblioteca.
 */
export async function captureVisualSurface({
  browser,
  url,
  routes = ['/'],
  widths = [1280, 390],
  themes = ['light', 'dark'],
  tree = 'working',
  missionDir,
  revision = 'head',
  commit_sha = 'unknown',
  inspectPage,
}: {
        browser?: any
        url: string
        routes?: Array<string | { path: string; states?: string[] }>
        widths?: number[]
        themes?: Array<'light' | 'dark'>
        tree?: string
        missionDir: string
        revision?: string
        commit_sha?: string
        inspectPage?: (params: { page: any; route: string; width: number; theme: 'light' | 'dark'; consoleMessages: any[]; networkResponses: any[]; stateSnapshots: Record<string, string> }) => Promise<any>
    }): Promise<Capture[]> {
  if (!missionDir) {
    throw new TypeError('missionDir é obrigatório para captureVisualSurface')
  }
  const outDir = path.join(missionDir, 'artifacts', 'visual', tree)
  fs.mkdirSync(outDir, { recursive: true })

  let playBrowser = browser
  let launchedLocally = false

  if (!playBrowser) {
    try {
      const playwrightModule = 'playwright'
      const playwright = await import(playwrightModule)
      playBrowser = await playwright.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      })
      launchedLocally = true
    } catch (err) {
      throw new Error(`Playwright não disponível para captura: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  
  const captures: Capture[] = []

  try {
    for (const routeItem of routes) {
      const routePath = typeof routeItem === 'string' ? routeItem : routeItem.path || '/'

      for (const width of widths) {
        for (const theme of themes) {
          const height = width === 390 ? 844 : 800
          const context = await playBrowser.newContext({
            viewport: { width, height },
            colorScheme: theme,
          })

          const page = await context.newPage()
          
          const consoleMessages: Array<{ type: string; text: string }> = []
          
          const networkResponses: Array<{ url: string; status: number }> = []
          page.on?.('console', (msg: any) => consoleMessages.push({ type: msg.type(), text: msg.text() }))
          page.on?.('response', (response: any) => networkResponses.push({ url: response.url(), status: response.status() }))
          const fullUrl = new URL(routePath, url).href

          await page.goto(fullUrl, { waitUntil: 'load', timeout: 15000 })
          // Tela que busca dados depois do load (o painel lista as missões por fetch) saía vazia no print, e o juiz
          // julgava a tela sem conteúdo (25/09). Espera a rede assentar; websocket aberto não segura a espera.
          await page.waitForLoadState?.('networkidle', { timeout: 8000 }).catch(() => {})
          // Espera estilos e render estabilizarem
          await page.waitForTimeout?.(150)

          const sanitizedRoute = routePath.replace(/[^a-zA-Z0-9_-]/g, '_') || 'root'
          const filename = `${sanitizedRoute}-${width}-${theme}.png`
          const filePath = path.join(outDir, filename)

          let buffer
          if (typeof page.screenshot === 'function') {
            buffer = await page.screenshot({
              fullPage: false, // Viewport somente para não estourar tokens
            })
            fs.writeFileSync(filePath, buffer)
          } else {
            // Se screenshot não disponível no dublê, gera placeholder determinístico
            buffer = Buffer.from(`mock-screenshot-${routePath}-${width}-${theme}`)
            fs.writeFileSync(filePath, buffer)
          }

          const sha256 = createHash('sha256').update(buffer).digest('hex')
          
          const stateSnapshots: Record<string, string> = {}
          const states = typeof routeItem === 'string' ? [] : (routeItem.states || [])
          for (const state of states) {
            const stateUrl = new URL(routePath, url)
            stateUrl.searchParams.set('state', state)
            await page.goto(stateUrl.href, { waitUntil: 'load', timeout: 15000 })
            stateSnapshots[state] = typeof page.content === 'function' ? await page.content() : ''
          }
          const inspection = inspectPage
            ? await inspectPage({ page, route: routePath, width, theme, consoleMessages, networkResponses, stateSnapshots })
            : undefined
          captures.push({
            route: routePath,
            width,
            theme,
            url: fullUrl,
            path: filePath.replace(/\\/g, '/'),
            revision,
            commit_sha,
            at: new Date().toISOString(),
            sha256,
            ...(inspection === undefined ? {} : { inspection }),
          })

          await context.close?.()
        }
      }
    }
  } finally {
    if (launchedLocally && playBrowser) {
      await playBrowser.close?.()
    }
  }

  return captures
}
