import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { validate, validateSupported } from '../src/schema/index.ts'
import { parseClaudeOutput, parseUnitResult } from '../src/adapters/claude/parse.ts'

const SCHEMA_NAMES = [
  'journal-event',
  'ade-config',
  'plan',
  'task-contract',
  'eval',
  'unit-result',
  'review-result',
  'capability-set',
  'visual-eval',
] as const

function loadFixture(schemaName: string, kind: 'valid' | 'invalid'): Record<string, any> {
  if (schemaName === 'plan' && kind === 'valid') {
    return {
      format_version: 2,
      id: 'plan-1',
      mission_id: 'mission-1',
      immutable_digest: '0123456789abcdef',
      authorization: {
        autonomy: 'safe',
        permitted_effects: ['push', 'open_pr'],
        eligible_skills: [],
      },
      phases: [
        {
          epics: [
            {
              stories: ['ADE-S1'],
            },
          ],
        },
      ],
      mission_budget: {
        max_usd: 20,
      },
      budget: {
        max_model_calls: 6,
        max_rework_rounds: 2,
      },
    }
  }

  if (schemaName === 'plan' && kind === 'invalid') {
    return {
      ...loadFixture('plan', 'valid'),
      __unexpected__: true,
    }
  }

  if (schemaName === 'task-contract' && kind === 'valid') {
    return {
      format_version: 2,
      id: 'ADE-S1',
      title: 'Fundação',
      complexity: 'bounded',
      task: 'Publicar os oito contratos e o carregador ajv.',
      workspace: {
        kind: 'git',
        root: '.',
      },
      risk: {
        level: 'normal',
        surfaces: [],
        evidence: [],
      },
      guardrails: {
        scope_paths: ['schemas/**', 'src/schema/**'],
        do_not_touch: ['.ade/**'],
        autonomy: 'safe',
      },
      requirements: [
        {
          id: 'R1',
          ears: 'WHEN um exemplo inválido é validado THE SYSTEM SHALL recusar apontando o caminho do campo.',
        },
      ],
      scenarios: [
        Object.assign(
          {
            id: 'C1',
            given: 'uma fixture inválida',
            when: 'ajv valida',
            verifiers: ['V1'],
          },
          JSON.parse('{"then":"recusa com o caminho do erro"}'),
        ),
      ],
      verifiers: [
        {
          id: 'V1',
          kind: 'script',
          cmd: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json', 'tests/schema.test.ts'],
          expect_exit: 0,
          timeout_s: 120,
          max_output_bytes: 65536,
          evidence: ['tests/schema.test.ts'],
          strictness: {
            mode: 'must_fail_before',
          },
          author: 'operator',
        },
      ],
      skills: [],
      roles: {
        maker: {
          family: 'claude',
          model_id: 'claude-sonnet-5',
        },
        checker_round: {
          family: 'codex',
          model_id: 'codex-1',
        },
      },
      budget: {
        max_model_calls: 6,
        max_rework_rounds: 2,
      },
      research_refs: [],
    }
  }

  if (schemaName === 'task-contract' && kind === 'invalid') {
    return {
      ...loadFixture('task-contract', 'valid'),
      __unexpected__: true,
    }
  }

  if (schemaName === 'artifact' && kind === 'valid') {
    return {
      ref: 'repo-ir-0123456789abcdef',
      kind: 'repo_ir',
      digest: 'abcdef0123456789',
      producer: 'repo-discovery',
      producer_version: '0.3.0',
      input_digest: '0123456789abcdef',
      created_at: '2026-09-20T14:00:00Z',
      provenance: ['commit:01dc2ec'],
      confidence: 0.95,
    }
  }

  if (schemaName === 'artifact' && kind === 'invalid') {
    return {
      ...loadFixture('artifact', 'valid'),
      __unexpected__: true,
    }
  }

  if (schemaName === 'visual-eval' && kind === 'valid') {
    return {
      story_id: 'ADE-S1',
      round: 1,
      rubric_version: '2026-09-17-v1',
      judge: {
        family: 'codex',
        model_id: 'gpt-5.6-terra',
      },
      detector: {
        engine_version: '0.1.5',
        url_mode: 'ok',
      },
      surface_mode: 'persuade',
      captures: [
        {
          route: '/',
          width: 1280,
          theme: 'light',
          path: 'artifacts/visual/root.png',
          sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      ],
      criteria: [
        { id: 'specificity', score: 8.5, weight: 3.0, note: 'específico' },
        { id: 'hierarchy', score: 8.0, weight: 2.0, note: 'hierarquia' },
        { id: 'typography', score: 8.5, weight: 2.0, note: 'tipografia' },
        { id: 'color', score: 8.0, weight: 1.5, note: 'cor' },
        { id: 'states', score: 8.0, weight: 1.0, note: 'estados' },
        { id: 'motion', score: 7.5, weight: 0.5, note: 'movimento' },
      ],
      final: 8.2,
      defects: [],
      verdict: 'pass',
    }
  }

  if (schemaName === 'visual-eval' && kind === 'invalid') {
    return {
      ...loadFixture('visual-eval', 'valid'),
      __unexpected__: true,
    }
  }


  const raw = readFileSync(
    new URL(`../fixtures/schemas/${schemaName}/${kind}.json`, import.meta.url),
    'utf8',
  )
  return JSON.parse(raw)
}

const LEGACY_V1_UNIT_RESULT = {
  format_version: 1,
  story_id: 'ADE-S1',
  state: 'done',
  phase: 'green',
  round: 1,
  tree_before: '0123456789abcdef',
  tree_after: 'fedcba9876543210',
  eval_records: [
    {
      id: 'E1',
      phase: 'red',
      passed: false,
      red_reason: 'assertion_failed',
    },
  ],
  gate_records: [],
  passes: true,
  reason: 'eval verde após implementação',
  sources: ['0123456789abcdef'],
}

const LEGACY_V1_INVALID_UNIT_RESULT = {
  ...LEGACY_V1_UNIT_RESULT,
  __unexpected__: true,
}

const LEGACY_V1_REVIEW_RESULT = {
  format_version: 1,
  verdict: 'approved',
  action_items: [
    {
      severity: 'minor',
      category: 'style',
      target_role: 'maker',
      location: 'src/journal/canonical.ts:10',
      problem: 'nome poderia ser mais claro',
      evidence: 'trecho do diff',
      required_action: 'renomear variável',
    },
  ],
  deferred: [],
  rejected: [],
  sources: ['0123456789abcdef'],
  summary: 'aprovado com uma observação menor',
}

const LEGACY_V1_INVALID_REVIEW_RESULT = {
  ...LEGACY_V1_REVIEW_RESULT,
  __unexpected__: true,
}

// AC2: cada um dos oito contratos aceita um exemplo válido e recusa um exemplo
// inválido apontando o caminho do campo com erro; configuração com campo
// desconhecido é recusada com código 4, nunca ignorada em silêncio.
describe('published schemas', () => {
  test('published_schemas_accept_valid_and_refuse_invalid_fixtures', () => {
    expect(SCHEMA_NAMES.length).toBe(9)

    for (const schemaName of SCHEMA_NAMES) {
      const validDoc = loadFixture(schemaName, 'valid')
      const validResult = validate(schemaName, validDoc)
      expect(validResult.valid, `${schemaName} valid fixture should be accepted`).toBe(true)

      const invalidDoc = loadFixture(schemaName, 'invalid')
      const invalidResult = validate(schemaName, invalidDoc)
      expect(invalidResult.valid, `${schemaName} invalid fixture should be refused`).toBe(false)
      if (invalidResult.valid) continue

      expect(invalidResult.errors.length).toBeGreaterThan(0)
      const pointsAtUnexpectedField = invalidResult.errors.some((error) =>
        error.path.includes('__unexpected__'),
      )
      expect(
        pointsAtUnexpectedField,
        `${schemaName} error should point at the unknown field's path`,
      ).toBe(true)

      // configuração com campo desconhecido nunca é ignorada em silêncio: sai com código 4
      if (schemaName === 'ade-config') {
        expect(invalidResult.code).toBe(4)
      }
    }
  })

  test('CA1: validateSupported accepts format_version 1 as valid, legacy (current: false)', () => {
    const unitResult = validateSupported('unit-result', LEGACY_V1_UNIT_RESULT)
    expect(unitResult.valid).toBe(true)
    expect(unitResult.errors).toEqual([])
    expect(unitResult.formatVersion).toBe(1)
    expect(unitResult.current).toBe(false)

    const reviewResult = validateSupported('review-result', LEGACY_V1_REVIEW_RESULT)
    expect(reviewResult.valid).toBe(true)
    expect(reviewResult.errors).toEqual([])
    expect(reviewResult.formatVersion).toBe(1)
    expect(reviewResult.current).toBe(false)
  })

  test('CA2: validateSupported refuses format_version 3 with code 4 and unsupported_result_format on /format_version', () => {
    const docWithV3 = { format_version: 3 }
    const reviewRes = validateSupported('review-result', docWithV3)
    expect(reviewRes.valid).toBe(false)
    expect(reviewRes.current).toBe(false)
    expect(reviewRes.formatVersion).toBe(3)
    if (reviewRes.valid) return
    expect(reviewRes.code).toBe(4)
    expect(reviewRes.errors.length).toBeGreaterThan(0)
    const reviewErr = reviewRes.errors.find((e) => e.path === '/format_version')
    expect(reviewErr).toBeDefined()
    expect(
      reviewErr?.code === 'unsupported_result_format' ||
        reviewErr?.message?.includes('unsupported_result_format'),
    ).toBe(true)

    const unitRes = validateSupported('unit-result', docWithV3)
    expect(unitRes.valid).toBe(false)
    expect(unitRes.formatVersion).toBe(3)
    expect(unitRes.current).toBe(false)
    if (unitRes.valid) return
    expect(unitRes.code).toBe(4)
    const unitErr = unitRes.errors.find((e) => e.path === '/format_version')
    expect(unitErr).toBeDefined()
    expect(
      unitErr?.code === 'unsupported_result_format' ||
        unitErr?.message?.includes('unsupported_result_format'),
    ).toBe(true)
  })

  test('CA3: validate preserves acceptance of valid fixtures for the other seven official schemas', () => {
    const otherSchemas = SCHEMA_NAMES.filter(
      (name) => name !== 'unit-result' && name !== 'review-result',
    )
    expect(otherSchemas.length).toBe(7)

    for (const schemaName of otherSchemas) {
      const validDoc = loadFixture(schemaName, 'valid')
      const result = validate(schemaName, validDoc)
      expect(result.valid, `${schemaName} valid fixture should continue to be accepted`).toBe(true)
      expect(result.errors).toEqual([])
    }
  })

  test('CA4: validateSupported refuses legacy document with __unexpected__ field pointing to /__unexpected__ and code 4', () => {
    const invalidUnitResult = LEGACY_V1_INVALID_UNIT_RESULT
    const unitRes = validateSupported('unit-result', invalidUnitResult)
    expect(unitRes.valid).toBe(false)
    expect(unitRes.current).toBe(false)
    expect(unitRes.formatVersion).toBe(1)
    if (unitRes.valid) return
    expect(unitRes.code).toBe(4)
    expect(unitRes.errors.length).toBeGreaterThan(0)
    const unitUnexpected = unitRes.errors.find((e) => e.path === '/__unexpected__')
    expect(unitUnexpected).toBeDefined()

    const invalidReviewResult = LEGACY_V1_INVALID_REVIEW_RESULT
    const reviewRes = validateSupported('review-result', invalidReviewResult)
    expect(reviewRes.valid).toBe(false)
    expect(reviewRes.current).toBe(false)
    expect(reviewRes.formatVersion).toBe(1)
    if (reviewRes.valid) return
    expect(reviewRes.code).toBe(4)
    expect(reviewRes.errors.length).toBeGreaterThan(0)
    const reviewUnexpected = reviewRes.errors.find((e) => e.path === '/__unexpected__')
    expect(reviewUnexpected).toBeDefined()
  })

})

describe('unit-result v2 contract evolution', () => {
  function readTranscriptStdout(name: string): string {
    return readFileSync(
      new URL(`../fixtures/transcripts/claude/${name}/stdout.json`, import.meta.url),
      'utf8',
    )
  }

  test('CA1: current fixture and valid Claude transcript return format_version 2, ready_for_verification, verify, cited: true, and no approval property', () => {
    const fixture = loadFixture('unit-result', 'valid') as Record<string, unknown>
    const fixtureVal = validate('unit-result', fixture)
    expect(fixtureVal.valid, `valid fixture should be valid: ${JSON.stringify(fixtureVal.errors)}`).toBe(true)
    expect(fixture.format_version).toBe(2)
    expect(fixture.state).toBe('ready_for_verification')
    expect(fixture.requested_action).toBe('verify')
    expect(fixture).not.toHaveProperty('passes')
    expect(fixture).not.toHaveProperty('approved')
    expect(fixture).not.toHaveProperty('reason')

    const transcriptStdout = readTranscriptStdout('ok_with_structured_output')
    const parsedClaude = parseClaudeOutput(transcriptStdout)
    expect(parsedClaude.error).toBeNull()
    const parsedResult = parseUnitResult(parsedClaude.envelope)
    expect(parsedResult.valid).toBe(true)
    expect(parsedResult.cited).toBe(true)
    const unitResult = parsedResult.unit_result as Record<string, unknown>
    expect(unitResult.format_version).toBe(2)
    expect(unitResult.state).toBe('ready_for_verification')
    expect(unitResult.requested_action).toBe('verify')
    expect(unitResult).not.toHaveProperty('passes')
    expect(unitResult).not.toHaveProperty('approved')
    expect(unitResult).not.toHaveProperty('reason')

    const withReason = { ...fixture, reason: 'narrativa legada não permitida na v2' }
    const resReason = validate('unit-result', withReason)
    expect(resReason.valid).toBe(false)
  })

  test('CA2: valid unit-result v1 is read with current: false by validateSupported and rejected by validate as current contract', () => {
    const v1Doc = {
      format_version: 1,
      story_id: 'ADE-S1',
      state: 'done',
      phase: 'green',
      round: 1,
      tree_before: '0123456789abcdef',
      tree_after: 'fedcba9876543210',
      eval_records: [
        {
          id: 'E1',
          phase: 'red',
          passed: false,
          red_reason: 'assertion_failed',
        },
      ],
      gate_records: [],
      passes: true,
      reason: 'eval verde após implementação',
      sources: ['0123456789abcdef'],
    }

    const supportedRes = validateSupported('unit-result', v1Doc)
    expect(supportedRes.valid).toBe(true)
    expect(supportedRes.formatVersion).toBe(1)
    expect(supportedRes.current).toBe(false)
    expect(supportedRes.errors).toEqual([])

    const currentRes = validate('unit-result', v1Doc)
    expect(currentRes.valid).toBe(false)
    if (currentRes.valid) return
    expect(currentRes.code).toBe(4)
    expect(currentRes.errors.length).toBeGreaterThan(0)
  })

  test('CA3: current fixture with requested_action approve is rejected pointing to /requested_action', () => {
    const fixture = loadFixture('unit-result', 'valid') as Record<string, unknown>
    const mutated = { ...fixture, requested_action: 'approve' }
    const result = validate('unit-result', mutated)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.errors.some((e) => e.path === '/requested_action')).toBe(true)
  })

  test('CA4: claim without evidence_refs or response without contract_revision is rejected pointing to missing field', () => {
    const fixture = loadFixture('unit-result', 'valid') as Record<string, any>

    // 1. Sem contract_revision
    const withoutContractRevision = { ...fixture }
    delete withoutContractRevision.contract_revision
    const resNoContract = validate('unit-result', withoutContractRevision)
    expect(resNoContract.valid).toBe(false)
    if (!resNoContract.valid) {
      expect(
        resNoContract.errors.some(
          (e) => e.path.includes('contract_revision') || e.message.includes('contract_revision'),
        ),
      ).toBe(true)
    }

    // 2. Claim sem evidence_refs
    const withoutEvidenceRefs = JSON.parse(JSON.stringify(fixture))
    if (withoutEvidenceRefs.handoff?.claims?.[0]) {
      delete withoutEvidenceRefs.handoff.claims[0].evidence_refs
    }
    const resNoEvidence = validate('unit-result', withoutEvidenceRefs)
    expect(resNoEvidence.valid).toBe(false)
    if (!resNoEvidence.valid) {
      expect(
        resNoEvidence.errors.some(
          (e) => e.path.includes('evidence_refs') || e.message.includes('evidence_refs'),
        ),
      ).toBe(true)
    }
  })
})

describe('review-result v2 contract evolution', () => {
  function loadReviewFixture(kind: string): unknown {
    const filePath = new URL(`../fixtures/schemas/review-result/${kind}.json`, import.meta.url)
    if (!existsSync(filePath)) {
      return null
    }
    const raw = readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  }

  test('CA1: current fixture returns valid:true for format_version 2, verdict approved and typed references', () => {
    const fixture = (loadReviewFixture('valid') || loadFixture('review-result', 'valid')) as Record<string, unknown>
    const res = validate('review-result', fixture)
    expect(res.valid, `valid fixture should be accepted: ${JSON.stringify(res.errors)}`).toBe(true)
    expect(fixture.format_version).toBe(2)
    expect(fixture.verdict).toBe('approved')
    expect(fixture).toHaveProperty('contract_revision')
    expect(fixture).toHaveProperty('input_revision')
    expect(fixture).toHaveProperty('requested_action')
    expect(fixture).toHaveProperty('evidence')
    expect(fixture).toHaveProperty('sources')
    expect(fixture).toHaveProperty('handoff')

    const supportedRes = validateSupported('review-result', fixture)
    expect(supportedRes.valid).toBe(true)
    expect(supportedRes.formatVersion).toBe(2)
    expect(supportedRes.current).toBe(true)
  })

  test('CA2: requested_action approve or evidence_refs with prose returns valid:false pointing to out-of-vocabulary value', () => {
    const fixture = (loadReviewFixture('valid') || loadFixture('review-result', 'valid')) as Record<string, any>

    // 1. requested_action: 'approve' (fora do enum verify|rework|decide)
    const withInvalidAction = { ...fixture, requested_action: 'approve' }
    const actionRes = validate('review-result', withInvalidAction)
    expect(actionRes.valid).toBe(false)
    if (!actionRes.valid) {
      expect(actionRes.errors.some((e) => e.path === '/requested_action')).toBe(true)
    }

    // 2. evidence_refs: ['trecho do diff'] (prosa em vez de referência tipada)
    const withProseEvidence = JSON.parse(JSON.stringify(fixture))
    if (withProseEvidence.action_items?.[0]) {
      withProseEvidence.action_items[0].evidence_refs = ['trecho do diff']
    }
    const proseRes = validate('review-result', withProseEvidence)
    expect(proseRes.valid).toBe(false)
    if (!proseRes.valid) {
      expect(proseRes.errors.some((e) => e.path === '/action_items/0/evidence_refs/0')).toBe(true)
    }

    // Fixture isolada invalid-action.json
    const invalidActionDoc = loadReviewFixture('invalid-action')
    if (invalidActionDoc) {
      const invalidActionRes = validate('review-result', invalidActionDoc)
      expect(invalidActionRes.valid).toBe(false)
      if (!invalidActionRes.valid) {
        expect(invalidActionRes.errors.some((e) => e.path === '/requested_action')).toBe(true)
      }
    }
  })

  test('CA3: claim without evidence_refs returns valid:false at /handoff/claims/0/evidence_refs', () => {
    const fixture = (loadReviewFixture('valid') || loadFixture('review-result', 'valid')) as Record<string, any>
    const claimNoEvidence = JSON.parse(JSON.stringify(fixture))
    if (claimNoEvidence.handoff?.claims?.[0]) {
      claimNoEvidence.handoff.claims[0].evidence_refs = []
    }
    const res = validate('review-result', claimNoEvidence)
    expect(res.valid).toBe(false)
    if (!res.valid) {
      expect(res.errors.some((e) => e.path === '/handoff/claims/0/evidence_refs')).toBe(true)
    }

    // Fixture isolada invalid-claim.json
    const invalidClaimDoc = loadReviewFixture('invalid-claim')
    if (invalidClaimDoc) {
      const invalidClaimRes = validate('review-result', invalidClaimDoc)
      expect(invalidClaimRes.valid).toBe(false)
      if (!invalidClaimRes.valid) {
        expect(invalidClaimRes.errors.some((e) => e.path === '/handoff/claims/0/evidence_refs')).toBe(true)
      }
    }
  })

  test('CA4: problem 221 chars, summary 401 chars, notes 501 ASCII chars or missing contract_revision are refused at corresponding field', () => {
    const fixture = (loadReviewFixture('valid') || loadFixture('review-result', 'valid')) as Record<string, any>

    // 1. problem com 221 caracteres
    const docProblem221 = JSON.parse(JSON.stringify(fixture))
    if (docProblem221.action_items?.[0]) {
      docProblem221.action_items[0].problem = 'p'.repeat(221)
    }
    const resProblem = validate('review-result', docProblem221)
    expect(resProblem.valid).toBe(false)
    if (!resProblem.valid) {
      expect(resProblem.errors.some((e) => e.path === '/action_items/0/problem')).toBe(true)
    }

    // 2. summary com 401 caracteres
    const docSummary401 = { ...fixture, summary: 's'.repeat(401) }
    const resSummary = validate('review-result', docSummary401)
    expect(resSummary.valid).toBe(false)
    if (!resSummary.valid) {
      expect(resSummary.errors.some((e) => e.path === '/summary')).toBe(true)
    }

    // 3. notes com 501 caracteres ASCII
    const docNotes501 = JSON.parse(JSON.stringify(fixture))
    if (docNotes501.handoff) {
      docNotes501.handoff.notes = 'n'.repeat(501)
    }
    const resNotes = validate('review-result', docNotes501)
    expect(resNotes.valid).toBe(false)
    if (!resNotes.valid) {
      expect(resNotes.errors.some((e) => e.path === '/handoff/notes')).toBe(true)
    }

    // 4. ausência de contract_revision
    const docNoContract = { ...fixture }
    delete docNoContract.contract_revision
    const resNoContract = validate('review-result', docNoContract)
    expect(resNoContract.valid).toBe(false)
    if (!resNoContract.valid) {
      expect(
        resNoContract.errors.some(
          (e) => e.path.includes('contract_revision') || e.message.includes('contract_revision'),
        ),
      ).toBe(true)
    }

    // Fixture isolada invalid-limits.json
    const invalidLimitsDoc = loadReviewFixture('invalid-limits')
    if (invalidLimitsDoc) {
      const invalidLimitsRes = validate('review-result', invalidLimitsDoc)
      expect(invalidLimitsRes.valid).toBe(false)
      if (!invalidLimitsRes.valid) {
        expect(
          invalidLimitsRes.errors.some(
            (e) =>
              e.path === '/summary' ||
              e.path === '/action_items/0/problem' ||
              e.path === '/handoff/notes',
          ),
        ).toBe(true)
      }
    }
  })

  test('review-result v1 legacy format is read with current: false by validateSupported and rejected by validate as current contract', () => {
    const v1Doc = LEGACY_V1_REVIEW_RESULT
    const supportedRes = validateSupported('review-result', v1Doc)
    expect(supportedRes.valid).toBe(true)
    expect(supportedRes.formatVersion).toBe(1)
    expect(supportedRes.current).toBe(false)
    expect(supportedRes.errors).toEqual([])

    const currentRes = validate('review-result', v1Doc)
    expect(currentRes.valid).toBe(false)
    if (!currentRes.valid) {
      expect(currentRes.code).toBe(4)
    }
  })

  test('task-contract accepts optional depends_on array of strings and rejects non-string items', () => {
    const validDoc = loadFixture('task-contract', 'valid')
    const withDeps = { ...validDoc, depends_on: ['ADE-S0', 'ADE-S1'] }
    const res = validate('task-contract', withDeps)
    expect(res.valid).toBe(true)

    const withInvalidDeps = { ...validDoc, depends_on: [123] }
    const resInvalid = validate('task-contract', withInvalidDeps)
    expect(resInvalid.valid).toBe(false)
    expect(resInvalid.errors.some((e) => e.path.includes('depends_on'))).toBe(true)
  })
})

