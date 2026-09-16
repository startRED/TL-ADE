# TL-ADE — Evals: filosofia, formato, suítes e dogfood

Documento de subsistema. A arquitetura é fixa em `docs/architecture.md`; aqui só o que ela delega:
o que conta como prova, em que forma, quem mede e com que critério objetivo. Referências a
`architecture.md §N` não são repetidas em prosa. Evidência: `docs/research/README.md` (digest #N) e
os documentos nomeados de `docs/research/`.

---

## 1. Filosofia

**Eval define "pronto". Relato de agente nunca conta.** Um `claude -p` pode reportar sucesso depois
de ter tido a ferramenta bloqueada — medido, não inferido (digest #37). Toda transição para
`complete` exige um exit code gravado no journal, nunca uma frase. O único campo que um agente
escreve no contrato é `passes`, e só por evidência (`architecture.md §4`; digest #22).

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
| **bugfix** | `repro` + `test` | o próprio `repro` contra `tree_before` | exit code + junit/tap |
| **UI** | `build` + `visual` (D1–D7) + `lint` | fixture ruim **reprova** a mesma pipeline | screenshots com metadados + JSON do juiz |
| **API** | `contract` + `negative` | auth inválida → 401/403; payload inválido → 4xx | corpo da resposta + schema validado |
| **infra** | `custom` (comando idempotente) + health check | segunda aplicação não muda estado (diff vazio) | saída do `plan`/`diff` + health check |
| **dados** | `contract` (schema) + `custom` (invariante) | linha corrompida injetada → pipeline falha | relatório do validador |

Transversal a todas: `typecheck` e `lint` entram como gates sempre-ligados quando o repositório os
declara (`architecture.md §3`, C8), não como eval por story — eval por story é o que **discrimina a
mudança**; gate é o que protege o repositório.

---

## 3. Um exemplo completo por `kind`

Campos conforme `interface Eval` (`architecture.md §4`). `cwd` omitido = raiz do worktree.

```jsonc
// test — unidade/integração que prova o comportamento pedido
{ "id": "s14/auth-refresh", "kind": "test",
  "cmd": ["npx","vitest","run","tests/auth.spec.ts","--reporter=junit","--outputFile=.ade-out/junit.xml"],
  "expect_exit": 0, "timeout_s": 300, "max_output_bytes": 8192,
  "evidence": [".ade-out/junit.xml"],
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

// lint — inclui o anti-slop vendorizado em tools/oxlint/anti-slop/ (nunca como dependência)
{ "id": "s14/lint", "kind": "lint",
  "cmd": ["npx","oxlint","--config","tools/oxlint/anti-slop/.oxlintrc.json","src"],
  "expect_exit": 0, "timeout_s": 120, "max_output_bytes": 8192,
  "evidence": [".ade-out/oxlint.json"],
  "strictness": { "mode": "additive", "note": "gate de repositório, não discrimina a story" },
  "author": "operator" }

// typecheck
{ "id": "s14/typecheck", "kind": "typecheck",
  "cmd": ["npx","tsc","--noEmit","-p","tsconfig.json"],
  "expect_exit": 0, "timeout_s": 300, "max_output_bytes": 8192, "evidence": [],
  "strictness": { "mode": "additive" }, "author": "operator" }

// build — pré-requisito do visual; verde antes de servir
{ "id": "s31/build", "kind": "build",
  "cmd": ["npm","run","build"], "expect_exit": 0, "timeout_s": 900, "max_output_bytes": 16384,
  "evidence": ["dist/"], "strictness": { "mode": "additive" }, "author": "operator" }

// visual — D1–D7 + juiz; o engine captura, o agente nunca entrega imagem
{ "id": "s31/visual-dashboard", "kind": "visual",
  "cmd": ["node","tools/ade-fqe.mjs","--route","/dashboard","--widths","1280,390","--themes","light,dark"],
  "expect_exit": 0, "timeout_s": 900, "max_output_bytes": 16384,
  "evidence": [".ade-out/visual/dashboard/*.png",".ade-out/visual/dashboard/verdict.json"],
  "strictness": { "mode": "must_fail_before", "note": "fixture ruim de referência reprova" },
  "author": "intent_compiler" }

// repro — o bug, antes e depois
{ "id": "s07/repro-login-400", "kind": "repro",
  "cmd": ["npx","vitest","run","tests/regress/login-400.spec.ts"],
  "expect_exit": 0, "timeout_s": 180, "max_output_bytes": 4096,
  "evidence": [".ade-out/junit-repro.xml"],
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
| `additive` | vermelho tentado e registrado; falha não bloqueia | aviso no journal e no `ade report`; conta em `strictness_fail` |
| `mutate` | Checker comenta a guarda nomeada e reexecuta; exige falha | reservado; caro por construção, é exceção |

### 4.1 Vermelho não é qualquer vermelho — casos de borda

O `tree_before` é um mutante universal barato, mas tem três degenerações conhecidas
(`landscape-evals-visual.md` §2.3). A resposta é classificar o motivo do vermelho, não abandonar o
portão. O EvalRecord grava `red_reason`, derivado por regra determinística sobre exit code + stderr
normalizado do runner declarado:

| Caso de borda | O que acontece contra `tree_before` | `red_reason` | Tratamento |
| :--- | :--- | :--- | :--- |
| **Arquivo novo** (rota, módulo, componente que ainda não existe) | erro de resolução (`ENOENT`, `Cannot find module`, 404) | `missing_target` | não discrimina: rebaixa para `additive` com `note` automática; exige o caso negativo da classe (§2) no mesmo cenário |
| **Teste novo que não compila antes** (importa símbolo inexistente) | erro de compilação/transpile | `compile_error` | idem `missing_target` |
| **Story puramente aditiva** (feature nova sobre superfície nova) | qualquer um dos dois acima | herdado | `additive` já é o modo declarado; o aviso é esperado, não é ruído |
| **Vermelho legítimo** | assertiva falha, status errado, portão D reprova | `assertion` | único que satisfaz `must_fail_before` |
| **Vermelho por ambiente** | timeout, porta ocupada, rede | `environment` | não conta como vermelho; o step é `ambiguous` e reexecuta (regra de reconciliação de `eval_run`) |

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
| `runtime_stamp` | `<versão do engine>:<digest da config>` | princípio 14 (§10); divergência = `stale_workflow_version` |

Indicador barato já derivável, sem instrumentação nova: **quantos `eval_run` vermelhos precederam o
verde por story**. Story que fecha com zero vermelho é suspeita de eval frouxo
(`landscape-harnesses.md` §3.1, item 5).

---

## 6. Evals dos subsistemas da própria ADE

Cada subsistema tem um eval com alvo falsificável. A ausência disso foi o padrão duplo de rigor
apontado em `judgment-J1` §4-C(3): exigir `recall@8` da Skill Fabric e nada do Intent Compiler.

| Subsistema | Fixture | Asserção | Alvo |
| :--- | :--- | :--- | :--- |
| Intent Compiler | 6–10 pares `pedido → plano esperado` | classe exata; nº de stories dentro da faixa da classe; domínios ⊇ esperados; skills ⊇ esperadas; ≥1 eval por cenário com `kind` esperado presente; nº de perguntas ≤ teto da classe; **nenhuma pergunta respondível pelo discovery** | classe correta em 100 %; faixa de stories em ≥80 % **[hipótese]** |
| Intent Compiler (qualidade do eval gerado) | repositório-fixture com o bug/lacuna plantada | o eval gerado passa o portão `red_reason: assertion` contra `tree_before` do fixture | ≥90 % dos evals gerados discriminam **[hipótese]** |
| Faixa rápida | 5 pedidos `trivial` num repo-fixture | ≤30 s até a **primeira edição de arquivo-fonte**, 0 perguntas, ≤2 `model_call` | 5/5 |
| Skill Fabric | fixtures de pedido com skills esperadas | `recall@8` e `precision@3`; **rank-1 rate** do BM25; detector de colisão de descrições (erro ≥75 % de similaridade par-a-par, aviso ≥50 %) | recall@8 ≥ 0,85; precision@3 ≥ 0,75; rank-1 ≥ 0,95 |
| FQE | 1 fixture ruim, 1 boa, por modo de superfície | ruim **reprova** em D1–D7 ou no juiz; boa **passa em 1 rodada**; nota registrada por família de juiz | 100 % nos dois sentidos |
| Checker | corpus de PRs com defeitos conhecidos | **precisão** (action_items que casam com defeito plantado ÷ total) e **cobertura** (defeitos plantados achados ÷ total) | comparação relativa, não absoluta |
| Adapters | transcripts gravados por família + CLI falsa com contador durável | parser tolera campo desconhecido; `no_result` vira `ambiguous`; `env` e pack capturados batem com o esperado | 100 % |
| Durabilidade | matriz de crash × fase | efeito já feito nunca redespacha; árvore suja vira checkpoint | 100 % das células |

**Faixa rápida — como medir sem ambiguidade.** As três propostas do painel definiram "começar" de
formas incomparáveis, e uma delas mediu até a primeira linha do journal (`judgment-J2` §1 e §5.1).
Definição operacional única: `t0 = batch_open.at`; `t1 = at` do primeiro `step_result` com
`effect_class: 'local_write'` cujo `dirty_paths` contenha caminho **fora** de `.ade/`. `t1 − t0 ≤ 30 s`.
Perguntas = eventos `decision` de origem entrevista. Chamadas = eventos `telemetry` (um por
`model_call`). Os três números saem do mesmo journal, sem instrumentação.

**Checker — protocolo, não placar.** CR-bench (arXiv 2603.23448v3, 184 PRs) é o desenho a copiar:
PRs reais com defeito conhecido, medindo pass rate e precisão separadamente. O número publicado
(Claude 32,1 % vs Codex 20,1 % de pass rate; Codex 88 % vs 78 % de precisão, digest #5) já justifica
a divisão Checker de rodada (precisão, Codex) / Checker de portão (cobertura, Claude) e **não é
métrica da ADE**. O corpus local é construído plantando defeitos conhecidos em commits do próprio
repositório da ADE — barato porque o journal já registra o diff de cada story completada.

**Durabilidade como suíte.** A matriz de `proposal-B-durable.md` §6 vira tabela de casos, uma célula
por teste: crash de {engine, worker/CLI, máquina, browser} × fase {`prepare`, `implement`,
`gates`/`eval`, `commit`/`push`/PR, `merge`, takeover, visual/pesquisa}. É critério de aceite do
slice 1 (`architecture.md §6`), não documentação.

---

## 7. Evals de paridade com o runtime de referência

**Política.** Onde o schema não mudou, o caso TS mantém **o mesmo nome** do caso Python
(`scripts/tests/test_tl_runtime.py`): nome igual é o que torna a paridade auditável linha a linha.
Onde o schema mudou de propósito, o caso é renomeado e entra na tabela de mapeamento — nenhuma das
três propostas do painel listou isso, e é o buraco nomeado em `judgment-J1` §5.3.

| Área | Python (v0.17.0) | TS (ADE) | Motivo |
| :--- | :--- | :--- | :--- |
| review-result | casos sobre `target` / `summary` | casos sobre `target_role` / `problem` / `required_action`; `summary` derivado | forma rica; corrige `intent_gap` que nunca escalava e `stagnation` falso-positivo (digest #32) |
| artefato de plano | `test_batch_*` sobre `batch.json` | `test_plan_*` sobre `plan.json` (Task Contracts) | `plan` substitui `batch` como artefato; o **evento** `batch_open` permanece, então os casos de journal mantêm o nome (`architecture.md §4`) |
| push multi-linha | `test_push_that_errors_after_landing_is_not_repeated` (**skip** no Windows) | mesmo nome, **sem skip** | o shim `.cmd` vira `node shim.js` e recebe argumento multi-linha sem passar por `cmd.exe` (`runtime-port-map.md` §0) |
| classes de efeito novas | — | `eval_run`, `visual_eval`, `research`, `human_takeover`, `human_release`, `catalog_sync` | casos novos, não paridade: nada a mapear |
| helpers fora do porte | `test_context_ledger`, `test_resume_generate` | — | são a origem real do mito das "10 falhas no Windows" (digest #1) |

**Alvo:** 93/93 em Windows **e** Linux, incluindo o caso hoje skipado — critério de saída da v0.2
(`architecture.md §8`; `judgment-J1` §6).

**Custo e onde roda.** A suíte Python leva ~11,7 s por caso, ~18 min em série, dominada por criação
de repositório Git + remoto bare + subprocessos por caso (`runtime-port-map.md` §0). O porte Vitest
precisa de **paralelismo por worker com tmpdir próprio** para o ciclo de paridade ser usável; o
número TS é **[hipótese]** até a primeira execução completa.

**Credencial em CI.** A suíte se divide em dois alvos:

| Alvo | Conteúdo | Credencial | Onde roda |
| :--- | :--- | :--- | :--- |
| `parity` | 93 casos + matriz de crash + adapters por transcript e CLI falsa | nenhuma | CI Linux + Windows, a cada push |
| `live` | sondas de `ade doctor` com chamada real (`probe_ok`/`probed_at`), `$imagegen`, juiz do FQE | assinatura Claude/Codex, gasta dinheiro | **opt-in**, local, nunca automático em CI |

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
| `visual_score` | mediana da nota final e % reprovada na rodada 1 | `visual_eval.final` |
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
| conhecimento exigido do operador | nº de **comandos distintos** + nº de **flags não-default** que a missão exigiu do operador, contados no journal | jornada 1 fecha com 1 comando e 0 flags **[hipótese]**; jornada 6 com ≤3 comandos |

A terceira é a única que precisou de definição nova: "conhecimento exigido" não é auditável como
prosa, e contar comando e flag é a proxy mais barata que muda quando a UX piora.

---

## 9. Escada de dogfood

Cada degrau tem critério objetivo e só se sobe com o anterior verde. Método de desenvolvimento da
própria ADE em `docs/adr/0020-metodo-de-desenvolvimento-da-propria-ade.md`.

| Nível | Escopo | Critério objetivo de aprovação |
| :--- | :--- | :--- |
| **0** | A ADE roda **uma story dela mesma** (ex.: adicionar campo aditivo ao `journal-event`) | `eval_run` vermelho com `red_reason: assertion` seguido de verde; `contain` limpo; canário de isolamento passa; commit local; cadeia de hash do journal verifica ponta a ponta; 0 intervenções humanas |
| **1** | **Lote de 5–10 stories** da própria ADE, uma aprovação só | 100 % das stories terminam em `complete` ou `awaiting_operator` com motivo legível (nunca em estado ambíguo); `escaped_defects` = 0 no lote seguinte; `strictness_fail` reportado e explicado item a item; `eval_pass_first` vira **baseline medido**, não alvo |
| **2** | **Jornadas 1–3 sobre a própria ADE** (correção de 5 min; ajuste com UI; feature com plano) | J1 passa o eval da faixa rápida (≤30 s, 0 perguntas, ≤2 chamadas) em 5/5; J2/J3 fecham com FQE verde em ≤2 rodadas e 0 reprovação de D1–D5 na rodada final; ≤5 perguntas na J3 e nenhuma respondível pelo discovery |
| **3** | **Missão inteira de uma fase do roadmap** (ex.: a v0.4 executada pela v0.3) | plano aprovado **uma única vez**; ≥90 % das stories completam sem `human_takeover`; custo real dentro do orçamento declarado na aprovação (com `cost_source` registrado); a suíte `parity` continua 93/93 depois do merge |
| **4** | **Jornada 6 desatendida** ("continue enquanto durmo") | ≥6 h de wall clock sem operador; retomada após crash induzido **sem nova entrevista**; 0 efeito duplicado (matriz de crash verde durante a noite); para em `awaiting_operator` ao esgotar o backlog aprovado, nunca por travamento; `ade discard <missão>` reverte o lote inteiro em um comando e nada é apagado |

O nível 0 é o "pronto" do slice 1; os níveis 2 e 3 acompanham v0.3 e v0.4; o nível 4 é a v1
(`architecture.md §5`, roadmap).

---

## 10. Benchmarks internos e versionamento da inteligência

Princípio 14 (`PROMPT.md` §3): toda decisão registra versão de harness, modelo, skill, prompt, eval
e evidência. Operacionalmente, **todo resultado de eval e todo resultado de benchmark interno
carrega o mesmo carimbo**, ou a comparação entre rodadas é ruído:

| Dimensão | Campo | Origem |
| :--- | :--- | :--- |
| engine + config | `runtime_stamp` = `<versão do engine>:<digest da config>` | `architecture.md §4`; ADR 0021 |
| modelo por papel | `family` + `model` + `effort` + `role` | `telemetry` por `model_call` |
| skill | `name` + `bytes` + `cited` + `sha256` + `commit` da fonte | `skills_injected[]` + `SkillIndexEntry` |
| prompt/pack | `pack_bytes` + `pack_sections[{section,bytes,digest}]` | `telemetry` |
| eval | `id` do eval + `strictness_mode` efetivo + versão do `eval.schema.json` | EvalRecord (§5) |
| juiz visual | `model_id` **pinado** do juiz | ver divergência D3 (§11) |
| detector | `ENGINE_VERSION` do Impeccable (nunca versão npm) | `architecture.md §7`; digest #19 |

**Desenho de diretório dos benchmarks internos**, emprestado de `@vercel/agent-eval`
(`landscape-evals-visual.md` §5.2): `results/<experimento>/<timestamp>/<eval>/run-N/` com
`result.json` (outcome + métricas) e `outputs/`. O `transcript.json` deles **é o journal** na ADE —
não há nada a construir; falta só o agregador por experimento, que cabe na projeção SQLite da v0.4.

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

## 11. Divergências propostas

Objeções a `architecture.md`, com evidência. A decisão permanece a da arquitetura até a revisão
adversarial decidir.

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
nenhuma proposta. Proposta: os dois alvos da §7 (`parity` sem credencial, `live` opt-in) como
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
