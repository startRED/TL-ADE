# Proposta B — Determinismo e durabilidade primeiro

Ângulo B da rodada de rearquitetação da TL-ADE. 2026-09-16. Base: os 66 invariantes de
`docs/research/runtime-port-map.md` §1.1 e o modelo Step/`effect_class`/reconciliação do runtime v0.17.0.

---

## 1. Tese

Otimiza uma coisa: nenhum efeito é feito duas vezes, nenhuma chamada é cobrada duas vezes, todo estado da
missão é reconstruível de um arquivo append-only — inclusive o que a spec v2 trata como exceção
(entrevista, pesquisa, avaliação visual, takeover, sincronização de catálogo), que aqui é `step` com
classe de efeito e regra de reconciliação. Concorrência N>1 não é backlog: é consequência de não escrever
um `Git` singleton no dia 1 (port map §5.1: "barato antes do primeiro commit e caro depois"). Sacrifica
latência do primeiro token (lease + write-ahead + recibo antes de todo spawn), volume de engine antes de
qualquer pixel de painel, e UX reativa — o painel não tem estado próprio, é projeção do journal. A
jornada 1 é protegida por uma faixa rápida explícita (§4), não pela ausência de durabilidade.

---

## 2. Mapa de componentes

**P** = código próprio · **N** = capacidade nativa de CLI/dependência.

| Componente | Responsabilidade | Entrada → saída | P/N | Fase |
| :--- | :--- | :--- | :-- | :-- |
| `Journal` | JSONL, cadeia de hash, `fsync` por linha, escritor serializado | evento → linha + `prev` | P + `canonicalize` | v1 |
| `Step` | Write-ahead intent→efeito→result; idempotência por `input_digest` | intenção → resultado/`ambiguous` | P (I01, I05, I06) | v1 |
| `Reconciler` | Tabela fechada por `effect_class` na retomada | journal + mundo → decisão | P (I08–I16) | v1 |
| `Lease` | Um escritor por lote; `mkdir` + heartbeat 2 s/TTL 6 s; exit 5 | lote → posse | P (I04) | v1 |
| `GitPort` | Uma instância **por worktree**, índice racy, refs de checkpoint/descarte | worktree → árvore, diff, refs | P + `git` (I18–I22, I60) | v1 |
| `JobRunner` | Spawn `detached` + recibo em disco + fingerprint anti-reuso de PID | argv → recibo + resultado | P (I65/I09) | v1 |
| `BinaryResolver` | Resolve o `.exe` atrás do shim npm; `cmd.exe /c` só como fallback | nome → caminho absoluto | P (I66) | v1 |
| `Scheduler` | Até N unidades prontas com `scope_paths` disjuntos e orçamento reservado | DAG → conjunto | P (I57) | v1 |
| `MergeQueue` | Serializa integração na base; regrava `base_before` a cada tentativa | pedidos → uma por vez | P (`tl_supervisor`) | v1 |
| `Contain` | Segurança > escopo sobre a árvore real, pós-fato, cross-family | árvore → ok/restore/stop | P (I22–I26) | v1 |
| `GateRunner` | Portões sobre a árvore do Maker; cache por árvore; restaura sobras | argv + árvore → veredito | P (I31, I32) | v1 |
| `EvalRunner` | Vermelho contra `tree_before`, verde contra `tree_after` | eval → `eval_run` | P | v1 |
| `PackCompiler` | Seções fixas, teto por seção com ponteiro, redação, manifesto | story → pack + manifesto | P (port map §6) | v1 |
| `Adapter` claude/codex | `model_call` = processo headless com id pré-cunhado, schema e teto de custo | pack → result file + uso | P + N | v1 |
| `Adapter` gemini/antigravity | Terceira família (pesquisa, desempate) | idem | P + N | pós-v1 |
| `CapabilityRegistry` | Cache do que o binário aceita, medido por chamada real | sondagem → `CapabilitySet` | P | v1 mín. |
| `ToolOutputFirewall` | Bruto vira artefato; modelo recebe extrato; falha nunca é resumida | saída → extrato + `ref` | P | v1 |
| `SkillFabric`+`SkillGuard` | Filtro → BM25 → seletor → ≤3 skills; sanitização, pin por hash, quarentena | pedido + índice → skills | P | v1 mín. |
| `FrontendQualityEngine` | D1–D7 antes do juiz; juiz de outra família; teto 2 rodadas | rota → `visual_eval` | P + N (`impeccable`) | v1 parc. |
| `ResearchTeam` | 2–4 chamadas paralelas somente-leitura | pergunta → `research-finding` | P | v1 mín. |
| `IntentCompiler` | Classifica, expande, ≤5 perguntas, emite plano validado | pedido → `plan.json` | P + N | v1 |
| `Panel` | Projeção: índice SQLite reconstruível + WS; ação vira step | journal → tela | P | v1 |
| `Takeover` | Checkpoint, CLI interativa no mesmo worktree, `human_takeover/_release` | pedido → sessão + árvore | P + N | v1 (PTY) |
| `HarnessDoctor` | Contadores de injeção/citação/custo por skill e regra | journal → ranking | P | v1 coleta |
| `RoutingHistory`, `Graft`, `Memory` de repo, loop de CI | histórico com Wilson; grafo; notas; fatia de log | — | P/N | pós-v1 |
| `ade routines`, export OTel, `render_report`/`project_batch`/`notify_argv`, `price_table`, `advisor_policy` | — | — | — | cortado |

**Não corta nunca** (port map §4): `gates.canonical` no CLOSE, `--accept-stale-version`,
`continue_independent_after_block`, `tl_ci_slice.normalize` (assinatura do detector de loop, usada mesmo
com CI desligada).

---

## 3. Contratos

```ts
type EffectClass =
  | "model_call" | "local_commit" | "push" | "pull_request" | "pull_request_merge"
  | "local_merge" | "ci_rerun" | "ci_query" | "gate" | "prepare"
  | "human_takeover" | "human_release" | "visual_eval" | "research" | "eval_run";  // 5 novas

interface JournalEvent {                        // porte literal do envelope + aditivos
  format_version: 1; seq: number; at: string;   // UTC sem milissegundos
  kind: "step_intent"|"step_result"|"unit_state"|"batch_state"|"note"|"attempt";
  prev: string;                                 // 16 hex do SHA-256 da linha anterior (JCS)
  step_id: string; effect_class?: EffectClass;
  input_digest?: string;                        // NÃO inclui intent_context (I17)
  intent_context?: Record<string, unknown>;     // remote_before, base_before, HEAD, tree
  worktree?: string;                            // NOVO — sem ele tree_before/after é ambíguo em N>1
  receipt_path?: string;                        // NOVO — I65
  session_ref?: string | null;                  // id pré-cunhado; null quando o transporte não permite
  status?: "ok"|"failed"|"released"|"ambiguous";
  tree_before?: string; tree_after?: string; evidence?: string[];
}

interface Story {                               // Task Contract, dentro de plan.schema.json
  id: string; epic: string; title: string; intent: string;
  requirements: string[];                       // EARS: "WHEN <cond> THE SYSTEM SHALL <comportamento>"
  scenarios: { id: string; when: string; then: string }[];
  evals: Eval[];                                // ≥1; cada um aponta um scenario_id
  scope_paths: string[]; do_not_touch: string[]; dependencies: string[];
  gates: string[]; skills: string[];            // ≤3, fixadas no prepare
  maker: { family: string; model_id: string }; checker: { family: string; model_id: string };
  spec_revision: string;                        // sha256 do objeto serializado
  passes: boolean;                              // ÚNICO campo gravável por um agente
}
interface Plan {
  schema_version: 1; epics: Epic[]; stories: Story[];
  approval: { digest: string; approved_at: string; permitted_effects: PermittedEffects };
  autonomy_level: "safe"|"controlled"|"restricted"; concurrency: number;   // NOVOS
  budget: { max_model_calls: number; max_rework_rounds_per_unit: number; max_usd?: number };
  frozen_scope: { paths: string[]; immutable_digest: string };             // I53
}

interface Eval {                                // NOVO schema (8º): o contrato de "pronto"
  id: string; scenario_id: string; kind: "command"|"http"|"visual"|"schema";
  cmd: string[]; cwd: string; expect_exit: number; timeout_s: number;
  max_output_bytes: number;                     // o firewall mora no contrato, não num wrapper
  evidence: string[];
  strictness: { mode: "tree_before"|"mutate"; must_fail: true };
}

interface ActionItem {                          // review-result: forma RICA, validada com ajv
  id: string; severity: "critical"|"high"|"medium"|"low";
  category: "patch"|"bad_spec"|"intent_gap"; target_role: "maker"|"planner"|"human";
  location: string; problem: string; evidence: string; required_action: string;
}
// summary NUNCA é lido: summary := problem; findingsDigest := sha256(sorted(problem))

type VisualEval = {                             // judge PINADO, senão a métrica anda com o modelo
  round; gates{D1..D7:"pass"|"fail"}; criteria[{id,score:number|"n/a",weight}]; final;
  defects[{severity:"P0".."P3",where,what}]; judge{family,model_id};
  shots[{url,width,theme,sha256}] };
type ResearchFinding = {
  question_id; recommendation; rejected[];
  evidence[{url,quote,tier:"oficial"|"codigo"|"release"|"paper"|"eng"|"comunidade"}];
  confidence:"verificado"|"inferido"|"hipotese" };

// Projeções — NÃO viram schema publicado (cache do doctor / campos do step / view do índice)
interface CapabilitySet {
  family: string; binary: { path: string; strategy: "direct"|"shim_resolved"|"cmd_wrapper" };
  models: string[]; effort: string[];           // lidos do handshake/--help, nunca hardcoded
  structuredOutput: "json-schema"|"output-schema"|"prompt_only";
  preMintedSessionId: boolean; budgetCap: boolean; imagegen: boolean;
  usage: { tokens: "breakdown"|"none"; cost: "usd"|"unknown" };
  probedAt: string; probeCallOk: boolean;       // uma chamada real, não presença de binário
}
type SkillIndexEntry = {                        // content_hash muda ⇒ reaprovação (anti rug pull)
  name; source_repo; path; description; tags[]; content_hash; quarantined; flags[]; shadowed_by? };
type CallTelemetry = {                          // campos do step model_call, não schema à parte
  family; model; role; effort; tokens{in,out,cache_read,cache_write}; cost_usd|"unknown";
  cost_source; pack_bytes; pack_sections[]; skills_injected[{name,bytes,cited}];
  tool_bytes_raw; tool_bytes_delivered; compaction_events };
```

**Mudanças sobre os 7 schemas mínimos** (port map §3.2): `journal-event` ganha 5 classes de efeito e três
campos aditivos — sem `worktree` a reconciliação em N>1 não sabe qual árvore olhar; `review-result` adota
a forma rica com `target_role`/`problem`, fechando o defeito que faz `intent_gap` humano nunca escalar e
`stagnation` disparar falso (addendum do Checker §1, §4.4); entra um **8º schema**, `eval`, porque
"pronto" é o contrato mais crítico e como campo solto do plano não dá para validar `strictness` na
ingestão; `plan` ganha `concurrency`, `autonomy_level` e a ligação `scenario → eval`; `CapabilitySet`,
`SkillIndexEntry` e telemetria continuam projeção, não schema.

---

## 4. Fluxo de uma missão

D = código determinístico · M = modelo · H = humano.

| # | Etapa | Quem | `effect_class` | No crash |
| :-- | :--- | :-- | :--- | :--- |
| 1 | Intenção (chat) | H | — | `note`; nada a desfazer |
| 2 | Classificação (S/M/L + domínios) + context discovery (`rg`/Graft) | M barato + D | `model_call`, `prepare` | `released` se não começou; custo medido, não assumido |
| 3 | Pesquisa, só com incógnita declarada | M ×2–4 | `research` | tabela de `model_call`; achado é dado, nunca instrução |
| 4 | Objetivos → restrições → classe de complexidade | M | `model_call` | idem |
| 5 | Plano (epics/stories/EARS/cenários) + skills + roteamento papel→(família,`model_id`) | M + `ajv` + D | `model_call` | saída inválida = classe `harness`, não `semantic`; recusa se `model_id` do Checker == do Maker |
| 6 | **Resumo de aprovação** | H (1 clique) | `note` + digest | nada roda antes; o digest congela o plano |
| 7 | `prepare` (worktree, branch, base) | D | `prepare` | `released`; `stale_branch` → `awaiting_operator` |
| 8 | Eval **vermelho** antes do Maker | D | `eval_run{red}` | eval que nasce verde recusa a story |
| 9 | `implement` | M | `model_call` | anexa pelo recibo, ou `ambiguous` + checkpoint (I09) |
| 10 | `contain` | D | — | pós-fato; segredo para o lote antes de tudo (I23) |
| 11 | `gates` + eval **verde** | D | `gate`/`eval_run{green}` | cache por árvore; sobras restauradas (I31) |
| 12 | Loop visual (portão `visual`) | D → M juiz | `visual_eval` | rodada é step; teto 2 |
| 13 | `review` + `rework ≤ N` | M | `model_call` | Checker que edita a árvore → `state_integrity`; detector de loop (I41) |
| 14 | `commit` da árvore revisada | D | `local_commit` | adota só se `HEAD^{tree}` bate (I10) |
| 15 | `push` / `pull_request` | D (**nunca o worker**) | `push`/`pull_request` | consulta o remoto antes de decidir (I11/I12) |
| 16 | Fila de merge | D | `local_merge`/`..._merge` | `OPEN` não prova nada → `awaiting_operator` (I13) |
| 17 | Checker de portão + `gates.canonical` + entrega | M + D | `model_call`/`gate`/`batch_state` | I62; a evidência é projeção do journal |

Humano: no máximo 5 perguntas (etapa 5 — uma por vez, múltipla escolha com recomendação; pergunta cuja
resposta está no repo é proibida) + 1 aprovação (etapa 6). Depois, só em `awaiting_operator`.

**Faixa rápida (classe `trivial`)**, a proteção da jornada 1: as etapas 3–6, 12, 13, 16 e 17 não
acontecem. Sobra 1→2→7→8→9→10→11→14. Sem DAG, plano, Checker LLM, pergunta nem aprovação (o pedido *é* a
aprovação quando `permitted_effects` cabe em `safe`). Continuam journal, write-ahead, contain e eval — a
durabilidade custa ~4 linhas de journal e um `git write-tree`, não cerimônia.

---

## 5. Adapters e transporte

**Decisão, que inverte o veredito de `addendum-adapter-transport-acp-vs-cli.md` §0 por razão de
durabilidade**: na v1 todo `model_call` é **bespoke headless**; ACP entra só no que é atendido e efêmero.
A justificativa são as próprias lacunas que aquele addendum mede em §6:

1. **Id pré-cunhado.** `session/new` não aceita id do cliente (medido no schema). Sem id antes do spawn,
   o `step_intent` grava intenção sem identidade do trabalho: write-ahead deixa de ser write-ahead.
   `claude --session-id <uuid>` resolve (I01/I05).
2. **Teto a priori.** ACP só dá `usage_update` pós-fato; `--max-budget-usd` é limite duro antes do gasto
   (I44 vira preventivo em vez de contábil).
3. **Contrato na fronteira.** `--json-schema` e `--output-schema` honram o schema byte a byte (medido);
   ACP v1 não tem structured output **no protocolo**. Sem isso, `review-result` volta a ser prosa.
4. **Sobrevivência ao crash do engine.** Sessão ACP é conexão JSON-RPC sobre stdio: engine morre, sessão
   morre. `model_call` precisa de processo `detached` + recibo em disco para I09 existir.

As **3 exceções conhecidas** (structured output, id pré-cunhado, escape PTY) deixam de ser exceções e
viram a regra; ACP fica com um papel nomeado e pós-v1: *steering* em turno vivo durante o takeover
(`_meta.steering.supported: true` medido em `claude-agent-acp` e `codex-acp`), onde não há invariante de
durabilidade a proteger porque o humano está presente.

| Família | Transporte v1 | Comando do papel | Ressalvas medidas |
| :--- | :--- | :--- | :--- |
| claude | bespoke `-p` | Maker `--session-id <uuid> --output-format stream-json --max-budget-usd`; Checker de portão `--json-schema "<inline>" --permission-mode plan` | `--json-schema` exige JSON literal, não caminho; shim npm precisa do `.exe` resolvido; sem sandbox de SO em Windows |
| codex | bespoke `codex exec` | Checker de rodada `--json --output-schema <arq> --ignore-user-config --sandbox read-only -o <result>`; `$imagegen` como `model_call` | **nunca** `codex review`/`exec review` (ignora `--output-schema` em silêncio); stdin fechado; `--skip-git-repo-check` |
| gemini/antigravity | bespoke, pós-v1 | pesquisa e desempate | `gemini` não retoma por id; `agy` escreveu fora do `--add-dir` sem aviso → isolamento verificado pelo engine em toda família |
| 4º provider | via `CapabilitySet` | — | ACP nativo é a porta; custa o princípio "sem chave de API" |

**Assumir o terminal** (v1, PTY): engine espera o fim da chamada ou cancela → checkpoint da árvore em
`refs/tl/checkpoints/...` → relança o binário interativo no **mesmo worktree** com `--resume <id>`
(`resume_fidelity:"verified"` só para claude) → `human_takeover` → ao soltar, `human_release` grava a
árvore e o ciclo retoma em `contain → gates → review`. Regra inviolável: **a digitação do operador não é
interpretada; só a árvore conta** — é a única camada que sobrevive ao takeover, já que `auto-mode`,
`execpolicy`, sandbox e `--disallowedTools` saem todos do caminho quando o humano digita.

**Dono do worktree e do processo: a ADE, sempre.** `claude --worktree`, `--tmux`, `--bg` e
`claude agents` são rejeitados: existem numa família só e o journal precisa referenciar o worktree que
ele mesmo criou. `node-pty` é I/O de terminal e nada mais — `pty.kill()` nunca mata a árvore (pode matar
PID alheio até 5 s depois, #967); encerra-se com `taskkill /T /F /PID` do PID do recibo, e o Job Object
que o libuv já cria cobre o caso comum de graça.

---

## 6. Durabilidade

| Invariante | Como sobrevive |
| :--- | :--- |
| Cadeia de hash (I02) | `canonicalize` (RFC 8785) em vez de reimplementar `json.dumps`; linha adulterada = exit 2 |
| `fsync` por linha (I03) | fd aberto + `writeSync` + `fsyncSync` — `appendFileSync` não garante flush |
| Write-ahead (I01) | um `step()` por unidade, fila serializada de append; dois `step()` concorrentes na mesma unidade são proibidos |
| Reconciliação (I08–I16) | porte literal da tabela; `model_call` passa a depender do recibo em disco, não do handle do processo |
| Checkpoint/descarte (I18, I19) | `commit-tree` + `update-ref` em `refs/tl/{checkpoints,discarded}`; nada é apagado sem cópia |
| Lease (I04) | `mkdir` + heartbeat/TTL + `kill(pid,0)`; `LockFileEx` no addon nativo só se o doctor mostrar falso-morto |
| `contain` (I22–I26) | diff integral com `maxBuffer` explícito — o default de 1 MiB trunca a varredura de segredo **em silêncio** |
| Orçamento (I44–I47) | reserva Maker+Checker antes da unidade; teto em USD só sobre custo observado; `unknown` nunca vira estimativa |
| Loop (I41) | 5 regex de normalização literais; `findings_digest` agora sobre `problem`, não sobre string vazia |
| Contenção (I64/I65) | recibo + `detached` + fingerprint + `taskkill /T`; addon napi-rs só se `doctor_containment_selftest_per_adapter` falhar com CLI real |
| Ambiente do worker (I49) | `env` explícito no spawn; herdar `process.env` por omissão é o bug fácil em Node |

**Matriz de crash por fase:**

| Crash \ fase | `prepare` | `implement` | `gates`/`eval` | `commit`/`push`/PR | `merge` | takeover | visual/pesquisa |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Engine** | `released` | recibo `running` → anexa; terminal sem result → `ambiguous`+checkpoint | `released`; cache por árvore | consulta remoto/`gh`; nunca duplica | `OPEN` não prova nada → operador | árvore vira checkpoint | rodada é step; achado gravado não repete |
| **Worker/CLI** | n/a | `ENOENT`/`start_failed` = `released` (não cobra); resto = `ambiguous` | `semantic` ou `harness` por regex | n/a (efeito é do engine) | n/a | sessão morre, árvore é a verdade | não começou = `released` |
| **Máquina** | idem, após `index --rebuild` | recibo sobrevive ao reboot; PID morto ou fingerprint diferente → `ambiguous` | idem | idem | idem | vira `awaiting_operator` | idem |
| **Browser** | — | — | — | — | — | painel reconecta e relê a projeção | shot é artefato em disco |

O painel nunca é fonte: fechar o navegador não muda estado, o índice é reconstruível, ação de operador
vira step antes de virar efeito.

**Concorrência: N-capaz no dia 1, ligada em N=2 só para `subsystem` e `project`; N=1 no resto.** O custo
de N está inteiro em decisões de dia 1 (GitPort por worktree, `next_ready` devolvendo conjunto,
`worktree` no evento, fila de merge), que ficam caras depois do primeiro commit. N=2 nas duas classes
maiores é o menor valor que **exercita** fila de merge, sweep de órfãos e `claim_scope` no dogfood — com
N=1 esse código apodrece não executado, exatamente como `tl_supervisor.py` hoje. Classes menores não
ganham: `feature` raramente tem duas stories com `scope_paths` disjuntos, e cada worktree a mais
multiplica a exposição ao ciclo de vida de processo. Reversão: `plan.concurrency: 1`.

---

## 7. Subsistemas

**Skill Fabric.** Filtro duro por domínio/linguagem/origem descarta ~80 %; BM25 local sobre `index.json`
devolve top-8 em milissegundos e US$ 0; um seletor barato recebe spec + as 8 descrições e fecha ≤3 skills
com motivo. Sem reranker (cross-encoder *piora* retrieval de ferramenta: nDCG@10 33,83 → 28,92) e sem
embedding (exigiria chave de API). Skill entra como **bloco fixo do pack, em ordem estável por id**:
ordenar por relevância mata o prefixo cacheável, e entrar como `tool_result` a torna candidata à limpeza
automática de resultados. Segurança v1: allowlist de fonte, pin por `content_hash` com reaprovação,
sanitização estática na sincronização (a defesa medida — ASR 36,0 % → 7,2 %, melhor que interceptação em
runtime), nunca executar script de catálogo, `contain` inviolável, corte da lethal trifecta, teto de 3 e
escolha no journal. Fixtures medem `recall@8 ≥ 0,85` e `precision@3 ≥ 0,75`.

**Frontend Quality Engine.** Build verde → serve → a11y snapshot + console + rede + computed styles →
**D1–D7** → screenshots de viewport (`fullPage:false`) → juiz. D1–D4 (console, 4xx/5xx, contraste AA,
overflow em 390 px) são `critical`; D5 é `impeccable detect --json` contra a **URL servida** (o modo
arquivo estático pegou 2 de 6 anti-patterns numa fixture); D6 é oxlint com `anti-slop` vendorizado; D7
exige rota de estado declarada. Reprovação determinística nunca chega ao modelo. O juiz é o **melhor**
multimodal de outra família, `model_id` pinado, sem ver o diff, sem histórico de rodadas e **antes** de o
achado do detector entrar no contexto (anti-ancoragem, citação literal). Teto **2 rodadas**; corte final
a calibrar por dogfood entre 7,0 e 8,0 — nenhuma pesquisa tem medição própria. v1: D1–D5 + juiz.

**Tool Output Firewall.** Mora no **executor da ADE**: `PreToolUse.updatedInput` e
`PostToolUse.updatedResponse` só existem no Claude Code, e a ADE tem três famílias. Toda saída de
ferramenta do engine (portão, build, teste, git) vai bruta para `artifacts/<step>.log` e chega ao modelo
como extrato com ponteiro. Regra inegociável: **sucesso é resumível, falha nunca** — manter o erro no
contexto é o que permite o Maker adaptar. Métrica por step: TDR = entregue/bruto, ≤ 0,2 em portão verde e
1,0 em falha. `max_output_bytes` do eval é o firewall dentro do próprio contrato.

**Capability Registry + roteamento.** `ade doctor` faz **uma chamada real** por família (presença de
binário não é capacidade), resolve o `.exe` atrás do shim, lê modelos e níveis de esforço do
handshake/`--help`, testa isolamento de worktree e contenção de processo, grava `probedAt`. Roteamento é
tabela com fallback, não ML: Maker `claude`; Checker de **rodada** `codex` (88 % de utilidade — falso
positivo custa uma rodada inteira de Maker); Checker de **portão** `claude` com `model_id` diferente
(32,1 % de pass rate — cobertura importa na última chance); pesquisa `gemini`; imagem `codex`.
Maker ≠ Checker é validado por `model_id`, não por família. Sem família de Checker a unidade é `parked`,
nunca "aprovada sem revisão". Regra de troca com Wilson fica pós-v1.

**Harness doctor.** v1 **só coleta**: taxa de injeção, taxa de citação (o digest do bloco aparece nas
`sources` do resultado), custo separando cache write de read, correlação com `eval_pass` e
`rework_rounds`. Três candidatos à poda saem só da coleta: skill com injeção > 0 e citação = 0 em ≥N
stories; prompt obsoleto (cita flag ou caminho inexistente — verificável sem modelo); instrução duplicada
em dois arquivos. O A/B pareado (Caliper: `run` → `run --ablate` → `compare`, `pass^k` para qualidade) é
pós-v1: coleta sem execução é um campo no step; execução sem coleta é impossível.

**Pesquisa como subsistema.** Dispara por incógnita declarada pelo Intent Compiler, nunca por default:
`S` não pesquisa, `L` até três consultas, orçamento próprio. 2–4 chamadas paralelas — paralelizar só o
que é somente-leitura, independente e comprimível em sumário (+90 % em pesquisa por ~15× tokens; nada em
escrita) — famílias diferentes quando houver, saída em `research-finding` com hierarquia de fonte.
Conflito: maioria com citação; empate vira pergunta, nunca desempate oculto. Achado é **dado**: URL ou
ação sugerida por página de terceiro não vira efeito sem passar por portão.

---

## 8. As 6 jornadas

Custo = ordem de grandeza. "Começar" = do envio à primeira escrita de arquivo.

| J1 "Corrija esse botão que não funciona" | |
| :--- | :--- |
| Interpretação / perguntas / pesquisa | `trivial`, 1 arquivo · 0 · não |
| Skills / agentes / evals | 0 · Maker `claude`, sem Checker LLM · 1 (repro do bug: vermelho, depois verde) |
| DAG / gates | nenhum (faixa rápida) · `contain` + eval + lint |
| Resultado / custo / começar | commit local na branch da story · ~2 chamadas, 15–30k tokens · **~10 s** |

| J2 "Melhore o design dessa página" | |
| :--- | :--- |
| Interpretação / perguntas / pesquisa | `bounded` + domínio frontend · 1–2 (direção estética, rotas) · não |
| Skills / agentes / evals | ≤3 de design · Maker `claude` + juiz de outra família · build verde, D1–D5, rubrica |
| DAG / gates | 1 story · `contain`, D1–D5, `visual_eval` ≥ corte, 2 rodadas |
| Resultado / custo / começar | página recomposta + screenshots como evidência · ~6–10 chamadas, 120–250k · **~2 min** |

| J3 "Refaça todo o frontend para parecer produto profissional" | |
| :--- | :--- |
| Interpretação / perguntas / pesquisa | `subsystem` · 3–4 (direção, rotas prioritárias, tema escuro, intocáveis) · 1 consulta (stack e tokens existentes) |
| Skills / agentes / evals | ≤3 por story · Maker `claude`, Checker `codex`, juiz 3ª família · build + D1–D7 + rubrica por story |
| DAG / gates | 9–20 stories, **N=2** com `scope_paths` disjuntos · por story + `gates.canonical` + fila de merge |
| Resultado / custo / começar | PRs por epic, merge serializado · ~80–200 chamadas, 3–8M · **~6 min** |

| J4 "Adicione billing com Stripe" | |
| :--- | :--- |
| Interpretação / perguntas / pesquisa | `feature` · 2–3 (modelo de cobrança, ambiente de teste, o que é `restricted`) · 2 consultas (API vigente, webhooks) — o caso canônico de "não tenho evidência para planejar" |
| Skills / agentes / evals | ≤2 · Maker `claude`, Checker `codex` · contrato de endpoint + **caso negativo** (webhook com assinatura inválida → 4xx) + migração idempotente |
| DAG / gates | 4–8 stories · `contain` (chave no diff **para o lote**), evals, Checker de portão, `secrets_read:false` |
| Resultado / custo / começar | PR por epic, merge manual · ~25–50 chamadas, 0,6–1,5M · **~4 min** |

| J5 "Crie um SaaS novo a partir dessa ideia" | |
| :--- | :--- |
| Interpretação / perguntas / pesquisa | `project` · 5 (as irreversíveis: produto, público, stack, modelo de dados, o que **não** entra) · 3 consultas paralelas com desempate |
| Skills / agentes / evals | ≤3 por story · Maker `claude`, Checker `codex`, portão `claude` outro `model_id`, juiz 3ª família · eval por story + e2e por epic |
| DAG / gates | por epic, 30–60 stories, **N=2**; step inicializador gera o feature list antes do primeiro Maker · todos + visual + `gates.canonical` + fila de merge |
| Resultado / custo / começar | repositório novo com CI verde e PRs por epic · ~200–500 chamadas, 8–25M · **~12 min** |

| J6 "Continue desenvolvendo sozinho enquanto durmo" | |
| :--- | :--- |
| Interpretação / perguntas / pesquisa | retoma o plano vivo, sem nova entrevista · 0 · só se uma story declarar incógnita |
| Skills / agentes / evals | por story · roteamento normal · inalterados (é o mesmo ciclo) |
| DAG / gates | o que estiver pronto no grafo, **N=2**, `continue_independent_after_block: true` · os mesmos + `max_parked_units`, `max_wall_clock_seconds`, teto de USD sobre custo observado |
| Resultado / custo / começar | fila de `awaiting_operator` de manhã + PRs prontos; nada mergeado em `restricted` · limitado pelo orçamento do lote · **~5 s** (é retomada) |

A assimetria certa: J1 gasta 4 linhas de journal e nenhuma pergunta; J5/J6 gastam o processo inteiro.

---

## 9. Cortes YAGNI

| Corte | Pedido em | Motivo |
| :--- | :--- | :--- |
| ACP como transporte de `model_call` | pesquisa (addendum) | Quebra id pré-cunhado, teto a priori e structured output — três invariantes por um handshake |
| CI (`ci_rerun`, `ci_query`, loop de fatia) | spec §6 | `ci.enabled:false` é o default; `normalize/signature` **fica**, é o detector de loop |
| `ade routines` / agendamento | princípio 13 | Nada a agendar antes de existir missão que roda |
| Exportação OTel / collector | princípio 9 | `gen_ai.*` é Development, sem tipo de token de cache nem custo; o journal já é a fonte |
| Memória por usuário, Mem0/Letta/Zep, embeddings de memória | princípio 9 | Benchmark é do problema errado (QA sobre conversa), números em disputa entre fornecedores, ganho já obtido por excerpt+digest |
| Reranker e embeddings na seleção de skills | princípio 5 | Medido piorando; e exigiria chave de API |
| Addon nativo (Job Object com `CREATE_SUSPENDED`, `flock`) | I64/I04 | libuv já dá kill-on-close no caso comum; promovido só se o selfteste por adapter falhar |
| Pixel-a-pixel, SaaS visual, computer use, MCP de browser | princípio 7 | Não há golden numa tela recém-nascida; 58–70 ferramentas no contexto por capacidade que a API do Playwright já dá |
| Roteamento automático por histórico | princípio 15 | Sem n ≥ 20 por `(papel, domínio, tamanho)` a troca é ruído; v1 sugere, humano aplica |
| A/B executado do harness doctor | princípio 1 | v1 coleta; executar antes de ter amostra mede nada |
| `render_report`, `project_batch`, `notify_argv`, `price_table`, `advisor_policy`, `Unit.kind`, `stop_conditions[18]` | runtime de referência | Projeções e campos mortos; risco de durabilidade zero |
| Painel com estado próprio (otimismo local, cache de missão) | spec §11 | Painel é projeção; estado no cliente é a porta de entrada da divergência |
| Tauri, multiusuário, SDK de API, sandbox de FS do worker | spec §14 | Nenhum resolve um invariante |

---

## 10. Roadmap em vertical slices

| Fase | Entrega | Pronto |
| :--- | :--- | :--- |
| **MVP (slice 1)** | Jornada 1 ponta a ponta, sem painel | abaixo |
| **v0.2** | Story completa (`prepare→…→commit`), Checker `codex` com `review-result` validado, plano de 1 epic | paridade em Vitest (mesmo nome de caso) para I01–I32 e I41–I47 |
| **v0.3** | DAG + N=2 + fila de merge + sweep de órfãos + push/PR | dois worktrees disjuntos fecham em paralelo e integram serializado; crash na fila não duplica merge |
| **v0.4** | Painel (projeção + WS + fila de escalação) e takeover PTY | fechar o navegador no meio de uma story não muda nada; assumir, editar, soltar → engine retoma do checkpoint |
| **v0.5** | Intent Compiler (classificação, camadas, ≤5 perguntas, plano, resumo) + pesquisa | fixture "quero melhorar o design" gera plano com tamanho, domínios, skills e evals esperados |
| **v0.6** | Skill Fabric + SkillGuard + firewall completo | `recall@8 ≥ 0,85`, `precision@3 ≥ 0,75`, `hard_miss = 0`, `contamination = 0` |
| **v1** | Frontend Quality Engine, harness doctor coletando, `ade doctor` completo | fixture ruim reprova, boa passa em 1 rodada; jornadas 1–5 rodam do chat |
| **Futuro** | ACP/steering, gemini/antigravity, Graft, rotinas, roteamento por histórico, A/B Caliper, addon nativo, CI | cada um com o seu eval |

### Slice 1 — "journal + step + recibo + uma chamada real"

- **Objetivo**: `ade run --story <arquivo>` executa uma story `trivial` num repositório real — lease,
  `prepare` em worktree, eval vermelho, uma chamada `claude -p` com id pré-cunhado, `contain`, eval
  verde, `local_commit` — tudo no journal e retomável.
- **Aceite**: (1) `SIGKILL` em cada um dos 6 pontos de injeção de falha e retomada sem repetir efeito nem
  cobrar chamada; (2) linha adulterada recusada com exit 2; (3) `ade index --rebuild` idêntico ao
  incremental; (4) worker com `env` filtrado e sem conseguir rodar `git`/`gh`; (5) segredo plantado no
  diff para o lote **antes** do commit.
- **Evals**: porte em Vitest, com o mesmo nome, de `test_crash_before_maker_effect_releases_the_call`,
  `..._after_maker_effect_consumes_call_and_continues_from_checkpoint`,
  `..._after_commit_is_reconciled_without_a_second_commit`, `test_journal_hash_chain_detects_tampering`,
  `test_worker_env_is_scrubbed`, `test_secret_in_diff_stops_batch`; mais quatro novos —
  `receipt_running_state_is_readable_mid_flight_by_a_cold_process`,
  `reconcile_rejects_pid_reuse_via_fingerprint_mismatch`,
  `doctor_resolves_npm_shim_to_real_exe_on_windows`,
  `canonicalize_output_byte_identical_to_python_reference_fixture`. CLI falsa com contador **em disco**,
  `no_result` e captura de pack+env — o trio que torna os testes de crash possíveis sem mock.
- **Dependências**: Node 22+, `canonicalize`, `ajv`, `git`, `claude` via `BinaryResolver`.
- **Risco**: o canonicalizador e a ordem `writeSync`/`fsyncSync`/`rename` são invisíveis quando errados —
  mitigados por paridade byte a byte contra fixture de referência e injeção de falha entre as chamadas.
- **Pronto**: os 10 testes verdes em Windows e Linux, em paralelo por worker com tmpdir próprio, e uma
  story real da própria ADE fechada por este caminho (primeiro dogfood).

---

## 11. Riscos e reversão

**R1 — A durabilidade engole a jornada 1.** 66 invariantes antes do primeiro pixel, e "corrija esse
botão" vira um lote. Sintoma: `começar` de J1 acima de 30 s ou mais de 2 chamadas. Mitigação: a faixa
rápida é requisito com eval próprio no slice 1, não otimização posterior. **Reversão**: se os steps ainda
pesarem, grava-se J1 como **um** step composto (`prepare+implement+gate` num intent só) — perde-se
granularidade de reconciliação numa classe onde não há efeito externo a reconciliar.

**R2 — Bespoke amarra a ADE ao formato de saída de três CLIs que mudam sem aviso.** Troca-se um handshake
declarativo por `--help` parseado e versionado. Sintoma: `ade doctor` falhando a cada release;
`--approve-for-me` ou `--json-schema` sumindo. Mitigação: `CapabilitySet` medido por chamada real com
`probedAt`, CLIs falsas cobrindo saída normal/truncada/sem custo/com ANSI, e
`no_checker_family_available` parkando em vez de aprovar. **Reversão**: o adapter já é interface; migrar
uma família para ACP é implementar `spawn/parseEvents/costOf` sobre JSON-RPC e aceitar que ela perde id
pré-cunhado e teto a priori — o journal grava `session_ref: null` e o id passa a ser registrado no
`step_result`. Decisão reversível por família, não em bloco.

**R3 — N=2 no dia 1 compra modos de falha que N=1 não teria.** Duas irmãs com `scope_paths` disjuntos
ainda conflitam em `package.json`/lockfile; crash com dois worktrees deixa dois órfãos; cada processo a
mais amplia a exposição ao ciclo de vida de PTY/ConPTY. Mitigação: N=2 só nas duas classes maiores; gates
da unidade rodam **depois** da integração, não só antes; sweep de órfãos com heartbeat +
`git worktree prune` no `ade doctor` e no shutdown. **Reversão**: `plan.concurrency: 1` — o código
continua N-capaz e não executado, que é exatamente o estado do `tl_supervisor.py` hoje e o motivo de eu
preferir ligá-lo em N=2 a deixá-lo apodrecer.

**Outras decisões-chave, reversão em uma linha**: forma rica do `review-result` → voltar à enxuta é
trocar dois campos e perder o painel; `eval` como 8º schema → reabsorver em `plan` e perder validação de
`strictness` na ingestão; juiz no melhor modelo → é config (`visual.judge`), mas a métrica deixa de ser
comparável entre lotes; firewall no executor → desligar é uma flag, o custo é contexto e não correção;
skills como bloco fixo do pack → voltar a `tool_result` custa o prefixo cacheável, mensurável pelo
próprio harness doctor.
