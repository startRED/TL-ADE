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

**Medido (2026-09-18, D1 rodada).** Missão autônoma na demo de 2026-09-17 04:54Z a 2026-09-18 13:03Z,
10 épicos, US$ 166,34; dogfood real em 27 s e US$ 0,28 (`docs/operations/dogfood-d1.md`). Velocidade do
slice, por `git log --shortstat` dos commits `ade:` (inserções + remoções, primeiro commit em 16/09):

- commit_base: 9a37c9832ce92b085f4eb9aabd6ffb64589ef01a
- linhas_alteradas: 35124
- dias: 3
- linhas_por_dia: 11708

O número é a régua para a v0.2 (Checker Codex + entrega remota): os 49 casos de paridade restantes são
porte mecânico e devem correr acima dessa média.

---

## Estado e autorização

- Slice 1: fechamento pendente ([plans/slice-1-fechamento.md](plans/slice-1-fechamento.md)).
- Recorte local v0.2: não autorizado ([plans/v02-local-proposta.md](plans/v02-local-proposta.md), [plans/v02-local-aprovacao.md](plans/v02-local-aprovacao.md)).
- Restante da v0.2: fora desta rodada.
Implementação dependente: bloqueada.
A revisão integrada, o rework limitado e a integração exclusivamente local constituem proposta pendente documentada em [plans/v02-local-proposta.md](plans/v02-local-proposta.md); a autorização documental é separada de verificações posteriores de CLI, canário, capacidade e fonte de cota. O restante da v0.2 (§2), incluindo entrega remota e paridade completa, permanece preservado conforme planejado, respeitando o teto de planejamento de §11.

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

**Emenda 2026-09-18 (revisão externa do slice, ver `docs/plans/slice-1.md` §"Emendas de 2026-09-18").**
Entram no **Must** da v0.2: (1) `unit-result` e `review-result` ganham `contract_revision`, `input_revision`
(commit/versão dos insumos), `evidence[{criterion, result_ref, input_digest}]` e `requested_action`
(`verify|rework|decide`); o motor recusa ou revalida resultado produzido para revisão de contrato ou insumo
obsoleto; o executor reporta `ready_for_verification`, nunca se aprova. (2) Custo por **entrega aceita**
(tentativas + revisão + rework + intervenção) como métrica do `report.md`, a partir dos tokens reportados
(S19), não preço teórico. (3) Toda regra cara do harness (segundo planejador, crítica de plano, rodadas de
revisão) tem no `ade-config` a justificativa e a condição de revisão; regra que não encontra defeito em N
missões é candidata a sair (Managed Agents: proteção de um modelo vira peso morto no seguinte).
(4) **Crítica do plano pelo Checker antes de qualquer código**, uma rodada de correção pelo Planner: provada
na demo (`proto/`) na missão de 18/09 — 12 de 13 planos vieram com 1–11 achados, ~US$ 1,15 por correção,
e os achados eram exatamente os que fariam o Maker decidir sozinho (valor sem origem, critério sem eval,
arquivo fora do escopo). Entra como passo fixo do `prepare`, com `plan_critic` gravado no journal. (5) O
Planner **sub-especifica de propósito** o como: EARS e evals fixam comportamento observável; detalhe de
implementação só entra no contrato quando é decisão de arquitetura citada (ADR ou `decisions`) — sobre-
especificação cedo cascateia em erro a jusante e o Checker recusa contrato que dita implementação sem
citar decisão. (6) **Formato único de handoff** para `unit-result`/`review-result`: seções fixas em ordem
estável (cache), `claims[]` separados de `evidence[]` e todo claim aponta para `eval_run` ou artifact (claim
sem evidência é recusado pelo schema — `sources[]` já existe, vira obrigatório por claim), `unknowns[]`,
`questions_for_owner[]` só com opções fechadas, `deltas` (o que mudou desde o último handoff) em vez de
descrição, `next_action` com um verbo, prosa livre só em `notes` com teto de 500 bytes. (7) Lint de
invariante com **mensagem que ensina a corrigir**: cada regra do `gate:anti-slop` e dos testes estruturais
de fronteira imprime a correção esperada no erro (o agente lê o erro, não o manual), e o pack não repete o
que o lint já diz. (8) **GC de docs como rotina só-PR** (promovida do backlog #10.3 porque aqui o falso
positivo custa um PR fechado, nunca um merge): `ade gc --docs` varre `docs/**` por caminho citado que não
existe, ADR referenciado que foi emendado e story concluída sem eval verde no journal, e abre PR pequeno;
cada doc de `docs/` ganha front-matter `verified: <commit>`, e `ade doctor --docs` lista os `stale` (doc
cujo `verified` é anterior à última mudança dos caminhos que ele cita). É a resposta ao README que dizia
"Nenhum código ainda" com o motor já escrito.

**Emenda 2026-09-18 (terceira revisão externa: Scrapling, Dify, OpenSEO, OpenShorts, Presenton).** Entram na
v0.2: (9) **Preflight por story**, determinístico e sem modelo, antes da primeira chamada paga: teste-alvo
existe, gerenciador de pacotes e dependências presentes, build relevante passa, worktree limpo, insumo
válido, credencial necessária declarada, disco e dependência externa alcançável; falha para a story em
`awaiting_operator{reason:'preflight'}` com a lista e o número de chamadas caras evitadas no journal. É
diferente do `ade doctor` (a máquina funciona?) — pergunta se **esta** story está pronta. (10) `evidence`
em `review-result.action_items[]` deixa de ser texto livre e vira `evidence_refs[]` tipado
(`eval:`, `gate:`, `artifact:`, `source:`, `file:<caminho>#L<a>-L<b>`, `trace:`); prosa só em `notes`
(≤500 bytes). Junto com `claims[] → evidence_refs[]` do item (6), fecha o princípio: prosa explica, nunca
prova. (11) **Verification Plan** derivado (o "sprint contract" de `architecture.md` A14 vira isto e não
ganha outro nome): a partir do Task Contract e do estado do repositório, o Checker assina *como* cada
critério será provado (`AC1 → teste X`, `AC2 → cenário de browser Y`, `AC3 → validação de schema`) antes do
`implement`; muda o como, nunca o que significa sucesso — o contrato continua a única verdade, o plano de
verificação é artefato do journal. (12) **Mudança de plano de controle é classe própria**: diff que toca
`AGENTS*`, skills, `schemas/`, gates, framework de evals, configuração de adapter, roteamento de modelo,
CI, `contain` ou journal muda como todas as mudanças futuras serão julgadas → sem merge automático, revisão
reforçada obrigatória, gravado como `control_plane_change` no journal. (13) **Criticidade por passo**:
todo passo declara `required | enhancement`; `required` falho para ou estaciona a story, `enhancement`
falho degrada com evidência gravada e segue (hoje isso existe caso a caso — vira regra do motor). (14)
**Projeção documental**: `docs/generated/` (`current-status.md`, `capabilities.md`, `architecture-map.md`,
`quality-report.md`) é gerado por `ade docs sync` a partir de journal, evals e schemas, nunca editado à mão;
o README aponta para lá. Junto com o item (8), impede a classe de erro "lembrar de atualizar 14 lugares".

**Emenda 2026-09-18 (cota, medida na missão real).** O limite que trava o operador não é dólar: é a cota de
cada assinatura (Claude 20×, Codex 5×, Google AI Pro), e nela **cache não desconta** em Codex e Gemini. Na
missão de 9 épicos: Flash 284M tokens de cota em 148 chamadas (1,9M por rodada de implementação e 2M por
fase de prova — o agente relê o contexto a cada turno), Sonnet 120M, Terra 26M em 159 revisões (150k por
revisão, o revisor explora o repositório); 91 % do prompt repete entre rodadas; 58 % das revisões pedem
mudança (3,3 revisões por story); prova e implementação do mesmo modelo custam o mesmo. Entram na v0.2:
(15) **Cota é orçamento de primeira classe**: o journal grava por chamada `quota_tokens = tokens_in +
cache_read + tokens_out` por família, `ade report --quota` soma por família/papel/dia e por janela (5 h e
semana), e `mission_budget` aceita teto de cota por família além do teto em dólar; o scheduler pausa por
`quota` (já existe na demo) e, com outra família habilitada para o papel, **troca de família em vez de
esperar** (Sonnet ↔ Flash para escrever, Terra ↔ Opus para revisar). (16) **Turnos são o multiplicador**:
cada fase declara teto de turnos (prova ≤14, implementação ≤30, correção ≤20, revisão ≤10 leituras) e o
prompt diz o que a fase NÃO faz (prova não implementa nem roda a suíte; revisor julga pelo diff e não explora;
ninguém roda prova lenta de integração — o harness roda) — turno gasto relendo contexto é a maior fatia da
cota do Flash. (17) **Uma chamada quando o modelo faz as duas fases**: se a família do Maker já entrega
prova e implementação juntas (Flash faz isso em >50 % das partes), a fase de prova vira **validação pelo
harness** (o vermelho é conferido revertendo só a implementação no worktree, `git stash` seletivo por
arquivo de prova), não segunda chamada — poupa uma chamada inteira por story sem abrir mão do vermelho.
(18) **Convergência em ≤2 rodadas é meta medida**: `review_rounds_per_story` no relatório, com alvo ≤2 e
alarme em ≥4; achado `low` nunca gera rodada (o Checker registra e aprova — regra já escrita, agora eval:
`low_only_review_is_an_approve`); achado repetido com a mesma citação de contrato pelo Maker é retirado na
rodada seguinte ou o Checker é trocado de família. (19) **Prefixo estável para cache** em todas as famílias
que o oferecem: seções fixas do pack (`contract`, `policy`, skills) antes das variáveis (`story`, diff,
achados), byte a byte iguais entre rodadas — a demo já mede `cache_read` de 383k por rodada no Flash e quase
zero `tokens_in` novo no Sonnet; a regra vira `SECTION_ORDER` do slice 1 (S16) e teste de igualdade de
prefixo entre rodadas. (20) **Saída curta é contrato** (Ponytail/Caveman como regra de motor, não estilo):
Maker termina com ≤3 linhas, Checker com `problem` ≤220 chars e `summary` ≤400, plano sem prosa fora dos
campos; tokens de saída são a menor fatia, mas diff menor = revisão menor = menos rodadas.
(21) **Custo de abertura por chamada** é medido, não suposto: sessão nova de CLI custa 8k–62k tokens antes
do primeiro input (metadados de ferramentas, skills embutidas, memória, `CLAUDE.md`); o motor abre centenas
de sessões por missão, então `ade doctor` mede os tokens do turno 0 por família e a **receita de chamada
curta** vale para as três CLIs, não só para o Codex: Claude com settings efêmeros por chamada (sem memória
automática, sem tarefas de fundo, sem skills embutidas, saída de bash limitada, thinking só onde o papel
pede — chaves `disableBundledSkills`, `bashMaxOutputLength`, `auto_memory`, `disable_background_tasks`
[verificar nomes na versão pinada]), Gemini com `--print-timeout` e sem extensões, Codex com
`--ignore-user-config --ignore-rules skills.max_context_tokens=0`; meta ≤3k tokens de abertura [hipotese].
(22) **Contexto longo degrada qualidade, não só custo** (medido pelos criadores: recuperação 92 % em 256k →
78 % em 1M; profundidade de raciocínio −67 % e edição-sem-leitura de 6 % → 34 % em sessão longa): além do
teto de turnos (item 16), cada chamada tem **teto de contexto** (120k tokens [hipotese]) — acima dele a
chamada é encerrada, o resultado parcial vira handoff e a rodada reabre em sessão nova. Invariante escrito:
**rodada nova = sessão nova**; histórico sujo (tentativa falha, resposta truncada por limite, erro de
ferramenta) nunca é reenviado — só o handoff estruturado (diff, achados, resposta do Maker) atravessa
rodadas. É o `rewind` dos criadores como regra de motor. (23) **Saída de prova filtrada dentro da sessão de
quem escreve**: o Maker que roda a suíte recebe a saída inteira no próprio contexto (a matriz de queda
custou uma chamada inteira do Flash); `ade test --brief` (reporter só-falhas + tail) é o único comando de
prova que o pack ensina, e onde a CLI tem hook pós-ferramenta o motor instala o filtro (só falhas, nunca
os verdes). (24) **Modo conselheiro antes de escalar**: quando o executor barato falha duas rodadas, em vez
de passar a escrita inteira ao modelo forte (escada: Sonnet → Opus, US$ 0,60–1,10 por rodada), o modelo
forte recebe diff + provas vermelhas + achados e devolve **só o diagnóstico e o plano de correção** (≤400
tokens de saída, sem editar); o executor barato aplica. Medido contra a escada em 10 partes de correção
(custo, rodadas até verde, defeitos escapados) — é o `/advisor` dos criadores e o item 4d do backlog em
forma testável; vira default só se vencer. (25) **Esforço é dial por papel, medido por modelo novo**: os
criadores mediram Fable `low` empatando com Opus 4.8 `max` a 1/6 do custo, Astra `high` ≈ `max` a metade,
`light` −80 %; então `effort` nunca é default herdado: cada (papel, modelo) tem esforço escolhido por
ablação de 5 stories (plano: achados da crítica e convergência das stories; escrita: rodadas até verde;
revisão: achados válidos/inválidos) e registrado em `roles.<papel>.effort` com a data e o número. Primeiro
experimento: plano de épico em Opus `high` × Fable `medium` × Astra `medium`.

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

**Emenda 2026-09-18 (revisão externa do slice).** Entram no escopo da v0.3, junto com o Intent Compiler:
(1) **caminhos por risco**, independentes da classe de complexidade: `risk ∈ {light, normal, critical}` no
Task Contract, com três configurações do mesmo motor (light: contrato mínimo, execução, portões pertinentes,
revisão por amostragem; normal: plano curto, testes, revisão focada; critical: análise de risco, evidência
independente, teste de falha e recuperação, autorização para efeito sensível) — uma linha em autorização é
`critical` mesmo sendo `trivial`. (2) **Planejamento progressivo** em três níveis: direção (objetivos e
limites), próxima entrega (recorte funcional com critério de sucesso) e trabalho disponível (contratos
executáveis); o resto fica como intenção, não como stories prematuras. (3) O briefing inicial separa o que o
sistema descobre no projeto, o que pesquisa fora (com fonte e data) e o que é decisão de produto (hipótese
reversível ou pergunta ao operador). (4) Painel/`ade status` mostra critérios verificados de N, incógnitas
críticas abertas, bloqueio e próxima ação, nunca porcentagem de tempo. (5) Verificadores por domínio com o
mesmo núcleo (relatório: rastreabilidade das afirmações; documento: inspeção da renderização; design:
briefing e acessibilidade), e dependência humana explícita quando a etapa é fabricação, inspeção ou decisão
profissional. Para isso o Task Contract troca duas abstrações, sem mudar o motor: `worktree` vira
`workspace` (git para código; pasta versionada com snapshot por rodada para docs, design e mídia) e `eval`
vira uma de três classes — `script` (determinístico, exit code), `judge` (rubrica com limiar duro, few-shot,
outra família, multimodal quando preciso; é o que o FQE já faz) ou `decide` (humano, com opções fechadas e
prazo) — de modo que um roteiro, uma thumbnail e um módulo passam pela mesma máquina. Nome das abstrações
quando isso for código: `GitPort` vira uma implementação de `WorkspacePort` (git, sistema de arquivos,
documento, design, remoto) e `eval` vira `Verifier` com classes `script | schema | judge | human | external`.

**Emenda 2026-09-18 (terceira revisão externa).** Entram na v0.3: (6) **Cache de artefatos certificados,
endereçado por conteúdo** (Presenton/Scrapling/OpenShorts: pague para entender uma vez, consuma a
representação depois): chave = `producer + producer_version + input_digest + config_digest + schema_version
(+ model_id quando o produtor é modelo)`, guardado em `.ade/cache/artifacts/<producer>/<chave>.json`, com
`raw_ref` para o bruto; pesquisa, análise visual, classificação de diff grande e mapa de dependências são os
primeiros produtores; entrada com mesma chave = zero chamada nova, e o journal grava `cache_hit` com a chave.
Não é cache de prompt: é trabalho cognitivo concluído. (7) **IR do repositório** como primeiro artefato
certificado por commit (`repo-ir-<digest>.json`: módulos, símbolos, donos, dependências, contratos,
testes por módulo, pontos de entrada), produzido por análise determinística sempre que der e por modelo
barato só no que não é dedutível; Planner, Maker e Checker recebem a **fatia** relevante do IR, não os
arquivos, e `ade show repo:symbol:<nome>` faz o drill-down. O batedor + `codeMap` da demo (`proto/`) é o
protótipo disso e já reduziu o custo do plano por épico. (8) **Amostradores de contexto** no compilador do
pack, um por tipo de insumo, sempre com `raw_ref` (nunca destruir a evidência): log → clusters de erro +
head/tail + anomalias; diff grande → interfaces + hotspots + arquivos de risco; documentação → seções
relevantes; CI → falhas + vizinhança causal; histórico → decisões e deltas; vídeo/imagem → quadros ou
regiões representativas (OpenShorts decide layout com 12 quadros a 1024 px, não com o vídeo). Regra: não
mandar o objeto inteiro quando uma representação menor preserva a informação daquela decisão, e medir
isso com `cited`. Todo insumo externo é convertido a Markdown/texto por ferramenta determinística antes do
pack (criadores mediram: HTML → Markdown −90 % de tokens, PDF → Markdown −65–70 %), com `raw_ref` para o
original. (9) **Roteador de revisão por risco**, determinístico, a partir do diff: auth/segredos/
rede → segurança; migração/schema/persistência → integridade de dados; cobrança/provedor pago →
econômico; UI → FQE/a11y; motor/concorrência → durabilidade; plano de controle → item (12) da v0.2; nada
disso → só o Checker geral. Story comum custa um Checker; mudança crítica roda os eixos em paralelo, e os achados dos eixos passam
por deduplicação determinística (`findings_digest` por arquivo+linha+classe) antes de virar rodada — um
caso medido pelos criadores: 4 revisores paralelos, 45 achados brutos, 24 depois da deduplicação.
Contraditório (outro agente verifica o achado: `apply | apply_modified | reject`) só para achados P0/P1 ou
contestados pelo Maker, nunca para todo comentário. (10) **Dono por escopo** (Dify: `AGENTS.md`
hierárquico, sem copiar a hierarquia): tabela `scope → docs/reference/<dono>.md` (`src/journal/**` →
`journal.md`, `src/adapters/**` → `adapters.md`…) que o compilador do pack usa para injetar só as regras
dos caminhos tocados; o `AGENTS.md` raiz continua ≤8 KB e vira índice. (11) **Gravar e reproduzir** chamadas
externas caras (Scrapling `development_mode`): primeira execução real vira fixture certificada; as rodadas
seguintes reproduzem; o portão final da story, quando o contrato exige integração real, chama de novo — a
CLI falsa e o gravador de transcript do slice 1 são o caso particular disto para `claude`/`codex`.

**Emenda 2026-09-18 (quarta revisão externa: Aider, Graphify, ast-grep, BMAD TEA, interview-me,
spec-driven-development, SWE-agent).** Entram na v0.3: (12) **O IR do repositório (item 7) ganha
ranqueamento sob orçamento** (Aider `repomap.py`: Tree-sitter → definições/referências → grafo → PageRank →
o maior mapa que cabe em `max_map_tokens`): a fatia entregue ao Planner/Maker/Checker é escolhida por
`relevância à task × importância estrutural × proximidade do escopo tocado × relevância de risco` até um
orçamento explícito em tokens (`ade code context <story> --budget 1800` devolve símbolos, relações, testes e
contratos com `estimated_tokens` e `revision`), nunca "arquivos relevantes" sem teto. Todo registro do IR
carrega proveniência em três classes que **nunca se misturam** (Graphify `EXTRACTED | INFERRED |
AMBIGUOUS`): `fact` (fonte determinística), `inference` (modelo, com `confidence` e `evidence_refs[]`) e
`operator_decision`; a mesma regra vale para o plano de conhecimento da v0.4. O grafo é **roteador, não
oráculo**: reflexão, import dinâmico, convenção de framework, string, código gerado, SQL montado e wiring de
runtime não resolvem por AST — quando o IR não resolve, o motor cai para `ast-grep`/`rg`/leitura com
`raw_ref`, e `rg` nunca é substituído pelo grafo. A interface (`ade code search-symbol | refs | imports |
structural-search | path`) é da ADE; Tree-sitter, ast-grep, rg e git são backends substituíveis.
(13) **Perfil de risco objetivo** no Task Contract, complementando `risk ∈ {light, normal, critical}` do
item (1) e o roteador do item (9): `risk.surfaces[]` ∈ {`auth`, `secrets`, `money`, `billing`,
`personal_data`, `migration`, `data_loss`, `public_api`, `external_effect`, `concurrency`, `durability`,
`security_boundary`, `supply_chain`, `agent_control_plane`} com `evidence[]` (`repo:path:…`, `requirement:R3`),
**sem probabilidade × impacto** (BMAD TEA avisa que o 1–9 é ilustrativo; número subjetivo multiplicado não
vira objetividade). Cada superfície tem política: `auth` → revisão de segurança + eval negativo de
autenticação; `billing` → integridade econômica + eval de idempotência; `migration` → prova de rollback +
portão de compatibilidade. **Runtime só escala risco, nunca reduz em silêncio**: diff que toca superfície não
prevista grava `risk_escalated{from, to, because}` e o scheduler acrescenta os portões e revisores da nova
classe — o Checker escolhido no plano é reconsiderado depois do `implement`. O campo `risk` entra no
`task-contract.schema.json` na **primeira story de schema da v0.3** (é a única emenda de forma que vale
antecipar: adicioná-lo depois migra todos os consumidores); o slice 1 não toca schema. (14) **Resumo de
suposições como projeção da aprovação** (addyosmani "assumptions I'm making", sem arquivo novo): derivado de
`unknowns[]`, `decision{default_assumed}` e `research_refs[]`, o `ade approve` imprime `✓ descoberto no repo
| ≈ default assumido | ? precisa do operador` por item; e a pergunta ao operador, só para `product_choice`
que muda o contrato, sai no formato `interview-me` reduzido — **uma por vez**, com `HIPÓTESE ATUAL`, `POR
QUÊ` (evidência) e `CONSEQUÊNCIA` de cada opção. Não entram: confiança mínima de 95 %, mínimo de perguntas,
aprovação por fase — o teto de 5 e a recusa por discovery continuam. (15) **Rastreabilidade derivada**, não
matriz mantida à mão (TEA `AC → test`): `ade report --trace` deriva `R1 → S1 → E1 … R3 → S3 → ausente` do
contrato e do journal, e requisito de superfície de risco sem eval verde é `parked`, nunca aprovado. (16)
**Ferramentas limitadas para o modelo** (SWE-agent ACI; o Tool Output Firewall passa a ser o segundo de três
níveis — PREVENIR: a ferramenta só produz o que cabe; FILTRAR: firewall; DESCER: `raw_ref`): `ade code
search | read | symbol | refs | path` e `ade artifact show` devolvem sempre `{summary, items[], next_cursor,
raw_ref}`, e `cat` de arquivo inteiro dentro do contexto deixa de existir como caminho normal. (17) **Fatia
de contexto por domínio** (BMAD `compile-epic-context`: 800–1500 tokens, sem copiar documento inteiro, sem
detalhe de story, sem nada que o código já responde): artefato certificado `context/domain-<nome>@<digest>`
derivado de Task Contract + IR + plano de conhecimento com `objetivo, garantias atuais, interfaces,
restrições, decisões, riscos`, reaproveitado por todas as stories do domínio via o cache do item (6); nunca
fonte de verdade, sempre regenerável. (18) **Schema universal de artefato** para tudo que o cache do item (6)
guarda (IR, pesquisa, fatia de contexto, análise visual, relatório de contrato, saída de teste, screenshot,
render de documento, sonda de rede): `{ref, kind, digest, producer, producer_version, input_digest,
created_at, provenance[], confidence ∈ {deterministic, model, operator}}` — é a ponte entre motor e evidência
e entra como schema publicado só quando houver dois consumidores (mesma regra do `visual-eval`).
(19) **Matriz de capacidades por papel, em código** (a boa ideia de "modo" do Roo/Cline sem persona): Maker
lê e escreve no workspace, sem rede; Checker lê, não escreve; Research tem rede e leitura mínima; Judge só
provedor e evidência; `git commit`, PR, merge e efeito externo são **sempre do motor** — o `contain` do
slice 1 é a primeira linha dessa tabela.

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

**Emenda 2026-09-18 (terceira revisão externa).** Entram na v0.4a/b: (1) **Plano de conhecimento do
projeto** (OpenSEO Project Memory, sem ser "memória automática do modelo"): `docs/knowledge/{project,
domains,known-noise}/` com itens explícitos, verificáveis e com proveniência — `id`, `scope`, `kind`
(`product_constraint | decision | preference | external_fact | invariant | learning`), `claim`, `source`
(`operator:decision:<id>` | `research:artifact:<ref>` | `mission:<id>`), `verified_at`, `expires_at`,
`confidence`; fato externo sempre com validade. **Não** guarda o que o repositório já responde (conteúdo de
arquivo, exports atuais, versão do `package.json`, estado da branch): isso é do IR do repositório; o plano
guarda intenção, decisões, restrições, preferências, aprendizados, fatos externos e invariantes não
dedutíveis. A IA seguinte recebe `K0192 + claim + proveniência + validade`, não "o Planner disse que…".
(2) **Roteador de aprendizado**: depois de cada missão, cada falha/achado/fricção é classificado
mecanicamente e o modelo só sugere; o mecanismo de promoção decide (OpenSEO: achado de revisão é evidência,
não regra) — bug único → correção + teste de regressão; regra determinística recorrente → gate/lint/teste;
conhecimento condicional → `docs/reference/<cicatriz>.md`; fricção pequena reproduzível → *papercut* (só
se outra pessoa encontraria E o próprio repositório consegue corrigir); ruído conhecido → registro de ruído;
decisão de arquitetura → ADR; fato externo ou preferência → plano de conhecimento; hipótese → experimento,
nunca regra. (3) **Registro de ruído conhecido** com condição de reativação: `fingerprint`, assinatura
normalizada, `classification: known_noise`, evidência, `reactivate_when` (`frequency_growth > 3x`,
`runtime_version changes`), `expires_at` — a IA não investiga a mesma coisa pela décima vez, e o problema
também não fica mudo para sempre. (4) **Review brief** como projeção do `ade report --review`, sem chamada
nova quando derivável: o que mudou, antes/depois, o código que importa, risco, o que NÃO mudou, decisões
discutíveis, estado das provas e "como provar em 2 minutos" — é a interface final da decisão humana. (5)
Skill tem exatamente **uma fonte canônica** (`.agents/skills/<nome>`); `.claude/skills`, `.codex/…` são
projeções efêmeras geradas pela ADE, nunca fontes; sem symlink (Windows e as três CLIs divergem).

**Emenda 2026-09-18 (quarta revisão externa).** Entram na v0.4a: (6) **`DesignBrief` ganha caráter**
(taste-skill: `DESIGN_VARIANCE`, `MOTION_INTENSITY`, `VISUAL_DENSITY`, 1–10): `character{variance, motion,
density}` mais `audience`, `references[]`, `preserved_patterns[]`, `avoid_patterns[]` e `direction{name,
signature, self_critique}`. **Sem baseline fixa** (o `8/6/4` do skill viraria o viés estético da ADE): os
três valores são inferidos de produto, público, marca, UI existente, referências e `surface_mode`, e o brief
registra de onde cada um veio. (7) **Recuperação local de design** (UI/UX Pro Max: catálogos de tipo de
produto, estilo, paleta, tipografia, padrão de landing e regra de UX com BM25 local, zero chamada): entra
como **candidatos** (`Top-K` de tokens, padrões e tipografia) para o Maker/juiz decidirem no contexto, nunca
como gerador ("fintech → paleta #1234 → pronto" é outro template de slop). É experimento com A/B obrigatório
antes de virar default: 20–30 tasks de UI em três braços (FQE atual · FQE + retrieval · FQE + retrieval +
caráter), medindo nota do juiz, rodadas de rework, preferência humana, tokens, wall-time e regressão de
acessibilidade; "BM25 altamente preciso" é afirmação do README do projeto, não prova para o nosso caso.
(8) **Verificador de contrato de API** como classe de `Verifier` opcional (`kind: api_contract`; backend
Specmatic ou a ferramenta que o projeto já usa, nunca `npx specmatic-mcp` automático — cadeia de suprimento
controlada): habilitado só quando o discovery acha `openapi.yaml`/AsyncAPI/GraphQL/gRPC; requisito
`"consumidores antigos continuam compatíveis"` ganha `proof: backward_compatibility` que o portão executa;
projeto sem API pública paga zero. Generaliza a família: `Verifier ∈ {script, test, schema, api_contract,
static_analysis, browser, visual_judge, model_judge, human_decision}`, o mesmo motor para documento
(`schema + render + human`), frontend (`browser + visual_judge`), API (`api_contract + test`) e rede (`probe +
config_check + human_cutover`).

**Emenda 2026-09-18 (Nutlope `hallmark` e `inspo`, ambos MIT).** Entram na v0.4a como forma da skill de
frontend e do retrieval de design — método, não identidade visual: (9) **Skill de frontend no formato
`SKILL.md` + `references/*.md` sob demanda** (hallmark: `SKILL.md` de 558 linhas com frontmatter
`description` como gatilho de roteamento; `references/slop-test.md`, `anti-patterns.md`,
`macrostructures/`, `themes/`, `components/`, `verbs/audit|redesign|study`): a skill fabric carrega o
`SKILL.md` pelo tipo de tarefa e o Maker puxa referência só quando a decisão pede — é o item (6) do cache
aplicado a skills. (10) **Camada barata do FQE antes do juiz visual**: o *slop-test* de 58 portas binárias
(cada resposta tem de ser "não") e a **pré-crítica em 6 eixos** (Philosophy/Hierarchy/Execution/
Specificity/Restraint/Variety, nota 1–5, carimbada no próprio artefato como `/* pre-emit critique */`) viram
`Verifier` determinístico + auto-juízo do Maker, com o catálogo `anti-patterns.md` como **vocabulário
nomeado de motivos de reprovação** do juiz visual (não "reprovado": "qual *tell*"); o `hero cabe em
1280×800/100svh` e `80–160 px entre seções` do inspo (`heroGuidance`/`spacingGuidance`) entram como portas
objetivas. (11) **Pre-flight do repositório antes de perguntar** (hallmark `Step 0`: lê `package.json`,
`tailwind.config`, CSS, fontes, paleta, libs de motion, com cache em JSON) — é a regra do discovery do
Intent Compiler aplicada a design: o `DesignBrief` infere `preserved_patterns[]` e tokens existentes do
repo, nunca do operador. (12) **Forma do retrieval local de design = `recommend()`/`compare()` do inspo**:
uma chamada devolve macroestrutura escolhida, N exemplares, ≤3 componentes de referência, paleta sugerida,
um `evidence` packet e as duas guidances fixas; a saída por candidato usa o **contrato `DESIGN.md`**
(paleta semântica, fontes reais, *type ramp*, escala de espaçamento, CSS vars) — é o que alimenta
`character{variance, motion, density}` do item (6). Servido localmente sobre catálogo próprio; **sem
crawler de terceiros, sem CDN externa, sem MCP público hospedado** (o inspo tem 832 sites capturados por
Playwright e embeddings Together AI — infraestrutura de produto deles, não da ADE). (13) **MCPs automáticos
por tipo de tarefa**, simétricos às skills automáticas: a capability matrix do item (19) da v0.3 ganha a
coluna `mcp[]` por papel (Maker de frontend recebe o servidor de design local no perfil `lite` — 9
ferramentas, `images: thumbs`, `maxTokens` sob o orçamento do Task Contract; Checker não recebe nenhum),
o motor sobe e derruba o servidor por chamada e grava `mcp_manifest` no journal (ferramentas expostas +
digest), exatamente como `pack_manifest`. É o "skills automáticas + MCPs automáticos" pedido pelo operador;
entra depois da skill fabric porque depende dela para o roteamento. **Não copiar**: os 21 temas e as
macroestruturas nomeadas do hallmark (curadoria de gosto de uma marca), a regra "nunca Inter/Roboto" como
universal (colide com marcas que as exigem), e a galeria/worker/Blob do inspo. (14) **Registro de skills de
UI como fonte da skill fabric** (ibelick `ui-skills`, MIT: registro curado de skills de *design engineering*
em 19 categorias — `accessibility`, `motion`, `typography`, `color`, `performance`, `testing`… — com CLI
`npx ui-skills get <skill>` e MCP `https://www.ui-skills.com/mcp` expondo só `list_skills` e `get_skill`; a
`ui-skills-root` roteia "pelo tópico, stack e intenção ao menor conjunto útil de skills"): a skill fabric
ganha um **catálogo externo versionado** de onde puxa skills por tipo de tarefa (`fixing-accessibility`,
`fixing-motion-performance`, `fixing-metadata`, `baseline-ui`, `create-design-md`, `animation-systems`,
`web-design-guidelines`, `frontend-ui-engineering`, `agent-browser`), **vendorizadas** no cache do item (6)
com digest e licença — nunca buscadas em tempo de missão (o MCP remoto é fonte de importação do operador,
não ferramenta do Maker; a cadeia de suprimento continua controlada). `create-design-md` é o mesmo contrato
`DESIGN.md` do item (12) e `baseline-ui` (deslop de espaçamento, hierarquia, tipografia) é o primeiro
`Verifier` barato do item (10). A regra de roteamento do `ui-skills-root` é o que a skill fabric implementa
por dentro — a partir do Task Contract, não de pergunta ao usuário.

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
(5) **Emenda 2026-09-18 — poda do harness por evidência**: seção do pack, skill injetada ou regra com
`cited < 20 %` em 20 stories consecutivas sai do default (fica opt-in por config, com o número no journal);
a cada modelo novo adotado numa família, cadência fixa de ablação pareada — 5 stories com e sem cada
seção do pack e cada portão de revisão — antes de o modelo virar default; componente sem efeito medido é
removido, não mantido por precaução (a própria Anthropic retirou o construto de sprint quando o modelo
seguinte deixou de precisar dele). (6) **Drenagem** do processo longo (`ade serve`, worker destacado):
`RUNNING → DRAINING` (não reivindica trabalho novo, faz checkpoint do atual) `→ STOPPED`, disparado por
atualização da ADE, desligamento da máquina ou reinício do painel — sobre o lease + heartbeat + reconciler
que já existem (OpenShorts faz isso no deploy).

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
| 4b | **Controle de pressão por provedor** (`ProviderRateController` determinístico: obedece `Retry-After`, reduz concorrência e recupera gradualmente; nunca decisão de modelo) | só quando N>1 entrar |
| 4c | **Mapa semântico de domínio** sobre o IR (Understand-Anything: camada opcional `estrutura técnica → domínio de negócio`, fingerprint incremental — mudou 3 arquivos, reanalisa 3 — como artefato certificado, nunca 5–7 agentes relendo o projeto por missão) | repositório alvo com >200k linhas **ou** plano por épico citando <60 % dos módulos tocados |
| 4e | **Gateway local multi-provedor** (OmniRoute: API OpenAI-compatível em `localhost`, 19 estratégias, circuit breaker, quotas por conta) como *backend opcional* de família atrás do adaptador CLI — nunca com OAuth de assinatura (Claude/ChatGPT) fora da CLI oficial, nunca comprimindo prompt no meio (quebra JSON-schema e prefixo de cache) | só se uma família paga por token entrar e o item 15 da v0.2 (troca de família) não bastar |
| 4d | **Arquiteto/editor em dois passos** (Aider `architect_coder`: reasoner forte esboça, editor barato aplica) — o **modo conselheiro** do item (24) da v0.2 é a forma mínima disto (forte só diagnostica na correção) e roda primeiro | só como A/B contra Maker forte direto em `feature`/`subsystem` — tokens, tempo, rework, defeitos escapados, CI de primeira; vira default só se vencer |
| 5 | **4º provider (OpenCode)** | necessidade de modelo fora das 3 famílias **e** aceitação explícita de chave de API (hoje é princípio) |
| 6 | **OTel export** | `gen_ai.*` sair de status Development com tipo de token de cache **ou** Erick querer dashboard fora do painel |
| 7 | **Memória por usuário** | `ade report` mostrando a mesma preferência re-perguntada ≥3× em missões diferentes |
| 8 | **CI loop (`ci_query`/`ci_rerun` ativos)** | repositório alvo com CI que a ADE não controla e ≥1 merge bloqueado por CI por semana |
| 9 | **Tauri (painel como app)** | painel usado diariamente por ≥1 mês e `ade serve` virando fricção |
| 10 | **Graft** | consulta de contexto recuperado passando de 6k tokens com `rg` em repositório real |
| 11 | **Plugin `dmmulroy/anti-slop` do oxlint, pinado por SHA** (o portão 2 de `slice-1.md` §6 entrou só com regras padrão) | ≥3 achados do Checker num mês que uma regra do plugin teria barrado |

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

**Teto de planejamento (emenda 2026-09-18).** Duas revisões externas independentes apontaram o mesmo risco:
33 KB de visão, 22 ADRs e emendas E1–E69 antes de o slice 1 fechar é o padrão que o projeto criticou no
BMAD, em escala maior. Regra: **nenhuma emenda nova em `architecture.md` e nenhum ADR novo de arquitetura
até o slice 1 fechar** (§7 do plano do slice); o que surgir vai para `docs/roadmap.md` como escopo de
versão ou para `docs/reference/` como cicatriz, e todo ADR pendente é tratado como **hipótese com métrica**
(o que mede, qual número o confirma, em quantas stories) e não como decisão a arbitrar em texto. Harness bom
se descobre rodando e removendo, não deduzindo — o journal por chamada da demo achou em uma noite (escada
cara, alarme falso de commit, prova verde sem código) o que nenhuma emenda previu. Quando o slice 1 fechar,
a primeira story de documentação consolida `architecture.md`: as emendas E1–E69 aceitas viram texto corrido
("como o sistema funciona agora"), o debate vai para `docs/research/` e para o histórico do git, e o
arquivo perde a arqueologia — a IA lê o estado, não a história de como se chegou nele.

**Fontes canônicas (quarta revisão, 2026-09-18).** Depois de quatro revisões o desenho converge em cinco
primitivas — Task Contract, journal durável, IR do repositório, cache de artefatos certificados e plano de
conhecimento — e **todo o resto é projeção ou consumidor** (pack, painel, revisão, relatório, skills,
pesquisa, design, handoff entre IAs). Ficam fora, verificado contra os repositórios atuais: BMAD e GSD como
método e `.planning/{STATE,ROADMAP,REQUIREMENTS,CONTEXT}.md` (estado duplicado do journal/plano); Memory
Bank do Cline (Markdown livre sem proveniência — o plano de conhecimento é a resposta); reabrir hooks/memória
do ECC (já decidido em `architecture.md`, sem dado novo); SWE-agent como dependência (o próprio projeto
aponta para o mini-swe-agent; fica a lição da ACI, item (16) da v0.3); substituir `rg` por grafo. Poucas
fontes canônicas, muita informação derivada, IAs descartáveis.
