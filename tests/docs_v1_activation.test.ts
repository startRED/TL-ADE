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
const ADR_0029_PATH = path.join(ROOT_DIR, 'docs', 'adr', '0029-ativacao-da-v1-noite-desatendida-e-dogfood.md')

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
  '0028-ativacao-da-v05-pesquisa-telemetria-intervencao.md': 'aeeb3edc18beeff7b5fa57c9c7e5c75c0239fe64358e68c830a73e8f59f723b7',
}

describe('Governança e ativação integral da v1', () => {
  // Critério (1): Dado o conjunto de ADRs aceitos 0001–0028, quando a prova de documentação roda,
  // então o conteúdo de cada um permanece byte a byte idêntico ao registrado e um ADR 0029 novo,
  // com status aceito e confirmação de Erick, existe.
  test('CA1 ADRs aceitos 0001-0028 imutáveis byte a byte e ADR 0029 novo existe com status aceito', () => {
    // 1. Imutabilidade dos ADRs 0001 a 0028
    for (const [filename, expectedHash] of Object.entries(EXPECTED_ADR_HASHES)) {
      const filePath = path.join(ROOT_DIR, 'docs', 'adr', filename)
      expect(existsSync(filePath), `ADR ${filename} deve existir`).toBe(true)
      const content = readFileSync(filePath)
      const hash = createHash('sha256').update(content).digest('hex')
      expect(hash, `ADR ${filename} não pode ter sido modificado`).toBe(expectedHash)
    }

    // 2. Existência do ADR 0029 com status aceito e confirmação de Erick
    expect(existsSync(ADR_0029_PATH), 'ADR 0029 deve existir em docs/adr/').toBe(true)
    const adr = readFileSync(ADR_0029_PATH, 'utf8')
    expect(adr).toMatch(/^# ADR 0029\b.*v1/m)
    expect(adr).toMatch(/\*\*Status:\*\* Aceito \(confirmado por Erick/i)
  })

  // Critério (2): Dado o ADR 0029, quando ele é lido, então cita a autorização de Erick de 2026-09-19
  // e o ADR 0024, descreve o escopo integral da v1 e repete a ordem obrigatória v0.2 -> v0.3 -> v0.4a -> v0.4b -> v0.5 -> v1.
  test('CA2 ADR 0029 cita autorização de Erick, ADR 0024, escopo integral da v1 e ordem do roadmap', () => {
    expect(existsSync(ADR_0029_PATH), 'ADR 0029 deve existir').toBe(true)
    const adr = readFileSync(ADR_0029_PATH, 'utf8')

    // Autorização de Erick e referência ao ADR 0024
    expect(adr).toContain('2026-09-19')
    expect(adr).toContain('ADR 0024')

    // Ordem obrigatória dos marcos
    expect(adr).toMatch(/v0\.2.*->.*v0\.3.*->.*v0\.4a.*->.*v0\.4b.*->.*v0\.5.*->.*v1/)

    // Escopo integral da v1:
    // Noite desatendida com precondições duras
    expect(adr).toContain('--unattended')
    expect(adr).toContain('precondições duras')
    expect(adr).toContain('orçamento de parede')
    expect(adr).toContain('max_wall_clock_seconds')
    expect(adr).toContain('max_parked_units')
    expect(adr).toContain('awaiting_operator')
    expect(adr).toMatch(/relat[oó]rio matinal/i)
    expect(adr).toContain('exit 3')
    expect(adr).toContain('exit 2')

    // Suíte de dogfood runs: 3 e pass^3 como suíte Vitest do repositório
    expect(adr).toContain('dogfood')
    expect(adr).toContain('runs: 3')
    expect(adr).toContain('pass^3')
    expect(adr).toContain('Vitest')

    // Calibração de corte visual e tetos de contexto pela telemetria
    expect(adr).toContain('corte visual')
    expect(adr).toContain('telemetria')
    expect(adr).toContain('tetos de contexto')

    // Documentação de operações, segurança e evals
    expect(adr).toContain('docs/operations/')
    expect(adr).toContain('docs/security/')
    expect(adr).toContain('docs/evals/')

    // Fallback de encerramento e não dependência
    expect(adr).toContain('taskkill /T /F /PID')
    expect(adr).toContain('ADR 0025')
  })

  // Critério (3): Dado a carta do projeto e o roadmap, quando a prova roda,
  // então o recorte ativo declarado é a v1, a v0.5 aparece como entregue e os itens de backlog pós-v1
  // continuam na lista de exclusões de src/.
  test('CA3 Charter e roadmap declaram recorte ativo v1 com v0.5 entregue e exclusões pós-v1 em src', () => {
    // Validação no PROJECT_CHARTER.md
    expect(existsSync(CHARTER_PATH), 'PROJECT_CHARTER.md deve existir').toBe(true)
    const charter = readFileSync(CHARTER_PATH, 'utf8')
    const charterLines = charter.split(/\r?\n/)
    expect(charterLines.length, 'Carta deve ter no máximo 80 linhas').toBeLessThanOrEqual(80)

    // Recorte ativo declarado é a v1
    expect(charter).toMatch(/Recorte ativo de governança da v1/i)
    expect(charter).toContain('ADR 0029')

    // v0.5 aparece como entregue
    expect(charter).toMatch(/v0\.5.*(entregue|concluíd)/i)

    // Exclusões de src/ contêm backlog pós-v1
    expect(charter).toMatch(/Fora do slice 1 histórico e do recorte ativo da v1/i)
    expect(charter).toContain('ACP')
    expect(charter).toContain('N>1')
    expect(charter).toContain('rotinas')
    expect(charter).toContain('OTel')
    expect(charter).toMatch(/GitHub real/i)
    expect(charter).toMatch(/`?proto(?:\/\*{0,2})?`?\s+(fica intocado|é apenas referência)/i)

    // Validação no docs/roadmap.md
    expect(existsSync(ROADMAP_PATH), 'docs/roadmap.md deve existir').toBe(true)
    const roadmap = readFileSync(ROADMAP_PATH, 'utf8')

    // §5 v0.5 entregue
    expect(roadmap).toMatch(/## 5\. v0\.5[^\r\n]*\r?\n\r?\n\*\*Estado\.\*\* Entregue/i)

    // §6 v1 como recorte ativo
    expect(roadmap).toMatch(/## 6\. v1[^\r\n]*\r?\n\r?\n\*\*Estado\.\*\* Recorte ativo/i)
    expect(roadmap).toContain('ADR 0029')
  })

  // Critério (4): Dado o índice de ADRs e o README, quando a prova roda,
  // então ambos listam o ADR 0029 com status aceito e apontam o recorte ativo v1 sem contradizer a carta.
  test('CA4 Índice de ADRs e README listam ADR 0029 aceito e apontam recorte ativo v1 coerente com a carta', () => {
    // Validação no docs/adr/README.md
    expect(existsSync(ADR_INDEX_PATH), 'docs/adr/README.md deve existir').toBe(true)
    const indexContent = readFileSync(ADR_INDEX_PATH, 'utf8')
    expect(indexContent).toContain('[0029](0029-ativacao-da-v1-noite-desatendida-e-dogfood.md)')
    expect(indexContent).toMatch(/\[0029\].*Aceito/i)
    expect(indexContent).toContain('ADR 0029')
    expect(indexContent).toContain('v1')

    // Validação no README.md
    expect(existsSync(README_PATH), 'README.md deve existir').toBe(true)
    const readme = readFileSync(README_PATH, 'utf8')
    expect(readme).toContain('ADR 0029')
    expect(readme).toMatch(/Recorte ativo deste épico:\s*v1/i)
    expect(readme).toMatch(/v0\.5.*entregue/i)
  })
})
