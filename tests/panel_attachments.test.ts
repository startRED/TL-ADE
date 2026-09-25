import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { startServer } from '../src/panel/server.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'
import { apiRequest, freePort } from './helpers/panel_ui.ts'

type Attachment = { name: string; data: string }
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
const file = (name: string, bytes: Buffer): Attachment => ({ name, data: bytes.toString('base64') })
const missions = (repo: string) => path.join(repo, '.ade', 'missions')
const missionFolders = (repo: string) => fs.existsSync(missions(repo)) ? fs.readdirSync(missions(repo)) : []
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function panel() {
  const repo = makeRepo()
  cleanups.push(() => removeRepo(repo.dir))
  fs.writeFileSync(path.join(repo.dir, 'README.md'), '# projeto de teste\n')
  repo.git(['add', '.'])
  repo.git(['commit', '-m', 'inicio'])
  const homeDir = makeTmpDir('ade-attachments-home-')
  cleanups.push(() => removeTmpDir(homeDir))
  let intentCalls = 0
  const server = await startServer({
    repoDir: repo.dir,
    port: await freePort(),
    openBrowser: false,
    deps: {
      homeDir,
      stdout: () => {},
      intent: {
        async compile() {
          intentCalls++
          return { questions: [{ id: 'Q1', text: 'Confirmar?', options: [{ id: 'sim', label: 'Sim' }] }] }
        },
      },
    },
  })
  cleanups.push(() => server.close())
  const projectId = server.projects.list()[0].id
  const route = `/api/projects/${encodeURIComponent(projectId)}/requests`
  const request = async (body: unknown) => {
    const res = await apiRequest(server.port, route, { method: 'POST', token: server.sessionToken, body })
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return { repo: repo.dir, server, route, request, get intentCalls() { return intentCalls } }
}

describe('anexos do pedido no painel', () => {
  test('C1.1 guarda PNG e Markdown com bytes íntegros e registra ambos no intake', async () => {
    const p = await panel()
    const markdown = Buffer.from('# Referência\nConteúdo do pedido.\n', 'utf8')
    const res = await p.request({ text: 'Use os arquivos', attachments: [file('imagem.png', png), file('notas.md', markdown)] })
    expect(res.status).toBe(202)
    const missionDir = path.join(missions(p.repo), res.body.mission_id)
    const attachmentsDir = path.join(missionDir, 'attachments')
    expect(fs.existsSync(attachmentsDir)).toBe(true)
    expect(fs.readdirSync(attachmentsDir).sort()).toEqual(['imagem.png', 'notas.md'])
    expect(fs.readFileSync(path.join(attachmentsDir, 'imagem.png'))).toEqual(png)
    expect(fs.readFileSync(path.join(attachmentsDir, 'notas.md'))).toEqual(markdown)
    const intake = JSON.parse(fs.readFileSync(path.join(missionDir, 'intake.json'), 'utf8'))
    expect(intake.attachments).toHaveLength(2)
    expect(JSON.stringify(intake.attachments)).toContain('imagem.png')
    expect(JSON.stringify(intake.attachments)).toContain('notas.md')
  })

  test('C1.2 rejeita onze arquivos e arquivo acima de 10 MB antes de criar missão ou chamar a IA', async () => {
    for (const attachments of [
      Array.from({ length: 11 }, (_, i) => file(`nota-${i}.txt`, Buffer.from('ok'))),
      [file('grande.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 97))],
    ]) {
      const p = await panel()
      const res = await p.request({ text: 'Analise os anexos', attachments })
      expect(res.status).toBe(400)
      expect(res.body.message).toMatch(/limite|m[aá]ximo|10\s*(?:MB|arquivos)/i)
      expect(missionFolders(p.repo)).toEqual([])
      expect(p.intentCalls).toBe(0)
    }
  })

  test('C1.3 rejeita extensão ZIP e PNG com assinatura inválida', async () => {
    for (const attachment of [file('arquivo.zip', Buffer.from('PK\u0003\u0004')), file('falso.png', Buffer.from('isto não é PNG'))]) {
      const p = await panel()
      const res = await p.request({ text: 'Analise o arquivo', attachments: [attachment] })
      expect(res.status).toBe(400)
      expect(res.body.message).toMatch(/tipo.*(?:n[aã]o.*aceito|inv[aá]lido)|(?:n[aã]o.*aceito|inv[aá]lido).*tipo/i)
      expect(missionFolders(p.repo)).toEqual([])
      expect(p.intentCalls).toBe(0)
    }
  })

  test('C1.4 saneia nomes com travessia e separadores sem escrever fora de attachments', async () => {
    const p = await panel()
    const bytes = Buffer.from('conteúdo seguro\n')
    const res = await p.request({ text: 'Leia o anexo', attachments: [file('../../fora.txt', bytes), file('pasta\\outro.txt', bytes)] })
    expect(res.status).toBe(202)
    const dir = path.join(missions(p.repo), res.body.mission_id, 'attachments')
    expect(fs.existsSync(dir)).toBe(true)
    const names = fs.readdirSync(dir)
    expect(names).toHaveLength(2)
    for (const name of names) {
      expect(name).not.toMatch(/[\\/]/)
      expect(name).not.toBe('..')
      expect(fs.readFileSync(path.join(dir, name))).toEqual(bytes)
    }
    expect(fs.existsSync(path.join(missions(p.repo), 'fora.txt'))).toBe(false)
    expect(fs.existsSync(path.join(p.repo, 'fora.txt'))).toBe(false)
    expect(fs.existsSync(path.join(p.repo, 'pasta', 'outro.txt'))).toBe(false)
  })

  test('C1.5 limita o corpo da rota com 413 e continua atendendo pedidos', async () => {
    const p = await panel()
    const oversized = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      let responded = false
      const req = http.request({ host: '127.0.0.1', port: p.server.port, path: p.route, method: 'POST', headers: { 'x-ade-session': p.server.sessionToken, 'content-type': 'application/json' } }, (res) => {
        responded = true
        if (!req.writableEnded) req.end()
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (part) => { body += part })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', (err) => { if (!responded) reject(err) })
      req.write('{"text":"')
      const chunk = 'a'.repeat(1024 * 1024)
      let sent = 0
      const send = () => {
        while (!responded && sent < 160) {
          sent++
          if (!req.write(chunk)) break
        }
        if (responded) return
        if (sent >= 160) req.end('"}')
        else req.once('drain', send)
      }
      send()
    })
    expect(oversized.status).toBe(413)
    expect(JSON.parse(oversized.body).message).toMatch(/corpo|pedido|limite|tamanho/i)
    expect(missionFolders(p.repo)).toEqual([])
    expect(p.intentCalls).toBe(0)
    const next = await p.request({ text: 'Pedido seguinte' })
    expect(next.status).toBe(202)
    expect(p.intentCalls).toBe(1)
  }, 120_000)

  test('C1.6 mantém o envio só de texto sem criar pasta de anexos', async () => {
    const p = await panel()
    const res = await p.request({ text: 'Pedido sem arquivos' })
    expect(res.status).toBe(202)
    expect(p.intentCalls).toBe(1)
    const missionDir = path.join(missions(p.repo), res.body.mission_id)
    expect(fs.existsSync(path.join(missionDir, 'attachments'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(missionDir, 'intake.json'), 'utf8')).request).toBe('Pedido sem arquivos')
  })
})
