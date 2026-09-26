const usd = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Custo equivalente de API em dólar, com vírgula brasileira: US$ 158,62. */
export const brl = (value: number) => `US$ ${usd.format(value)}`

/** Tempo desde `startIso` até `endMs` em horas e minutos: "38 min", "5 h 12 min". */
export function elapsed(startIso: string, endMs: number): string {
  const min = Math.floor((endMs - Date.parse(startIso)) / 60_000)
  if (min < 1) return 'menos de 1 min'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`
}

export const hour = (at: string) => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Caminho longo cabe numa linha: a raiz e as duas últimas pastas, que dizem qual projeto é. O inteiro vai no title. */
export function shortPath(full: string): string {
  const parts = full.split(/[\\/]/).filter(Boolean)
  if (full.length <= 48 || parts.length <= 3) return full
  const sep = full.includes('\\') ? '\\' : '/'
  return [parts[0], '…', ...parts.slice(-2)].join(sep)
}
