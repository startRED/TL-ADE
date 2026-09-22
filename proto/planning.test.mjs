import test from 'node:test'
import assert from 'node:assert/strict'
import { planIssues, versionProgram, needsPlanCritic, needsScout, scoutKey, skillsForStory, canCombineProof, RISK_WORDS } from './planning.mjs'
import { planningSamples } from './planning-eval.mjs'

const story = (id, extra = {}) => ({ id, request: 'Entregar o comportamento pedido', acceptance: ['O resultado é verificável'], scope_paths: ['src/a.js'], depends_on: [], ...extra })

test('long_cohesive_story_is_not_split_by_words_or_criteria', () => {
  assert.deepEqual(planIssues({ stories: [story('s1', { request: 'detalhe '.repeat(250), acceptance: Array.from({ length: 9 }, (_, i) => `Resultado ${i}`) })] }), [])
})

test('multiple_stories_require_a_reason_and_valid_dependencies', () => {
  assert.ok(planIssues({ stories: [story('s1'), story('s2')] }).some(x => x.includes('split_reason')))
  assert.deepEqual(planIssues({ stories: [story('s1', { split_reason: 'Base verificável antes da integração' }), story('s2', { split_reason: 'Integração depende da base', depends_on: ['s1'] })] }), [])
  assert.ok(planIssues({ stories: [story('s1', { depends_on: ['missing'] })] }).length)
})

test('missing_acceptance_or_scope_is_still_rejected', () => {
  assert.ok(planIssues({ stories: [story('s1', { acceptance: [], scope_paths: [] })] }).length >= 2)
})

test('approved_versions_become_one_epic_each_without_replanning', () => {
  const brief = { versions: [{ name: 'v0.2', goal: 'Durabilidade', includes: ['Retomar sem duplicação'] }, { name: 'v0.3', goal: 'Revisão', includes: ['Revisar alterações'] }] }
  assert.equal(versionProgram(brief, 0).epics.length, 1)
  assert.match(versionProgram(brief, 1).epics[0].goal, /Revisar alterações/)
  assert.doesNotMatch(versionProgram(brief, 0).epics[0].goal, /Revisar alterações/)
  assert.equal(versionProgram(brief, 2), null)
})

test('plan_critique_is_reserved_for_risky_work', () => {
  assert.equal(needsPlanCritic({ complexity: 'feature', difficulty: 'normal', domains: ['backend'] }), false)
  assert.equal(needsPlanCritic({ difficulty: 'hard' }), true)
  assert.equal(needsPlanCritic({ domains: ['security'] }), true)
})

test('backend_story_does_not_inherit_future_frontend_skills', () => {
  const skills = [{ id: 'backend-patterns' }, { id: 'design-taste-frontend' }, { id: 'impeccable' }]
  assert.deepEqual(skillsForStory(skills, story('s1')), [skills[0]])
  assert.equal(skillsForStory(skills, story('s1', { scope_paths: ['ui/App.jsx'] })).length, 3)
  assert.equal(skillsForStory(skills, story('s1'), ['impeccable']).length, 2)
})

test('fast_lane_combines_proof_without_a_preselected_test_file', () => {
  assert.equal(canCombineProof({}, { named: true }, {}), true)
  assert.equal(canCombineProof({}, { named: false }, {}), false)
  assert.equal(canCombineProof({}, { named: true }, { red_retry: true }), false)
  assert.equal(canCombineProof({ prova_com_codigo: false }, { named: true }, {}), false)
})

test('real_planner_prompt_and_schema_allow_variable_story_counts', async () => {
  const { samples, schema } = await planningSamples()
  assert.equal(samples.length, 3)
  assert.equal(schema.properties.stories.maxItems, undefined)
  for (const sample of samples) {
    assert.match(sample.prompt, /PLANEJAMENTO PROPORCIONAL/)
    assert.doesNotMatch(sample.prompt, /decide mal|no máximo 160 palavras|até ~400 linhas|primeira fatia coerente/)
  }
})

test('needsScout: épico 1 da versão 1 fica com o scout da missão', () => {
  assert.equal(needsScout({ summary: 'da missão' }, 'e1', 0, 0), false)
})

test('needsScout: épico 1 de uma versão seguinte renova o scout, apesar do id repetido', () => {
  assert.equal(needsScout({ summary: 'da v0.2', epic: scoutKey('e1', 0) }, 'e1', 0, 1), true)
})

test('needsScout: mesmo épico da mesma versão não repete', () => {
  assert.equal(needsScout({ epic: scoutKey('e2', 1) }, 'e2', 1, 1), false)
})

test('needsScout: épico seguinte dentro do mesmo programa renova', () => {
  assert.equal(needsScout({ epic: scoutKey('e1', 0) }, 'e2', 1, 0), true)
})

test('RISK_WORDS: pedido curto em superfície sensível sai da faixa rápida', () => {
  assert.equal(RISK_WORDS.test('remova a autenticação da rota de pagamento'), true)
  assert.equal(RISK_WORDS.test('troque a senha padrão do admin'), true)
  assert.equal(RISK_WORDS.test('aumente a fonte do título'), false)
  assert.equal(RISK_WORDS.test('mude a cor do botão de login'), true) // na dúvida, plano completo
})
