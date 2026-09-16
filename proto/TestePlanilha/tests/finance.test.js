import { describe, it, expect } from 'vitest'
import { calcularSaldo } from '../src/finance.js'

describe('calcularSaldo', () => {
  it('soma receitas e subtrai despesas para obter o saldo total', () => {
    const lancamentos = [
      { tipo: 'receita', valor: 1000 },
      { tipo: 'despesa', valor: 300 },
      { tipo: 'receita', valor: 250 },
      { tipo: 'despesa', valor: 120 },
    ]

    expect(calcularSaldo(lancamentos)).toBe(830)
  })
})
