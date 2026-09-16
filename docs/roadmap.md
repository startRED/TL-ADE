# TL-ADE — Roadmap (2026-09-17)

Roadmap por vertical slices. A ordem é fixa e vem de `architecture.md` §1–§3 e das ADRs 0001–0022; este
documento não decide *o quê*, decide *quando, com que prova e a que custo*. Arquitetura em
`architecture.md`; método de construção em `docs/development-method.md` (ADR 0020).

## 0. Como ler

**Unidades.** `dias-dev` = dia de 1 desenvolvedor (Erick) conduzindo Claude Code + Codex, 5 dias por
semana. `h-agente` = horas de parede de chamada de modelo dentro desses dias (não somam ao calendário;
medem custo e o quanto do slice é mecânico). `linhas TS` = produção, sem testes, salvo indicação. Todas
as estimativas são **[hipotese]**: a única base medida é o volume do porte — `tl_runtime.py` 2470 linhas,
`tl_job.py` 2562, `tl_supervisor.py` 558, `tl_ci_slice.py` 181, `test_tl_runtime.py` 1324 (93 casos),
`runtime-port-map.md` cabeçalho. A razão assumida é ~1,3 linha TS estrita por linha Python equivalente e
~350 linhas líquidas (produção + teste) por dia-dev em código de durabilidade.

**Escada de dogfood.** Nível atingido ao fim de cada slice; é eval do projeto, não métrica de vaidade.

| Nível | O que a ADE faz em si mesma |
| :-- | :--- |
| D0 | nada; Erick + Claude Code direto |
| D1 | fecha **uma** story dela mesma, escrita à mão em `plan.json`, com commit local |
| D2 | fecha um **lote** mecânico dela mesma (porte de casos de teste) até PR merged |
| D3 | recebe pedido em linguagem natural sobre si mesma, planeja e executa |
| D4 | constrói o próprio painel e a própria UI sob o FQE |
| D5 | roda a noite desatendida sobre o próprio backlog e conduz a v1 |

**Totais.** ~12.900 linhas TS de produção + ~9.100 de teste; **73 dias-dev** e ~560 h-agente da primeira
linha à v1 — ~15 semanas de calendário, não ~12 (ver §9, divergência 2).

---

## 1. Slice 1 — MVP do motor durável (D1)

**Objetivo.** `ade run --plan plan.json` executa uma story trivial escrita à mão com Maker `claude`, eval
vermelho→verde, `contain` e commit local, sobrevivendo a `kill -9` em qualquer ponto.

**Valor real.** Erick pode dar uma tarefa pequena e desligar a máquina no meio sem perder trabalho nem
pagar duas vezes pela mesma chamada — o que hoje não existe em nenhuma CLI: `claude --resume` retoma a
conversa, não o efeito.

| | Escopo |
| :--- | :--- |
| **Must** | journal (cadeia de hash, fsync, escritor único), `step()` write-ahead, lease com fingerprint, GitPort por worktree, `contain` + canário de isolamento por família, Runner com recibo durável e Job Object, BinaryResolver, adapter `claude`, CLI falsa por família, eval runner `red`/`green`, Pack compiler mínimo, 8 schemas + ajv, `ade run/status/journal/report/doctor` |
| **Should** | `ade show <ref>` (drill-down do Firewall), `runtime_stamp` + `--accept-stale-version` |
| **Experimental** | — |

**Aceite.** (1) Matriz crash × fase verde: engine, worker, máquina e `--timeout` em 6 pontos (antes do
spawn, depois do efeito do Maker, antes/depois do commit, durante `contain`, durante o eval) — nenhum
efeito repetido, cada decisão explicada no journal. (2) Eval que nasce verde é recusado pelo portão
`tree_before`. (3) Segredo plantado no diff bloqueia o lote antes de qualquer commit, mesmo com violação
de escopo simultânea. (4) Linha do journal adulterada → exit 2. (5) `ade doctor` resolve o `.exe` real
atrás dos 3 shims e prova `--json-schema` com chamada real. (6) Canário: escrita fora do worktree pela
família falha e vira `state_integrity`.

**Evals.** `canonicalize_output_byte_identical_to_python_reference_fixture` (vetores RFC 8785 antes de
qualquer outro código); `crash_before_maker_effect_releases_the_call`,
`crash_after_maker_effect_is_ambiguous`, `crash_after_commit_is_not_repeated`;
`journal_hash_chain_detects_tampering`; `invalid_journal_line_is_refused`;
`eval_that_is_green_before_the_change_is_refused`; `secret_in_diff_blocks_batch_before_commit`;
`scope_violation_restores_tree_to_round_start`; `worker_env_is_filtered` (fixture grava `role-N.env.json`);
`pack_sections_in_fixed_order` (fixture grava `role-N.pack.md`); `fake_cli_counter_survives_restart`
(contador em disco, `no_result`). Fixtures em `fixtures/runtime/<cenário>/<papel>.json`, porte direto de
`fake_harness.py`.

**Dependências.** Node ≥22, TypeScript estrito ESM, npm workspaces, `canonicalize`, `ajv`, `node:util`
`parseArgs`, Vitest. Nada mais.

**Riscos.** Canonicalizador errado quebra a cadeia **em silêncio** → vetores JCS são o primeiro commit.
`fs.appendFileSync` não garante flush → fd aberto + `writeSync` + `fsyncSync`. `maxBuffer` default trunca
a varredura de segredo → teste com diff >1 MiB e segredo no fim. `await` entre `step_intent` e efeito abre
reentrância → fila serializada por unidade, provada por teste.

**Pronto.** Aceite verde nos dois SOs; a ADE fecha uma story **dela mesma** (adicionar um campo ao
`journal-event`, com eval) por este caminho; suíte roda em paralelo por worker com tmpdir próprio.

**Não faz.** Push/PR/merge, Checker, plano, skills, FQE, painel, pesquisa, orçamento, detector de loop,
scheduler com DAG, segunda família como Maker.

**Custo.** `journal` 260 · `step` 320 · `lease` 80 · `git` 520 · `contain` 380 · `runner` 300 ·
`binary-resolver` 90 · `adapters/claude` 180 · `adapters/fake` 150 · `eval-runner` 200 · `pack` 240 ·
`schemas+ajv` 120 · `cli` 260 · `scheduler` 90 · `config` 100 ≈ **3.350 TS** + ~1.900 de teste.
**15 dias-dev · ~90 h-agente.** Escada: **D1**.

---

## 2. v0.2 — Paridade, entrega remota e Checker (D2)

**Objetivo.** Fechar os 66 invariantes com paridade 93/93 nos dois SOs e levar uma story até PR merged com
revisão de outra família.

**Valor real.** Erick para de revisar linha a linha: o Codex revisa com `review-result` estruturado, o
rework é automático até o teto, e o PR chega com evidência. É o primeiro lote autônomo real.

| | Escopo |
| :--- | :--- |
| **Must** | porte dos casos restantes com **tabela de mapeamento de nomes** onde o schema mudou; push/PR/merge + reconciliação contra remoto; adapter `codex` + Checker de rodada (`--output-schema review-result`); `rework` ≤N; detector de loop (`normalize`/`signature`); orçamentos (reserva, teto em USD, parede, `max_parked_units`); gate runner com cache por árvore; classes de falha fechadas |
| **Should** | Checker de portão (`claude --permission-mode plan`), gates canônicos no CLOSE, `ade decide`, `ade discard` |
| **Experimental** | `claude ultrareview` como portão opcional pré-merge |

**Aceite.** (1) 93/93 em Windows e Linux, incluindo o caso hoje skipado (o shim `.cmd` vira `node shim.js`).
(2) Suíte de paridade ≤6 min com 4 workers [hipotese] — 18 min em série é inutilizável no ciclo.
(3) CI Linux roda **sem credencial de CLI**: tudo que exige `claude`/`codex` real está atrás de
`ade doctor` e da tag `probe`, nunca da suíte. (4) `no_checker_family_available` → `parked`, nunca aprovado.
(5) Erro de `git push` não decide nada: o remoto é consultado antes. (6) Rede indisponível na retomada →
`awaiting_operator`, nunca retry.

**Evals.** `push_that_errors_after_landing_is_not_repeated` (o skip que some no porte);
`pr_is_adopted_only_with_exact_base_and_head`; `open_pr_after_merge_queue_is_ambiguous_not_failed`;
`ci_rerun_is_always_ambiguous_and_counted`; `checker_that_edits_the_tree_is_reverted`;
`maker_and_checker_with_same_model_id_are_refused`; `loop_signature_detects_a_b_a_oscillation`;
`budget_reserve_blocks_start_not_middle`; fixture `review-result/legacy-shape.json` recusado por ajv na
ingestão; `parity-name-map.json` como artefato versionado com justificativa por caso renomeado.

**Dependências.** Slice 1 verde; `gh` com fixtures por versão; repositório remoto bare de teste.

**Riscos.** Casos de paridade que mudaram de propósito (forma rica do `review-result`, `plan`) não passam
com o mesmo nome → o inventário de renomes é entregável do início do slice, não descoberta do fim.
Piso de 19,4k tokens do Codex encarece o Checker → `--ignore-user-config` sempre e poda do pack.

**Pronto.** Paridade verde; um lote de ≥5 stories mecânicas da própria ADE fechado até merge sem
intervenção; `parity-name-map.json` revisado.

**Não faz.** Interpretar pedido em linguagem natural — o `plan.json` continua escrito à mão.

**Custo.** entrega/reconciliação 700 · adapter codex + review 350 · rework 180 · loop 200 · orçamentos 220 ·
gates 200 ≈ **1.850 TS** + ~2.800 de teste (porte). **13 dias-dev · ~120 h-agente** (o maior bloco mecânico
do projeto; candidato natural a loop autônomo em worktree descartável). Escada: **D2**.

---

## 3. v0.3 — Intent Compiler e Task Contract (D3)

**Objetivo.** `ade "corrija o botão de login"` vira plano de Task Contracts aprovado uma vez e executado.

**Valor real.** Some o conhecimento operacional: Erick descreve o resultado, não o processo. É o north star
em forma mínima.

| | Escopo |
| :--- | :--- |
| **Must** | context discovery determinístico; classificação de complexidade (chamada barata com fallback determinístico); expansão em camadas; entrevista ≤5 perguntas com recusa de pergunta respondível pelo repo e `"não sei"` → default registrado; plano validado por ajv; aprovação única; faixa rápida `trivial` |
| **Should** | `ade plan`, `ade validate`, `ade approve`, `ade takeover`/`release` por comando impresso |
| **Experimental** | pesquisa como step único com schema (uma chamada, sem time) |

**Aceite.** (1) Jornada 1 ponta a ponta: **≤30 s até a primeira edição de arquivo-fonte, 0 perguntas,
≤2 chamadas** — é eval, não propriedade emergente. (2) Story sem eval por cenário, sem `do_not_touch`,
sem classe ou com UI sem `DesignBrief` é recusada pela validação. (3) Eval que nasce verde volta ao Intent
Compiler, não ao Maker. (4) Pergunta cuja resposta está no discovery é recusada com o ponteiro da evidência.
(5) Custo real do classificador medido e registrado (`--model haiku` já faturou como sonnet: US$ 0,37 para
ecoar 200 bytes, digest #26) — acima do teto, cai para a regra determinística.

**Evals.** `trivial_request_reaches_first_source_edit_under_30s`; `question_answerable_by_discovery_is_refused`;
`dont_know_records_default_and_registers_unknown`; `story_without_eval_per_scenario_is_refused`;
`ui_story_without_design_brief_is_refused`; `classifier_cost_is_measured_not_assumed`;
fixtures do tradutor (10–15 pedidos → plano esperado: classe, domínios, nº de stories, evals), com
`pass^3`.

**Dependências.** v0.2; `--json-schema`/`--output-schema` provados pelo doctor.

**Riscos.** EARS genérico ("THE SYSTEM SHALL work correctly") passa na validação de forma e produz eval não
discriminativo — o portão `tree_before` é a defesa real, e as fixtures do tradutor precisam de um caso
**negativo** que deve reprovar. Entrevista que vira interrogatório → teto duro de 5 e recusa por discovery.

**Pronto.** Jornada 1 e jornada 4 executadas em repositório sandbox; a ADE planeja e executa uma feature
dela mesma a partir de uma frase.

**Não faz.** Skills, FQE, painel, pesquisa em time.

**Custo.** intent compiler 900 · contrato/recusas 250 · classes 120 · faixa rápida 150 · entrevista 200 ·
aprovação 180 · CLI 100 ≈ **1.900 TS** + ~1.200 de teste. **11 dias-dev · ~85 h-agente.** Escada: **D3**.

---

## 4. v0.4 — Skill Fabric, Frontend Quality Engine e painel (D4)

**Objetivo.** Qualidade de frontend provada por portão e juiz, skills injetadas sem explodir contexto, e o
estado visível fora do JSONL.

**Valor real.** "Melhore o design dessa página" e "refaça o frontend" passam a ter resposta com nota,
evidência e screenshots lado a lado — e Erick vê a missão acontecendo.

| | Escopo |
| :--- | :--- |
| **Must** | catálogo curado (60–80) com sync pinado por commit, sanitização em build time, quarentena e SkillGuard (12 controles); seleção filtro duro → BM25 top-8 → seletor ≤3; FQE D1–D7 + juiz multimodal de outra família, ≤2 rodadas, corte 7,5; painel somente-leitura como projeção + índice SQLite reconstruível; `ade catalog sync/list/inspect`, `ade serve`, `ade index --rebuild` |
| **Should** | `$imagegen` para asset final; screenshots lado a lado em `awaiting_operator` |
| **Experimental** | duas etapas Claude→Codex no FQE (flag, não default) |

**Aceite.** (1) `recall@8 ≥ 0,85` e `precision@3 ≥ 0,75` nas fixtures de seleção. (2) Skill nova no projeto
exige aprovação; em lote desatendido → `awaiting_operator`. (3) Scripts de skill nunca executados pelo
engine; `contain` inviolável com skill hostil no catálogo. (4) Fixture de UI ruim **reprova**; fixture boa
**passa em 1 rodada**. (5) O painel não tem estado próprio: apagar o SQLite e reconstruir do journal dá o
mesmo resultado byte a byte. (6) Toda ação do painel vira step no journal.

**Evals.** `skill_selection_rank1_routing` e `skill_description_collision` (framework de
`addyosmani/agent-skills`); `hostile_skill_cannot_escape_contain`; `skill_script_is_never_executed`;
`visual_bad_fixture_must_fail` / `visual_good_fixture_passes_in_one_round`;
`judge_scores_before_seeing_diff_and_detector` (anti-ancoragem); `contrast_aa_gate_rejects_known_fixture`;
`projection_rebuild_is_byte_identical`.

**Dependências.** v0.3; `playwright` (biblioteca); `better-sqlite3` (entra **aqui**, com o painel, não antes);
Impeccable 4.3.1 pinado por `ENGINE_VERSION`; `packages/web`.

**Riscos.** É o maior slice do roadmap e o único que entrega três subsistemas novos juntos (ver §9,
divergência 1). Módulo nativo (`better-sqlite3`) no Windows → prebuild verificado no doctor antes do
primeiro uso. Juiz caro dominando o orçamento → o teto vale para o rework, não para o juiz.

**Pronto.** Jornadas 2 e 3 executadas; o painel da própria ADE construído pela ADE sob o FQE.

**Não faz.** PTY embutido, steering, pesquisa em time, telemetria completa.

**Custo.** skill fabric 1.400 · FQE 1.300 · painel + projeção 1.200 ≈ **3.900 TS** + ~1.600 de teste.
**17 dias-dev · ~130 h-agente.** Escada: **D4**.

---

## 5. v0.5 — Pesquisa, takeover embutido e telemetria (D5)

**Objetivo.** A missão longa fica auditável e interrompível: `agy` para pesquisa, PTY no painel, telemetria
por chamada.

**Valor real.** Erick assume o terminal no meio de uma story e devolve sem perder o ciclo; e passa a saber
para onde o dinheiro foi.

| | Escopo |
| :--- | :--- |
| **Must** | adapter `agy` (v0.x) somente-leitura com canário de isolamento; pesquisa como subsistema (time 2–4 opt-in, empate vira pergunta); telemetria completa por `model_call` com `cost_source`; harness doctor em coleta |
| **Should** | takeover com PTY embutido no painel |
| **Experimental** | ablação pareada (Caliper / `claude plugin eval`) sobre um item do harness |

**Aceite.** (1) O canário reprova `agy` que escreve fora do `--add-dir` (comportamento medido, digest #38) →
família fica somente-leitura. (2) Nenhuma decisão do engine depende de `pty.kill()`; encerramento por
`taskkill /T /F /PID`. (3) Achado de pesquisa entra como **dado**, nunca como instrução — teste com achado
contendo instrução embutida. (4) Telemetria fecha: soma de `pack_sections` = `pack_bytes`; `cited` medido.

**Evals.** `agy_canary_detects_write_outside_add_dir`; `research_finding_is_data_not_instruction`;
`takeover_release_resumes_from_checkpoint`; `telemetry_sections_sum_to_pack_bytes`;
`codex_cost_is_estimated_with_cost_source_flag`.

**Dependências.** v0.4; `agy` autenticado; `~/.ade/prices.json`.

**Riscos.** node-pty nunca teve 1.2.0 estável e o bug #967 mata PID alheio (digest #29) → gatilho de
reversão em §8. Time de pesquisa custa ~15× tokens → opt-in por config, nunca default.

**Pronto.** Jornadas 4 e 5 executadas; uma noite desatendida da própria ADE com relatório de manhã.

**Não faz.** ACP, N>1, rotinas, OTel export.

**Custo.** adapter agy + canário 250 · pesquisa 350 · PTY/takeover 450 · telemetria + doctor 400 ≈
**1.450 TS** + ~700 de teste. **9 dias-dev · ~70 h-agente.** Escada: **D5**.

---

## 6. v1 — Jornada 6 e hardening (D5 pleno)

**Objetivo.** A ADE conduz o próprio desenvolvimento por uma noite inteira e a documentação fecha.

**Valor real.** "Continue enquanto durmo" deixa de ser demo: orçamento de parede, `max_parked_units`,
`continue_independent_after_block` e `ade report` de manhã com o motivo de cada parada.

| | Escopo |
| :--- | :--- |
| **Must** | jornada 6 desatendida em dogfood real; suíte de dogfood 20–50 tarefas com `runs: 3` e `pass^3`; calibração do corte visual e dos tetos de pack pela telemetria; documentação (`docs/operations/`, `docs/security/`, `docs/evals/`) |
| **Should** | `ade eval <story>` sobre a suíte de dogfood agregada pelo índice |
| **Experimental** | roteamento sugerido por `~/.ade/routing.jsonl` (humano aplica) |

**Aceite.** (1) Uma noite ≥6 h sem intervenção, backlog aprovado esgotado ou parado em
`awaiting_operator` com motivo por unidade. (2) Nenhum efeito externo fora do `permitted_effects` aprovado.
(3) Tetos de pack ajustados por p90 medido, não por hipótese. (4) Corte visual recalibrado com dados dos
lotes reais (a faixa 7,0–7,5 não tem fonte primária).

**Evals.** `unattended_night_completes_or_parks_with_reason`; `wall_clock_budget_stops_batch_not_story`;
`parked_unit_cap_is_enforced`; suíte de dogfood com os 5 grupos (tradutor, jornadas, visual, estritez,
durabilidade).

**Riscos.** A ADE muda o engine embaixo da própria missão → `runtime_stamp` + `--accept-stale-version`
(ADR 0021) é o único anteparo, e precisa de teste explícito na noite. 45 % do código gerado falha teste de
segurança há 3 anos → revisão humana obrigatória em três pontos: servidor local, `contain`, catálogo.

**Pronto.** Escada D5 sustentada por duas noites consecutivas; ADRs 0001–0022 fechados.

**Não faz.** Nada do backlog de §10.

**Custo.** ≈ **600 TS** + ~900 de teste + docs. **8 dias-dev · ~65 h-agente.**

---

## 7. Invariantes I01–I66 → slice

| Slice | Invariantes |
| :--- | :--- |
| **Slice 1** | I01–I07 (write-ahead, cadeia, fsync, lease, idempotência, `released`/`ambiguous`), I08 (moldura de reconciliação), I09 (`model_call`), I10 (`local_commit`), I16 (`gate`/`prepare` → `released`), I17, I18–I21 (checkpoint, cópia antes de descartar, `clean -fd`, árvore como identidade), I22–I26 (rename, binário, diff integral, restauração por escopo, "não mudou nada"), I27, I29, I33, I34, I48, I49, I52, I55, I56, I59, I60, I64, I65, I66 |
| **v0.2** | I11–I15 (push, PR, `pull_request_merge`, `local_merge`, `ci_rerun`), I28, I30, I31, I32, I35–I40, I41–I43 (loop, classes fechadas, `unknown` → `park`), I44–I47 (orçamentos), I50, I51, I57, I58, I61, I62, I63 |
| **v0.3** | I53 (`immutable_digest` do contrato aprovado), I54 (`spec_revision` = digest da story serializada) |
| **v0.4–v1** | nenhum novo; I31/I32/I59 estendidos ao FQE e ao bloco de skills do pack |

Cobertura: 44 invariantes no slice 1, 20 na v0.2, 2 na v0.3. I15 e I40 entram portados e **desligados**
(`ci.enabled: false`); ver §9, divergência 4.

---

## 8. Gatilhos de reversão

| Sinal medido | Reversão | Custo |
| :--- | :--- | :--- |
| `node-pty` sangrando (crash, PID alheio morto, ConPTY travado) 2× em um mês | `portable-pty` via napi-rs; se persistir, takeover volta a ser só comando impresso | ~2 dias-dev; nenhum dado perdido (o PTY é view) |
| `ade doctor` falhando uma flag entre releases >1× por trimestre | migrar a família para ACP (`transport` já está no `CapabilitySet`, `session_ref: null` já está no evento) | 1 arquivo por família; perde-se schema e id pré-cunhado |
| Operador abre o `journal.jsonl` à mão mais de uma vez por lote | antecipar o painel (é aditivo; só o índice é retrabalho) | ~1 dia-dev |
| `precision@3` < 0,75 ou `rework_rounds` p90 alto em classe `project` | ampliar o catálogo (é `git clone` + `index.json`, não código) e/ou ligar o time de pesquisa | configuração |
| Sessão nova por story perdendo para sessão longa na ablação pareada | `session_ref` já existe: modo `reconnect` por família vira flag de config | ~2 dias-dev |
| Custo do classificador barato acima do teto (digest #26) | regra determinística por tamanho de diff estimado — já é o fallback | zero |
| Nota do juiz travada acima de 7,5 sem defeito escapado por 20 stories | subir o corte; se travada abaixo, calibrar a rubrica antes de mexer no teto de rodadas | configuração |
| Suíte de paridade >10 min no ciclo local | sharding por arquivo e `--no-threads` só nos casos de git | ~0,5 dia-dev |

---

## 9. Divergências propostas

Objeções a `architecture.md`; nenhuma decisão foi alterada aqui.

1. **v0.4 empilha Skill Fabric + FQE + painel (17 dias-dev, o maior slice).** J1 §3 rebaixou a proposta B
   exatamente por "curva de valor invertida" (painel antes do subsistema que o alimenta); aqui a ordem já é
   melhor, mas o painel continua sendo o único item da v0.4 sem eval de qualidade próprio e o único que
   traz módulo nativo (`better-sqlite3`). Proposta: partir em v0.4a (Skill Fabric + FQE) e v0.4b (painel),
   sem mudar a ordem relativa — ou mover o painel para depois da v0.5.
2. **A v1 não cabe em ~3 meses.** Somando os slices: 73 dias-dev ≈ 15 semanas a 5 dias/semana, sem folga
   para retrabalho. J1 §5.1 já registrou que nenhuma proposta tinha calendário e §6 que "a v1 dela não cabe
   em 3 meses". Proposta: declarar a v1 como ~15–16 semanas, ou cortar explicitamente o painel da v1.
3. **`ade eval <story>` está na lista fixa de comandos da v1 sem subsistema dono.** `architecture.md` §3
   lista C1–C22 e nenhum é a suíte de dogfood; `landscape-evals-visual.md` §5.2 propõe 20–50 tarefas com
   `runs: 3`, `pass^3` e agregador no índice SQLite — que só existe a partir da v0.4. Proposta: ou a suíte
   vira C23 na v0.4, ou `ade eval` sai da lista de comandos da v1.
4. **I15 (`ci_rerun`) e I40 (merge remoto exige CI `success`) entram no porte sem consumidor.** O CI loop
   está cortado da v1 e `ci.enabled: false` é o default; `runtime-port-map.md` §4 diz que o que precisa
   sobreviver de `tl_ci_slice.py` é `normalize`/`signature` (o detector de loop, I41), não o fatiador.
   Proposta: marcar I15/I40 como "portados desligados" no critério de paridade, com teste que prova que o
   caminho está inerte, em vez de contá-los como invariantes ativos da v0.2.

---

## 10. Backlog pós-v1 priorizado

| # | Item | Sinal que promove |
| :-- | :--- | :--- |
| 1 | **ACP + steering no meio do turno** | RFD `session/inject` estável **ou** doctor falhando flag >1×/trimestre (§8) **ou** pedido de 4º provider |
| 2 | **N>1 com fila de merge e `node_modules` por worktree** | wall-time medido de lote `subsystem`/`project` com ≥3 stories independentes prontas e fila parada >30 % do tempo |
| 3 | **Rotinas autônomas agendadas** | ≥3 pedidos repetidos idênticos em 30 dias no journal (dead code, cobertura, regressão visual) |
| 4 | **Ablação automática do harness (Caliper)** | harness doctor com ≥20 itens medidos e ≥2 itens com efeito negativo confirmado na coleta manual |
| 5 | **4º provider (OpenCode)** | necessidade de modelo fora das 3 famílias **e** aceitação explícita de chave de API (hoje é princípio) |
| 6 | **OTel export** | `gen_ai.*` sair de status Development com tipo de token de cache **ou** Erick querer dashboard fora do painel |
| 7 | **Memória por usuário** | `ade report` mostrando a mesma preferência re-perguntada ≥3× em missões diferentes |
| 8 | **CI loop (`ci_query`/`ci_rerun` ativos)** | repositório alvo com CI que a ADE não controla e ≥1 merge bloqueado por CI por semana |
| 9 | **Tauri (painel como app)** | painel usado diariamente por ≥1 mês e `ade serve` virando fricção |
| 10 | **Graft** | consulta de contexto recuperado passando de 6k tokens com `rg` em repositório real |

Ordem por sinal, não por desejo: nada sobe sem o número.

---

## 11. Como a ADE constrói a ADE

Resumo; o documento é `docs/development-method.md` (ADR 0020).

O princípio é o de `landscape-dev-workflows.md` §recomendação: **a qualidade da malha de verificação é a
variável independente; a autonomia do agente é a dependente** — Orca com ~30 portões e zero revisão humana
funciona; Gas City sem malha fica em 23 % de CI verde. Portanto, nenhum aumento de autonomia sem portão
novo.

Dia 1: `AGENTS.md` ≤8 KB como roteador de gatilhos (Codex trunca a 32 KiB em silêncio e omite skills acima
de 8.000 chars na listagem, digest #39), `CLAUDE.md` com uma linha (`@AGENTS.md`), `init.sh`,
`docs/plan/features.json` com `passes` como único campo gravável, `docs/reference/` vazio — um arquivo por
cicatriz, escrito no momento do erro. Portões locais na ordem de custo: `tsc --strict` + Vitest → Oxlint com
`anti-slop` pinado por SHA → root directory guard → ratchets (`max-lines`, `ts-nocheck`, `any`) → paridade
93/93 → `code-quality:changed` → verificação de que todo import novo existe no registry (5,2 %/21,7 % de
pacotes alucinados) → razão teste:produção no corpo do PR.

Regra específica desta base: **transcript capturado, nunca tela lembrada** — todo parser de saída de CLI é
escrito contra fixture gravada byte a byte, a classe de bug que o Orca documentou tendo queimado cinco
tentativas. Ponto de troca: o lote de paridade da v0.2 é o único trabalho volumoso, repetitivo e com
critério binário do projeto — é ali que o loop autônomo se paga, em worktree descartável e branch próprio,
nunca em `main`. A partir da v0.3 a própria ADE assume os slices seguintes, subindo a escada D1→D5, e a
régua contínua é a regra de release: **antes de cada versão, a ADE constrói uma story dela mesma**.
