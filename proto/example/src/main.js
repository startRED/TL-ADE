// Página do app. Monta cada componente listado em components.json.
// Convenção: todo módulo visual exporta `mount(container)`.
const app = document.getElementById('app')
const list = await (await fetch('./src/components.json')).json()
for (const { file, title } of list) {
  const section = document.createElement('section')
  section.innerHTML = `<h2>${title}</h2>`
  app.appendChild(section)
  try {
    const mod = await import(`./${file}`)
    if (typeof mod.mount === 'function') mod.mount(section)
    else section.insertAdjacentHTML('beforeend', `<p class="empty">${file} não exporta mount(container).</p>`)
  } catch (err) {
    section.insertAdjacentHTML('beforeend', `<p class="error">Não carregou ${file}: ${err.message}</p>`)
  }
}
