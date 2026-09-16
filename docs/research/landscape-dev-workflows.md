# Landscape: metodologias e workflows para construir a TL-ADE

Data da pesquisa: 2026-09-16. Escopo: como desenvolver a própria TL-ADE (TypeScript, monorepo pnpm,
meses de trabalho, operador único) com alta qualidade e máxima automação.

Convenções: `[V]` = verificado em fonte primária (repo, docs oficiais, release notes, API do GitHub);
`[I]` = inferido de fatos verificados; `[H]` = hipótese. Contagens de estrelas vêm de `gh api` em
2026-09-16 — use-as como **ordenação relativa**, não como número absoluto; repos de metodologia com
centenas de milhares de estrelas são atípicos e o valor pode refletir inflação do ecossistema. `[I]`

---

## (a) Matriz de decisão

| Método | O que automatiza de verdade | Onde exige humano | Maturidade | Evidência de resultado | Custo de contexto | Decisão ADE |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Anthropic — "Effective harnesses for long-running agents"** | Papel `initializer` (monta repo, `init.sh`, notas de progresso, feature list) + `coding agent` (uma feature por sessão, auto-verifica, commita). Sequência fixa de 6 passos no início de cada sessão. `[V]` | Escrever o pedido inicial; decidir quando parar. | Artigo de engenharia da Anthropic, 2026 `[V]` | Clone do claude.ai com ~200 features construído pelo harness `[V]` | Mínimo: 1 JSON + notas + `init.sh` | **ADOPT** — é o esqueleto do dia 1 |
| **Claude Code best practices (docs oficiais)** | 4 níveis de portão de verificação (prompt → `/goal` → Stop hook → subagente verificador); plan mode; `/batch` em 5–30 subagentes com worktree+PR cada; headless `claude -p --output-format stream-json` | Poda do `CLAUDE.md`; decidir o nível de portão; aprovar plano | Doc de produto vivo (`code.claude.com/docs/en/best-practices`) `[V]` | Boris Cherny: "dar ao Claude como verificar o próprio trabalho melhora 2–3×" `[V]`; CLAUDE.md do time = 2,5k tokens `[V]` | Baixo; o doc é sobre reduzir contexto | **ADOPT** |
| **Superpowers (obra/superpowers, Jesse Vincent)** | Cadeia `brainstorming → using-git-worktrees → writing-plans → subagent-driven-development → TDD → requesting-code-review → finishing-a-development-branch`. Implementer fresco por tarefa, ledger append-only, loop de fix com teto de 5 rounds (≥4 escala modelo) `[V]` | Aprovação do design no brainstorming; escolha merge/PR/discard no fim. Entre tarefas **não** para `[V]` | 287k★, push 2026-09-14, v6.3.0 (2026-08) `[V]`; suite de evals própria `[V]` | Sem métrica publicada de outcome `[V]`; evidência é adoção em ~14 harnesses `[V]` | Desenhado para ser barato: leitura pesada vai para subagentes isolados `[V]` | **ADOPT** — já instalado localmente, custo de adoção zero |
| **Codex / AGENTS.md + review** | Formato de instrução de repo aceito por Codex, Jules, Gemini CLI, Copilot, Cursor, Zed, Aider, Devin, Factory, Junie `[V]`; sob curadoria da Agentic AI Foundation (Linux Foundation) `[V]` | Escrever e podar o arquivo | >60.000 projetos OSS `[V]`; `openai/codex` 124k★, push hoje `[V]` | Padrão de fato multi-fornecedor `[V]` | **Teto de 32 KiB, truncado em silêncio** (`project_doc_max_bytes`) `[V, fonte secundária]` | **ADOPT** — com AGENTS.md < 8 KB |
| **Orca (stablyai/orca) — padrão de CI** | ~30 portões nomeados no `pr.yml`: `audit:anti-slop`, ratchets (`max-lines`, `ts-nocheck`), *root directory guard*, `code-quality:changed`, matriz Node × 8 shards, e2e Windows/WSL/Wayland `[V]` | Autor/operador do agente; merge | 11.045 commits e 9.857 PRs merged em 6 meses; 8.858 arquivos de teste; 66 workflows `[V]` | 2.249 PRs merged nos últimos 30d, ~75/dia `[V]` | 54,6–64,9 runner-min por PR `[V]` | **ADOPT** (portões) — ver §b1 |
| **PRP / Product Requirement Prompt (Wirasm)** | Forma do artefato: `PRP = PRD + curated codebase intelligence + validation commands`; `/prp-implement` leva a PR com CI verde; `prp_loop.py` (loop autônomo em código, 25 KB) `[V]` | Aprovar o PRP antes; revisar o PR depois `[V]` | 2.244★, push 2026-09-08, **sem releases** `[V]` | Nicho; o termo virou vocabulário genérico `[I]` | ~16 KB por invocação `[V]` | **ADAPT** — copiar a *forma* do artefato, não o repo |
| **Ralph Wiggum loop (Huntley)** | `while :; do cat PROMPT.md \| claude -p ...; done`; dois prompts (plan/build); progresso acumula em arquivos + git, contexto zera a cada iteração; até 500 subagentes de leitura e 1 de build `[V]` | Fase 1 (ideia → JTBD → `specs/*.md`) é conversa fora do loop; humano afina o PROMPT entre rodadas `[V]` | `how-to-ralph-wiggum` 1.755★, push 2026-01-11 — 4 markdowns e um `loop.sh` `[V]` | `cursed` (compilador self-hosting, Zig, ~US$14k; ~US$5k se tivesse fixado a linguagem) `[V]`; US$50k de escopo por US$297 `[V, auto-reportado]` | Mais barato por iteração, mais caro no total (relê specs sempre) `[V]` | **ADAPT** — só para lotes mecânicos verificáveis (§c, fase 1). Exige `--dangerously-skip-permissions`: sandbox é a única fronteira `[V]` — não usar fora de contêiner/worktree descartável |
| **Beads (gastownhall/beads, Yegge)** | Backlog como **grafo**: `bd ready` (fila derivada, sem bloqueador aberto), `bd update --claim` (claim atômico), IDs por hash (`bd-a1b2`, zero conflito de merge), *compaction* semântica para poupar janela de contexto `[V]` | Definir o grafo inicial; escalações | 27.188★, v1.3.0 (2026-09-15), push hoje, 10.821 commits, 1.650 arquivos `_test.go` `[V]` | 51% dos commits recentes com trailer de agente `[V]`; Yegge: ~175 commits/dia, ~69 bi tokens/mês `[V]` | **O mais leve da categoria**: 5 linhas no AGENTS.md + pull JSON sob demanda `[V]` | **REFERENCE** — as 3 primitivas (`ready`, claim, hash ID) entram no engine da ADE; não instalar a ferramenta |
| **GitHub Spec Kit** | `/speckit-constitution → specify → plan → tasks → implement → converge` (repetir implement↔converge até `Converged`); extensões `bug` e `assess` `[V]` | README manda rodar **uma skill por vez e revisar antes de continuar** `[V]` | 137k★, v1.0.7 (2026-09-15), cadência semanal, 321 issues abertas `[V]` | Adoção massiva; presets comunitários `[V]` | `templates/` = 157.532 B (~40k tokens); `/speckit-specify` sozinho ≈ 4–5k tokens `[V]` | **REFERENCE** — a spec da ADE já existe e é melhor que o que o template geraria |
| **OpenSpec (Fission-AI)** | `/opsx:explore → propose → apply → archive`; specs em Markdown com SHALL/WHEN/THEN; "Stores" (planejamento compartilhado entre repos) `[V]` | Gate humano entre `propose` e `apply` `[V]` | 68.426★, v1.13.0 (2026-09-09); **1,77M downloads npm/mês** — maior sinal de uso real da categoria `[V]`; dogfooda a si mesmo `[V]` | Posicionado para brownfield, contra o waterfall do Spec Kit `[V]` | ~132 KB em 13 skills `[V]` | **REFERENCE** — adotar só se a ADE precisar de spec compartilhada entre repos (Stores) |
| **Kiro specs + EARS (AWS)** | `requirements.md` (EARS: "WHEN [trigger] the system SHALL [response]") → `design.md` → `tasks.md` em `.kiro/specs`; executa tasks independentes em *waves* concorrentes `[V]` | Gates humanos entre as três fases (bypass via Quick Spec) `[V]` | Produto proprietário, sem repo; adoção não verificável `[V]` | Sem números públicos `[V]` | Não quantificável `[H]` | **ADAPT** — só a notação EARS para o campo de aceite das stories |
| **BMAD Method v6** | `bmad setup` → `bmad-build`; cadeia sprint-planning → build → code-review; PRD/arquitetura/épicos/stories; `bmad-loop` roda épico inteiro sem supervisão `[V]` | Escolher o *planning path*; revisar cada artefato `[V]` | 53.070★, v6.0.0 em 2026-02-17, v6.12.0 em 2026-09-04 `[V]` | v6.12 mudou para "decidir a cerimônia **depois** de investigar"; v6.11 cortou 14→8 skills core `[V]` | **~1,76 MB em 29 skills** — ordem de grandeza acima de todos `[V]` | **REJECT** como método; **REFERENCE** pela lição: cerimônia proporcional ao tamanho da mudança |
| **Agent OS v3 (buildermethods)** | Só padrões de código: `/discover-standards`, `/inject-standards`, `/index-standards` `[V]` | Quase tudo, por decisão explícita `[V]` | 5.419★, v3.0.0 (2026-01-20), sem release há 8 meses `[V]` | O release v3 é uma retratação: "não faz sentido reinventar" spec-writing e task-breakdown, que "Plan Mode e modelos frontier fazem melhor" `[V]` | ~31 KB, o mais leve `[V]` | **REFERENCE** — a lição vale mais que a ferramenta |
| **gstack (Garry Tan)** | 23 skills encenando papéis (CEO/Designer/EM/QA/CSO); `/office-hours → /autoplan → /spec → /review → /ship → /land-and-deploy → /canary`; `/freeze`, `/guard`, `/careful` `[V]` | ~6 gates nomeados de julgamento humano `[V]` | 133k★, push hoje, CI com evals periódicos e quality-gate `[V]` | 60 dias: 3 serviços em produção, 40+ features, part-time `[V, auto-reportado]`; claim de 810× em LOC lógico `[V, auto-reportado / métrica escolhida pelo autor]` `[H]` | Alto por design; mitigado por digest de 2 KB `[I]` | **REFERENCE** — `/freeze` (bloqueio de caminhos) e `/canary` são ideias aproveitáveis |
| **Everything Claude Code (affaan-m/ECC)** | Catálogo: 292 skills, 169 agentes/comandos/hooks, ~50 MB; inclui `autonomous-loops`, `eval-harness`, `gan-style-harness`, `context-budget`, `agentshield` `[V]` | Toda a orquestração — é biblioteca, não loop fechado `[I]` | 259k★, push 2026-09-15, mantenedor único, entrega semanal `[V]` | Nenhum número de projeto construído `[H]` | O maior volume bruto da lista `[V]` | **ADAPT** — já é fonte do catálogo da ADE (spec §9); usar como *fonte*, não como método |
| **Gas Town (gastownhall/gastown)** | Orquestração de 20–30 agentes: Mayor/Rigs/Polecats/Hooks(worktrees)/Convoys/Refinery (merge queue Bors com bisecting)/Witness-Deacon-Dogs/Scheduler com cap de rate limit `[V]` | Overseer só em escalação P0/P1 `[V]` | 18.078★, v1.2.1 (2026-06-06), sem release há 3 meses; energia do autor migrou para `gascity` `[V]` | **Dashboard oficial do próprio org, 2026-09-13: CI success rate 22,7%; 116 de 150 commits em main com CI falhando (~77%)** `[V]` | Alto | **REJECT** para a v1 — 30 agentes é problema que a ADE não tem; a *Refinery* vira **REFERENCE** para o backlog v2 |
| **Taskmaster AI** | Parse de PRD → tasks → subtasks + dependências, via CLI e servidor MCP `[V]` | Revisão de tudo | 28.075★ mas **push 2026-04-28, release 0.43.1 de 2026-03-31** — ~5 meses parado; últimos commits só trocam URLs `[V]` | 63k downloads npm/mês (28× menos que OpenSpec) `[V]` | Baixo (MCP) `[I]` | **REJECT** — em risco de abandono |
| **Vibe Kanban (BloopAI)** | Board → workspace por agente com branch + terminal + dev server; diff review com comentário inline devolvido ao agente; 10+ CLIs `[V]` | Revisão do diff | **README abre com "Vibe Kanban is sunsetting"** (anúncio 2026-04-10); última release v0.1.44 (2026-04-24); 540 issues abertas `[V]` | Motivo declarado: não acharam modelo de negócio `[V]` | — | **REJECT** — mas o *diff review com comentário inline devolvido ao agente* é feature candidata ao painel da ADE `[I]` |
| **Conductor (conductor.build)** | Agentes Claude/Codex/Cursor em paralelo, workspaces isolados, review e merge `[V]` | Review e merge | Proprietário, **Mac-only**, v0.85.0 `[V]` | Sem repo público | — | **REJECT** — Mac-only; é exatamente o produto que a ADE substitui |

**Três eixos ortogonais que a evidência de 2026 separa** `[I, sustentado por V]`:
1. **Spec-driven** (Spec Kit, OpenSpec, Kiro, PRP, BMAD) — artefatos markdown + gates humanos entre fases.
2. **Backlog como grafo** (Beads, Taskmaster) — dependências, fila `ready`, claim atômico, contexto por *pull*.
3. **Orquestração/workspace** (Gas Town, Conductor, Vibe Kanban) — paralelismo, isolamento, merge queue.

A TL-ADE é do eixo 3 com motor do eixo 2; o eixo 1 ela já resolveu por spec escrita à mão.

---

## (b) Estudos de caso

### b1. Orca — `stablyai/orca` `[V]`

**É o "Orca" citado.** Stably AI (YC W22, 25 pessoas), descrito no próprio repo como "the ADE for
working with a fleet of parallel agents" — mesmo acrônimo, mesmo problema `[V]`. Descartados:
`hundredrabbits/Orca` (linguagem de música), OrcaSlicer, `spinnaker/orca`, Microsoft Orca (LLMs).

Escala em 6 meses (criado 2026-03-17): 11.045 commits em main, 9.857 PRs merged, 953 releases,
149,9 MB de TypeScript, 8.858 arquivos de teste Vitest, 66 workflows, ~2.249 PRs merged nos últimos
30 dias `[V]`. Não há declaração pública de "% escrito por IA"; 292 commits com `Co-Authored-By: Claude`
é piso, não teto `[V]`.

Replicável:
- **`CLAUDE.md` é uma linha: `@AGENTS.md`.** Fonte única. O `AGENTS.md` (~1.400 palavras) é um
  **roteador de gatilhos**: cada regra termina apontando um arquivo em `docs/reference/` `[V]`.
- **`docs/reference/` — 40 arquivos, um por cicatriz.** Exemplo canônico,
  `antigravity-readiness-evidence.md`: um detector "foi escrito cinco vezes; três das quatro primeiras
  eram piores que o bug que substituíam; a quinta foi revertida" — e nenhuma das cinco percebeu que a
  condição comum a todas nunca casa com uma tela real `[V]`. A correção institucional não foi prompt
  melhor: foi um gravador de PTY commitado + fixtures + a regra *"uma regra que lê o que uma CLI de
  agente pinta no terminal deve ser escrita contra um transcript capturado, não contra uma tela
  lembrada"* `[V]`. **Isto é diretamente aplicável à ADE**, cujos adapters parseiam saída de CLI.
- **Portões de CI que substituem revisão linha a linha**: `audit:anti-slop` (job "Reject low-evidence
  patterns", usando `dmmulroy/anti-slop` pinado por SHA, com `no-unknown-parameters`,
  `no-chained-type-assertions`, `no-widen-then-assert`, `require-safety-comment-for-type-assertion`);
  **ratchets** que só podem melhorar (`max-lines`, `ts-nocheck`) com proibição escrita de suprimir a
  regra; **root directory guard** rejeitando arquivos novos na raiz; `code-quality:changed` só nas
  linhas alteradas; scripts de CI baixados do `default_branch`, nunca de `pull/<n>/head`, em jobs com
  token de escrita `[V]`.
- **Corpo de PR como relatório de evidência.** Template com "AI Disclosure", resumo de code review do
  próprio agente cobrindo cross-platform/SSH/performance/UI/segurança, tabela automática de LoC teste vs
  produção (`pr-test-loc.yml`) e "Visual Proof" before/after obrigatório para UI `[V]`. PRs reais trazem
  **controle negativo** (`grep` de uma flag inexistente retorna 0, a real retorna 1) e frases como
  "não consegui determinar a versão mínima da CLI e não vou chutar" `[V]`.

Não replicável (e é o risco): **zero reviews humanas `APPROVED`, nenhuma branch protection, nenhum
ruleset em `main`** `[V]`. Só funciona porque existem 66 workflows e ~30 portões. Copiar a autonomia sem
copiar a malha é o erro do Gas City (abaixo).

### b2. Anthropic / Claude Code `[V]`

`anthropics/claude-code` **não é o código-fonte** (produto npm minificado); métricas derivadas dele são
inválidas `[V]`. Os números reais, em ordem e com grau:

| Data | Fonte | Número |
| :--- | :--- | :--- |
| 2025-05 | Boris Cherny (Latent Space) | "~80%" + "há muita revisão humana de código" `[V]` |
| 2025-12 | Boris (via Simon Willison) | 259 PRs / 497 commits / +40k −38k linhas em 30 dias, "cada linha escrita por Claude Code + Opus 4.5" `[V]` |
| 2026-01 | Fortune | 100% há 2+ meses; porta-voz: 70–90% na empresa `[V]` |
| **2026-06** | **Anthropic Institute (única medição instrumentada)** | **>80% do código merged em produção autorado por Claude** (mai/2026), vs "low single digits" antes de fev/2025; engenheiro típico merge 8× mais código/dia que em 2024 — **com caveat dos próprios autores de que LOC é métrica imperfeita e 8× "é quase certamente exagero"** `[V]` |

Armadilha: o "90% em 3–6 meses" de Dario Amodei (CFR, 2025-03) é previsão sobre a indústria, não
estatística interna `[V]`.

Processo replicável: 5 sessões locais (uma por checkout git) + 5–10 na web; **10–20% das sessões
abandonadas**; CLAUDE.md do time de **2,5k tokens**, atualizado várias vezes por semana, com
aprendizados adicionados ao marcar `@.claude` em PRs de colegas via GitHub Action; **plan mode
obrigatório quando o objetivo é um PR** `[V]`. Filosofia: "a cada modelo novo, deletamos um monte de
código" `[V]`.

Dado de risco interno: usuários do Claude Code **aprovam 93% dos prompts de permissão** `[V]` — o gate
por clique não é gate.

### b3. `cloudflare/workers-oauth-provider` — o melhor registro de auditoria `[V]`

O verbo importa: "**largely** written with the help of Claude", e a ressalva é explícita: *"this is not
'vibe coded'. Every line was thoroughly reviewed and cross-referenced with relevant RFCs, by security
experts"* `[V]`.

- **Os prompts estão nas mensagens de commit.** Commit inicial: ~1.800 palavras de spec → 857 linhas em
  um arquivo `[V]`.
- **Convenção de autoria no histórico**: `Ask Claude to…` (saída da IA) vs `Fix Claude's bug manually` /
  `Finish … myself` (humano) `[V]`.
- **Os commits mais valiosos são os de fracasso**: *"THIS CODE HAS A BUG. I repeatedly prompted Claude to
  fix the bug, but it kept getting it wrong. I will fix manually in the next commit."* `[V]`
- Métrica: "alguns dias com IA; estimo semanas ou meses à mão" `[V]`. Ressalva do próprio autor: caso
  ideal — padrão bem conhecido, plataforma bem conhecida, spec de API clara `[V]`.
- **E mesmo assim, dois CVEs medium**: CVE-2025-4143 (falta validação de `redirect_uri`) e CVE-2025-4144
  (bypass de PKCE por downgrade); a advisory atribui a falha ao **revisor humano** `[V]`.
- Hoje: ~9,5k LOC de src vs ~18,3k de testes (**1,9:1**), semgrep pinado, suíte `conformance/` rodando
  Worker real, e `bonk.yml` — review por IA sob demanda via `/bonk` no PR `[V]`.

### b4. `cursed` (Huntley) — prova o loop, não a manutenibilidade `[V]`

1.198 commits, contribuidor único, Zig 8,8 MB, **parado desde 2025-11-16**, 654★ `[V]`. ~US$14k em três
reescritas (C → Rust → Zig); autor estima ~US$5k se tivesse fixado a linguagem `[V]`. Sem workflow de
teste no GitHub Actions `[V]`. A raiz tem `build_output.log`, `direct_test.c`,
`CURSED_FINAL_DEMONSTRATION.cursed`, `benchmark_results.csv` commitados `[V]` — exatamente o lixo que o
*root directory guard* do Orca existe para impedir.

### b5. Yegge — Beads e Gas Town `[V]`

Beads: 27.188★, Go, 1.650 arquivos `_test.go` (44% dos arquivos), `ci-gate.sh` que exige `success` e
trata `skipped` como falha, actions pinadas por SHA `[V]`. Governança replicável: `PROJECT_CHARTER.md`
como gate de escopo (*"Beads owns issue tracking primitives and should not encode orchestration-layer
policy"*) — a única defesa documentada contra agente que expande superfície do produto `[V]`; e
`PR_MAINTAINER_GUIDELINES.md` protegendo contribuidores humanos de agentes maintainer `[V]`.

Métricas de Yegge: ~175 commits "reais"/dia, >700 beads no backlog, equivalente a US$87k/mês de tokens
(desembolso real ~US$2.800 via rotação de 13 contas Max), 96% de cache hit `[V]`.

**O contraponto, publicado pelo próprio org** (`gascity-project-dashboard`, 2026-09-13): **CI success
rate 22,7%** (queda de 42,3 pontos), **116 de 150 commits em main com CI falhando (~77%)**, mediana de
primeira resposta humana "sem dados" `[V]`. Quem cita Gas Town como prova de que frotas funcionam
precisa citar isto junto.

### b6. Outros repos "IA-escritos"

- ✅ `samuelcolvin/spread` (autor do Pydantic, Rust/GPUI): *"almost entirely written by AI — Codex +
  GPT-5.5 e Claude Code + Opus 4.7 1M"*; política invertida: **"No PRs"**, contribua com o *prompt
  proposto na issue*; CI real com actions pinadas, `permissions: {}`, zizmor `[V]`.
- ⚠️ `electric-sql/electric`: "nearly 100% AI-written" — declaração sem métrica nem descrição de revisão
  `[V]`.
- ⚠️ `graydon/lsp-lm-tool`: disclosure exemplar, **zero testes, zero CI** `[V]`.
- ❌ `sqlite-vec` não alega autoria por IA; `sourcegraph/amp` não existe publicamente; Cognition/Devin e
  Vercel não têm repo público com percentual + CI — **sem números** `[V]`.

**Achado estrutural** `[I, de ~80 buscas de código]`: declarar autoria por IA no README correlaciona
**negativamente** com maturidade de engenharia. Os projetos sérios (Orca, Beads) deixam a evidência nos
trailers de commit e no CI, não no README.

### b7. Baseline de risco 2026 — o que a malha de verificação precisa cobrir

| Eixo | Sinal | Força |
| :--- | :--- | :--- |
| **Segurança** | **45% das amostras falham teste de segurança — plano desde 2023**, enquanto a corretude *sintática* subiu de ~50% para ~95%. 150+ modelos, 80 tarefas (Veracode) `[V]` | **Benchmark reprodutível — o dado mais duro** |
| Cadeia de suprimentos | Pacotes alucinados: 5,2% (comercial) / 21,7% (OSS), e **repetíveis** → sequestráveis. 2,23M amostras (USENIX Security 2025) `[V]` | Peer-reviewed |
| Tipo de defeito | Apiiro (~7.000 devs, ~62k repos): >10.000 achados de segurança/mês, 10× vs dez/2024; erros de sintaxe caem, **escalação de privilégio e falhas de design arquitetural sobem** `[V]` | Telemetria de fornecedor |
| Manutenibilidade | GitClear (623M mudanças): duplicação de blocos **+81%**, refatoração **−70%**, mudanças tocando código >12 meses **−74%** `[V]` | Telemetria de fornecedor |
| Throughput de PR | **2,09×** per capita (802 devs, 196.212 PRs, 2024-01→2026-04); **carga por revisor também dobrou e a revisão automatizada ultrapassou a humana**; merge e revert estáveis `[V]` | Paper longitudinal |
| Revisão | A maioria dos PRs gerados por IA **não recebe revisão**; quando recebe, o revisor tende a ser outro agente `[V]` | Paper descritivo |
| Produtividade individual | METR RCT 2025: **−19%** (previram +24%) — mas o follow-up de 2026 foi **autodesqualificado pelos autores** (viés de seleção; medir tempo quebra com agentes paralelos) `[V]` | RCT com ressalva do próprio autor |
| Horizonte de tarefa | Doubling do horizonte de 50%: ~7 meses geral, **88,6 dias desde 2024**; Opus 4.5 em 320 min `[V]` | Paper |

Não existe DORA 2026, Stack Overflow 2026 nem Octoverse 2026 `[V]` — blogs que citam "SO Survey 2026"
estão rotulando números de 2025; não usar.

**Conclusão que a matriz de risco impõe**: a taxa de falha de *segurança* do código gerado está plana em
45% desde 2023 enquanto a corretude sintática foi a 95%. O portão de que a ADE mais precisa (segurança e
design) é justamente aquele em que o modelo menos ajuda. **A qualidade da malha de verificação é a
variável independente; a autonomia do agente é a dependente.**

---

## (c) Recomendação: como construir a TL-ADE

Princípio de corte: a spec da ADE já existe e é boa; o motor já existe (tl-orchestrator v0.17.0, 93
testes). **Não adotar nenhum framework que reescreva spec ou backlog.** Adotar só o que a spec ainda não
tem: um esqueleto de sessão de agente, uma malha de portões de CI, e um registro de cicatrizes.

### c1. Artefatos do dia 1 (tudo em uma sessão, ~2 h)

| Artefato | Conteúdo | Origem |
| :--- | :--- | :--- |
| `AGENTS.md` (raiz, **< 8 KB**) | Como buildar/rodar/testar + regras de projeto como **roteador de gatilhos** ("ao tocar adapter → leia `docs/reference/cli-output-parsing.md`"). Nada de status, nada de log | Orca + agents.md + limite de 32 KiB do Codex `[V]` |
| `CLAUDE.md` | **Uma linha: `@AGENTS.md`** | Orca `[V]` |
| `init.sh` | `pnpm i`, build, teste rápido, `ade doctor`. Toda sessão começa lendo-o | Anthropic harness `[V]` |
| `docs/plan/features.json` | Feature list em **JSON** (não Markdown — o modelo sobrescreve MD com mais facilidade `[V]`), derivada dos 5 sub-projetos da spec §14. Por feature: `id`, `description` end-to-end, `steps`, `eval` (comando), `passes: bool` | Anthropic harness `[V]` |
| `docs/plan/progress.md` | Notas de sessão, append-only | Anthropic harness `[V]` |
| `docs/reference/*.md` | Vazio no dia 1. Um arquivo por cicatriz, escrito **no momento** em que um agente erra | Orca `[V]` |
| `.github/workflows/pr.yml` | Portões de c3 | Orca `[V]` |
| `docs/research/landscape-dev-workflows.md` | Este arquivo | — |

Convenção de commit desde o commit 1: prefixo/trailer separando autoria (`Co-Authored-By:` para saída de
agente; mensagem explícita quando o humano corrige à mão) — torna a razão IA/humano mensurável por
`git log` `[V: Cloudflare, Beads]`.

### c2. Ciclo por story (o fluxo enxuto)

Ferramenta: **Claude Code + skills Superpowers já instaladas localmente** (custo de adoção zero) +
**Codex como Checker**. Isto é o mesmo roteamento de papéis que a spec §13 já fixou — construir a ADE
assim é dogfood da própria spec.

```
1. brainstorming          (Superpowers)  → design doc curto   [HUMANO aprova]
2. writing-plans          (Superpowers)  → plano com tarefas de 2–5 min, caminhos exatos
3. using-git-worktrees    (Superpowers)  → worktree + branch, baseline de teste limpa
4. subagent-driven-development           → implementer FRESCO por tarefa, teto de 5 rounds de fix
   + test-driven-development             → RED-GREEN-REFACTOR, eval escrito antes do código
5. portões locais (c3) rodam antes de qualquer commit
6. Checker = Codex, família diferente, contexto mínimo (diff + spec da story)
7. PR com corpo-relatório (c4) → CI → merge commit (--merge, nunca squash, spec §6)
8. finishing-a-development-branch        → limpa worktree           [HUMANO decide merge]
```

Dois pontos de humano por story, e só dois: aprovação do design (passo 1) e do merge (passo 8). Entre
eles o agente não pergunta — exceto operação irreversível, ação de segurança ou efeito fora do worktree
`[V: Superpowers]`.

Regra de cerimônia proporcional `[V: BMAD v6.12, Claude Code docs]`: *se dá para descrever o diff em uma
frase, pula os passos 1–2*. Mudança simples ganha spec de duas seções e termina numa sessão.

### c3. Portões (a malha — o que substitui revisão linha a linha)

Ordem de implementação, do mais barato ao mais caro:

1. `tsc --strict` + `vitest` — obrigatório desde o commit 1.
2. **`oxlint` com `dmmulroy/anti-slop` pinado por SHA** — já previsto na spec §9 como portão TS; ativar
   no dia 1, não depois. Regras que importam para o motor: `no-unknown-parameters`, `no-unknown-returns`,
   `no-chained-type-assertions`, `no-widen-then-assert`, `require-safety-comment-for-type-assertion`
   `[V]`.
3. **Root directory guard** — ~20 linhas de CI. É a diferença entre a raiz do Orca e a do `cursed` `[V]`.
4. **Ratchets** (`max-lines`, `ts-nocheck`, `any`) — a métrica só melhora; suprimir a regra é proibido
   por escrito no AGENTS.md `[V]`.
5. **Paridade com a suíte Python**: os 93 testes de `test_tl_runtime.py` portados com o mesmo nome; o
   engine não merge sem eles verdes (spec §15).
6. `code-quality:changed` — lint pesado só nas linhas alteradas, para o CI não virar gargalo `[V]`.
7. **Checker de outra família** (Codex) — não é portão de CI, é passo 6 do ciclo.
8. `npm audit` / `osv-scanner` + **verificação de que todo pacote importado existe no registry** —
   antídoto direto ao 5,2%/21,7% de pacotes alucinados `[V]`.
9. Cobertura: **razão teste:produção visível no corpo do PR** (tabela automática estilo `pr-test-loc.yml`)
   em vez de threshold global. Referência: Cloudflare está em 1,9:1 `[V]`.

Não fazer na v1: mutation testing (caro, retorno baixo com 93 testes de paridade já cobrindo o núcleo);
merge queue com bisecting (só faz sentido com N agentes concorrentes — a spec fixou concorrência 1).

### c4. Corpo de PR como relatório de evidência

Template obrigatório, 4 seções `[V: Orca]`:
- **O que mudou** e por quê (1 parágrafo).
- **Eval executado** — comando e saída; o eval falharia sem a mudança? (spec §7 já exige isto).
- **Controle negativo** quando a verificação é de parsing/detecção (ex.: a flag inexistente retorna 0, a
  real retorna 1).
- **O que NÃO foi verificado** — lista explícita. *"Não consegui determinar X e não vou chutar"* é uma
  conclusão aceitável e preferível a um chute `[V]`.

### c5. O que roda no tl-orchestrator v0.17.0 vs no Claude Code/Codex direto

| Trabalho | Onde | Porquê |
| :--- | :--- | :--- |
| Sub-projeto 1, **porte dos 93 testes** (Python → Vitest, mesmos nomes) | **tl-orchestrator v0.17.0**, um lote de N stories mecânicas | É o único trabalho do projeto que é volumoso, repetitivo e com critério de pronto binário — o perfil exato em que um loop autônomo ganha `[V: Ralph/cursed]`. O v0.17.0 já tem journal, portões, rework e retomada. Se rodá-lo neste repo custar mais de meio dia de adaptação, **cai para `claude -p` em loop sobre a lista de testes**, que é a mesma ideia sem a integração |
| Sub-projeto 1, **motor** (journal JSONL, cadeia de hash, scheduler) | **Claude Code direto**, ciclo c2 completo | Design novo, decisões de arquitetura, TDD — precisa de brainstorming e plano |
| Sub-projeto 2, **adapters + PTY** | **Claude Code direto**, com a regra do transcript capturado (c6) | Parsing de saída de CLI é a superfície onde o Orca provou que agentes erram sistematicamente `[V]` |
| Sub-projeto 2, **painel** (React/xterm) | Claude (design) → Codex (engenharia), spec §10 | Já é o fluxo que a própria spec prescreve; construir o painel assim valida o fluxo antes de automatizá-lo |
| Sub-projetos 3–5 (tradutor, catálogo, loop visual) | **A própria ADE**, a partir do momento em que `ade run <lote>` + painel passam no dogfood da spec §14 | Ponto de troca definido e verificável, não uma data |
| Revisão de tudo | **Codex** (`codex exec`) como Checker | Spec §13 já fixou; famílias diferentes |

**Ponto de troca**: quando o sub-projeto 2 fechar ("assumir terminal no meio de story, soltar, engine
retoma do checkpoint"), a ADE constrói o sub-projeto 3. A regra de release da spec §15 ("antes de cada
versão, a ADE constrói uma story dela mesma") vira a régua contínua.

### c6. Três regras específicas desta base de código

1. **Transcript capturado, nunca tela lembrada.** Toda regra que lê saída de CLI de agente (os
   `parseEvents` dos adapters) é escrita contra um transcript de PTY gravado byte a byte e commitado
   como fixture. A spec §5 já pede "CLI falsa em `fixtures/`" — endurecer para "fixture é gravação
   real, não texto escrito à mão". Custo: um script de gravação (~50 linhas). Evita a classe de bug que
   o Orca documentou tendo queimado cinco tentativas `[V]`.
2. **`PROJECT_CHARTER.md` de uma página** delimitando o que a ADE **não** é (não é CI, não é issue
   tracker, não é IDE) — o gate de escopo do Beads é a única defesa documentada contra agente que amplia
   superfície `[V]`. Barato: 20 linhas.
3. **Poda semanal do AGENTS.md** pelo critério da Anthropic: *"remover esta linha faria o agente
   errar?"* `[V]`. Alvo: ≤ 2,5k tokens, como o do time do Claude Code `[V]`. Instrução que o modelo
   resolveria sozinho é ruído — já é o princípio 4 da spec §1.

### c7. Riscos

| Risco | Evidência | Mitigação |
| :--- | :--- | :--- |
| **Revisão deslocada para CI sem malha equivalente** | Gas City: 22,7% de CI success, 77% dos commits em main quebrados `[V]`; Orca funciona com ~30 portões e 8.858 testes `[V]` | Portões c3 ativos **antes** de aumentar autonomia. Nenhum aumento de autonomia sem portão novo |
| **Segurança: 45% de falha, plano desde 2023** `[V]` | Veracode; Apiiro: escalação de privilégio e falhas de design subindo `[V]`; Cloudflare teve 2 CVEs mesmo com revisão de especialistas `[V]` | Superfície de risco da ADE é pequena e conhecida: servidor só em `127.0.0.1`, `contain` de FS, catálogo de terceiros como leitura (spec §9/§11). Revisão humana **obrigatória** nesses três pontos, sem exceção |
| **Pacote alucinado** (5,2%/21,7%, repetível → sequestrável) `[V]` | USENIX Security 2025 | Portão c3.8: todo import novo verificado no registry; lockfile commitado; dependência nova é decisão humana |
| **Erosão de manutenibilidade** (duplicação +81%, refatoração −70%) `[V]` | GitClear | Ratchet de `max-lines` + `code-quality:changed`; princípio "a cada modelo novo, deletamos código" `[V: Anthropic]` |
| **Adapters quebram quando a CLI muda o formato de saída** | Classe de bug documentada pelo Orca `[V]`; Gemini CLI já migrou para Antigravity (spec §5) | Regra c6.1 (fixture gravada) + `ade doctor` + teste de contrato por adapter |
| **Over-processo para um operador só** | Agent OS v3 cortou o próprio escopo porque Plan Mode já resolvia `[V]`; BMAD v6.12 tornou a cerimônia proporcional `[V]` | Regra da cerimônia proporcional (c2). Se o diff cabe numa frase, pula plano |
| **Loop autônomo sem sandbox** | Ralph exige `--dangerously-skip-permissions`; o sandbox vira a única fronteira `[V]` | Loop autônomo **só** em worktree descartável, só no lote de paridade (c5), com push para branch próprio — nunca em `main` |
| **Contexto inchado** | Codex trunca AGENTS.md a 32 KiB **em silêncio** `[V]`; "bloated CLAUDE.md causes Claude to ignore your actual instructions" `[V]` | Teto de 8 KB no AGENTS.md; poda semanal (c6.3); conhecimento condicional vai para skill ou `docs/reference/`, nunca para o AGENTS.md |
| **Métrica auto-reportada vira decisão** | 810× do gstack e US$297/US$50k do Ralph são auto-reportados; METR se autodesqualificou; 8× da Anthropic tem caveat do próprio autor `[V]` | Medir localmente o que importa: PRs merged com CI verde na primeira tentativa, e razão teste:produção. Não importar número de terceiro como meta |

---

## Fontes

Anthropic: [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) ·
[Claude Code best practices](https://code.claude.com/docs/en/best-practices) ·
[Recursive self-improvement (Institute)](https://www.anthropic.com/institute/recursive-self-improvement) ·
[Auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) ·
[How Claude Code is built (Pragmatic Engineer)](https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built)

Métodos: [obra/superpowers](https://github.com/obra/superpowers) ·
[github/spec-kit](https://github.com/github/spec-kit) ·
[Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) ·
[bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) ·
[kiro.dev/docs/specs](https://kiro.dev/docs/specs/) ·
[buildermethods/agent-os](https://github.com/buildermethods/agent-os) ·
[Wirasm/PRPs-agentic-eng](https://github.com/Wirasm/PRPs-agentic-eng) ·
[eyaltoledano/claude-task-master](https://github.com/eyaltoledano/claude-task-master) ·
[ghuntley.com/ralph](https://ghuntley.com/ralph/) ·
[ghuntley/how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum) ·
[garrytan/gstack](https://github.com/garrytan/gstack) ·
[affaan-m/ECC](https://github.com/affaan-m/ECC) ·
[agents.md](https://agents.md/) ·
[BloopAI/vibe-kanban — sunset](https://www.vibekanban.com/blog/shutdown) ·
[conductor.build](https://conductor.build/)

Casos: [stablyai/orca](https://github.com/stablyai/orca) ·
[orca — antigravity-readiness-evidence.md](https://github.com/stablyai/orca/blob/main/docs/reference/antigravity-readiness-evidence.md) ·
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) ·
[cloudflare/workers-oauth-provider — HISTORY.md](https://github.com/cloudflare/workers-oauth-provider/blob/main/HISTORY.md) ·
[ghuntley/cursed](https://github.com/ghuntley/cursed) ·
[gastownhall/beads](https://github.com/gastownhall/beads) ·
[gastownhall/gastown](https://github.com/gastownhall/gastown) ·
[Yegge — The Shape of Things to Come](https://yegge.ai/essays/the-shape-of-things-to-come/) ·
[Boris Cherny — Latent Space](https://www.latent.space/p/claude-code) ·
[Simon Willison sobre Boris Cherny](https://simonwillison.net/2025/Dec/27/boris-cherny/)

Risco: [Veracode GenAI Code Security 2026](https://www.veracode.com/blog/spring-2026-genai-code-security/) ·
[USENIX Security 2025 — package hallucination](https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen) ·
[Apiiro — 4x velocity, 10x vulnerabilities](https://apiiro.com/blog/4x-velocity-10x-vulnerabilities-ai-coding-assistants-are-shipping-more-risks/) ·
[GitClear — AI code quality gap](https://www.gitclear.com/the_ai_code_quality_maintainability_gap) ·
[METR RCT 2025](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) ·
[METR — uplift update 2026](https://metr.org/blog/2026-02-24-uplift-update/) ·
[arXiv 2607.01904 — PR throughput](https://arxiv.org/abs/2607.01904) ·
[DORA 2025](https://dora.dev/dora-report-2025/)
