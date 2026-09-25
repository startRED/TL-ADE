import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as nomes from '../src/nomes.mjs'

test('saudar cumprimenta pelo nome', () => {
  assert.equal(nomes.saudar('Ada'), 'Olá, Ada!')
})

// Prova do pedido de PEDIDO.md: nasce vermelha e fica verde quando o pedido é entregue.
test('iniciais devolve a primeira letra maiúscula de cada palavra', () => {
  assert.equal(typeof nomes.iniciais, 'function')
  assert.equal(nomes.iniciais('ada lovelace'), 'AL')
  assert.equal(nomes.iniciais('  grace   brewster hopper '), 'GBH')
  assert.equal(nomes.iniciais(''), '')
})
