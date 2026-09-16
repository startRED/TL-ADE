// Formulário de login. Projeto de exemplo usado pelo protótipo da TL-ADE.
// Bug conhecido: o botão "Entrar" continua ativo enquanto o envio está em curso,
// então um duplo clique dispara dois logins.

export function createLoginForm({ login }) {
  const form = document.createElement('form')
  form.innerHTML = `
    <label>E-mail <input name="email" type="email" required></label>
    <label>Senha <input name="password" type="password" required></label>
    <button type="submit">Entrar</button>
    <p class="error" hidden></p>
  `
  const button = form.querySelector('button')
  const error = form.querySelector('.error')

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    const data = new FormData(form)
    try {
      await login({ email: data.get('email'), password: data.get('password') })
    } catch (err) {
      error.textContent = err.message
      error.hidden = false
    }
  })

  return { form, button, error }
}
