// node --test proto/skill-meta.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { skillDescription } from './skill-meta.mjs'

test('descrição de uma linha continua como era', () => {
  assert.equal(skillDescription('name: x\ndescription: Faz uma coisa\ntags: []'), 'Faz uma coisa')
})

test('bloco ">" devolve o texto, não o ">"', () => {
  const fm = 'name: ponytail\ndescription: >\n  Primeira linha\n  segunda linha\nargument-hint: "[lite]"'
  assert.equal(skillDescription(fm), 'Primeira linha segunda linha')
})

test('bloco "|" também junta as linhas', () => {
  assert.equal(skillDescription('description: |\n  Uma\n  Duas\nlicense: MIT'), 'Uma Duas')
})

test('para na próxima chave do frontmatter', () => {
  assert.ok(!skillDescription('description: >\n  Texto\nlicense: MIT\nname: y').includes('MIT'))
})

test('tira aspas e corta em 220', () => {
  assert.equal(skillDescription('description: "com aspas"'), 'com aspas')
  assert.equal(skillDescription('description: ' + 'a'.repeat(300)).length, 220)
})

test('sem description devolve vazio', () => {
  assert.equal(skillDescription('name: x\ntags: []'), '')
})
