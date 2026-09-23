import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { buildWebPanel, resolveCurrentBuild } from '../src/panel/web-build.ts'
import { startServer } from '../src/panel/server.ts'
import { readPanelSnapshot } from '../src/panel/sqlite-index.ts'
import { makeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'
import { freePort, openPanel, startPanelForTest } from './helpers/panel_ui.ts'

let cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

function tmp(prefix: string): string {
  const dir = makeTmpDir(prefix)
  cleanups.push(() => removeTmpDir(dir))
  return dir
}

function gitFixture(): string {
  const repo = makeRepo()
  writeFileSync(path.join(repo.dir, 'README.md'), '# fixture\n')
  repo.git(['add', '.'])
  repo.git(['commit', '-m', 'inicio'])
  cleanups.push(() => removeTmpDir(repo.dir))
  return repo.dir
}

/** runBuild dublê: grava um index.html com a marca informada, com pausas para intercalar pedidos. */
function fakeBuild(marker: string, pauses = 0) {
  return async (outDir: string) => {
    for (let i = 0; i < pauses; i++) await new Promise((r) => setTimeout(r, 5))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'index.html'), `<html>${marker}</html>`)
  }
}

function failingBuild(message: string) {
  return async (outDir: string) => {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'index.html'), '<html>quebrado</html>')
    throw new Error(message)
  }
}

async function serve(repoDir: string, extra: { webDistDir?: string; homeDir?: string } = {}) {
  const port = await freePort()
  const server = await startServer({
    repoDir,
    port,
    openBrowser: false,
    webDistDir: extra.webDistDir,
    deps: { stdout: () => {}, homeDir: extra.homeDir ?? tmp('ade-home-') },
  })
  cleanups.push(() => server.close())
  return server
}

function request(port: number, rawPath: string, options: { method?: string; token?: string; origin?: string; body?: unknown } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (options.token) headers['x-ade-session'] = options.token
    if (options.origin) headers.origin = options.origin
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

const api = (server: { port: number; sessionToken: string }, p: string, method = 'GET', body?: unknown) =>
  request(server.port, p, { method, token: server.sessionToken, body })

describe('painel novo servido do último build e vários projetos', () => {
  test('criterio_1_build_que_passa_e_promovido_e_servido_em_get_raiz', async () => {
    const webDir = tmp('ade-web-')
    const result = await buildWebPanel({ webDir, runBuild: fakeBuild('build-A') })
    expect(result.promoted).toBe(true)
    expect(result.error).toBeUndefined()
    expect(readFileSync(path.join(result.distDir, 'index.html'), 'utf8')).toBe('<html>build-A</html>')
    expect(resolveCurrentBuild(path.join(webDir, 'dist'))).toBe(result.distDir)

    const server = await serve(tmp('ade-repo-'), { webDistDir: path.join(webDir, 'dist') })
    const res = await request(server.port, '/')
    expect(res.status).toBe(200)
    expect(res.body).toBe('<html>build-A</html>')
  })

  test('criterio_2_build_que_falha_nao_promove_e_o_anterior_continua_igual_e_servido', async () => {
    const webDir = tmp('ade-web-')
    const distRoot = path.join(webDir, 'dist')
    const first = await buildWebPanel({ webDir, runBuild: fakeBuild('build-A') })
    const pointerBefore = readFileSync(path.join(distRoot, 'current.json'))
    const indexBefore = readFileSync(path.join(first.distDir, 'index.html'))

    for (const message of ['tsc: erro de tipo', 'vite build falhou']) {
      const second = await buildWebPanel({ webDir, runBuild: failingBuild(message) })
      expect(second.promoted).toBe(false)
      expect(second.error).toContain(message)
      expect(second.distDir).toBe(first.distDir)
    }
    expect(readFileSync(path.join(distRoot, 'current.json')).equals(pointerBefore)).toBe(true)
    expect(readFileSync(path.join(first.distDir, 'index.html')).equals(indexBefore)).toBe(true)
    // Só o build anterior sobra: as pastas dos builds que falharam foram removidas.
    expect(readdirSync(path.join(distRoot, 'builds'))).toEqual([path.basename(first.distDir)])

    const server = await serve(tmp('ade-repo-'), { webDistDir: distRoot })
    expect((await request(server.port, '/')).body).toBe('<html>build-A</html>')
  })

  test('criterio_3_promocao_durante_gets_em_laco_nunca_serve_fallback_nem_erro', async () => {
    const webDir = tmp('ade-web-')
    const distRoot = path.join(webDir, 'dist')
    await buildWebPanel({ webDir, runBuild: fakeBuild('build-A') })
    const server = await serve(tmp('ade-repo-'), { webDistDir: distRoot })

    const bodies: Array<{ status: number; body: string }> = []
    let done = false
    const loop = (async () => {
      let extra = 20
      while (!done || extra-- > 0) bodies.push(await request(server.port, '/'))
    })()
    const result = await buildWebPanel({ webDir, runBuild: fakeBuild('build-B', 10) })
    done = true
    await loop

    expect(result.promoted).toBe(true)
    expect(bodies.length).toBeGreaterThan(20)
    for (const r of bodies) {
      expect(r.status).toBe(200)
      expect(['<html>build-A</html>', '<html>build-B</html>']).toContain(r.body)
    }
    expect(bodies.at(-1)?.body).toBe('<html>build-B</html>')
    // Guarda o atual e o anterior.
    expect(readdirSync(path.join(distRoot, 'builds'))).toHaveLength(2)
  })

  test('criterio_4_gravacao_do_ponteiro_que_lanca_deixa_build_anterior_intacto', async () => {
    const webDir = tmp('ade-web-')
    const distRoot = path.join(webDir, 'dist')
    const first = await buildWebPanel({ webDir, runBuild: fakeBuild('build-A') })
    const pointerBefore = readFileSync(path.join(distRoot, 'current.json'))

    const second = await buildWebPanel({
      webDir,
      runBuild: fakeBuild('build-B'),
      fsOps: { writeFileAtomic: () => { throw new Error('disco cheio') } },
    })
    expect(second.promoted).toBe(false)
    expect(second.error).toContain('disco cheio')
    expect(second.distDir).toBe(first.distDir)
    expect(readFileSync(path.join(distRoot, 'current.json')).equals(pointerBefore)).toBe(true)
    expect(readFileSync(path.join(first.distDir, 'index.html'), 'utf8')).toBe('<html>build-A</html>')
    expect(readdirSync(path.join(distRoot, 'builds'))).toEqual([path.basename(first.distDir)])

    const server = await serve(tmp('ade-repo-'), { webDistDir: distRoot })
    expect((await request(server.port, '/')).body).toBe('<html>build-A</html>')
  })

  test('criterio_5_sem_build_promovido_get_raiz_entrega_index_html_da_raiz', async () => {
    const distRoot = tmp('ade-dist-vazio-')
    expect(resolveCurrentBuild(distRoot)).toBeNull()
    // Ponteiro para build que não existe também não conta como promovido.
    writeFileSync(path.join(distRoot, 'current.json'), JSON.stringify({ build: 'sumiu' }))
    expect(resolveCurrentBuild(distRoot)).toBeNull()

    const server = await serve(tmp('ade-repo-'), { webDistDir: distRoot })
    const res = await request(server.port, '/')
    expect(res.status).toBe(200)
    expect(res.body).toBe(readFileSync(path.join(process.cwd(), 'index.html'), 'utf8'))
  })

  test('criterio_6_caminho_de_tela_entrega_index_do_build_e_ponto_ponto_recebe_404', async () => {
    const webDir = tmp('ade-web-')
    const distRoot = path.join(webDir, 'dist')
    const built = await buildWebPanel({ webDir, runBuild: fakeBuild('build-A') })
    mkdirSync(path.join(built.distDir, 'assets'))
    writeFileSync(path.join(built.distDir, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(path.join(distRoot, 'segredo.txt'), 'fora do build')

    const server = await serve(tmp('ade-repo-'), { webDistDir: distRoot })
    for (const screen of ['/modelos', '/projetos/abc']) {
      const res = await request(server.port, screen)
      expect(res.status).toBe(200)
      expect(res.body).toBe('<html>build-A</html>')
    }
    const asset = await request(server.port, '/assets/app.js')
    expect(asset.body).toBe('console.log(1)')
    for (const escape of ['/../segredo.txt', '/assets/../../segredo.txt', '/%2e%2e/segredo.txt', '/..%2fsegredo.txt']) {
      const res = await request(server.port, escape)
      expect(res.status, escape).toBe(404)
      expect(res.body).not.toContain('fora do build')
    }
  })

  test('criterio_7_rotas_de_projetos_sem_sessao_ou_com_origem_de_fora_recusam', async () => {
    const server = await serve(tmp('ade-repo-'))
    const routes: Array<[string, string, unknown]> = [
      ['GET', '/api/projects', undefined],
      ['POST', '/api/projects/open', { path: 'x' }],
      ['POST', '/api/projects/close', { id: 'x' }],
      ['POST', '/api/projects/select', { id: 'x' }],
      ['GET', '/api/projects/x/snapshot', undefined],
    ]
    for (const [method, p, body] of routes) {
      expect((await request(server.port, p, { method, body })).status, p).toBe(401)
      expect((await request(server.port, p, { method, body, token: 'errado' })).status, p).toBe(401)
      expect((await request(server.port, p, { method, body, token: server.sessionToken, origin: 'http://evil.example' })).status, p).toBe(403)
    }
  })

  test('criterio_8_dois_repositorios_abertos_sao_listados_e_cada_um_tem_sua_projecao', async () => {
    const repoA = gitFixture()
    const repoB = gitFixture()
    const server = await serve(tmp('ade-inicio-'))

    const opened = []
    for (const repo of [repoA, repoB]) {
      const res = await api(server, '/api/projects/open', 'POST', { path: repo })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toEqual({ id: expect.any(String), name: path.basename(repo), path: path.resolve(repo) })
      opened.push(body)
    }
    expect(opened[0].id).not.toBe(opened[1].id)

    const list = JSON.parse((await api(server, '/api/projects')).body)
    for (const p of opened) {
      expect(list).toContainEqual({ ...p, open: true, active: expect.any(Boolean) })
    }
    expect(list.filter((p: { active: boolean }) => p.active)).toHaveLength(1)

    for (const p of opened) {
      const res = await api(server, `/api/projects/${encodeURIComponent(p.id)}/snapshot`)
      expect(res.status).toBe(200)
      const expected = await readPanelSnapshot({ repoDir: p.path, indexPath: path.join(p.path, '.ade', 'index.sqlite') })
      expect(JSON.parse(res.body)).toEqual(JSON.parse(JSON.stringify(expected)))
    }
    expect((await api(server, '/api/projects/nao-existe/snapshot')).status).toBe(404)
  })

  test('criterio_9_caminho_inexistente_ou_sem_git_responde_400_em_portugues_e_nao_registra', async () => {
    const home = tmp('ade-home-')
    const server = await serve(tmp('ade-inicio-'), { homeDir: home })
    const semGit = tmp('ade-sem-git-')
    for (const bad of [path.join(semGit, 'nao-existe'), semGit, '', 42]) {
      const res = await api(server, '/api/projects/open', 'POST', { path: bad })
      expect(res.status, String(bad)).toBe(400)
      const body = JSON.parse(res.body)
      expect(body.error).toEqual(expect.any(String))
      expect(body.message).toMatch(/não|inválid/i)
    }
    const list = JSON.parse((await api(server, '/api/projects')).body)
    expect(list.map((p: { path: string }) => p.path)).not.toContain(path.resolve(semGit))
    expect(existsSync(path.join(home, '.ade', 'projects.json'))).toBe(false)
    expect(existsSync(path.join(semGit, '.ade'))).toBe(false)
  })

  test('criterio_10_projeto_com_lease_de_outro_servidor_responde_409_e_nao_fica_aberto', async () => {
    const repo = gitFixture()
    await serve(repo)
    const other = await serve(tmp('ade-inicio-'))

    const res = await api(other, '/api/projects/open', 'POST', { path: repo })
    expect(res.status).toBe(409)
    const list = JSON.parse((await api(other, '/api/projects')).body)
    expect(list.filter((p: { path: string; open: boolean }) => p.path === path.resolve(repo) && p.open)).toHaveLength(0)
  })

  test('criterio_11_fechar_com_atividade_em_execucao_responde_409_e_depois_de_release_fecha', async () => {
    const repo = gitFixture()
    const server = await serve(tmp('ade-inicio-'))
    const { id } = JSON.parse((await api(server, '/api/projects/open', 'POST', { path: repo })).body)
    const leasePath = path.join(repo, '.ade', 'serve.lease')

    for (const kind of ['mission', 'chat'] as const) {
      const release = server.projects.beginActivity(id, kind)
      expect(server.projects.hasActivity(id)).toBe(true)
      const res = await api(server, '/api/projects/close', 'POST', { id })
      expect(res.status).toBe(409)
      expect(JSON.parse((await api(server, '/api/projects')).body)).toContainEqual(expect.objectContaining({ id, open: true }))
      expect(JSON.parse(readFileSync(leasePath, 'utf8')).pid).toBe(process.pid)
      release()
      release()
      expect(server.projects.hasActivity(id)).toBe(false)
    }

    const res = await api(server, '/api/projects/close', 'POST', { id })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(existsSync(leasePath)).toBe(false)
    expect((await api(server, '/api/projects/close', 'POST', { id })).status).toBe(404)
    expect((await api(server, '/api/projects/select', 'POST', { id })).status).toBe(404)
  })

  test('criterio_12_no_navegador_abre_dois_projetos_e_troca_o_ativo_pela_lista', async () => {
    const repoA = gitFixture()
    const repoB = gitFixture()
    const panel = await startPanelForTest({ repoDirs: [repoA] })
    cleanups.push(() => panel.close())
    const ui = await openPanel(panel.url)
    cleanups.push(() => ui.browser.close())
    const { page } = ui
    const nameA = path.basename(repoA)
    const nameB = path.basename(repoB)

    await expect.poll(() => page.getByTestId('active-project').textContent()).toBe(nameA)
    await page.getByRole('button', { name: 'Projetos' }).click()
    await page.getByLabel('Caminho da pasta').fill(repoB)
    await page.getByRole('button', { name: 'Abrir' }).click()
    await expect.poll(() => page.getByTestId('active-project').textContent()).toBe(nameB)

    await page.getByRole('button', { name: `Usar ${nameA}` }).click()
    await expect.poll(() => page.getByTestId('active-project').textContent()).toBe(nameA)
    await expect.poll(() => page.getByTestId('project-state').textContent()).toContain(path.resolve(repoA))

    await page.getByRole('button', { name: `Usar ${nameB}` }).click()
    await expect.poll(() => page.getByTestId('active-project').textContent()).toBe(nameB)
    await expect.poll(() => page.getByTestId('project-state').textContent()).toContain(path.resolve(repoB))
    expect(ui.consoleErrors).toEqual([])
  }, 180_000)

  test('criterio_13_tema_escolhido_fica_fixo_e_persiste_ao_recarregar', async () => {
    const panel = await startPanelForTest({ repoDirs: [gitFixture()] })
    cleanups.push(() => panel.close())
    const ui = await openPanel(panel.url)
    cleanups.push(() => ui.browser.close())
    const { page } = ui
    const theme = () => page.evaluate(() => `${document.documentElement.dataset.palette}/${document.documentElement.dataset.theme}`)

    await expect.poll(theme).toBe('cobalto/dark')
    expect(await page.getByRole('switch').count()).toBe(0)
    await page.getByRole('button', { name: 'Aparência' }).click()
    await page.getByRole('radio', { name: /Papel/ }).click()
    await expect.poll(theme).toBe('papel/light')
    await page.reload()
    await expect.poll(theme).toBe('papel/light')
    expect(ui.consoleErrors).toEqual([])
  }, 180_000)

  test('criterio_14_servidor_iniciado_como_nas_provas_antigas_mantem_seguranca_e_lista_o_projeto_inicial', async () => {
    const repo = tmp('ade-antigo-')
    const port = await freePort()
    const server = await startServer({ repoDir: repo, port, openBrowser: false, deps: { stdout: () => {} } })
    cleanups.push(() => server.close())

    expect(existsSync(path.join(repo, '.ade', 'serve.lease'))).toBe(true)
    expect((await request(port, '/api/snapshot')).status).toBe(401)
    expect((await request(port, '/api/snapshot', { token: server.sessionToken, origin: 'http://evil.example' })).status).toBe(403)
    expect((await api(server, '/api/snapshot')).status).toBe(200)
    expect(server.projects.list()).toEqual([
      expect.objectContaining({ path: path.resolve(repo), active: true }),
    ])
  })
})
