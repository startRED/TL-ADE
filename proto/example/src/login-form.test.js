import { describe, it, expect, vi } from 'vitest'
import { createLoginForm } from './login-form.js'

function fill(form) {
  form.querySelector('[name=email]').value = 'ana@exemplo.com'
  form.querySelector('[name=password]').value = 'segredo'
}

describe('formulário de login', () => {
  it('envia e-mail e senha ao confirmar', async () => {
    const login = vi.fn().mockResolvedValue(undefined)
    const { form } = createLoginForm({ login })
    fill(form)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await Promise.resolve()
    expect(login).toHaveBeenCalledWith({ email: 'ana@exemplo.com', password: 'segredo' })
  })

  it('mostra a mensagem quando o login falha', async () => {
    const login = vi.fn().mockRejectedValue(new Error('Credenciais inválidas'))
    const { form, error } = createLoginForm({ login })
    fill(form)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe('Credenciais inválidas')
  })

  it('desabilita o botão Entrar enquanto o envio está em curso', async () => {
    let resolveLogin
    const login = vi.fn(() => new Promise((resolve) => { resolveLogin = resolve }))
    const { form, button } = createLoginForm({ login })
    fill(form)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await Promise.resolve()
    expect(button.disabled).toBe(true)
    resolveLogin()
    await new Promise((r) => setTimeout(r, 0))
    expect(button.disabled).toBe(false)
  })
})
