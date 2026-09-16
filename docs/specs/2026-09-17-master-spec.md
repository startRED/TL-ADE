# TL-ADE — Master spec (v3, 2026-09-17)

> **Substitui `docs/specs/2026-09-16-ade-design.md`** (spec v2, histórica). Fonte canônica de
> arquitetura: `docs/architecture.md`. Esta spec não repete a arquitetura: fixa escopo, contratos de
> superfície (CLI, config, estado em disco), estados e critérios de teste, e aponta para as specs
> dedicadas de cada subsistema. Evidência: `docs/research/README.md` (digest #N) e os documentos de
> `docs/research/`.

---

## 1. Escopo da v1 e fora de escopo

**Na v1.** Engine durável (journal com cadeia de hash, write-ahead por step, reconciliação por classe
de efeito, lease, git por worktree); Intent Compiler com classes de complexidade e faixa rápida;
plano de Task Contracts com aprovação única; ciclo de story com eval-first (vermelho antes, verde
depois), `contain` + canário de isolamento, gates, Checker de rodada e de portão, rework limitado;
Skill Fabric com catálogo curado (60–80) e SkillGuard; Frontend Quality Engine D1–D6 (portões
dependentes de render; o lint anti-slop vive no Gate runner, `architecture.md` §11 E39) + juiz
multimodal de outra família; Context Pack com tetos e manifesto; Tool Output Firewall; Capability
Registry medido por `ade doctor`; telemetria por `model_call`; entrega (commit local na v1,
push/PR/merge a partir da v0.2); `ade takeover` por comando impresso.

**Fora da v1** (`architecture.md` §3, linha "Cortados"): ACP como transporte, concorrência N>1
executada, PTY embutido/node-pty/xterm, CI loop, rotinas autônomas (pós-v1: o ADR de
`routine_budget`/escopo/política de PR só abre quando elas entrarem no roadmap, E52), 4º provider,
memória por usuário,
MCP de browser, pixel-diff, `codex review`, avaliador barato, banimento absoluto de fontes, ablação
automática, OTel export, Tauri. `agy` (Antigravity CLI 1.2.x) é v0.x, papel de pesquisa e fallback de
Checker; Gemini CLI não é usado (digest #2, #3). Painel web somente-leitura é v0.4b.

**Limite de ambição por fatia.** A ordem do roadmap é fixa: Slice 1 (MVP, ~3 semanas) → v0.2 →
v0.3 → v0.4a (Skill Fabric + FQE D1–D6 + juiz) → v0.4b (painel-projeção + SQLite + workspaces) →
v0.5 → v1 → futuro (`docs/roadmap.md`); a v1 completa é ~15–16 semanas a 5 dias/semana
(`architecture.md` §11 E37) — os totais não são recalculados antes da medição da semana 1 do
Slice 1, e até lá seguem [hipótese] (E57). O Slice 1 **não** entrega paridade 93/93: isso é critério de saída da
v0.2 (J1 §2, falha fatal 1 da proposta A); o Slice 1 porta um subconjunto nomeado de 44 casos
(E26). O Slice 1 entrega engine núcleo, uma story trivial com `plan.json` escrito à mão, Maker
`claude`, eval vermelho/verde, `contain` + canário, commit local, matriz de crash × fase e CLI falsa.

---

## 2. Stack e monorepo

| Item | Decisão | Nota |
| :--- | :--- | :--- |
| Runtime | Node ≥ 22 (24.16 instalado) | ESM, TypeScript estrito |
| Monorepo | **pacote único na raiz na v1**; npm workspaces só no commit que cria `packages/web` (v0.4b) | `pnpm` não instalado e não será adicionado; `architecture.md` §11 E29 |
| Pacotes | um pacote na raiz (engine, adapters, intent, skills, fqe, cli) na v1; `packages/web` só na v0.4b, quando os workspaces são criados | um pacote até haver Vite |
| Deps v1 | `canonicalize` (JCS, Apache-2.0, 0 deps), `ajv`, `playwright` (só FQE) | digest #30 |
| CLI | `node:util` `parseArgs` | zero deps de parsing |
| Índice | `better-sqlite3` **só com o painel** (v0.4b) | dependência nativa sem consumidor é defeito (J1 §4) |
| Testes | Vitest; Playwright como biblioteca | |
| Proibido antes da v0.4b/v0.5 | Fastify, WebSocket, `node-pty`, `@xterm/xterm` | digest #29 |

ADR: `docs/adr/0001-typescript-node-monorepo.md`.

---

## 3. Estado em disco e config

```
<repo>/.ade/config.json
<repo>/.ade/missions/<id>/{plan.json, journal.jsonl, status.json, report.md,
                           packs/, artifacts/, jobs/, lease/}
<repo>/.ade/wt/<story>/                 worktrees (caminho curto: MAX_PATH)
~/.ade/catalog/{sources/<nome>@<commit>/, index.json, quarantine/}
~/.ade/capabilities.json                CapabilitySet por família
~/.ade/routing.jsonl                    histórico de desempenho por papel
~/.ade/prices.json                      tabela de preços (estimativa do resumo de aprovação; a
                                        telemetria só tem 'reported' e 'unknown', E61)
```

Nada em `.ade/` entra em commit (`.git/info/exclude`, escrito por `ade doctor`). `jobs/<step>.json`
é o recibo durável com fingerprint anti-reuso de PID; `lease/` é `mkdir` + heartbeat 2 s + TTL 15 s
[hipótese, medir no slice 1] (`architecture.md` §3 C3, §6).

**`ade-config.schema.json`** — `additionalProperties: false` em todos os níveis: **campo fora do
schema é recusado com exit 4**, nunca ignorado. Um campo desconhecido quase sempre é um default
silenciosamente não aplicado. O schema é artefato do slice 1 e a **única fonte** das chaves de
configuração: a tabela abaixo é derivada do schema e não normativa (E55).

| Chave | Conteúdo | Default |
| :--- | :--- | :--- |
| `adapters` | por família: `enabled`, `launch` override, `env_allowlist`, `unattended_flags` override, `ignore_user_config` (Codex: `true`) | claude + codex habilitados; `agy` desabilitado na v1 (modo desatendido do `agy` é `--dangerously-skip-permissions`; `--approval-mode yolo` é do Gemini CLI e não se aplica) |
| `roles` | `intent_compiler`, `classifier`, `maker`, `checker_round`, `checker_gate`, `judge`, `research`: cada um `{primary, fallbacks[≤2]}` com `family` + `model_id` + `effort` | `architecture.md` §7 "Capability Registry e roteamento" |
| `gates` | lista ordenada `{id, cmd[], when: 'always'|'flag', flag?, timeout_s, max_output_bytes, cache_by_tree}` | vazio; `ade doctor` sugere a partir dos manifestos |
| `evals` | `default_timeout_s`, `default_max_output_bytes`, `strictness_default: 'must_fail_before'`, `allow_additive_classes[]` | `additive` só onde declarado e só com um eval `negative` ou spot-check `mutate` no mesmo cenário (E12) |
| `limits` | `max_model_calls_per_story`, `max_rework_rounds` (2), `max_usd_per_mission`, `max_wall_clock_seconds`, `max_parked_units`, `max_pack_bytes` (120 000 [hipótese]), `pack_section_bytes{}` (seção de rodada 24 000; seção `contract` 32 000 ≈8k tokens [hipótese], E50), `review.max_diff_bytes` (60 000), `max_output_bytes` global do Firewall | corte do pack é em **bytes** (E13); "40k tokens" é alvo de projeto por estimativa; calibrar por p90. Nome canônico do diff do Checker: `limits.review.max_diff_bytes` (E13 e operations §9.6 o citam abreviado como `review.max_diff_bytes`). `plan.mission_budget` (E3) **sobrepõe** `limits.max_wall_clock_seconds`, `limits.max_parked_units` e `limits.max_usd_per_mission` na missão em que está gravado; `limits` é o default do repositório. Precedência de rodadas e chamadas: o default de `limits` (`max_model_calls_per_story`, `max_rework_rounds` 2) só vale quando a story não traz `budget`; o `budget` da story, preenchido pelos defaults **por classe** de E4 (trivial 3/1; bounded 6/2; feature 10/3; subsystem e project 12/3) [hipótese], vence. A rodada de rework reservada ao loop visual em story com UI (E39) sai desse mesmo balde, e o orçamento com UI segue `max_model_calls = 2 + 2·visual_rounds + 2·(max_rework_rounds + 1)` [hipótese]: `bounded` com UI = 8 chamadas/3 rework (sem UI mantém 6/2), `feature` com UI = 12/3 (E65). O estouro do teto da seção `contract` é `story_pack_overflow` e reabre a divisão da story (E50). Não há teto de tokens (`max_tokens_in`/`max_tokens_out` rejeitados, E61): onde a família não reporta custo, o teto efetivo é `max_model_calls` |
| `fast_lane` | `checker_threshold_files` (1) | a faixa rápida `trivial` só chama o Checker de rodada quando o diff toca mais arquivos-fonte que este número; valor canônico em `architecture.md` §5 (tabela de classes), J1 §10-1 |
| `autonomy` | `default: 'safe'|'controlled'|'restricted'`, `ask_operator[]` (enum fechado: `push`, `pull_request`, `pull_request_merge`, `dependency_add`, `dependency_major_bump`, `migration_destructive`, `deploy`, `dependency_install`, `secrets_read`, `destructive_local`, `skill_first_use`, `*`, mais `note` livre), `unattended: boolean`, `require_approval_for_new_skill: true` | `safe`; `restricted` é `dispatch: never` (`autonomy_requires_operator`) e herda `scope_paths` da story (E5). `deploy` e `dependency_install` são vocabulário de aprovação: valem só como valores de `ask_operator` e **não** entram em `effect_class` nem em `permitted_effects` (E44) |
| `visual` | bloco publicado uma única vez em `frontend-quality-engine.md` §10 (canônico): `enabled`, `serve_command[]`, `url`, `ready_timeout_s`, `routes[]`, `widths[2]`, `themes[]`, `console_allowlist[]`, `network_allowlist[]`, `gates` (subconjunto bloqueante de D1..D6), `imagegen: boolean`, `max_rounds` (2), `cut` (7,5), `specificity_min` (7), `criterion_min` (6), `judge{family,model_id,pinned_at}`, `generator`, `two_stage`, `impeccable{engine_version,bin}` | FQE ligado quando há UI; lint anti-slop é `gate:anti-slop` no Gate runner (C8), não portão do FQE (E39). `ENGINE_VERSION` do Impeccable divergente do pin é **falha do `ade doctor`** (fail-closed), nunca aviso: o FQE entra em modo degradado e stories com UI param em `awaiting_operator{reason:'fqe_unavailable'}`, enquanto stories sem UI seguem (E45) |
| `research` | `enabled`, `trigger: 'external_fact'` (incógnita declarada, não classe), `max_queries_by_class` (bounded 1, feature+ 3), `team_size` (0 = chamada única), `tie_becomes_question: true` | time paralelo é opt-in (E19) |
| `catalog` | `sources[]` (nome + commit pinado), `trust_default`, `max_skills_per_story` (3), `bm25_top_k` (8), `local_skills_win: true` | `docs/catalog-sources.md`. A v1 assume repositórios do próprio operador: `catalog.sources` vive no `.ade/config.json` do repositório (não existe `~/.ade/config.json`) e skills em `<repo>/.claude/skills/` não entram no pack nem são carregadas pela CLI, porque a chamada despachada roda sob `--safe-mode` (E15); em `codex`/`agy` a supressão equivalente é provada pela sonda. "Modo repositório de terceiros" é backlog da v0.5 com ADR próprio (E56) |
| `harness` | `telemetry: true`, `collect_citation: true`, `doctor_probe_real_calls: boolean`, `ablation: false` | doctor v1 só coleta (digest #40 / J3 §7) |

Validação na ingestão por ajv; o digest JCS da config entra no `runtime_stamp`, que tem três partes
(`<core_version>:<config_digest>:<capabilities_digest>`, E7): só `core_version` — constante do núcleo
durável C1–C5 e C7 — bloqueia com `stale_workflow_version` numa intenção aberta, até
`ade run --accept-stale-version` (gravado como `decision`, ADR 0021); `capabilities_digest` **registra**
upgrade silencioso de CLI (`agy` 1.2.3 → 1.2.4 sem ação) e não bloqueia `--unattended` (E68): tem dois
leitores nomeados, o relatório do `ade doctor` e o evento `mission_summary` (E67). O `config_digest`
também não bloqueia; a mitigação é argv congelado no `batch_open` e hash de `.ade/**` no doctor (E43).

---

## 4. CLI

Exit codes herdados do runtime de referência (`scripts/tl_runtime.py` `main()`; mapa
`{done:0, in_progress:0, stopped:2, blocked:3}` e `Refusal(code=4)`, `code=5` para lease):

| Código | Significado |
| :-- | :--- |
| 0 | ok / idle (nada a fazer, ou execução em progresso sem parada) |
| 2 | stop / recusa (lote parado; cadeia de journal quebrada; entrada válida recusada por política; `stale_workflow_version`; trabalho vermelho final) |
| 3 | concluído com paradas (unidades em `awaiting_operator`/`parked`/`blocked`, orçamento esgotado) |
| 4 | entrada inválida (schema, campo desconhecido, forma nua rejeitada, plano que não valida) |
| 5 | lease em conflito (`coordinator_conflict`) |

Esta tabela é a **tabela única** de exit codes do projeto: **não existem 1 nem 6**, `ade report` e
`ade journal` saem sempre 0, e o exit 3 de E31 vale para `ade run` (E47). Nenhuma spec derivada
publica código fora daqui.

| Comando | Argumentos | Efeito | Exits |
| :--- | :--- | :--- | :--- |
| `ade run <pedido>` \| `--plan <arquivo>` | `--mission`, `--max-units`, `--autonomy safe\|controlled\|restricted`, `--max-usd`, `--unattended`, `--yes`, `--accept-stale-version`, `--json` | compila (ou lê) o plano, adquire lease, executa até fechar/parar/idle; `--unattended` obriga `--yes` e recusa sem as precondições duras (A5) | 0,2,3,4,5 |
| `ade plan <pedido>` | `--out`, `--class`, `--non-interactive`, `--from <missão>` | Intent Compiler até `plan.json`, sem executar; `--non-interactive` recusa qualquer pergunta (exit 3 com as perguntas em JSON); `--from` herda discovery, respostas e stories concluídas e marca a missão anterior como `superseded` | 0,2,3,4 |
| `ade approve <missão>` | `--yes`, `--reject "<motivo>"` | grava `decision{option:'approve'}` e congela `immutable_digest`; `--reject` devolve ao Intent Compiler | 0,2,4 |
| `ade validate <plan>` | — | preflight read-only: ajv, regras de recusa, tetos de pack, capacidades | 0,4 |
| `ade status` | `--mission`, `--json` | projeção do fold do journal | 0,3 |
| `ade report [missão]` | `--out` | relatório de manhã derivado do journal | 0 |
| `ade journal [--unit]` | `--mission` | fold diagnóstico | 0 |
| `ade decide <unit> --option retry\|skip\|discard\|pick\|accept_unproven` | `--mission`, `--value <id>` (obrigatório com `pick`) | registra decisão do operador; `accept_unproven` fecha como `complete` a story `trivial` parada em `red_unproven` (E51). Não há opção de cancelar story `running`: Ctrl-C para o lote e `ade discard` trata a story depois (E62) | 0,4,5 |
| `ade steer <missão> "<nota>"` | `--json` | enfileira intenção consumida no `prepare` da próxima story (não é steering intraturno); o consumidor é a seção `task` do pack, que recebe `operator_notes` (≤600 bytes, mais recente primeiro) — nota é contexto, não requisito: o contrato continua imutável (E53) | 0,4 |
| `ade takeover <story>` | — | imprime o comando exato (`claude --resume <uuid>` + `--add-dir`/`--settings` reimpressos), grava `human_takeover` e escreve `.ade/missions/<id>/takeover-<story>.cmd` e `.ps1` | 0,4 |
| `ade release <story>` | — | checkpoint + `human_release`, retoma o ciclo | 0,4,5 |
| `ade discard <missão>` | `--yes` | move o lote inteiro para `refs/ade/discarded/`; nada é apagado | 0,4,5 |
| `ade show <ref>` | `--bytes`, `--open` | drill-down de artifact bruto do Firewall; `--open` usa o visualizador do SO (o `report.md` emite caminhos absolutos por parada) | 0,4 |
| `ade eval <story>` | `--phase red\|green` | roda os evals do contrato fora do ciclo (dono: C9) | 0,2,4 |
| `ade doctor` | `--probe-real`, `--offline`, `--fix`, `--routing`, `--skills`, `--harness` | mede capacidades (chamada real opt-in com `--probe-real`, TTL `limits.probe_ttl_days`; `--offline` é o default em CI e deixa `probe_ok: null`), `core.longpaths`, shims, canário de isolamento, `.git/info/exclude`; `--routing` sugere trocas de default, `--skills` relata delta de memória/config do agente (detect-only, E35), `--harness` emite os blocos do harness doctor | 0,2 |
| `ade catalog sync\|list\|inspect` | `--source`, `--id` | fetch + checkout do commit pinado, sha256 por arquivo, sanitização, quarentena | 0,2,4 |
| `ade serve` (v0.4b) | `--port` | painel somente-leitura; token aleatório por sessão impresso no terminal + checagem de `Origin` (E34) | 0 |
| `ade index --rebuild` (v0.4b) | — | reconstrói o SQLite a partir do JSONL | 0 |

`ade run <pedido>` é a forma canônica; a forma nua `ade "<pedido>"` é aceita **apenas** quando o
primeiro token não casa com nenhum comando conhecido e o pedido tem espaço em branco — caso
contrário, exit 4 com sugestão (E31). Exit 3 vale quando há `awaiting_operator` com
`batch_state: in_progress`. Estados e `reason` são em inglês (formato do journal); as mensagens ao
operador são em português. Esta tabela é a **fonte única** da superfície de CLI: nenhuma spec publica
flag que não esteja aqui, e o texto do `--help` é gerado dela. O `--help` curto separa a superfície
operacional (`run`, `report`, `decide`, `discard`) da avançada. Toda saída `--json` é JCS canônico. Toda recusa imprime
`{error, code}` em stderr.

---

## 5. Modelo de missão

`plan.json` (`plan.schema.json`) é congelado na aprovação e é o único insumo de execução.

```ts
interface Plan {
  format_version: 1
  mission_id: string; created_at: string; request: string      // o pedido literal
  runtime_stamp: string
  complexity: Complexity
  phases: { id: string; title: string; epics: Epic[] }[]        // fase → epic → story
  authorization: {                                              // aprovação única, §9 da arquitetura
    approved_by: 'operator' | 'fast_lane'; approved_at: string
    autonomy: 'safe' | 'controlled' | 'restricted'
    permitted_effects: EffectClass[]                            // só efeitos EXTERNOS; classes internas
                                                                // (model_call, eval_run, local_write, gate,
                                                                // prepare) são implícitas
    estimated_cost_usd: number | null; cost_source: 'reported' | 'estimated' | 'unknown'
    new_skills: string[]                                        // primeira aparição no projeto
    eligible_skills: string[]                                   // conjunto congelado da missão: união do top-8 por story
  }
  mission_budget: { max_wall_clock_seconds?: number; max_parked_units?: number; max_usd?: number }
                                                                // gravado no batch_open; jornada 6: 8 h e 3 [hipótese]
  budget: { max_model_calls: number }
  immutable_digest: string                                      // SHA-256 sobre JCS do plano sem este campo
}
interface Epic { id: string; title: string; stories: TaskContract[] }
```

**Regras.**

1. Cada story é um **Task Contract** (`architecture.md` §4), imutável após a aprovação. O contrato não
   tem `passes`: o estado da story vive no journal (`unit_state`) e na projeção `status.json`, e o
   veredito em `unit-result` (E1). Exceção única de mutabilidade: em `trivial` com `evals: []` na
   aprovação, o Maker preenche `evals` uma vez (`author: 'maker'`), gravado como step `local_write`
   com `eval_authored_by`; o vermelho diferido é condição de validade (E2).
2. `immutable_digest` é recalculado na abertura de toda missão e antes de todo step: divergência é
   recusa (exit 2), nunca execução. É o que impede "o plano mudou embaixo do lote".
3. `permitted_effects` é o **conjunto fechado** de efeitos **externos** que o lote pode produzir
   (classes internas — `model_call`, `eval_run`, `local_write`, `gate`, `prepare` — são implícitas,
   E3, E6). Um step cuja classe externa não está autorizada nunca é despachado: vira
   `awaiting_operator` com o motivo (ex.: `push is not permitted`). Os três níveis são conjuntos
   **distintos** de `permitted_effects`, não uma cadeia de inclusão (operations §2): `controlled` é o
   único que despacha `push`/`pull_request`/dependência/migration desatendidos; `restricted` é o nível
   em que tudo o que sai do worktree vira pergunta —
   `restricted` implica `ask_operator: ['*']`, é `dispatch: never` e nunca roda
   desatendido. `ade run --unattended` recusa sem gates ativos, baseline de eval verde, caminho de
   rollback em `refs/ade/` e isolamento por worktree verificado pelo canário (A5).
4. Validação de plano (`ade validate`, também no `run`) recusa: story sem eval por cenário; sem
   `do_not_touch`; sem `complexity`; com UI e sem `design_brief`; com `skills` fora do índice do
   catálogo; com estimativa de pack acima do teto (pede divisão); com `depends_on` cíclico. O teto de
   pack tem duas verificações: estimativa no plano (divide por cenário) e medição no `prepare`, que
   poda o contexto recuperado e nunca o contrato — se o contrato sozinho estoura, a divisão reabre
   (E20). A validação de `eval.cmd[0]` contra os `scripts` do projeto **não** roda no plano: migra
   para o `prepare` de cada story, com re-discovery no worktree; no plano valida-se só a forma, de
   modo que uma missão em que a fase 0 cria os scripts usados pelas fases seguintes ainda cabe numa
   aprovação única (E63).
5. `depends_on` é opcional: sem ele o scheduler é lista plana (digest #22 — o harness de longa
   duração da Anthropic não usa DAG). O DAG só existe quando o plano o declara.

---

## 6. Ciclo da story

**Fases** (ordem): `prepare` → `eval_red` → `implement` → `contain` → `gates` → *(`fqe` se há UI)* →
`eval_green` → `review` → *(`rework` ≤ N, volta a `implement`)* → `checker_gate` → `commit` →
`push` → `pull_request` → `ci` → `merge` → `complete`. Na v1 o ciclo termina em `commit`
(push/PR/merge entram na v0.2; `ci` é portado desligado, `ci.enabled: false` default, E25). Toda
story com UI reserva 1 rodada de rework para o FQE já no `prepare` (E39). O `local_merge`
fast-forward da branch da story na branch base entra em `safe` quando a base não mudou desde o
`prepare` (ff-only, ref de origem preservada em `refs/ade/`); se a base mudou, o commit fica na
branch da story e o `report.md` imprime o comando de merge (E64).

O `prepare` também resolve dependências: cria junction (Windows) ou symlink `node_modules`
apontando para o checkout base quando o hash do lockfile do worktree é igual ao do base; se diverge,
classe ≥ `bounded` roda o instalador detectado no discovery (`npm ci`,
`pnpm install --frozen-lockfile`, …) como step `prepare`, com `prepare_dependency_ms` na telemetria,
e `trivial` com lockfile divergente para em `awaiting_operator{reason:'environment'}` (E49). E
recusa despacho em worktree com `takeover.json` presente: a story para em
`awaiting_operator{reason:'takeover_open'}` e `ade decide --option retry` devolve a mesma parada,
sem exit code novo (E42).

**Estados da story** (porte literal de `UNIT_STATES`): `ready`, `running`, `waiting`, `retryable`,
`parked`, `blocked`, `completed`, `failed`, `awaiting_operator`. Terminais: `parked`, `blocked`,
`completed`, `failed`, `awaiting_operator`.

| De | Para | Gatilho |
| :--- | :--- | :--- |
| `ready` | `running` | `next_ready` + reserva de orçamento + lease |
| `running` | `retryable` | falha transitória classificada `released` (nada efetivado) |
| `running` | `awaiting_operator` | `target_role:'human'` no review; ambiguidade de efeito externo; rede indisponível na retomada; empate de pesquisa; skill nova em lote desatendido; FQE sem consenso após 2 rodadas; `takeover_open` (E42); `fqe_unavailable` (E45); `red_unproven` em `trivial` (E51); `environment` por lockfile divergente em `trivial` (E49) |
| `running` | `parked` | orçamento esgotado, `rework_limit_exhausted`, detector de loop, `no_checker_family_available`, canário de isolamento reprovado |
| `running` | `completed` | `complete` gravado com evidência |
| qualquer aberta | `blocked` | dependência em estado terminal não-`completed` |
| `awaiting_operator` | `retryable` \| `failed` \| `completed` | `ade decide --option retry|skip|discard|pick --value <id>`; `accept_unproven` fecha como `completed` com `decision` gravada (E51) |
| `parked`/`awaiting_operator` | `running` | `ade release` após `takeover` |

**Invariantes do ciclo.** (a) sessão nova por chamada, modelo fixo por papel, `Maker ≠ Checker` por
`model_id` (digest #3) — a telemetria grava `models: { role: 'executor' | 'advisor'; model_id }[]` e a
regra vale por `model_id` e por vendor para **todo** papel da chamada; `--advisor` só entra na receita
quando o modelo do advisor é observável em `modelUsage` (sonda do doctor), e até lá o Maker roda sem
`--advisor` (E66); (b) o Checker nunca escreve — `codex exec --sandbox read-only
--ignore-user-config --output-schema review-result.schema.json` na rodada, `claude -p --json-schema
… --permission-mode plan` no portão (I28 vira impossibilidade, J3 §5); o Checker de rodada também
recusa vendor igual ao do Maker (`models[].vendor`, E10); (c) eval vermelho contra `tree_before` é
obrigatório salvo `strictness.mode = 'additive'`, que gera aviso registrado; só
`red_reason: 'assertion'` conta como vermelho válido — `missing_target`, `compile_error` e
`environment` rebaixam para `additive` com aviso (classe ≥ `feature`: `awaiting_operator`) e
`additive` exige no mesmo cenário um eval `negative` ou um spot-check `mutate` (E12) — em `trivial`
não há rebaixamento, porque `negative` e `mutate` não existem nessa classe: a story para em
`awaiting_operator{reason:'red_unproven'}` com o diff pronto e `ade decide --option accept_unproven`
a fecha como `complete` com `decision` gravada (E51); o runner de evals (C9) exige reporter
estruturado (`--reporter=json` no Vitest/Jest, equivalente por runner) e `numTotalTests ≥ 1`, e zero
teste executado é `red_reason: 'missing_target'`, nunca verde (E58); eval que
nasce verde volta ao Intent Compiler, não ao Maker; (d) o relato do agente nunca conta — só evidência
executada (digest #37); (e) `contain` roda pós-fato sobre a árvore com precedência segurança >
`sensitive_paths` > escopo, `maxBuffer` explícito (o default de 1 MiB trunca a varredura de segredo
em silêncio); segredo encontrado em blob vai para quarentena em `refs/ade/quarantine/`, nunca é
empurrado e o doctor alerta — purga de blob não existe na v1, é comando manual pós-v1 (E60, E36); (f) isolamento tem duas provas distintas, e **nenhuma delas custa chamada por story**: o
**canário com modelo** é sonda do `ade doctor`, uma por família — pedir ao modelo, num worktree
descartável, que escreva `../canary-<uuid>.txt` —, gravada em `~/.ade/capabilities.json` com
`probed_at` + TTL, e reprová-la barra a família para papéis de escrita
(`adapters-capability-registry.md` §6); **por dispatch** roda só a verificação de custo zero, sem
instrução ao modelo: hash antes/depois de um conjunto fixo de alvos (raiz do repo fora do worktree,
`~/.claude`, `$CODEX_HOME`, `~/.gemini/antigravity-cli/` e a deny-list de E23 — `~/.ssh/**`,
`~/.aws/**`, `**/.env*`); qualquer alvo alterado é `isolation_canary_failed` (digest #38); (g) git, `gh`, commit, push e merge são sempre do engine, nunca
do worker (I55).

---

## 7. Subsistemas e specs dedicadas

| Subsistema | Resumo de uma linha | Spec dedicada |
| :--- | :--- | :--- |
| Engine e durabilidade | journal JSONL com `prev` = 16 hex do SHA-256 sobre JCS, `fsync` por linha, escritor único; `step_intent`/`step_result`; reconciliação por `effect_class`; lease com fingerprint; recibo durável; worker não-detached (Job Object da libuv) | `docs/specs/engine-durability.md` |
| Intent Compiler | discovery determinístico → classificação → expansão em camadas → ≤5 perguntas (recusa pergunta respondível pelo repo; "não sei" = default registrado) → plano validado → resumo de aprovação; faixa rápida `trivial` | `docs/specs/intent-compiler.md` |
| Skill Fabric | catálogo curado, `index.json` com metadados fora do SKILL.md, filtro duro → BM25 top-8 → seletor ≤3 → bloco fixo do pack por id; SkillGuard (12 controles), sanitização em build time (ASR 36 % → 7,2 %, digest #34) | `docs/specs/skill-fabric.md` |
| Frontend Quality Engine | DesignBrief em 4 camadas (`self_critique` obrigatório); build → serve → Playwright (a11y, console, rede, estilos) → D1–D6, todos dependentes de render (D5 = `impeccable detect --json` contra URL renderizada) → juiz multimodal de outra família pinado por `model_id`, rubrica de 6 critérios, corte 7,5 com critério de recalibração publicado, ≤2 rodadas | `docs/specs/frontend-quality-engine.md` |
| Adapters e Capability Registry | casca fina sobre flags nativas por família, parser tolerante a campo desconhecido, CLI falsa por família; CapabilitySet medido por `ade doctor`, roteamento por papel com primário + 2 fallbacks | `docs/specs/adapters-capability-registry.md` |
| Context Pack, Firewall, telemetria | pack em ordem de volatilidade com teto por seção e manifesto, sempre `{pack_path}` (digest #31); `run(argv) → {rawPath, extract}` com bruto em artifact e extrato ao modelo; telemetria por `model_call` com `skills_injected[]` carregando `cited`, `sha256` do conteúdo injetado e `source` (`catalog@<commit>` ou `local`) como evidência de supply chain (E59) | `docs/specs/context-firewall-telemetry.md` |
| Superfície do operador | CLI, `ade report`, fila de `awaiting_operator`, `decide`/`steer`/`show --open`, `takeover`/`release`/`discard`, painel-projeção v0.4b (toda ação vira step antes de virar efeito) | `docs/specs/operator-surface.md` |

---

## 8. Os oito schemas publicados

Todos com `additionalProperties: false`, `$id` estável e `format_version`. Campos completos em
`architecture.md` §4; aqui só o eixo de cada um.

| Schema | Eixo | Campos principais |
| :--- | :--- | :--- |
| `journal-event` | linha durável | `format_version`, `seq`, `at`, `prev`, `kind`, `effect_class` (inclui `gate` e `prepare`, E6), `input_digest`, `intent_context`, `worktree`, `receipt_path`, `session_ref: string\|null`, `runtime_stamp` (`core_version:config_digest:capabilities_digest`) |
| `ade-config` | política do repositório | as 11 chaves de §3 (o bloco `visual` é publicado em `frontend-quality-engine.md` §10) |
| `plan` | lote aprovado | `phases[].epics[].stories[]`, `authorization{permitted_effects, autonomy, eligible_skills}`, `mission_budget`, `budget`, `immutable_digest` |
| `task-contract` | uma story | `complexity`, `task`, `guardrails{scope_paths, do_not_touch, sensitive_paths, autonomy, ask_operator}`, `requirements[].ears`, `scenarios[].evals`, `evals[]`, `skills[≤3]`, `roles`, `design_brief?`, `budget` — **sem `passes`** (E1) |
| `eval` | prova executável | `kind`, `cmd[]`, `expect_exit`, `timeout_s`, `max_output_bytes`, `evidence[]`, `strictness{mode}`, `author` |
| `unit-result` | resultado por story | `story_id`, `state`, `phase`, `round`, `tree_before`/`tree_after`, `eval_records[]` (com `red_reason`), `gate_records[]`, `commit?`, `passes`, `reason`, `sources[]` obrigatório (digests das seções do pack usadas, E8) |
| `review-result` | veredito do Checker | `verdict`, `action_items[]{severity, category, target_role, location, problem, evidence, required_action}`, `deferred[]`, `rejected[]`, `sources[]` obrigatório (E8); `summary` **derivado**, nunca fonte (digest #32) |
| `capability-set` | uma família | `launch`, `transport`, `models[]{id, context_window, effort, vendor}`, `resume`, `fork`, `preminted_session_id`, `structured_output`, `budget_cap_native`, `image_in/out`, `sandbox`, `cost_report`, `advisor`, `unattended_flags[]`, `probe_ok: boolean\|null`, `probe_mode: 'real'\|'help_only'\|'fixture'`, `bootstrap_cost_tokens`, `probed_at` |

Sem `sources[]` preenchido, `cited` é sempre falso na telemetria. `visual-eval` é promovido a **nono
schema publicado na v0.4b** (dois consumidores: FQE e painel-projeção, E9); `research-finding` fica
como JSON Schema inline enquanto houver um consumidor só.

---

## 9. Estratégia de testes

| Camada | O que prova | Onde |
| :--- | :--- | :--- |
| **Unidade** | canonicalização, cadeia de hash, fold do journal, reconciliação por classe, lease, `dirty_paths -z` com rename, resolução de shims | Vitest, sem rede |
| **Byte-paridade do JCS** | `canonicalize_output_byte_identical_to_python_reference_fixture`: fixtures geradas pelo runtime Python; canonicalizador errado quebra a cadeia em silêncio (I02, J1 §3) | Vitest |
| **CLI falsa** | adapter por família com **transcript gravado** (stdout/stderr/exit real das CLIs) + contador de invocações **em disco**; cobre `no_result`, exit não-zero, JSON truncado, campo desconhecido, timeout | Vitest, zero custo, roda em CI sem credencial |
| **Paridade** | os 93 casos de `test_tl_runtime.py` (1 skip) portados caso a caso, com `parity-name-map.json` (lista fechada dos casos que mudam de nome/semântica por `review-result` rico e `plan`) como artefato de **entrada** da v0.2; o Slice 1 porta um subconjunto nomeado de 44 casos e 93/93 nos dois SOs é critério de saída da **v0.2** (digest #1, J1 §5.3, E26). Dois alvos normativos: `parity` (zero credencial, CI Windows + Linux) e `probes` (chamadas reais, local, opt-in) | Vitest, Windows + Linux |
| **Matriz de crash × fase** | engine, worker, máquina e browser mortos em cada fase; o que reconcilia, o que fica `ambiguous`, o que vira checkpoint. Critério de aceite do Slice 1, não documentação | integração |
| **Fixtures de intenção** | pedidos reais → classe esperada, perguntas esperadas, recusa de pergunta respondível pelo discovery, eval verde de nascença devolvido ao compiler; alvo falsificável para EARS genérico ("THE SYSTEM SHALL work correctly" **precisa** reprovar) | Vitest + CLI falsa |
| **Fixtures de seleção de skills** | roteamento rank-1 e colisão de descrições, no framework de evals de `addyosmani/agent-skills` (`ref-addyosmani-agent-skills.md`); alvo `recall@8 ≥ 0,85`, `precision@3 ≥ 0,75` [hipótese] | Vitest |
| **FQE boa/ruim** | duas páginas fixas — uma que passa D1–D6 e uma com defeito plantado por portão — mais uma fixture de slop que o juiz tem de pontuar abaixo de 7,5; Impeccable pinado por `ENGINE_VERSION` (digest #19) | Playwright |
| **Dogfood** | a ADE fecha uma story dela mesma (Slice 1: adicionar um campo ao `journal-event`) com worktree, `contain` e checkpoint no lugar; progride até conduzir a própria missão (v1, jornada 6) | manual + journal |

**Cobertura.** ≥85 % de linhas exigidas só em `journal, step, lease, git, runner, contain`
[hipótese]; no resto, a razão teste:produção aparece no corpo do PR, sem portão (E27).

**Faixa rápida.** O teste `fast_lane_trivial_starts_within_30s_zero_questions` é critério de saída da
**v0.3**; o Slice 1 grava só `first_source_edit_ms` como baseline (E40).

**CI sem credencial.** Nada que exija assinatura roda em CI: `ade doctor --probe-real` faz chamada real,
custa dinheiro e só roda localmente; em CI vale `ade doctor --offline` (default), com `probe_ok: null`
e Capability Registry lido de fixture — fora de CI, `null` recusa despacho e nunca degrada para
fallback (E10). O fallback do estágio 0 (`claude -p` em loop) grava cursor durável no formato de linha
do `journal-event`, e o gravador de transcript (`scripts/record-transcript.ts`) é artefato do dia 1
(E28). As três superfícies de segurança — `contain`/isolamento, servidor local do painel e ingestão do
catálogo — têm revisão humana obrigatória, exceção escrita à meta "zero revisão humana" (E30). A suíte
de paridade custa ~11,7 s/caso em série (≈18 min): paraleliza por worker (J1 §5.4).

---

## 10. Riscos e mitigações

| # | Risco | Evidência | Mitigação na v1 |
| :-- | :--- | :--- | :--- |
| R1 | Slice 1 não cabe em 3 semanas: `tl_runtime.py` 2470 linhas + `tl_job.py` 2562 a portar | J1 §5.2 | escopo do Slice 1 = 10 testes nomeados, subconjunto de 44 casos de paridade e uma story trivial; paridade 93/93 é v0.2; a semana 1 mede linhas portadas por dia e replaneja explicitamente o roadmap (v1 completa ~15–16 semanas, E37) [hipótese] |
| R2 | Eval escrito pelo próprio Maker na faixa rápida não é prova independente | J2 §3 (A-1) | `author: 'maker'` gravado no journal + portão `tree_before` mantido; telemetria mede defeitos escapados da classe `trivial` |
| R3 | EARS genérico passa na validação de forma e não discrimina | J1 §4 (C-3) | fixtures de intenção com casos que **precisam** reprovar; eval verde de nascença volta ao compiler |
| R4 | Escrita fora do worktree não detectada (`bypassPermissions`, sem sandbox de SO no Windows) | digest #8, #37, #38 | canário com modelo como sonda do `ade doctor` por família (TTL em `capabilities.json`) + verificação de custo zero por dispatch, hash antes/depois dos alvos fixos (§6(f)); `contain` pós-fato sobre o diff; env filtrado (I49) como cerca real — `--disallowedTools` é glob best-effort e vai em **argumento único separado por vírgula** (`"Bash(git push*),Bash(gh pr*)"`, E24). A deny-list de caminhos (`~/.ssh/**`, `~/.aws/**`, `**/.env*`) vive no env filtrado, no canário e no doctor, **não** no `contain` (E23) |
| R5 | Saída de ferramenta hostil como vetor de injeção ("falha nunca é resumida" entrega log íntegro) | J3 §4 | Firewall cerca a falha como **dado** com delimitador e aviso; bruto em artifact; `ade show` para drill-down |
| R6 | Supply chain de skills (ToxicSkills: 36,8 % com falha, 91 % por injeção) | digest #12, #34 | pin por commit + sha256 por arquivo, licença por skill, sanitização estática em build time, frontmatter removido antes da injeção, quarentena, engine nunca executa script |
| R7 | Custo estrutural: piso de 19,4k do Codex por chamada de Checker; diff de 200 000 chars | digest #27, J3 §6 | receita de chamada curta `--ignore-user-config --ignore-rules --ephemeral -c skills.max_context_tokens=0` + `AGENTS.md` ≤2 KB escrito pelo engine no worktree (E16); `limits.review.max_diff_bytes` 60 000, por arquivo em ordem de relevância de escopo, com ponteiro `ade show diff:<story>#<arquivo>` |
| R8 | Ablação do harness doctor é cega no braço Codex (sem USD; `claude plugin eval` só no braço Claude) | digest #28, J3 §7 | doctor v1 **só coleta**; `cost_source: 'estimated'` via `~/.ade/prices.json`; ablação pareada fica para pós-v1 com o ponto cego declarado |
| R9 | A ADE se atualiza durante a própria missão (dogfood) | J1 §5.6 | `runtime_stamp` = engine + digest da config; divergência em intenção aberta = `stale_workflow_version` até `--accept-stale-version` (ADR 0021) |
| R10 | Worker morre com o engine (não-detached): uma chamada paga perdida por crash | `architecture.md` §6 | árvore suja vira checkpoint, chamada vira `ambiguous`, próximo Maker continua; detached + recibo anexável é upgrade |
| R11 | Windows: MAX_PATH em `.ade/wt/<id>` com `node_modules` profundo; handle preso em `git worktree remove` | J1 §5.7 | worktree em caminho curto, `core.longpaths=true` no doctor, retry com backoff na remoção, sweep de órfãs |
| R12 | Tetos de pack são chute | digest, "Hipóteses assumidas" | corte em bytes: `max_pack_bytes` 120 000 [hipótese], seção de rodada 24 000, skills ≤10k tokens por skill e soma ≤25k (E13, E14); telemetria por seção; ajustar por p90 no dogfood [hipótese] |

---

## 11. O que mudou em relação à spec v2

Tabela de `architecture.md` §8 expandida com o ADR que fixa cada mudança.

| Spec v2 | v3 | Motivo (evidência) | ADR |
| :--- | :--- | :--- | :--- |
| 3 famílias na v1 (`gemini`/`antigravity` por binário) | 2 famílias (claude, codex); Google = `agy` na v0.x, pesquisa e fallback de Checker; `Maker ≠ Checker` por `model_id` | binário `antigravity` não existe; `agy` serve modelos Claude; Gemini CLI exige API key (#2, #3) | 0005 |
| `codex review` como Checker; "Codex = melhor revisor" | Checker de rodada Codex (precisão) / de portão Claude (cobertura), via `exec --output-schema` | CR-bench 32,1 % vs 20,1 %; `--output-schema` ignorado em `review` (#5, #6) | 0006 |
| Painel com PTY na v1; SQLite; Fastify | painel-projeção somente-leitura na v0.4b; `ade takeover` por comando; PTY v0.5+ | node-pty sem 1.2.0 estável, bug #967 (#29); curva de valor | 0013 |
| Sem advisor nativo; protocolo de saída estruturada por prompt | `--advisor`, `--json-schema`, `--output-schema`, `--max-budget-usd`, `--session-id` nativos | (#4, #10, #11) | 0004 |
| 4 rodadas visuais, corte 8, avaliador barato, fontes banidas | 2 rodadas, corte 7,5 (recalibração publicada), portões D1–D6 dependentes de render, lint anti-slop no Gate runner, juiz forte de outra família pinado por `model_id`, o brief vence, Impeccable pinado por `ENGINE_VERSION` | Impeccable 4.3.1 normativo; banda calibrada (#16–#19) | 0010 |
| Composio como lista curada; `anthropics/skills` inteiro | fontes com licença conhecida; denylist proprietária; catálogo 60–80 | 864 SKILL.md vendorizados, 832 wrappers; licenças (#12, #13) | 0009 |
| Skills como leitura sob demanda | bloco fixo do pack por id; seleção externa obrigatória | truncagem nativa (1.536 chars, ~1 % do contexto) e cache (#13, #14) | 0009 |
| Checker atesta eval estrito | prova vermelha por execução gravada no journal | determinístico e mais barato; relato de agente não conta (#37) | 0007 |
| Contexto limpo = `/clear` | processo novo com `--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | `--bare` quebra autenticação por assinatura (#9) | 0011 |
| Concorrência 1, worktrees no futuro | N=1 com Git por worktree e campo `worktree` desde o dia 1 | barato antes do primeiro commit, caro depois (#33) | 0014 |
| Paridade "10 falham no Windows" | 93/93 nos dois SOs, com tabela de mapeamento de nomes onde o schema mudou | a suíte passa 93/93, 1 skip (#1) | 0003 |
| `review-result` copiado | forma rica, `summary` derivado, defeito latente corrigido | schema e runtime discordavam em dois pontos (#32) | 0006 |
| Graft embutido em todo worktree | dependência **opcional** com fallback silencioso para `rg` | ganho real a medir no dogfood (`ref-graft.md`) | 0018 |
| Transporte por adapter genérico indefinido | bespoke headless na v1; ACP quando houver steering estável ou 4º provider | ACP não pré-cunha id de sessão nem coage schema (#35) | 0004 |
| Sem nível de autonomia formal | `safe`/`controlled`/`restricted` + `permitted_effects` fechado no plano; `restricted` nunca desatendido | flags de modo desatendido medidas por família (#37) | 0015 |
| Times de pesquisa como default | pesquisa é subsistema opt-in, classe ≥ `feature`, empate vira pergunta | +90 % de recall por ~15× tokens: só onde se paga | 0016 |
| Harness com poda automática | doctor v1 **só coleta**; ablação pareada depois | métrica de citação e custo por item primeiro (#40) | 0017 |
| Sem versionamento de journal | `format_version` só sobe com migração; `runtime_stamp` por evento | dogfood muda o engine embaixo da missão | 0021 |

---

## 12. Divergências resolvidas

Objeções a `docs/architecture.md` arbitradas em `architecture.md` §11 (2026-09-17). O corpo desta
spec já reflete cada decisão.

1. **`passes` dentro de um contrato imutável** → **aceita** (`architecture.md` §11 E1). `passes` sai
   do `task-contract`; o estado da story vive no journal (`unit_state`) e na projeção `status.json`, e
   o veredito em `unit-result`. Ajuste conexo (E2): em `trivial` com `evals: []` na aprovação, o Maker
   preenche `evals` uma vez (`author: 'maker'`), gravado como step `local_write` com
   `eval_authored_by` — exceção única de mutabilidade, com vermelho diferido como condição de
   validade. Refletido em §5 regra 1 e §8.

2. **`probe_ok: boolean` não expressa "não sondado"** → **aceita e ampliada** (E10). `probe_ok:
   boolean | null`, mais `probe_mode: 'real' | 'help_only' | 'fixture'`, `bootstrap_cost_tokens` por
   família e `models[].vendor`; `ade doctor --offline` é o default em CI e `null` fora de CI **recusa
   despacho**, nunca degrada. O Checker de rodada recusa vendor igual ao do Maker. Refletido em §4, §6
   e §8.

3. **Forma nua `ade "<pedido>"`** → **aceita** (E31). `ade run <pedido>` é canônico; a forma nua vale
   só quando o primeiro token não é comando conhecido e o pedido tem espaço em branco, senão exit 4
   com sugestão. Exit 3 quando há `awaiting_operator` com `batch_state: in_progress`; estados e
   `reason` em inglês, mensagens em português; `--help` curto separa superfície operacional da
   avançada. Refletido em §4.

4. **`max_diff_bytes` herdado (200 000 chars)** → **aceita** (E13). `limits.review.max_diff_bytes`
   default 60 000 chars, por arquivo em ordem de relevância de escopo, com ponteiro
   `ade show diff:<story>#<arquivo>`. No mesmo item, o corte do pack passa a ser **em bytes**
   (`limits.max_pack_bytes` 120 000 [hipótese], seção de rodada 24 000): "40k tokens" continua como
   alvo de projeto por estimativa. Refletido em §3 e R7/R12.

5. **`visual-eval` publicado junto com o painel** → **aceita com ajuste de fatia** (E9): nono schema
   publicado na **v0.4b** (a fatia que traz o painel-projeção), não na v0.4 genérica. O `judge` é
   pinado por `model_id` no contrato e replicado no registro; `visual_score` só é comparável dentro do
   mesmo juiz; `judge_family` é registrado e "juiz único (Codex) com Maker sempre Claude" fica como
   hipótese explícita. `research-finding` continua inline. Refletido em §8.

6. **Slice 1 sem orçamento de porte medido** → **aceita** (E37, E26). A semana 1 do Slice 1 mede
   linhas portadas por dia e replaneja o roadmap explicitamente; a v1 completa é ~15–16 semanas a
   5 dias/semana (não "3 meses"), e o Slice 1 porta um subconjunto nomeado de 44 casos de paridade
   (93/93 fica na v0.2). Refletido em §1 e R1.

Nenhuma das seis foi rejeitada. Pendências que ficam para Erick ou para o dogfood
(`architecture.md` §9, §11): retenção de `refs/ade/discarded/`, defaults numéricos de lease, pack e
orçamentos, e a confirmação dos cinco itens de §9 da arquitetura.
