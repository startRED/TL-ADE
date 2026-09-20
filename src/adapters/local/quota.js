// @ts-check
import fs from 'node:fs'

/**
 * Lê o recibo oficial publicado no diretório local da ADE.
 *
 * @param {{ receiptPath?: string }} [options]
 * @returns {{ readReceipt: ({ family, now }: { family: string, now: number }) => Promise<any | null> }}
 */
export function createLocalQuotaPort(options = {}) {
  return {
    readReceipt: async () => {
      if (!options.receiptPath) return null
      try {
        return JSON.parse(await fs.promises.readFile(options.receiptPath, 'utf8'))
      } catch {
        return null
      }
    },
  }
}
