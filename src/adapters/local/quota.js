// @ts-check
import fs from 'node:fs'

/**
 * Lê o recibo oficial publicado no diretório local da ADE, validando frescor, família e fonte oficial.
 *
 * @param {{ receiptPath?: string }} [options]
 * @returns {{ readReceipt: (params?: { family?: string, now?: number | string | Date }) => Promise<any | null> }}
 */
export function createLocalQuotaPort(options = {}) {
  return {
    readReceipt: async ({ family, now } = {}) => {
      if (!options.receiptPath) return null
      let receipt
      try {
        const raw = await fs.promises.readFile(options.receiptPath, 'utf8')
        receipt = JSON.parse(raw)
      } catch {
        return null
      }

      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
        return null
      }

      if (receipt.source !== 'official') {
        return null
      }

      if (family && (typeof receipt.family !== 'string' || receipt.family !== family)) {
        return null
      }

      const nowTime = typeof now === 'number' ? now : (now ? new Date(now).getTime() : Date.now())

      if (!receipt.observed_at || !receipt.weekly_reset_at) {
        return null
      }

      const obsTime = new Date(receipt.observed_at).getTime()
      const resetTime = new Date(receipt.weekly_reset_at).getTime()
      if (!Number.isFinite(obsTime) || !Number.isFinite(resetTime)) {
        return null
      }

      if (nowTime - obsTime > 86400000 || nowTime > resetTime) {
        return null
      }

      return receipt
    },
  }
}
/**
 * Verifica a disponibilidade real de cota oficial através de probe controlado.
 *
 * @param {{ family?: string, probe?: (opts?: any) => Promise<any> }} [params]
 * @returns {Promise<{ available: boolean, family?: string, source: 'official', probe_ok: boolean }>}
 */
export async function verifyRealQuotaAvailability({ family, probe } = {}) {
  if (typeof probe === 'function') {
    try {
      const probeResult = await probe({ family })
      const ok = Boolean(probeResult && probeResult.reachable)
      return {
        available: ok,
        family,
        source: 'official',
        probe_ok: ok,
      }
    } catch {
      return {
        available: false,
        family,
        source: 'official',
        probe_ok: false,
      }
    }
  }

  return {
    available: false,
    family,
    source: 'official',
    probe_ok: false,
  }
}
