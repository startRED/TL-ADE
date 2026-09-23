import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  planMission,
  validateMissionPlan,
  approveMission,
  replanRemaining,
  assertApprovedPlan,
} from '../src/mission/plan-lifecycle.js'
import { main as cliMain } from '../src/cli/index.js'
import { splitContract } from '../src/intent/split.js'
import { validateCompiledPlan } from '../src/intent/validate.js'
import { readJournal, openJournal } from '../src/journal/journal.ts'
import { validate } from '../src/schema/index.ts'
import { digest16 } from '../src/journal/canonical.ts'

describe('Plan Lifecycle and Approval', () => {
  let tmpRepoDir: string

  beforeEach(() => {
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-lifecycle-test-'))
    fs.writeFileSync(
      path.join(tmpRepoDir, 'package.json'),
      JSON.stringify({ name: 'test-project', scripts: { test: 'node --test' } }, null, 2),
    )
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpRepoDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test('criterio_1_pedido_em_portugues_grava_missao_contratos_validados_e_perguntas_sem_despacho', async () => {
    const request = 'Implementar autenticação de usuário e gerenciamento de perfil'

    const planned = await planMission({
      request,
      repoDir: tmpRepoDir,
      nonInteractive: true,
    })

    expect(planned.missionId).toMatch(/^mission-/)
    expect(planned.planPath).toBeDefined()
    expect(fs.existsSync(planned.planPath)).toBe(true)
    expect(planned.state).toBe('planned')
    expect(planned.digest).toMatch(/^[0-9a-f]{16}$/)
    expect(Array.isArray(planned.questions)).toBe(true)
    expect(planned.questions.length).toBeLessThanOrEqual(5)

    // Verifica que o plano foi gravado e é válido
    const planRaw = fs.readFileSync(planned.planPath, 'utf8')
    const planObj = JSON.parse(planRaw)
    const planValidation = validate('plan', planObj)
    expect(planValidation.valid, `Plan validation failed: ${JSON.stringify(planValidation.errors)}`).toBe(true)

    // Verifica os contratos das stories
    const missionDir = path.dirname(planned.planPath)
    const storiesDir = path.join(missionDir, 'stories')
    expect(fs.existsSync(storiesDir)).toBe(true)

    const storyIds = planObj.phases.flatMap((p: any) => p.epics.flatMap((e: any) => e.stories))
    expect(storyIds.length).toBeGreaterThan(0)

    for (const storyId of storyIds) {
      const contractPath = path.join(storiesDir, `${storyId}.json`)
      expect(fs.existsSync(contractPath), `Contract ${storyId} missing`).toBe(true)
      const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
      const contractValidation = validate('task-contract', contract)
      expect(contractValidation.valid, `Contract ${storyId} invalid: ${JSON.stringify(contractValidation.errors)}`).toBe(true)
    }

    // Zero despacho: sem commits de git, sem chamadas de modelo iniciadas
    const journalPath = path.join(missionDir, 'journal.jsonl')
    if (fs.existsSync(journalPath)) {
      const { events } = readJournal(journalPath)
      const hasExecution = events.some(
        (e) => e.kind === 'story_started' || e.kind === 'model_call' || e.kind === 'worker_dispatched',
      )
      expect(hasExecution).toBe(false)
    }

    // Testa também via CLI ade plan
    let cliOutput = ''
    const exitCode = await cliMain(['plan', '--request', 'Criar endpoint de telemetria', '--repo', tmpRepoDir, '--non-interactive'], {
      stdout: (msg: string) => { cliOutput += msg },
      stderr: (msg: string) => { cliOutput += msg },
    })
    expect(exitCode).toBe(0)
    expect(cliOutput).toContain('mission-')
  })

  test('criterio_2_validate_informa_todas_violacoes_sem_alterar_projeto_nem_estado', async () => {
    // 1. Plano válido
    const planned = await planMission({
      request: 'Criar exportador de relatório',
      repoDir: tmpRepoDir,
      nonInteractive: true,
    })

    const validRes = validateMissionPlan(planned.planPath)
    expect(validRes.valid).toBe(true)
    expect(validRes.digest).toBe(planned.digest)
    expect(validRes.errors).toEqual([])

    // Verifica que validateMissionPlan é determinístico e não altera mtime nem arquivos
    const planStatBefore = fs.statSync(planned.planPath)
    const validRes2 = validateMissionPlan(planned.planPath)
    const planStatAfter = fs.statSync(planned.planPath)
    expect(validRes2).toEqual(validRes)
    expect(planStatAfter.mtimeMs).toBe(planStatBefore.mtimeMs)

    // 2. Plano inválido
    const invalidMissionDir = path.join(tmpRepoDir, '.ade', 'missions', 'mission-invalid')
    fs.mkdirSync(path.join(invalidMissionDir, 'stories'), { recursive: true })

    const invalidPlan = {
      format_version: 2,
      id: 'plan-invalid',
      mission_id: 'mission-invalid',
      immutable_digest: '1234567890abcdef',
      phases: [{ epics: [{ stories: ['S1'] }] }],
      // Faltando authorization, mission_budget, budget
    }
    const invalidPlanPath = path.join(invalidMissionDir, 'plan.json')
    fs.writeFileSync(invalidPlanPath, JSON.stringify(invalidPlan, null, 2))

    // Story com verificador inexistente referenciado
    const invalidContract = {
      format_version: 2,
      id: 'S1',
      title: 'Story Inválida',
      complexity: 'trivial',
      task: 'Fazer algo',
      workspace: { kind: 'git', root: '.' },
      risk: { level: 'normal', surfaces: [], evidence: [] },
      guardrails: { scope_paths: ['src/**'], do_not_touch: ['.ade/**'], autonomy: 'safe' },
      requirements: [{ id: 'R1', ears: 'WHEN event happens THE SYSTEM SHALL respond within 1 s' }],
      scenarios: [{ id: 'C1', given: 'init', when: 'event', then: 'ok', verifiers: ['V-MISSING'] }],
      verifiers: [{
        id: 'V1',
        kind: 'script',
        cmd: ['node', 'test.js'],
        expect_exit: 0,
        timeout_s: 30,
        max_output_bytes: 1024,
        evidence: ['test.js'],
        strictness: { mode: 'must_fail_before' },
        author: 'operator',
      }],
      skills: [],
      roles: {
        maker: { family: 'claude', model_id: 'claude-sonnet-5' },
        checker_round: { family: 'codex', model_id: 'codex-1' },
      },
      budget: { max_model_calls: 3, max_rework_rounds: 1 },
      depends_on: ['S-NONEXISTENT'],
    }
    fs.writeFileSync(path.join(invalidMissionDir, 'stories', 'S1.json'), JSON.stringify(invalidContract, null, 2))

    const invalidRes = validateMissionPlan(invalidPlanPath)
    expect(invalidRes.valid).toBe(false)
    expect(invalidRes.errors.length).toBeGreaterThanOrEqual(2)
    expect(invalidRes.errors.some((e: any) => e.message?.includes('V-MISSING') || e.code === 'scenario_verifier_missing')).toBe(true)
    expect(invalidRes.errors.some((e: any) => e.message?.includes('S-NONEXISTENT') || e.code === 'missing_dependency')).toBe(true)

    // CLI ade validate
    let cliOutput = ''
    const exitCode = await cliMain(['validate', '--plan', invalidPlanPath], {
      stderr: (msg: string) => { cliOutput += msg },
    })
    expect(exitCode).toBe(4)
    expect(cliOutput).toContain('invalido')
  })

  test('criterio_3_approve_congela_plano_efeitos_skills_e_recusa_digest_alterado_ou_incompativel', async () => {
    const planned = await planMission({
      request: 'Implementar cálculo de impostos',
      repoDir: tmpRepoDir,
      nonInteractive: true,
    })

    const missionDir = path.dirname(planned.planPath)

    // 1. Aprovação com digest correto congela plano
    const approveRes = await approveMission({
      repoDir: tmpRepoDir,
      missionId: planned.missionId,
      expectedDigest: planned.digest,
    })

    expect(approveRes.approved).toBe(true)
    expect(approveRes.digest).toBe(planned.digest)
    expect(Array.isArray(approveRes.eligibleSkills)).toBe(true)
    expect(Array.isArray(approveRes.permittedEffects)).toBe(true)

    // Confirma que a decisão durável foi gravada no journal
    const journalPath = path.join(missionDir, 'journal.jsonl')
    expect(fs.existsSync(journalPath)).toBe(true)
    const { events } = readJournal(journalPath)
    const approvalEvent = events.find(
      (e) => e.kind === 'decision' && (e.data as any)?.decision === 'plan_approved',
    )
    expect(approvalEvent).toBeDefined()
    expect((approvalEvent?.data as any)?.digest).toBe(planned.digest)

    // assertApprovedPlan confirma
    const planObj = JSON.parse(fs.readFileSync(planned.planPath, 'utf8'))
    const asserted = assertApprovedPlan({ missionDir, plan: planObj })
    expect(asserted.digest).toBe(planned.digest)

    // 2. Aprovação repetida com mesmo digest é idempotente
    const repeatApprove = await approveMission({
      repoDir: tmpRepoDir,
      missionId: planned.missionId,
      expectedDigest: planned.digest,
    })
    expect(repeatApprove.approved).toBe(true)

    // 3. Alteração no plano: digest diverge
    const alteredPlan = { ...planObj, intent: 'Intenção alterada maliciosamente' }
    fs.writeFileSync(planned.planPath, JSON.stringify(alteredPlan, null, 2))

    // Tentativa de aprovação com o digest antigo deve ser recusada
    const alteredRes = await approveMission({
      repoDir: tmpRepoDir,
      missionId: planned.missionId,
      expectedDigest: planned.digest,
    })
    expect(alteredRes.approved).toBe(false)

    // assertApprovedPlan falha fechado pois o plano mudou em relação ao aprovado no journal
    expect(() => assertApprovedPlan({ missionDir, plan: alteredPlan })).toThrow(/digest|alterado|mismatch/i)

    // 4. Tentativa de aprovação incompatível (digest incorreto passado)
    const planned2 = await planMission({
      request: 'Outro pedido independente',
      repoDir: tmpRepoDir,
      nonInteractive: true,
    })
    const badDigestRes = await approveMission({
      repoDir: tmpRepoDir,
      missionId: planned2.missionId,
      expectedDigest: '0000000000000000',
    })
    expect(badDigestRes.approved).toBe(false)

    // CLI ade approve
    let cliOutput = ''
    const cliExit = await cliMain(['approve', '--mission', planned.missionId, '--digest', '0000000000000000', '--repo', tmpRepoDir], {
      stderr: (msg: string) => { cliOutput += msg },
    })
    expect(cliExit).toBe(4)
  })

  test('criterio_4_replan_herda_descoberta_preserva_stories_concluidas_e_marca_substituida', async () => {
    // 1. Criar missão inicial
    const initial = await planMission({
      request: 'S1 entregar modelo de dados, S2 criar migrações, e S3 expor rotas api',
      repoDir: tmpRepoDir,
      nonInteractive: true,
    })

    const initialMissionDir = path.dirname(initial.planPath)

    await approveMission({
      repoDir: tmpRepoDir,
      missionId: initial.missionId,
      expectedDigest: initial.digest,
    })

    const initialJournal = openJournal({
      missionDir: initialMissionDir,
      runtimeStamp: '1:0123456789abcdef:0123456789abcdef',
    })

    // Simula execução:
    // Story S1: concluída (status: committed)
    await initialJournal.append({
      kind: 'story_started',
      unit: 'S1',
      data: { unit: 'S1' },
    })
    await initialJournal.append({
      kind: 'story_done',
      unit: 'S1',
      data: { unit: 'S1', status: 'committed', commit: 'abcdef123456' },
    })

    // Story S2: no_changes (status: awaiting_operator, reason: no_changes)
    await initialJournal.append({
      kind: 'story_started',
      unit: 'S2',
      data: { unit: 'S2' },
    })
    await initialJournal.append({
      kind: 'story_done',
      unit: 'S2',
      data: { unit: 'S2', status: 'awaiting_operator', reason: 'no_changes', commit: null },
    })

    // Story S3: pendente (sem eventos)
    await initialJournal.close()

    // 2. Replanejar o restante
    const replanned = await replanRemaining({
      repoDir: tmpRepoDir,
      fromMissionId: initial.missionId,
      request: 'S2 criar migrações e S3 expor rotas api',
    })

    expect(replanned.missionId).toBeDefined()
    expect(replanned.missionId).not.toBe(initial.missionId)

    // Preservação por digest: S1 concluída permanece intacta com mesmo digest
    expect(replanned.preservedStories.length).toBe(1)
    expect(replanned.preservedStories[0].id).toBe('S1')

    const newMissionDir = path.join(tmpRepoDir, '.ade', 'missions', replanned.missionId)
    const s1Original = fs.readFileSync(path.join(initialMissionDir, 'stories', 'S1.json'), 'utf8')
    const s1Preserved = fs.readFileSync(path.join(newMissionDir, 'stories', 'S1.json'), 'utf8')
    expect(digest16(JSON.parse(s1Preserved))).toBe(digest16(JSON.parse(s1Original)))

    // Somente o restante foi recompilado
    expect(replanned.replannedStories.length).toBeGreaterThan(0)
    const replannedIds = replanned.replannedStories.map((s: any) => s.id)
    expect(replannedIds).not.toContain('S1')

    // Marcação durável de substituição na missão anterior
    const { events: oldEvents } = readJournal(path.join(initialMissionDir, 'journal.jsonl'))
    const replacementEvent = oldEvents.find(
      (e) => e.kind === 'decision' && (e.data as any)?.decision === 'mission_replaced',
    )
    expect(replacementEvent).toBeDefined()
    expect((replacementEvent?.data as any)?.replaced_by).toBe(replanned.missionId)

    // no_changes tratado com no máximo um replanejamento
    // Se a mesma story terminar em no_changes de novo na nova missão, não repete infinitamente
    const newJournal = openJournal({
      missionDir: newMissionDir,
      runtimeStamp: '1:0123456789abcdef:0123456789abcdef',
    })
    const replannedS2Id = replannedIds[0]
    await newJournal.append({
      kind: 'story_started',
      unit: replannedS2Id,
      data: { unit: replannedS2Id },
    })
    await newJournal.append({
      kind: 'story_done',
      unit: replannedS2Id,
      data: { unit: replannedS2Id, status: 'awaiting_operator', reason: 'no_changes', commit: null },
    })
    await newJournal.close()

    // Segundo replanejamento automático deve recusar repetição infinita
    await expect(
      replanRemaining({
        repoDir: tmpRepoDir,
        fromMissionId: replanned.missionId,
        request: 'S2 criar migrações',
      }),
    ).rejects.toThrow(/replan|limite|tentativa/i)
  })

  test('criterio_5_divisao_de_contrato_mantem_requisitos_cenarios_e_dependencias_aciclicas', () => {
    const bigContract = {
      format_version: 2,
      id: 'S-HEAVY',
      title: 'Contrato com múltiplos requisitos e cenários',
      complexity: 'feature',
      needs_ui: false,
      task: 'Processar múltiplos formatos de arquivo',
      workspace: { kind: 'git', root: '.' },
      risk: { level: 'normal', surfaces: [], evidence: [] },
      guardrails: { scope_paths: ['src/**'], do_not_touch: ['.ade/**'], autonomy: 'safe' },
      requirements: [
        { id: 'R1', ears: 'WHEN xml format requested THE SYSTEM SHALL parse xml' },
        { id: 'R2', ears: 'WHEN json format requested THE SYSTEM SHALL parse json' },
        { id: 'R3', ears: 'WHEN yaml format requested THE SYSTEM SHALL parse yaml' },
      ],
      scenarios: [
        { id: 'C1', given: 'xml file', when: 'parse', then: 'ok', verifiers: ['V1'] },
        { id: 'C2', given: 'json file', when: 'parse', then: 'ok', verifiers: ['V2'] },
        { id: 'C3', given: 'yaml file', when: 'parse', then: 'ok', verifiers: ['V3'] },
      ],
      verifiers: [
        { id: 'V1', kind: 'script', cmd: ['node', 'test-xml.js'], expect_exit: 0, timeout_s: 30, max_output_bytes: 1024, evidence: ['test-xml.js'], strictness: { mode: 'must_fail_before' }, author: 'operator' },
        { id: 'V2', kind: 'script', cmd: ['node', 'test-json.js'], expect_exit: 0, timeout_s: 30, max_output_bytes: 1024, evidence: ['test-json.js'], strictness: { mode: 'must_fail_before' }, author: 'operator' },
        { id: 'V3', kind: 'script', cmd: ['node', 'test-yaml.js'], expect_exit: 0, timeout_s: 30, max_output_bytes: 1024, evidence: ['test-yaml.js'], strictness: { mode: 'must_fail_before' }, author: 'operator' },
      ],
      skills: [],
      roles: {
        maker: { family: 'claude', model_id: 'claude-sonnet-5' },
        checker_round: { family: 'codex', model_id: 'codex-1' },
      },
      budget: { max_model_calls: 6, max_rework_rounds: 2 },
    }

    const parts = splitContract(bigContract, { max_scenarios: 1, max_contract_bytes: 32000 })
    expect(parts.length).toBe(3)

    // Requisitos e cenários inteiros preservados
    const allScenarios = parts.flatMap((p) => p.scenarios)
    expect(allScenarios.map((s) => s.id)).toEqual(['C1', 'C2', 'C3'])

    const allRequirements = parts.flatMap((p) => p.requirements)
    expect(allRequirements.map((r) => r.id)).toEqual(['R1', 'R2', 'R3'])

    // Dependências acíclicas e estáveis
    expect(parts[0].depends_on).toBeUndefined()
    expect(parts[1].depends_on).toEqual([parts[0].id])
    expect(parts[2].depends_on).toEqual([parts[1].id])

    // Validação de cada parte em plano compilado
    const plan = {
      format_version: 2,
      id: 'plan-split',
      mission_id: 'mission-split',
      immutable_digest: 'abcdef1234567890',
      authorization: { autonomy: 'safe', permitted_effects: [], eligible_skills: [] },
      phases: [{ epics: [{ stories: parts.map((p) => p.id) }] }],
      mission_budget: { max_usd: 10 },
      budget: { max_model_calls: 3, max_rework_rounds: 1 },
    }
    const valResult = validateCompiledPlan(plan, parts)
    expect(valResult.valid, `Part validation failed: ${JSON.stringify(valResult.errors)}`).toBe(true)

    // Se o contrato não puder ser dividido (ex: cenário único que excede limite)
    const indivisible = {
      ...bigContract,
      scenarios: [bigContract.scenarios[0]],
      requirements: [bigContract.requirements[0]],
    }
    expect(() => splitContract(indivisible, { max_contract_bytes: 50 })).toThrow(/atômico|não cabe no teto/i)
  })
})
