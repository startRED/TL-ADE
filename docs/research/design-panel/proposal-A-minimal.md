# Proposta A — "Menos código, mais alavanca": a ADE mínima que cumpre o north star

Data: 2026-09-16. Ângulo: cortar tudo que uma capacidade nativa já resolve; manter intacta a
durabilidade do journal e o eval como prova. Fontes: `docs/research/*` (citadas por arquivo em cada
afirmação factual). Nada aqui afirma capacidade de CLI que não esteja verificada na pesquisa.

---

## 1. Tese

A ADE mínima é **um scheduler durável mais um compilador de contexto** — o resto é consumo de
capacidade nativa. O journal com write-ahead, reconciliação e `contain` é a única coisa que ninguém
mais faz por nós (`runtime-port-map.md` I01–I66); saída por schema, orçamento por chamada, id de
sessão pré-cunhado, detector estético determinístico e A/B de skill já existem nos binários
instalados (`capabilities-claude-code.md` §0, §11; `addendum-frontend-engine-anchor.md` §1).
Otimizamos **tempo até a primeira story real rodar sozinha** e **superfície de manutenção**.
Sacrificamos, na v1: painel web com PTY, ACP, concorrência N>1, índice SQLite, catálogo de centenas
de skills, times de pesquisa paralelos e rotinas autônomas. A aposta é que o DAG, o painel e o ACP
são *otimizações de um sistema que ainda não existe*.

---

## 2. Mapa de componentes

**P** = código próprio · **N** = capacidade nativa consumida. Referências `I##` são invariantes de
`runtime-port-map.md` §1.1.

| # | Componente | Responsabilidade | Entrada → Saída | P/N | Status |
| :-- | :--- | :--- | :--- | :-- | :--- |
| C1 | **Journal** | Registro append-only com cadeia de hash JCS, `fsync` por linha, lease exclusivo. | Step → `journal.jsonl` | P (JCS via `canonicalize`, §1.2) | **v1** |
| C2 | **Step + reconcile** | Write-ahead e tabela de reconciliação por `effect_class` na retomada. | journal + árvore/remoto → `ok\|released\|ambiguous` | P (I01–I17) | **v1** |
| C3 | **Git layer** | Uma instância por worktree: `worktree_tree` racy, `dirty_paths -z`, checkpoint/restore em refs. | cwd → tree hash, paths sujos | P (I19–I22, I60) | **v1** |
| C4 | **Contain** | Verificação pós-fato: segredo > escopo, restaura e estaciona. | diff + bytes → `ok\|restore\|stop` | P (I23–I26) | **v1** |
| C5 | **Runner** | Spawn com recibo durável, env filtrado, contenção de processo, *tool output firewall*. | argv → `{state, rawPath, extract}` | P; Job Object de graça do libuv (digest #30); kill por `taskkill /T /F /PID`, nunca `pty.kill()` (`landscape-routing...` §4.2) | **v1** |
| C6 | **Pack compiler** | Um prompt por chamada: ordem por volatilidade, teto por seção com ponteiro, redação. | story + skills → `pack.md` + manifesto | P (`runtime-port-map.md` §6; cache em `landscape-context...` §1.3) | **v1** |
| C7 | **Adapter bespoke** | Papel → argv; parse do JSON. Só `claude` e `codex`. | `RoleCall` → `CallResult` | P fino sobre N: `--json-schema`/`--output-schema`, `--session-id`, `--max-budget-usd`, `--permission-prompts none`, `--ignore-user-config` | **v1** |
| C8 | **Scheduler plano** | Próxima story pronta, `depends_on` opcional, concorrência 1. | plano → story id | P (~80 linhas); baseline Anthropic é lista plana com `passes` (`landscape-harnesses.md` §7) | **v1** |
| C9 | **Intent compiler** | Uma chamada com schema devolve o Task Contract inteiro. | pedido + mapa do repo → `plan.json` | P = prompt + schema; N = `--json-schema` coage (`addendum-checker` §3) | **v1** |
| C10 | **Eval runner + estritez** | Executa o eval e prova que ele falha contra `tree_before`. | `Eval[]` + 2 árvores → `eval_run{red,green}` | P (`landscape-evals-visual.md` §2.3) | **v1** |
| C11 | **Skill index** | BM25 sobre índice curado + seletor LLM barato sobre top-8. | story → ≤3 skills | P (~150 linhas); reranker é contraindicado (ToolRet 33,8→28,9) | **v1**, catálogo de 40–80 |
| C12 | **Capability registry** | JSON por família + `ade doctor` que prova cada flag com chamada real. | binários → `CapabilitySet` | P; N = `system/init.capabilities` (`capabilities-claude-code.md` §10) | **v1** |
| C13 | **Frontend Quality Engine** | Portões determinísticos; juiz multimodal só quando eles passam. | rota + viewport → `visual-eval` | N = Playwright (lib) + `impeccable detect --json` contra a **URL servida** (`addendum-frontend...` §1.2, §4) | **v1** (D1–D5 + juiz); D6/D7 pós-v1 |
| C14 | **Pesquisa** | Uma chamada com schema quando o plano declara incógnita. | pergunta → `research-finding` | P fino sobre `--json-schema` | **v1** (1 agente); time **pós-v1** |
| C15 | **Harness doctor** | Coleta injeção/citação/custo por skill e regra. | journal → relatório | P (coleta); N = `claude plugin eval` tem braço baseline | **v1 = só coleta** |
| C16 | **`ade takeover`** | Imprime o comando de retomada e grava `human_takeover`. | story → linha de comando | P (~20 linhas); N = `claude --resume <uuid>` abre sessão `-p` em interativo | **v1** |
| C17–C23 | Painel + PTY + WebSocket; índice SQLite; ACP; adapter `gemini`/`agy`; concorrência N>1; rotinas agendadas; memória/Graft/CI | — | — | — | **pós-v1 ou cortado** (§9) |

Contagem: **16 componentes na v1**, dos quais 6 são portes literais de invariante já testado e 4 são
casca fina sobre flag nativa.

---

## 3. Contratos

Contra os 7 schemas mínimos do `runtime-port-map.md` §3.2: **5 publicados e validados com `ajv`**
(journal-event, ade-config, plan, unit-result, review-result). `visual-eval` e `research-finding`
viram **JSON Schema inline** em `--json-schema`/`--output-schema` até a v0.3 — a coação é do CLI, o
consumidor é um só, e schema publicado sem segundo consumidor é cerimônia.

```ts
// plan.json — Task Contract (substitui batch.schema.json; EARS de Kiro, cenário de OpenSpec)
type Plan = {
  schema_version: 1; mission_id: string;
  complexity: "trivial" | "bounded" | "feature" | "subsystem" | "project";
  approval: { digest: string; approved_at: string; permitted_effects: Effects };
  budget: { max_model_calls: number; max_usd?: number; max_rework_per_story: number };
  stories: Story[];                       // lista PLANA; o DAG é o campo depends_on, opcional
};
type Story = {
  id: string; title: string; intent: string;
  requirements: string[];                 // "WHEN <cond> THE SYSTEM SHALL <comportamento>"
  scenarios: { id: string; when: string; then: string }[];
  evals: Eval[];                          // >=1; cada eval aponta um scenario_id
  scope_paths: string[]; do_not_touch: string[]; depends_on: string[];
  gates: ("visual" | "migration")[]; skills: SkillRef[];   // skills vêm do prepare
  maker: RoleBinding; checker: RoleBinding;
  autonomy: "safe" | "controlled" | "restricted";
  passes: boolean;                        // ÚNICO campo gravável pelo agente
  spec_revision: string;                  // sha256 do objeto serializado (substitui I54)
};
type Eval = {
  id: string; scenario_id: string; kind: "command" | "http" | "visual";
  cmd: string[]; cwd: string; expect_exit: number; evidence: string[];
  timeout_s: number; max_output_bytes: number;
  strictness: { mode: "tree_before" | "mutate"; must_fail: true };
};

// journal-event — porte literal de step-journal.schema.json + 4 classes de efeito novas
type JournalEvent = {
  format_version: 1; seq: number; at: string; prev: string;  // 16 hex do sha256 da linha anterior
  kind: "step_intent" | "step_result" | "unit_state" | "batch_state" | "note";
  effect_class?: EffectClass;             // + eval_run | visual_eval | research | human_takeover
  status?: "ok" | "failed" | "released" | "ambiguous";
  input_digest?: string; intent_context?: unknown;           // context fica fora do digest (I17)
  worktree?: string;                      // aditivo: habilita N>1 sem mudar o formato
  session_id?: string;                    // pré-cunhado antes do spawn (--session-id)
  stamp: string;                          // ade:config:model:skills:prompt — princípio 14 em 1 campo
  tree_before?: string; tree_after?: string; evidence?: Ref[];
  usage?: { in: number; out: number; cache_read: number; cache_write: number;
            usd: number | "unknown"; cost_source: "reported" | "estimated" | "unknown" };
};

// review-result — forma RICA, medida (addendum-checker §4.2)
type ReviewResult = {
  schema_version: 1; verdict: "approved" | "changes_requested";
  action_items: { id: string; severity: "critical"|"high"|"medium"|"low";
                  category: "patch"|"bad_spec"|"intent_gap";
                  target_role: "maker"|"planner"|"human";
                  location: string; problem: string; evidence: string; required_action: string }[];
  deferred: Finding[]; rejected: Finding[];
};
// summary NUNCA é campo de entrada: summaryOf(i) = i.problem; digest = sha256(sorted(problem))

// CapabilitySet — só o que muda decisão; lido pelo doctor, nunca hardcodado
type CapabilitySet = {
  family: "claude" | "codex"; bin: string;          // caminho absoluto resolvido (I66)
  structured_output: "json-schema" | "output-schema" | "prompt-only";
  session_id_preminted: boolean; budget_usd_flag: boolean;
  effort_values: string[]; models: string[];
  cost_reporting: "usd" | "tokens" | "unknown";
  unattended_flags: string[]; image_gen: boolean; probe_ok: boolean; probed_at: string;
};

// skill index entry — dedup por (source, path, name), pin por hash
type SkillEntry = { name: string; source: string; path: string; description: string;
                    tags: string[]; domains: string[]; content_hash: string;
                    trust: "local" | "allowlisted" | "quarantined"; shadowed_by?: string };

// telemetria NÃO é schema próprio: é `usage` acima + 4 campos no step_result
type CallTelemetry = { pack_bytes: number; pack_sections: {name:string;bytes:number}[];
                       skills_injected: string[]; tool_bytes_raw: number; tool_bytes_delivered: number };
```

**Deltas contra os 7 schemas mínimos:** `unit-result` fica, com os 6 campos fechados de
`tl_job.RESULT_FIELDS`; `visual-eval` e `research-finding` saem dos publicados; `journal-event` ganha
`stamp`, `session_id` e `worktree` (aditivos); `ade-config` perde `panel` e ganha `autonomy`
(`addendum-autonomia-...` §5); `review-result` adota a forma rica com `ajv` na ingestão — sem isso o
`intent_gap` humano nunca escala e `stagnation` dispara falso (`addendum-checker-...` §1, §5).

---

## 4. Fluxo de uma missão ponta a ponta

| Etapa | Quem executa |
| :--- | :--- |
| **intenção** | humano, uma frase |
| **classe + domínios** | 1 chamada barata com schema sobre pedido + `git ls-files` truncado (~2k in) |
| **context discovery** | **código**: `git ls-files`, `package.json`, rotas de `.ade/config.json`. Sem Graft na v1 |
| **pesquisa** | condicional: 1 chamada com schema, só se classe ≥ `feature` **e** houver incógnita declarada |
| **objetivos/restrições/Task Contract** | 1 chamada do modelo forte com `--json-schema` do `Plan` (~8–20k in) |
| **perguntas** | humano, **≤5**, só o que o repositório não responde; múltipla escolha com recomendação primeiro |
| **aprovação** | humano, **1 ponto**: escopo, custo, skills novas, efeitos externos, nível de autonomia |
| **plano** | **código**: `ajv`; story sem eval, ou cenário sem eval, é recusada |
| **skills** | no `prepare`: BM25 top-8 + seletor barato → ≤3, hash pinado (~1,5k in) |
| **agentes/modelos** | **código**: tabela + fallback; Maker ≠ Checker por **`model_id`**, não por família |
| **eval vermelho** | **código**: eval contra `tree_before`; verde-de-nascença devolve a story ao compilador |
| **implementação** | 1 chamada Maker com o pack, `--max-budget-usd` como teto duro — a maior fatia do custo |
| **contain + gates + eval verde** | **código**: segredo/escopo/"não mudou nada"; build-lint-test com cache por árvore, saída filtrada na origem |
| **loop visual** (`gates:visual`) | **código** D1–D5 → só se passar, 1 chamada de juiz de outra família (US$ 0,04–0,18/rodada) |
| **revisão independente** | 1 chamada Checker de rodada (`codex`, precisão) com `--output-schema` (~20k in) |
| **refinamento** | rework a partir do **checkpoint**, nunca por cima; teto por story; detector de loop |
| **evidência + entrega** | **código**: manifesto do pack, exit codes, artefatos; commit fixado à árvore revisada, push por refspec, PR — nunca pelo worker |
| **portão do lote** | 1 chamada Checker de portão (`claude`, cobertura) no CLOSE + gates canônicos |

Modelo entra em **7 pontos**; tudo o mais é determinístico. Humano entra em **2**.

---

## 5. Adapters e transporte

**Veredito: bespoke em 100% da v1; ACP fica fora.** O `addendum-adapter-transport-acp-vs-cli.md` §0
recomenda ACP primário com 3 exceções — esta proposta inverte, porque as 3 exceções são exatamente
as capacidades que sustentam a arquitetura: (1) *structured output* é ausência do protocolo v1, não
do adapter (§3.1); (2) `session/new` **não aceita id do cliente**, o que quebra o write-ahead puro
(§3.5); (3) não há equivalente a `--max-budget-usd` — em ACP o orçamento é reativo, com janela de
estouro (§6). Some-se que `usage_update.cost` em USD foi medido ausente no `codex-acp` (§4). Trocar
três garantias duras por *steering* em turno vivo — cuja RFD (`session/inject`, PR #1261) está
aberta no bucket v2 — é pagar adiantado por UX de um painel que a v1 não tem.

**Por família (v1):** `claude` = `-p --output-format json --json-schema <inline> --session-id <uuid>
--max-budget-usd --permission-mode bypassPermissions --permission-prompts none --disallowedTools
"Bash(git push*),Bash(gh pr*)" --safe-mode` (nunca `--bare`, que força `ANTHROPIC_API_KEY` e quebra
a assinatura — `capabilities-claude-code.md` §0) mais `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
`codex` = `exec --json --output-schema <arquivo> --sandbox workspace-write --approve-for-me
--ignore-user-config --skip-git-repo-check -C <worktree>`, com `stdin: 'ignore'` obrigatório
(`addendum-frontend-engine-anchor.md` §5). **Nunca** `codex review`/`codex exec review`:
`--output-schema` é silenciosamente ignorado ali, a saída é prosa `[P1]` (`addendum-checker-...`
§2.2). Resolver o executável por caminho absoluto e invocar `.cmd` via `cmd.exe /c` (I66).

**"Assumir o terminal" na v1 é uma linha de comando, não um PTY.** `ade takeover <story>` pausa no
checkpoint, grava `human_takeover` e imprime `claude --resume <uuid>` (mais `--add-dir`/`--settings`
originais, que o resume **não** restaura). O operador cola no próprio terminal. Isso elimina
`node-pty` (11 bugs abertos de ConPTY em 2026, incluindo `kill()` que mata PID alheio —
`landscape-routing-skills-terminal.md` §4.1), xterm, WebSocket e servidor Fastify da v1. `ade
release` relê a árvore; a digitação do operador nunca é interpretada — é a única invariante que
sobrevive ao takeover (`addendum-autonomia-...` §6.5).

**Dono do worktree e do processo: a ADE, sempre.** Não usar `claude --worktree`/`--tmux`/`--bg`
(assimetria entre famílias, `-p` não limpa, dois donos de ciclo de vida —
`capabilities-claude-code.md` §8). Worktrees em `<repo>/.ade/wt/`; processo com recibo em disco
antes do spawn, Job Object herdado do libuv e `taskkill /T /F /PID` no timeout. **Gatilho para
reabrir ACP:** um 4º provider, ou `session/inject` estável em v1 do protocolo.

---

## 6. Durabilidade

Não negociável, portado literalmente: **I01–I66**. Os pontos onde o porte TS pode falhar em silêncio,
e que por isso viram teste antes de código: canonicalização **RFC 8785** via `canonicalize`
(`JSON.stringify` não ordena chaves e quebraria a cadeia sem erro — I02); `fsync` por linha com fd
aberto, porque `appendFileSync` não garante flush (I03); lease próprio de ~60 linhas
(`proper-lockfile` está abandonado — digest #30); varredura de segredo no diff integral **sem** o
`maxBuffer` default de 1 MiB, que truncaria a varredura calado (I24, §1.2); as 5 regex de
normalização do detector de loop, literais (I41). Mantidos contra a tentação de cortar:
`gates.canonical` no CLOSE, `--accept-stale-version`, `continue_independent_after_block`, e o
conceito de recibo durável de chamada — sem ele `model_call` não é reconciliável e um timeout deixa
o agente escrevendo na árvore (I64–I65).

**Ganho líquido sobre o runtime Python:** o `session_id` é pré-cunhado com `--session-id <uuid>`,
então o `step_intent` grava a identidade da chamada **antes** do spawn — write-ahead de verdade, sem
parsing de saída; e `--max-budget-usd` transforma o teto por chamada de contabilidade *a posteriori*
em limite duro *a priori* (`landscape-harnesses.md` §5.2).

**Concorrência 1 na v1**, não por simplicidade: escritores paralelos na mesma árvore são o modo de
falha nomeado por Cognition, e o critério é "paralelize só trabalho somente-leitura, independente e
comprimível" (`landscape-harnesses.md` §2.2). Os campos que habilitam N>1 (`worktree` no evento,
`Git` não-singleton) entram na v1 **como campos**, custo zero; o scheduler e a fila de integração
ficam para depois. Git por worktree desde o dia 1 é barato; retrofitar é caro (digest #33).

---

## 7. Os seis subsistemas, em versão de 10%

**Skill Fabric.** O gargalo é o índice, não o corpo: 1.188 descrições custam ~60k tokens por turno,
3 corpos custam ~6–7k (digest #13). A v1 sincroniza um **catálogo curado de 40–80** das fontes ADOPT
(`ref-skill-sources.md` §2): filtro duro por domínio, BM25 sobre nome+descrição+tags (~80 linhas,
5 ms, US$ 0) e seletor LLM barato sobre o top-8 — reranker cross-encoder **piora** o retrieval
(ToolRet 33,83→28,92) enquanto lista curta + LLM melhora (87,1%→93,1%). Segurança: allowlist de
fontes, pin por `sha256` com reaprovação na mudança, sanitização estática NFKC/base64/`curl|bash` no
sync (ASR 36,0%→7,2%, a defesa mais eficaz e mais barata), skill é **leitura, nunca execução**, teto
de 3 por story. Skill entra como **bloco fixo do pack ordenado por id**, não como `tool_result`:
ordenar por relevância mata o cache. Fixtures `must/should/must_not` medem `recall@8 ≥ 0,85` e
`precision@3 ≥ 0,75`.

**Frontend Quality Engine.** Build verde → serve → a11y snapshot (200–400 tokens vs milhares de uma
screenshot) → **D1–D5 determinísticos** (console limpo, zero 4xx/5xx, contraste AA, sem scroll
horizontal em 390px, `impeccable detect --json` contra a **URL servida** — no modo estático o
detector pegou 2 de 6 anti-patterns numa fixture) → só então screenshot em 1280/390 e **um** juiz de
família diferente. Teto **2 rodadas**, não 4, por citação primária ("Verify in bounded passes, not a
loop"); corte 7,5 com critério 1 ≥ 7 e nenhum < 6, calibrado contra a banda 20–32/40 do Impeccable.
Regra obrigatória que a spec v2 não tem: **o juiz não vê o diff nem os achados do detector antes de
fechar o julgamento estético** (anti-anchoring). Impeccable pinado por `ENGINE_VERSION` (`0.1.5`),
não por versão npm — `impeccable@4.3.1` não existe no registro público. Guardrail estético é
**default penalizado**, não veto ("o brief vence"); sobrevive um banimento absoluto: kicker/eyebrow.

**Tool Output Firewall.** Não é subsistema: é a assinatura do C5. Todo comando passa por
`run(argv) → {rawPath, extract}`; o bruto vai para `artifacts/`, o modelo recebe o extrato com
ponteiro de drill-down. *Losslessness*: **sucesso é resumível, falha vai inteira** — manter o erro
no contexto é o que deixa o modelo adaptar. Hooks `PreToolUse`/`PostToolUse` são reforço exclusivo
do Claude Code, nunca a implementação. Medida: TDR ≤ 0,2 em portão verde, 1,0 em falha.

**Capability Registry + roteamento.** Um JSON por família e um `ade doctor` que **prova cada flag com
chamada real** — presença de binário não basta (`gemini 0.59.0` funciona apesar da migração de
2026-06-18). Roteamento é tabela com fallback, não ML: router aprendido resolve o problema errado
(dezenas de modelos por token de API) e o RouteLLM está abandonado. Defaults: Maker `claude`
(SWE-bench empatado no topo → decide o ferramental), **Checker de rodada `codex`** (88% de utilidade;
falso positivo custa uma rodada inteira de Maker), **Checker de portão `claude`** (32,1% de pass
rate, cobertura), juiz visual de família ≠ da que editou. Maker ≠ Checker é verificado por
**`model_id`**, não por família — `agy` serve modelos Claude e GPT (#3). A v1 **coleta**
`routing.jsonl` e não troca nada sozinha; a regra (n ≥ 20, Δ ≥ 0,10, Wilson 95%) vira sugestão.

**Harness doctor.** v1 = **só coleta**: injeção, citação (o digest da seção aparece em `sources` do
resultado), custo por skill/regra separando cache write de read, e três candidatos de poda que não
exigem A/B (skill injetada com citação zero em ≥N stories; prompt citando flag inexistente;
instrução duplicada). A ablação pareada roda em **`claude plugin eval`**, que já tem braço de
baseline — não reimplementar Caliper. Coleta sem execução é barata; execução sem coleta é impossível.

**Pesquisa.** v1 = **uma** chamada com schema, só com incógnita declarada e classe ≥ `feature`. Time
de 2–4 agentes custa ~15× tokens e só se paga em recall. Achado é **dado, nunca instrução**: URL ou
ação sugerida por terceiro não vira efeito sem portão. Hierarquia de fontes e separação
fato/inferência/hipótese vivem no **prompt do papel**, não em código.

---

## 8. As 6 jornadas

Colunas: interpretação | perguntas | pesquisa | skills | agentes/modelos | evals | DAG (stories) |
gates | resultado | custo | tempo até começar.

**J1 — "Corrija esse botão que não funciona"**

| Interpretação | Perguntas | Pesquisa | Skills | Agentes/modelos | Evals |
| :--- | :--- | :--- | :--- | :--- | :--- |
| classe **trivial**, `frontend`; sem plano, sem epic | **0** | não | **0** (filtro duro não acha domínio) | 1 Maker `claude`; **sem Checker LLM** | 1: teste que reproduz o clique; vermelho contra `tree_before` |

| DAG | Gates | Resultado | Custo | Tempo até começar |
| :--- | :--- | :--- | :--- | :--- |
| **1 story** | eval + contain + lint incremental | commit local; PR só em `controlled` | ~2 chamadas, 35–60k in | **< 30 s** |

**J2 — "Melhore o design dessa página"**

| Interpretação | Perguntas | Pesquisa | Skills | Agentes/modelos | Evals |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **bounded**, `ui`; brief estético antes do código | **1–2** (direção; rotas/estados) | não | 2: `frontend-design` **ou** Impeccable `shape` (nunca os dois) + `improve-ui` | Maker `claude`; juiz `codex`; Checker `codex` com `model_id` ≠ juiz | D1–D5 + rubrica ≥ 7,5; build verde |

| DAG | Gates | Resultado | Custo | Tempo até começar |
| :--- | :--- | :--- | :--- | :--- |
| **1 story** | `visual` (≤2 rodadas) + contain | token system coeso; `DESIGN.md` | ~5–7 chamadas; juiz US$ 0,04–0,18/rodada | ~2 min |

**J3 — "Refaça todo o frontend para parecer produto profissional"**

| Interpretação | Perguntas | Pesquisa | Skills | Agentes/modelos | Evals |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **subsystem**; uma direção, N páginas | **3–4** (direção; páginas; rotas/API preservadas?; dark mode?) | 1 chamada (stack de UI) | 3/story; direção declarada 1× e reinjetada como invariante | Maker `claude` por página; juiz alternando família; Checker rodada `codex`, portão `claude` | por página D1–D5 + rubrica; global build + smoke e2e |

| DAG | Gates | Resultado | Custo | Tempo até começar |
| :--- | :--- | :--- | :--- | :--- |
| **6–15 stories**; `depends_on` só design system → páginas | `visual` por story + canônicos no CLOSE | PR por página; `visual_score` mediano | ~60–150 chamadas, dominado por rework | ~5 min |

**J4 — "Adicione billing com Stripe"**

| Interpretação | Perguntas | Pesquisa | Skills | Agentes/modelos | Evals |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **feature**; `api`+`dados`+`frontend` | **3–5** (preço; assinatura vs avulso; webhook; ambiente de teste) | **sim**, 1 chamada — caso canônico de incógnita | 1–2 (`backend-patterns`, `database-migrations`) | Maker `claude`; Checker rodada `codex`, portão `claude` | contrato 200+schema; **negativos**: webhook mal assinado → 400; cartão recusado → estado consistente; migration idempotente |

| DAG | Gates | Resultado | Custo | Tempo até começar |
| :--- | :--- | :--- | :--- | :--- |
| **4–8 stories** com dependência real (modelo→endpoint→webhook→UI) | eval + contain + `migration` + portão do lote | PR encadeado; segredo nunca no diff | ~25–50 chamadas | ~6 min |

**J5 — "Crie um SaaS novo a partir dessa ideia"**

| Interpretação | Perguntas | Pesquisa | Skills | Agentes/modelos | Evals |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **project**; sessão initializer antes do 1º Maker | **5** (produto; stack; auth; persistência; direção visual) | **sim**, até 3 chamadas | catálogo inteiro disponível, ≤3/story | Maker `claude`; Checker rodada `codex`, portão `claude`; juiz alternado; `$imagegen` para assets | taxonomia por classe; e2e cresce por epic; `strictness` em todas |

| DAG | Gates | Resultado | Custo | Tempo até começar |
| :--- | :--- | :--- | :--- | :--- |
| **20–60 stories** em 3–6 epics; dependência entre epics, plana dentro | eval + contain + `visual` nas de UI + canônicos por epic | repo novo, CI verde, PR por story, `DESIGN.md` | centenas de chamadas; teto em `--max-budget-usd` + `max_model_calls` | ~10–15 min |

**J6 — "Continue desenvolvendo sozinho enquanto durmo"**

| Interpretação | Perguntas | Pesquisa | Skills | Agentes/modelos | Evals |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **não é classe nova**: lote com `autonomy` fixo + orçamento de parede | **1** (teto de custo/horas), ou 0 se já no config | herda a do plano aprovado | as pinadas no plano; skill nova de madrugada → `awaiting_operator` | idem, em modo desatendido (`--permission-prompts none` / `--approve-for-me`) | idem **+** estritez obrigatória em toda story (nada passa por relato) |

| DAG | Gates | Resultado | Custo | Tempo até começar |
| :--- | :--- | :--- | :--- | :--- |
| backlog inteiro; `continue_independent_after_block: true` | idem + `max_parked_units`, `max_wall_clock_seconds`, detector de loop | fila de PRs; `ade report` de manhã com o motivo de cada parada | limitado por orçamento, não por plano | **imediato** |

J1 gasta 2 chamadas e nenhum artefato de processo; J6 roda horas sem humano. Se J1 exigisse epic, a
arquitetura teria falhado.

---

## 9. Cortes YAGNI explícitos

| Cortado da v1 | Pedido por | Motivo |
| :--- | :--- | :--- |
| **Painel web, PTY, xterm, Fastify, WebSocket** | spec §4, §11 | ~40% do código previsto para o que `ade report` + `ade takeover` cobrem sem `node-pty` (11 bugs de ConPTY, incl. `kill()` em PID alheio). Volta na v0.4. |
| **Índice SQLite** | spec §3, §6 | É índice **para o painel**; sem painel, projeção sem leitor. O journal é greppável. |
| **Transporte ACP** | `adapters-and-acp.md` §0 | Custa structured output, id pré-cunhado e orçamento a priori — as 3 garantias que sustentam o journal (§5). |
| **Adapter `gemini`/`agy`** | spec §5 | Duas famílias já bastam para Maker ≠ Checker. `gemini` não retoma por id nem tem schema; `agy` escreveu fora do `--add-dir` sem avisar (#38). |
| **Concorrência N>1, pool de worktrees, fila de merge** | PROMPT §3.3 | Evidência manda serializar escrita na mesma árvore. Os **campos** entram; o scheduler não. |
| **Catálogo de centenas de skills** | spec §9, PROMPT §3.5 | ~1.188 brutas → ~60–80 relevantes. Sincronizar 1.100 irrelevantes é custo de índice, quarentena e auditoria por zero ganho. |
| **Time de pesquisa de 2–4 agentes** | PROMPT §3.8 | ~15× tokens; só se paga em recall. |
| **Memória por repo e por usuário** | `landscape-context...` §3 | Journal + delta de spec já são o progress log. |
| **Graft embutido** | spec §2, §12 | ADOPT opcional com fallback `rg`; ganho "a medir no dogfood" não sustenta dependência na v1. |
| **CI loop e `ci_rerun`** | runtime | `ci.enabled: false` é default. `tl_ci_slice.normalize` **entra** — é a assinatura do detector de loop. |
| **Rotinas autônomas agendadas** | PROMPT §3.13 | `/loop` e routines nativos cobrem sem código nosso. |
| **Frontend em duas etapas Claude→Codex** | spec §10 | É **[H]** sem benchmark (`landscape-routing...` §1.3). Default = Maker único; a 2ª etapa vira flag e hipótese do doctor. |
| **`visual-eval`/`research-finding` publicados** | `runtime-port-map.md` §3.2 | Um consumidor só; o schema inline já coage. |
| **Advisor próprio, `auto-mode`, `codex sandbox` universal, `ultrareview` bloqueante** | spec §12 | `--advisor` já é nativo; `auto-mode` é só-Claude e semântico; `codex sandbox` falha fechado até no próprio cwd; `ultrareview` tem cota de 3 e 5–10 min. |
| **Pixel-diff, SaaS visual, computer use, MCP de browser automático** | — | Sem baseline em tela nova; 58–70 ferramentas no contexto por capacidade que a API do Playwright já dá. |

---

## 10. Roadmap em vertical slices

**MVP (slice 1)** motor durável + uma story real, sem painel e sem plano · **v0.2** Intent Compiler +
plano + aprovação + skills + Checker · **v0.3** FQE (D1–D5 + juiz) + `$imagegen` · **v0.4** painel
web só-leitura e `ade report` rico; PTY apenas se o takeover por linha de comando se provar
insuficiente no dogfood · **v1** pesquisa como time, ablação via `claude plugin eval`, adapter
Gemini, delta de spec em `.ade/spec/` · **Futuro** ACP, N>1, Graft, rotinas, memória, Tauri.

### Slice 1, detalhado

**Objetivo.** `ade run` executa **uma** story declarada à mão em `plan.json`, com Maker `claude`,
eval obrigatório, `contain` e commit local — sobrevivendo a `kill -9` em qualquer ponto.

**Critério de aceite.** (1) Matar o processo em 6 pontos (antes do spawn, depois do efeito do Maker,
antes/depois do commit, antes/depois do push) e retomar: **nenhum efeito repetido**, com o journal
explicando cada decisão. (2) Eval que nasce verde é recusado pelo gate `tree_before`. (3) Segredo
plantado no diff **para o lote** antes de qualquer commit, mesmo com violação de escopo simultânea.
(4) `ajv` recusa um `review-result` na forma antiga (`target`/`summary`) na ingestão. (5) Journal
adulterado em uma linha → exit 2.

**Evals do slice.** Porte de `test_tl_runtime.py` caso a caso com o mesmo nome, alvo **93/93 em
Windows e Linux incluindo o caso hoje skipado** (o shim vira `node shim.js`) — não "os 10 que
falham", que vêm de helpers que a ADE não porta. CLI falsa com contador **durável em disco**,
`no_result` e captura de pack + env.

**Dependências.** Node 22 LTS, `canonicalize`, `ajv`, `child_process`. Zero UI, zero `node-pty`,
zero SQLite, zero Playwright.

**Risco.** Canonicalizador errado quebra a cadeia em silêncio (mitiga: vetores RFC 8785 antes de
qualquer outro código); `maxBuffer` default trunca a varredura de segredo (mitiga: teste com diff >
1 MiB e segredo no fim).

**Pronto.** Paridade verde nos dois SOs; a ADE executa uma story **dela mesma** (adicionar um campo
ao `journal-event`, com eval); `ade doctor` resolve o caminho absoluto dos dois binários e prova
`--json-schema`/`--output-schema` com chamada real.

---

## 11. Os 3 maiores riscos e como reverter

**R1 — "Sem painel" mata a adoção.** O north star fala em ver agentes trabalhando; a v1 entrega um
JSONL e um `ade report`. *Sinal:* o operador abre o journal à mão mais de uma vez por lote.
*Reversão:* o painel é **aditivo e sem acoplamento** — os dados já estão no journal, e o SQLite
cortado é o único retrabalho (~1 dia para reconstruir o índice). O PTY reverte separado; se
`node-pty` sangrar, a rota de escape é `portable-pty` via napi-rs.

**R2 — Bespoke envelhece mais rápido que ACP.** Flags mudam a cada release, sem handshake de
capacidade; um release quebra `--approve-for-me` e o lote desatendido vira inseguro em silêncio.
*Sinal:* `ade doctor` falhando uma flag entre releases mais de uma vez por trimestre. *Reversão:* o
`AgentAdapter` é a fronteira, o `CapabilitySet` tem `probe_ok`/`probed_at` e o doctor **falha alto**
em vez de degradar. Trocar o transporte de uma família é reescrever um arquivo, não a arquitetura.

**R3 — O corte de skills e de pesquisa subdimensiona J5 e J6.** *Sinal:* `precision@3` < 0,75 nas
fixtures, ou `rework_rounds` p90 alto em classe `project`. *Reversão:* o índice é um JSON e a
sincronização é um `git clone` por fonte — ir de 80 para 300 skills é configuração, não código,
desde que os controles de supply chain já estejam no lugar (e estão, na v1); pesquisa vira time
trocando `research.max_agents`. Ter projetado pequeno custa zero; ter projetado grande custaria
manutenção permanente.

**Decisões que precisam do Erick antes da implementação:** (1) aceitar a v1 sem painel e sem PTY;
(2) aceitar duas famílias na v1 (Claude + Codex), com Gemini/Antigravity pós-v1; (3) aceitar o teto
visual de 2 rodadas e o corte 7,5 em vez de 4 rodadas e 8.
