# TL-ADE — Evals: filosofia, formato, suítes e dogfood

Documento de subsistema. A arquitetura é fixa em `docs/architecture.md`; aqui só o que ela delega:
o que conta como prova, em que forma, quem mede e com que critério objetivo. Referências a
`architecture.md §N` não são repetidas em prosa. Evidência: `docs/research/README.md` (digest #N) e
os documentos nomeados de `docs/research/`.

---

## 1. Filosofia

**Eval define "pronto". Relato de agente nunca conta.** Um `claude -p` pode reportar sucesso depois
de ter tido a ferramenta bloqueada — medido, não inferido (digest #37). Toda transição para
`complete` exige um exit code gravado no journal, nunca uma frase. O contrato é imutável após a
aprovação: nenhum agente escreve nele (o campo `passes` foi removido, `architecture.md §11 E1`); o
veredito vive no `unit-result` e o estado da story no journal (`unit_state`) e na projeção
`status.json` (digest #22). Exceção única: em `trivial` com `evals: []` na aprovação, o Maker
preenche `evals` uma vez (`author: 'maker'`, step `local_write` com `eval_authored_by`), e o vermelho
diferido é condição de validade (`architecture.md §11 E2`).

Quatro regras derivadas, todas com fonte:

| Regra | Conteúdo | Fonte |
| :--- | :--- | :--- |
| Outcome, não trajetória | O eval verifica o estado final da árvore e do sistema. A sequência de tool calls fica no journal para auditoria, nunca como critério — *"this approach too rigid"* | `landscape-evals-visual.md` §2.1 (Anthropic, "Demystifying evals for AI agents") |
| Code-based primeiro | Grader model-based só onde code-based é impossível. Na ADE existe exatamente um lugar: a nota estética do FQE | `landscape-evals-visual.md` §2.1 |
| Calibração é o erro dominante | Auditoria de 138 tarefas difíceis do SWE-bench Verified: ~59 % com falhas materiais — teste estreito demais rejeita solução correta, frouxo demais aceita errada. O eval frouxo não é risco teórico | `landscape-evals-visual.md` §1 |
| O portão substitui o humano; o modelo não | Orca: ~11k commits em 6 meses, zero revisão humana, ~30 portões. Gas City sem malha: ~23 % de CI verde | digest #40 |

**Duas populações de eval, dois alvos.** Eval de story é **regressão**: exige ~100 % de passagem.
Suíte de dogfood é **capacidade**: começa com taxa baixa e se reporta em `pass^k` (todas as k
tentativas passam), nunca em `pass@k`, que tende a 100 % com k grande e esconde instabilidade
(`landscape-evals-visual.md` §2.4). Benchmarks públicos medem modelo, não harness, e estão
contaminados: entram como justificativa de princípio, jamais como número reportado
(`landscape-evals-visual.md` §1 e §6).

---

## 2. Taxonomia por classe de tarefa

Um formato só (`Eval` de `architecture.md §4`, validado por `schemas/eval.schema.json`). A classe de
tarefa não muda o formato: muda **quais `kind` são obrigatórios** e **qual é o caso negativo**. O
caso negativo é o que separa eval de teatro — um eval só positivo ("o endpoint responde 200") aceita
quase qualquer implementação (`landscape-evals-visual.md` §2.2).

| Classe | `kind` obrigatórios | Caso negativo obrigatório | Evidência no journal |
| :--- | :--- | :--- | :--- |
| **bugfix** | `repro` + `test` | o próprio `repro` contra `tree_before` | exit code + relatório estruturado do runner com `numTotalTests ≥ 1` (`architecture.md §12 E58`) |
| **UI** | `build` + `visual` (D1–D6) | fixture ruim **reprova** a mesma pipeline | screenshots com metadados + JSON do juiz |
| **API** | `contract` + `negative` | auth inválida → 401/403; payload inválido → 4xx | corpo da resposta + schema validado |
| **infra** | `custom` (comando idempotente) + health check | segunda aplicação não muda estado (diff vazio) | saída do `plan`/`diff` + health check |
| **dados** | `contract` (schema) + `custom` (invariante) | linha corrompida injetada → pipeline falha | relatório do validador |

Transversal a todas: `typecheck` e `lint` entram como gates quando o repositório os declara
(`architecture.md §3`, C8) — o lint anti-slop (Oxlint vendorizado) saiu do FQE e é gate por flag no
C8 com nome próprio `gate:anti-slop`, ativo só em projeto TS/JS (`architecture.md §11 E39`) —, não como eval por story — eval por story é o que **discrimina a
mudança**; gate é o que protege o repositório.

---

## 3. Um exemplo completo por `kind`

Campos conforme `interface Eval` (`architecture.md §4`). `cwd` omitido = raiz do worktree.

**Regra dura de `cmd[0]`:** é sempre `node` ou um `.exe` resolvido pelo BinaryResolver (C6);
`npx`, `npm run` e qualquer `.cmd` são recusados na validação — `spawn('npx.cmd')` sem
`shell:true` falha com `EINVAL` no Node 24/Windows (digest #30, `docs/plans/slice-1.md` §3). O bin
real (`node node_modules/<pkg>/<entrada>`) é confirmado por `ade doctor`.

**Onde `cmd[0]` é validado.** No plano valida-se só a forma; a validação contra os `scripts` e os
binários existentes acontece no `prepare` de cada story, por re-discovery no worktree
(`architecture.md §12 E63`) — é o que permite que uma fase anterior da mesma missão crie o script que
as seguintes usam. O `node_modules` do worktree vem por junction (Windows) ou symlink do checkout
base quando o hash do lockfile bate; se diverge, classe ≥ `bounded` roda o instalador do discovery
como step `prepare` (com `prepare_dependency_ms` na telemetria) e `trivial` para em
`awaiting_operator{reason:'environment'}` (`architecture.md §12 E49`).

```jsonc
// test — unidade/integração que prova o comportamento pedido
{ "id": "s14/auth-refresh", "kind": "test",
  "cmd": ["node","node_modules/vitest/vitest.mjs","run","tests/auth.spec.ts","--reporter=json","--outputFile=.ade-out/vitest.json"],
  "expect_exit": 0, "timeout_s": 300, "max_output_bytes": 8192,
  "evidence": [".ade-out/vitest.json"],   // reporter estruturado e `numTotalTests >= 1`, E58
  "strictness": { "mode": "must_fail_before" }, "author": "intent_compiler" }

// contract — status + schema da resposta (API) ou schema do dado (dados)
{ "id": "s21/orders-contract", "kind": "contract",
  "cmd": ["node","tools/contract.mjs","--route","POST /orders","--schema","schemas/order.schema.json"],
  "expect_exit": 0, "timeout_s": 120, "max_output_bytes": 4096,
  "evidence": [".ade-out/contract/orders.json"],
  "strictness": { "mode": "must_fail_before" }, "author": "intent_compiler" }

// negative — o caminho que TEM de falhar
{ "id": "s21/orders-unauthenticated", "kind": "negative",
  "cmd": ["node","tools/contract.mjs","--route","POST /orders","--no-auth","--expect-status","401"],
  "expect_exit": 0, "timeout_s": 60, "max_output_bytes": 2048,
  "evidence": [".ade-out/contract/orders-401.json"],
  "strictness": { "mode": "additive", "note": "rota nova; vermelho por 404 não discrimina" },
  "author": "intent_compiler" }

// lint — anti-slop vendorizado em tools/oxlint/anti-slop/ (nunca como dependência); gate por flag do C8
{ "id": "s14/lint", "kind": "lint",
  "cmd": ["node","node_modules/oxlint/bin/oxlint","--config","tools/oxlint/anti-slop/.oxlintrc.json","src"],
  "expect_exit": 0, "timeout_s": 120, "max_output_bytes": 8192,
  "evidence": [".ade-out/oxlint.json"],
  "strictness": { "mode": "additive", "note": "gate de repositório, não discrimina a story" },
  "author": "operator" }

// typecheck
{ "id": "s14/typecheck", "kind": "typecheck",
  "cmd": ["node","node_modules/typescript/bin/tsc","--noEmit","-p","tsconfig.json"],
  "expect_exit": 0, "timeout_s": 300, "max_output_bytes": 8192, "evidence": [],
  "strictness": { "mode": "additive" }, "author": "operator" }

// build — pré-requisito do visual; verde antes de servir
{ "id": "s31/build", "kind": "build",
  "cmd": ["node","node_modules/vite/bin/vite.js","build"], "expect_exit": 0, "timeout_s": 900, "max_output_bytes": 16384,
  "evidence": ["dist/"], "strictness": { "mode": "additive" }, "author": "operator" }

// visual — D1–D6 + juiz pinado por model_id; o engine captura, o agente nunca entrega imagem
{ "id": "s31/visual-dashboard", "kind": "visual",
  "cmd": ["node","tools/ade-fqe.mjs","--route","/dashboard","--widths","1280,390","--themes","light,dark"],
  "expect_exit": 0, "timeout_s": 900, "max_output_bytes": 16384,
  "evidence": [".ade-out/visual/dashboard/*.png",".ade-out/visual/dashboard/verdict.json"],
  "strictness": { "mode": "must_fail_before", "note": "fixture ruim de referência reprova" },
  "author": "intent_compiler" }

// repro — o bug, antes e depois
{ "id": "s07/repro-login-400", "kind": "repro",
  "cmd": ["node","node_modules/vitest/vitest.mjs","run","tests/regress/login-400.spec.ts","--reporter=json","--outputFile=.ade-out/vitest-repro.json"],
  "expect_exit": 0, "timeout_s": 180, "max_output_bytes": 4096,
  "evidence": [".ade-out/vitest-repro.json"],
  "strictness": { "mode": "must_fail_before" }, "author": "maker" }

// custom — idempotência de infra, invariante de dados, qualquer comando com exit falsificável
{ "id": "s44/terraform-idempotent", "kind": "custom",
  "cmd": ["node","tools/idempotent.mjs","--","terraform","plan","-detailed-exitcode"],
  "expect_exit": 0, "timeout_s": 600, "max_output_bytes": 8192,
  "evidence": [".ade-out/tfplan.txt"],
  "strictness": { "mode": "must_fail_before" }, "author": "intent_compiler" }
```

`max_output_bytes` implementa o Tool Output Firewall dentro do próprio contrato do eval, não num
wrapper (`landscape-evals-visual.md` §2.1): o bruto vira artifact, o modelo recebe extrato.

---

## 4. Strictness e a prova vermelha por execução

`eval_run` é classe de efeito com três fases (`architecture.md §3`, C9). O vermelho roda contra
`tree_before`, restaurado num worktree descartável; o verde contra `tree_after`; a fase `strictness`
existe só para o modo `mutate`.

| Modo | Exigência | Consequência de violar |
| :--- | :--- | :--- |
| `must_fail_before` | `eval_run{phase:red}` com `exit != 0` contra `tree_before` | eval que nasce verde volta ao **Intent Compiler**, não ao Maker |
| `additive` | vermelho tentado e registrado; falha não bloqueia; exige, no mesmo cenário, um eval `negative` ou um spot-check `mutate` (validação ajv, `architecture.md §11 E12`) | aviso no journal e no `ade report`; conta em `strictness_fail` |
| `mutate` | Checker comenta a guarda nomeada e reexecuta; exige falha | reservado; caro por construção, é exceção |

### 4.1 Vermelho não é qualquer vermelho — casos de borda

O `tree_before` é um mutante universal barato, mas tem três degenerações conhecidas
(`landscape-evals-visual.md` §2.3). A resposta é classificar o motivo do vermelho, não abandonar o
portão. O EvalRecord grava `red_reason`, derivado por regra determinística sobre exit code + stderr
normalizado do runner declarado:

| Caso de borda | O que acontece contra `tree_before` | `red_reason` | Tratamento |
| :--- | :--- | :--- | :--- |
| **Arquivo novo** (rota, módulo, componente que ainda não existe) | erro de resolução (`ENOENT`, `Cannot find module`, 404) | `missing_target` | não discrimina: rebaixa para `additive` com `note` automática; exige o caso negativo da classe (§2) no mesmo cenário; em classe ≥ `feature` o rebaixamento vai a `awaiting_operator` (`architecture.md §11 E12`); em `trivial` **não há rebaixamento** (a classe não tem `negative` nem `mutate`): a story para em `awaiting_operator{reason:'red_unproven'}` com o diff pronto e `ade decide --option accept_unproven` a fecha com `decision` gravada (`architecture.md §12 E51`) |
| **Teste novo que não compila antes** (importa símbolo inexistente) | erro de compilação/transpile | `compile_error` | idem `missing_target` |
| **Story puramente aditiva** (feature nova sobre superfície nova) | qualquer um dos dois acima | herdado | `additive` já é o modo declarado; o aviso é esperado, não é ruído |
| **Vermelho legítimo** | assertiva falha, status errado, portão D reprova | `assertion` | único que satisfaz `must_fail_before` |
| **Vermelho por ambiente** | timeout, porta ocupada, rede | `environment` | não conta como vermelho; o step é `ambiguous` e reexecuta (regra de reconciliação de `eval_run`) |
| **Zero teste executado** (filtro não casa arquivo, suíte vazia) | runner sai 0 sem rodar nada (`numTotalTests: 0`) | `missing_target` | C9 exige reporter estruturado (`--reporter=json` no Vitest/Jest, equivalente por runner) e `numTotalTests ≥ 1`; zero teste nunca é verde (`architecture.md §12 E58`) |

Sem essa classificação, `must_fail_before` é satisfeito por um arquivo que não existe — e o eval
tautológico (escrito para casar com o código que o mesmo modelo vai escrever, risco nomeado em
`judgment-J2` §3-A(1) para a faixa rápida) passa. Com ela, o único vermelho que libera o portão é o
comportamental. O mapeamento regex por runner (vitest, pytest, tsc, go test, cargo, oxlint) é código
do engine, versionado junto com o `runtime_stamp`. **[hipótese]** que 6 runners cobrem o dogfood
inteiro; a cobertura real é medida no nível 1 da escada (§9).

---

## 5. EvalRecord — a evidência no journal

O EvalRecord é o payload do `step_result` com `effect_class: 'eval_run'`. Nada é arquivo solto: o
journal é o transcript (`landscape-evals-visual.md` §5.2).

| Campo | Conteúdo | Por quê |
| :--- | :--- | :--- |
| `eval_id`, `kind`, `phase` | identidade e fase (`red`/`green`/`strictness`) | agregação por story e por kind |
| `tree_ref` | digest da árvore contra a qual rodou | prova que o vermelho foi contra `tree_before` |
| `exit`, `duration_ms`, `red_reason` | resultado bruto + classificação §4.1 | falsificabilidade e diagnóstico |
| `output_digest`, `raw_path` | sha256 do bruto + artifact | `ade show <ref>` faz drill-down sem inchar o pack |
| `evidence_paths[]` | globs resolvidos e gravados | o que o `ade report` mostra de manhã |
| `strictness_mode`, `strictness_warning` | modo efetivo (pode ter sido rebaixado em §4.1) | `strictness_fail` computável |
| `author` | `intent_compiler` / `maker` / `operator` | telemetria da concessão da faixa rápida (`judgment-J2` §4) |
| `runtime_stamp` | `<core_version>:<config_digest>:<capabilities_digest>` (`architecture.md §11 E7`) | princípio 14 (§10); divergência de `core_version` = `stale_workflow_version`, aceita por `ade run --accept-stale-version` |

Indicador barato já derivável, sem instrumentação nova: **quantos `eval_run` vermelhos precederam o
verde por story**. Story que fecha com zero vermelho é suspeita de eval frouxo
(`landscape-harnesses.md` §3.1, item 5).

---

## 6. Evals dos subsistemas da própria ADE

Cada subsistema tem um eval com alvo falsificável. A ausência disso foi o padrão duplo de rigor
apontado em `judgment-J1` §4-C(3): exigir `recall@8` da Skill Fabric e nada do Intent Compiler.

| Subsistema | Fixture | Asserção | Alvo |
| :--- | :--- | :--- | :--- |
| Intent Compiler | 6–10 pares `pedido → plano esperado` | classe exata; nº de stories dentro da faixa da classe; domínios ⊇ esperados; skills ⊇ esperadas; ≥1 eval por cenário com `kind` esperado presente; nº de perguntas ≤ teto da classe; **nenhuma pergunta respondível pelo discovery**; incógnitas restantes registradas em `unknowns[]` do contrato com `kind` correto (`architecture.md §12 E48`) | classe correta em 100 %; faixa de stories em ≥80 % **[hipótese]** |
| Intent Compiler (qualidade do eval gerado) | repositório-fixture com o bug/lacuna plantada | o eval gerado passa o portão `red_reason: assertion` contra `tree_before` do fixture | ≥90 % dos evals gerados discriminam **[hipótese]** |
| Faixa rápida | 5 pedidos `trivial` num repo-fixture | ≤30 s até a **primeira edição de arquivo-fonte**, 0 perguntas, ≤2 `model_call` (o classificador conta quando roda; a regra determinística é tentada primeiro, `architecture.md §11 E18`) | 5/5, como critério de saída da v0.3 (`E40`) |
| Skill Fabric | fixtures de pedido com skills esperadas, sob o protocolo de conformidade em 3 níveis de rigor (`architecture.md §10 A8`) | `recall@8` e `precision@3`; **rank-1 rate** do BM25; braço de controle "BM25@3 puro" contra o seletor barato (`E14`); detector de colisão de descrições (erro ≥75 % de similaridade par-a-par, aviso ≥50 %) | recall@8 ≥ 0,85; precision@3 ≥ 0,75; rank-1 ≥ 0,95 |
| FQE | 1 fixture ruim, 1 boa, por modo de superfície | ruim **reprova** em D1–D6 ou no juiz; boa **passa em 1 rodada**; nota registrada por `model_id` e `judge_family` do juiz | 100 % nos dois sentidos |
| Checker | corpus de PRs com defeitos conhecidos | **precisão** (action_items que casam com defeito plantado ÷ total) e **cobertura** (defeitos plantados achados ÷ total); `review-result` sem `sources[]` é inválido (`architecture.md §11 E8`); vendor do Checker de rodada ≠ vendor do Maker (`E10`) | comparação relativa, não absoluta |
| Adapters | transcripts gravados por família + CLI falsa com contador durável | parser tolera campo desconhecido; `no_result` vira `ambiguous`; `env` e pack capturados batem com o esperado; `probe_ok: null` com `probe_mode` declarado recusa despacho fora de CI, nunca degrada (`E10`) | 100 % |
| Durabilidade | matriz de crash × fase | efeito já feito nunca redespacha; árvore suja vira checkpoint | 100 % das células **existentes na fase** — no slice 1, os 6 pontos de injeção de `ADE_FAULT` de S14 (`prepare`, `implement`, `gates`/`eval`, `commit`) mais `dispatch_into_open_takeover_is_refused`, caso próprio fora do lote portado (`architecture.md §12 E42`); `merge`, takeover e visual/pesquisa entram quando as fases existirem |

**Faixa rápida — como medir sem ambiguidade.** As três propostas do painel definiram "começar" de
formas incomparáveis, e uma delas mediu até a primeira linha do journal (`judgment-J2` §1 e §5.1).
Definição operacional única, com sede normativa em `docs/vision.md` §3 sob o nome
`first_source_edit_ms` e aqui citada por referência (`architecture.md §12 E54`): `t0 = batch_open.at`; `t1 = at` do primeiro `step_result` com
`effect_class: 'local_write'` cujo `dirty_paths` contenha caminho **fora** de `.ade/`. `t1 − t0 ≤ 30 s`.
Perguntas = eventos `decision` de origem entrevista (com `source: operator | engine`). Chamadas =
eventos `telemetry` (um por `model_call`). Os três números saem do mesmo journal, sem instrumentação.
No slice 1 só se grava `first_source_edit_ms` como baseline; o teste
`fast_lane_trivial_starts_within_30s_zero_questions` é critério de saída da v0.3
(`architecture.md §11 E40`).

**Checker — protocolo, não placar.** CR-bench (arXiv 2603.23448v3, 184 PRs) é o desenho a copiar:
PRs reais com defeito conhecido, medindo pass rate e precisão separadamente. O número publicado
(Claude 32,1 % vs Codex 20,1 % de pass rate; Codex 88 % vs 78 % de precisão, digest #5) já justifica
a divisão Checker de rodada (precisão, Codex) / Checker de portão (cobertura, Claude) e **não é
métrica da ADE**. O corpus local é construído plantando defeitos conhecidos em commits do próprio
repositório da ADE — barato porque o journal já registra o diff de cada story completada.

**Durabilidade como suíte.** A matriz de `proposal-B-durable.md` §6 vira tabela de casos, uma célula
por teste: crash de {engine, worker/CLI, máquina, browser} × fase {`prepare`, `implement`,
`gates`/`eval`, `commit`/`push`/PR, `merge`, takeover, visual/pesquisa}. É critério de aceite do
slice 1 (`architecture.md §6`), não documentação — no slice 1 só as células cujas fases existem (os
6 pontos de `ADE_FAULT` de S14); a matriz cheia é critério da v1.

---

## 7. Evals de paridade com o runtime de referência

**Política.** Onde o schema não mudou, o caso TS mantém **o mesmo nome** do caso Python
(`scripts/tests/test_tl_runtime.py`): nome igual é o que torna a paridade auditável linha a linha.
Onde o schema mudou de propósito, o caso é renomeado e entra na tabela de mapeamento — nenhuma das
três propostas do painel listou isso, e é o buraco nomeado em `judgment-J1` §5.3. A tabela
`parity-name-map.json` (lista fechada dos casos que mudam de nome ou semântica) é artefato de
**entrada** da v0.2, não subproduto (`architecture.md §11 E26`).

| Área | Python (v0.17.0) | TS (ADE) | Motivo |
| :--- | :--- | :--- | :--- |
| review-result | casos sobre `target` / `summary` | casos sobre `target_role` / `problem` / `required_action`; `summary` derivado | forma rica; corrige `intent_gap` que nunca escalava e `stagnation` falso-positivo (digest #32) |
| artefato de plano | `test_batch_*` sobre `batch.json` | `test_plan_*` sobre `plan.json` (Task Contracts) | `plan` substitui `batch` como artefato; o **evento** `batch_open` permanece, então os casos de journal mantêm o nome (`architecture.md §4`) |
| push multi-linha | `test_push_that_errors_after_landing_is_not_repeated` (**skip** no Windows) | mesmo nome, **sem skip** | o shim `.cmd` vira `node shim.js` e recebe argumento multi-linha sem passar por `cmd.exe` (`runtime-port-map.md` §0) |
| classes de efeito novas | — | `eval_run`, `visual_eval`, `research`, `human_takeover`, `human_release`, `catalog_sync`, `gate`, `prepare` (`architecture.md §11 E6`) | casos novos, não paridade: nada a mapear |
| helpers fora do porte | `test_context_ledger`, `test_resume_generate` | — | são a origem real do mito das "10 falhas no Windows" (digest #1) |

**Alvo:** 93/93 em Windows **e** Linux, incluindo o caso hoje skipado — critério de saída da v0.2
(`architecture.md §8` e `§11 E26`; `judgment-J1` §6). O slice 1 cobre um subconjunto nomeado de 44
casos; os 93 não são meta do slice.

**Custo e onde roda.** A suíte Python leva ~11,7 s por caso, ~18 min em série, dominada por criação
de repositório Git + remoto bare + subprocessos por caso (`runtime-port-map.md` §0). O porte Vitest
precisa de **paralelismo por worker com tmpdir próprio** para o ciclo de paridade ser usável; o
número TS é **[hipótese]** até a primeira execução completa.

**Credencial em CI.** A suíte se divide em dois alvos:

| Alvo | Conteúdo | Credencial | Onde roda |
| :--- | :--- | :--- | :--- |
| `parity` | 93 casos (44 no slice 1) + matriz de crash + adapters por transcript e CLI falsa; `ade doctor --offline` é o default | nenhuma | CI Linux + Windows, a cada push |
| `probes` | sondas de `ade doctor` com chamada real (`probe_ok`/`probed_at`/`probe_mode: 'real'`), `$imagegen`, juiz do FQE | assinatura Claude/Codex, gasta dinheiro | **opt-in**, local, nunca automático em CI |

Sonda que gasta dinheiro é opt-in explícito — a alternativa (CI que fatura) é o modo de falha que
`judgment-J1` §5.4 aponta como não resolvido por nenhuma proposta.

---

## 8. Métricas de missão

Sete métricas derivadas do journal, sem instrumentação nova (`landscape-evals-visual.md` §5.1):

| Métrica | Definição | Fonte no journal |
| :--- | :--- | :--- |
| `eval_pass_first` | stories com gates verdes sem rework ÷ total | `gates` sem `rework` subsequente |
| `rework_rounds` | mediana e p90 por story | contagem de steps `rework` |
| `escaped_defects` | defeitos achados **depois** de `complete` ÷ stories | steps de missão posterior tocando arquivo de story anterior |
| `visual_score` | mediana da nota final e % reprovada na rodada 1, **só comparável dentro do mesmo `model_id` de juiz** (`architecture.md §11 E9`) | `visual_eval.final` + `judge_family` |
| `human_interventions` | (`human_takeover` + `awaiting_operator`) ÷ stories | classes de efeito |
| `cost_per_story` | USD e tokens, com `cost_source` | `telemetry` por `model_call` |
| `strictness_fail` | evals rebaixados ou reprovados no portão ÷ evals | `eval_run{phase:strictness}` + `strictness_warning` |

`escaped_defects` e `human_interventions` medem a promessa central; as outras cinco são diagnóstico.

**Métricas de UX do `PROMPT.md` §7, agora com definição operacional e eval.** Nenhuma proposta do
painel deu eval a elas (`judgment-J2` §5.1):

| Métrica de UX | Definição operacional | Eval |
| :--- | :--- | :--- |
| perguntas ao usuário | eventos `decision` de origem entrevista, por missão | teto por classe (`architecture.md §5`); fixture do Intent Compiler (§6) |
| tempo até o trabalho começar | `t1 − t0` da §6 (primeira escrita fora de `.ade/`) | eval da faixa rápida: ≤30 s em 5/5 |
| conhecimento exigido do operador | nº de **comandos distintos** + nº de **flags não-default** que a missão exigiu do operador, contados no evento `telemetry` de `scope: 'mission_summary'` (verbos de CLI usados, `architecture.md §11 E11`) | jornada 1 fecha com 1 comando (`ade run <pedido>`) e 0 flags **[hipótese]**; jornada 6 com ≤3 comandos |

A terceira é a única que precisou de definição nova: "conhecimento exigido" não é auditável como
prosa, e contar comando e flag é a proxy mais barata que muda quando a UX piora.

---

## 9. Escada de dogfood

Cada degrau tem critério objetivo e só se sobe com o anterior verde. Método de desenvolvimento da
própria ADE em `docs/adr/0020-metodo-de-desenvolvimento-da-propria-ade.md`.

| Nível | Escopo | Critério objetivo de aprovação |
| :--- | :--- | :--- |
| **0** | A ADE roda **uma story dela mesma** (ex.: adicionar campo aditivo ao `journal-event`) | `eval_run` vermelho com `red_reason: assertion` seguido de verde; `contain` limpo; canário de isolamento passa; commit local; cadeia de hash do journal verifica ponta a ponta; `local_merge` ff-only na base quando ela não mudou desde o `prepare`, senão o commit fica na branch da story e o `report.md` imprime o comando (`architecture.md §12 E64`); 0 intervenções humanas **durante a execução da missão pela ADE** (a aprovação do plano e do merge, e a revisão humana obrigatória do diff de `contain`/isolamento, acontecem fora da missão — `docs/plans/slice-1.md` §6, E30) |
| **1** | **Lote de 5–10 stories** da própria ADE, uma aprovação só | 100 % das stories terminam em `complete` ou `awaiting_operator` com motivo legível (nunca em estado ambíguo), com `ade run` saindo 0 ou 3 — nunca 1, que não existe na tabela de exit codes (`architecture.md §12 E47`); `escaped_defects` = 0 no lote seguinte; `strictness_fail` reportado e explicado item a item; `eval_pass_first` vira **baseline medido**, não alvo |
| **2** | **Jornadas 1–3 sobre a própria ADE** (correção de 5 min; ajuste com UI; feature com plano) | J1 passa o eval da faixa rápida (≤30 s, 0 perguntas, ≤2 chamadas) em 5/5; J2/J3 fecham com FQE verde em ≤2 rodadas e 0 reprovação de D1–D6 na rodada final (D6 = responsivo); ≤5 perguntas na J3 e nenhuma respondível pelo discovery |
| **3** | **Missão inteira de uma fase do roadmap** (ex.: a v0.4a executada pela v0.3) | plano aprovado **uma única vez**; ≥90 % das stories completam sem `human_takeover`; custo real dentro do orçamento declarado na aprovação (com `cost_source` registrado; `max_usd` só vale onde a família reporta custo, nas demais o teto é `max_model_calls` e não existe teto de tokens, `architecture.md §12 E61`); a suíte `parity` continua 93/93 depois do merge |
| **4** | **Jornada 6 desatendida** ("continue enquanto durmo") | `ade run --unattended` só arranca com as quatro precondições duras (gates ativos, baseline de eval verde, rollback em `refs/ade/`, canário de isolamento por worktree — `architecture.md §10 A5`); ≥6 h de wall clock sem operador; retomada após crash induzido **sem nova entrevista**; 0 efeito duplicado (matriz de crash verde durante a noite); para em `awaiting_operator` ao esgotar o backlog aprovado, nunca por travamento; `ade discard <missão>` reverte o lote inteiro em um comando e nada é apagado |

O nível 0 é o "pronto" do slice 1; os níveis 2 e 3 acompanham v0.3 e v0.4a/v0.4b; o nível 4 é a v1
(`architecture.md §5`, roadmap). `ade eval <story>` roda os evals do contrato (dono: C9); a suíte de
dogfood é suíte Vitest do repositório, não comando da v1 (`architecture.md §11 E38`).

---

## 10. Benchmarks internos e versionamento da inteligência

Princípio 14 (`PROMPT.md` §3): toda decisão registra versão de harness, modelo, skill, prompt, eval
e evidência. Operacionalmente, **todo resultado de eval e todo resultado de benchmark interno
carrega o mesmo carimbo**, ou a comparação entre rodadas é ruído:

| Dimensão | Campo | Origem |
| :--- | :--- | :--- |
| engine + config + CLIs | `runtime_stamp` = `<core_version>:<config_digest>:<capabilities_digest>` | `architecture.md §4` e `§11 E7`; ADR 0021 |
| modelo por papel | `family` + `effort` + `models[{role: executor\|advisor, model_id}]`; Maker ≠ Checker por `model_id` e por vendor vale para todo papel da chamada, e `--advisor` só entra na receita quando o modelo do advisor é observável na sonda do doctor | `telemetry` por `model_call`; `architecture.md §12 E66` |
| skill | `name` + `bytes` + `cited` + `sha256` (do conteúdo injetado) + `source` (`catalog@<commit>` ou `local`) no próprio evento, sem depender de join para provar supply chain (`architecture.md §12 E59`); só o catálogo curado entra no pack — skills de `<repo>/.claude/skills/` não entram e não são carregadas pela CLI sob `--safe-mode` (`architecture.md §12 E56`, `catalog-sources.md §1`, `skill-fabric.md §6`) | `skills_injected[]` (+ `SkillIndexEntry` quando a skill vem do catálogo) |
| prompt/pack | `pack_bytes` + `pack_sections[{section,bytes,digest}]` (corte em bytes: `limits.max_pack_bytes`, default 120 000 **[hipótese]**; seção `contract` com teto próprio de 32 000 bytes **[hipótese]**, estouro é `story_pack_overflow` e reabre a divisão da story, `architecture.md §12 E50`; as chaves são derivadas de `schemas/ade-config.schema.json`, fonte única da configuração, `E55`) | `telemetry` |
| seções efetivamente usadas | `sources[]` obrigatório em `unit-result` e `review-result`; sem ele `cited` é sempre falso | `architecture.md §11 E8` |
| eval | `id` do eval + `strictness_mode` efetivo + versão do `eval.schema.json` | EvalRecord (§5) |
| juiz visual | `model_id` **pinado** do juiz + `judge_family`; `visual-eval` vira 9º schema publicado na v0.4b | `architecture.md §11 E9`; §11 D3 desta página |
| detector | `ENGINE_VERSION` do Impeccable (nunca versão npm); divergência do pin é **falha** do `ade doctor` (fail-closed), nunca aviso, e o FQE entra em modo degradado — story com UI para em `awaiting_operator{reason:'fqe_unavailable'}`, story sem UI segue (`architecture.md §12 E45`) | `architecture.md §7`; digest #19 |

**Desenho de diretório dos benchmarks internos**, emprestado de `@vercel/agent-eval`
(`landscape-evals-visual.md` §5.2): `results/<experimento>/<timestamp>/<eval>/run-N/` com
`result.json` (outcome + métricas) e `outputs/`. O `transcript.json` deles **é o journal** na ADE —
não há nada a construir; falta só o agregador por experimento, que cabe na projeção SQLite da v0.4b.

**Método de ablação**: A/B pareado estilo Caliper — fixtures rodando **sem** o item como baseline,
rubrica cega, N trials, taxa de sustentação. É o desenho que a Vercel usou para medir 57 % menos
falhas com `design.md` (>200 execuções, baseline sem o arquivo, sem re-rolls), a única medição
causal publicada de ganho por contexto (`landscape-evals-visual.md` §4.2). `claude plugin eval` já
tem braço baseline (digest #25); o ponto cego conhecido é o braço Codex. Na v1 o harness doctor **só
coleta** (`architecture.md §7`); a ablação automática é futuro.

**Governança**: ledger append-only de mudanças **rejeitadas** por evidência de eval, no modelo do
`evals/skill-impact.md` de `addyosmani/agent-skills` (`ref-addyosmani-agent-skills.md` §4.1) — impede
re-propor a mesma ideia já reprovada. O mesmo repositório fornece o framework de 3 camadas adotado
como **método** (estrutural em CI grátis → roteamento TF-IDF com rank-1 e detector de colisão →
comportamental sob demanda com grader LLM), nunca como dependência de código; `hooks/` e `scripts/`
daquele repositório não entram (risco de execução automática, `ref-addyosmani-agent-skills.md` §5).

---

## 11. Divergências resolvidas

Objeções levantadas a `architecture.md` e a arbitragem correspondente (`architecture.md §11`), que é
canônica. O texto das seções acima já reflete cada decisão.

- **D1 → aceita**, `architecture.md §11 E12`: `additive` exige `negative` ou spot-check `mutate` no mesmo cenário, validado por ajv.
- **D2 → aceita**, `architecture.md §11 E12`: `EvalRecord.red_reason ∈ {assertion, missing_target, compile_error, environment}`; só `assertion` é vermelho válido; rebaixamento automático para `additive` e `awaiting_operator` em classe ≥ `feature`.
- **D3 → aceita**, `architecture.md §11 E9`: `roles.judge` pinado por `model_id`, replicado no `visual_eval`, `judge_family` registrado, `visual_score` comparável só dentro do mesmo juiz; `visual-eval` publicado na v0.4b.
- **D4 → aceita com renomeação**, `architecture.md §11 E26`: dois alvos normativos `parity` (zero credencial, CI Windows + Linux) e `probes` (o antigo `live`; chamadas reais, local, opt-in); `parity-name-map.json` é artefato de entrada da v0.2 e o slice 1 cobre 44 casos.
- **Registrada (não é objeção da página)**, `architecture.md §10 A14`: o `gan-style-harness` do ECC usa 5–15 rodadas e corte 7,0; a ADE mantém ≤2 rodadas e 7,5 (Impeccable normativo, digest #16) e mede no dogfood. O "sprint contract" (Checker assina os critérios antes do `implement`) entra como flag experimental, nunca como default.

Texto original das objeções, preservado como registro:

**D1 — `additive` sem contrapeso deixa a story sem prova nenhuma.** `architecture.md §7` define que
`additive` "só gera aviso registrado". Numa story puramente aditiva — que domina produto novo, e é
exatamente o caso que `judgment-J2` §1 aponta como degradação do mecanismo central — o aviso é a
única consequência, e um eval tautológico passa sem nada o contradizer. Proposta: `additive` exige,
no mesmo cenário, **um eval `negative` ou um `mutate` spot-check**; o caso negativo já é obrigatório
por classe (`landscape-evals-visual.md` §2.2) e o modo `mutate` já existe no schema, então o custo é
de validação no ajv, não de código novo.

**D2 — vermelho sem classificação de motivo é satisfeito por arquivo inexistente.**
`architecture.md §3` (C9) e §7 exigem `exit != 0` contra `tree_before`, sem qualificar a causa. Um
eval que referencia rota, módulo ou componente que ainda não existe fica vermelho por resolução, não
por comportamento — e o portão libera. Proposta: `red_reason` no EvalRecord com rebaixamento
automático para `additive` quando o motivo for `missing_target`, `compile_error` ou `environment`
(§4.1). Evidência: `landscape-evals-visual.md` §2.3 já nomeia a degeneração ("eval que também
falharia por ausência de arquivo") e prescreve `mutate` como saída; a classificação é o que torna a
escolha do modo automática em vez de opinião do Intent Compiler.

**D3 — `visual_score` não é comparável entre lotes sem juiz pinado.** `architecture.md §7` roteia o
juiz por papel via Capability Registry ("melhor multimodal de família diferente"), com primário + 2
fallbacks. Quando o roteamento troca — degradação do doctor, modelo novo, cota —, a métrica anda sem
que a qualidade mude. `landscape-evals-visual.md` §5.2 e §7 registram isso como risco novo e citam o
campo `judge` fixo do `@vercel/agent-eval`. Proposta: `roles.judge` pinado por `model_id` no contrato
e replicado no `visual_eval`; comparação de `visual_score` só dentro do mesmo `model_id`; troca de
juiz abre série nova. ADR 0010 deveria dizê-lo.

**D4 — "93/93 nos dois SOs" não tem história de CI sem credencial.** `architecture.md §8` fixa a
paridade como critério, e §6 fixa a matriz de crash, mas nada separa o que roda sem assinatura do
que faz chamada real e gasta dinheiro — lacuna nomeada em `judgment-J1` §5.4 como não resolvida por
nenhuma proposta. Proposta: os dois alvos da §7 (`parity` sem credencial, `probes` opt-in) como
divisão normativa, e um orçamento de wall clock para o alvo `parity` (o número Python é ~18 min em
série, `runtime-port-map.md` §0) como requisito de porte, não como observação.

---

## 12. Perguntas em aberto

1. Baselines numéricos de `eval_pass_first`, `rework_rounds` e `escaped_defects` não existem: o
   nível 1 da escada (§9) os **produz**, não os verifica. Todo alvo numérico desta página marcado
   **[hipótese]** depende disso.
2. Cobertura do mapeamento `red_reason` por runner: 6 runners são suficientes? Não medido.
3. Corpus local de PRs com defeitos plantados para o eval do Checker: quantos e de onde. O
   repositório da ADE só terá volume depois do nível 1.
4. Custo real da suíte `parity` em Vitest com paralelismo por worker: não medido.
5. Pesos da rubrica visual por modo de superfície (Persuade/Operate/Read/Experience) não estão
   calibrados — os pesos atuais valem para um caso geral (`landscape-evals-visual.md` §9.7).
6. `pass^k` para a suíte de dogfood exige `k` runs por fixture; `k=3` é o default herdado da
   literatura, sem medição de estabilidade na ADE.
