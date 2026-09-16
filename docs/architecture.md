# TL-ADE — Arquitetura (v3, 2026-09-17)

Documento canônico da arquitetura. Substitui a spec v2 (`docs/specs/2026-09-16-ade-design.md`, agora
histórica). Nasce de `docs/research/README.md` (40 premissas derrubadas) e do painel de arquiteturas
(`docs/research/design-panel/`): base é a proposta A (mínima, alavanca nativa), com enxertos nomeados
de B (durabilidade, matriz de crash, slice 1 como plano de teste) e de C (Task Contract, DesignBrief,
regras de recusa). Cada decisão relevante tem ADR em `docs/adr/`. Detalhes por componente em
`docs/specs/`. Roadmap em `docs/roadmap.md`.

## 1. Tese

A ADE é um **scheduler durável + compilador de contexto + compilador de intenção**. Todo o resto é
consumo de capacidade nativa já verificada nos binários instalados: `claude -p --json-schema
--session-id --max-budget-usd --safe-mode`, `codex exec --json --output-schema --sandbox read-only
--ignore-user-config`, `impeccable detect --json`, `$imagegen`, `claude plugin eval`, `--advisor`.
Só três coisas são insubstituíveis e são código próprio: (1) o journal com write-ahead, cadeia de hash
e reconciliação por classe de efeito (66 invariantes do runtime v0.17.0, portados literalmente);
(2) o Task Contract com eval provado vermelho antes e verde depois; (3) o Context Pack com ordem
fixa, tetos e manifesto. Otimiza tempo até a primeira story rodar sozinha e superfície de manutenção.
Sacrifica na v1: painel com PTY, ACP, concorrência N>1, catálogo de centenas de skills, time de
pesquisa paralelo, rotinas. Todos reversíveis porque o engine e os contratos já carregam os campos.

Princípio operacional: **o portão substitui o humano; o modelo não** (Orca: ~30 portões nomeados e
8.858 arquivos de teste substituem revisão linha a linha — o humano permanece no merge; não há
declaração pública de fração escrita por IA. Gas City sem malha: 23 % de CI verde). E o gargalo de missões longas é instruction
following (SWE-EVO, >60 % das falhas), não janela: o investimento vai para o contrato, não para o
orquestrador.

## 2. Visão geral

```
 operador ──► ade (CLI) ──► Intent Compiler ──► Plan (Task Contracts) ──► aprovação única
                 │                                                            │
                 ▼                                                            ▼
        ┌─────────────────────────── engine (Node, um processo) ────────────────────────┐
        │ Scheduler ─► Step(write-ahead) ─► Runner ─► Adapter(claude|codex|agy) ─► CLI │
        │      ▲            │  journal.jsonl (hash chain, fsync)   │   worktree/story   │
        │      │            ▼                                      ▼                    │
        │  Reconciler   Pack compiler ◄── Skill Fabric ◄── catálogo   Contain / Gates   │
        │      │        Tool Output Firewall ──► artifacts/          Eval runner        │
        │      └── Capability Registry ── ade doctor ──── FQE (Playwright + Impeccable)  │
        └────────────────────────────────────────────────────────────────────────────────┘
                 │ projeção (v0.4+)                          estado: <repo>/.ade/  ~/.ade/
                 ▼
        painel web somente-leitura (Chat · Missão · Log) ── `ade takeover` (v1: comando impresso)
```

Estado por repositório em `<repo>/.ade/` (config, missões, journals, artifacts, worktrees em
`.ade/wt/<story>`). Estado global em `~/.ade/` (catálogo, registry de capacidades, telemetria).
Nada em `.ade/` entra em commit (`.git/info/exclude`).

## 3. Componentes

| # | Componente | Responsabilidade | Código próprio vs nativo | v1 |
| :-- | :--- | :--- | :--- | :-- |
| C1 | Journal | JSONL append-only, `prev` = 16 hex do SHA-256 da linha anterior sobre JSON canônico (RFC 8785 via `canonicalize`), `fsync` por linha, escritor único serializado | próprio (porte I01–I06) | v1 |
| C2 | Step + Reconciler | `step_intent` antes do efeito, `step_result` depois, `input_digest`, `intent_context`; tabela fechada de reconciliação por `effect_class` (I07–I17) | próprio (porte) | v1 |
| C3 | Lease | `mkdir` + heartbeat em `worker_thread` a cada 2 s + TTL 15 s [hipótese, medir no slice 1] + fingerprint (pid, start time); exit 5 em conflito; regra dura: nenhuma chamada externa síncrona no engine | próprio (~60 linhas; `proper-lockfile` abandonado) | v1 |
| C4 | GitPort | uma instância por worktree (nunca singleton), `worktree_tree` com índice racy, `dirty_paths -z` com os dois lados de rename, checkpoint/descarte em `refs/ade/...` | próprio sobre `git` | v1 |
| C5 | Runner | spawn com `env` explícito filtrado (I49), recibo durável em disco com fingerprint anti-reuso de PID, `cwd` no worktree, kill por `taskkill /T /F /PID` (nunca `pty.kill`), Job Object herdado do libuv (filho não-detached) | próprio | v1 |
| C6 | BinaryResolver | resolve o `.exe` real atrás dos 3 shims npm; `spawn` de `.cmd` só via `cmd.exe /c` | próprio | v1 |
| C7 | Contain | pós-fato sobre a árvore: segurança (segredos no diff integral, `maxBuffer` explícito) > `sensitive_paths` > `scope_paths`/`do_not_touch`; canário de isolamento por família (escrever fora do worktree tem de falhar) | próprio (porte I22–I26) + canário novo | v1 |
| C8 | Gate runner | gates sempre/por flag sobre a árvore do Maker, cache por árvore, restauração de sobras; saída passa pelo Firewall | próprio (porte I31–I32) | v1 |
| C9 | Eval runner | `eval_run{phase: red|green|strictness}` como classe de efeito; vermelho contra `tree_before` obrigatório salvo `strictness.mode = additive`; eval que nasce verde volta ao Intent Compiler | próprio, novo | v1 |
| C10 | Pack compiler | seções em ordem fixa por volatilidade, teto por seção com ponteiro, teto global, redação de segredos pós-montagem, manifesto como evidência; sempre `{pack_path}` | próprio (porte, seções novas) | v1 |
| C11 | Tool Output Firewall | `run(argv) → {rawPath, extract}`: bruto vira artifact; o modelo recebe extrato (falhas íntegras, sucesso resumido) + ponteiro de drill-down; saída de ferramenta é dado não confiável (cerca inbound) | próprio; hooks das CLIs só como reforço | v1 |
| C12 | Adapters | bespoke headless: `claude`, `codex`; `agy` para pesquisa é **opcional na v1 atrás do canário de isolamento** (`probe_ok: true` + canário verde ⇒ habilitado; senão a pesquisa roda em `claude`, sem terceira opinião e sem time paralelo de famílias diferentes). Casca fina sobre flags nativas + parser tolerante a campos desconhecidos + CLI falsa por família | próprio, fino | v1 (2) |
| C13 | Capability Registry | JSON por família com `probe_ok/probed_at` medidos por `ade doctor` com chamada real; roteamento por papel com primário + até 2 fallbacks (conforme famílias com `probe_ok: true`); Maker ≠ Checker por `model_id` | próprio, pequeno | v1 |
| C14 | Scheduler | lista de stories com `depends_on` opcional (DAG só quando o plano declara); `next_ready` devolve conjunto (N-capaz), N=1 na v1 (N>1 pós-v1); reserva de orçamento; `blocked` por dependência parada; `--unattended` recusa sem precondições (A5) | próprio (~80 linhas) | v1 |
| C15 | Intent Compiler | context discovery determinístico (git, rg, manifestos) → classificação de complexidade → expansão em camadas → ≤5 perguntas (recusa pergunta respondível pelo discovery; "não sei" = default registrado) → plano de Task Contracts validado por ajv → resumo de aprovação | próprio + 1–2 chamadas com `--json-schema` | v1 |
| C16 | Skill Fabric | catálogo curado (60–80), `index.json` com extensão fora do SKILL.md, filtro duro por domínio → BM25 top-8 (~80 linhas, $0) → seletor barato ≤3 → bloco fixo do pack ordenado por id estável; SkillGuard (12 controles) | próprio | v1 |
| C17 | Frontend Quality Engine | DesignBrief em 4 camadas no contrato; build → serve → a11y snapshot + console + rede + `impeccable detect --json` (URL renderizada) → portões determinísticos D1–D6 (todos dependentes de render; lint anti-slop vive no Gate runner C8) → juiz multimodal de outra família (anti-ancoragem, pinado por `model_id`) → ≤2 rodadas, corte 7,5; `$imagegen` para assets | próprio orquestrando Playwright (lib) + Impeccable pinado | v0.4a (D1–D6 + juiz; conjunto bloqueante calibrado no dogfood) |
| C18 | Pesquisa | step `research`: uma chamada com schema por incógnita declarada (classe ≥ feature); time paralelo somente-leitura (2–4) opt-in; empate vira pergunta; achado é dado; **pack sintético** (só a incógnita declarada e termos derivados dela — nunca excerpt do repo, contrato ou diff) em worktree descartável vazio, porque é o único papel com rede de propósito e não há fence de egresso em nenhuma família (eval `research_pack_contains_no_repository_content`) | próprio, fino | v1 (simples) |
| C19 | Telemetria + harness doctor | evento por `model_call` no journal (tokens, cache, custo com `cost_source`, pack por seção, `skills_injected[{name,bytes,cited,sha256,source}]`); doctor v1 só coleta e relata | próprio | v1 (coleta) |
| C20 | Painel | projeção do journal via índice SQLite reconstruível + WebSocket; Chat · Missão · Log; toda ação do painel vira step | próprio | v0.4 |
| C21 | Takeover | v1: `ade takeover <story>` imprime o comando exato (`claude --resume <uuid>` + `--add-dir`/`--settings`) e grava `human_takeover`; `ade release` grava checkpoint e retoma o ciclo. PTY embutido: v0.5+ | próprio | v1 (CLI) |
| C22 | Entrega | commit/push/PR/merge executados pelo engine (worker nunca roda git/gh), `gh` com fixtures por versão, merge commit, reconciliação contra remoto; rede indisponível na retomada = `awaiting_operator` | próprio (porte I33–I40) | v1 (commit local); push/PR v0.2 |
| — | Cortados da v1 | ACP, N>1, PTY/node-pty, CI loop, rotinas, 4º provider, Graft (opcional v0.x), memória por usuário, MCP de browser, pixel-diff, ultrareview no loop, `codex review`, avaliador barato, banimento absoluto de fontes, ablação automática, OTel export | — | — |

## 4. Contratos

Oito schemas publicados (`schemas/*.schema.json`, validados com ajv): `journal-event`, `ade-config`,
`plan`, `task-contract`, `eval`, `unit-result`, `review-result`, `capability-set`. `visual-eval` e
`research-finding` são JSON Schema inline enquanto houver um consumidor só.

```ts
type Complexity = 'trivial' | 'bounded' | 'feature' | 'subsystem' | 'project'

interface TaskContract {                 // uma story = um contrato; imutável após aprovação
  id: string; title: string
  complexity: Complexity
  task: string                            // o quê e por quê, nunca o como
  guardrails: { scope_paths: string[]; do_not_touch: string[]; sensitive_paths?: string[]
                autonomy: 'safe' | 'controlled' | 'restricted'; ask_operator?: string[] }
  requirements: { id: string; ears: string }[]          // "WHEN … THE SYSTEM SHALL …", 1:1 com eval
  scenarios: { id: string; given: string; when: string; then: string; evals: string[] }[]
  evals: Eval[]                            // obrigatório; ≥1 por cenário
  skills: string[]                         // ids do catálogo, ≤3, decididos no prepare
  roles: { maker: ModelRef; checker_round: ModelRef; checker_gate?: ModelRef; judge?: ModelRef }
  design_brief?: DesignBrief               // obrigatório quando há UI
  research_refs?: string[]
  unknowns?: { id: string; question: string; kind: 'product_choice' | 'external_fact' | 'repo_fact'
               resolved_by?: 'operator' | 'research' | 'discovery' }[]   // E48: incógnitas da entrevista
  depends_on?: string[]
  budget: { max_model_calls: number; max_rework_rounds: number; max_usd?: number }
  // sem `passes` (E1): o contrato é imutável após aprovação; o veredito vive em `unit-result` e o
  // estado da story no journal (`unit_state`). `max_usd` só é aplicável quando a família do papel
  // reporta custo (`cost_source: 'reported'`); ver §7 Contexto, Firewall e telemetria.
}

interface Plan {                           // plan.schema.json; gravado no batch_open
  id: string; mission_id: string; immutable_digest: string
  authorization: { autonomy: 'safe' | 'controlled' | 'restricted'; permitted_effects: string[] }  // só efeitos externos (E3)
  mission_budget: { max_wall_clock_seconds: number; max_parked_units: number; max_usd?: number }
  eligible_skills: string[]                // união do top-8 por story, congelada na aprovação (E33)
  stories: TaskContract[]
}

interface Eval {
  id: string; kind: 'test' | 'contract' | 'negative' | 'lint' | 'typecheck' | 'build' | 'visual' | 'repro' | 'custom'
  cmd: string[]; cwd?: string; expect_exit: number; timeout_s: number; max_output_bytes: number
  evidence: string[]                       // caminhos/globs gravados como artifact
  strictness: { mode: 'must_fail_before' | 'additive' | 'mutate'; note?: string }
  author: 'intent_compiler' | 'maker' | 'operator'
}

interface DesignBrief {                    // convergência Impeccable + frontend-design + Vercel design.md
  product: string                          // durável: produto, público, verdade factual
  tokens: string                           // DESIGN.md: paleta (dominante + acentos, CSS variables), tipografia, espaçamento
  surface_mode: 'persuade' | 'operate' | 'read' | 'experience'
  direction: { name: string; signature: string; self_critique: string }   // o brief vence o guardrail
  guardrails_default: string[]             // defaults penalizados, exceto os hard_bans
  hard_bans: string[]                      // lista fechada e não configurável, veto absoluto que nenhum brief recompra
                                           // hoje: 'kicker-above-heading', 'hero-eyebrow-chip' (citação literal do Impeccable; ajv por `const`)
}

interface JournalEvent {                   // step-journal.schema.json v1 + campos aditivos
  format_version: 1; seq: number; at: string; prev: string
  kind: 'batch_open' | 'step_intent' | 'step_result' | 'unit_state' | 'attempt' | 'recovery' | 'decision' | 'note' | 'batch_state' | 'telemetry'
  effect_class?: 'none' | 'model_call' | 'local_write' | 'local_commit' | 'local_merge' | 'push' | 'pull_request'
               | 'pull_request_merge' | 'ci_query' | 'ci_rerun' | 'eval_run' | 'visual_eval' | 'research' | 'human_takeover' | 'human_release' | 'catalog_sync'
               | 'gate' | 'prepare'       // E6
  worktree?: string; receipt_path?: string; session_ref?: string | null   // null quando o transporte não pré-cunha id
  source?: 'operator' | 'engine'           // obrigatório em kind: 'decision' (E11)
  runtime_stamp: string                    // <core_version>:<config_digest>:<capabilities_digest> (E7);
                                           // só core_version divergente bloqueia com stale_workflow_version
}

interface UnitResult {                     // unit-result.schema.json; o veredito da story
  story_id: string; verdict: 'passed' | 'failed' | 'parked'; evidence: string[]
  sources: string[]                        // digests das seções do pack usadas (E8); sem isso `cited` é sempre falso
}

interface ReviewResult {                   // forma rica do runtime de referência; summary derivado
  verdict: 'approved' | 'changes_requested'
  action_items: { id: string; severity: 'critical' | 'high' | 'medium' | 'low'
                  category: 'patch' | 'bad_spec' | 'intent_gap'; target_role: 'maker' | 'planner' | 'human'
                  location: string; problem: string; evidence: string; required_action: string }[]
  deferred: Finding[]; rejected: Finding[]
  sources: string[]                        // obrigatório (E8), mesma semântica de unit-result
}

interface CapabilitySet {                  // uma por família; medida, nunca declarada à mão
  id: string; family: string; launch: { cmd: string; args: string[]; env: Record<string, string> }
  transport: 'cli' | 'acp'
  models: { id: string; vendor: string; context_window: number | null; effort: string[] }[]   // vendor derivado por prefixo (E10)
  resume: 'reconnect' | 'replay' | 'reprompt' | 'none'; fork: boolean; preminted_session_id: boolean
  structured_output: 'schema_inline' | 'schema_file' | 'none'; budget_cap_native: boolean
  image_in: boolean; image_out: boolean; tools_allowlist: boolean; sandbox: 'os' | 'restricted_token' | 'none'
  cost_report: 'usd' | 'tokens' | 'none'; advisor: boolean
  unattended_flags: string[]; probed_at: string
  probe_ok: boolean | null                 // null fora de CI recusa despacho, nunca degrada (E10)
  probe_mode: 'real' | 'help_only' | 'fixture'
  bootstrap_cost_tokens: number | null     // piso medido por família; entrada da estimativa de custo do resumo de aprovação
}

interface SkillIndexEntry {                // ~/.ade/catalog/index.json; SKILL.md upstream fica byte-idêntico
  id: string; source: string; commit: string; sha256: string; license: string | 'unknown'
  name: string; description: string; when_to_use?: string
  domains: string[]; languages: string[]; families: string[]; tags: string[]
  body_tokens: number; has_scripts: boolean; trust: 'local' | 'allowlisted' | 'quarantine'
  disable_model_invocation?: boolean
}

interface Telemetry {                      // kind: 'telemetry', um por model_call
  mission_id: string; story_id: string; step_id: string; family: string; role: string; effort: string
  models: { role: 'executor' | 'advisor'; model_id: string }[]   // E66: Maker ≠ Checker vale para todo papel da chamada
  duration_ms: number; tokens_in: number; tokens_out: number; cache_read: number; cache_write: number
  cost_usd: number | null; cost_source: 'reported' | 'unknown'   // sem 'estimated' (I45): uso não observado é unknown
  cost_basis: 'list' | 'invoice' | null    // 'reported' do Claude é preço de tabela (costBasis: "list"), não fatura
  pack_bytes: number; pack_sections: { section: string; bytes: number; digest: string }[]
  skills_injected: { name: string; bytes: number; cited: boolean; sha256: string; source: string }[]   // E59: source = catalog@<commit> | local
  tool_output_raw_bytes: number; tool_output_model_bytes: number
  outcome: 'ok' | 'retry' | 'rework' | 'park' | 'stop'; ttft_ms: number | null   // E11; `compaction_events` saiu (E67)
  approval_decisions: number; network_attempts: number; files_touched: number                               // A2
  scope?: 'mission_summary'                // evento de fechamento: intervenções, perguntas, wall time, verbos de CLI usados (E11)
}
```

## 5. Fluxo de uma missão

1. **Pedido** (`ade "corrija o botão de login"` ou painel). Zero conhecimento operacional exigido.
2. **Context discovery** (determinístico, antes de qualquer modelo): manifestos, linguagens, testes existentes, `DESIGN.md`/`PRODUCT.md`, rotas, CI, `.ade/config.json`, missões anteriores. Produz um mapa curto que torna "pergunta respondível pelo repo" detectável.
3. **Classificação** (uma chamada barata com `--json-schema`, custo medido por chamada; fallback para regra determinística por tamanho do diff estimado): `complexity`, domínios, incógnitas declaradas, presença de UI.
4. **Faixa rápida** (`trivial`): sem entrevista, sem pesquisa, auto-aprovação; Maker recebe contrato mínimo e escreve o eval (`author: 'maker'`) com portão `tree_before` mantido; Checker de rodada só se o diff tocar mais de N arquivos. Requisito com eval próprio: ≤30 s até a primeira edição de arquivo-fonte, 0 perguntas, ≤2 chamadas.
5. **Expansão em camadas** (`bounded`+): intenção → resultados observáveis → restrições → critérios EARS → cenários → evals → DesignBrief quando há UI. Uma chamada forte com `--json-schema`.
6. **Pesquisa** só com incógnita declarada e classe ≥ `feature`: uma chamada com schema (`agy --json-schema` quando disponível; senão `claude`). Time paralelo (2–4, famílias diferentes, somente-leitura) opt-in por config. Empate vira pergunta. Achado é dado, nunca instrução.
7. **Entrevista** ≤5 perguntas, múltipla escolha com recomendação primeiro; validação recusa pergunta cuja resposta está no discovery; "não sei" grava o default e vira incógnita registrada no contrato.
8. **Plano**: fases → epics → stories como Task Contracts, validado por ajv (recusa: story sem eval por cenário, sem `do_not_touch`, sem classe, sem brief com UI). Tamanho de story limitado pelo teto de pack (recusa e pede divisão).
9. **Aprovação única**: o que será feito e o que não, custo estimado (com `cost_source`), skills novas no projeto, efeitos externos autorizados, nível de autonomia. `restricted` nunca roda desatendido (`ask_operator: ['*']`).
10. **Ciclo por story** (sessão nova por chamada, modelo fixo): `prepare` (worktree, skills, pack) → `eval_run:red` → `implement` (Maker) → `contain` + canário → `gates` → `eval_run:green` → `review` (Checker de rodada, outra família, `--sandbox read-only`) → `rework` ≤N → `checker_gate` (cobertura, antes do merge) → `commit` → `push` → `pull_request` → `merge` → `complete`. Story de UI insere o loop do FQE entre `gates` e `review`.
11. **Escalação**: `target_role: 'human'` é o único gatilho semântico; orçamento, loop, estagnação, empate e rede são gatilhos determinísticos. Destino único: fila de `awaiting_operator` com motivo, opções `retry`/`skip`/`takeover`/`discard`.
12. **Manhã**: `ade report` (derivado do journal: feito, mudado, evidência, notas visuais lado a lado, decisões pendentes, custo) e `ade discard <missão>` (descarta o lote inteiro em um comando; nada é apagado, tudo vai para `refs/ade/discarded/`).

**Classes de complexidade e processo liberado**

| Classe | Perguntas | Pesquisa | Plano | Checker | FQE | Concorrência |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| trivial | 0 | não | contrato mínimo | só se diff > 1 arquivo-fonte (config `fast_lane.checker_threshold_files`) | detector só; achado vira `note` no journal e **nunca bloqueia**, e o spawn conta no alvo de 30 s | — |
| bounded | ≤2 | não | 1–3 stories | rodada | D1–D6 + juiz se UI (o render já foi pago; nenhum portão `critical` é pulado) | — |
| feature | ≤5 | se incógnita | 4–8 stories, 1 epic | rodada + portão | completo | — |
| subsystem | ≤5 | sim | 9–20 stories, epics | rodada + portão | completo | — (N opt-in pós-v1) |
| project | ≤5 | time | fases, epics, stories | rodada + portão | completo | — (N opt-in pós-v1) |

A jornada 6 ("continue enquanto durmo") não é classe: é missão com `autonomy` e orçamento de parede
(`max_wall_clock_seconds`, `max_parked_units`), que retoma sem nova entrevista e para em
`awaiting_operator` ao esgotar o backlog aprovado.

## 6. Durabilidade

Porte literal de I01–I66 (`docs/research/runtime-port-map.md` §1). Mudanças:

- **Novas classes de efeito**: `eval_run`, `visual_eval`, `research`, `human_takeover`, `human_release`, `catalog_sync`; cada uma com regra de reconciliação (todas `released` exceto `model_call`-like, que seguem a regra do `model_call`).
- **Worker não-detached na v1**: morre com o engine (Job Object do libuv), a chamada vira `ambiguous`, a árvore suja vira checkpoint e o próximo Maker continua. Perde-se uma chamada paga em crash do engine; ganha-se contenção de árvore de processos de graça e um único modo de falha. Detached + recibo "anexável" é upgrade quando um addon nativo trouxer Job Object próprio.
- **Recibo durável** em `<state>/jobs/<step>.json` com fingerprint (unit, authorization, cwd, argv, timeout, result_file, pid, start_time): reconciliação rejeita PID reciclado.
- **Lease** com fingerprint: lease morto-vivo após reboot é detectado e adotado só quando o processo dono não existe com o mesmo start time.
- **Git por worktree** desde o dia 1, campo `worktree` no evento: N>1 vira scheduler, não migração.
- **Matriz de crash × fase** (engine, worker, máquina, browser) é critério de aceite do slice 1, não documentação.
- **Rede indisponível na retomada** (push/PR): `awaiting_operator`, nunca retry.
- **Versão do journal**: `format_version` só sobe com migração explícita; `runtime_stamp` divergente numa intenção aberta para a missão (`stale_workflow_version`) até `--accept-stale-version`. A ADE em dogfood nunca muda o engine embaixo de uma missão sem passar por isso.
- **Windows**: `{pack_path}` sempre (lpCommandLine 32.767); worktrees em caminho curto (`.ade/wt/<id>`), `core.longpaths=true` no doctor; shims resolvidos; `spawn(...,{shell:false})` com `.exe` real.

## 7. Subsistemas

**Adapters e transporte.** Bespoke headless na v1 porque três garantias do write-ahead não existem no
ACP v1: id de sessão pré-cunhado (`--session-id`), saída por schema (`--json-schema`/`--output-schema`)
e teto de orçamento a priori (`--max-budget-usd`). `session_ref: null` no evento e `transport` no
CapabilitySet deixam a migração para ACP por família reversível e honesta no journal. Gatilho para
ACP: steering no meio do turno (RFD `session/inject` estável) ou 4º provider. `agy` é opcional já na v1 para
pesquisa, atrás do canário de isolamento (`--json-schema` coage; escreve fora do `--add-dir`: só
somente-leitura até o canário passar). Leitura única: `probe_ok: true` + canário verde ⇒ habilitado;
senão o `ade doctor` degrada o papel de pesquisa para `claude` e registra a degradação — a v1 não
promete duas famílias de pesquisa, e o time paralelo (famílias diferentes) fica indisponível sem `agy`.
O Gemini CLI (`gemini`) não faz parte da ADE: a família Google é o Antigravity CLI (`agy`), que
Erick usa e tem autenticado; `gemini` exigiria API key e não é usado. Chamadas curtas no Codex sempre com
`--ignore-user-config`: os ~19,4k tokens de entrada medidos num prompt trivial são o piso **sem** poda
(instruções do sistema + `AGENTS.md` do usuário + catálogo de skills); `--ignore-user-config` +
`AGENTS.md` mínimo é a mitigação, e o piso resultante só existe depois de medido pelo `ade doctor`
(`bootstrap_cost_tokens`, E10) — até lá nenhuma estimativa de custo do Checker é publicada.

**Checker.** Rodada (precisão, gera rework): Codex `codex exec --json --sandbox read-only
--ignore-user-config --output-schema review-result.schema.json`. Portão (cobertura, antes do merge):
Claude `claude -p --json-schema ... --permission-mode plan`. Nunca `codex review`. Checker não escreve
(I28 vira impossibilidade). `no_checker_family_available` → `parked`, nunca aprovado sem revisão.
Maker ≠ Checker por `model_id`. `claude ultrareview` é portão opcional pré-merge (cota, 5–10 min).

**Eval-first.** Eval nasce no contrato (`author`), roda vermelho contra `tree_before` (`must_fail_before`)
e verde contra `tree_after`; `additive` só gera aviso registrado (mudança puramente aditiva); `mutate`
reservado. Eval que nasce verde devolve a story ao Intent Compiler, não ao Maker. `EvalRecord` é
evidência do journal. O relato do agente nunca conta: um `claude -p` pode reportar sucesso após
ferramenta bloqueada (medido).

**Skill Fabric.** Fontes com licença conhecida e allowlist (ver `docs/catalog-sources.md`);
`docx/pdf/pptx/xlsx` da Anthropic e `openai/skills` na denylist por licença. Sync = fetch + checkout
do commit pinado (nunca pull), sha256 por arquivo, `skills-ref validate`, sanitização estática em
build time (ASR 36 % → 7,2 %), quarentena para skill nova, frontmatter removido antes da injeção,
scripts nunca executados pelo engine, `contain` inviolável, primeira aparição no projeto exige
aprovação (em lote desatendido: `awaiting_operator`), skills locais do repositório vencem por nome.
Seleção: filtro duro (domínio/linguagem/família) → BM25 top-8 sobre `name+description+when_to_use+tags`
→ seletor barato fecha ≤3 → bloco fixo do pack ordenado por id (cache). Fixtures de seleção com o
framework de evals de `addyosmani/agent-skills` (roteamento rank-1 + colisão de descrições).

**Frontend Quality Engine.** DesignBrief obrigatório com UI (única alavanca com medição causal:
−57 % de falhas). Pipeline: build verde → serve → Playwright (biblioteca) captura a11y snapshot,
console, rede, estilos computados → portões determinísticos D1 console limpo, D2 sem 4xx/5xx, D3
contraste AA, D4 estados presentes, D5 `impeccable detect --json` contra a URL renderizada (o modo de
arquivo cobre só um subconjunto), D6 responsivo em 2 larguras (`critical`). Não existe D7: o lint
anti-slop saiu do FQE para o Gate runner C8 por E39. Numeração canônica em
`docs/specs/frontend-quality-engine.md` §4
→ screenshot 2 larguras × claro/escuro só para o juiz → juiz = melhor multimodal de família diferente,
rubrica de 6 critérios (especificidade 3,0; hierarquia 2,0; tipografia 2,0; cor 1,5; estados 1,0;
movimento 0,5), corte 7,5 com especificidade ≥7, julga ANTES de ver diff e achados do detector
(anti-ancoragem) → ≤2 rodadas → `awaiting_operator` com screenshots lado a lado para escolha
preguiçosa. Fontes genéricas e clichês são defaults penalizados; o brief vence. Duas etapas Claude →
Codex é flag medida, não default. `$imagegen` (`codex exec`, stdin fechado, `--skip-git-repo-check`)
só como asset final. Impeccable = `pbakaus/impeccable` (4.3.1 instalado como plugin; detector Rust
Apache-2.0), pinado por `ENGINE_VERSION`, nunca por versão npm.

**Contexto, Firewall e telemetria.** Pack em ordem de volatilidade: ferramentas → papel → invariantes
do repo (≤1,5k) → skills por id (≤20k) → contexto recuperado (≤6k) → contrato → rodada (achados,
falhas de gate, checkpoint) → tarefa; teto 40k (hipótese a medir). Isolamento: `--safe-mode` +
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (nunca `--bare`). Firewall no executor: bruto em `artifacts/`,
extrato ao modelo (falha íntegra mas cercada como dado; sucesso resumido), `ade show <ref>` para
drill-down; hooks `PostToolUse` das CLIs como segunda camada. Telemetria por chamada no journal;
Codex não expõe USD (preço por token da assinatura ChatGPT não é público) → `cost_usd: null` e
`cost_source: 'unknown'`, nunca estimativa: I45 proíbe que uso não observado vire número, e teto em
dólar (`budget.max_usd`, `plan.mission_budget.max_usd`) só conta `cost_source: 'reported'`. Para
família sem USD o teto é `max_model_calls` + tokens, e o scheduler recusa reserva em USD em vez de
estimar. O `reported` do Claude é estimativa local a preço de tabela (`costBasis: "list"`), não
fatura: em assinatura o recurso escasso é cota, e o resumo de aprovação e o `ade report` dizem isso
com essas palavras. OTel export pós-v1. Harness doctor v1
só coleta (injeção, citação via `cited`, custo por item); ablação pareada (Caliper, `claude plugin eval`)
depois, com o ponto cego conhecido do braço Codex.

**Capability Registry e roteamento.** Tabela por papel com primário + **até** 2 fallbacks, conforme
as famílias com `probe_ok: true` (com duas famílias na v1 há no máximo um fallback, e papéis de
Checker podem ficar sem nenhum); o doctor reprova só a ausência de primário e, para papéis de
Checker, a ausência de qualquer família de vendor diferente (`no_checker_family_available` →
`parked`). Degradação via doctor, `Maker ≠ Checker`. Defaults iniciais (só revisão tem benchmark, e
apenas no eixo de pass rate — Claude 32,1 % vs Codex 20,1 %, n=184 PRs; o eixo de **precisão** que
sustenta o Codex como Checker de rodada vem de uma amostra de 8 comentários em que o PR-Agent
pontua mais alto: **[hipótese]**, default provisório, primeiro item a medir em `~/.ade/routing.jsonl`
por `false_positive_rework_rate` no dogfood): Intent Compiler
Claude forte; classificador barato medido; Maker Claude (Sonnet 5 por padrão, Opus em `subsystem`+;
`--advisor` opcional como alavanca de custo); Checker de rodada Codex; Checker de portão Claude; juiz
visual multimodal de outra família do Maker; pesquisa `agy` → Claude. Histórico de desempenho em
`~/.ade/routing.jsonl`; v1 sugere troca, humano aplica.

**Autonomia.** `safe` (ler, editar, testar, branch, commit local), `controlled` (push, PR, dependências,
migrations), `restricted` (produção, segredos, destrutivo; nunca desatendido). Flags de modo desatendido
por família medidas: Claude `--permission-mode bypassPermissions --permission-prompts none
--disallowedTools "Bash(git push *),Bash(gh pr *)"` (E24: **um** argumento, regras separadas por vírgula, com espaço antes do `*`, e o prompt posicional sempre antes das flags variádicas;
string normativa única publicada em `specs/adapters-capability-registry.md` §2; glob best-effort; a cerca real é o `env` filtrado e o
engine ser o único a rodar git/gh); Codex `--sandbox workspace-write --approve-for-me` + `.rules`;
`agy` `--dangerously-skip-permissions` (o `--approval-mode yolo` é do Gemini CLI, não do `agy`). Nunca `--permission-mode auto`.

## 8. O que mudou em relação à spec v2

| Spec v2 | v3 | Motivo (evidência) |
| :--- | :--- | :--- |
| 3 famílias na v1 (`gemini`/`antigravity` por binário) | 2 famílias na v1 (Claude, Codex); família Google = `agy` (Antigravity CLI) na v0.x para pesquisa e fallback de Checker; Maker ≠ Checker por `model_id` | binário `antigravity` não existe, o nome é `agy`; `agy` serve modelos Claude; Gemini CLI não é usado (#2, #3) |
| Codex = melhor revisor; `codex review` | Checker de rodada Codex / de portão Claude via `exec --output-schema` | CR-bench; `--output-schema` ignorado em `review` (#5, #6) |
| Painel com PTY na v1; SQLite; Fastify | painel projeção somente-leitura v0.4; `ade takeover` por comando; PTY v0.5+ | node-pty beta, bug #967; curva de valor (#29) |
| Sem advisor nativo; protocolo de saída por prompt | `--advisor`, `--json-schema`, `--output-schema`, `--max-budget-usd` nativos | (#4, #10, #11) |
| 4 rodadas visuais, corte 8, avaliador barato, fontes banidas | 2 rodadas, corte 7,5, juiz forte de outra família, brief vence, Impeccable pinado | Impeccable 4.3.1 normativo (#16–#19) |
| Composio como lista curada; anthropics/skills inteiro | fontes com licença; denylist proprietária; catálogo 60–80 | licenças e contagem real (#12, #13) |
| Skills como leitura sob demanda | bloco fixo do pack por id; seleção externa obrigatória | truncagem nativa e cache (#13, #14) |
| Checker atesta eval estrito | prova vermelha por execução gravada | determinístico e mais barato |
| Contexto limpo = `/clear` | processo novo `--safe-mode`, auto memory desligada | `--bare` quebra assinatura (#9) |
| Concorrência 1, worktrees futuro | N=1 com Git por worktree e campo `worktree` desde o dia 1 | barato antes do primeiro commit (#33) |
| Paridade "10 falham no Windows" | 93/93 nos dois SOs, com tabela de mapeamento de nomes onde o schema mudou | suíte passa 93/93 (#1) |
| `review-result` copiado | forma rica, `summary` derivado, defeito latente corrigido | (#32) |

## 9. Decisões de Erick (confirmadas em 2026-09-17)

1. **Painel ao vivo na v1, no navegador, com abertura por 2 cliques.** Decisão: a v0.4b entrega um lançador (`ade.bat`/`ade.cmd` na raiz do repositório ou atalho gerado por `ade init`) que sobe `ade serve` e abre o navegador na página local já pronta para uso. A interface deve parecer uma IDE, familiar e fácil de entender (painel de missões/stories à esquerda, diff e evidências no centro, relatório e decisões à direita) — critério de aceite de UX da v0.4b, medido no dogfood D4. Continua somente-leitura + ações que viram steps no journal (E32); terminal embutido (PTY) fica na v0.5. Esta decisão amplia o escopo da v0.4b em relação a "projeção mínima": o roadmap registra o acréscimo como [hipótese] de esforço até a medição.
2. **Três famílias na v1**: Claude Code e Codex desde o slice 1; Google via `agy` entra na v0.5 (dentro da v1) para pesquisa e fallback de Checker, condicionada ao canário de isolamento. Sem chave de API obrigatória: só as assinaturas existentes. Sem 4º provider.
3. **Corte visual 7,5 e teto de 2 rodadas** mantidos como [hipótese], calibrados no dogfood (E39).
4. **Worker morre com o engine** (fechar o terminal ou Ctrl-C para o trabalho; nada roda escondido em segundo plano). Confirmado.
5. **Pacote único** desde o slice 1 (E29). Confirmado.
6. **Defaults numéricos** (lease, pack, orçamentos E4/E65, `max_parked_units`) ficam como [hipótese]: o engine mede nas primeiras semanas e ajusta sem consulta; toda mudança vira ADR curto ou nota no roadmap, e Erick é avisado só quando o custo subir.
7. **Produto: vários projetos, progresso por épico, cara de IDE, simplicidade** (Erick, 2026-09-17). (a) A ADE serve **vários projetos** (repositórios) do mesmo operador: um por vez na v1, vários em paralelo depois; o painel tem a noção de "projeto" desde a v0.4b (seletor, histórico de missões por projeto, `~/.ade/projects.json`). (b) A visão principal é **progresso**: épicos → stories → estado, "em que parte está", o que falta; não é o journal cru. O plano (`plan.json`) já tem épicos e stories; o painel os projeta. (c) Sensação de **IDE/ADE familiar** (Antigravity, Claude Code desktop): barra lateral de projetos, área central de evidência, painel de decisão à direita; sem inventar metáfora nova. (d) **O usuário não deve pensar**: a interface mostra só o que é bom mostrar (estado, próxima decisão, custo, evidência resumida); tokens, journal, flags e nomes de componentes ficam atrás de "avançado". Isto é critério de aceite de UX da v0.4b e vale para `ade report`. O protótipo em `proto/` é o primeiro teste dessa regra.
8. **Custo mostrado como uso do plano, não em dólar** (Erick, 2026-09-17). O painel e o `report.md` mostram, por família, quanto da **janela de 5 horas** e do **limite semanal** da assinatura já foi usado (Claude: ambos; Codex: semanal; `agy`: o que a CLI expuser), numa barra simples ("38 % da semana"). Dólar fica em "avançado". Precondição a medir pelo doctor (v0.2): nenhuma das CLIs documenta esse dado na saída headless (`stream-json` do Claude traz `total_cost_usd` e `usage`, não a cota; `codex exec --json` traz tokens). Caminhas a sondar: eventos de rate limit no `stream-json`, endpoint de uso do login OAuth, ou a mesma fonte que `/usage` e `/status` leem. Enquanto não houver fonte, o painel mostra tokens e chamadas com o rótulo "cota do plano: indisponível", nunca um número inventado.

## 10. Adendos incorporados após o painel

Fonte: `docs/research/ref-affaan-mustafa-ecc.md` (guias shortform, longform e de segurança do ECC,
lidos das versões versionadas no repositório; plugin local está em 1.10.0 contra 2.2.1 upstream).
Os três guias confirmam a tese §1, o Firewall (C11), a morte do grupo de processos (C5), a fronteira
de política (§7 Autonomia), N=1 e Maker ≠ Checker. Nenhum contradiz a arquitetura. Entram:

| # | Mudança | Componente |
| :-- | :--- | :--- |
| A1 | Extrato do Firewall com forma fixa `{status: success\|warning\|error, summary, next_actions[], artifacts[], raw_ref}` em vez de texto livre; schema inline | C11 |
| A2 | Telemetria ganha `approval_decisions`, `network_attempts`, `files_touched`; agregados `pass@k` e `pass^k` por classe de complexidade | §4 Telemetry, C19 |
| A3 | **Watchdog de silêncio de I/O** (não heartbeat: o worker é binário de terceiro e não emite sinal algum para o engine): sem byte novo em stdout/stderr por `idle_timeout_s` — default por família no `CapabilitySet`, medido pelo doctor, com `agy` ≥ `--print-timeout` —, o engine grava `attempt{class:'harness'}`, mata por `taskkill /T /F /PID` conferindo o `process_fingerprint`, põe a unidade em `awaiting_operator` e põe o log em quarentena. Gatilho chama-se `worker_idle_timeout` (não `worker_heartbeat_lost`) | C5, C3 |
| A4 | Deny-list nomeada no `contain` e no `env` filtrado: leitura negada em `~/.ssh/**`, `~/.aws/**`, `**/.env*`; `ANTHROPIC_BASE_URL` e equivalentes nunca propagados nem aceitos (CVE-2026-21852, CVE-2025-59536) | C7, I49, ADR 0015 |
| A5 | Precondição dura da jornada 6: `ade run --unattended` recusa sem (a) gates ativos, (b) baseline de eval verde, (c) caminho de rollback em `refs/ade/`, (d) isolamento por worktree verificado pelo canário | C14, operações |
| A6 | Estagnação também por assinatura de falha idêntica (hash de stderr/stack normalizado) em duas tentativas consecutivas; corrige o falso positivo herdado do `review-result` | C8/C9, detector de loop |
| A7 | SkillGuard com lista concreta de padrões: zero-width/bidi (`​ ‌ ‍ ⁠ ﻿ ‪-‮`), `<!--`, `<script`, `data:text/html`, `base64,`, `curl\|wget\|nc\|scp\|ssh`, `enableAllProjectMcpServers`, `ANTHROPIC_BASE_URL` | C16 |
| A8 | Protocolo de eval de conformidade (3 níveis de rigor de prompt, execução, classificação da sequência) para fixtures de skills e para o canário de isolamento | C16, C7 |
| A9 | [hipótese] medir `--system-prompt` como veículo do pack contra o prompt de usuário; pack continua vindo de arquivo (`lpCommandLine`) | C10, harness doctor |
| A10 | `ade doctor` adota as 7 categorias do `/harness-audit` (Tool Coverage, Context Efficiency, Quality Gates, Memory Persistence, Eval Coverage, Security Guardrails, Cost Efficiency) e o contrato de saída (score, checks com caminho, `top_actions`), pontuadas por telemetria e ablação, nunca por presença de arquivo | C19, ADR 0017 |
| A11 | Seção "invariantes do repositório" do pack em forma canônica "Must Always / Must Never", imperativo curto, ≤1,5k tokens | C10 |
| A12 | Achado do harness doctor no formato instinto `{trigger, action, confidence 0,3–0,9, evidence[], domain, scope: project\|global}`, derivado do journal (nunca de hooks), promoção project→global ao observar em 2+ repositórios; v1 só coleta | C19, ADR 0017 |
| A13 | ECC é referência pinada por commit, nunca dependência de runtime; só `skills/` entra no catálogo, nunca `hooks/`, `install.sh` ou instaladores | C16, `catalog-sources.md` |
| A14 | Divergência registrada: `gan-style-harness` do ECC usa 5–15 rodadas e corte 7,0; a ADE mantém ≤2 e 7,5 e mede no dogfood. Atribuição honesta: **≤2 rodadas é citação literal do Impeccable**; o **corte 7,5 e a rubrica de 6 critérios são desenho próprio da ADE, inspirado em — não derivado de — o Impeccable (que faz critique dual-agent sobre as 10 heurísticas de Nielsen)**: [hipótese], com critério de recalibração publicado em E39. "Sprint contract" (Checker assina os critérios antes do `implement`) entra como flag experimental | C17, evals |

Rejeitados do ECC: catálogo inteiro (gargalo de índice), 39 hooks automáticos, 79 comandos legados,
`autonomous-agent-harness`, `token-budget-advisor`, os 14 MCPs, `ecc2/`, GitHub App pago, e o método
do `harness-audit.js` (pontua presença de arquivo). Atenção: o "36 %" da Snyk (skills com injeção)
não é o "36,0 % → 7,2 %" da premissa #34 (ASR); métricas diferentes.

## 11. Arbitragem das divergências dos escritores (2026-09-17)

Os 18 documentos derivados registraram objeções a este documento. Decisões abaixo são canônicas e
prevalecem sobre qualquer trecho anterior deste arquivo ou dos derivados; a revisão adversarial
propaga. "E" = evidência principal.

**Contratos e estado**
- E1 `passes` sai do Task Contract. O contrato é imutável após aprovação (coberto por `immutable_digest`); o estado da story vive no journal (`unit_state`) e na projeção `status.json`. `unit-result` carrega o veredito. E: master-spec; digest #22.
- E2 Exceção única de mutabilidade: em `trivial` com `evals: []` na aprovação, o Maker preenche `evals` uma vez (`author: 'maker'`), gravado como step `local_write` com `eval_authored_by`, e o vermelho diferido é condição de validade. E: intent-compiler D2.
- E3 `plan.mission_budget: { max_wall_clock_seconds, max_parked_units, max_usd }` gravado no `batch_open`; defaults da jornada 6: 8 h e 3 [hipótese]. `permitted_effects` lista só efeitos externos; classes internas (`model_call`, `eval_run`, `local_write`, `gate`, `prepare`) são implícitas. E: journeys; master-spec.
- E4 Orçamento default por story e classe [hipótese]: trivial 3 chamadas/1 rework; bounded 6/2; feature 10/3; subsystem e project 12/3. E: vision (pergunta aberta).
- E5 `ask_operator` é enum fechado (`push`, `pull_request`, `pull_request_merge`, `dependency_add`, `dependency_major_bump`, `migration_destructive`, `deploy`, `secrets_read`, `destructive_local`, `skill_first_use`, `*`) mais `note` livre. `restricted` não tem bloco de famílias: `dispatch: never` (`autonomy_requires_operator`) e herda `scope_paths` da story. E: operations 9.2, 9.4, 9.5.
- E6 `effect_class` ganha `gate` e `prepare` agora (antes do slice 1), além das classes novas já listadas. E: engine D3.
- E7 `runtime_stamp = <core_version>:<config_digest>:<capabilities_digest>`; `core_version` é constante do núcleo durável (C1–C5, C7) e só ela bloqueia com `stale_workflow_version`; `capabilities_digest` **registra** (não bloqueia) upgrade silencioso de CLI (`agy` 1.2.3 → 1.2.4 sem ação) — a palavra "cobre" era falsa, e o risco de um portão bloqueante mudar de comportamento no meio de uma noite desatendida fica assumido por escrito. Aceite por `ade run --accept-stale-version`, gravado como `decision`. E: development-method D1; adapters D2; engine D6.
- E8 `unit-result` e `review-result` ganham `sources: string[]` obrigatório (digests das seções do pack usadas); sem isso `cited` é sempre falso. E: context D1; judgment-J3.
- E9 `visual-eval` vira 9º schema publicado na v0.4b (dois consumidores). `judge` pinado por `model_id` no contrato e replicado no registro; `visual_score` só comparável dentro do mesmo juiz; `judge_family` registrado e "juiz único (Codex) com Maker sempre Claude" é hipótese explícita. E: evals D3; journeys.
- E10 `CapabilitySet`: `probe_ok: boolean | null`, `probe_mode: 'real' | 'help_only' | 'fixture'`, `bootstrap_cost_tokens` medido por família, `models[].vendor` (derivado por prefixo). `ade doctor --offline` é o default em CI; `null` fora de CI recusa despacho, nunca degrada. Checker de rodada recusa vendor igual ao do Maker. E: adapters D3, D4, D5; context D4.
- E11 Telemetria ganha `compaction_events`, `outcome ∈ {ok, retry, rework, park, stop}`, `ttft_ms`, e um evento `scope: 'mission_summary'` no fechamento (intervenções, perguntas, wall time, verbos de CLI usados). Eventos `decision` carregam `source: operator | engine`. E: vision D1; context D5.
- E12 `EvalRecord.red_reason ∈ {assertion, missing_target, compile_error, environment}`; só `assertion` conta como vermelho válido; os demais rebaixam para `additive` com aviso (classe ≥ feature: `awaiting_operator`). `additive` exige no mesmo cenário um eval `negative` ou um spot-check `mutate` (validação ajv). E: evals D1, D2.

**Limites e contexto**
- E13 Corte do pack em bytes (`limits.max_pack_bytes`, default 120 000 [hipótese], calibrar por p90); "40k tokens" é alvo de projeto por estimativa. Teto próprio da seção de rodada (achados, falhas de gate, checkpoint): 24 000 bytes com ponteiro. Diff do Checker: `review.max_diff_bytes` default 60 000 chars, por arquivo em ordem de relevância de escopo, ponteiro `ade show diff:<story>#<arquivo>`. E: context D2, D3; engine D1; operations 9.6; judgment-J3.
- E14 Skills: ≤7,5k tokens por skill e soma ≤20k (elevado de 5k/7,5k para 7,5k/20k por E70; não 2,5k fixo); o filtro duro não elimina por tamanho antes do BM25. Braço de controle "BM25@3 puro" medido antes de manter o seletor barato. E: skill-fabric D1; adr-1.
- E15 O engine tem de suprimir o listing nativo de skills/plugins do usuário na chamada despachada (a supressão é `--safe-mode`, que já desliga todas as customizações — CLAUDE.md, skills, plugins, hooks, MCP, comandos, agentes; `--setting-sources` e `--plugin-dir` saem da receita até a sonda mostrar necessidade, e `--plugin-dir` é flag de carga por sessão, não de supressão) e a prova é a contagem de skills no evento `system/init` da chamada despachada; `skills_injected[]` só é verdadeiro sob essa supressão. E: skill-fabric D2 [hipótese até a sonda].
- E16 Receita de chamada curta no Codex: `--ignore-user-config --ignore-rules --ephemeral` + `AGENTS.md` escrito pelo engine no worktree, ≤2 KB como escolha de projeto [hipótese] (o número **medido** é ≤8 KB: acima disso o Codex omite skills silenciosamente; truncagem dura em 32 KiB). `-c skills.max_context_tokens=0` vira **sonda do doctor** (o valor 0 nunca foi exercitado; default medido é 2 % da janela, teto explícito 10 000): se o binário recusar 0, usar o menor valor aceito e gravar no `CapabilitySet` — com `--ignore-user-config` o `-c` é em boa parte redundante. o pack do Checker inclui obrigatoriamente a seção "invariantes do repo". Chamadas de `$imagegen` usam a configuração completa (sonda do doctor confirma). E: adapters D5; adr-1; skill-fabric D4.
- E17 Benefício de cache é [hipótese]; `cache_read / (tokens_in + cache_read)` por papel é a primeira métrica do harness doctor. E: context D6.
- E18 Classificador: regra determinística primeiro em candidatos a `trivial` (1 arquivo tocado no discovery + verbo de correção); chamada de modelo só com confiança < 0,6 ou classe ≥ feature. As ≤2 chamadas da faixa rápida incluem o classificador quando ele roda. E: intent D1; journeys; digest #26.
- E19 Pesquisa dispara por incógnita declarada do tipo `external_fact` (não por classe); teto por classe: bounded ≤1 consulta sem time; feature+ até 3; time paralelo opt-in. E: intent D3.
- E20 Teto de pack por story tem duas verificações: estimativa no plano (divide por cenário) e medição no `prepare` (poda contexto recuperado, nunca o contrato; reabre divisão se o contrato sozinho estourar). E: intent D4.

**Durabilidade e engine**
- E21 Worker não-detached na v1: a branch "anexa e espera" de I09 fica dormente; o recibo com fingerprint serve para decidir `ambiguous` com honestidade e para `taskkill` seguro; o teste de attach é v0.5+. E: slice-1 D1; engine D4; adr-2.
- E22 `findings_digest = sha256(sorted(normalize(location) + '|' + normalize(problem)))` com as regex de `tl_ci_slice.normalize`; teste `same_findings_reworded_is_still_stagnation`. E: engine D5.
- E23 Deny-list de caminhos fora do worktree (`~/.ssh/**`, `~/.aws/**`, `**/.env*`) vive no `env` filtrado, no canário e no doctor, não no `contain` (que só vê o diff). `ANTHROPIC_BASE_URL` e equivalentes nunca propagados. Ajusta A4. E: operations 9.3.
- E24 `--disallowedTools` em argumento único separado por vírgula (`"Bash(git push *),Bash(gh pr *)"`) — a lista aceita vírgula **ou** espaço; o argumento único é convenção de escape, não a restrição medida. A **regra dura** é outra: `--allowedTools`, `--disallowedTools`, `--tools` e `--mcp-config` são variádicos (`<tools...>`), logo **o prompt posicional vem sempre antes de qualquer flag variádica** (senão é engolido como mais um valor), com teste no adapter. Padrões com espaço antes do `*` (`Bash(git push *)`), porque `Bash(git diff*)` casa também `git diff-index`. Sonda do doctor exige `permission_denials` não vazio num `git push --dry-run`. E: operations 9.1.
- E25 I15 (`ci_rerun`) e I40 (merge remoto exige CI verde) entram como "portados desligados" com teste do caminho inerte; `ci.enabled: false` default. E: roadmap.
- E26 Paridade: tabela `parity-name-map.json` (lista fechada dos casos que mudam de nome/semântica por `review-result` rico e `plan`) é artefato de ENTRADA da v0.2. Slice 1 tem subconjunto nomeado de 44 casos; 93/93 é critério da v0.2. Dois alvos normativos: `parity` (zero credencial, CI Windows + Linux) e `probes` (chamadas reais, local, opt-in). E: slice-1 D3; evals D4; adr-1.
- E27 Cobertura: ≥85 % de linhas só em `journal, step, lease, git, runner, contain` [hipótese]; razão teste:produção no corpo do PR sem portão no resto. E: slice-1 D4.
- E28 Fallback do estágio 0 (`claude -p` em loop) grava cursor durável no formato de linha do `journal-event`. Gravador de transcript (`scripts/record-transcript.ts`) é artefato do dia 1. E: slice-1 D5; development-method D4.
- E29 Pacote único na raiz na v1; npm workspaces só no commit que cria `packages/web` (v0.4b). E: development-method D2.
- E30 Meta "zero revisão humana" tem exceção escrita: as três superfícies de segurança (contain/isolamento, servidor local do painel, ingestão do catálogo) têm revisão humana obrigatória. E: development-method D3.

**Operador e superfície**
- E31 CLI: `ade run <pedido>` é canônico; forma nua aceita só quando o primeiro token não é comando e o pedido tem espaço em branco (senão exit 4 com sugestão). `--help` curto separa superfície operacional (`run`, `report`, `decide`, `discard`) da avançada. Exit 3 quando há `awaiting_operator` com `batch_state: in_progress`. Estados e `reason` em inglês (journal); mensagens em português. E: master-spec; vision D2.
- E32 Novos verbos: `ade decide <unit> --option retry|skip|discard|pick --value <id>`; `ade show <ref> --open` (visualizador do SO; `report.md` emite caminhos absolutos por parada); `ade steer <missão> "<nota>"` (enfileira intenção consumida no `prepare` da próxima story; não é steering intraturno); `ade plan <pedido> --from <missão>` (herda discovery, respostas e stories concluídas; a anterior fica `superseded`); `ade run --accept-stale-version`; `ade run --unattended`. Takeover grava também `.ade/missions/<id>/takeover-<story>.cmd` e `.ps1`. E: operator-surface D1–D4; vision D3, D4.
- E33 Aprovação única congela o conjunto elegível de skills da missão (união do top-8 por story); só skill fora do conjunto parqueia em lote desatendido. E: journeys.
- E34 Painel (v0.4b): token aleatório por sessão do `ade serve` impresso no terminal + checagem de `Origin`. E: security D1.
- E35 Scripts de skills de catálogo nunca ficam disponíveis ao agente na v1 (só o corpo do `SKILL.md` e `references/*.md` como texto); controle 11 (memória/config do agente no scan) é detect-only na v1 com baseline de hashes, bloqueio de despacho em v0.5. E: security D2, D3; skill-fabric D3.
- E36 `refs/ade/discarded/` acumula; `ade doctor` reporta volume; purga é comando manual pós-v1. E: operator-surface.

**Roadmap e FQE**
- E37 v0.4 divide-se em v0.4a (Skill Fabric + FQE) e v0.4b (painel projeção + SQLite + workspaces). A v1 completa é ~15–16 semanas a 5 dias/semana (não "3 meses"); o slice 1 mede linhas portadas por dia na semana 1 e replaneja explicitamente. E: roadmap; master-spec.
- E38 `ade eval <story>` roda os evals do contrato (dono: C9); a suíte de dogfood é suíte Vitest, não comando da v1. E: roadmap.
- E39 Lint anti-slop (Oxlint vendorizado, pinado por SHA) sai do FQE e vira gate por flag no C8, com nome próprio `gate:anti-slop` e **condicionado à linguagem detectada no discovery**: só ativa em projeto TS/JS. Não existe equivalente multi-linguagem, as regras são preferência declarada do autor (falsos positivos prováveis) e a ADE não terceiriza a definição de "slop" a ela; nas demais linguagens o portão anti-slop é o linter nativo do projeto. FQE fica com D1–D6 dependentes de render. `self_critique` é obrigatório (`minLength`). Corte 7,5 com critério de recalibração publicado (escaped_visual_defects > 10 % em 20 stories → 8,0; `awaiting_operator` em trabalho aprovado à primeira vista → 7,0). Toda story com UI reserva 1 rodada de rework para o FQE no `prepare`. E: fqe D1–D4.
- E40 Faixa rápida: teste `fast_lane_trivial_starts_within_30s_zero_questions` é critério de saída da v0.3; slice 1 grava só `first_source_edit_ms` como baseline. E: slice-1 D2.

**Pendências que ficam para Erick ou para o dogfood**: retenção de refs descartados; defaults numéricos de lease/pack/orçamentos; confirmação dos itens de §9.

## 12. Emendas pós-revisão adversarial (2026-09-17)

A revisão adversarial (6 críticos, 137 achados, 42 verificados por 3 refutadores cada, 25 confirmados,
34 fixers) devolveu 31 pontos que exigiam decisão de arquitetura. Decisões abaixo prevalecem sobre §3–§11
e sobre os derivados; a propagação é feita pela mesma revisão. ADO = adotado, ADA = adaptado, REJ = rejeitado.

**Contenção e autonomia**
- E41 REJ Estender `--disallowedTools` a `Read`/`Glob`/`Grep` com globs de caminhos negados. Não é fronteira real (best-effort sobre o próprio agente); a contenção de leitura de segredos na v1 é env filtrado (I49) + ausência de credencial no processo. Fica registrado como limite conhecido em security §11.
- E42 ADO `takeover_open` recusa despacho: `prepare` recusa worktree com `takeover.json` presente e a story para em `awaiting_operator{reason:'takeover_open'}`; `ade decide --option retry` sobre essa story devolve a mesma parada. Sem exit code novo (exit 3). Teste próprio no slice 1: `dispatch_into_open_takeover_is_refused` (fora do lote portado).
- E43 REJ `config_digest` bloqueante com `--accept-config-change`. E7 mantido (só `core_version` bloqueia). Mitigação já aplicada: argv congelado no `batch_open` e hash de `.ade/**` verificado pelo doctor.
- E44 ADA `deploy` e `dependency_install` são valores exclusivos do enum de `ask_operator` (E5); **não** entram em `effect_class`. A menção em operations §1 é vocabulário de aprovação, não de `permitted_effects`.
- E46 ADA Literal canônico de E24 passa a `"Bash(git push *),Bash(gh pr *),Bash(gh release *)"`. `WebFetch` fica fora (leitura sem efeito externo; a pesquisa depende dela). Sede normativa: adapters §2; os demais documentos citam por referência, sem repetir o literal.
- E56 ADA Confiança em repositório: a v1 assume repositórios do próprio operador. `catalog.sources` permanece em `.ade/config.json` do repositório (sem `~/.ade/config.json`, que não existe no layout). Skills em `<repo>/.claude/skills/` não entram no pack (só o catálogo curado) e não são carregadas pela CLI porque a chamada despachada roda sob `--safe-mode` (E15); em `codex`/`agy` a supressão equivalente é provada pela sonda. "Modo repositório de terceiros" (allowlist de remotos; `.ade/config.json` não confiado) é backlog da v0.5 com ADR próprio quando chegar.
- E62 REJ Cancelar story `running` (`operator_cancel`). Na v1, Ctrl-C para o lote (lease + reconciliação) e `ade discard` trata a story depois. Sem transição nova.
- E64 ADO `local_merge` fast-forward da branch da story na branch base entra em `safe` quando a base não mudou desde o `prepare` (ff-only; ref de origem preservada em `refs/ade/`). Se a base mudou, o commit fica na branch da story e o `report.md` imprime o comando de merge. Fecha a entrega da jornada 1 sem verbo de git.
- E68 REJ `capabilities_digest` divergente bloquear `--unattended`. E7 mantido; divergência vai ao relatório e ao `mission_summary`.

**Engine, evals e orçamento**
- E45 ADO `ENGINE_VERSION` do Impeccable divergente do pin é **falha do doctor** (fail-closed), nunca aviso. FQE entra em modo degradado: stories com UI param em `awaiting_operator{reason:'fqe_unavailable'}`; stories sem UI seguem. Norma de §7.
- E47 ADO Tabela única de exit codes = master-spec §4, herdada do runtime: 0 ok/idle; 2 recusa ou parada final (inclui `stale_workflow_version` e trabalho vermelho final); 3 concluído com paradas (`awaiting_operator`, orçamento esgotado, `parked`); 4 entrada inválida (forma nua rejeitada, plano que não valida); 5 lease. Não existem 1 nem 6. `ade report` e `ade journal` saem sempre 0; o exit 3 de E31 vale para `ade run`.
- E49 ADO `node_modules` por worktree: o `prepare` cria junction (Windows) ou symlink `node_modules` apontando para o checkout base quando o hash do lockfile do worktree é igual ao do base. Se diverge, classe ≥ `bounded` roda o instalador do discovery (`npm ci`, `pnpm install --frozen-lockfile`, …) como step `prepare`, com `prepare_dependency_ms` na telemetria; `trivial` com lockfile divergente para em `awaiting_operator{reason:'environment'}`. A jornada 1 mantém ≤30 s com junction. Fecha engine-durability pergunta 5.
- E51 ADA Emenda a E12 para `trivial`: `red_reason != 'assertion'` **não** rebaixa para `additive` (que exige `negative`/`mutate`, inexistentes em `trivial`). A story para em `awaiting_operator{reason:'red_unproven'}` com o diff pronto; `ade decide --option accept_unproven` fecha a story como `complete` com `decision` gravada. Caminho feliz da jornada 1 intacto (0 interações).
- E58 ADO C9 exige reporter estruturado (`--reporter=json` no Vitest/Jest; equivalente por runner) e `numTotalTests ≥ 1`; zero testes executados é `red_reason: 'missing_target'`, nunca verde. Formato `V(...)` de slice-1 §3 ganha o reporter.
- E61 REJ `max_tokens_in`/`max_tokens_out` em `mission_budget`. `max_usd` + `prices.json` cobrem as famílias com custo reportado; nas demais o teto é `max_model_calls`.
- E63 ADA Validação de `eval.cmd[0]` contra `scripts` migra do plano para o `prepare` de cada story (re-discovery no worktree); no plano valida-se só a forma. A jornada 5 volta a caber numa aprovação (a fase 0 cria os scripts que as fases seguintes usam). `story.provides_runner` rejeitado.
- E65 ADA Emenda a E4: `max_model_calls = 2 + 2·visual_rounds + 2·(max_rework_rounds + 1)` [hipótese]. `bounded` com UI = 8 chamadas/3 rework; sem UI mantém 6/2; `feature` com UI = 12/3.
- E57 REJ Recalcular os totais de E37 agora. A medição da semana 1 do slice 1 replaneja os números; até lá ficam [hipótese].
- E60 REJ Purga de segredo em blob na v1. E36 mantido: quarentena em `refs/ade/quarantine/`, nunca empurrado, alerta do doctor; purga é comando manual pós-v1.

**Contratos e contexto**
- E48 ADO `TaskContract.unknowns?[]` entra no §4 e em `task-contract.schema.json` (`id`, `question`, `kind ∈ {product_choice, external_fact, repo_fact}`, `resolved_by?`). A incógnita é do contrato, não do plano.
- E50 ADO Teto da seção `contract` do pack: 32 000 bytes (≈8k tokens) [hipótese], dentro de `max_pack_bytes`; estouro é `story_pack_overflow` e reabre a divisão da story. Substitui os valores divergentes (2 000 tok em context §1.1; 18 000 tok em intent-compiler §9).
- E53 ADO `ade steer` ganha consumidor: a seção `task` do pack recebe `operator_notes` (≤600 bytes, mais recente primeiro), fila drenada no `prepare` da story seguinte. A nota é contexto, não requisito: o contrato continua imutável.
- E54 ADO Métrica U1 tem definição operacional única em vision §3: `first_source_edit_ms` = tempo do `ade run` até o primeiro `local_write` em arquivo fora de `.ade/` que não seja arquivo de eval, medido pelo journal. operator-surface §14.4, journeys §1 e intent-compiler §3 citam por referência.
- E55 ADO `schemas/ade-config.schema.json` é artefato do slice 1 e a única fonte das chaves de configuração; tabelas em prosa nos specs são derivadas e não normativas (marcadas "derivado do schema").
- E59 ADO `skills_injected[]` ganha `sha256` (do conteúdo injetado) e `source` (`catalog@<commit>` ou `local`). Evidência de supply chain no próprio evento.
- E66 ADO Telemetria: `model` vira `models: { role: 'executor' | 'advisor'; model_id }[]`. Maker ≠ Checker por `model_id` e por vendor vale para **todo** papel da chamada. `--advisor` só entra na receita quando o modelo do advisor é observável em `modelUsage` (sonda do doctor); até lá o Maker roda sem `--advisor`. ADR 0005/0006 registram.
- E67 ADO `compaction_events` sai da telemetria (sessão nova por chamada, turno único, pack com teto: nunca há compactação). `capabilities_digest` tem dois leitores nomeados: relatório do doctor e `mission_summary`.

**Fora da v1**
- E52 REJ ADR de rotinas autônomas (`routine_budget`, `scope_paths`, política de PR). Rotinas são pós-v1 (vision §2.13); o ADR abre quando entrarem no roadmap.
- E69 REJ Contadores de cota por família no doctor. Subsistema de medição novo; fora da v1.

**Decisão de Erick (2026-09-17)**
- E70 ADO Teto por skill sobe de 5k para **7,5k tokens** e a soma do bloco de skills de 7,5k para **20k** (≤3 skills). Justificativa: skills só entram na chamada do Maker, o bloco vai no prefixo estável do pack e é servido pelo cache de prompt (`cache_read` na telemetria), então o custo marginal por chamada é ~10 %. Continua [hipótese]: se `cache_read` ficar abaixo de 80 % do bloco ou a obediência cair (achados do Checker por regra de skill ignorada), o teto volta a 5k. Permite `taste-skill` com recorte; `img2threejs` (8,2k) continua precisando de poda.

**Pendências que continuam com Erick**: itens de §9; defaults numéricos marcados [hipótese] (lease, pack, orçamentos E4/E65, `max_parked_units`).
