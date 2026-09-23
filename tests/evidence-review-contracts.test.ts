import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const SPEC_URL = new URL('../docs/specs/evidence-review-contracts.md', import.meta.url)

export const REQUIRED_ERROR_CODES = [
  'unsupported_result_format',
  'stale_contract_revision',
  'stale_input_revision',
  'unverified_reference',
  'claim_without_evidence',
  'next_action_mismatch',
  'notes_too_large',
  'legacy_result_not_approvable',
] as const

export const REQUIRED_SECTIONS = [
  'Entradas',
  'Saídas',
  'Erros',
  'Compatibilidade',
] as const

export const FUTURE_RESERVATIONS = [
  'plan.schema.json',
  'task-contract.schema.json',
  'ade-config.schema.json',
  'capability-set.schema.json',
] as const

export function validateSpecSections(doc: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!doc.includes('unit-result')) errors.push('unit-result ausente')
  if (!doc.includes('review-result')) errors.push('review-result ausente')

  for (const section of REQUIRED_SECTIONS) {
    if (!doc.includes(section)) {
      errors.push(`Seção ${section} ausente`)
    }
  }

  for (const code of REQUIRED_ERROR_CODES) {
    if (!doc.includes(code)) {
      errors.push(`Código de erro ausente: ${code}`)
    }
  }

  if (!doc.includes('código 4') && !doc.includes('code: 4') && !doc.includes('"code": 4')) {
    errors.push('Menção ao código 4 ausente')
  }

  if (!doc.includes('format_version') || !doc.includes('contract_revision') || !doc.includes('input_revision')) {
    errors.push('Campos de revisão ausentes')
  }

  return { valid: errors.length === 0, errors }
}

export function validateStateDistinction(doc: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  const hasNoApprove = doc.includes('ready_for_verification não aprova')
  const hasRequiresReview = doc.includes('approved exige revisão corrente')

  if (!hasNoApprove) {
    errors.push('Declaração obrigatória "ready_for_verification não aprova" ausente')
  }
  if (!hasRequiresReview) {
    errors.push('Declaração obrigatória "approved exige revisão corrente" ausente')
  }
  if (!doc.includes('ready_for_verification') || !doc.includes('approved')) {
    errors.push('Estados obrigatórios ausentes')
  }

  return { valid: errors.length === 0, errors }
}

export function validateFutureReservations(doc: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  for (const schema of FUTURE_RESERVATIONS) {
    if (!doc.includes(schema)) {
      errors.push(`Reserva futura para ${schema} ausente`)
    }
  }
  return { valid: errors.length === 0, errors }
}

export function validateReviewConstants(constants: {
  RESULT_FORMAT_VERSION?: unknown
  REQUESTED_ACTIONS?: readonly unknown[]
  REFERENCE_PREFIXES?: readonly unknown[]
}): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (constants.RESULT_FORMAT_VERSION !== 2) {
    errors.push(`RESULT_FORMAT_VERSION esperado: 2, obtido: ${constants.RESULT_FORMAT_VERSION}`)
  }

  const expectedActions = ['verify', 'rework', 'decide']
  if (
    !Array.isArray(constants.REQUESTED_ACTIONS) ||
    constants.REQUESTED_ACTIONS.length !== expectedActions.length ||
    !expectedActions.every((a, i) => constants.REQUESTED_ACTIONS![i] === a)
  ) {
    errors.push(`REQUESTED_ACTIONS inválido: ${JSON.stringify(constants.REQUESTED_ACTIONS)}`)
  } else if (!Object.isFrozen(constants.REQUESTED_ACTIONS)) {
    errors.push('REQUESTED_ACTIONS deve ser congelado')
  }

  const expectedPrefixes = ['eval:', 'gate:', 'artifact:', 'source:', 'file:', 'trace:']
  if (
    !Array.isArray(constants.REFERENCE_PREFIXES) ||
    constants.REFERENCE_PREFIXES.length !== expectedPrefixes.length ||
    !expectedPrefixes.every((p, i) => constants.REFERENCE_PREFIXES![i] === p)
  ) {
    errors.push(`REFERENCE_PREFIXES inválido: ${JSON.stringify(constants.REFERENCE_PREFIXES)}`)
  } else if (!Object.isFrozen(constants.REFERENCE_PREFIXES)) {
    errors.push('REFERENCE_PREFIXES deve ser congelado')
  }

  return { valid: errors.length === 0, errors }
}

describe('evidence-review-contracts', () => {
  test('CA1: unit-result e review-result possuem entradas, saídas, erros e regra de compatibilidade explicitamente descritos', () => {
    const doc = readFileSync(SPEC_URL, 'utf8')
    const check = validateSpecSections(doc)
    expect(check.valid, `Especificação incompleta: ${check.errors.join(', ')}`).toBe(true)

    // Mutações negativas: remover cada seção obrigatória deve falhar
    for (const section of REQUIRED_SECTIONS) {
      const mutatedDoc = doc.replaceAll(section, 'SECAO_REMOVIDA')
      const mutatedCheck = validateSpecSections(mutatedDoc)
      expect(mutatedCheck.valid).toBe(false)
      expect(mutatedCheck.errors.some((e) => e.includes(section))).toBe(true)
    }

    // Mutações negativas: remover cada código de erro obrigatório deve falhar
    for (const code of REQUIRED_ERROR_CODES) {
      const mutatedDoc = doc.replaceAll(code, 'CODIGO_REMOVIDO')
      const mutatedCheck = validateSpecSections(mutatedDoc)
      expect(mutatedCheck.valid).toBe(false)
      expect(mutatedCheck.errors.some((e) => e.includes(code))).toBe(true)
    }

    // Mutação negativa: remover menção ao código 4 deve falhar
    const mutatedWithoutCode4 = doc.replaceAll('código 4', '').replaceAll('code: 4', '')
    expect(validateSpecSections(mutatedWithoutCode4).valid).toBe(false)
  })

  test('CA2: ready_for_verification pertence somente ao executor e approved somente à revisão corrente validada', () => {
    const doc = readFileSync(SPEC_URL, 'utf8')
    const check = validateStateDistinction(doc)
    expect(check.valid, `Distinção de estados falhou: ${check.errors.join(', ')}`).toBe(true)

    expect(doc).toContain('ready_for_verification não aprova')
    expect(doc).toContain('approved exige revisão corrente')

    // Mutação negativa: confundir estados permitindo que ready_for_verification aprove
    const mutatedConfused = doc.replaceAll('ready_for_verification não aprova', 'ready_for_verification aprova')
    expect(validateStateDistinction(mutatedConfused).valid).toBe(false)

    // Mutação negativa: remover exigência de revisão corrente para approved
    const mutatedMissingReview = doc.replaceAll('approved exige revisão corrente', 'approved sem revisao')
    expect(validateStateDistinction(mutatedMissingReview).valid).toBe(false)
  })

  test('CA3: plan, task-contract, ade-config e capability-set aparecem em quatro reservas separadas e nenhum formato é alterado', () => {
    const doc = readFileSync(SPEC_URL, 'utf8')
    const res = validateFutureReservations(doc)
    expect(res.valid, `Reservas ausentes: ${res.errors.join(', ')}`).toBe(true)

    // Verificar que os 4 schemas no disco continuam intactos com format_version: 1 e sem alterações
    for (const schemaName of FUTURE_RESERVATIONS) {
      const schemaRaw = readFileSync(new URL(`../schemas/${schemaName}`, import.meta.url), 'utf8')
      const schemaJson = JSON.parse(schemaRaw)
      expect(schemaJson.format_version ?? 1, `${schemaName} não deve ser alterado`).toBe(1)
    }

    // Mutações negativas: remoção de cada reserva exclusiva deve falhar
    for (const schemaName of FUTURE_RESERVATIONS) {
      const mutatedDoc = doc.replaceAll(schemaName, 'REMOVED_RESERVATION')
      const mutatedRes = validateFutureReservations(mutatedDoc)
      expect(mutatedRes.valid).toBe(false)
      expect(mutatedRes.errors.some((e) => e.includes(schemaName))).toBe(true)
    }
  })

  test('CA4: módulo inicial de revisão expõe RESULT_FORMAT_VERSION igual a 2, REQUESTED_ACTIONS congelado e seis prefixos tipados', async () => {
    const mod = await import('../src/review/validate.ts')
    const { RESULT_FORMAT_VERSION, REQUESTED_ACTIONS, REFERENCE_PREFIXES } = mod

    expect(RESULT_FORMAT_VERSION).toBe(2)
    expect(REQUESTED_ACTIONS).toEqual(['verify', 'rework', 'decide'])
    expect(Object.isFrozen(REQUESTED_ACTIONS)).toBe(true)
    expect(REFERENCE_PREFIXES).toEqual(['eval:', 'gate:', 'artifact:', 'source:', 'file:', 'trace:'])
    expect(Object.isFrozen(REFERENCE_PREFIXES)).toBe(true)

    const check = validateReviewConstants({ RESULT_FORMAT_VERSION, REQUESTED_ACTIONS, REFERENCE_PREFIXES })
    expect(check.valid, `Validação de constantes falhou: ${check.errors.join(', ')}`).toBe(true)

    // Mutação negativa: REQUESTED_ACTIONS=['verify','approve']
    const invalidActionsCheck = validateReviewConstants({
      RESULT_FORMAT_VERSION,
      REQUESTED_ACTIONS: Object.freeze(['verify', 'approve'] as unknown as typeof REQUESTED_ACTIONS),
      REFERENCE_PREFIXES,
    })
    expect(invalidActionsCheck.valid).toBe(false)

    // Mutação negativa: constante não congelada
    const unfrozenCheck = validateReviewConstants({
      RESULT_FORMAT_VERSION,
      REQUESTED_ACTIONS: ['verify', 'rework', 'decide'],
      REFERENCE_PREFIXES,
    })
    expect(unfrozenCheck.valid).toBe(false)

    // Mutação negativa: RESULT_FORMAT_VERSION incorreto
    const wrongVersionCheck = validateReviewConstants({
      RESULT_FORMAT_VERSION: 1,
      REQUESTED_ACTIONS,
      REFERENCE_PREFIXES,
    })
    expect(wrongVersionCheck.valid).toBe(false)

    // Mutação negativa: prefixos incorretos ou incompletos
    const wrongPrefixesCheck = validateReviewConstants({
      RESULT_FORMAT_VERSION,
      REQUESTED_ACTIONS,
      REFERENCE_PREFIXES: Object.freeze(['eval:', 'gate:'] as unknown as typeof REFERENCE_PREFIXES),
    })
    expect(wrongPrefixesCheck.valid).toBe(false)
  })
})
