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
~300 linhas líquidas (produção + teste) por dia-dev em código de durabilidade — razão **derivada** da soma
das seções §1–§6 (13.050 + 9.100 em 73 dias-dev), não arbitrada; é ela que a medição da semana 1 refuta.

**Escada de dogfood.** Nível atingido ao fim de cada slice; é eval do projeto, não métrica de vaidade.

| Nível | O que a ADE faz em si mesma |
| :-- | :--- |
| D0 | nada; Erick + Claude Code direto |
| D1 | fecha **uma** story dela mesma, escrita à mão em `plan.json`, com commit local |
| D2 | fecha um **lote** mecânico dela mesma (porte de casos de teste) até PR merged |
| D3 | recebe pedido em linguagem natural sobre si mesma, planeja e executa |
| D4 | constrói o próprio painel e a própria UI sob o FQE |
| D5 | roda a noite desatendida sobre o próprio backlog e conduz a v1 |

**Totais.** ~13.050 linhas TS de produção (soma dos "Custo" de §1–§6) + ~9.100 de teste; **73 dias-dev** e ~560 h-agente da primeira
linha à v1 — **~15–16 semanas** de calendário, não ~12 nem "3 meses" (`architecture.md` §11 E37; ver §9,
resolvida 2). O slice 1 mede **linhas portadas por dia** na semana 1 e obriga replanejamento explícito
destas estimativas antes da v0.2; até lá tudo aqui é [hipotese].

---

## 1. Slice 1 — MVP do motor durável (D1)

**Objetivo.** `ade run --plan plan.json` executa uma story trivial escrita à mão com Maker `claude`, eval
vermelho→verde, `contain` e commit local, sobrevivendo a `kill -9` em qualquer ponto.

**Valor real.** Erick pode dar uma tarefa pequena e desligar a máquina no meio sem perder trabalho nem
pagar duas vezes pela mesma chamada — o que hoje não existe em nenhuma CLI: `claude --resume` retoma a
conversa, não o efeito.

| | Escopo |
| :--- | :--- |
| **Must** | journal (cadeia de hash, fsync, escritor único), `step()` write-ahead, lease com fingerprint, GitPort por worktree, `contain` + canário de isolamento por família, Runner com recibo durável e Job Object, BinaryResolver, adapter `claude`, CLI falsa por família, eval runner `red`/`green` com `red_reason` (só `assertion` conta como vermelho válido), classes de efeito `gate` e `prepare` desde o dia 1, `prepare` que recusa worktree com `takeover.json` presente (E42) e cria junction (Windows) ou symlink de `node_modules` para o checkout base quando o hash do lockfile bate — lockfile divergente instala no `prepare` em classe ≥ `bounded` (`prepare_dependency_ms`) e para `trivial` em `awaiting_operator{reason:'environment'}` (E49), Pack compiler mínimo com corte em bytes (`limits.max_pack_bytes`, default 120 000 [hipotese]; teto próprio de 32 000 bytes na seção `contract` — E50), 8 schemas + ajv (`schemas/ade-config.schema.json` é a **única fonte** das chaves de configuração; tabelas em prosa nos specs são derivadas e não normativas — E55), `ade run/status/journal/report/doctor` |
| **Should** | `ade show <ref>` (drill-down do Firewall), `runtime_stamp` em três partes (`<core_version>:<config_digest>:<capabilities_digest>`, só `core_version` bloqueia) + `ade run --accept-stale-version` gravado como `decision` |
| **Experimental** | — |

**Aceite.** (1) Matriz crash × fase verde: engine, worker, máquina e `--timeout` em 6 pontos (antes do
spawn, depois do efeito do Maker, antes/depois do commit, durante `contain`, durante o eval) — nenhum
efeito repetido, cada decisão explicada no journal. (2) Eval que nasce verde é recusado pelo portão
`tree_before`. (3) Segredo plantado no diff bloqueia o lote antes de qualquer commit, mesmo com violação
de escopo simultânea — o blob fica em `refs/ade/quarantine/`, nunca empurrado, com alerta do doctor; purga
é comando manual pós-v1 e **não** existe na v1 (E60). (4) Linha do journal adulterada → exit 2, pela tabela
única de exit codes da master-spec §4 (0 ok, 2 recusa ou parada final, 3 concluído com paradas, 4 entrada
inválida, 5 lease; não existem 1 nem 6 — E47). (5) `ade doctor` resolve o `.exe` real
atrás dos 3 shims e prova `--json-schema` com chamada real (`probe_mode: 'real'`); `ade doctor --offline`
é o default em CI e devolve `probe_ok: null`, que recusa despacho em vez de degradar. (6) Canário: escrita
fora do worktree pela família falha e vira `state_integrity` — a deny-list (`~/.ssh/**`, `~/.aws/**`,
`**/.env*`) vive no `env` filtrado, no canário e no doctor, nunca no `contain`. (7) Subconjunto **nomeado
de 44 casos** de paridade verde; os 93/93 são critério da v0.2, não daqui.

**Evals.** A lista canônica é a de `docs/plans/slice-1.md` §4 — **os 12 novos, o
`dispatch_into_open_takeover_is_refused` acrescentado por E42 (fora do lote portado) e os 44 portados** —, e este
roadmap deliberadamente **não** a duplica: o comando de eval é `vitest run --reporter=json … -t "<nome>"` e um
`-t` sem correspondência não falha, passa com zero testes — por isso C9 exige reporter estruturado e
`numTotalTests ≥ 1`, e zero testes executados é `red_reason: 'missing_target'`, nunca verde (E58). Âncoras
do slice, na ordem em que precisam ficar verdes:
`canonicalize_output_byte_identical_to_python_reference_fixture` (vetores RFC 8785 antes de qualquer outro
código), `journal_hash_chain_detects_tampering`, `invalid_journal_line_is_refused`,
`crash_before_maker_effect_releases_the_call`,
`crash_after_maker_effect_consumes_call_and_continues_from_checkpoint`,
`crash_after_commit_is_reconciled_without_a_second_commit`, `eval_born_green_is_rejected`,
`secret_in_diff_stops_batch`, `scope_expansion_restores_tree_then_parks_on_repeat`, `worker_env_is_scrubbed`,
`pack_sections_are_ordered_and_contain_no_journal`, `fake_cli_counter_survives_engine_restart` (contador em
disco, `no_result`). Fixtures em `fixtures/runtime/<cenário>/<papel>.json`, porte direto de
`fake_harness.py`. A faixa rápida **não** tem eval aqui: o slice 1 grava só `first_source_edit_ms` como
baseline — a métrica U1 tem definição operacional única em `vision.md` §3 (tempo do `ade run` até o primeiro
`local_write` em arquivo fora de `.ade/` que não seja arquivo de eval, medido pelo journal), citada aqui por
referência (E54); o portão `fast_lane_trivial_starts_within_30s_zero_questions` é critério de saída da v0.3.

**Dependências.** Node ≥22, TypeScript estrito ESM, **pacote único na raiz** (npm workspaces só no commit
que cria `packages/web`, na v0.4b), `canonicalize`, `ajv`, `node:util` `parseArgs`, Vitest. Nada mais.
Artefatos do dia 1: `scripts/record-transcript.ts` (transcript gravado byte a byte) e o fallback do
estágio 0 (`claude -p` em loop) com cursor durável no formato de linha do `journal-event`.

**Riscos.** Canonicalizador errado quebra a cadeia **em silêncio** → vetores JCS são o primeiro commit.
`fs.appendFileSync` não garante flush → fd aberto + `writeSync` + `fsyncSync`. `maxBuffer` default trunca
a varredura de segredo → teste com diff >1 MiB e segredo no fim. `await` entre `step_intent` e efeito abre
reentrância → fila serializada por unidade, provada por teste.

**Pronto.** Aceite verde nos dois SOs; a ADE fecha uma story **dela mesma** (adicionar um campo ao
`journal-event`, com eval) por este caminho; suíte roda em paralelo por worker com tmpdir próprio;
cobertura ≥85 % de linhas **só** em `journal, step, lease, git, runner, contain` [hipotese] — no resto a
régua é a razão teste:produção no corpo do PR, sem portão. Medição de linhas portadas por dia da semana 1
publicada e as estimativas de §0 replanejadas.

**Não faz.** Push/PR/merge, Checker, plano, skills, FQE, painel, pesquisa, orçamento **completo** (parede,
`max_parked_units`, defaults por classe — a reserva I44 e o teto em USD sobre custo observado I45 entram já
aqui, `docs/plans/slice-1.md` S14), detector de loop, scheduler com DAG, segunda família como Maker.

**Custo.** `journal` 180 · `step` 260 · `lease` 70 · `git` 240 · `runner` 230 · `contain` 160 ·
`gates` 90 · `evals` 110 · `pack` 140 · `adapters/claude` 130 · `adapters/fake` 120 · `cli` 180 ·
`engine` 120 = **2.030 TS** + ~2.500 de teste (≈ 1,2:1). Números idênticos aos da tabela por módulo de
`docs/plans/slice-1.md` §2, que é o **baseline único** da medição da semana 1 (E37); `scheduler` e
`config` não entram porque o charter do slice 1 exclui DAG e configuração além do `ade-config`.
**15 dias-dev · ~90 h-agente.** Escada: **D1**.

---

## 2. v0.2 — Paridade, entrega remota e Checker (D2)

**Objetivo.** Fechar os 66 invariantes com paridade 93/93 nos dois SOs e levar uma story até PR merged com
revisão de outra família.

**Valor real.** Erick para de revisar linha a linha: o Codex revisa com `review-result` estruturado, o
rework é automático até o teto, e o PR chega com evidência. É o primeiro lote autônomo real.

| | Escopo |
| :--- | :--- |
| **Must** | porte dos casos restantes com `parity-name-map.json` como **artefato de entrada** do slice; push/PR/merge + reconciliação contra remoto, incluindo `local_merge` fast-forward da branch da story na base dentro de `safe` quando a base não mudou desde o `prepare` (ff-only, ref de origem preservada em `refs/ade/`; base mudada deixa o commit na branch da story e o `report.md` imprime o comando de merge — E64); adapter `codex` + Checker de rodada (`codex exec --json --sandbox read-only --ignore-user-config --output-schema review-result`, recusando vendor igual ao do Maker — a regra Maker ≠ Checker vale por `model_id` e por vendor para **todo** papel da chamada, incluindo advisor, e `--advisor` só entra na receita quando o modelo do advisor é observável em `modelUsage`, E66) com `sources[]` obrigatório em `review-result` e `unit-result`; `rework` ≤N; detector de loop (`findings_digest` sobre `normalize`/`signature`); orçamentos (reserva, teto em USD, parede, `max_parked_units`, defaults por classe: trivial 3/1, bounded 6/2, feature 10/3, subsystem e project 12/3 [hipotese], pela fórmula `max_model_calls = 2 + 2·visual_rounds + 2·(max_rework_rounds + 1)` — com UI, `bounded` vira 8/3 e `feature` 12/3, E65; não há `max_tokens_in`/`max_tokens_out`: onde não há custo reportado o teto é `max_model_calls`, E61); gate runner com cache por árvore e **lint anti-slop por flag** (`gate:anti-slop`, Oxlint vendorizado); classes de falha fechadas |
| **Should** | Checker de portão (`claude --permission-mode plan`), gates canônicos no CLOSE, `ade decide <unit> --option retry\|skip\|discard\|pick\|accept_unproven --value <id>` (sem `operator_cancel`: na v1 Ctrl-C para o lote — lease + reconciliação — e `ade discard` trata a story depois, E62), `ade discard`, `ade show <ref> --open` |
| **Experimental** | `claude ultrareview` como portão opcional pré-merge |

**Aceite.** (1) 93/93 em Windows e Linux, incluindo o caso hoje skipado (o shim `.cmd` vira `node shim.js`).
(2) Suíte de paridade ≤6 min com 4 workers [hipotese] — 18 min em série é inutilizável no ciclo.
(3) Dois alvos normativos e separados: `parity` (zero credencial, CI Windows + Linux, `ade doctor --offline`)
e `probes` (chamadas reais, local, opt-in) — nada que exija `claude`/`codex` real entra na suíte de paridade.
(4) `no_checker_family_available` → `parked`, nunca aprovado; Checker com o mesmo `vendor` do Maker é recusado.
(5) Erro de `git push` não decide nada: o remoto é consultado antes. (6) Rede indisponível na retomada →
`awaiting_operator`, nunca retry.

**Evals.** `push_that_errors_after_landing_is_not_repeated` (o skip que some no porte);
`pr_is_adopted_only_with_exact_base_and_head`; `open_pr_after_merge_queue_is_ambiguous_not_failed`;
`ci_rerun_is_always_ambiguous_and_counted`; `checker_that_edits_the_tree_stops_the_batch_as_state_integrity`
(classe de movimento `stop`, nunca reversão e continuação — `engine-durability.md` §12/§15);
`maker_and_checker_with_same_model_id_are_refused`; `loop_signature_detects_a_b_a_oscillation` e
`same_findings_reworded_is_still_stagnation` (`findings_digest`);
`budget_reserve_blocks_start_not_middle`; `review_result_without_sources_is_refused`; fixture
`review-result/legacy-shape.json` recusado por ajv na ingestão; `parity-name-map.json` como artefato
versionado, **entregue no início do slice**, com justificativa por caso renomeado.

**Dependências.** Slice 1 verde; `gh` com fixtures por versão; repositório remoto bare de teste.

**Riscos.** Casos de paridade que mudaram de propósito (forma rica do `review-result`, `plan`) não passam
com o mesmo nome → o inventário de renomes é entregável do início do slice, não descoberta do fim.
Piso de 19,4k tokens do Codex encarece o Checker → receita de chamada curta sempre
(`--ignore-user-config --ignore-rules --ephemeral -c skills.max_context_tokens=0` + `AGENTS.md` ≤2 KB
escrito pelo engine no worktree) e diff cortado em `review.max_diff_bytes` (default 60 000 chars, por
arquivo em ordem de relevância de escopo, com ponteiro `ade show diff:<story>#<arquivo>`).

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
| **Must** | context discovery determinístico; classificação **determinística primeiro** (candidato a `trivial` = 1 arquivo tocado no discovery + verbo de correção; chamada de modelo só com confiança < 0,6 ou classe ≥ `feature`); expansão em camadas; entrevista ≤5 perguntas com recusa de pergunta respondível pelo repo e `"não sei"` → default registrado e incógnita anotada em `TaskContract.unknowns[]` (`kind ∈ {product_choice, external_fact, repo_fact}`, `resolved_by?`; a incógnita é do contrato, não do plano — E48); plano validado por ajv **só na forma**: a validação de `eval.cmd[0]` contra os `scripts` do projeto roda no `prepare` de cada story, por re-discovery no worktree (E63); `mission_budget` no `batch_open`; aprovação única que congela o conjunto elegível de skills; teto de pack verificado duas vezes (estimativa no plano, medição no `prepare`), com teto próprio de 32 000 bytes (≈8k tokens) [hipotese] na seção `contract` — estouro é `story_pack_overflow` e reabre a divisão da story (E50); faixa rápida `trivial` |
| **Should** | `ade plan <pedido> --from <missão>` (herda discovery, respostas e stories concluídas; a anterior fica `superseded`), `ade validate`, `ade approve`, `ade steer <missão> "<nota>"` (a nota vira `operator_notes` na seção `task` do pack, ≤600 bytes, mais recente primeiro, fila drenada no `prepare` da story seguinte; é contexto, não requisito — o contrato continua imutável, E53), `ade takeover`/`release` por comando impresso (+ `takeover-<story>.cmd`/`.ps1`), com `takeover.json` aberto recusando despacho: a story para em `awaiting_operator{reason:'takeover_open'}` e `ade decide --option retry` devolve a mesma parada, sem exit code novo (E42) |
| **Experimental** | pesquisa como step único com schema, disparada por incógnita declarada do tipo `external_fact` em `unknowns[]` (uma chamada, sem time) |

**Aceite.** (1) Jornada 1 ponta a ponta: **≤30 s até a primeira edição de arquivo-fonte, 0 perguntas,
≤2 chamadas** (as ≤2 incluem o classificador quando ele roda) — é eval de saída do slice, não propriedade
emergente. (2) Story sem eval por cenário, sem `do_not_touch`, sem classe ou com UI sem `DesignBrief` é
recusada pela validação; exceção única: em `trivial` com `evals: []` na aprovação o Maker preenche `evals`
uma vez (`author: 'maker'`, step `local_write` com `eval_authored_by`) e o vermelho diferido é condição de
validade — em `trivial`, `red_reason != 'assertion'` **não** rebaixa para `additive` (que exigiria `negative`
ou `mutate`, inexistentes na classe): a story para em `awaiting_operator{reason:'red_unproven'}` com o diff
pronto e `ade decide --option accept_unproven` a fecha como `complete`, com `decision` gravada, sem custo
para o caminho feliz da jornada 1 (E51). (3) Eval que nasce verde volta ao Intent
Compiler, não ao Maker. (4) Pergunta cuja resposta está no discovery é recusada com o ponteiro da evidência.
(5) Custo real do classificador medido e registrado (`--model haiku` já faturou como sonnet: US$ 0,37 para
ecoar 200 bytes, digest #26) — a regra determinística é o caminho primário, e acima do teto a chamada de
modelo simplesmente não roda.

**Evals.** `fast_lane_trivial_starts_within_30s_zero_questions` (critério de saída do slice);
`question_answerable_by_discovery_is_refused`;
`dont_know_records_default_and_registers_unknown`; `story_without_eval_per_scenario_is_refused`;
`ui_story_without_design_brief_is_refused`; `classifier_cost_is_measured_not_assumed`;
`additive_without_negative_or_mutate_is_refused_by_ajv`;
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

## 4. v0.4a e v0.4b — Skill Fabric, Frontend Quality Engine e painel (D4)

A v0.4 é **dois slices** (`architecture.md` §11 E37; ver §9, resolvida 1): **v0.4a** entrega os dois
subsistemas que produzem valor e têm eval próprio; **v0.4b** entrega a projeção, o módulo nativo e o
primeiro workspace npm. A ordem relativa não muda e a v0.4b pode escorregar para depois da v0.5 sem
bloquear nada.

**Objetivo.** Qualidade de frontend provada por portão e juiz, skills injetadas sem explodir contexto, e o
estado visível fora do JSONL.

**Valor real.** "Melhore o design dessa página" e "refaça o frontend" passam a ter resposta com nota,
evidência e screenshots lado a lado — e Erick vê a missão acontecendo.

| | Escopo v0.4a (Skill Fabric + FQE) |
| :--- | :--- |
| **Must** | catálogo curado (60–80) com sync pinado por commit, sanitização em build time, quarentena e SkillGuard (12 controles) — a v1 assume repositórios do próprio operador: `catalog.sources` vive no `.ade/config.json` do repositório, skills em `<repo>/.claude/skills/` **não** entram no pack e não são carregadas porque a chamada despachada roda sob `--safe-mode`, e "modo repositório de terceiros" (allowlist de remotos) é backlog da v0.5 com ADR próprio (E56); seleção filtro duro → BM25 top-8 → seletor ≤3, ≤7,5k tokens por skill e soma ≤20k (o filtro duro não elimina por tamanho antes do BM25); supressão do listing nativo de skills/plugins na chamada despachada, provada pelo doctor por contagem em `system/init`; FQE **D1–D6** (todos dependentes de render) + juiz multimodal de outra família pinado por `model_id`, ≤2 rodadas, corte 7,5, `self_critique` obrigatório, 1 rodada de rework reservada no `prepare` de toda story com UI; `ade catalog sync/list/inspect` |
| **Should** | `$imagegen` para asset final; screenshots lado a lado em `awaiting_operator` |
| **Experimental** | duas etapas Claude→Codex no FQE (flag, não default); braço de controle "BM25@3 puro" contra o seletor barato |

| | Escopo v0.4b (painel, projeção, workspaces) |
| :--- | :--- |
| **Must** | lançador de 2 cliques (`ade.bat` gerado por `ade init`) que sobe `ade serve` e abre o navegador na página pronta; interface com aparência de IDE, familiar (decisão de Erick, `architecture.md` §9.1; esforço adicional [hipótese]); painel somente-leitura como projeção + índice SQLite reconstruível; token aleatório por sessão do `ade serve` impresso no terminal + checagem de `Origin`; `visual-eval` promovido a **9º schema publicado** (dois consumidores); npm workspaces criados no mesmo commit que cria `packages/web`; `ade serve`, `ade index --rebuild` |
| **Should** | — |
| **Experimental** | — |

**Aceite.** v0.4a: (1) `recall@8 ≥ 0,85` e `precision@3 ≥ 0,75` nas fixtures de seleção. (2) Skill nova no
projeto exige aprovação; em lote desatendido → `awaiting_operator`; o conjunto elegível congelado na
aprovação é o que define "nova". (3) Scripts de skill de catálogo **nunca ficam disponíveis ao agente**
(só o corpo do `SKILL.md` e `references/*.md` como texto); `contain` inviolável com skill hostil no
catálogo; controle 11 (memória/config do agente) é detect-only com baseline de hashes. (4) Fixture de UI
ruim **reprova**; fixture boa **passa em 1 rodada**. v0.4b: (5) O painel não tem estado próprio: apagar o
SQLite e reconstruir do journal dá o mesmo resultado byte a byte. (6) Toda ação do painel vira step no
journal. (7) Requisição sem o token da sessão ou com `Origin` estranho é recusada.

**Evals.** `skill_selection_rank1_routing` e `skill_description_collision` (framework de
`addyosmani/agent-skills`); `hostile_skill_cannot_escape_contain`; `skill_script_is_never_exposed`;
`native_skill_listing_is_suppressed_in_dispatched_call`;
`visual_bad_fixture_must_fail` / `visual_good_fixture_passes_in_one_round`;
`judge_scores_before_seeing_diff_and_detector` (anti-ancoragem); `contrast_aa_gate_rejects_known_fixture`;
`projection_rebuild_is_byte_identical`; `panel_request_without_session_token_is_refused`.

**Dependências.** v0.3; `playwright` (biblioteca) e Impeccable 4.3.1 pinado por `ENGINE_VERSION` na v0.4a —
`ENGINE_VERSION` divergente do pin é **falha do doctor** (fail-closed), nunca aviso, e o FQE entra em modo
degradado: story com UI para em `awaiting_operator{reason:'fqe_unavailable'}`, story sem UI segue (E45);
`better-sqlite3` e `packages/web` **só na v0.4b** (é ali que o pacote único da raiz vira workspaces).

**Riscos.** Mesmo partido, é o maior bloco do roadmap. Módulo nativo (`better-sqlite3`) no Windows →
prebuild verificado no doctor antes do primeiro uso, e a v0.4b é a única parte que carrega esse risco.
Juiz caro dominando o orçamento → o teto vale para o rework, não para o juiz.

**Pronto.** Jornadas 2 e 3 executadas (v0.4a); o painel da própria ADE construído pela ADE sob o FQE
(v0.4b).

**Não faz.** Lint anti-slop (voltou para o gate runner na v0.2), PTY embutido, steering intraturno,
pesquisa em time, telemetria completa.

**Custo.** v0.4a: skill fabric 1.400 · FQE 1.300 ≈ **2.700 TS** + ~1.100 de teste, **12 dias-dev ·
~95 h-agente**. v0.4b: painel + projeção 1.200 ≈ **1.200 TS** + ~500 de teste, **5 dias-dev ·
~35 h-agente**. Total **17 dias-dev · ~130 h-agente**. Escada: **D4** ao fim da v0.4b.

---

## 5. v0.5 — Pesquisa, takeover embutido e telemetria (D5)

**Objetivo.** A missão longa fica auditável e interrompível: `agy` para pesquisa, PTY no painel, telemetria
por chamada.

**Valor real.** Erick assume o terminal no meio de uma story e devolve sem perder o ciclo; e passa a saber
para onde o dinheiro foi.

| | Escopo |
| :--- | :--- |
| **Must** | adapter `agy` (v0.x, `--dangerously-skip-permissions`) somente-leitura com canário de isolamento; pesquisa como subsistema disparada por incógnita `external_fact` (teto por classe: bounded ≤1 consulta sem time, feature+ até 3; time 2–4 opt-in, empate vira pergunta); telemetria completa por `model_call` com `cost_source`, `outcome`, `ttft_ms`, `models: { role: 'executor' \| 'advisor'; model_id }[]` no lugar do antigo `model` (E66) e `skills_injected[]` com `sha256` do conteúdo injetado e `source` (`catalog@<commit>` ou `local`) como evidência de supply chain (E59) — **sem** `compaction_events`, que saiu da telemetria porque sessão nova por chamada, turno único e pack com teto não deixam haver compactação (E67) —, e evento `scope: 'mission_summary'` no fechamento; harness doctor em coleta com as 7 categorias e `cache_read / (tokens_in + cache_read)` por papel como primeira métrica |
| **Should** | takeover com PTY embutido no painel |
| **Experimental** | ablação pareada (Caliper / `claude plugin eval`) sobre um item do harness; teste de "anexa e espera" do worker detached (a branch de I09 fica dormente na v1) |

**Aceite.** (1) O canário reprova `agy` que escreve fora do `--add-dir` (comportamento medido, digest #38) →
família fica somente-leitura. (2) Nenhuma decisão do engine depende de `pty.kill()`; encerramento por
`taskkill /T /F /PID`. (3) Achado de pesquisa entra como **dado**, nunca como instrução — teste com achado
contendo instrução embutida. (4) Telemetria fecha: soma de `pack_sections` = `pack_bytes`; `cited` medido.

**Evals.** `agy_canary_detects_write_outside_add_dir`; `research_finding_is_data_not_instruction`;
`takeover_release_resumes_from_checkpoint`; `telemetry_sections_sum_to_pack_bytes`;
`codex_cost_is_estimated_with_cost_source_flag`.

**Dependências.** v0.4a (a v0.4b só é necessária para o PTY no painel); `agy` autenticado;
`~/.ade/prices.json`.

**Riscos.** node-pty nunca teve 1.2.0 estável e o bug #967 mata PID alheio (digest #29) → gatilho de
reversão em §8. Time de pesquisa custa ~15× tokens → opt-in por config, nunca default.

**Pronto.** Jornadas 4 e 5 executadas; uma noite desatendida da própria ADE com relatório de manhã.

**Não faz.** ACP, N>1, rotinas, OTel export.

**Custo.** adapter agy + canário 250 · pesquisa 350 · PTY/takeover 450 · telemetria + doctor 400 ≈
**1.450 TS** + ~700 de teste. **9 dias-dev · ~70 h-agente.** Escada: **D5**.

---

## 6. v1 — Jornada 6 e hardening (D5 pleno)

**Objetivo.** A ADE conduz o próprio desenvolvimento por uma noite inteira e a documentação fecha.

**Valor real.** "Continue enquanto durmo" deixa de ser demo: `plan.mission_budget` gravado no `batch_open`
(defaults da jornada 6: `max_wall_clock_seconds` 8 h e `max_parked_units` 3 [hipotese]),
`continue_independent_after_block` e `ade report` de manhã com o motivo de cada parada (caminhos absolutos
por parada, abríveis com `ade show <ref> --open`).

| | Escopo |
| :--- | :--- |
| **Must** | jornada 6 desatendida em dogfood real, com as precondições duras do `ade run --unattended` (gates ativos, baseline de eval verde, rollback em `refs/ade/`, isolamento por worktree provado pelo canário); suíte de dogfood 20–50 tarefas com `runs: 3` e `pass^3` como **suíte Vitest do repositório**, não comando da v1; calibração do corte visual e dos tetos de pack pela telemetria; documentação (`docs/operations/`, `docs/security/`, `docs/evals/`) |
| **Should** | `ade eval <story>`, que roda os evals do **contrato** (dono: C9) — a suíte de dogfood não é acessível por ele |
| **Experimental** | roteamento sugerido por `~/.ade/routing.jsonl` (humano aplica) |

**Aceite.** (1) Uma noite ≥6 h sem intervenção, backlog aprovado esgotado ou parado em
`awaiting_operator` com motivo por unidade — noite com paradas sai com exit 3, nunca 0 (E47). (2) Nenhum efeito externo fora do `permitted_effects` aprovado
(que lista só efeitos externos; `model_call`, `eval_run`, `local_write`, `gate` e `prepare` são implícitos).
(3) `limits.max_pack_bytes` e `review.max_diff_bytes` ajustados por p90 medido, não por hipótese.
(4) Corte visual recalibrado pelo critério publicado: `escaped_visual_defects` > 10 % em 20 stories → 8,0;
`awaiting_operator` em trabalho aprovado à primeira vista → 7,0.

**Evals.** `unattended_night_completes_or_parks_with_reason`;
`unattended_without_preconditions_is_refused`; `wall_clock_budget_stops_batch_not_story`;
`parked_unit_cap_is_enforced`; suíte de dogfood com os 5 grupos (tradutor, jornadas, visual, estritez,
durabilidade).

**Riscos.** A ADE muda o engine embaixo da própria missão → `runtime_stamp` em três partes (só
`core_version` bloqueia com `stale_workflow_version`; `capabilities_digest` **registra** upgrade silencioso
de CLI e não bloqueia nem o `--unattended` — a divergência vai ao relatório do doctor e ao `mission_summary`,
seus dois leitores nomeados, E68/E67)
+ `ade run --accept-stale-version` (ADR 0021) é o único anteparo, e precisa de teste explícito na noite.
45 % do código gerado falha teste de segurança há 3 anos → a meta "zero revisão humana" tem exceção escrita
em três superfícies: contain/isolamento, servidor local do painel, ingestão do catálogo.

**Pronto.** Escada D5 sustentada por duas noites consecutivas; ADRs 0001–0022 fechados, exceto os que
seguem pendentes de confirmação do Erick (`architecture.md` §9: ADRs 0004, 0005, 0010, 0012 e 0013).

**Não faz.** Nada do backlog de §10.

**Custo.** ≈ **600 TS** + ~900 de teste + docs. **8 dias-dev · ~65 h-agente.**

---

## 7. Invariantes I01–I66 → slice

| Slice | Invariantes |
| :--- | :--- |
| **Slice 1** | I01–I07 (write-ahead, cadeia, fsync, lease, idempotência, `released`/`ambiguous`), I08 (moldura de reconciliação), I09 (`model_call`), I10 (`local_commit`), I16 (`gate`/`prepare` → `released`), I17, I18–I21 (checkpoint, cópia antes de descartar, `clean -fd`, árvore como identidade), I22–I26 (rename, binário, diff integral, restauração por escopo, "não mudou nada"), I27, I29, I33, I34, I48, I49, I52, I55, I56, I59, I60, I64, I65, I66, **I30, I31, I32** (branch de unidade e gate runner com cache — o ciclo do S14 já roda `gates`), **I42** (classes de falha fechadas), **I44, I45** (reserva e teto em USD sobre custo observado) |
| **v0.2** | I11–I15 (push, PR, `pull_request_merge`, `local_merge`, `ci_rerun`), I28, I35–I40, I41 e I43 (loop, `unknown` → `park`), I46, I47 (resto dos orçamentos), I50, I51, I57, I58, I61, I62, I63 |
| **v0.3** | I53 (`immutable_digest` do contrato aprovado), I54 (`spec_revision` = digest da story serializada) |
| **v0.4a–v1** | nenhum novo; I31/I32/I59 estendidos ao FQE e ao bloco de skills do pack |

Cobertura (contagem da tabela acima, conferida faixa a faixa; o "44" antigo era eco dos 44 casos de
paridade): **41 invariantes no slice 1, 23 na v0.2**, 2 na v0.3 — 66 no total. A lista desta tabela e a
lista de 44 casos de `docs/plans/slice-1.md` §4 têm de ser mantidas coerentes; o mapa invariante→teste é
`docs/specs/engine-durability.md` §19. I15 e I40 entram portados e **desligados**
(`ci.enabled: false`), com teste que prova o caminho inerte, e não contam como invariantes ativos da v0.2;
ver §9, resolvida 4.

---

## 8. Gatilhos de reversão

| Sinal medido | Reversão | Custo |
| :--- | :--- | :--- |
| `node-pty` sangrando (crash, PID alheio morto, ConPTY travado) 2× em um mês | `portable-pty` via napi-rs; se persistir, takeover volta a ser só comando impresso | ~2 dias-dev; nenhum dado perdido (o PTY é view) |
| `ade doctor` falhando uma flag entre releases >1× por trimestre | migrar a família para ACP (`transport` já está no `CapabilitySet`, `session_ref: null` já está no evento) | 1 arquivo por família; perde-se schema e id pré-cunhado |
| Operador abre o `journal.jsonl` à mão mais de uma vez por lote | antecipar o painel (é aditivo; só o índice é retrabalho) | ~1 dia-dev |
| `precision@3` < 0,75 ou `rework_rounds` p90 alto em classe `project` | ampliar o catálogo (é `git clone` + `index.json`, não código) e/ou ligar o time de pesquisa | configuração |
| Sessão nova por story perdendo para sessão longa na ablação pareada | `session_ref` já existe: modo `reconnect` por família vira flag de config | ~2 dias-dev |
| Custo do classificador barato acima do teto (digest #26) | desligar a chamada de modelo: a regra determinística já é o caminho primário | zero |
| `escaped_visual_defects` > 10 % em 20 stories | subir o corte para 8,0; `awaiting_operator` em trabalho aprovado à primeira vista → baixar para 7,0, calibrando a rubrica antes de mexer no teto de rodadas | configuração |
| Suíte de paridade >10 min no ciclo local | sharding por arquivo e `--no-threads` só nos casos de git | ~0,5 dia-dev |

---

## 9. Divergências resolvidas

Arbitradas em `architecture.md` §11 (2026-09-17). O corpo deste documento já reflete cada decisão.

1. **v0.4 empilhava Skill Fabric + FQE + painel (17 dias-dev, o maior slice).** → **aceita**,
   `architecture.md` §11 E37: v0.4 divide-se em **v0.4a** (Skill Fabric + FQE D1–D6 + juiz) e **v0.4b**
   (painel projeção + SQLite + workspaces), sem mudar a ordem relativa. §4 foi reescrito com os dois
   escopos, dois custos e o risco do módulo nativo isolado na v0.4b.
2. **A v1 não cabia em ~3 meses.** → **aceita**, E37: a v1 completa é **~15–16 semanas** a 5 dias/semana,
   e o slice 1 mede linhas portadas por dia na semana 1 para replanejar explicitamente (§0, §1 "Pronto").
   O painel não é cortado da v1; é adiado para a v0.4b.
3. **`ade eval <story>` estava na lista de comandos da v1 sem subsistema dono.** → **aceita com correção
   de escopo**, E38: `ade eval <story>` roda os evals **do contrato** e o dono é o C9 (eval runner); a
   suíte de dogfood 20–50 tarefas é **suíte Vitest do repositório**, não comando da v1, e não precisa do
   índice SQLite. Não há C23.
4. **I15 (`ci_rerun`) e I40 (merge remoto exige CI `success`) entravam no porte sem consumidor.** →
   **aceita**, E25: ambos ficam "portados desligados" (`ci.enabled: false` default) com teste do caminho
   inerte, fora da contagem de invariantes ativos da v0.2 (§7).
5. **Lint anti-slop como portão D6 do FQE.** → **rejeitada a forma anterior**, E39: o lint não depende de
   render e por isso sai do FQE e vira **gate por flag no C8** (v0.2); o FQE fica com D1–D6 todos
   dependentes de render, e o antigo "D1–D7" deste roadmap era leitura desatualizada.
6. **Faixa rápida medida já no slice 1.** → **rejeitada**, E40: o slice 1 grava só `first_source_edit_ms`
   como baseline; o portão `fast_lane_trivial_starts_within_30s_zero_questions` é critério de saída da
   v0.3 (§3).
7. **93/93 como critério do slice 1 e `parity-name-map.json` como descoberta do fim.** → **rejeitada**,
   E26: o slice 1 tem subconjunto **nomeado de 44 casos**, 93/93 é critério da v0.2 e o mapa de nomes é
   artefato de **entrada** do slice, com dois alvos normativos (`parity` sem credencial, `probes` opt-in).
8. **npm workspaces desde o slice 1.** → **rejeitada**, E29: pacote único na raiz na v1; workspaces só no
   commit que cria `packages/web`, na v0.4b (§1 e §4 "Dependências").

**Pendências** que permanecem abertas e não são decididas aqui: retenção de `refs/ade/discarded/`
(purga manual pós-v1, como a do blob em quarentena — não há comando de purga na v1, E60), defaults
numéricos de lease, pack e orçamentos (todos [hipotese], calibrados no dogfood; os de E4/E65 e
`max_parked_units` incluídos) e a confirmação dos itens de `architecture.md` §9 por Erick. Os totais de
E37 **não** são recalculados agora: a medição da semana 1 do slice 1 replaneja os números (E57).

---

## 10. Backlog pós-v1 priorizado

| # | Item | Sinal que promove |
| :-- | :--- | :--- |
| 1 | **ACP + steering no meio do turno** | RFD `session/inject` estável **ou** doctor falhando flag >1×/trimestre (§8) **ou** pedido de 4º provider |
| 2 | **N>1 com fila de merge** (o `node_modules` por worktree desceu para o `prepare` do slice 1, E49) | wall-time medido de lote `subsystem`/`project` com ≥3 stories independentes prontas e fila parada >30 % do tempo |
| 3 | **Rotinas autônomas agendadas** (sem ADR na v1: `routine_budget`, `scope_paths` de rotina e política de PR só entram quando o item subir para o roadmap, E52) | ≥3 pedidos repetidos idênticos em 30 dias no journal (dead code, cobertura, regressão visual) |
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
`docs/plan/features.json` com `passes` como único campo gravável (é o plano de construção da própria ADE;
o `passes` **saiu** do Task Contract por E1, onde o estado vive no journal), `docs/reference/` vazio — um arquivo por
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
