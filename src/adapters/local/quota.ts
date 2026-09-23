// @ts-check
import fs from 'node:fs'
import path from 'node:path'

async function readValidReceipt(receiptPath: string, family: string | undefined, now: number | string | Date | undefined): Promise<any | null> {
  let receipt
  try {
    const raw = await fs.promises.readFile(receiptPath, 'utf8')
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
}

/**
 * Lê o recibo oficial publicado no diretório local da ADE, validando frescor, família e fonte oficial.
 */
export function createLocalQuotaPort(options: { receiptPath?: string } = {}): { readReceipt: (params?: { family?: string; now?: number | string | Date }) => Promise<any | null> } {
  return {
    readReceipt: async ({ family, now } = {}) => {
      if (!options.receiptPath) return null
      // Recibo único (legado) ou o de cada família, gravado pela leitura oficial (refreshQuotaReceipts).
      const candidates = [options.receiptPath, ...(family ? [path.join(path.dirname(options.receiptPath), `quota-${family}.json`)] : [])]
      for (const candidate of candidates) {
        const receipt = await readValidReceipt(candidate, family, now)
        if (receipt) return receipt
      }
      return null
    },
  }
}
/**
 * Verifica a disponibilidade real de cota oficial através de probe controlado.
 */
export async function verifyRealQuotaAvailability({ family, probe }: { family?: string; probe?: (opts?: any) => Promise<any> } = {}): Promise<{ available: boolean; family?: string; source: 'official'; probe_ok: boolean }> {
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
