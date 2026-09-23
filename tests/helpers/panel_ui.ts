import { readdirSync, statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'

import { buildWebPanel, resolveCurrentBuild } from '../../src/panel/web-build.ts'
import { startServer } from '../../src/panel/server.ts'
import { makeTmpDir, removeTmpDir } from './tmp-dir.ts'

const WEB_DIR = fileURLToPath(new URL('../../packages/web', import.meta.url))
const DIST_ROOT = path.join(WEB_DIR, 'dist')

/** Porta livre em 127.0.0.1, escolhida pelo sistema. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

/** Última modificação nas fontes do painel (packages/web sem dist e node_modules) e no lock das dependências. */
function newestPanelSourceMtime(): number {
  const sources = [path.join(WEB_DIR, '..', '..', 'package-lock.json'), WEB_DIR]
  for (const name of readdirSync(WEB_DIR)) {
    if (name === 'dist' || name === 'node_modules') continue
    const full = path.join(WEB_DIR, name)
    sources.push(full)
    if (statSync(full).isDirectory()) {
      for (const sub of readdirSync(full, { recursive: true, encoding: 'utf8' })) sources.push(path.join(full, sub))
    }
  }
  return Math.max(...sources.map((file) => statSync(file).mtimeMs))
}

let buildOnce: Promise<string> | null = null

/**
 * Garante um build promovido do código atual, uma vez por processo de prova; build que falha derruba a prova.
 * Reusa o build promovido quando nenhuma fonte do painel mudou depois dele: o tsc + vite build (8 s parado,
 * mais de 80 s com a máquina cheia) sai da suíte inteira e só roda quando o painel muda.
 */
export function ensureWebBuild(): Promise<string> {
  buildOnce ??= (async () => {
    // ponytail: frescor pela data de modificação, como o make; fonte restaurada com data antiga não recompila.
    const current = resolveCurrentBuild(DIST_ROOT)
    if (current && statSync(path.join(current, 'index.html')).mtimeMs > newestPanelSourceMtime()) return current
    const result = await buildWebPanel({ webDir: WEB_DIR })
    if (!result.promoted) throw new Error(`Build do painel falhou:\n${result.error}`)
    return result.distDir
  })()
  return buildOnce
}

/** Sobe o servidor com o build promovido; o primeiro repositório é o de inicialização, os demais são abertos em seguida. */
export async function startPanelForTest({ repoDirs, deps = {} }: {
  repoDirs: string[]
  deps?: NonNullable<Parameters<typeof startServer>[0]>['deps']
}): Promise<{ url: string; token: string; server: Awaited<ReturnType<typeof startServer>>; close: () => Promise<void> }> {
  if (repoDirs.length === 0) throw new Error('startPanelForTest precisa de ao menos um repositório.')
  await ensureWebBuild()
  if (!resolveCurrentBuild(DIST_ROOT)) throw new Error(`Nenhum build promovido em ${DIST_ROOT}.`)
  const homeDir = makeTmpDir('ade-panel-ui-home-')
  const server = await startServer({
    repoDir: repoDirs[0],
    port: await freePort(),
    openBrowser: false,
    webDistDir: DIST_ROOT,
    deps: { stdout: () => {}, homeDir, ...deps },
  })
  for (const dir of repoDirs.slice(1)) await server.projects.open(dir)
  return {
    url: server.url,
    token: server.sessionToken,
    server,
    close: async () => {
      await server.close()
      removeTmpDir(homeDir)
    },
  }
}

/** Abre o painel no chromium do Playwright, juntando os erros de console e de página. */
export async function openPanel(url: string): Promise<{ browser: Browser; page: Page; consoleErrors: string[] }> {
  let browser: Browser
  try {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  } catch (err) {
    throw new Error(
      `Chromium do Playwright indisponível para a prova de interface (rode "node node_modules/playwright/cli.js install chromium"): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const page = await browser.newPage()
  const consoleErrors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', (err) => consoleErrors.push(err.message))
  await page.goto(url)
  return { browser, page, consoleErrors }
}
