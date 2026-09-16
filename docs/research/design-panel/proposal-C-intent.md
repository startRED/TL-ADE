# Proposta C — Intenção e qualidade no centro

Ângulo: o produto da TL-ADE é o **Intent Compiler + Task Contract + eval-first + Frontend Quality
Engine**. Engine, adapters e painel são infraestrutura que existe para que o contrato seja escrito
bem, provado e entregue. Data: 2026-09-16. Toda afirmação factual cita o documento de pesquisa.

---

## 1. Tese

Esta arquitetura otimiza **acerto de interpretação por unidade de atenção humana**. O dado que a
orienta é o SWE-EVO: 25 % de resolved rate contra 72,8 % do mesmo modelo em SWE-bench Verified, e
**>60 % das falhas dos modelos fortes são instruction following**, não janela nem sintaxe
(`landscape-harnesses.md` §1.1). Logo o orçamento de complexidade vai para o contrato (EARS,
cenários ligados a evals, prova vermelha, brief de design), não para o orquestrador. Sacrifica:
concorrência N>1, ACP e steering na v1, catálogo de skills em escala, rotinas autônomas, painel
rico. Aceita ser mais lenta em largura para ser certa em profundidade — e o corte é reversível
porque o engine durável é portado inteiro.

---

## 2. Mapa de componentes

`P` = código próprio. `N` = capacidade nativa de CLI/dependência. Marcação v1 / pós-v1 / cortado.

| Componente | Responsabilidade (1 frase) | Entradas → saídas | P/N | Fase |
| :--- | :--- | :--- | :--- | :--- |
| **Intent Compiler** | Transforma pedido impreciso em Task Contract validável, detectando incógnitas antes de perguntar. | pedido + discovery + classe → `Plan` | P + 2 chamadas com `--json-schema`/`--output-schema` (N) | v1 |
| **Classificador de complexidade** | Decide a classe e com ela quanto processo é liberado. | pedido + mapa do repo → `{class, domains, confidence}` | P + 1 chamada barata (N) | v1 |
| **Context Discovery** | Responde "o que já existe?" antes de qualquer pergunta ao humano. | repo → arquivos, símbolos, testes, spec viva | P sobre `git`/`rg` | v1 |
| Graft | Troca grep+read por consulta a grafo. | repo → esqueleto/callers | N (dep. opcional, fallback rg) | pós-v1 |
| **Entrevista mínima** | ≤5 perguntas, só irreversível, de produto ou não inferível do repo. | incógnitas → contrato fechado | P (pergunta respondida pelo repo é recusada na validação) | v1 |
| **Pesquisa como subsistema** | Reconhece ausência de evidência e produz `research-finding` com hierarquia de fontes. | pergunta → 2–4 agentes → síntese JSON | P + `--json-schema` (N) | v1 (2 agentes, classes ≥ feature) |
| **Validador de contrato** | Recusa plano sem eval por cenário, sem `do_not_touch`, sem classe, sem brief quando há UI. | `Plan` → ok/refusal | P (`ajv`) | v1 |
| **Eval Runner + prova vermelha** | Prova por execução que o eval falha antes e passa depois. | `Eval[]` + `tree_before` → `eval_run` | P sobre `tree_before` (`landscape-evals-visual.md` §2.3) | v1 |
| **Engine durável** | Journal write-ahead, reconciliação, checkpoint, lease, contain, orçamento, detector de loop. | steps → `journal.jsonl` + árvore | P (porte dos 66 invariantes) | v1 |
| **Context Pack compiler** | Um prompt por chamada: ordem fixa, teto por seção, manifesto como evidência. | contrato + skills + contexto → `pack.md` | P (port-map §6 + ordem de cache de `landscape-context-observability.md` §1.3) | v1 |
| **Tool Output Firewall** | Bruto vira artifact; o modelo vê extrato; falha nunca é resumida. | stdout/stderr → `artifacts/` + extrato + TDR | P no executor (hooks são reforço) | v1 |
| **Adapters bespoke** | Chamada headless com id pré-cunhado, schema de saída e teto de custo. | `{cwd, pack_path, model, effort, schema}` → eventos + usage | P fino sobre flags nativas (N) | v1 |
| Transporte ACP | Sessão viva, steering, takeover sem matar processo. | JSON-RPC | N (`claude-agent-acp` 0.78, `codex-acp` 1.12) | pós-v1 |
| **Capability Registry** | Declara o que cada família faz e roteia papel por capacidade + histórico. | `ade doctor` + `routing.jsonl` → família/modelo | P (tabela + view SQL + Wilson) | v1 manual; automático pós-v1 |
| **Skill Fabric** | ≤3 skills por story sem pôr o índice no contexto. | índice + spec → 3 corpos no pack | P (BM25 ~80 linhas) + 1 chamada barata (N) | v1 (~60–80 skills) |
| **Sanitizador de skills (C1–C9)** | Impede que conteúdo de terceiro vire instrução ou execução. | `SKILL.md` → índice/quarentena | P (~200 linhas) | v1 |
| **Frontend Quality Engine** | Detecta UI, exige brief em 4 camadas, roda D1–D7, só então chama o juiz. | story de UI → `visual-eval` | P (Playwright lib) + `impeccable detect` (N, Apache-2.0) | v1 |
| **Harness doctor** | Mede o custo de cada item do harness e poda o que não se paga. | telemetria → relatório/ablação | P (coleta) + `claude plugin eval` (N) | v1 coleta; ablação pós-v1 |
| **Painel** | Missão, chat, escalações, custo. | WebSocket ← journal | P (React/Fastify) | v1 mínimo |
| PTY "assumir o terminal" | Devolve a TUI nativa ao operador. | node-pty + `--resume` | P + N | pós-v1 |
| Spec viva (`.ade/spec/`) | Acumula o que o projeto já promete, delta por lote. | contrato fechado → delta arquivado | P (OpenSpec conceitual) | pós-v1 |
| Concorrência N>1 / fila de merge | Worktrees paralelas com `scope_paths` disjuntos. | — | P | pós-v1 |
| Rotinas autônomas | Lotes recorrentes de manutenção. | — | P | pós-v1 |
| 4º provider (OpenCode), MCP no caminho automático, `$imagegen` como referência de cópia, `codex review` como Checker, `alibaba/open-code-review`, embeddings na seleção | — | — | — | **cortado** |

---

## 3. Contratos

Pseudo-TypeScript curto. O eixo é o `TaskContract`: **a story é o contrato**, não um item de plano
com campos soltos.

```ts
type Complexity = "trivial" | "bounded" | "feature" | "subsystem" | "project";

interface TaskContract {          // uma story
  id: string; epic?: string; title: string;
  intent: string;                              // uma frase, o "porquê"
  complexity: Complexity;
  requirements: string[];                      // EARS: "WHEN <evento> THE SYSTEM SHALL <comportamento>"
  scenarios: { id: string; when: string; then: string }[];
  evals: Eval[];                               // ≥1; todo scenario.id referenciado por ≥1 eval
  scope_paths: string[]; do_not_touch: string[];
  guardrails: string[];                        // invariantes citáveis por gate, não prosa
  design_brief?: DesignBrief;                  // obrigatório se domains inclui UI
  skills: SkillRef[];                          // ≤3, fechadas no prepare
  maker: RoleBinding; checker: RoleBinding;    // Maker ≠ Checker por model_id
  autonomy: "safe" | "controlled" | "restricted";
  passes: boolean;                             // ÚNICO campo gravável pelo agente
}

interface DesignBrief {                        // 4 camadas (landscape-evals-visual.md §4.1)
  product: { audience: string; facts: string[] };        // PRODUCT.md — durável
  tokens: { color: string[]; type: string[]; spacing: string; motion: string };  // DESIGN.md
  mode: "persuade" | "operate" | "read" | "experience";  // modo da superfície
  direction: { palette: string[]; type_roles: string[]; layout: string; signature: string;
               self_critique: string };        // plano de direção + auto-crítica contra o default
}

interface Eval {
  id: string; scenario_id: string;
  kind: "command" | "http" | "visual" | "schema";
  cmd: string[]; cwd: string; expect_exit: number;
  evidence: string[]; timeout_s: number; max_output_bytes: number;
  strictness: { mode: "tree_before" | "mutate"; must_fail: true };
}

interface Plan {
  mission_id: string; request: string; complexity: Complexity;
  stories: TaskContract[]; edges: [string, string][];     // DAG; vazio em trivial/bounded
  approval: { digest: string; approved_at: string; permitted_effects: string[] };
  budget: { max_model_calls: number; max_usd?: number; max_rework_rounds_per_unit: number };
  research?: ResearchFinding[];
}

interface JournalEvent {                       // porte literal do envelope
  format_version: number; seq: number; at: string; prev: string;
  kind: "step_intent" | "step_result" | "unit_state" | "batch_state" | "note";
  effect_class: "model_call" | "gate" | "commit" | "push" | "pull_request" | "local_merge"
    | "eval_run" | "visual_eval" | "research" | "human_takeover" | "human_release";
  status?: "ok" | "failed" | "released" | "ambiguous";
  tree_before?: string; tree_after?: string; worktree?: string;
  session_id?: string; pack_digest?: string; evidence?: string[];
}

interface ReviewResult {                       // forma rica; summary é derivado de problem
  schema_version: 1; verdict: "approved" | "changes_requested";
  action_items: { id: string; severity: "critical"|"high"|"medium"|"low";
                  category: "patch" | "bad_spec" | "intent_gap";
                  target_role: "maker" | "planner" | "human";
                  location: string; problem: string; evidence: string; required_action: string }[];
  deferred: Finding[]; rejected: Finding[];
}

interface EvalRecord {                         // novo schema publicado
  eval_id: string; story_id: string; phase: "red" | "green" | "strictness";
  exit_code: number; duration_ms: number; evidence_refs: string[]; tree: string;
}

interface CapabilitySet {
  family: "claude" | "codex" | "gemini" | "antigravity";
  launch: string[]; requires_shell_on_windows: boolean;
  structuredOutput: "json-schema" | "output-schema" | false;
  mintableSessionId: boolean; budgetCapUsd: boolean;
  resume: "by_id" | "latest_only" | false;
  effort: string[]; models: string[];
  cost: "usd" | "tokens_only" | "unknown";
  imagegen: boolean; unattended_flags: string[];
}

interface SkillIndexEntry {
  name: string; source_repo: string; path: string;
  description: string; when_to_use?: string; tags: string[]; domains: string[];
  content_hash: string;                        // sha256(SKILL.md) — muda ⇒ reabre aprovação
  trust: "local" | "declared" | "quarantined"; flags: string[];
  shadowed_by?: string;
}

interface CallTelemetry {
  mission_id: string; story_id: string; step_id: string; call_id: string;
  family: string; model: string; role: string; effort: string;
  duration_ms: number; ttft_ms?: number;
  tokens: { in: number; out: number; cache_read: number; cache_write: number };
  cost_usd: number | "unknown"; cost_source: "reported" | "estimated" | "unknown";
  pack_sections: { name: string; bytes: number }[];
  skills_injected: { name: string; bytes: number }[];
  tool_bytes_raw: number; tool_bytes_delivered: number; tdr: number;
  outcome: "ok" | "retry" | "rework" | "park" | "stop"; eval_result: "pass" | "fail" | "n/a";
}
```

**O que muda em relação aos 7 schemas mínimos de `runtime-port-map.md` §3.2.** (1) `plan.schema.json`
deixa de ser "epics → stories com campos" e passa a conter `TaskContract` completo: `requirements`
EARS, `scenarios`, `complexity`, `design_brief`, `guardrails` e a regra do campo único gravável
(`passes`) — a ligação `scenario → eval` vira regra dura de validação. (2) **Sobe de 7 para 8
schemas publicados**: `eval.schema.json` sai de dentro do plano e ganha vida própria, porque a prova
vermelha produz `EvalRecord` que é evidência de journal, não item de configuração. (3)
`journal-event` ganha `eval_run` com `phase` e `worktree` (aditivo, como o port-map já previa).
(4) `review-result` adota a forma rica com `target_role` e `summary` derivado, corrigindo o defeito
latente que fazia `intent_gap` para humano nunca escalar e `stagnation` disparar falso
(`addendum-checker-contract-review-result.md` §0/§4). (5) `research-finding` e `visual-eval`
permanecem como estão. (6) `ade-config` ganha `autonomy` (`addendum-autonomia...` §5).
`SkillIndexEntry` e `CallTelemetry` **não** viram schema publicado: são projeção interna.

---

## 4. Fluxo de uma missão ponta a ponta

`[D]` determinístico, `[M]` modelo, `[H]` humano.

| # | Etapa | Quem | Detalhe |
| :-- | :--- | :--- | :--- |
| 1–2 | Intenção → context discovery | `[H]` → `[D]` | Uma frase. `git log`, `rg`, testes relacionados, `.ade/spec/`. Roda **antes** de qualquer modelo: é o que torna a pergunta proibida detectável. |
| 3 | Classificação | `[M barato]` | Classe + domínios + confiança. Custo vigiado por chamada: `claude -p --model haiku` já faturou como sonnet (README #26); se não bater, cai para regra determinística. |
| 4 | Interpretação | `[M forte + schema]` | → `intent`, `requirements` EARS, `scenarios`, incógnitas. Coagida por `--json-schema` nativo, validada por `ajv` (fonte da verdade). |
| 5 | Pesquisa (condicional) | `[M ×2–4]` | Só com incógnita **e** classe ≥ feature. Famílias diferentes, mesma pergunta; empate vira pergunta. Trivial/bounded nunca pesquisam. |
| 6 | Objetivos e restrições | `[D]` | `scope_paths`, `do_not_touch`, `guardrails` do discovery + política do repo. Consulta, não inferência. |
| 7 | Entrevista | `[H] ≤5` | Só o que sobreviveu a 2 e 5. Trivial 0, bounded 0–1, project até 5. Pergunta respondida pelo discovery é recusada na validação. |
| 8–9 | Classe → forma; plano | `[D]` → `[M forte + schema]` | A classe libera processo (§7 da tabela de complexidade). Stories são `TaskContract`; DAG só com dependência real. |
| 10–11 | Skills; agentes/modelos | `[D]` + `[M barato]` / `[D]` | BM25 top-8 → seletor devolve ≤3 com motivo. Capability Registry roteia papel; Maker ≠ Checker por `model_id` (o `agy` serve modelos Claude — README #3). |
| 12 | Aprovação | `[H] ×1` | O que será feito, o que não, custo, skills novas, efeitos externos. `trivial` + `safe` auto-aprova, registrado no journal. |
| 13 | **Prova vermelha** | `[D]` | Cada eval contra `tree_before`, exige exit ≠ 0. Eval que nasce verde é recusado e a story volta ao Intent Compiler, **não** ao Maker. |
| 14–15 | Implementação; contain + gates + evals | `[M forte]` / `[D]` | Sessão nova, pack montado por código, `--max-budget-usd` onde existe. Escrita fora do escopo é violação; evals no executor, com firewall. |
| 16–17 | Loop visual (se UI); revisão | `[D]`+`[M multimodal]` / `[M outra família]` | D1–D7 primeiro, juiz só se passarem, teto 2 rodadas. Checker vê diff + contrato, nunca histórico; `ReviewResult` por `--output-schema`. |
| 18–19 | Refinamento; entrega | `[M]`+`[D]` / `[D]` | Rework parte do checkpoint. Commit/push/PR/merge **sempre pelo engine**; corpo do PR é relatório de evidência. |
| 20 | Escalação | `[H] fila` | `awaiting_operator` só por `target_role: "human"`, orçamento estourado ou empate de pesquisa. |

Total humano no caso denso: 5 perguntas + 1 aprovação. No trivial: zero.

---

## 5. Adapters e transporte

**Decisão v1: bespoke headless puro. ACP entra em v0.x.** Tudo de que o contrato depende é
exatamente o que o ACP **não** tem: nem `PromptResponse` nem `NewSessionRequest` têm campo de saída
estruturada (ausência do protocolo, não do adapter); `session/new` não aceita id cunhado pelo
cliente, o que quebra o write-ahead puro do journal; não há teto de orçamento a priori, só
`usage_update` pós-fato — e o `codex-acp` não emite custo
(`addendum-adapter-transport-acp-vs-cli.md` §0, §3.1, §4, §6). O que o ACP dá de único é **steering
em turno vivo** (`_meta.steering.supported: true`, medido em claude e codex), que serve ao takeover:
valor real, mas de jornada 6, não do contrato. Inverter a ordem é gastar o transporte mais novo para
comprar o que a v1 menos precisa.

Por família, v1: **claude** `claude -p --session-id <uuid> --json-schema <inline> --max-budget-usd
--output-format stream-json --safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`--bare` quebra a
autenticação por assinatura — README #9, #11, #42); **codex** `codex exec --json --output-schema
<arquivo> --sandbox workspace-write --approve-for-me` (nunca `codex review`, que ignora
`--output-schema` em silêncio — medido); **gemini/antigravity** `agy` como binário real
(`gemini` 0.59 exige `GEMINI_API_KEY`), `--json-schema` existe no `agy`, não no `gemini`,
`--approval-mode yolo` para desatendido, e **verificação obrigatória de isolamento** porque o `agy`
escreveu fora do `--add-dir` pedido, sem aviso (README #38). Três exceções bespoke permanecem
nomeadas mesmo depois que o ACP entrar: (1) saída estruturada do Intent Compiler e do Checker;
(2) cunhagem de `sessionId` antes do spawn; (3) modo de escape PTY quando o operador quer a TUI
nativa — o processo ACP não tem UI própria.

**"Assumir o terminal"** na v1 é o Caminho B da pesquisa sem ACP: checkpoint da árvore → espera o
turno fechar ou cancela → o operador escreve, e o engine relança a mesma CLI interativa no mesmo
worktree com `--resume <id>` (fidelidade verificada só para `claude`; `"unverified"` gravado no
journal para os outros). Steering (Caminho A, sem matar processo) chega com o ACP em v0.x. Digitação
do operador nunca é interpretada: o que conta é a árvore, e ela volta para `contain → gates →
review`.

**Dono de worktree e processo é sempre o engine.** `claude --worktree`/`--tmux`/`--bg` são REJECT
como mecanismo: só uma família os tem, e a assimetria mataria o adapter único
(`landscape-harnesses.md` §5.2). No Windows, encerramento é `taskkill /T /F /PID` — nunca
`pty.kill()` (bug #967: pode matar processo não relacionado até 5 s depois); a contenção de árvore
vem do Job Object que a libuv já cria para filhos não-detached; `spawn` de qualquer `.cmd`/`npx`
exige `shell:true` ou resolução do `.exe` real (README #29, #30, #62).

---

## 6. Durabilidade

Os 66 invariantes são portados, não reinventados. **Journal JSONL** com cadeia de hash, escritor
único, `fsync` por linha, canonicalização JCS via `canonicalize` (Apache-2.0, 0 deps).
**Write-ahead**: `step_intent` com `session_id` pré-cunhado antes de qualquer efeito, `step_result`
depois — é por isso que a cunhagem de id é exceção bespoke inegociável. **Reconciliação** na
retomada por classe de efeito, com `tree_before`/`tree_after`; crash não redespacha efeito já feito.
**Checkpoint** em refs, com `restore` para rework limpo. **Lease** por lote (~60 linhas próprias;
`proper-lockfile` está abandonado). **Contain** como fronteira inviolável de escrita, acima de
qualquer instrução de skill. **Orçamento** por story e por lote, com `check_budget` contando
intenções abertas, mais `--max-budget-usd` como teto a priori onde a CLI oferece. **Detector de
loop** por assinatura normalizada (`tl_ci_slice.normalize/signature` porta 1:1, mesmo com CI
desligada). Não cortar, apesar da tentação: `gates.canonical` no CLOSE, `--accept-stale-version`,
`continue_independent_after_block`.

Dois acréscimos desta proposta: `eval_run{phase}` como classe de efeito de primeira classe — a prova
vermelha é evidência durável, não log —, e `contain` verificado **por família** depois de cada
chamada, porque uma CLI pode reportar sucesso após ferramenta bloqueada (README #37) e outra pode
escrever fora do diretório declarado (#38). Prova por eval, nunca por relato.

**Concorrência 1 na v1**, e por evidência, não por preguiça: o modo de falha nomeado por Cognition é
escritor paralelo sem contexto compartilhado, e a própria Anthropic registra que tarefas de código
têm pouco paralelismo real e que agentes ainda coordenam mal em tempo real
(`landscape-harnesses.md` §2.1). Paralelismo na v1 existe só onde a evidência o sustenta: **pesquisa**
(somente-leitura, independente, comprimível em sumário; +90 % de qualidade por ~15× tokens). N>1
entra em pós-v1 com precondição dura verificada pelo engine — interseção vazia de `scope_paths` — e
fila de integração serializada; o desenho já existe em `tl_supervisor.py`, que está pronto, testado e
nunca foi chamado pelo runtime.

---

## 7. Sete subsistemas, um parágrafo cada

**Skill Fabric.** O gargalo não é o corpo (~6–7k tokens para três), é o índice: ~60k tokens/turno
para 1.188 descrições. A v1 recusa a escala — ingere ~60–80 skills relevantes para a stack (README
#13). Pipeline: filtro duro por domínio/origem → BM25 local (~80 linhas, ~5 ms, US$ 0) top-8 →
seletor barato devolve ≤3 com motivo → fecho com precedência (repo > catálogo) e dedup por
`(name, content_hash)`. Skills entram como **bloco fixo do pack ordenado por id estável**, nunca
como leitura nem por relevância: ordenar por score muda o prefixo e mata o cache. Alvos em fixtures:
`recall@8 ≥ 0,85`, `precision@3 ≥ 0,75`, `hard_miss = 0`, `contamination = 0`. Segurança C1–C9 é v1
inteira, com peso em C3 (sanitização estática no sync: ASR 36,0 % → 7,2 %, melhor que interceptação
em runtime a 12,9 %) e C4 (skill de catálogo nunca executa). Embeddings e dynamic guardian ficam
como upgrade path anotado.

**Frontend Quality Engine.** UI detectada liga o brief em 4 camadas (`PRODUCT` durável, `DESIGN`
tokens, **modo** da superfície, plano de direção com `signature` e auto-crítica contra o default) —
a única alavanca visual com medição causal publicada: 57 % menos falhas com `design.md`, >200 runs,
rubrica cega. Loop: `build verde → serve → a11y + console + network → D1–D7 → screenshot só se
passarem → juiz multimodal de outra família`. D5 é `impeccable detect --json` **contra a URL
renderizada** (medido: o modo estático pegou 2 de 6 anti-patterns), pinado por `ENGINE_VERSION`
porque `npx impeccable@4.3.1` não existe no npm público. Corte: final ≥ 7,5, especificidade ≥ 7,
nenhum < 6, zero `critical` — não 8/10, que põe a barra acima do que interface humana de produção
atinge. Teto **2 rodadas**. O juiz é o **melhor** multimodal de outra família, não o mais barato:
US$ 0,04–0,18/rodada contra 30–150k tokens de rework. Fonte genérica é default penalizado com eixo
livre, não banimento — o brief vence; sobrevive um banimento absoluto: kicker acima de heading.

**Tool Output Firewall.** Mora no executor da ADE: é onde está o volume e a única camada que cobre
as três famílias. `PreToolUse.updatedInput`/`PostToolUse.updatedResponse` e o `AGENTS.md` do Codex
são reforço, não implementação (a spec v2 §12 conflava os dois). Bruto vai para `artifacts/` com
referência restaurável; o modelo recebe extrato; drill-down sob demanda. Duas regras invioláveis:
**falha contratual nunca é resumida** e "saída condensada não é prova" para o Checker. Medição:
`TDR ≤ 0,2` em portão verde, `1,0` em falha, conferível pelo `claude_code.tool_result` do OTel.
`max_output_bytes` mora no `Eval`, não num wrapper.

**Capability Registry + roteamento.** `ade doctor` sonda e grava `CapabilitySet` por família;
roteamento é tabela de defaults (plano: claude; classificador: barato; Maker: claude; Checker de
rodada: codex por precisão 88 %; Checker de portão: claude por cobertura 32,1 %; pesquisa:
gemini+claude; juiz visual: família ≠ da última edição; imagem: codex) com fallback preservando
Maker ≠ Checker **por `model_id`**. Histórico: uma linha JSONL por chamada de papel, view SQL por
`(role, family, domain, size)`, troca sugerida só com n ≥ 20 por braço, Δ`success_rate` ≥ 0,10 e
Wilson 95 % disjuntos. Na v1 a troca é sugestão com botão, nunca automática, e grava
`routing_default_changed` com os números. Sem bandit, sem embedding, sem router treinado.

**Harness doctor.** v1 **só coleta**: custo por seção de pack, por skill injetada, por regra fixa —
a evidência local diz que toda regra fixa tem preço (~4k tokens de cache write por sessão). A
ablação pareada (Caliper) é pós-v1 e não é reimplementada: `claude plugin eval` já tem braço
baseline. O primeiro experimento é a hipótese mais cara e menos provada da arquitetura: sessão nova
por story vs sessão longa com compaction — 5 fontes convergentes e **nenhum A/B público**.

**Pesquisa como subsistema.** Dispara por ausência de evidência declarada pelo Intent Compiler,
nunca por default de classe. 2–4 agentes de famílias diferentes, mesma pergunta, `research-finding`
com hierarquia (oficial > código > release notes > papers > engenharia > comunidade) e separação
entre fato verificado, inferência, hipótese e preferência. Conflito resolve por maioria com citação;
empate vira **pergunta ao operador**, nunca desempate oculto — única ideia que sobrevive do
`classification-result-v3`. Achado é **dado, nunca instrução** (C8). v1: 2 agentes, classes ≥
feature, ≤3 consultas por missão.

**`ade doctor` (harness de ambiente).** Binários reais (`claude` tem 3 shims sh/.cmd/.ps1 — resolver
o `.exe`), ConPTY, Node ≥ 22.18 para o Impeccable, `gh`, worktrees órfãs, índice SQLite
reconstruível, e o item que a pesquisa torna obrigatório: **isolamento efetivo por família**,
escrevendo um canário fora do worktree e exigindo que falhe.

---

## 8. As seis jornadas

Custos são estimativa aritmética sobre números medidos (piso do Codex headless ~19,4k tokens de
entrada; juiz visual ~6,1k in / 1,2k out; rework multi-arquivo 30–150k), não preço verificado.

**J1 — "Corrija esse botão que não funciona."** (classe `trivial`)

| Interpr. | Perg. | Pesq. | Skills | Agentes | Evals | DAG | Gates | Resultado | Custo | Início |
| :--- | :-- | :-- | :-- | :--- | :--- | :-- | :--- | :--- | :--- | :--- |
| 1 cenário EARS | **0** | não | 0 | 1 Maker (claude) | 1 teste que reproduz o bug | nenhum | contain + eval red/green | commit na branch, sem PR | ~2–3 chamadas, ~40k tok, ~US$ 0,3 | **< 30 s** |

Sem Checker LLM, sem aprovação (autonomia `safe` auto-aprova `trivial`, registrado no journal), sem
plano, sem pack de skills. Esta linha é o teste de falha da arquitetura: se ela crescer, a
arquitetura falhou.

**J2 — "Melhore o design dessa página."** (`bounded`)

| Interpr. | Perg. | Pesq. | Skills | Agentes | Evals | DAG | Gates | Resultado | Custo | Início |
| :--- | :-- | :-- | :-- | :--- | :--- | :-- | :--- | :--- | :--- | :--- |
| modo da superfície; eixo livre ou pinado | 1 (direção, múltipla escolha) | não | 1–2 design | Maker claude + juiz de outra família | D1–D7 + rubrica | 1 story | visual, ≤2 rodadas | página com nota ≥ 7,5 | ~5–8 chamadas, ~120k tok, ~US$ 1,5 | ~2 min |

**J3 — "Refaça todo o frontend para parecer produto profissional."** (`feature`)

| Interpr. | Perg. | Pesq. | Skills | Agentes | Evals | DAG | Gates | Resultado | Custo | Início |
| :--- | :-- | :-- | :-- | :--- | :--- | :-- | :--- | :--- | :--- | :--- |
| inventário de rotas/estados; um brief 4 camadas | 2–3 (direção, escopo, tema escuro) | opcional (stack) | 2–3 | Maker claude/story, juiz rotativo | D1–D7 por rota + build | 4–8 stories | visual + canonical no CLOSE | PR único com evidência por rota | ~40 chamadas, ~1,2M tok, ~US$ 12–20 | ~6 min |

**J4 — "Adicione billing com Stripe."** (`feature`, alto risco)

| Interpr. | Perg. | Pesq. | Skills | Agentes | Evals | DAG | Gates | Resultado | Custo | Início |
| :--- | :-- | :-- | :-- | :--- | :--- | :-- | :--- | :--- | :--- | :--- |
| EARS por fluxo: checkout, webhook, falha, reembolso | 2 (plano/moeda; ambiente de teste) | **sim**, 2 agentes, API atual | 1–2 | Maker claude, Checker codex, pesquisa gemini+claude | contrato de API + **casos negativos** (assinatura inválida → 4xx) | 3–5 stories | contain + evals + review + `restricted` p/ segredos | PR com webhook testado; segredos nunca no worker | ~30 chamadas, ~900k tok, ~US$ 10 | ~8 min |

**J5 — "Crie um SaaS novo a partir dessa ideia."** (`project`)

| Interpr. | Perg. | Pesq. | Skills | Agentes | Evals | DAG | Gates | Resultado | Custo | Início |
| :--- | :-- | :-- | :-- | :--- | :--- | :-- | :--- | :--- | :--- | :--- |
| initializer gera spec viva antes do 1º Maker | **5** (domínio, público, stack, dados, auth) | **sim**, ≤3 consultas | 3/story | todas as famílias; Checker/story + revisão de branch | eval por cenário + e2e + visual | DAG por epic, 15–40 stories | todos, incl. canonical e visual | repo executável com evidência por story | ~200 chamadas, ~6M tok, ~US$ 60–120 | ~15 min |

**J6 — "Continue desenvolvendo sozinho enquanto durmo."** (`subsystem`, desatendido)

| Interpr. | Perg. | Pesq. | Skills | Agentes | Evals | DAG | Gates | Resultado | Custo | Início |
| :--- | :-- | :-- | :-- | :--- | :--- | :-- | :--- | :--- | :--- | :--- |
| lê spec viva + backlog; **uma** story por sessão | 0 (lote aprovado antes) | só se bloquear | ≤3 | flags desatendidas + `--disallowedTools` p/ push/PR/merge | eval/story, prova vermelha obrigatória | DAG do lote, concorrência 1 | contain por família + orçamento + loop + `continue_independent_after_block` | fila de PRs; escalações esperando no painel | orçamento é o teto | imediato |

---

## 9. Cortes YAGNI explícitos

| Corte | Origem | Motivo |
| :--- | :--- | :--- |
| ACP como transporte primário na v1 | `adapters-and-acp.md` | Falta-lhe as 3 coisas de que o contrato depende (schema de saída, id cunhado, teto a priori). Entra em v0.x pelo steering. |
| Catálogo de centenas de skills | spec v2 §9 | O índice custa ~60k tokens/turno; ~60–80 skills cobrem a stack. Escalar é problema de índice, não de valor. |
| Concorrência N>1 | spec v2 backlog | Evidência contra escritores paralelos; o desenho (`tl_supervisor.py`) já existe para quando houver demanda medida. |
| Painel com PTY e "assumir" na v1 | spec v2 §11 | Zero impacto sobre a qualidade do contrato. Chat + missão + log bastam para operar. |
| Rotinas autônomas | PROMPT §13 | Sem telemetria acumulada, uma rotina é um gerador de PRs sem critério. |
| 4º provider (OpenCode) | `adapters-and-acp.md` §4 | Custa o princípio "sem chave de API"; a arquitetura fica aberta, o provider não entra. |
| Graft embutido | spec v2 §12 | ADOPT como dependência opcional com fallback para `rg`; ganho a medir no dogfood, não a assumir. |
| MCP no caminho automático | PROMPT §1 | Playwright MCP / Chrome DevTools MCP trazem 58–70 ferramentas para ganho zero: Playwright como biblioteca dá tudo. |
| `codex review` como Checker | spec v2 §13 | Ignora `--output-schema` em silêncio (medido). |
| Avaliador visual em modelo barato | spec v2 §16 | Economiza centavos num orçamento dominado pelo rework (10–50×) e compra julgamento pior. |
| Banimento de fontes | spec v2 §10.1 | Contradiz as duas fontes primárias de design: o brief vence. Vira default penalizado. |
| 4 rodadas visuais / corte 8/10 | spec v2 §10.5 | Contradiz a fonte normativa; trabalho bom cairia em `awaiting_operator`. |
| `context-ledger`, `classification-result-v3`, `render_report`, `project_batch`, `advisor_policy`, `price_table`, `notify_argv` | runtime | Projeção ou método documental; nenhum é lido pelo runtime ou tem leitor. |
| Ablação automática do harness doctor | PROMPT §1 | v1 coleta; sem amostra, ablação é teatro. |
| `claude ultrareview` no loop | `addendum-checker...` §8 | Cloud, 5–10 min, cota de 3 grátis: incompatível com rework. Portão opcional pré-merge. |

---

## 10. Roadmap em vertical slices

| Fase | Entrega | Critério de saída |
| :--- | :--- | :--- |
| **MVP** | Slice 1 (abaixo): contrato executável ponta a ponta numa story `bounded`, sem painel, sem skills, sem visual. | `ade run "<pedido>"` fecha uma story com prova vermelha no journal. |
| **v0.2** | Engine durável completo (66 invariantes, paridade com a suíte Python) + adapters claude/codex + Checker com schema. | Crash no meio da story retoma sem redespachar efeito. |
| **v0.3** | Classificador de complexidade + DAG + entrevista + aprovação + pesquisa mínima. | J1 sem perguntas e J4 com 2 perguntas, no mesmo binário. |
| **v0.4** | Skill Fabric (BM25 + seletor + C1–C9) + Context Pack com tetos + Tool Output Firewall + telemetria. | `recall@8 ≥ 0,85`, `precision@3 ≥ 0,75`, `TDR ≤ 0,2` em portão verde. |
| **v0.5** | Frontend Quality Engine (brief 4 camadas, D1–D7, juiz, 2 rodadas) + painel mínimo. | Fixture ruim reprova; fixture boa passa em 1 rodada. |
| **v1** | Modo desatendido (J6), autonomia por repositório, `ade doctor` com canário de isolamento, capability registry com histórico. | Lote noturno de 8 stories fecha com ≤1 escalação e zero violação de `contain`. |
| **futuro** | ACP + steering, PTY "assumir", N>1 com fila de merge, spec viva `.ade/spec/`, ablação Caliper, rotinas, Graft. | — |

### Slice 1 detalhado — "Task Contract executável"

- **Objetivo.** Pedido de uma frase → `TaskContract` validado → eval vermelho provado → implementação
  headless → revisão de outra família → tudo no journal. Classe `bounded`, dogfood na própria TL-ADE.
- **Escopo.** `Plan`/`TaskContract`/`Eval` + `ajv`; Intent Compiler (2 chamadas com schema); Eval
  Runner com `tree_before`; `Journal` com cadeia de hash e write-ahead; adapter `claude` + CLI falsa;
  adapter `codex` só para o Checker; `contain` mínimo. **Fora:** painel, skills, visual, DAG,
  pesquisa, worktrees, PR/merge.
- **Aceite.** (1) Contrato sem eval por cenário é recusado com mensagem acionável. (2) Eval que passa
  contra `tree_before` reprova a story e volta ao Intent Compiler, não ao Maker. (3) `kill -9` no
  `implement` e retomada não redespacham o `model_call` já pago. (4) `target_role: "human"` produz
  `awaiting_operator`, não rework. (5) Escrita fora de `scope_paths` é detectada e revertida.
- **Evals do slice.** Vitest com CLI falsa (contador durável, `no_result`, captura de pack e env —
  porte do `fake_harness.py`); paridade I01–I05, I19–I26, I41; um ponta a ponta em repo temporário;
  um caso de eval frouxo que **precisa** reprovar.
- **Dependências.** Node 22, `ajv`, `canonicalize`, `better-sqlite3`, `claude` 2.1.271, `codex`
  0.154.0. Nenhuma rede obrigatória além das CLIs.
- **Risco.** EARS genérico ("THE SYSTEM SHALL work correctly") passa na validação de forma e falha na
  de substância. Mitigação: recusar cenário sem verbo observável e sem eval que o referencie; o
  Checker recebe cenário e eval juntos.
- **Pronto.** Os 5 critérios verdes em Windows e Linux, journal auditável por `ade journal --verify`,
  e a story do próprio slice fechada pela ADE em dogfood.

---

## 11. Três maiores riscos e como reverter

**R1 — O Intent Compiler vira um gargalo de latência e custo antes de qualquer linha de código.**
Duas chamadas de modelo forte com schema, mais classificação, mais discovery, antes do primeiro
Maker; se isso custar minutos em J1, a arquitetura violou o próprio princípio. Sinal de alarme:
tempo até começar > 60 s em `trivial`, ou custo de planejamento > 15 % do custo da missão.
**Reversão:** `trivial` e `bounded` passam a usar caminho curto determinístico — contrato gerado por
template a partir do discovery, com uma única chamada de modelo — e o compilador completo fica para
classes ≥ feature. O ponto de reversão é uma função de despacho, não uma reescrita.

**R2 — A prova vermelha é frágil ou cara nos casos aditivos.** `tree_before` como mutante universal
funciona para bugfix e alteração; em mudança puramente aditiva o eval falha por ausência de arquivo,
o que é um vermelho sem significado. O modo `mutate` (comentar a guarda que a spec nomeia) é caro e
depende do Checker acertar o alvo. **Reversão:** rebaixar `strictness` de bloqueio para **aviso
registrado** nas classes aditivas, mantendo o vermelho obrigatório onde `tree_before` é
discriminativo, e usar a segunda rede já prevista (eval que nunca falhou em rework algum é
sinalizado). O campo `strictness.mode` já existe no schema: a reversão é mudar o default por classe,
sem tocar no engine.

**R3 — Bespoke-first envelhece mal e o steering vira requisito antes do previsto.** As flags de CLI
mudam sem aviso entre releases, e três vocabulários de permissão divergentes é exatamente o custo que
o ACP existe para eliminar; se o operador passar a exigir intervenção em turno vivo, o Caminho B
(esperar o turno fechar) vai parecer primitivo. **Reversão:** o `AgentAdapter` é desenhado com
`CapabilitySet` explícito e transporte como detalhe interno; trocar para ACP é implementar
`AcpTransport` atrás da mesma interface, mantendo as 3 exceções bespoke (schema, id cunhado, PTY)
como caminho paralelo — que é exatamente o híbrido que a pesquisa recomenda. O sinal de gatilho é
concreto: `codex-acp` passar a emitir `usage_update.cost`, ou a RFD `session/inject` estabilizar.

Riscos menores, já mitigados no desenho e registrados para não sumirem: custo real do classificador
"barato" (medir por chamada, cair para regra determinística se não bater); pin do Impeccable por
`ENGINE_VERSION` e não por versão npm; verificação de isolamento por família a cada chamada.
