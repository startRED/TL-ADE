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
Skill Fabric com catálogo curado (60–80) e SkillGuard; Frontend Quality Engine D1–D7 + juiz
multimodal de outra família; Context Pack com tetos e manifesto; Tool Output Firewall; Capability
Registry medido por `ade doctor`; telemetria por `model_call`; entrega (commit local na v1,
push/PR/merge a partir da v0.2); `ade takeover` por comando impresso.

**Fora da v1** (`architecture.md` §3, linha "Cortados"): ACP como transporte, concorrência N>1
executada, PTY embutido/node-pty/xterm, CI loop, rotinas autônomas, 4º provider, memória por usuário,
MCP de browser, pixel-diff, `codex review`, avaliador barato, banimento absoluto de fontes, ablação
automática, OTel export, Tauri. `agy` (Antigravity CLI 1.2.x) é v0.x, papel de pesquisa e fallback de
Checker; Gemini CLI não é usado (digest #2, #3). Painel web somente-leitura é v0.4.

**Limite de ambição por fatia.** A ordem do roadmap é fixa: Slice 1 (MVP, ~3 semanas) → v0.2 →
v0.3 → v0.4 → v0.5 → v1 → futuro (`docs/roadmap.md`). O Slice 1 **não** entrega paridade 93/93: isso
é critério de saída da v0.2 (J1 §2, falha fatal 1 da proposta A). O Slice 1 entrega engine núcleo,
uma story trivial com `plan.json` escrito à mão, Maker `claude`, eval vermelho/verde, `contain` +
canário, commit local, matriz de crash × fase e CLI falsa.

---

## 2. Stack e monorepo

| Item | Decisão | Nota |
| :--- | :--- | :--- |
| Runtime | Node ≥ 22 (24.16 instalado) | ESM, TypeScript estrito |
| Monorepo | **npm workspaces** | `pnpm` não instalado e não será adicionado |
| Pacotes | `packages/core` (engine, adapters, intent, skills, fqe, cli) na v1; `packages/web` só na v0.4 | um pacote até haver Vite |
| Deps v1 | `canonicalize` (JCS, Apache-2.0, 0 deps), `ajv`, `playwright` (só FQE) | digest #30 |
| CLI | `node:util` `parseArgs` | zero deps de parsing |
| Índice | `better-sqlite3` **só com o painel** (v0.4) | dependência nativa sem consumidor é defeito (J1 §4) |
| Testes | Vitest; Playwright como biblioteca | |
| Proibido antes da v0.4/v0.5 | Fastify, WebSocket, `node-pty`, `@xterm/xterm` | digest #29 |

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
~/.ade/prices.json                      tabela de preços (cost_source: 'estimated')
```

Nada em `.ade/` entra em commit (`.git/info/exclude`, escrito por `ade doctor`). `jobs/<step>.json`
é o recibo durável com fingerprint anti-reuso de PID; `lease/` é `mkdir` + heartbeat 2 s + TTL 6 s
(`architecture.md` §6).

**`ade-config.schema.json`** — `additionalProperties: false` em todos os níveis: **campo fora do
schema é recusado com exit 4**, nunca ignorado. Um campo desconhecido quase sempre é um default
silenciosamente não aplicado.

| Chave | Conteúdo | Default |
| :--- | :--- | :--- |
| `adapters` | por família: `enabled`, `launch` override, `env_allowlist`, `unattended_flags` override, `ignore_user_config` (Codex: `true`) | claude + codex habilitados; `agy` desabilitado na v1 |
| `roles` | `intent_compiler`, `classifier`, `maker`, `checker_round`, `checker_gate`, `judge`, `research`: cada um `{primary, fallbacks[≤2]}` com `family` + `model_id` + `effort` | `architecture.md` §7 "Capability Registry e roteamento" |
| `gates` | lista ordenada `{id, cmd[], when: 'always'|'flag', flag?, timeout_s, max_output_bytes, cache_by_tree}` | vazio; `ade doctor` sugere a partir dos manifestos |
| `evals` | `default_timeout_s`, `default_max_output_bytes`, `strictness_default: 'must_fail_before'`, `allow_additive_classes[]` | `additive` só onde declarado |
| `limits` | `max_model_calls_per_story`, `max_rework_rounds` (2), `max_usd_per_mission`, `max_wall_clock_seconds`, `max_parked_units`, `pack_total_tokens` (40k), `pack_section_tokens{}`, `max_diff_bytes` (Checker), `max_output_bytes` global do Firewall | tetos são hipótese a medir (digest, "Hipóteses assumidas") |
| `autonomy` | `default: 'safe'|'controlled'|'restricted'`, `ask_operator[]`, `unattended: boolean`, `require_approval_for_new_skill: true` | `safe`; `restricted` nunca desatendido |
| `visual` | `enabled`, `widths[2]`, `themes[]`, `gates: D1..D7`, `judge_cutoff` (7,5), `max_rounds` (2), `impeccable_engine_version`, `imagegen: boolean` | FQE ligado quando há UI |
| `research` | `enabled`, `min_complexity: 'feature'`, `team_size` (0 = chamada única), `tie_becomes_question: true` | time paralelo é opt-in |
| `catalog` | `sources[]` (nome + commit pinado), `trust_default`, `max_skills_per_story` (3), `bm25_top_k` (8), `local_skills_win: true` | `docs/catalog-sources.md` |
| `harness` | `telemetry: true`, `collect_citation: true`, `doctor_probe_real_calls: boolean`, `ablation: false` | doctor v1 só coleta (digest #40 / J3 §7) |

Validação na ingestão por ajv; o digest JCS da config entra no `runtime_stamp`
(`<versão do engine>:<digest da config>`): mudar config no meio de uma missão com intenção aberta
levanta `stale_workflow_version` até `--accept-stale-version` (ADR 0021).

---

## 4. CLI

Exit codes herdados do runtime de referência (`scripts/tl_runtime.py` `main()`; mapa
`{done:0, in_progress:0, stopped:2, blocked:3}` e `Refusal(code=4)`, `code=5` para lease):

| Código | Significado |
| :-- | :--- |
| 0 | ok / idle (nada a fazer, ou execução em progresso sem parada) |
| 2 | stop / recusa (lote parado; cadeia de journal quebrada; entrada válida recusada por política) |
| 3 | concluído com paradas (unidades em `awaiting_operator`/`parked`/`blocked`) |
| 4 | entrada inválida (schema, campo desconhecido, plano que não valida) |
| 5 | lease em conflito (`coordinator_conflict`) |

| Comando | Argumentos | Efeito | Exits |
| :--- | :--- | :--- | :--- |
| `ade run <pedido>` \| `--plan <arquivo>` | `--mission`, `--max-units`, `--unattended`, `--accept-stale-version`, `--json` | compila (ou lê) o plano, adquire lease, executa até fechar/parar/idle | 0,2,3,4,5 |
| `ade plan <pedido>` | `--out`, `--class`, `--no-interview` | Intent Compiler até `plan.json`, sem executar | 0,2,4 |
| `ade approve <missão>` | `--yes` | grava `decision{option:'approve'}` e congela `immutable_digest` | 0,2,4 |
| `ade validate <plan>` | — | preflight read-only: ajv, regras de recusa, tetos de pack, capacidades | 0,4 |
| `ade status` | `--mission`, `--json` | projeção do fold do journal | 0,3 |
| `ade report [missão]` | `--out` | relatório de manhã derivado do journal | 0 |
| `ade journal [--unit]` | `--mission` | fold diagnóstico | 0 |
| `ade decide <unit> --option retry\|skip` | `--mission` | registra decisão do operador | 0,4,5 |
| `ade takeover <story>` | — | imprime o comando exato (`claude --resume <uuid>` + `--add-dir`/`--settings` reimpressos) e grava `human_takeover` | 0,4 |
| `ade release <story>` | — | checkpoint + `human_release`, retoma o ciclo | 0,4,5 |
| `ade discard <missão>` | `--yes` | move o lote inteiro para `refs/ade/discarded/`; nada é apagado | 0,4,5 |
| `ade show <ref>` | `--bytes` | drill-down de artifact bruto do Firewall | 0,4 |
| `ade eval <story>` | `--phase red\|green` | roda os evals do contrato fora do ciclo | 0,2,4 |
| `ade doctor` | `--probe`, `--fix` | mede capacidades (chamada real com `--probe`), `core.longpaths`, shims, canário de isolamento, `.git/info/exclude` | 0,2 |
| `ade catalog sync\|list\|inspect` | `--source`, `--id` | fetch + checkout do commit pinado, sha256 por arquivo, sanitização, quarentena | 0,2,4 |
| `ade serve` (v0.4) | `--port` | painel somente-leitura | 0 |
| `ade index --rebuild` (v0.4) | — | reconstrói o SQLite a partir do JSONL | 0 |

Toda saída `--json` é JCS canônico. Toda recusa imprime `{error, code}` em stderr.

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
    permitted_effects: EffectClass[]                            // fecha o conjunto de efeitos do lote
    estimated_cost_usd: number | null; cost_source: 'reported' | 'estimated' | 'unknown'
    new_skills: string[]                                        // primeira aparição no projeto
  }
  budget: { max_usd?: number; max_model_calls: number; max_wall_clock_seconds?: number; max_parked_units?: number }
  immutable_digest: string                                      // SHA-256 sobre JCS do plano sem este campo
}
interface Epic { id: string; title: string; stories: TaskContract[] }
```

**Regras.**

1. Cada story é um **Task Contract** (`architecture.md` §4), imutável após a aprovação.
2. `immutable_digest` é recalculado na abertura de toda missão e antes de todo step: divergência é
   recusa (exit 2), nunca execução. É o que impede "o plano mudou embaixo do lote".
3. `permitted_effects` é o **conjunto fechado** de `effect_class` que o lote pode produzir. Um step
   cuja classe não está autorizada nunca é despachado: vira `awaiting_operator` com o motivo
   (ex.: `local_commit is not permitted`). `safe` ⊂ `controlled` ⊂ `restricted`;
   `restricted` implica `ask_operator: ['*']` e nunca roda desatendido.
4. Validação de plano (`ade validate`, também no `run`) recusa: story sem eval por cenário; sem
   `do_not_touch`; sem `complexity`; com UI e sem `design_brief`; com `skills` fora do índice do
   catálogo; com estimativa de pack acima do teto (pede divisão); com `depends_on` cíclico.
5. `depends_on` é opcional: sem ele o scheduler é lista plana (digest #22 — o harness de longa
   duração da Anthropic não usa DAG). O DAG só existe quando o plano o declara.

---

## 6. Ciclo da story

**Fases** (ordem): `prepare` → `eval_red` → `implement` → `contain` → `gates` → *(`fqe` se há UI)* →
`eval_green` → `review` → *(`rework` ≤ N, volta a `implement`)* → `checker_gate` → `commit` →
`push` → `pull_request` → `ci` → `merge` → `complete`. Na v1 o ciclo termina em `commit`
(push/PR/merge entram na v0.2).

**Estados da story** (porte literal de `UNIT_STATES`): `ready`, `running`, `waiting`, `retryable`,
`parked`, `blocked`, `completed`, `failed`, `awaiting_operator`. Terminais: `parked`, `blocked`,
`completed`, `failed`, `awaiting_operator`.

| De | Para | Gatilho |
| :--- | :--- | :--- |
| `ready` | `running` | `next_ready` + reserva de orçamento + lease |
| `running` | `retryable` | falha transitória classificada `released` (nada efetivado) |
| `running` | `awaiting_operator` | `target_role:'human'` no review; ambiguidade de efeito externo; rede indisponível na retomada; empate de pesquisa; skill nova em lote desatendido; FQE sem consenso após 2 rodadas |
| `running` | `parked` | orçamento esgotado, `rework_limit_exhausted`, detector de loop, `no_checker_family_available`, canário de isolamento reprovado |
| `running` | `completed` | `complete` gravado com evidência |
| qualquer aberta | `blocked` | dependência em estado terminal não-`completed` |
| `awaiting_operator` | `retryable` \| `failed` | `ade decide --option retry|skip` |
| `parked`/`awaiting_operator` | `running` | `ade release` após `takeover` |

**Invariantes do ciclo.** (a) sessão nova por chamada, modelo fixo por papel, `Maker ≠ Checker` por
`model_id` (digest #3); (b) o Checker nunca escreve — `codex exec --sandbox read-only
--ignore-user-config --output-schema review-result.schema.json` na rodada, `claude -p --json-schema
… --permission-mode plan` no portão (I28 vira impossibilidade, J3 §5); (c) eval vermelho contra
`tree_before` é obrigatório salvo `strictness.mode = 'additive'`, que gera aviso registrado; eval que
nasce verde volta ao Intent Compiler, não ao Maker; (d) o relato do agente nunca conta — só evidência
executada (digest #37); (e) `contain` roda pós-fato sobre a árvore com precedência segurança >
`sensitive_paths` > escopo, `maxBuffer` explícito (o default de 1 MiB trunca a varredura de segredo
em silêncio); (f) o canário de isolamento por família roda **a cada chamada**: escrever fora do
worktree tem de falhar (digest #38); (g) git, `gh`, commit, push e merge são sempre do engine, nunca
do worker (I55).

---

## 7. Subsistemas e specs dedicadas

| Subsistema | Resumo de uma linha | Spec dedicada |
| :--- | :--- | :--- |
| Engine e durabilidade | journal JSONL com `prev` = 16 hex do SHA-256 sobre JCS, `fsync` por linha, escritor único; `step_intent`/`step_result`; reconciliação por `effect_class`; lease com fingerprint; recibo durável; worker não-detached (Job Object da libuv) | `docs/specs/engine-durability.md` |
| Intent Compiler | discovery determinístico → classificação → expansão em camadas → ≤5 perguntas (recusa pergunta respondível pelo repo; "não sei" = default registrado) → plano validado → resumo de aprovação; faixa rápida `trivial` | `docs/specs/intent-compiler.md` |
| Skill Fabric | catálogo curado, `index.json` com metadados fora do SKILL.md, filtro duro → BM25 top-8 → seletor ≤3 → bloco fixo do pack por id; SkillGuard (12 controles), sanitização em build time (ASR 36 % → 7,2 %, digest #34) | `docs/specs/skill-fabric.md` |
| Frontend Quality Engine | DesignBrief em 4 camadas; build → serve → Playwright (a11y, console, rede, estilos) → D1–D7 (D5 = `impeccable detect --json` contra URL renderizada) → juiz multimodal de outra família, rubrica de 6 critérios, corte 7,5, ≤2 rodadas | `docs/specs/frontend-quality-engine.md` |
| Adapters e Capability Registry | casca fina sobre flags nativas por família, parser tolerante a campo desconhecido, CLI falsa por família; CapabilitySet medido por `ade doctor`, roteamento por papel com primário + 2 fallbacks | `docs/specs/adapters-capability-registry.md` |
| Context Pack, Firewall, telemetria | pack em ordem de volatilidade com teto por seção e manifesto, sempre `{pack_path}` (digest #31); `run(argv) → {rawPath, extract}` com bruto em artifact e extrato ao modelo; telemetria por `model_call` com `skills_injected[].cited` | `docs/specs/context-firewall-telemetry.md` |
| Superfície do operador | CLI, `ade report`, fila de `awaiting_operator`, `takeover`/`release`/`discard`, painel-projeção v0.4 (toda ação vira step antes de virar efeito) | `docs/specs/operator-surface.md` |

---

## 8. Os oito schemas publicados

Todos com `additionalProperties: false`, `$id` estável e `format_version`. Campos completos em
`architecture.md` §4; aqui só o eixo de cada um.

| Schema | Eixo | Campos principais |
| :--- | :--- | :--- |
| `journal-event` | linha durável | `format_version`, `seq`, `at`, `prev`, `kind`, `effect_class`, `input_digest`, `intent_context`, `worktree`, `receipt_path`, `session_ref: string\|null`, `runtime_stamp` |
| `ade-config` | política do repositório | as 10 chaves de §3 |
| `plan` | lote aprovado | `phases[].epics[].stories[]`, `authorization{permitted_effects, autonomy}`, `budget`, `immutable_digest` |
| `task-contract` | uma story | `complexity`, `task`, `guardrails{scope_paths, do_not_touch, sensitive_paths, autonomy, ask_operator}`, `requirements[].ears`, `scenarios[].evals`, `evals[]`, `skills[≤3]`, `roles`, `design_brief?`, `budget` |
| `eval` | prova executável | `kind`, `cmd[]`, `expect_exit`, `timeout_s`, `max_output_bytes`, `evidence[]`, `strictness{mode}`, `author` |
| `unit-result` | resultado por story | `story_id`, `state`, `phase`, `round`, `tree_before`/`tree_after`, `eval_records[]`, `gate_records[]`, `commit?`, `passes`, `reason` |
| `review-result` | veredito do Checker | `verdict`, `action_items[]{severity, category, target_role, location, problem, evidence, required_action}`, `deferred[]`, `rejected[]`; `summary` **derivado**, nunca fonte (digest #32) |
| `capability-set` | uma família | `launch`, `transport`, `models[]`, `resume`, `fork`, `preminted_session_id`, `structured_output`, `budget_cap_native`, `image_in/out`, `sandbox`, `cost_report`, `advisor`, `unattended_flags[]`, `probe_ok`, `probed_at` |

`visual-eval` e `research-finding` ficam como JSON Schema inline enquanto houver um consumidor só;
promovem-se a publicados quando o painel (v0.4) passar a lê-los.

---

## 9. Estratégia de testes

| Camada | O que prova | Onde |
| :--- | :--- | :--- |
| **Unidade** | canonicalização, cadeia de hash, fold do journal, reconciliação por classe, lease, `dirty_paths -z` com rename, resolução de shims | Vitest, sem rede |
| **Byte-paridade do JCS** | `canonicalize_output_byte_identical_to_python_reference_fixture`: fixtures geradas pelo runtime Python; canonicalizador errado quebra a cadeia em silêncio (I02, J1 §3) | Vitest |
| **CLI falsa** | adapter por família com **transcript gravado** (stdout/stderr/exit real das CLIs) + contador de invocações **em disco**; cobre `no_result`, exit não-zero, JSON truncado, campo desconhecido, timeout | Vitest, zero custo, roda em CI sem credencial |
| **Paridade** | os 93 casos de `test_tl_runtime.py` (1 skip) portados caso a caso, **com tabela de mapeamento de nomes** onde o schema mudou de propósito (`review-result` rico, `plan`); 93/93 nos dois SOs é critério de saída da **v0.2**, não do Slice 1 (digest #1, J1 §5.3) | Vitest, Windows + Linux |
| **Matriz de crash × fase** | engine, worker, máquina e browser mortos em cada fase; o que reconcilia, o que fica `ambiguous`, o que vira checkpoint. Critério de aceite do Slice 1, não documentação | integração |
| **Fixtures de intenção** | pedidos reais → classe esperada, perguntas esperadas, recusa de pergunta respondível pelo discovery, eval verde de nascença devolvido ao compiler; alvo falsificável para EARS genérico ("THE SYSTEM SHALL work correctly" **precisa** reprovar) | Vitest + CLI falsa |
| **Fixtures de seleção de skills** | roteamento rank-1 e colisão de descrições, no framework de evals de `addyosmani/agent-skills` (`ref-addyosmani-agent-skills.md`); alvo `recall@8 ≥ 0,85`, `precision@3 ≥ 0,75` [hipótese] | Vitest |
| **FQE boa/ruim** | duas páginas fixas — uma que passa D1–D7 e uma com defeito plantado por portão — mais uma fixture de slop que o juiz tem de pontuar abaixo de 7,5; Impeccable pinado por `ENGINE_VERSION` (digest #19) | Playwright |
| **Dogfood** | a ADE fecha uma story dela mesma (Slice 1: adicionar um campo ao `journal-event`) com worktree, `contain` e checkpoint no lugar; progride até conduzir a própria missão (v1, jornada 6) | manual + journal |

**CI sem credencial.** Nada que exija assinatura roda em CI: `ade doctor --probe` faz chamada real,
custa dinheiro e só roda localmente; em CI o Capability Registry é lido de fixture. A suíte de
paridade custa ~11,7 s/caso em série (≈18 min): paraleliza por worker (J1 §5.4).

---

## 10. Riscos e mitigações

| # | Risco | Evidência | Mitigação na v1 |
| :-- | :--- | :--- | :--- |
| R1 | Slice 1 não cabe em 3 semanas: `tl_runtime.py` 2470 linhas + `tl_job.py` 2562 a portar | J1 §5.2 | escopo do Slice 1 = 10 testes nomeados e uma story trivial; paridade total é v0.2; medir o volume portado por semana e replanejar [hipótese] |
| R2 | Eval escrito pelo próprio Maker na faixa rápida não é prova independente | J2 §3 (A-1) | `author: 'maker'` gravado no journal + portão `tree_before` mantido; telemetria mede defeitos escapados da classe `trivial` |
| R3 | EARS genérico passa na validação de forma e não discrimina | J1 §4 (C-3) | fixtures de intenção com casos que **precisam** reprovar; eval verde de nascença volta ao compiler |
| R4 | Escrita fora do worktree não detectada (`bypassPermissions`, sem sandbox de SO no Windows) | digest #8, #37, #38 | canário de isolamento por família a cada chamada; `contain` pós-fato; env filtrado (I49) como cerca real — `--disallowedTools` é glob best-effort |
| R5 | Saída de ferramenta hostil como vetor de injeção ("falha nunca é resumida" entrega log íntegro) | J3 §4 | Firewall cerca a falha como **dado** com delimitador e aviso; bruto em artifact; `ade show` para drill-down |
| R6 | Supply chain de skills (ToxicSkills: 36,8 % com falha, 91 % por injeção) | digest #12, #34 | pin por commit + sha256 por arquivo, licença por skill, sanitização estática em build time, frontmatter removido antes da injeção, quarentena, engine nunca executa script |
| R7 | Custo estrutural: piso de 19,4k do Codex por chamada de Checker; diff de 200 000 chars | digest #27, J3 §6 | `--ignore-user-config` sempre; `limits.max_diff_bytes` explícito com ponteiro de drill-down |
| R8 | Ablação do harness doctor é cega no braço Codex (sem USD; `claude plugin eval` só no braço Claude) | digest #28, J3 §7 | doctor v1 **só coleta**; `cost_source: 'estimated'` via `~/.ade/prices.json`; ablação pareada fica para pós-v1 com o ponto cego declarado |
| R9 | A ADE se atualiza durante a própria missão (dogfood) | J1 §5.6 | `runtime_stamp` = engine + digest da config; divergência em intenção aberta = `stale_workflow_version` até `--accept-stale-version` (ADR 0021) |
| R10 | Worker morre com o engine (não-detached): uma chamada paga perdida por crash | `architecture.md` §6 | árvore suja vira checkpoint, chamada vira `ambiguous`, próximo Maker continua; detached + recibo anexável é upgrade |
| R11 | Windows: MAX_PATH em `.ade/wt/<id>` com `node_modules` profundo; handle preso em `git worktree remove` | J1 §5.7 | worktree em caminho curto, `core.longpaths=true` no doctor, retry com backoff na remoção, sweep de órfãs |
| R12 | Tetos de pack (40k/7,5k/6k/1,5k) são chute | digest, "Hipóteses assumidas" | telemetria por seção; ajustar por p90 no dogfood [hipótese] |

---

## 11. O que mudou em relação à spec v2

Tabela de `architecture.md` §8 expandida com o ADR que fixa cada mudança.

| Spec v2 | v3 | Motivo (evidência) | ADR |
| :--- | :--- | :--- | :--- |
| 3 famílias na v1 (`gemini`/`antigravity` por binário) | 2 famílias (claude, codex); Google = `agy` na v0.x, pesquisa e fallback de Checker; `Maker ≠ Checker` por `model_id` | binário `antigravity` não existe; `agy` serve modelos Claude; Gemini CLI exige API key (#2, #3) | 0005 |
| `codex review` como Checker; "Codex = melhor revisor" | Checker de rodada Codex (precisão) / de portão Claude (cobertura), via `exec --output-schema` | CR-bench 32,1 % vs 20,1 %; `--output-schema` ignorado em `review` (#5, #6) | 0006 |
| Painel com PTY na v1; SQLite; Fastify | painel-projeção somente-leitura na v0.4; `ade takeover` por comando; PTY v0.5+ | node-pty sem 1.2.0 estável, bug #967 (#29); curva de valor | 0013 |
| Sem advisor nativo; protocolo de saída estruturada por prompt | `--advisor`, `--json-schema`, `--output-schema`, `--max-budget-usd`, `--session-id` nativos | (#4, #10, #11) | 0004 |
| 4 rodadas visuais, corte 8, avaliador barato, fontes banidas | 2 rodadas, corte 7,5, juiz forte de outra família, o brief vence, Impeccable pinado por `ENGINE_VERSION` | Impeccable 4.3.1 normativo; banda calibrada (#16–#19) | 0010 |
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

## 12. Divergências propostas

Objeções a `docs/architecture.md`. **Nenhuma decisão foi alterada nesta spec**; a revisão adversarial
decide.

1. **`passes` dentro de um contrato imutável é contradição de campo.** `architecture.md` §4 declara
   o Task Contract "imutável após aprovação" e, no mesmo bloco, `passes: boolean` como "ÚNICO campo
   gravável pelo agente". Um artefato congelado por `immutable_digest` (§5 desta spec) não pode ter
   campo gravável: ou o digest quebra a cada story fechada, ou `passes` é ignorado na verificação — e
   aí a imutabilidade é parcial e não declarada. Evidência: digest #22 diz que o harness da Anthropic
   usa *uma lista plana com um único campo gravável*, mas essa lista **é** o estado mutável, não o
   contrato. **Proposta:** `passes` vive só em `unit-result` (que já o carrega, §8) e sai do
   `task-contract`.

2. **`probe_ok: boolean` não expressa "não sondado".** `capability-set` exige `probe_ok` booleano e
   `probed_at`. Em CI (Linux, sem assinatura) nenhuma sondagem real acontece (J1 §5.4: as sondas de
   `ade doctor` fazem chamada real, custam dinheiro e exigem assinatura), e `probe_ok: false` é
   indistinguível de "família quebrada" — o que faria o roteamento degradar para fallback
   silenciosamente na própria suíte de paridade. **Proposta:** `probe_ok: boolean | null` com `null`
   = não sondado neste ambiente, e recusa de despacho (não degradação) quando `null` fora de CI.

3. **A forma nua `ade "<pedido>"` está prometida e não está na CLI.** `architecture.md` §5.1 abre o
   fluxo com `ade "corrija o botão de login"` e o roadmap da v0.3 promete `ade "<pedido>"` ponta a
   ponta, mas a lista fixa de comandos não tem forma nua — e `parseArgs` do `node:util` despacha por
   subcomando. Implementar as duas formas sem regra explícita cria ambiguidade real (um pedido que
   começa com a palavra `status` ou `report`). **Proposta:** `ade run <pedido>` é canônico e a forma
   nua é açúcar aceito **apenas** quando o primeiro token não casa com nenhum comando conhecido e o
   pedido tem espaço em branco; caso contrário, exit 4 com sugestão.

4. **`max_diff_bytes` herdado (200 000 chars ≈ 50k tokens) não aparece na arquitetura.** J3 §6 e §10
   item 5 apontam que as três propostas o herdaram sem revisão e que ele custa ~50k de entrada por
   rodada, por Checker, numa story grande. `architecture.md` fixa tetos de pack mas não este.
   Incluí-o em `limits` (§3) é decisão minha e precisa de veredito: **proposta:** default 60 000
   chars com ponteiro de drill-down (`ade show`), medido no dogfood antes de fixar.

5. **`visual-eval` tem dois consumidores desde a v0.4 e continua inline.** `architecture.md` §4
   mantém `visual-eval` e `research-finding` inline "enquanto houver um consumidor só", mas o FQE
   produz o registro e o painel-projeção (v0.4) o lê, além do `ade report`. **Proposta:** promover
   `visual-eval` a nono schema publicado **na v0.4**, junto com o painel, para não migrar formato com
   missões gravadas em disco.

6. **O Slice 1 não tem orçamento de porte medido.** J1 §5.1 e §5.2 registram que nenhuma proposta
   estimou dias ou volume, e o roadmap fixa "~3 semanas" sobre 5.032 linhas de Python de referência.
   O número é [hipótese] sem medição. **Proposta:** o primeiro critério de saída da semana 1 do Slice
   1 é uma medição de linhas portadas por dia, com replanejamento explícito do roadmap se a
   extrapolação estourar as 3 semanas — não um aviso no fim.
