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

Princípio operacional: **o portão substitui o humano; o modelo não** (Orca: ~30 portões, zero
revisão humana; Gas City sem malha: 23 % de CI verde). E o gargalo de missões longas é instruction
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
| C3 | Lease | `mkdir` + heartbeat 2 s + TTL 6 s + fingerprint (pid, start time); exit 5 em conflito | próprio (~60 linhas; `proper-lockfile` abandonado) | v1 |
| C4 | GitPort | uma instância por worktree (nunca singleton), `worktree_tree` com índice racy, `dirty_paths -z` com os dois lados de rename, checkpoint/descarte em `refs/ade/...` | próprio sobre `git` | v1 |
| C5 | Runner | spawn com `env` explícito filtrado (I49), recibo durável em disco com fingerprint anti-reuso de PID, `cwd` no worktree, kill por `taskkill /T /F /PID` (nunca `pty.kill`), Job Object herdado do libuv (filho não-detached) | próprio | v1 |
| C6 | BinaryResolver | resolve o `.exe` real atrás dos 3 shims npm; `spawn` de `.cmd` só via `cmd.exe /c` | próprio | v1 |
| C7 | Contain | pós-fato sobre a árvore: segurança (segredos no diff integral, `maxBuffer` explícito) > `sensitive_paths` > `scope_paths`/`do_not_touch`; canário de isolamento por família (escrever fora do worktree tem de falhar) | próprio (porte I22–I26) + canário novo | v1 |
| C8 | Gate runner | gates sempre/por flag sobre a árvore do Maker, cache por árvore, restauração de sobras; saída passa pelo Firewall | próprio (porte I31–I32) | v1 |
| C9 | Eval runner | `eval_run{phase: red|green|strictness}` como classe de efeito; vermelho contra `tree_before` obrigatório salvo `strictness.mode = additive`; eval que nasce verde volta ao Intent Compiler | próprio, novo | v1 |
| C10 | Pack compiler | seções em ordem fixa por volatilidade, teto por seção com ponteiro, teto global, redação de segredos pós-montagem, manifesto como evidência; sempre `{pack_path}` | próprio (porte, seções novas) | v1 |
| C11 | Tool Output Firewall | `run(argv) → {rawPath, extract}`: bruto vira artifact; o modelo recebe extrato (falhas íntegras, sucesso resumido) + ponteiro de drill-down; saída de ferramenta é dado não confiável (cerca inbound) | próprio; hooks das CLIs só como reforço | v1 |
| C12 | Adapters | bespoke headless: `claude`, `codex`; `agy` para pesquisa (v0.x). Casca fina sobre flags nativas + parser tolerante a campos desconhecidos + CLI falsa por família | próprio, fino | v1 (2) |
| C13 | Capability Registry | JSON por família com `probe_ok/probed_at` medidos por `ade doctor` com chamada real; roteamento por papel com primário + 2 fallbacks; Maker ≠ Checker por `model_id` | próprio, pequeno | v1 |
| C14 | Scheduler | lista de stories com `depends_on` opcional (DAG só quando o plano declara); `next_ready` devolve conjunto (N-capaz), N=1 na v1; reserva de orçamento; `blocked` por dependência parada | próprio (~80 linhas) | v1 |
| C15 | Intent Compiler | context discovery determinístico (git, rg, manifestos) → classificação de complexidade → expansão em camadas → ≤5 perguntas (recusa pergunta respondível pelo discovery; "não sei" = default registrado) → plano de Task Contracts validado por ajv → resumo de aprovação | próprio + 1–2 chamadas com `--json-schema` | v1 |
| C16 | Skill Fabric | catálogo curado (60–80), `index.json` com extensão fora do SKILL.md, filtro duro por domínio → BM25 top-8 (~80 linhas, $0) → seletor barato ≤3 → bloco fixo do pack ordenado por id estável; SkillGuard (12 controles) | próprio | v1 |
| C17 | Frontend Quality Engine | DesignBrief em 4 camadas no contrato; build → serve → a11y snapshot + console + rede + `impeccable detect --json` (URL renderizada) → portões determinísticos D1–D7 → juiz multimodal de outra família (anti-ancoragem) → ≤2 rodadas, corte 7,5; `$imagegen` para assets | próprio orquestrando Playwright (lib) + Impeccable pinado | v1 parcial (D1–D5 + juiz) |
| C18 | Pesquisa | step `research`: uma chamada com schema por incógnita declarada (classe ≥ feature); time paralelo somente-leitura (2–4) opt-in; empate vira pergunta; achado é dado | próprio, fino | v1 (simples) |
| C19 | Telemetria + harness doctor | evento por `model_call` no journal (tokens, cache, custo com `cost_source`, pack por seção, `skills_injected[{name,bytes,cited}]`); doctor v1 só coleta e relata | próprio | v1 (coleta) |
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
  depends_on?: string[]
  budget: { max_model_calls: number; max_rework_rounds: number; max_usd?: number }
  passes: boolean                          // ÚNICO campo gravável pelo agente (por evidência, nunca por texto)
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
  guardrails_default: string[]             // defaults penalizados, não vetos
}

interface JournalEvent {                   // step-journal.schema.json v1 + campos aditivos
  format_version: 1; seq: number; at: string; prev: string
  kind: 'batch_open' | 'step_intent' | 'step_result' | 'unit_state' | 'attempt' | 'recovery' | 'decision' | 'note' | 'batch_state' | 'telemetry'
  effect_class?: 'none' | 'model_call' | 'local_write' | 'local_commit' | 'local_merge' | 'push' | 'pull_request'
               | 'pull_request_merge' | 'ci_query' | 'ci_rerun' | 'eval_run' | 'visual_eval' | 'research' | 'human_takeover' | 'human_release' | 'catalog_sync'
  worktree?: string; receipt_path?: string; session_ref?: string | null   // null quando o transporte não pré-cunha id
  runtime_stamp: string                    // <versão do engine>:<digest da config>; divergência = stale_workflow_version
}

interface ReviewResult {                   // forma rica do runtime de referência; summary derivado
  verdict: 'approved' | 'changes_requested'
  action_items: { id: string; severity: 'critical' | 'high' | 'medium' | 'low'
                  category: 'patch' | 'bad_spec' | 'intent_gap'; target_role: 'maker' | 'planner' | 'human'
                  location: string; problem: string; evidence: string; required_action: string }[]
  deferred: Finding[]; rejected: Finding[]
}

interface CapabilitySet {                  // uma por família; medida, nunca declarada à mão
  id: string; family: string; launch: { cmd: string; args: string[]; env: Record<string, string> }
  transport: 'cli' | 'acp'
  models: { id: string; context_window: number | null; effort: string[] }[]
  resume: 'reconnect' | 'replay' | 'reprompt' | 'none'; fork: boolean; preminted_session_id: boolean
  structured_output: 'schema_inline' | 'schema_file' | 'none'; budget_cap_native: boolean
  image_in: boolean; image_out: boolean; tools_allowlist: boolean; sandbox: 'os' | 'restricted_token' | 'none'
  cost_report: 'usd' | 'tokens' | 'none'; advisor: boolean
  unattended_flags: string[]; probe_ok: boolean; probed_at: string
}

interface SkillIndexEntry {                // ~/.ade/catalog/index.json; SKILL.md upstream fica byte-idêntico
  id: string; source: string; commit: string; sha256: string; license: string | 'unknown'
  name: string; description: string; when_to_use?: string
  domains: string[]; languages: string[]; families: string[]; tags: string[]
  body_tokens: number; has_scripts: boolean; trust: 'local' | 'allowlisted' | 'quarantine'
  disable_model_invocation?: boolean
}

interface Telemetry {                      // kind: 'telemetry', um por model_call
  mission_id: string; story_id: string; step_id: string; family: string; model: string; role: string; effort: string
  duration_ms: number; tokens_in: number; tokens_out: number; cache_read: number; cache_write: number
  cost_usd: number | null; cost_source: 'reported' | 'estimated' | 'unknown'
  pack_bytes: number; pack_sections: { section: string; bytes: number; digest: string }[]
  skills_injected: { name: string; bytes: number; cited: boolean }[]
  tool_output_raw_bytes: number; tool_output_model_bytes: number
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
| trivial | 0 | não | contrato mínimo | só se diff > N arquivos | detector só | — |
| bounded | ≤2 | não | 1–3 stories | rodada | D1–D5 + juiz se UI | — |
| feature | ≤5 | se incógnita | 4–8 stories, 1 epic | rodada + portão | completo | — |
| subsystem | ≤5 | sim | 9–20 stories, epics | rodada + portão | completo | N opt-in |
| project | ≤5 | time | fases, epics, stories | rodada + portão | completo | N opt-in |

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
ACP: steering no meio do turno (RFD `session/inject` estável) ou 4º provider. `agy` entra na v0.x para
pesquisa (`--json-schema` coage; escreve fora do `--add-dir`: só somente-leitura até o canário passar).
O Gemini CLI (`gemini`) não faz parte da ADE: a família Google é o Antigravity CLI (`agy`), que
Erick usa e tem autenticado; `gemini` exigiria API key e não é usado. Chamadas curtas no Codex sempre com
`--ignore-user-config` (piso de 19,4k tokens).

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
arquivo cobre só um subconjunto), D6 lint anti-slop (Oxlint, vendorizado), D7 responsivo em 2 larguras
→ screenshot 2 larguras × claro/escuro só para o juiz → juiz = melhor multimodal de família diferente,
rubrica de 6 critérios (especificidade 3,0; hierarquia 2,0; tipografia 2,0; cor 1,5; estados 1,0;
movimento 0,5), corte 7,5 com especificidade ≥7, julga ANTES de ver diff e achados do detector
(anti-ancoragem) → ≤2 rodadas → `awaiting_operator` com screenshots lado a lado para escolha
preguiçosa. Fontes genéricas e clichês são defaults penalizados; o brief vence. Duas etapas Claude →
Codex é flag medida, não default. `$imagegen` (`codex exec`, stdin fechado, `--skip-git-repo-check`)
só como asset final. Impeccable = `pbakaus/impeccable` (4.3.1 instalado como plugin; detector Rust
Apache-2.0), pinado por `ENGINE_VERSION`, nunca por versão npm.

**Contexto, Firewall e telemetria.** Pack em ordem de volatilidade: ferramentas → papel → invariantes
do repo (≤1,5k) → skills por id (≤7,5k) → contexto recuperado (≤6k) → contrato → rodada (achados,
falhas de gate, checkpoint) → tarefa; teto 40k (hipótese a medir). Isolamento: `--safe-mode` +
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (nunca `--bare`). Firewall no executor: bruto em `artifacts/`,
extrato ao modelo (falha íntegra mas cercada como dado; sucesso resumido), `ade show <ref>` para
drill-down; hooks `PostToolUse` das CLIs como segunda camada. Telemetria por chamada no journal;
Codex sem USD → tabela de preços com `cost_source: 'estimated'`; OTel export pós-v1. Harness doctor v1
só coleta (injeção, citação via `cited`, custo por item); ablação pareada (Caliper, `claude plugin eval`)
depois, com o ponto cego conhecido do braço Codex.

**Capability Registry e roteamento.** Tabela por papel com primário + 2 fallbacks, degradação via
doctor, `Maker ≠ Checker`. Defaults iniciais (só revisão tem benchmark discriminante): Intent Compiler
Claude forte; classificador barato medido; Maker Claude (Sonnet 5 por padrão, Opus em `subsystem`+;
`--advisor` opcional como alavanca de custo); Checker de rodada Codex; Checker de portão Claude; juiz
visual multimodal de outra família do Maker; pesquisa `agy` → Claude. Histórico de desempenho em
`~/.ade/routing.jsonl`; v1 sugere troca, humano aplica.

**Autonomia.** `safe` (ler, editar, testar, branch, commit local), `controlled` (push, PR, dependências,
migrations), `restricted` (produção, segredos, destrutivo; nunca desatendido). Flags de modo desatendido
por família medidas: Claude `--permission-mode bypassPermissions --permission-prompts none
--disallowedTools "Bash(git *)" "Bash(gh *)"` (glob best-effort; a cerca real é o `env` filtrado e o
engine ser o único a rodar git/gh); Codex `--sandbox workspace-write --approve-for-me` + `.rules`;
`agy` `--approval-mode yolo`. Nunca `--permission-mode auto`.

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

## 9. Decisões que precisam de Erick

1. **Painel e PTY fora da v1** (contraria decisão prévia): v1 entrega `ade report` + `ade takeover` por comando; painel somente-leitura na v0.4; PTY embutido na v0.5+. Recomendação: aceitar; o custo do PTY hoje é o node-pty beta e ~40 % do código.
2. **Duas famílias na v1** (Claude + Codex); Gemini via `agy` só para pesquisa e só quando o canário de isolamento passar. Recomendação: aceitar.
3. **Sem chave de API obrigatória** mantém-se; consequência: sem 4º provider (OpenCode). Família Google só via `agy` (assinatura), nunca via Gemini CLI. Confirmar.
4. **Corte visual 7,5 e teto de 2 rodadas** (contra 8 e 4 da entrevista). Recomendação: aceitar e calibrar no dogfood.
5. **Worker morre com o engine na v1** (uma chamada perdida em crash do engine) em troca de contenção de processos de graça. Recomendação: aceitar.
