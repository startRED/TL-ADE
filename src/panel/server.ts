import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdeError } from '../journal/errors.ts'
import { approveMission } from '../mission/plan-lifecycle.ts'
import { requestMissionControl } from '../engine/control.ts'
import { createInterventionController } from './control.ts'
import { defaultChatAgent } from './chat/agent.ts'
import { createChat, type ChatAgent } from './chat/chat.ts'
import { createSessionManager } from './session.ts'
import { createLocalQuotaPort } from '../adapters/local/quota.ts'
import { readModelsView, readUsage, setManualQuota, updateModelSettings, type QuotaPort } from './models-api.ts'
import { createIntake, defaultIntent, spawnMissionRun, type IntentPort, type RunMission } from './intake.ts'
import { pickFolder } from './folder-picker.ts'
import { assertProjectPath, createOpenProjects } from './open-projects.ts'
import { eligibleSkills, listPlugins, listSkills, readProjectOptions, readSkill, saveProjectOptions, setPlugin } from './options.ts'
import { listProjects, registerProject } from './projects.ts'
import { listUnits, readUnit } from './units.ts'
import { resolveCurrentBuild } from './web-build.ts'
import { createWebSocketHandler } from './websocket.ts'
import { checkNativeSqlite, readPanelSnapshot, rebuildProjection } from './sqlite-index.ts'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

/** Biblioteca do terminal embutido (dependência pinada de packages/web). */

const XTERM_FILES: Record<string, string> = {
  '/vendor/xterm.js': path.join('lib', 'xterm.js'),
  '/vendor/xterm.css': path.join('css', 'xterm.css'),
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Lê o corpo JSON; corpo malformado é erro de entrada (400), não objeto vazio. */
async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  let text = ''
  for await (const chunk of req) text += chunk
  try {
    return JSON.parse(text)
  } catch {
    throw new AdeError('invalid_json', 'Corpo da requisição não é JSON válido.', 2)
  }
}

/**
 * Arquivo do build para o caminho pedido: o próprio arquivo, ou o index.html para caminho de tela.
 * Qualquer segmento '..' (cru ou codificado) fica de fora: null vira 404.
 */
function resolveBuildFile(buildDir: string, rawUrl: string): string | null {
  let rawPath: string
  try {
    rawPath = decodeURIComponent(rawUrl.split('?')[0])
  } catch {
    return null
  }
  if (rawPath.split(/[\\/]/).includes('..')) return null
  const candidate = path.resolve(buildDir, `.${rawPath}`)
  const relative = path.relative(buildDir, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  if (relative && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  return path.extname(rawPath) ? null : path.join(buildDir, 'index.html')
}

/**
 * Abre o navegador padrão apontando para a URL informada.
 */
export async function defaultOpenBrowser(url: string): Promise<void> {
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
 */
export async function startServer({
  repoDir = process.cwd(),
  port = 4173,
  host = '127.0.0.1',
  openBrowser = true,
  webDistDir,
  deps = {},
}: {
        repoDir?: string
        port?: number
        host?: string
        openBrowser?: boolean
        /** Raiz dos builds do painel (current.json + builds/); padrão packages/web/dist. */
        webDistDir?: string
        deps?: {
            homeDir?: string
            stdout?: { write: (s: string) => void } | ((s: string) => void)
            stderr?: { write: (s: string) => void } | ((s: string) => void)
            openBrowser?: (url: string) => Promise<void>
            checkNativeSqlite?: () => any
            /** Compilador de intenção do pedido do painel (padrão: o da real). */
            intent?: IntentPort
            /** Execução da missão aprovada (padrão: bin/ade.js run --plan). */
            runMission?: RunMission
            /** Agente do chat do painel, que roda na cópia do projeto (padrão: a CLI da empresa escolhida). */
            chatAgent?: ChatAgent
            /** Leitura oficial da cota (padrão: recibo local em ~/.ade/quota-receipt.json). */
            quotaPort?: QuotaPort
            /** Relógio da página Modelos e do relatório de uso. */
            now?: () => number
            /** Catálogo de skills sincronizado (padrão: ~/.ade/catalog). */
            catalogDir?: string
        } & import('./control.ts').TerminalDeps
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
  const homeDir = deps.homeDir ?? os.homedir()

  // 2. Verificação antecipada da dependência nativa
  const probeFn = deps.checkNativeSqlite ?? checkNativeSqlite
  probeFn()

  // 3 e 4. Projetos abertos, cada um com o próprio lease exclusivo (exit 5 se colisão) e projeção inicial
  const projects = createOpenProjects()
  const { indexPath } = await projects.open(resolvedRepo)
  const quotaPort = deps.quotaPort ?? createLocalQuotaPort({ receiptPath: path.join(homeDir, '.ade', 'quota-receipt.json') })
  const now = deps.now ?? Date.now
  const catalogDir = deps.catalogDir ?? path.join(homeDir, '.ade', 'catalog')
  const activeProject = () => {
    if (!projects.activeId) throw new AdeError('project_not_found', 'Nenhum projeto aberto.', 2)
    return projects.get(projects.activeId)
  }

  // 5. Canal WebSocket unidirecional
  const stderrWrite =
    typeof deps.stderr === 'function'
      ? deps.stderr
      : (deps.stderr?.write?.bind(deps.stderr) ?? process.stderr.write.bind(process.stderr))
  const intake = createIntake({
    intent: deps.intent ?? defaultIntent,
    runMission: deps.runMission ?? spawnMissionRun,
    eligibleSkills: (repo) => eligibleSkills(catalogDir, repo),
    beginActivity: projects.beginActivity,
    onError: stderrWrite,
  })
  const chat = createChat({
    agent: deps.chatAgent ?? defaultChatAgent,
    beginActivity: projects.beginActivity,
    missionRunning: (projectId) => projects.hasActivity(projectId, 'mission'),
    onError: stderrWrite,
  })
  const intervention = createInterventionController({ repoDir: resolvedRepo, terminal: deps })
  const wsHandler = createWebSocketHandler({
    sessionManager,
    repoDir: resolvedRepo,
    findTerminal: intervention.findTerminal,
    onJournalChanged: () => rebuildProjection({ repoDir: resolvedRepo, indexPath }),
    onError: (err) => stderrWrite(`ade serve: falha ao atualizar painel: ${err instanceof Error ? err.message : String(err)}\n`),
  })

  // 6. Servidor HTTP
  const packageDir = fileURLToPath(new URL('../..', import.meta.url))
  const rootIndexHtml = path.join(packageDir, 'index.html')
  const webPkgDir = path.join(packageDir, 'packages', 'web')
  const distRoot = webDistDir ?? path.join(webPkgDir, 'dist')

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${host}:${port}`)
      const pathname = parsedUrl.pathname
      const method = req.method || 'GET'

      const xtermFile = XTERM_FILES[pathname]
      if (xtermFile) {
        let content
        try {
          content = await fs.promises.readFile(path.join(packageDir, 'node_modules', '@xterm', 'xterm', xtermFile))
        } catch (err) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { code: 'terminal_asset_missing', message: `xterm indisponível: ${err instanceof Error ? err.message : err}` } }))
          return
        }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(xtermFile)] })
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

      // Build promovido servido como SPA; sem ele, o index.html da raiz (ponteiro relido a cada pedido).
      if (!pathname.startsWith('/api/') && method === 'GET') {
        const buildDir = resolveCurrentBuild(distRoot)
        if (!buildDir) {
          if (pathname === '/' || pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(fs.readFileSync(rootIndexHtml))
            return
          }
        } else {
          const file = resolveBuildFile(buildDir, req.url || '/')
          if (file) {
            res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' })
            res.end(fs.readFileSync(file))
            return
          }
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

        if (pathname.startsWith('/api/projects') || pathname.startsWith('/api/models') || pathname === '/api/usage' || pathname.startsWith('/api/skills')) {
          try {
            if (pathname === '/api/skills' && method === 'GET') {
              const filter = (k: string) => parsedUrl.searchParams.get(k) || undefined
              sendJson(res, 200, listSkills(catalogDir, { domain: filter('domain'), trust: filter('trust'), source: filter('source') }))
              return
            }
            const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/)
            if (skillMatch && method === 'GET') {
              sendJson(res, 200, readSkill(catalogDir, decodeURIComponent(skillMatch[1])))
              return
            }
            const settingsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(options|plugins)$/)
            if (settingsMatch && (method === 'GET' || method === 'POST')) {
              const repo = projects.get(decodeURIComponent(settingsMatch[1])).path
              if (settingsMatch[2] === 'options') {
                sendJson(res, 200, method === 'GET' ? readProjectOptions(repo) : saveProjectOptions(repo, await readJsonBody(req)))
              } else {
                if (method === 'POST') setPlugin(catalogDir, repo, await readJsonBody(req))
                sendJson(res, 200, listPlugins(catalogDir, repo))
              }
              return
            }
            if (pathname === '/api/models' && method === 'GET') {
              sendJson(res, 200, await readModelsView(activeProject().path, now(), quotaPort))
              return
            }
            if (pathname === '/api/models/settings' && method === 'POST') {
              sendJson(res, 200, updateModelSettings(activeProject().path, await readJsonBody(req)))
              return
            }
            if (pathname === '/api/models/quota' && method === 'POST') {
              setManualQuota(activeProject().path, await readJsonBody(req), now())
              sendJson(res, 200, { ok: true })
              return
            }
            if (pathname === '/api/usage' && method === 'GET') {
              sendJson(res, 200, await readUsage(activeProject(), parsedUrl.searchParams.get('since'), now(), quotaPort))
              return
            }
            if (pathname === '/api/projects' && method === 'GET') {
              const open = projects.list()
              const registered = listProjects({ homeDir })
                .filter((r) => !open.some((p) => p.path === path.resolve(r.path)))
                .map((r) => ({ id: r.id, name: r.name, path: path.resolve(r.path), open: false, active: false }))
              sendJson(res, 200, [...open.map((p) => ({ ...p, open: true })), ...registered])
              return
            }
            const snapshotMatch = pathname.match(/^\/api\/projects\/([^/]+)\/snapshot$/)
            if (snapshotMatch && method === 'GET') {
              const project = projects.get(decodeURIComponent(snapshotMatch[1]))
              sendJson(res, 200, await readPanelSnapshot({ repoDir: project.path, indexPath: project.indexPath }))
              return
            }
            const unitsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/missions\/([^/]+)\/units(?:\/([^/]+))?$/)
            if (unitsMatch && method === 'GET') {
              const project = projects.get(decodeURIComponent(unitsMatch[1]))
              const missionId = decodeURIComponent(unitsMatch[2])
              sendJson(res, 200, unitsMatch[3]
                ? await readUnit(project.path, missionId, decodeURIComponent(unitsMatch[3]))
                : listUnits(project.path, missionId))
              return
            }
            const chatMatch = pathname.match(/^\/api\/projects\/([^/]+)\/chat(?:\/(approve|reject|clear))?$/)
            if (chatMatch) {
              const project = projects.get(decodeURIComponent(chatMatch[1]))
              const action = chatMatch[2]
              if (!action && method === 'GET') {
                sendJson(res, 200, await chat.read(project))
                return
              }
              if (method === 'POST') {
                const body = await readJsonBody(req)
                if (!action) {
                  await chat.ask(project, body)
                  sendJson(res, 202, { ok: true })
                } else {
                  sendJson(res, 200, action === 'clear' ? await chat.clear(project) : await chat[action as 'approve' | 'reject'](project, body?.id))
                }
                return
              }
            }
            const intakeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(requests|intake|intake\/interview|intake\/(?:briefing|plan)\/(?:approve|reject))$/)
            if (intakeMatch) {
              const project = projects.get(decodeURIComponent(intakeMatch[1]))
              const action = intakeMatch[2]
              if (action === 'intake' && method === 'GET') {
                // ?if_missing=null: o painel pergunta sem gerar 404 (erro no console) em projeto sem pedido.
                const missingAsNull = parsedUrl.searchParams.get('if_missing') === 'null'
                sendJson(res, 200, missingAsNull ? intake.find(project.path) : intake.read(project.path))
                return
              }
              if (action !== 'intake' && method === 'POST') {
                const body = await readJsonBody(req)
                if (action === 'requests') {
                  sendJson(res, 202, { mission_id: (await intake.submit(project.path, body?.text)).mission_id })
                } else if (action === 'intake/interview') {
                  sendJson(res, 200, await intake.answer(project.path, body?.answers))
                } else if (action === 'intake/briefing/approve') {
                  sendJson(res, 200, await intake.approveBriefing(project.path, body?.digest))
                } else if (action === 'intake/plan/approve') {
                  sendJson(res, 200, await intake.approvePlan(project, body?.digest))
                } else {
                  sendJson(res, 200, await intake.reject(project.path, action === 'intake/briefing/reject' ? 'briefing' : 'plan', body?.reason))
                }
                return
              }
            }
            if (method === 'POST' && pathname === '/api/projects/pick') {
              sendJson(res, 200, { path: await pickFolder() })
              return
            }
            if (method === 'POST' && pathname === '/api/projects/open') {
              const repoPath = assertProjectPath((await readJsonBody(req))?.path)
              const wasOpen = projects.list().some((p) => p.path === repoPath)
              const { id, name, path: openedPath } = await projects.open(repoPath)
              try {
                registerProject({ repoDir: openedPath, homeDir })
              } catch (err) {
                // Registro falhou: desfaz a abertura para o estado bater com a resposta de erro.
                if (!wasOpen) projects.close(id)
                throw err
              }
              projects.select(id)
              sendJson(res, 200, { id, name, path: openedPath })
              return
            }
            if (method === 'POST' && (pathname === '/api/projects/close' || pathname === '/api/projects/select')) {
              const id = (await readJsonBody(req))?.id
              if (typeof id !== 'string') throw new AdeError('project_id_invalid', 'Informe o id do projeto.', 2)
              if (pathname.endsWith('/close')) projects.close(id)
              else projects.select(id)
              sendJson(res, 200, { ok: true })
              return
            }
          } catch (err) {
            if (!(err instanceof AdeError)) throw err
            const status = err.code === 'project_not_found' || err.code === 'intake_not_found' || err.code === 'unit_not_found' || err.code === 'chat_proposal_not_found' || err.code === 'skill_not_found' ? 404 : err.exitCode === 5 ? 409 : 400
            sendJson(res, status, { error: err.code, message: err.message })
            return
          }
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

          
          let payload: any = {}
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

        const controlMatch = pathname.match(/^\/api\/actions\/(pause|resume|takeover|release)$/)
        if (controlMatch && method === 'POST') {
          let bodyText = ''
          for await (const chunk of req) {
            bodyText += chunk
          }
          
          let payload: any
          try {
            payload = JSON.parse(bodyText)
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_json' }))
            return
          }
          try {
            const action = controlMatch[1]
            // Pausa e retomada só gravam o pedido durável; quem executa a missão registra a transição.
            // Takeover e devolução exigem STOPPED: o painel vira o escritor único enquanto controla.
            const result = action === 'takeover'
              ? await intervention.takeover(payload)
              : action === 'release'
                ? await intervention.release(payload)
                : await requestMissionControl({
                  repoDir: resolvedRepo,
                  missionId: payload?.mission_id,
                  action: (action as 'pause' | 'resume'),
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
    wsHandler.handleUpgrade(req, (socket as import('node:net').Socket), head)
  })

  // Escuta de porta
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      projects.closeAll()
      if ((err as any).code === 'EADDRINUSE') {
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
    await intervention.closeAll()
    projects.closeAll()
    await new Promise((resolve) => {
      server.close(() => resolve(undefined))
    })
  }

  return {
    server,
    port,
    sessionToken: sessionManager.token,
    url: serverUrl,
    projects,
    close,
  }
}
