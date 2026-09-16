# ADRs da TL-ADE

Registro de decisões de arquitetura. A fonte canônica é `docs/architecture.md`; cada ADR fixa **uma**
decisão dela, com a evidência que a sustenta (digest `docs/research/README.md` #1–#40, documentos de
`docs/research/`, painel em `docs/research/design-panel/`) e o gatilho de reversão. Os adendos do ECC
(`architecture.md` §10, A1–A14) e a arbitragem das divergências (§11, E1–E40) prevalecem sobre qualquer
trecho anterior, aqui inclusive.

Formato fixo: título · Status · Contexto · Decisão · Evidência · Trade-offs · Alternativas rejeitadas ·
Como reverter · Consequências para outros documentos.

Convenções: um ADR nunca é editado para mudar de rumo — é **substituído** por um novo que o marca como
superseded; afirmação factual sobre CLI ou fonte externa cita `digest #N` ou o arquivo de pesquisa; o
que ainda não tem medição vem marcado `[hipótese]`.

## Índice

| # | Título | Status |
| :-- | :--- | :--- |
| [0001](0001-typescript-node-monorepo.md) | TypeScript sobre Node 22+, ESM estrito, pacote único na raiz na v1 | aceito 2026-09-17 |
| [0002](0002-journal-jsonl-hash-chain.md) | Journal JSONL append-only com cadeia de hash sobre JSON canônico | aceito 2026-09-17 |
| [0003](0003-port-66-invariantes-e-paridade-93.md) | Porte literal dos 66 invariantes e paridade 93/93 como critério de saída da v0.2 | aceito 2026-09-17 |
| [0004](0004-transporte-bespoke-v1-acp-depois.md) | Transporte bespoke headless na v1; ACP como migração por família | aceito 2026-09-17, pendente de confirmação do Erick |
| [0005](0005-duas-familias-v1-agy-v0x-maker-checker-por-model-id.md) | Duas famílias na v1, `agy` na v0.x, Maker ≠ Checker por `model_id` | aceito 2026-09-17, pendente de confirmação do Erick |
| [0006](0006-checker-comandos-review-result-rodada-vs-portao.md) | Checker de rodada (Codex) vs Checker de portão (Claude), com `review-result` rico | aceito 2026-09-17 |
| [0007](0007-eval-first-prova-vermelha-strictness.md) | Eval-first: prova vermelha executada, com `strictness` por classe | aceito 2026-09-17 |
| [0008](0008-intent-compiler-task-contract-classes-faixa-rapida.md) | Intent Compiler, Task Contract, classes de complexidade e faixa rápida | aceito 2026-09-17 |
| [0009](0009-skill-fabric-catalogo-curado-selecao-12-controles.md) | Skill Fabric: catálogo curado, seleção externa e 12 controles de supply chain | aceito 2026-09-17 |
| [0010](0010-frontend-quality-engine-impeccable-juiz-2-rodadas.md) | Frontend Quality Engine: portões determinísticos, Impeccable, juiz de outra família, 2 rodadas | aceito 2026-09-17, pendente de confirmação do Erick |
| [0011](0011-context-pack-firewall-telemetria.md) | Context Pack com tetos, Tool Output Firewall e telemetria por chamada | aceito 2026-09-17 |
| [0012](0012-engine-dono-de-worktree-e-processo.md) | O engine é dono do worktree e do processo | aceito 2026-09-17, pendente de confirmação do Erick |
| [0013](0013-painel-projecao-takeover-por-comando-pty-depois.md) | Painel como projeção, takeover por comando, PTY depois | aceito 2026-09-17, pendente de confirmação do Erick |
| [0014](0014-concorrencia-1-git-por-worktree.md) | Concorrência N=1 na v1, Git por worktree desde o dia 1 | aceito 2026-09-17 |
| [0015](0015-autonomia-niveis-flags-desatendidas.md) | Três níveis de autonomia, flags desatendidas por família, `contain` como única fronteira | aceito 2026-09-17 |
| [0016](0016-pesquisa-como-subsistema.md) | Pesquisa como subsistema: um step, uma incógnita declarada, achado é dado | aceito 2026-09-17 |
| [0017](0017-harness-doctor-coleta-primeiro.md) | Harness doctor: coletar primeiro, ablação depois | aceito 2026-09-17 |
| [0018](0018-graft-opcional.md) | Graft como dependência opcional, com fallback silencioso para `rg` | aceito 2026-09-17 |
| [0019](0019-rejeicoes.md) | Rejeições: o que a ADE não adota e o que mudaria isso | aceito 2026-09-17 |
| [0020](0020-metodo-de-desenvolvimento-da-propria-ade.md) | Método de desenvolvimento da própria ADE | aceito 2026-09-17 |
| [0021](0021-versionamento-do-journal-e-engine-stamp.md) | Versionamento do journal e `runtime_stamp` do engine | aceito 2026-09-17 |
| [0022](0022-restricoes-windows.md) | Restrições do Windows como requisito de primeira classe | aceito 2026-09-17 |

## Mapa decisão → onde ela aparece

| Tema | ADRs | Seção de `architecture.md` |
| :--- | :--- | :--- |
| Stack e repositório | 0001, 0022 | §2, §6, §11 E29 |
| Durabilidade e recuperação | 0002, 0003, 0012, 0014, 0021 | §6, §11 E6, E7, E21, E25–E27 |
| Modelos, transporte e papéis | 0004, 0005, 0006, 0015 | §7, §11 E10, E16, E23, E24 |
| Intenção, contrato e prova | 0007, 0008, 0016 | §4, §5, §11 E1–E4, E12, E18–E20 |
| Contexto, skills e qualidade | 0009, 0010, 0011, 0018 | §7, §10 A1, A7, A11, A13, A14, §11 E8, E9, E13–E15, E33, E35, E39 |
| Observação e método | 0013, 0017, 0019, 0020 | §3, §8, §10 A10, A12, §11 E11, E17, E30, E34, E37 |
