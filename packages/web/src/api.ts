// O servidor abre o painel com ?session=<token>; toda chamada à API leva o token no cabeçalho.
const sessionToken = new URLSearchParams(window.location.search).get('session') ?? ''

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Chama a API do painel e devolve o JSON; resposta de erro vira ApiError com a mensagem do servidor. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('x-ade-session', sessionToken)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  const res = await fetch(path, { ...init, headers })
  const body: unknown = await res.json()
  if (!res.ok) {
    const message = (body as { message?: unknown }).message
    if (res.status === 401) throw new ApiError(401, 'Este link é de uma sessão antiga do painel. Abra o endereço novo que o comando ade serve mostrou no terminal.')
    throw new ApiError(res.status, typeof message === 'string' ? message : `Falha ${res.status} em ${path}.`)
  }
  return body as T
}

export const postJson = <T>(path: string, body: unknown) => apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) })

/** Avisa a cada evento do journal em /api/events; devolve a função que encerra a assinatura. */
export function subscribeEvents(onChange: () => void): () => void {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${scheme}://${window.location.host}/api/events?session=${encodeURIComponent(sessionToken)}`)
  ws.onmessage = () => onChange()
  // ponytail: sem reconexão; o painel recarrega o estado a cada ação do usuário.
  // Fechar ainda conectando vira erro no console: espera abrir para fechar.
  return () => {
    if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close()
    else ws.close()
  }
}
