import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { PREFLIGHT_CHECK_ORDER, runPreflight, type PreflightCheckPort } from '../src/engine/preflight.ts'
import { AdeError } from '../src/journal/errors.ts'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const ADR_DIR = path.join(ROOT_DIR, 'docs', 'adr')
const ADR_0026_PATH = path.join(ADR_DIR, '0026-governanca-execucao-custos.md')
const ADR_INDEX_PATH = path.join(ADR_DIR, 'README.md')
const CHARTER_PATH = path.join(ROOT_DIR, 'PROJECT_CHARTER.md')

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

const EXPECTED_PROTECTED_ADR_HASHES: Readonly<Record<string, string>> = Object.freeze({
  '0001-typescript-node-monorepo.md': '3cadb9c9a0a263344dffa1ca33420691f371d7a482ecf7e77fd129c73245556b',
  '0002-journal-jsonl-hash-chain.md': '5d12886229f6a4ddf8d4491544569328926e3ddbd75aff58bce2844b4e9e2f13',
  '0003-port-66-invariantes-e-paridade-93.md': '4eef28870185c2e8eaae6f985976c5654306c4b55f95d5c5f199987871484d8a',
  '0004-transporte-bespoke-v1-acp-depois.md': 'd5f5c1a1d8f6f268e52212b68e078a105e66d098954dd2df3c8c78370479ae01',
  '0005-duas-familias-v1-agy-v0x-maker-checker-por-model-id.md': '0433a01b98aa49c782e3a220c7bdbf45363ce3e53aa16a8158f1d84073f32441',
  '0006-checker-comandos-review-result-rodada-vs-portao.md': '79dd32e592673e4de9e4640c7a531be943688564802e83b46213f508c5bb4898',
  '0007-eval-first-prova-vermelha-strictness.md': 'bdfe5085134bdf18ba5d0092e326f708c2bf90f96be89051bc7e6aa132886c56',
  '0008-intent-compiler-task-contract-classes-faixa-rapida.md': 'eb31b97f3a915e16b0fcef1a7d6995492c46740093ec6d61d3e2deed485bca38',
  '0009-skill-fabric-catalogo-curado-selecao-12-controles.md': 'e0be095eff74ab01ff46a332691651a347497f47ab5fa1a33d0db22981f9b531',
  '0010-frontend-quality-engine-impeccable-juiz-2-rodadas.md': '2f23825407381046232e53b50f8466cbb14fcb0038d1bee38a7aac12038c30d3',
  '0011-context-pack-firewall-telemetria.md': '928d1036391b611479a9188a0eec5bc277e9f286483d0a8255d2f625cc50ea0e',
  '0012-engine-dono-de-worktree-e-processo.md': '45d05f4dfe4b4df519c8c3f31e27bf2de089dc213c8fdf0da26cc1c3fb1f9835',
  '0013-painel-projecao-takeover-por-comando-pty-depois.md': '203e92cb9315355de822bf5e6466db4b69724d035b161647639c1ce96e738892',
  '0014-concorrencia-1-git-por-worktree.md': 'e35bbe5b99b1ff5a65297329e1724178352da818f2b8856c07c454d2d1664c1a',
  '0015-autonomia-niveis-flags-desatendidas.md': '3a3dd3b2beb949e2dccf13698e10b0c73cd91421d73ae2b2180d3e6f586d184d',
  '0016-pesquisa-como-subsistema.md': 'ad81abe71eab91d2e27632cbe5c94e49aefbcb9bbbbdaed396af03b5a6670ab5',
  '0017-harness-doctor-coleta-primeiro.md': 'a83ea74943741aa8e13375865561b365ea0d44787923877d5e2cbe85bc0729c0',
  '0018-graft-opcional.md': 'd973cc3d546a677d4aa17e47f1caa0642f77110716e1fcbcbc3eca880099bc98',
  '0019-rejeicoes.md': '92b26fc7ebf4833f8adea525aef113d09d1049229e7ed8e76ab58cc3f1d5c1f9',
  '0020-metodo-de-desenvolvimento-da-propria-ade.md': 'dfde0fa84d0e9582f088cac6ee370e333f9cf5ab0a1ebf7bc7c69e19cea02dcd',
  '0021-versionamento-do-journal-e-engine-stamp.md': '32eb766d8e97e5d01eda944508ffe37dfbb965eb8fcd7af2283236f99456384e',
  '0022-restricoes-windows.md': 'beb00d5ad35801520867811343d6d426e39fbf7fa77a5dd7f0b54346e5d07568',
  '0023-js-esm-com-jsdoc-e-checkjs.md': 'ac3132c5907ed9a59df99e8ae820efd8036ca79bf34ea59ce0bb7164a37c90bb',
  '0024-autorizacao-roadmap-ate-v1.md': 'e30368cb9d8b8624995ace57d48c11e61e8d99e78bdb21cfcf61dc1c64192601',
  '0025-fallback-da-arvore-de-processos-windows.md': '39da0c2b750ce028dc42d03041c55ba2ced80ffd42811d0465b0eb033db8ab9a',
})

function getProtectedAdrHashes(): Record<string, string> {
  const files = readdirSync(ADR_DIR)
    .filter((file) => /^00(0[1-9]|1[0-9]|2[0-5])-.*\.md$/.test(file))
    .sort()

  const hashes: Record<string, string> = {}
  for (const file of files) {
    hashes[file] = sha256(readFileSync(path.join(ADR_DIR, file)))
  }
  return hashes
}

function buildValidChecks(): Record<string, PreflightCheckPort> {
  /** @type {Record<string, PreflightCheckPort>} */
  const checks: Record<string, PreflightCheckPort> = {}
  for (let i = 0; i < PREFLIGHT_CHECK_ORDER.length; i++) {
    const id = PREFLIGHT_CHECK_ORDER[i]
    // Mistura de portas falsas síncronas e assíncronas
    if (i % 2 === 0) {
      checks[id] = {
        check: () => ({ status: 'ready', reason: null }),
      }
    } else {
      checks[id] = {
        check: async () => ({ status: 'ready', reason: null }),
      }
    }
  }
  return checks
}

describe('preflight e governança de execução v0.2', () => {
  // CA1 — Dado o índice, a Carta e o ADR 0026, quando a prova documental os lê,
  // então os três registram a autorização até a v1, o recorte ativo de governança da v0.2
  // e os padrões provisórios de US$ 300, 50%, 8 horas, 3 unidades, turnos e contexto.
  test('CA1 registra autorização até a v1, recorte de governança e padrões provisórios nos três documentos', () => {
    expect(existsSync(ADR_0026_PATH), 'docs/adr/0026-governanca-execucao-custos.md deve existir').toBe(true)
    expect(existsSync(ADR_INDEX_PATH), 'docs/adr/README.md deve existir').toBe(true)
    expect(existsSync(CHARTER_PATH), 'PROJECT_CHARTER.md deve existir').toBe(true)

    const adr0026 = readFileSync(ADR_0026_PATH, 'utf8')
    const adrIndex = readFileSync(ADR_INDEX_PATH, 'utf8')
    const charter = readFileSync(CHARTER_PATH, 'utf8')

    const docs = [
      { name: 'ADR 0026', content: adr0026 },
      { name: 'docs/adr/README.md', content: adrIndex },
      { name: 'PROJECT_CHARTER.md', content: charter },
    ]

    for (const doc of docs) {
      expect(doc.content, `${doc.name} deve registrar autorização até a v1`).toMatch(/até a v1/i)
      expect(doc.content, `${doc.name} deve registrar recorte ativo de governança da v0.2`).toMatch(/recorte ativo de governança da v0\.2/i)
      expect(doc.content, `${doc.name} deve registrar teto absoluto de US$ 300`).toMatch(/(?:US\$\s*300|300\s*USD|absolute_usd_cap:\s*300)/i)
      expect(doc.content, `${doc.name} deve registrar cota semanal de 50%`).toMatch(/50%/)
      expect(doc.content, `${doc.name} deve registrar 8 horas de parede`).toMatch(/8 horas/)
      expect(doc.content, `${doc.name} deve registrar 3 unidades estacionadas`).toMatch(/3 unidades/)
      expect(doc.content, `${doc.name} deve registrar turnos provisórios`).toMatch(/proof:\s*14/)
      expect(doc.content, `${doc.name} deve registrar turnos implementation: 30`).toMatch(/implementation:\s*30/)
      expect(doc.content, `${doc.name} deve registrar turnos correction: 20`).toMatch(/correction:\s*20/)
      expect(doc.content, `${doc.name} deve registrar turnos review: 10`).toMatch(/review:\s*10/)
      expect(doc.content, `${doc.name} deve registrar limite de contrato de 32000 bytes`).toMatch(/32000/)
      expect(doc.content, `${doc.name} deve registrar limite de pack de 120000 bytes`).toMatch(/120000/)
    }
  })

  // CA2 — Dado o ADR 0026, quando suas restrições são inspecionadas, então segurança,
  // permissões, regras de aprovação e mudanças do plano de controle continuam exigindo
  // aprovação humana e nenhum ADR 0001–0025 foi modificado.
  test('CA2 restrições exigem aprovação humana e nenhum ADR 0001-0025 foi modificado', () => {
    const hashesBefore = getProtectedAdrHashes()
    expect(Object.keys(hashesBefore)).toHaveLength(25)
    expect(hashesBefore, 'Hashes dos ADRs 0001 a 0025 devem bater com a referência canônica').toEqual(
      EXPECTED_PROTECTED_ADR_HASHES,
    )

    expect(existsSync(ADR_0026_PATH), 'docs/adr/0026-governanca-execucao-custos.md deve existir').toBe(true)
    const adr0026 = readFileSync(ADR_0026_PATH, 'utf8')

    // Verificação de aprovação humana para áreas críticas
    const humanApprovalAreas = ['segurança', 'permissões', 'regras de aprovação', 'control_plane_change']
    for (const area of humanApprovalAreas) {
      const areaRegex = new RegExp(area, 'i')
      expect(adr0026, `ADR 0026 deve referenciar barreira para ${area}`).toMatch(areaRegex)
    }
    expect(adr0026, 'ADR 0026 deve exigir expressamente aprovação humana').toMatch(/aprovação humana/i)

    const hashesAfter = getProtectedAdrHashes()
    expect(hashesAfter, 'Hashes dos ADRs 0001 a 0025 não devem ter mudado').toEqual(hashesBefore)

    // Prova de sensibilidade: alteração em qualquer ADR protegido falharia a validação
    const tampered = { ...hashesBefore, '0001-typescript-node-monorepo.md': 'tampered' }
    expect(tampered).not.toEqual(EXPECTED_PROTECTED_ADR_HASHES)
  })

  // CA3 — Dadas oito verificações válidas e planned_paid_calls igual a 6,
  // quando o preflight é avaliado, então retorna ready:true, failures:[] e calls_avoided:0.
  test('CA3 dadas oito verificações válidas e planned_paid_calls 6, retorna ready true, failures vazio e calls_avoided 0', async () => {
    expect(PREFLIGHT_CHECK_ORDER).toEqual([
      'proof_target',
      'dependencies',
      'build',
      'worktree',
      'input',
      'credential',
      'disk',
      'external_access',
    ])

    const checks = buildValidChecks()
    const result = await runPreflight({
      checks,
      planned_paid_calls: 6,
      consumed_paid_calls: 0,
    })

    expect(result.ready).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.calls_avoided).toBe(0)
    expect(result.checks).toHaveLength(8)
    for (const check of result.checks) {
      expect(check.status).toBe('ready')
      expect(check.reason).toBeNull()
    }
  })

  // CA4 — Dadas proof_target ausente e external_access indisponível com 2 chamadas
  // já consumidas de um orçamento 6, quando o preflight é avaliado, então retorna
  // ready:false, failures na ordem declarada e calls_avoided:4.
  test('CA4 dadas proof_target e external_access blocked com 2 consumidas de 6, retorna ready false, failures ordenados e calls_avoided 4', async () => {
    const checks = buildValidChecks()
    checks.proof_target = {
      check: () => ({ status: 'blocked', reason: 'alvo de prova ausente' }),
    }
    checks.external_access = {
      check: async () => ({ status: 'blocked', reason: 'acesso externo indisponível' }),
    }

    const result = await runPreflight({
      checks,
      planned_paid_calls: 6,
      consumed_paid_calls: 2,
    })

    expect(result.ready).toBe(false)
    expect(result.failures).toEqual([
      { id: 'proof_target', reason: 'alvo de prova ausente' },
      { id: 'external_access', reason: 'acesso externo indisponível' },
    ])
    expect(result.calls_avoided).toBe(4)
    expect(result.checks).toHaveLength(8)

    const proofTargetCheck = result.checks.find((c) => c.id === 'proof_target')
    expect(proofTargetCheck).toEqual({
      id: 'proof_target',
      status: 'blocked',
      reason: 'alvo de prova ausente',
    })

    const externalAccessCheck = result.checks.find((c) => c.id === 'external_access')
    expect(externalAccessCheck).toEqual({
      id: 'external_access',
      status: 'blocked',
      reason: 'acesso externo indisponível',
    })
  })

  // CA5 — Dada uma resposta de porta sem status reconhecido, checks nulo,
  // ID obrigatório ausente ou número negativo de chamadas, quando o preflight é avaliado,
  // então ocorre AdeError preflight_input_invalid com exitCode 4.
  test('CA5 dada resposta sem status reconhecido, checks nulo, ID ausente ou chamadas negativas, lança AdeError preflight_input_invalid com exitCode 4', async () => {
    const validChecks = buildValidChecks()

    // 1. checks nulo
    await expect(
      runPreflight({
        checks: null as any,
        planned_paid_calls: 6,
        consumed_paid_calls: 0,
      }),
    ).rejects.toSatisfy(
      (err: any) => err instanceof AdeError && err.code === 'preflight_input_invalid' && err.exitCode === 4,
    )

    // 2. checks sem disk
    const checksWithoutDisk = { ...validChecks }
    delete (checksWithoutDisk as any).disk
    await expect(
      runPreflight({
        checks: checksWithoutDisk,
        planned_paid_calls: 6,
        consumed_paid_calls: 0,
      }),
    ).rejects.toSatisfy(
      (err: any) => err instanceof AdeError && err.code === 'preflight_input_invalid' && err.exitCode === 4,
    )

    // 3. status: 'maybe'
    const checksWithMaybe = {
      ...validChecks,
      disk: {
        check: () => ({ status: 'maybe' as any, reason: 'desconhecido' }),
      },
    }
    await expect(
      runPreflight({
        checks: checksWithMaybe,
        planned_paid_calls: 6,
        consumed_paid_calls: 0,
      }),
    ).rejects.toSatisfy(
      (err: any) => err instanceof AdeError && err.code === 'preflight_input_invalid' && err.exitCode === 4,
    )

    // 4. consumed_paid_calls: -1
    await expect(
      runPreflight({
        checks: validChecks,
        planned_paid_calls: 6,
        consumed_paid_calls: -1,
      }),
    ).rejects.toSatisfy(
      (err: any) => err instanceof AdeError && err.code === 'preflight_input_invalid' && err.exitCode === 4,
    )

    // 5. planned_paid_calls: -1
    await expect(
      runPreflight({
        checks: validChecks,
        planned_paid_calls: -1,
        consumed_paid_calls: 0,
      }),
    ).rejects.toSatisfy(
      (err: any) => err instanceof AdeError && err.code === 'preflight_input_invalid' && err.exitCode === 4,
    )

    // 6. reason não string e não nulo (ex: number)
    const checksWithInvalidReason = {
      ...validChecks,
      disk: {
        check: () => ({ status: 'ready' as any, reason: 123 as any }),
      },
    }
    await expect(
      runPreflight({
        checks: checksWithInvalidReason,
        planned_paid_calls: 6,
        consumed_paid_calls: 0,
      }),
    ).rejects.toSatisfy(
      (err: any) => err instanceof AdeError && err.code === 'preflight_input_invalid' && err.exitCode === 4,
    )

    // 7. reason ausente (undefined)
    const checksWithMissingReason = {
      ...validChecks,
      disk: {
        check: () => ({ status: 'ready' as any } as any),
      },
    }
    await expect(
      runPreflight({
        checks: checksWithMissingReason,
        planned_paid_calls: 6,
        consumed_paid_calls: 0,
      }),
    ).rejects.toSatisfy(
      (err: any) => err instanceof AdeError && err.code === 'preflight_input_invalid' && err.exitCode === 4,
    )
  })
})
