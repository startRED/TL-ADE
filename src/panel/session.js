// @ts-check
import { randomBytes } from 'node:crypto'

/**
 * Cria o gerenciador de sessão efêmera para proteger o servidor local da ADE.
 *
 * @param {{ token?: string, allowedOrigins?: string[] }} [options]
 */
export function createSessionManager(options = {}) {
  const sessionToken = options.token || randomBytes(24).toString('hex')
  const allowedOrigins = new Set(options.allowedOrigins || [])

  return {
    get token() {
      return sessionToken
    },

    /**
     * Valida se o token fornecido corresponde à credencial ativa da sessão.
     *
     * @param {string | null | undefined} candidate
     * @returns {boolean}
     */
    validateToken(candidate) {
      if (!candidate || typeof candidate !== 'string') return false
      return candidate === sessionToken
    },

    /**
     * Valida se a origem da requisição pertence estritamente à máquina local.
     * Rejeita qualquer tentativa de cross-site / external origin.
     *
     * @param {string | null | undefined} originHeader
     * @returns {boolean}
     */
    validateOrigin(originHeader) {
      if (!originHeader) return true // Requisições locais diretas (curl, fetch sem header de browser)

      try {
        return allowedOrigins.has(new URL(originHeader).origin)
      } catch {
        return false
      }
    },

    /**
     * Valida se o endereço de escuta do servidor é seguro (apenas interface local).
     *
     * @param {string | null | undefined} host
     * @returns {boolean}
     */
    validateBindHost(host) {
      if (!host) return true
      const normalized = host.trim().toLowerCase()
      return normalized === '127.0.0.1' || normalized === 'localhost'
    },
  }
}
