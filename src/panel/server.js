// @ts-check
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdeError } from '../journal/errors.js'
import { approveMission } from '../mission/plan-lifecycle.js'
import { requestMissionControl } from '../engine/control.js'
import { createSessionManager } from './session.js'
import { acquireServeLease } from './serve-lease.js'
import { createWebSocketHandler } from './websocket.js'
import { checkNativeSqlite, readPanelSnapshot, rebuildProjection } from './sqlite-index.js'

/** @type {Record<string, string>} */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Abre o navegador padrão apontando para a URL informada.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function defaultOpenBrowser(url) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('rundll32', ['url.dll,FileProtocolHandler', url], {
        shell: false,
        maxBuffer: 64 * 1024,
      }, () => resolve())
    } else if (process.platform === 'darwin') {
      execFile('open', [url], {
        shell: false,
        maxBuffer: 64 * 1024,
      }, () => resolve())
    } else {
      execFile('xdg-open', [url], {
        shell: false,
        maxBuffer: 64 * 1024,
      }, () => resolve())
    }
  })
}

/**
 * Inicia o servidor local protegido do painel da TL-ADE.
 *
 * @param {{
 *   repoDir?: string,
 *   port?: number,
 *   host?: string,
 *   openBrowser?: boolean,
 *   deps?: {
 *     stdout?: { write: (s: string) => void } | ((s: string) => void),
 *     stderr?: { write: (s: string) => void } | ((s: string) => void),
 *     openBrowser?: (url: string) => Promise<void>,
 *     checkNativeSqlite?: () => any,
 *   },
 * }} [options]
 */
export async function startServer({
  repoDir = process.cwd(),
  port = 4173,
  host = '127.0.0.1',
  openBrowser = true,
  deps = {},
} = {}) {
  const sessionManager = createSessionManager({ allowedOrigins: [`http://${host}:${port}`] })

  // 1. Validação estrita do host de ligação (critério 9)
  if (!sessionManager.validateBindHost(host)) {
    throw new AdeError(
      'forbidden_host',
      `Servidor restrito a 127.0.0.1. Tentativa de escuta em host externo "${host}" recusada.`,
      1,
    )
  }

  const resolvedRepo = path.resolve(repoDir)

  // 2. Verificação antecipada da dependência nativa
  const probeFn = deps.checkNativeSqlite ?? checkNativeSqlite
  probeFn()

  // 3. Obtenção do lease exclusivo (critério 11: exit 5 se colisão)
  const lease = acquireServeLease({ repoDir: resolvedRepo })

  // 4. Assegura a projeção inicial
  const indexPath = path.join(resolvedRepo, '.ade', 'index.sqlite')
  if (!fs.existsSync(indexPath)) {
    await rebuildProjection({ repoDir: resolvedRepo, indexPath })
  }

  // 5. Canal WebSocket unidirecional
  const stderrWrite =
    typeof deps.stderr === 'function'
      ? deps.stderr
      : (deps.stderr?.write?.bind(deps.stderr) ?? process.stderr.write.bind(process.stderr))
  const wsHandler = createWebSocketHandler({
    sessionManager,
    repoDir: resolvedRepo,
    onJournalChanged: () => rebuildProjection({ repoDir: resolvedRepo, indexPath }),
    onError: (err) => stderrWrite(`ade serve: falha ao atualizar painel: ${err instanceof Error ? err.message : String(err)}\n`),
  })

  // 6. Servidor HTTP
  const packageDir = fileURLToPath(new URL('../..', import.meta.url))
  const rootIndexHtml = path.join(packageDir, 'index.html')
  const webPkgDir = path.join(packageDir, 'packages', 'web')

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${host}:${port}`)
      const pathname = parsedUrl.pathname
      const method = req.method || 'GET'

      // Rotas estáticas públicas da aplicação web
      if (pathname === '/' || pathname === '/index.html') {
        const content = fs.readFileSync(rootIndexHtml)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(content)
        return
      }

      if (pathname.startsWith('/packages/web/')) {
        const sub = pathname.replace('/packages/web/', '')
        const filePath = path.resolve(webPkgDir, sub)
        const relative = path.relative(webPkgDir, filePath)
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase()
          const mime = MIME_TYPES[ext] || 'application/octet-stream'
          const content = fs.readFileSync(filePath)
          res.writeHead(200, { 'Content-Type': mime })
          res.end(content)
          return
        }
      }

      // Rotas da API protegidas por sessão e origem (critérios 7 e 8)
      if (pathname.startsWith('/api/')) {
        const tokenHeader = req.headers['x-ade-session']
        const tokenCandidate =
          parsedUrl.searchParams.get('session') ||
          (Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader) ||
          req.headers.authorization?.replace(/^Bearer\s+/i, '')

        if (!sessionManager.validateToken(tokenCandidate)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized', code: 401 }))
          return
        }

        const origin = req.headers.origin
        if (!sessionManager.validateOrigin(origin)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'forbidden_origin', code: 403 }))
          return
        }

        if (pathname === '/api/snapshot' && method === 'GET') {
          const snapshot = await readPanelSnapshot({ repoDir: resolvedRepo, indexPath })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(snapshot))
          return
        }

        if (pathname.startsWith('/api/artifacts/') && method === 'GET') {
          const ref = decodeURIComponent(pathname.replace('/api/artifacts/', '')).replace(/^artifacts[\\/]/, '')
          const snapshot = await readPanelSnapshot({ repoDir: resolvedRepo, indexPath })
          const missionId = snapshot.selectedMission?.id
          const artDir = missionId ? path.join(resolvedRepo, '.ade', 'missions', missionId, 'artifacts') : ''
          const candidate = artDir ? path.resolve(artDir, ref) : ''
          const relative = artDir ? path.relative(artDir, candidate) : '..'
          const targetFile = relative && !relative.startsWith('..') && !path.isAbsolute(relative) &&
            fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null

          if (targetFile) {
            const ext = path.extname(targetFile).toLowerCase()
            const mime = MIME_TYPES[ext] || 'application/octet-stream'
            const content = fs.readFileSync(targetFile)
            res.writeHead(200, { 'Content-Type': mime })
            res.end(content)
            return
          }

          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'artifact_not_found', code: 404 }))
          return
        }

        if (pathname === '/api/actions/approve' && method === 'POST') {
          let bodyText = ''
          for await (const chunk of req) {
            bodyText += chunk
          }

          /** @type {any} */
          let payload = {}
          try {
            payload = JSON.parse(bodyText)
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_json', approved: false }))
            return
          }

          const result = await approveMission({
            repoDir: resolvedRepo,
            missionId: payload.mission_id,
            expectedDigest: payload.digest,
            source: 'panel',
          })

          if (result.approved) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          }
          return
        }

        const controlMatch = pathname.match(/^\/api\/actions\/(pause|resume)$/)
        if (controlMatch && method === 'POST') {
          let bodyText = ''
          for await (const chunk of req) {
            bodyText += chunk
          }
          /** @type {any} */
          let payload
          try {
            payload = JSON.parse(bodyText)
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_json' }))
            return
          }
          try {
            // O painel só grava o pedido durável; quem executa a missão registra a transição.
            const result = await requestMissionControl({
              repoDir: resolvedRepo,
              missionId: payload?.mission_id,
              action: /** @type {'pause' | 'resume'} */ (controlMatch[1]),
              expectedDigest: payload?.digest,
              source: 'panel',
            })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err) {
            if (!(err instanceof AdeError)) throw err
            res.writeHead(err.exitCode === 5 ? 409 : 400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.code, message: err.message }))
          }
          return
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found', code: 404 }))
    } catch (err) {
      stderrWrite(`ade serve: erro ao atender requisição: ${err instanceof Error ? err.message : String(err)}\n`)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal_error' }))
    }
  })

  // WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    wsHandler.handleUpgrade(req, /** @type {import('node:net').Socket} */ (socket), head)
  })

  // Escuta de porta
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      lease.release()
      if (/** @type {any} */ (err).code === 'EADDRINUSE') {
        reject(new AdeError('port_in_use', `Porta ${port} já está em uso por outro processo`, 1, { port }))
      } else {
        reject(err)
      }
    })

    server.listen(port, host, () => {
      resolve(undefined)
    })
  })

  const serverUrl = `http://${host}:${port}/?session=${sessionManager.token}`

  const stdoutWrite =
    typeof deps.stdout === 'function'
      ? deps.stdout
      : (deps.stdout?.write?.bind(deps.stdout) ?? process.stdout.write.bind(process.stdout))

  stdoutWrite(`Painel TL-ADE disponível em ${serverUrl}\n`)

  if (openBrowser) {
    const opener = deps.openBrowser ?? defaultOpenBrowser
    try {
      await opener(serverUrl)
    } catch {}
  }

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    wsHandler.closeAll()
    lease.release()
    await new Promise((resolve) => {
      server.close(() => resolve(undefined))
    })
  }

  return {
    server,
    port,
    sessionToken: sessionManager.token,
    url: serverUrl,
    close,
  }
}
