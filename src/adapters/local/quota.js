// @ts-check

/**
 * Cria a porta local enquanto não há fonte oficial de cota configurada.
 *
 * @returns {{ readReceipt: ({ family, now }: { family: string, now: number }) => Promise<null> }}
 */
export function createUnavailableQuotaPort() {
  return {
    readReceipt: async () => null,
  }
}
