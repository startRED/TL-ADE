const usd = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Custo equivalente de API em dólar, com vírgula brasileira: US$ 158,62. */
export const brl = (value: number) => `US$ ${usd.format(value)}`

export const hour = (at: string) => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
