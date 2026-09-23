import { describe, expect, test } from 'vitest'

import { folderPickerCommand, pickFolder } from '../src/panel/folder-picker.ts'

function fakeExec(result: { err?: (Error & { code?: unknown }) | null; stdout?: string; stderr?: string }) {
  const calls: Array<{ file: string; args: string[]; opts: any }> = []
  const execFile = (file: string, args: string[], opts: any, cb: Function) => {
    calls.push({ file, args, opts })
    cb(result.err ?? null, result.stdout ?? '', result.stderr ?? '')
  }
  return { execFile, calls }
}

function exitError(code: unknown): Error & { code?: unknown } {
  return Object.assign(new Error('saiu'), { code })
}

describe('seletor de pasta nativo', () => {
  test('usa o diálogo de cada sistema, sem shell', () => {
    const win = folderPickerCommand('win32')
    expect(win.file).toBe('powershell.exe')
    const script = Buffer.from(win.args.at(-1) ?? '', 'base64').toString('utf16le')
    expect(script).toContain('IFileDialog')
    expect(folderPickerCommand('darwin').file).toBe('osascript')
    expect(folderPickerCommand('linux').file).toBe('zenity')
  })

  test('devolve o caminho escolhido sem espaços nem quebra de linha', async () => {
    const { execFile, calls } = fakeExec({ stdout: 'E:\\projetos\\app\r\n' })
    await expect(pickFolder({ platform: 'win32', execFile })).resolves.toBe('E:\\projetos\\app')
    expect(calls[0].opts.maxBuffer).toBeGreaterThan(0)
  })

  test('cancelar devolve null em cada sistema', async () => {
    await expect(pickFolder({ platform: 'win32', execFile: fakeExec({ stdout: '\r\n' }).execFile })).resolves.toBeNull()
    await expect(pickFolder({ platform: 'darwin', execFile: fakeExec({ err: exitError(1), stderr: 'User canceled. (-128)' }).execFile })).resolves.toBeNull()
    await expect(pickFolder({ platform: 'linux', execFile: fakeExec({ err: exitError(1) }).execFile })).resolves.toBeNull()
  })

  test('falha real vira AdeError com mensagem para digitar o caminho', async () => {
    await expect(pickFolder({ platform: 'linux', execFile: fakeExec({ err: exitError('ENOENT') }).execFile }))
      .rejects.toMatchObject({ code: 'folder_picker_failed', message: expect.stringContaining('digite o caminho') })
    await expect(pickFolder({ platform: 'darwin', execFile: fakeExec({ err: exitError(1), stderr: 'erro de script' }).execFile }))
      .rejects.toMatchObject({ code: 'folder_picker_failed' })
  })
})
