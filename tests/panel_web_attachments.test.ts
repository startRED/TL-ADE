import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { Page } from 'playwright'

import { makeRepo } from './helpers/git-repo.ts'
import { removeTmpDir } from './helpers/tmp-dir.ts'
import { openPanel, startPanelForTest } from './helpers/panel_ui.ts'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
const upload = (name: string, buffer: Buffer, mimeType: string) => ({ name, buffer, mimeType })
const image = upload('imagem.png', png, 'image/png')
const pdfFile = upload('documento.pdf', pdf, 'application/pdf')
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function panel() {
  const repo = makeRepo()
  writeFileSync(path.join(repo.dir, 'README.md'), '# projeto de teste\n')
  repo.git(['add', '.'])
  repo.git(['commit', '-m', 'inicio'])
  cleanups.push(() => removeTmpDir(repo.dir))
  const server = await startPanelForTest({
    repoDirs: [repo.dir],
    deps: {
      intent: {
        async compile() {
          return { questions: [{ id: 'Q1', text: 'Confirmar?', options: [{ id: 'sim', label: 'Sim' }] }] }
        },
      },
    },
  })
  cleanups.push(() => server.close())
  const ui = await openPanel(server.url)
  cleanups.push(() => ui.browser.close())
  await ui.page.getByLabel('Pedido').waitFor()
  return { repo: repo.dir, page: ui.page }
}

function fileInput(page: Page) {
  return page.locator('form.composer input[type="file"]')
}

async function attach(page: Page, files: ReturnType<typeof upload>[]) {
  const clip = page.getByRole('button', { name: 'Anexar arquivos' })
  expect(await clip.count()).toBe(1)
  expect(await fileInput(page).count()).toBe(1)
  await fileInput(page).setInputFiles(files)
}

async function tabTo(page: Page, buttonName: string) {
  const button = page.getByRole('button', { name: buttonName })
  // o anexo entra depois da leitura em base64, que é assíncrona
  await button.first().waitFor()
  expect(await button.count()).toBe(1)
  if (await button.evaluate((element) => element === document.activeElement)) return
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab')
    if (await button.evaluate((element) => element === document.activeElement)) return
  }
  expect(await button.evaluate((element) => element === document.activeElement)).toBe(true)
}

// miniatura de verdade: a imagem carregou, e não caiu para etiqueta
async function thumbnail(page: Page, name: string) {
  await page.waitForFunction((alt) => {
    const img = Array.from(document.querySelectorAll<HTMLImageElement>('form.composer img')).find((x) => x.alt === alt)
    return !!img && img.complete && img.naturalWidth > 0
  }, name)
  expect(await page.locator('form.composer li.attach.thumb img').evaluateAll((xs, alt) => xs.filter((x) => (x as HTMLImageElement).alt === alt).length, name)).toBe(1)
}

describe('anexos no campo do pedido', () => {
  test('C3.1 clipe nativo múltiplo mostra miniatura PNG e etiqueta PDF antes do envio', async () => {
    const { page } = await panel()
    expect(await page.getByRole('button', { name: 'Anexar arquivos' }).count()).toBe(1)
    expect(await fileInput(page).count()).toBe(1)
    expect(await fileInput(page).getAttribute('multiple')).not.toBeNull()
    const accept = await fileInput(page).getAttribute('accept')
    expect(accept).toMatch(/image\/|\.png/i)
    expect(accept).toMatch(/\.pdf|application\/pdf/i)
    expect(accept).toMatch(/\.txt/i)
    expect(accept).toMatch(/\.md/i)
    await attach(page, [image, pdfFile])
    // a leitura em base64 é assíncrona: espera o anexo entrar antes de contar
    await page.getByRole('button', { name: 'Remover documento.pdf' }).waitFor()
    await thumbnail(page, 'imagem.png')
    expect(await page.locator('form.composer img[alt="documento.pdf"]').count()).toBe(0)
    expect(await page.getByText('documento.pdf', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Remover imagem.png' }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Remover documento.pdf' }).count()).toBe(1)
  }, 120_000)

  test('C3.1 PNG válido com File.type vazio ou genérico ainda vira miniatura', async () => {
    const { page } = await panel()
    // o Playwright deduz o MIME pelo nome: o File com tipo vazio ou genérico nasce no próprio navegador
    const types = await fileInput(page).evaluate((input: HTMLInputElement, data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'sem-tipo.png', { type: '' }))
      dt.items.add(new File([bytes], 'generico.png', { type: 'application/octet-stream' }))
      input.files = dt.files
      const seen = Array.from(input.files, (f) => f.type)
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return seen
    }, png.toString('base64'))
    expect(types).toEqual(['', 'application/octet-stream'])
    await page.getByRole('button', { name: 'Remover generico.png' }).waitFor()
    await thumbnail(page, 'sem-tipo.png')
    await thumbnail(page, 'generico.png')
    expect(await page.getByRole('alert').count()).toBe(0)
  }, 120_000)

  test('C3.2 X remove só o anexo escolhido', async () => {
    const { page } = await panel()
    await attach(page, [image, pdfFile])
    await page.getByRole('button', { name: 'Remover documento.pdf' }).waitFor()
    await page.getByRole('button', { name: 'Remover imagem.png' }).click()
    expect(await page.getByRole('button', { name: 'Remover imagem.png' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Remover documento.pdf' }).count()).toBe(1)
    expect(await page.getByText('documento.pdf', { exact: true }).count()).toBe(1)
  }, 120_000)

  test('C3.3 rejeita 11º arquivo, mais de 10 MB e tipo não aceito com alerta visível', async () => {
    const { page } = await panel()
    const ten = Array.from({ length: 10 }, (_, i) => upload(`nota-${i}.txt`, Buffer.from('ok'), 'text/plain'))
    await attach(page, ten)
    await page.getByRole('button', { name: 'Remover nota-9.txt' }).waitFor()
    await fileInput(page).setInputFiles([upload('decimo-primeiro.txt', Buffer.from('não entra'), 'text/plain')])
    expect(await page.getByRole('alert').count()).toBe(1)
    expect(await page.getByRole('alert').textContent()).toMatch(/limite|10 arquivos/i)
    expect(await page.getByRole('button', { name: 'Remover decimo-primeiro.txt' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: /^Remover nota-/ }).count()).toBe(10)

    await page.reload()
    await page.getByLabel('Pedido').waitFor()
    await attach(page, [upload('grande.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 97), 'text/plain')])
    expect(await page.getByRole('alert').count()).toBe(1)
    expect(await page.getByRole('alert').textContent()).toMatch(/10 MB|limite/i)
    expect(await page.getByRole('button', { name: 'Remover grande.txt' }).count()).toBe(0)

    await page.reload()
    await page.getByLabel('Pedido').waitFor()
    await attach(page, [upload('arquivo.zip', Buffer.from('PK\u0003\u0004'), 'application/zip')])
    expect(await page.getByRole('alert').count()).toBe(1)
    expect(await page.getByRole('alert').textContent()).toMatch(/tipo|aceito/i)
    expect(await page.getByRole('button', { name: 'Remover arquivo.zip' }).count()).toBe(0)
  }, 120_000)

  test('C3.3 recusa na hora formatos que o servidor não grava e soma seleções seguidas', async () => {
    const { page } = await panel()
    const svg = upload('vetor.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')
    const markdown = upload('notas.markdown', Buffer.from('# notas'), 'text/markdown')
    const fake = upload('falsa.png', Buffer.from('não sou png'), 'image/png')
    await attach(page, [image, svg, markdown, fake])
    await page.getByRole('button', { name: 'Remover imagem.png' }).waitFor()
    await page.getByRole('alert').filter({ hasText: 'falsa.png' }).waitFor()
    const alert = await page.getByRole('alert').textContent()
    expect(alert).toMatch(/vetor\.svg: tipo não aceito/)
    expect(alert).toMatch(/notas\.markdown: tipo não aceito/)
    expect(alert).toMatch(/falsa\.png: o conteúdo não corresponde/)
    for (const name of ['vetor.svg', 'notas.markdown', 'falsa.png']) {
      expect(await page.getByRole('button', { name: `Remover ${name}` }).count()).toBe(0)
    }
    await fileInput(page).setInputFiles([pdfFile])
    await page.getByRole('button', { name: 'Remover documento.pdf' }).waitFor()
    expect(await page.getByRole('button', { name: 'Remover imagem.png' }).count()).toBe(1)
  }, 120_000)

  test('C3.3 recusa extensões herdadas do protótipo sem travar o envio', async () => {
    const { page } = await panel()
    const inherited = ['arquivo.constructor', 'arquivo.tostring', 'arquivo.__proto__', 'arquivo.hasownproperty']
    await attach(page, inherited.map((name) => upload(name, Buffer.from('x'), 'application/octet-stream')))
    await page.getByRole('alert').filter({ hasText: 'arquivo.constructor' }).waitFor()
    const alert = await page.getByRole('alert').textContent()
    for (const name of inherited) {
      expect(alert).toContain(`${name}: tipo não aceito`)
      expect(await page.getByRole('button', { name: `Remover ${name}` }).count()).toBe(0)
    }
    await fileInput(page).setInputFiles([pdfFile])
    await page.getByRole('button', { name: 'Remover documento.pdf' }).waitFor()
    await page.getByLabel('Pedido').fill('Leia o anexo')
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/requests') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Enviar pedido' }).click()
    expect((await responsePromise).status()).toBe(202)
  }, 120_000)

  test('C3.4 envio leva base64 e texto a /requests, grava os bytes e avança para entrevista', async () => {
    const { repo, page } = await panel()
    await attach(page, [image, pdfFile])
    await page.getByRole('button', { name: 'Remover documento.pdf' }).waitFor()
    await page.getByLabel('Pedido').fill('Leia os anexos')
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/requests') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Enviar pedido' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(202)
    expect(response.request().postDataJSON()).toEqual({
      text: 'Leia os anexos',
      attachments: [
        { name: 'imagem.png', data: png.toString('base64') },
        { name: 'documento.pdf', data: pdf.toString('base64') },
      ],
    })
    await page.getByRole('heading', { name: 'Entrevista' }).waitFor()
    const missions = path.join(repo, '.ade', 'missions')
    const [mission] = readdirSync(missions)
    const dir = path.join(missions, mission, 'attachments')
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['documento.pdf', 'imagem.png'])
    expect(readFileSync(path.join(dir, 'imagem.png'))).toEqual(png)
    expect(readFileSync(path.join(dir, 'documento.pdf'))).toEqual(pdf)
  }, 120_000)

  test('C3.5 clipe e X são alcançáveis e acionáveis por teclado', async () => {
    const { page } = await panel()
    await page.getByLabel('Pedido').focus()
    await tabTo(page, 'Anexar arquivos')
    const chooserPromise = page.waitForEvent('filechooser')
    await page.keyboard.press('Enter')
    const chooser = await chooserPromise
    expect(chooser.isMultiple()).toBe(true)
    await chooser.setFiles([image, pdfFile])
    await tabTo(page, 'Remover imagem.png')
    await page.keyboard.press('Enter')
    expect(await page.getByRole('button', { name: 'Remover imagem.png' }).count()).toBe(0)
    await tabTo(page, 'Remover documento.pdf')
    await page.keyboard.press('Space')
    expect(await page.getByRole('button', { name: 'Remover documento.pdf' }).count()).toBe(0)
  }, 120_000)
  test('C3.6 Ctrl+V com imagem anexa; prints seguidos ganham nomes próprios e texto colado segue texto', async () => {
    const { page } = await panel()
    const field = page.getByLabel('Pedido')
    // o print do sistema chega como image.png, sempre com o mesmo nome
    const paste = (withText: boolean) => field.evaluate((el, [data, text]) => {
      const bytes = Uint8Array.from(atob(data as string), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      if (text) dt.setData('text/plain', 'texto copiado')
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      el.dispatchEvent(ev)
      return ev.defaultPrevented
    }, [png.toString('base64'), withText])
    expect(await paste(false)).toBe(true)
    await page.getByRole('button', { name: 'Remover imagem-colada-1.png' }).waitFor()
    expect(await paste(false)).toBe(true)
    await page.getByRole('button', { name: 'Remover imagem-colada-2.png' }).waitFor()
    await thumbnail(page, 'imagem-colada-2.png')
    // área de transferência com texto (Word, Excel): o texto vence e nada é anexado
    expect(await paste(true)).toBe(false)
    expect(await page.locator('form.composer li.attach').count()).toBe(2)
    expect(await page.getByRole('alert').count()).toBe(0)
  }, 120_000)

  test('C3.7 campo cresce com o texto e o botão expande e retrai o pedido longo', async () => {
    const { page } = await panel()
    const field = page.getByLabel('Pedido')
    const height = () => field.evaluate((el) => el.getBoundingClientRect().height)
    const empty = await height()
    expect(await page.getByRole('button', { name: 'Expandir campo' }).count()).toBe(0)
    await field.fill(Array.from({ length: 6 }, (_, i) => `linha ${i + 1}`).join('\n'))
    const six = await height()
    expect(six).toBeGreaterThan(empty)
    await field.fill(Array.from({ length: 60 }, (_, i) => `linha ${i + 1}`).join('\n'))
    const capped = await height()
    // cresce um pouco, não muito: o teto fica bem abaixo da altura da janela
    expect(capped).toBeLessThan(await page.evaluate(() => innerHeight * 0.45))
    const expand = page.getByRole('button', { name: 'Expandir campo' })
    await expand.waitFor()
    await expand.click()
    // o teto muda com transição: mede depois que ela assenta
    await expect.poll(height).toBeGreaterThan(capped * 1.5)
    const retract = page.getByRole('button', { name: 'Retrair campo' })
    // aberto, o campo não empurra Retrair e Enviar para fora da janela
    await expect.poll(() => page.getByRole('button', { name: 'Enviar pedido' }).evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true)
    expect(await retract.evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true)
    expect(await retract.getAttribute('aria-expanded')).toBe('true')
    await retract.click()
    await expect.poll(height).toBe(capped)
  }, 120_000)
})
