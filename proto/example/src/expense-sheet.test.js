import { describe, it, expect } from 'vitest'
import { createExpenseSheet } from './expense-sheet.js'

function addExpense(form, description, amount) {
  form.querySelector('[name=description]').value = description
  form.querySelector('[name=amount]').value = amount
  form.dispatchEvent(new Event('submit', { cancelable: true }))
}

describe('planilha de gastos', () => {
  it('soma os valores lançados e mostra o total atualizado', () => {
    const { form, total } = createExpenseSheet()
    addExpense(form, 'Mercado', '50')
    addExpense(form, 'Transporte', '12.5')
    expect(total.textContent).toBe('R$ 62,50')
  })
})
