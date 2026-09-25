import { randomBytes } from 'node:crypto'

/**
 * Cria o gerenciador de sessão efêmera para proteger o servidor local da ADE.
 */
export function createSessionManager(options: { token?: string; allowedOrigins?: string[]; cookieName?: string } = {}) {
  const sessionToken = options.token || randomBytes(24).toString('hex')
  const allowedOrigins = new Set(options.allowedOrigins || [])
  const cookieName = options.cookieName || 'ade_session'

  return {
    get token() {
      return sessionToken
    },

    /**
     * Cookie que entrega o token à página servida, para o link do painel ser só host e porta.
     * HttpOnly esconde do JavaScript; SameSite=Strict não viaja em pedido de outro site.
     */
    get cookie() {
      return `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`
    },

    /** Token vindo do cookie da requisição, ou null. */
    tokenFromCookie(cookieHeader: string | undefined): string | null {
      for (const part of (cookieHeader || '').split(';')) {
        const [name, ...value] = part.trim().split('=')
        if (name === cookieName) return value.join('=')
      }
      return null
    },

    /**
     * Só entrega o cookie quando o Host é o próprio servidor: barra DNS rebinding,
     * em que um domínio externo aponta para 127.0.0.1 e leria a página.
     */
    validateHost(hostHeader: string | undefined): boolean {
      return !!hostHeader && allowedOrigins.has(`http://${hostHeader.toLowerCase()}`)
    },

    /**
     * Valida se o token fornecido corresponde à credencial ativa da sessão.
     */
    validateToken(candidate: string | null | undefined): boolean {
      if (!candidate || typeof candidate !== 'string') return false
      return candidate === sessionToken
    },

    /**
     * Valida se a origem da requisição pertence estritamente à máquina local.
     * Rejeita qualquer tentativa de cross-site / external origin.
     */
    validateOrigin(originHeader: string | null | undefined): boolean {
      if (!originHeader) return true // Requisições locais diretas (curl, fetch sem header de browser)

      try {
        return allowedOrigins.has(new URL(originHeader).origin)
      } catch {
        return false
      }
    },

    /**
     * Valida se o endereço de escuta do servidor é seguro (apenas interface local).
     */
    validateBindHost(host: string | null | undefined): boolean {
      if (!host) return true
      const normalized = host.trim().toLowerCase()
      return normalized === '127.0.0.1' || normalized === 'localhost'
    },
  }
}
