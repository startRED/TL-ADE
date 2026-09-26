# Registro de fontes do catálogo — v2 (2026-09-17)

Substitui a v1 de 2026-09-16, que classificava por estrelas e tratava `ComposioHQ/awesome-claude-skills`
como lista curada. Método da revisão: clone raso de cada repositório, contagem e medição local de
`SKILL.md`, leitura de LICENSE **por skill** e não por repositório (`docs/research/ref-skill-sources.md`,
`docs/research/ref-addyosmani-agent-skills.md`, `docs/research/ref-tools.md`). Tudo que é contagem,
tamanho ou licença abaixo foi medido, não lido de README.

Classificação: **skill** (sincroniza para `~/.ade/catalog/`), **ferramenta** (integra num portão ou
componente), **inspiração** (não integra; informa design).
Decisão: **ADOPT** (usa como está) · **ADAPT** (usa parte, com modificação) · **REFERENCE** (lê, não
integra) · **REJECT** (não entra).

Pipeline de ingestão, controles e precedência: `docs/specs/skill-fabric.md`.
Decisão arquitetural: `docs/adr/0009-skill-fabric-catalogo-curado-selecao-12-controles.md`;
rejeições: `docs/adr/0019-rejeicoes.md`.

---

## 1. Fontes de skills

`commit` é o pin inicial, medido em 2026-09-16. O pin **de registro** vive em `catalog.sources` de
`.ade/config.json` do repositório — `~/.ade/config.json` não existe no layout, e a v1 assume
repositórios do próprio operador (E56); a coluna aqui é a proveniência da medição, não a configuração
ativa. A forma da chave é fixada por `schemas/ade-config.schema.json`, única fonte das chaves de
configuração (E55): o que se lê aqui é derivado do schema, não normativo.
Fonte com `<pin pendente>` (aqui e na §2) fica **dormente até pin**: fora do escopo Must do
`ade catalog sync` da v0.4a enquanto o commit não for medido e gravado, porque o controle 2 do
SkillGuard (`docs/specs/skill-fabric.md` §5) faz checkout do SHA pinado e nunca `pull` — sem commit não
há o que sincronizar nem o que validar.

| Fonte | Licença | Commit pinado | Classificação | Decisão | Motivo |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `anthropics/skills` | **por skill**: 15 Apache-2.0, 4 Proprietary | `34040c9` | skill | **ADOPT parcial** | Formato canônico e melhor guia de autoria existente (`skill-creator`, 33 KB). **Denylist `docx`/`pdf`/`pptx`/`xlsx`**: texto proprietário proíbe "retain copies outside the Services". O repositório **não tem LICENSE de raiz** — licença é lida por skill |
| `affaan-m/ECC` | MIT | `8321021` | skill | **ADAPT** | 292 skills reais (não 903: 609 arquivos são espelhos multi-CLI e traduções). Ingerir só `skills/`, **nunca `install.sh`, nunca `hooks/`**, nunca instaladores por CLI. 124 scripts dentro de `skills/` → quarentena por padrão; na v1 nenhum script de catálogo fica disponível ao agente (só o corpo do `SKILL.md` e `references/*.md` como texto, architecture.md §11 E35). Referência pinada por commit, nunca dependência de runtime (§10 A13). Filtrar por domínio: os 40 `*-patterns` de Django/Laravel/Spring/Perl são inertes na stack e custam índice |
| `addyosmani/agent-skills` | MIT (raiz, sem exceção) | `<pin pendente>` | skill + método | **ADAPT**, dormente até pin | 25 skills canônicas, sem espelhos; ~7 preenchem lacuna real (API design, migração, ideação, requisitos, observabilidade, ship-gate, grounding em fonte). **Nunca `hooks/`**: `SessionStart` injeta um `SKILL.md` inteiro em toda sessão e `simplify-ignore.sh` reescreve arquivos do usuário no disco durante `Read`/`Edit`. O valor principal é o **framework de evals em 3 camadas** e o ledger `skill-impact.md`, adotados como método |
| `Leonxlnx/taste-skill` | MIT | `ccbc156` | skill | **ADAPT** (recorte), pedido de Erick 2026-09-17 | Anti-slop para landing pages, portfólios e redesigns (o próprio README exclui dashboards e UI de produto: não serve ao painel da ADE). `skills/taste-skill/SKILL.md` tem ~12,8k palavras (~17k tokens), acima do teto por skill (≤7,5k, E70): entra como **dois recortes curados** — `taste-marketing` (seções 0, 1, 4.1–4.7, 5.D, 6, 8: leitura do brief, três dials, tipografia, cor, layout, animações proibidas, dark mode) e `redesign-audit` (de `skills/redesign-skill/SKILL.md`, auditoria antes de mexer; casa com a jornada 2). `brandkit` alimenta a camada `tokens` do DesignBrief. `imagegen-frontend-*` e `image-to-code` ficam de fora (o FQE já tem `$imagegen`). Complementa o Impeccable (instrução ao Maker; o juiz continua sendo o Impeccable + juiz multimodal). Zero scripts no escopo de skill; `skill.sh` e `.claude-plugin/` não entram |
| `ibelick/ui-skills` | MIT | `c5bcd86` | skill | **ADOPT** | 7 skills de design engineering; zero scripts no escopo de skill; `improve-ui` declara fronteira inviolável no corpo ("Never modify product source"), que casa com `contain` e com o FQE |
| `ayghri/i-have-adhd` | MIT | `0a84de4` | skill | **ADOPT** | Disciplina de saída. Precedente de `metadata: {tags, category}` + `disable-model-invocation: true` — os campos que o `SkillIndexEntry` lê |
| `UditAkhourii/adhd` | MIT | `16dc239` | skill | **ADOPT** (a skill) / **REFERENCE** (o runtime TS) | Descrição com **gate negativo explícito** ("Skip for syntax, lookups, bugs with known root cause"): o modelo de descrição acionável que o detector de colisão premia |
| `img2threejs/img2threejs` | Apache-2.0 | `6e60b5e` | skill | **ADAPT**, dormente | Gate de qualidade objetivo antes de aceitar resultado é padrão reaproveitável. Corpo de 8,2k tokens estoura o teto por skill (≤7,5k, soma ≤20k, §11 E14): só entra se o domínio 3D aparecer e depois de progressive disclosure |
| `FloWritesCode/fwc-swiftui-skills` | MIT | `c2454e6` | skill | **ADOPT**, dormente | Fonte mais limpa medida (**zero scripts**). Fora do índice até existir projeto Apple |
| `superpowers` + skills locais de Erick (`impeccable`, `tl-impeccable-design`, `frontend-design`) | local | — | skill | **trust: local** | Lidas in-place em `~/.claude/skills/`; não sincronizam, não têm sha256 de pin (não há upstream a verificar), mas o evento de telemetria grava o `sha256` do corpo injetado e `source: 'local'` (E59). Skills de `<repo>/.claude/skills/` **não entram no pack** na v1 (só o catálogo curado) e não são carregadas pela CLI, porque a chamada despachada roda sob `--safe-mode`; em `codex`/`agy` a supressão equivalente é provada pela sonda (E56). Precedência **acima** do catálogo |
| `openai/skills` | **ausente** | — | skill | **REFERENCE** — fora do catálogo até resolver | 39 skills em `.curated` + 5 em `.system`, já instaladas localmente em `~/.codex/skills/.system/`. Sem licença declarada = mesmo bloqueio legal do Composio. **Uso in-place da instalação oficial do fornecedor (`$imagegen`) é permitido — a denylist é sobre redistribuição, não sobre uso** |
| `ComposioHQ/awesome-claude-skills` | **ausente** | `be2a406` | — | **REJECT** | Não é lista curada: **864 `SKILL.md` vendorizados**, 832 wrappers templatados do Rube MCP (30,4k tokens de índice para wrappers idênticos), 12 nomes colidindo com a Anthropic e 5 byte-idênticos; `document-skills/` redistribui as 4 proprietárias num repo **sem nenhuma LICENSE**. ADR 0019 |
| `vercel-labs/skills` | MIT | — | ferramenta | **REFERENCE** | Instalador/registry `npx skills find\|add\|list` sobre skills.sh. O controle 1 do SkillGuard proíbe instalador de registry aberto; serve como referência de UX, nunca como dependência |

**Escala.** 1.188 `SKILL.md` brutos → ~320 nomes de qualidade → **60–80 relevantes** para a stack
(TS/React/Node/design/agentic). ~75 % do volume bruto é ruído: espelho, template, cópia.

**Custo.** Índice completo: ~59.800 tokens **por turno** (inviável). Núcleo curado (~87 skills): ~7.500
tokens. Corpo injetado de ≤3 skills: ~6–7k tokens, dentro da soma ≤20k (§11 E14, §12 E70). O gargalo é o índice, nunca o corpo — é o que
justifica a seleção externa como requisito e não como otimização.

---

## 1.1 Fontes ativas no catálogo sincronizado (2026-09-24, ADR 0039)

Candidatas vieram de pesquisa do Grok e do ChatGPT a pedido de Erick; cada uma foi reclonada e medida aqui (licença do
repositório e do frontmatter, commit que tocou o `SKILL.md`, palavras, scripts, achados do SkillGuard). Pins completos e
caminhos em `~/.ade/catalog-repos/.ade/config.json`; sincroniza com `ade catalog sync` rodado dentro dessa pasta.

| Fonte | Licença | Commit | Skills pinadas | Estado no índice |
| :--- | :--- | :--- | :--- | :--- |
| `mattpocock/skills` | MIT | `c55ee46` | `tdd`, `code-review`, `codebase-design`, `resolving-merge-conflicts`, `writing-for-agents` | as 5 liberadas (as 2 últimas em 2026-09-26) |
| `helderberto/agent-skills` | MIT | `369b84f` | `frontend-ui-engineering` | liberada |
| `mblode/agent-skills` | MIT | `e7db33d` | `tidy`, `ui-design` | quarentena (`credentials`, `<!--`, `.env` em referência) |
| `product-on-purpose/pm-skills` | Apache-2.0 | `1cef1a9` | `deliver-acceptance-criteria`, `deliver-edge-cases` | quarentena (`<!--` de atribuição e de template) |
| `Jeffallan/claude-skills` | MIT | `882ef55` | `react-expert`, `test-master`, `code-reviewer` | `react-expert` liberada; as outras em quarentena (`<!--`, `<script` de teste XSS, `credentials`) |
| `wshobson/agents` | MIT | `4236bb9` | `typescript-advanced-types`, `javascript-testing-patterns`, `nodejs-backend-patterns`, `error-handling-patterns`, `accessibility-compliance` | 3 liberadas; `nodejs-backend-patterns` (`credentials`) e `accessibility-compliance` (`<!--`) em quarentena |
| `DevelopersGlobal/ai-agent-skills` | MIT | `f47f948` | `debugging-methodology` | liberada |
| `antfu/skills` | MIT | `a74f281` | `vitest` | quarentena (`<!--`, `--env-file=.env.staging` em referência) |

**Cortadas na medição:** `mattpocock/diagnosing-bugs` (traz `scripts/hitl-loop.template.sh`; só o `SKILL.md` cai em
quarentena `network_command`, medido em 2026-09-26), `mattpocock/grilling`, `grill-me`, `grill-with-docs`, `to-spec`,
`to-tickets`, `triage`, `wayfinder` e `handoff` (entrevistam o operador ou publicam em issue tracker: não cabem em
missão autônoma), `mattpocock/domain-modeling` (cria `CONTEXT.md` na raiz, fora da allowlist), `mattpocock/prototype`
e `research` (código descartável e agente de fundo, fora do escopo da parte), `mcollina/skills/node`
(`SKILL.md` parado desde 2026-03-13 e assets `.ts`), `facebookresearch/secpriv-skill` (`SKILL.md` na raiz, sem `name`),
`helderberto/a11y-audit` (manda rodar `npx`), `helderberto/tdd` (repete a do mattpocock), `alirezarezvani/claude-skills`
(biblioteca com scripts; fica para uma rodada própria).

## 1.2 Coleções famosas na lista curada (2026-09-25, ADR 0042)

Pedido de Erick: trazer as skills e plugins mais conhecidos da internet, com filtro rígido (licença livre e segura) e
lista fixa revisada, que só muda por commit e só entra no catálogo por comando. A lista vive no repositório, em
`docs/catalog/fontes-curadas.json`, e sincroniza com `ade catalog sync --sources docs/catalog/fontes-curadas.json`.
Cada entrada leva `reason` (motivo) e `community_signal` (sinal da comunidade com data da medição). Esta tabela é o
espelho legível da lista: commit abreviado e licença têm de bater com o arquivo (`tests/catalog_sources_registry.test.ts`).

| Fonte | Licença | Commit | Skills escolhidas | Motivo | Sinal da comunidade | Ficou de fora e por quê |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `obra/superpowers` | MIT | `5bf4e78` | `dispatching-parallel-agents`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `test-driven-development`, `using-git-worktrees`, `verification-before-completion`, `writing-plans` | Método de trabalho do agente (planejar, revisar, verificar antes de concluir, isolar em worktree), que casa com o ciclo Maker/Checker; LICENSE MIT na raiz do commit | 291.168 estrelas e 26.049 forks (API do GitHub, 2026-09-24) | `hooks/` e `scripts/`; meta-skills (`using-superpowers`, `diagnosing-superpowers`); as que trazem scripts (`brainstorming`, `systematic-debugging`, `writing-skills`, `executing-plans`, `subagent-driven-development`) |
| `affaan-m/ECC` (antigo `everything-claude-code`) | MIT | `e482e57` | 26 pastas da stack TS/React/Node/Postgres: `api-design`, `architecture-decision-records`, `backend-patterns`, `coding-standards`, `context-budget`, `contract-first`, `database-migrations`, `deployment-patterns`, `design-system`, `docker-patterns`, `e2e-testing`, `error-handling`, `frontend-a11y`, `frontend-patterns`, `hexagonal-architecture`, `mcp-server-patterns`, `postgres-patterns`, `prisma-patterns`, `react-patterns`, `react-performance`, `react-testing`, `search-first`, `security-review`, `tdd-workflow`, `verification-loop`, `vite-patterns` | Recorte da stack do maior acervo de skills; LICENSE MIT na raiz do commit | 266.744 estrelas e 39.863 forks (API do GitHub, 2026-09-24) | `install.*`, `hooks/` e instaladores por CLI; pastas de skill com scripts; padrões de outras linguagens (Django, Laravel, Spring, Perl etc.) |
| `anthropics/skills` | Apache-2.0 | `3337550` | `skill-creator` (só `SKILL.md`, `LICENSE.txt`, `agents/`, `references/`) | Formato canônico e melhor guia de autoria de skills. Sem LICENSE na raiz: licença conferida em `skills/skill-creator/LICENSE.txt` do commit | 177.965 estrelas e 21.082 forks (API do GitHub, 2026-09-24) | `scripts/` e `eval-viewer/` (Python) do `skill-creator`; `docx`/`pdf`/`pptx`/`xlsx` (proprietárias); `doc-coauthoring` (sem `LICENSE.txt` próprio); as demais declaram `license: Complete terms in LICENSE.txt`, que a checagem de licença do sync recusa |
| `addyosmani/agent-skills` | MIT | `bcab6a1` | 18 skills: `api-and-interface-design`, `browser-testing-with-devtools`, `ci-cd-and-automation`, `code-review-and-quality`, `code-simplification`, `context-engineering`, `debugging-and-error-recovery`, `deprecation-and-migration`, `documentation-and-adrs`, `git-workflow-and-versioning`, `incremental-implementation`, `observability-and-instrumentation`, `performance-optimization`, `planning-and-task-breakdown`, `security-and-hardening`, `shipping-and-launch`, `source-driven-development`, `spec-driven-development` | Skills canônicas de engenharia, sem espelhos, que preenchem lacunas reais (API, migração, observabilidade, ship-gate, grounding em fonte); LICENSE MIT na raiz. Sai do estado "dormente até pin" da §1 | 98.863 estrelas e 10.388 forks (API do GitHub, 2026-09-24) | `hooks/` (o `SessionStart` injeta um `SKILL.md` inteiro e `simplify-ignore.sh` reescreve arquivos); `test-driven-development` e `frontend-ui-engineering` (ids já cobertos); `idea-refine` (traz script); `using-agent-skills` (meta) |
| Skills locais de Erick (`~/.claude/skills/`) | local | — | lidas in-place, como na §1 (`trust: local`) | Pedido de olhar também o que já está no computador: as boas continuam valendo por precedência local, sem redistribuição | — | Não entram em `fontes-curadas.json`: sem upstream nem commit para pinar; o `superpowers` local passa a ter pin pela linha acima |

**Ficaram de fora da lista inteira:** `openai/skills` (sem licença declarada, §1), `ComposioHQ/awesome-claude-skills`
(sem LICENSE e com cópias das proprietárias, ADR 0019) e `vercel-labs/skills` (instalador de registry aberto, que o
controle 1 do SkillGuard proíbe). O filtro é o mesmo para todas: licença livre conferida no commit pinado, só pastas de
skill sem scripts nem hooks, e o SkillGuard da sincronização decide liberada ou quarentena.

## 2. Ferramentas (integradas, não sincronizadas como skill)

| Fonte | Licença | Pin | Papel na ADE | Decisão |
| :--- | :--- | :--- | :--- | :--- |
| `pbakaus/impeccable` | detector Rust Apache-2.0 | **4.3.1** (plugin de marketplace instalado), pinado por `ENGINE_VERSION` do binário; divergência entre o `ENGINE_VERSION` medido e o pin é **falha do doctor** (fail-closed), nunca aviso, e leva o FQE a modo degradado — story com UI para em `awaiting_operator{reason:'fqe_unavailable'}` (E45) | Portão **D5** do Frontend Quality Engine: `impeccable detect --json` contra a URL renderizada. O modo de arquivo estático captura só um subconjunto (2 de 6 anti-patterns numa fixture) | **ADOPT** |
| `agentskills/agentskills` | Apache-2.0 | `<pin pendente>` | `skills-ref validate` = validação estrutural no ingest (controle 4 do SkillGuard). Spec normativa do Agent Skills, **sem releases versionadas**: o pin de conformidade é o commit | **ADOPT**, dormente até pin |
| `trailhq/Graft` | — | `<pin pendente>` | Grafo por worktree para o contexto recuperado do pack, com **fallback silencioso para `rg`** se ausente. ADR 0018: dependência **opcional**, ganho a medir no dogfood | **ADOPT opcional**, dormente até pin |
| `dmmulroy/anti-slop` | — | vendorizado | Regras Oxlint anti-slop → **gate por flag no Gate runner (C8)**, com nome próprio `gate:anti-slop` e só em projeto TS/JS, fora do FQE: não depende de render (architecture.md §11 E39). Vendorizar `src/` (não há pacote npm oficial); é a **taxonomia** de "low-evidence pattern" que se adota, não o ruleset fixo | **ADAPT** |
| `edonadei/caliper` | — | — | **Protocolo** de ablação pareada (`--ablate`, `compare`) + separação `activates:`/`expect:`/`assert:` para o harness doctor. Adota-se o protocolo, não o pacote Python: `claude plugin eval` já tem braço baseline | **ADOPT (protocolo)** |
| `reticlehq/reticle` | Apache-2.0 **+ FSL** | — | Predicado composto (`allOf`: net+element+signal+console) devolvendo `file:line` como evidência — bom padrão de asserção para o Checker web. Projeto jovem (1 commit relevante), licença não permissiva pura | **REFERENCE** |
| `alibaba/open-code-review` | — | — | Revisão híbrida determinística + LLM. Modo autônomo exige chave de LLM própria, o que quebra "sem chave de API"; modo Delegation deixa o LLM real ser o agente, tornando a ferramenta redundante com o Checker. ADR 0019 | **REJECT** |

---

## 3. Inspiração (não integra)

| Fonte | O que sobrevive | Decisão |
| :--- | :--- | :--- |
| `Q00/ouroboros` | Só o gate de ambiguidade com score numérico antes de gerar código — ideia já absorvida pela entrevista ≤5 perguntas do Intent Compiler. O resto é retórica de "Agent OS" | **REFERENCE** a ideia, **REJECT** o pacote |
| `JayPokale/Chisle` | O hook `PostToolUse` que faz scrub→elide→dedup na saída bruta antes de reentrar no contexto (absorvido pelo Tool Output Firewall, C11) e o hábito de publicar o **pior caso**, não só a média | **REFERENCE** |
| `stablyai/orca` | ~11k commits e ~9,9k PRs em 6 meses com zero revisão humana e ~30 portões de CI, contra ~23 % de CI verde do Gas City sem malha. É a evidência do princípio "o portão substitui o humano; o modelo não" | **REFERENCE** |
| `addyosmani/agent-skills` (`.claude/rules/skills-contributing.md`) | Regra anti-duplicação: antes de criar skill, buscar o catálogo e justificar a lacuna. Vira regra formal do processo de ingestão | **ADOPT como regra** |

**Orquestradores de terceiros: nenhum entra como dependência.** Vibe Kanban está sendo desligado
(2026-04-10); Crystal virou Nimbalyst e parou; Claude Squad é AGPL-3.0; RouteLLM abandonado desde
2024-08; Lost Pixel arquivado em 2026-04-22; Aider sem push desde 2026-05. BMAD e as demais metodologias
informam o método (`docs/research/landscape-dev-workflows.md`), não o código. ADR 0019.

---

## 4. Capacidades das CLIs

Corrige a seção equivalente da v1, que citava comparativos secundários com três erros de fato.
Fonte primária: `--help` dos binários instalados + smoke tests locais
(`docs/research/capabilities-claude-code.md`, `capabilities-codex.md`,
`capabilities-gemini-antigravity.md`, `addendum-gemini-family-viability.md`).

| Família | Binário | Versão | Papel na v1 | Fatos que mudaram desde a v1 do registro |
| :--- | :--- | :--- | :--- | :--- |
| `claude` | `claude` | 2.1.271 | Maker (Sonnet 5 default, Opus em `subsystem`+), Checker de portão, Intent Compiler, juiz visual | Tem `--advisor <model>` (executor barato + advisor forte: +2,7 pp SWE-bench com −11,9 % de custo), que **só entra na receita quando o modelo do advisor for observável em `modelUsage`** (sonda do doctor); até lá o Maker roda sem `--advisor` e a telemetria registra cada papel em `models[]` (E66), `--json-schema` inline, `--session-id` para pré-cunhar o id do journal, `--max-budget-usd`, `claude plugin eval`, `claude ultrareview --json`. **`--bare` quebra a autenticação por assinatura**: o isolamento correto é `--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Sandbox de SO **não roda em Windows nativo** |
| `codex` | `codex` | 0.154.0 | Checker de rodada (precisão), `$imagegen` | `codex exec --json --output-schema <arquivo> --sandbox read-only`. **`codex review` não tem `--json`/`--output-schema`**, e `codex exec review` aceita a flag e a ignora em silêncio: nunca usar. `--full-auto` **não existe** no parser 0.154.0. Piso de ~19,4k tokens de entrada. Não reporta USD (só tokens); janela de 272k em todos os modelos, nunca 1M. Receita de chamada curta: `--ignore-user-config --ignore-rules --ephemeral -c skills.max_context_tokens=0` + `AGENTS.md` ≤2 KB escrito pelo engine no worktree (architecture.md §11 E16). **`$imagegen` funciona headless** (gpt-image-2, sem chave de API), com stdin fechado e `--skip-git-repo-check` |
| **`agy`** (família Google) | `agy` | 1.2.x, auto-atualiza | **v0.x**: pesquisa com `--json-schema` e fallback de Checker | **O binário `antigravity` nunca existiu** — o nome é `agy` (`%LOCALAPPDATA%\agy\bin\agy.exe`), instalado e autenticado por assinatura. `agy` **serve modelos de outras famílias** (claude-sonnet, claude-opus-thinking, gpt-oss): Maker ≠ Checker tem de chavear por `model_id`, não por binário — a regra vale para **todo** papel da chamada, registrado em `models[]` da telemetria (E66). Desatendido é `--dangerously-skip-permissions` — `--approval-mode yolo` é do Gemini CLI, não do `agy` (architecture.md §7 Autonomia). Auto-atualização silenciosa é coberta por `capabilities_digest` no `runtime_stamp` (§11 E7). Anomalia de telemetria medida (`cache_read_tokens` > `total_tokens`). **Escreveu em `~/.gemini/antigravity-cli/scratch/` em vez do `--add-dir` pedido, sem aviso**: entra somente-leitura até o canário de isolamento passar |
| ~~`gemini`~~ | `gemini` | 0.59.0 instalado | **não é usado** | Só funciona com `GEMINI_API_KEY`/Vertex; o OAuth pessoal está morto nesta máquina, e o princípio "sem chave de API obrigatória" o exclui. A família Google da ADE é `agy`. O projeto gemini-cli segue vivo (0.60.0 em 2026-09-15) — a exclusão é de política, não de saúde do projeto |

**Descoberta de skills, por família** — o fato que decide a injeção em vez da instalação:

| Família | Lê `.agents/skills/`? | Teto de listagem | Consequência |
| :--- | :--- | :--- | :--- |
| Claude Code | **Não** (documentado explicitamente) | `description`+`when_to_use` truncados em **1.536 chars**; listing orçado em ~1 % do contexto | Precedência nativa é pessoal > projeto — a ADE **inverte** (repo > local > catálogo), com o degrau `repo` vazio na v1: skills de `<repo>/.claude/skills/` não entram no pack (E56). O engine ainda suprime o listing nativo na chamada despachada (`--safe-mode`, `--setting-sources`, `--plugin-dir` vazio), provado por contagem em `system/init` [hipótese até a sonda do doctor, §11 E15] |
| Codex | Sim (cwd → raiz, `$HOME/.agents/skills`, `/etc/codex/skills`) | **2 % da janela ou 8.000 chars**, com **omissão silenciosa** | Instalar em `.agents/skills/` é perder capacidade sem aviso. AGENTS.md trunca a 32 KiB: manter ≤ 8 KB |
| Gemini CLI | Sim, com precedência para `.agents/` | injeta name+description de todas as habilitadas | Irrelevante: `gemini` não é usado |

**Não existe diretório de skills comum às três CLIs.** Injetar o corpo como bloco do Context Pack é a
única via uniforme — decisão técnica, não só de segurança (`docs/specs/skill-fabric.md` §8).

---

## 5. Segurança do ecossistema (base dos 12 controles)

Snyk **ToxicSkills**, 2026-02-05: 3.984 skills escaneadas em ClawHub e skills.sh; **36,82 % (1.467) com
ao menos uma falha**, 13,4 % críticas; **76 payloads maliciosos confirmados** por revisão humana; **91 %
deles via prompt injection**; 8 ainda no ar na publicação. Barreira de entrada do ClawHub: um `SKILL.md`
e uma conta GitHub de uma semana.

Defesa com melhor número medido (arXiv 2606.01567v2): **sanitização estática em build time leva o ASR de
36,0 % para 7,2 %**, contra 12,9 % de interceptação em runtime e 26,6 % de defesa só por system prompt.
É por isso que o SkillGuard roda no `sync`, não no despacho.

Superfície medida nas fontes adotadas (scripts dentro do escopo de skill): ECC **124**, `anthropics/skills`
73 (fora de `skills/`), `addyosmani` **1** (15 linhas, `mkdir` + `echo`), ui-skills 0, FWC **0**. Nenhum
payload malicioso confirmado nestas fontes — o número mede **superfície de revisão**, não malícia.
