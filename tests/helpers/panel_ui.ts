import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { vi } from 'vitest'

import { buildWebPanel, resolveCurrentBuild } from '../../src/panel/web-build.ts'
import { startServer } from '../../src/panel/server.ts'
import { makeTmpDir, removeTmpDir } from './tmp-dir.ts'

// Fechar o chromium espera o processo sair e o Playwright apagar o perfil temporário, com novas tentativas enquanto
// os processos filhos seguram arquivos (Windows); com a suíte inteira rodando, o afterEach que fecha navegador e
// servidor passa dos 10 s padrão do vitest (perfis sobrando no temp mostram o fechamento lento, não travado).
// Vale para o arquivo que importa este helper, antes de ele registrar os hooks.
vi.setConfig({ hookTimeout: 60_000 })

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

/** Pedido HTTP ao servidor do painel, com token de sessão e corpo JSON opcionais. */
export function apiRequest(port: number, rawPath: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (options.token) headers['x-ade-session'] = options.token
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    if (payload) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: options.method ?? 'GET', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end(payload)
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

const BUILD_LOCK = path.join(DIST_ROOT, 'build.lock')

/** Processo vivo? EPERM é processo de outro dono, mas vivo. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** PID gravado na trava; 0 quando ela sumiu ou ainda está vazia. */
function lockHolder(): number {
  try {
    return Number(readFileSync(BUILD_LOCK, 'utf8')) || 0
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
}

/**
 * Trava entre os processos de prova (um por arquivo): um compila por vez e os outros reusam o build que ele promoveu.
 * Sem ela, cada arquivo de prova do painel compila junto quando o painel muda, um build apaga o do outro e a
 * máquina cheia estoura o tempo das limpezas. Trava deixada por processo morto é tomada.
 */
async function withBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(DIST_ROOT, { recursive: true })
  for (;;) {
    try {
      writeFileSync(BUILD_LOCK, String(process.pid), { flag: 'wx' })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const holder = lockHolder()
    // ponytail: dois à espera podem tomar juntos a trava de um morto e compilar os dois; só custo, o ponteiro é atômico.
    if (holder > 0 && !alive(holder)) rmSync(BUILD_LOCK, { force: true })
    else await new Promise((resolve) => setTimeout(resolve, 250))
  }
  try {
    return await fn()
  } finally {
    if (lockHolder() === process.pid) rmSync(BUILD_LOCK, { force: true })
  }
}

let buildOnce: Promise<string> | null = null

/**
 * Garante um build promovido do código atual, uma vez por processo de prova; build que falha derruba a prova.
 * Reusa o build promovido quando nenhuma fonte do painel mudou depois dele: o tsc + vite build (8 s parado,
 * mais de 80 s com a máquina cheia) sai da suíte inteira e só roda quando o painel muda, em um processo só.
 */
export function ensureWebBuild(): Promise<string> {
  buildOnce ??= withBuildLock(async () => {
    // ponytail: frescor pela data de modificação, como o make; fonte restaurada com data antiga não recompila.
    const current = resolveCurrentBuild(DIST_ROOT)
    if (current && statSync(path.join(current, 'index.html')).mtimeMs > newestPanelSourceMtime()) return current
    const result = await buildWebPanel({ webDir: WEB_DIR })
    if (!result.promoted) throw new Error(`Build do painel falhou:\n${result.error}`)
    return result.distDir
  })
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
