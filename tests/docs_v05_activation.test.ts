import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const CHARTER_PATH = path.join(ROOT_DIR, 'PROJECT_CHARTER.md')
const README_PATH = path.join(ROOT_DIR, 'README.md')
const ROADMAP_PATH = path.join(ROOT_DIR, 'docs', 'roadmap.md')
const ADR_INDEX_PATH = path.join(ROOT_DIR, 'docs', 'adr', 'README.md')
const ADR_0028_PATH = path.join(ROOT_DIR, 'docs', 'adr', '0028-ativacao-da-v05-pesquisa-telemetria-intervencao.md')

const EXPECTED_ADR_HASHES: Record<string, string> = {
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
  '0026-governanca-execucao-custos.md': 'abfd7e3c3004ac82f650bcb81995521891e8fbfc3728bfa408823326e8001ea0',
  '0027-ativacao-da-v04b-painel-local.md': '81ef0340dfc3e47797e6acf55e3076685a1dc56b3ff7027e9d348474f83ea026',
}

describe('Governança e ativação exclusiva da v0.5', () => {
  // Critério (1): Dado o recorte ativo da v0.4b, quando a documentação de governança for validada,
  // então um ADR novo e aceito registra a autorização de Erick, o escopo integral da v0.5 e a continuidade obrigatória da ordem do roadmap.
  test('CA1 ADR 0028 novo e aceito registra autorização de Erick, escopo integral da v0.5 e ordem do roadmap', () => {
    expect(existsSync(ADR_0028_PATH), 'ADR 0028 deve existir em docs/adr/').toBe(true)
    const adr = readFileSync(ADR_0028_PATH, 'utf8')

    // Título e status
    expect(adr).toMatch(/^# ADR 0028\b.*v0\.5/m)
    expect(adr).toMatch(/\*\*Status:\*\* Aceito \(confirmado por Erick/i)

    // Autorização de Erick e continuidade da ordem
    expect(adr).toContain('2026-09-19')
    expect(adr).toContain('ADR 0024')
    expect(adr).toMatch(/v0\.2.*->.*v0\.3.*->.*v0\.4a.*->.*v0\.4b.*->.*v0\.5.*->.*v1/)

    // Escopo integral da v0.5:
    // Pesquisa controlada, agy somente-leitura com canário, incógnita external_fact e tetos
    expect(adr).toContain('agy')
    expect(adr).toContain('canário')
    expect(adr).toContain('external_fact')
    expect(adr).toContain('trivial')
    expect(adr).toContain('bounded')
    expect(adr).toContain('feature')
    expect(adr).toContain('dado') // achado é dado, não instrução

    // Telemetria por model_call, unknown para não observado, sem compaction_events, mission_summary
    expect(adr).toContain('telemetria')
    expect(adr).toContain('model_call')
    expect(adr).toContain('unknown')
    expect(adr).toContain('compaction_events')
    expect(adr).toContain('mission_summary')

    // Drenagem cooperativa, pausa, retomada e takeover com terminal
    expect(adr).toContain('DRAINING')
    expect(adr).toContain('STOPPED')
    expect(adr).toContain('pausa')
    expect(adr).toContain('retomada')
    expect(adr).toContain('takeover')
    expect(adr).toContain('PTY')
    expect(adr).toContain('taskkill /T /F /PID')
    expect(adr).toContain('human_release')

    // Exclusões explícitas da v0.5
    expect(adr).toContain('ACP')
    expect(adr).toContain('N>1')
    expect(adr).toContain('rotinas')
    expect(adr).toContain('OTel')
    expect(adr).toMatch(/GitHub real/i)
  })

  // Critério (2): Dado o novo recorte, quando o charter e o estado público forem consultados,
  // então pesquisa controlada, telemetria, drenagem, pausa, retomada e takeover com terminal aparecem como autorizados,
  // enquanto capacidades da v1 e versões futuras continuam proibidas.
  test('CA2 Charter e estado público autorizam pesquisa, telemetria, drenagem, pausa, retomada e takeover, proibindo v1 e futuras', () => {
    // Validação no PROJECT_CHARTER.md
    expect(existsSync(CHARTER_PATH), 'PROJECT_CHARTER.md deve existir').toBe(true)
    const charter = readFileSync(CHARTER_PATH, 'utf8')
    const charterLines = charter.split(/\r?\n/)
    expect(charterLines.length, 'Carta deve ter no máximo 80 linhas').toBeLessThanOrEqual(80)

    expect(charter).toContain('Recorte ativo de governança da v0.5')
    expect(charter).toContain('pesquisa controlada')
    expect(charter).toContain('telemetria')
    expect(charter).toContain('DRAINING')
    expect(charter).toContain('STOPPED')
    expect(charter).toContain('pausa')
    expect(charter).toContain('retomada')
    expect(charter).toContain('takeover')
    expect(charter).toContain('ADR 0028')

    // Proibições em src/ no charter (v1 e além proibidas)
    expect(charter).toContain('Fora do slice 1 histórico e do recorte ativo da v0.5')
    expect(charter).toContain('ACP')
    expect(charter).toContain('N>1')
    expect(charter).toContain('rotinas')
    expect(charter).toContain('OTel')
    expect(charter).toMatch(/GitHub real/i)

    // Validação no README.md
    expect(existsSync(README_PATH), 'README.md deve existir').toBe(true)
    const readme = readFileSync(README_PATH, 'utf8')
    expect(readme).toContain('ADR 0028')
    expect(readme).toContain('v0.5')
    expect(readme).toContain('pesquisa')
    expect(readme).toContain('telemetria')
    expect(readme).toContain('takeover')

    // Validação no docs/roadmap.md
    expect(existsSync(ROADMAP_PATH), 'docs/roadmap.md deve existir').toBe(true)
    const roadmap = readFileSync(ROADMAP_PATH, 'utf8')
    expect(roadmap).toContain('ADR 0028')
    expect(roadmap).toContain('v0.5')
  })

  // Critério (3): Dado o histórico arquitetural, quando a ativação for registrada,
  // então nenhum ADR aceito anteriormente terá sido editado e o índice apontará para o novo registro.
  test('CA3 Histórico arquitetural preservado: ADRs 0001 a 0027 inalterados e índice aponta para ADR 0028', () => {
    // 1. O índice aponta para ADR 0028
    expect(existsSync(ADR_INDEX_PATH), 'docs/adr/README.md deve existir').toBe(true)
    const indexContent = readFileSync(ADR_INDEX_PATH, 'utf8')
    expect(indexContent).toContain('[0028](0028-ativacao-da-v05-pesquisa-telemetria-intervencao.md)')
    expect(indexContent).toContain('ADR 0028')

    // 2. Todos os ADRs aceitos anteriores (0001 a 0027) permanecem com os hashes idênticos
    for (const [filename, expectedHash] of Object.entries(EXPECTED_ADR_HASHES)) {
      const filePath = path.join(ROOT_DIR, 'docs', 'adr', filename)
      expect(existsSync(filePath), `ADR ${filename} deve existir`).toBe(true)
      const content = readFileSync(filePath)
      const hash = createHash('sha256').update(content).digest('hex')
      expect(hash, `ADR ${filename} não pode ter sido modificado`).toBe(expectedHash)
    }
  })

  // Critério (4): Dado que proto/ é apenas referência, quando o recorte for ativado,
  // então sua proibição de alteração permanece explícita.
  test('CA4 Proibição de alteração em proto permanece explícita', () => {
    const charter = readFileSync(CHARTER_PATH, 'utf8')
    expect(charter).toMatch(/`?proto(?:\/\*{0,2})?`?\s+(fica intocado|é apenas referência)/i)

    if (existsSync(ADR_0028_PATH)) {
      const adr = readFileSync(ADR_0028_PATH, 'utf8')
      expect(adr).toContain('proto')
      expect(adr).toMatch(/`?proto(?:\/\*{0,2})?`?.*(intocado|referência|proibid)/i)
    }
  })
})
