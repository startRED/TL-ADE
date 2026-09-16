# addyosmani/agent-skills — avaliação para o Skill Fabric da ADE

Data: 2026-09-16. Método: `gh api repos/addyosmani/agent-skills` (metadados) +
`gh api .../git/trees/HEAD?recursive=1` (árvore completa, 197 blobs) + leitura via
`raw.githubusercontent.com` do README, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE`,
`evals/README.md`, `evals/skill-impact.md`, `hooks/*.sh`, `hooks/hooks.json`,
`skills/idea-refine/scripts/idea-refine.sh` e 9 `SKILL.md` completos (frontmatter +
corpo), mais os outros 16 `SKILL.md` só por tamanho (bytes). Sem clone local — leitura
direta do blob no commit `HEAD` do momento da pesquisa.

---

## 1. Ficha do repositório

[verificado: `gh api repos/addyosmani/agent-skills`, 2026-09-16]

| Campo | Valor |
| :--- | :--- |
| Autor | Addy Osmani (`addyosmani`) — ex-Chrome/DX @ Google, autor de livros sobre engenharia front-end |
| Descrição do repo | "Production-grade engineering skills for AI coding agents." |
| Criado | 2026-02-15 |
| Último push | 2026-09-12T03:14:59Z (7 dias antes desta pesquisa) |
| Licença | **MIT**, raiz do repo, sem exceção por skill (diferente de `anthropics/skills`) |
| Estrelas | 94 994 |
| Forks | 10 075 |
| Watchers/subscribers | 497 |
| Issues abertas | 128 |
| Tamanho | 1 088 KB |

**Nota sobre popularidade** [inferido]: proporção estrelas:watchers (~191:1) é
incomum para um repo orgânico — não é prova de manipulação (Osmani tem audiência
real e grande), mas o número de estrelas por si só não deveria ser lido como sinal
de qualidade vetada; a avaliação abaixo é por conteúdo, não por popularidade.

---

## 2. Estrutura e o que é

[verificado: árvore `git/trees/HEAD?recursive=1`]

- **25 skills canônicas** em `skills/<nome>/SKILL.md` — um único caminho, sem
  espelhos reais. `.opencode/skills` é um **symlink** para `../skills/` (não duplica
  arquivos). Contraste direto com o achado #4 do `ref-skill-sources.md` sobre o ECC
  (903 arquivos brutos, 292 canônicos) — aqui a contagem bruta já é a real.
- **9 comandos de slash** (`/spec /plan /build /test /constraints /review /webperf
  /code-simplify /ship`) que mapeiam o ciclo de vida DEFINE→PLAN→BUILD→VERIFY→REVIEW→SHIP,
  replicados em `.claude/commands/` (Markdown), `.gemini/commands/` (TOML) e
  `commands/` (TOML genérico para Antigravity). `/build auto` roda o plano aprovado
  uma vez e implementa cada task com TDD + commit individual, pausando em falha —
  versão em miniatura do objetivo de loop autônomo da própria ADE.
- **4 subagentes** (`agents/code-reviewer.md`, `security-auditor.md`,
  `test-engineer.md`, `web-performance-auditor.md`).
- **7 checklists compartilhados** em `references/` de nível de repo (não por skill):
  `accessibility-checklist.md`, `definition-of-done.md`, `observability-checklist.md`,
  `orchestration-patterns.md`, `performance-checklist.md`, `security-checklist.md`,
  `testing-patterns.md`. Referenciados a partir das skills — mas o próprio README
  avisa que a instalação por skill individual via `npx skills add --skill <nome>`
  **não copia** `references/`, gap rastreado na issue #361 do próprio repo.
- **Hooks** (`hooks/`, ver §5) e **13 scripts de CI/lint** em `scripts/` (Node.js:
  `validate-skills.js`, `validate-commands.js`, `validate-versions.js`,
  `validate-reference-links.js`, `validate-artifact-paths.js`, `run-evals.js` +
  testes) — ferramentas de contribuição, não distribuídas ao contexto do agente.
- **Framework de evals em 3 camadas** (`evals/`, ver §3) — o achado mais distinto do
  repositório.

Multi-CLI declarado e com instruções concretas por produto: Claude Code (plugin
nativo), Cursor (`.cursor/skills/` + `.cursor/rules/*.mdc`), Gemini CLI (`gemini
skills install`), Windsurf, OpenCode (`.opencode/skills/`), GitHub Copilot
(`.github/copilot-instructions.md` + Copilot CLI plugin), Codex (`codex plugin
marketplace add` + `.codex-plugin/plugin.json`, lê `skills/` diretamente), e instalador
universal via `npx skills` (`vercel-labs/skills`, já classificado como
**REFERENCE, não instalador** no `ref-skill-sources.md` §2 — essa decisão da ADE
continua de pé, o repo só demonstra o padrão na prática).

---

## 3. Conformidade com o padrão Agent Skills

[verificado: leitura de 9 `SKILL.md` completos — `using-agent-skills`,
`code-review-and-quality`, `test-driven-development`, `debugging-and-error-recovery`,
`frontend-ui-engineering`, `security-and-hardening`, `planning-and-task-breakdown`,
`code-simplification`, `idea-refine`]

- **Frontmatter**: todas as 9 amostras usam **só `name` + `description`**. Nenhuma
  usa `allowed-tools`, `metadata`, `license` por skill ou `compatibility` — o
  formato é válido, mas não usa a riqueza opcional do spec (contraste com
  `ayghri/i-have-adhd`, que usa `metadata: {tags, category}` e
  `disable-model-invocation`, já **ADOTADO** no `ref-skill-sources.md`).
- **Descrições**: acionáveis, todas no padrão "Verbo. Use when X, Y, Z" com
  gatilhos concretos (ex.: `security-and-hardening` lista 5 cenários de uso
  distintos). **Nenhuma tem gate negativo explícito no texto** ("não use quando…") —
  diferente de `UditAkhourii/adhd`, já registrada como o modelo de descrição
  acionável no `ref-skill-sources.md` §2. O gate negativo aqui vive **fora** da
  skill, nos casos `negative` do arquivo de eval correspondente (ver §4) — put
  de forma testável, mas não visível para o classificador de seleção em tempo real.
- **Progressive disclosure real**: só 2 das 25 têm subpastas —
  `constraint-driven-development/references/` e `idea-refine/scripts/`. As
  outras 23 são monolíticas (todo o corpo no `SKILL.md`), incluindo as que mais
  precisariam de divisão (`security-and-hardening`, 28 KB).
- **Tamanho médio medido** (25/25 arquivos, bytes/4 ≈ tokens):

  | Métrica | Valor |
  | :--- | ---: |
  | Total | 353 572 bytes / 25 skills |
  | Médio | 14 142 bytes ≈ **3 535 tokens** |
  | Menor | `idea-refine`, 8 111 bytes ≈ 2 028 tok |
  | Maior | `security-and-hardening`, 27 993 bytes ≈ **6 998 tok** |

  Acima do teto recomendado pelo spec (<5 000 tokens/corpo, "under 500 lines"):
  `security-and-hardening` (~7,0k), `performance-optimization` (21 717 B ≈ 5,4k),
  `constraint-driven-development` (21 008 B ≈ 5,3k), `code-review-and-quality`
  (20 555 B ≈ 5,1k). Quatro das 25 (16%) estourariam o teto de corpo já adotado
  pela ADE (`ref-skill-sources.md` §5: "rejeitar/avisar acima de ~5k tokens"). Nenhuma
  usa `references/` para descarregar esse excesso apesar de o spec recomendar
  exatamente isso — é o oposto do padrão de `anthropics/skills` (progressive
  disclosure real em 6/19) e de `ibelick/ui-skills`.

---

## 4. O que é distinto — vale absorver além das skills em si

Isto é o achado mais forte da pesquisa: o valor real do repositório para a ADE não
está no conteúdo das 25 skills (majoritariamente redundante, ver §6), mas em **três
peças de engenharia de processo** que nenhuma outra fonte do catálogo tem.

1. **Framework de evals em 3 camadas** (`evals/README.md`, 8 165 bytes) —
   candidato direto a método para a hipótese pendente do Skill Fabric
   (`ref-skill-sources.md`: "recall@8 ≥ 0,85 e precision@3 ≥ 0,75 na seleção de
   skills — fixtures de pedidos com skills esperadas"):
   - **Tier 1 (estrutural, CI, grátis)**: frontmatter, nomenclatura, seções
     obrigatórias, paridade de comandos — `validate-skills.js`.
   - **Tier 2 (trigger & roteamento, CI, grátis)**: TF-IDF stemizado sobre as
     descrições; cada `evals/cases/<skill>.json` declara prompts `positive`
     (devem rankear top-k, default 3) e `negative` (pertencem a outra skill,
     declarada em `owner` — o runner garante que a dona supera esta skill, não só
     que esta não vence vácuo). Métrica publicada: **trigger rank-1 rate**, piso de
     CI em 95%. **Detector de colisão**: erro em ≥75% de similaridade par-a-par
     entre descrições, aviso em ≥50%. Isto é exatamente o portão que falta para a
     ADE não deixar duas skills do catálogo convergirem silenciosamente.
   - **Tier 3 (comportamental, sob demanda, custa tokens)**: roda o caso via
     `claude -p --output-format stream-json --verbose` num repo git descartável,
     materializa fixtures de `evals/fixtures/<skill>/`, e um grader LLM confere
     `expectations[]` (schema herdado do `skill-creator` v2 da Anthropic, com um
     campo `kind` opcional: `execution` vs `dialogue`). Inclui **casos de pressão**
     (prazo, custo afundado, autoridade) para skills de disciplina — testa se o
     workflow segura quando o prompt argumenta para pular a etapa.
   - **`evals/skill-impact.md`**: ledger append-only de mudanças de skill
     **rejeitadas** por evidência de eval, para contribuintes não re-propor a
     mesma ideia. Padrão de governança barato e direto — a ADE pode adotar o mesmo
     ledger para o processo de sync do catálogo (`docs/catalog-sources.md`).

2. **`hooks/sdd-cache-{pre,post}.sh`** — cache HTTP para `WebFetch` chaveado por
   URL, com revalidação via `ETag`/`If-None-Match` e `Last-Modified`/
   `If-Modified-Since` (nunca serve sem validador do servidor; sem TTL solto).
   No hit, sai com código 2 e escreve o corpo cacheado em stderr para o Claude
   Code entregar ao agente no lugar do resultado real do `WebFetch` — incluindo o
   prompt original da consulta anterior, para o agente decidir se ainda se aplica.
   Padrão diretamente relevante para o "Tool Output Firewall"/telemetria de custo
   já mapeado em `landscape-context-observability.md` — pesquisa repetida no
   mesmo domínio dentro de uma sessão longa é desperdício medido em outras partes
   da pesquisa da ADE (achado #27 do README: piso de custo do Codex headless).

3. **`.claude/rules/skills-contributing.md`** — regra anti-duplicação: antes de
   criar `skills/<nome>/` ou reescrever uma existente, buscar o catálogo e PRs
   abertos e justificar a lacuna; preferir estender uma skill existente a criar
   quase-duplicata. É a mesma disciplina que o `ref-skill-sources.md` já aplica
   manualmente (§1, achado 4: ECC tinha 903 arquivos por falta dessa disciplina) —
   vale portar como regra formal do processo de ingestão do catálogo da ADE, não
   só como convenção implícita.

4. **Mapeamento do ciclo de vida em comandos** (`/spec → /plan → /build → /test →
   /constraints → /review → /webperf → /code-simplify → /ship`) é uma
   nomenclatura de referência limpa para a UX do fluxo Intent Compiler → Maker →
   Checker → Ship da ADE — vale como inspiração de rotulagem, não como
   componente a importar.

`hooks/simplify-ignore.sh` (proteção de blocos de código contra leitura/edição
durante a sessão, restaurados no `Stop`) é engenhoso mas entra em risco, não em
ideia a absorver — ver §5.

---

## 5. Riscos

- **Licença**: baixo. MIT na raiz, sem exceção por skill — ao contrário de
  `anthropics/skills` (4 skills proprietárias) e de `ComposioHQ/awesome-claude-skills`
  (sem LICENSE nenhuma), este repositório pode ser vendorizado inteiro sem
  bloqueio legal. [verificado]
- **Scripts dentro de `skills/`**: baixo. Só 1 script em todo o catálogo de
  skills — `idea-refine/scripts/idea-refine.sh`, 15 linhas, `mkdir -p docs/ideas`
  e um `echo` de JSON de status. Sem rede, sem escrita fora do diretório
  declarado, sem risco material. [verificado, lido na íntegra]
- **Scripts fora de `skills/` (execução automática)**: **médio-alto**, e é o
  risco real do repositório. `hooks/hooks.json` registra um hook `SessionStart`
  que roda `hooks/session-start.sh` **automaticamente ao instalar o plugin**,
  injetando o `SKILL.md` inteiro de `using-agent-skills` como `additionalContext`
  em toda sessão nova — um plugin de terceiro escrevendo texto extenso no
  contexto sem confirmação por sessão. `sdd-cache-pre.sh`/`post.sh` interceptam
  todo `WebFetch` (`PreToolUse`/`PostToolUse`); `simplify-ignore.sh` intercepta
  `Read`/`Edit`/`Write`/`Stop` e **reescreve o arquivo no disco durante a
  sessão** (substitui blocos marcados por placeholders `BLOCK_<hash>` na leitura,
  restaura no `Stop`) — um hook de terceiro mutando bytes de arquivos do usuário
  como efeito colateral de `Read` é um padrão poderoso mas fora do que a ADE já
  decidiu tolerar de fontes externas. Nenhum desses scripts foi encontrado
  malicioso na leitura (lógica é defensiva, com `command -v` guards e
  `set -euo pipefail`), mas a superfície de execução automática é real.
  **Decisão recomendada, consistente com a política já adotada para o ECC**:
  ingerir só `skills/`; nunca `hooks/`, nunca `scripts/`, nunca instalar via
  plugin marketplace.
- **Prompt injection**: baixo-médio, pelo mesmo vetor do `SessionStart` acima —
  não é conteúdo malicioso, mas estabelece o padrão de auto-injeção de bloco
  grande no prompt sem gate por sessão, o exato tipo de superfície que a decisão
  já tomada pela ADE de sanitização estática em build time (achado #34 do README
  da rodada) deveria cobrir antes de qualquer skill ou hook deste repo entrar no
  pipeline de sync.
- **Sobreposição**: alta em volume. Ver tabela §6 — metade das 25 skills duplica
  terreno já coberto por skills ativas nesta própria sessão
  (`superpowers:test-driven-development`, `superpowers:systematic-debugging`,
  `superpowers:writing-plans`, `everything-claude-code:frontend-design`,
  `everything-claude-code:security-review`) ou por decisões já tomadas no
  catálogo (`ibelick/ui-skills` ADOTADO para UI, `/simplify` nativo do harness).

---

## 6. Tabela das 25 skills

Tamanho = bytes do `SKILL.md` bruto / 1024. "Refs/Scripts" marca subpastas
`references/`/`scripts/` (só 2 das 25 têm). Domínio e veredito são deste
pesquisador; as 9 marcadas ⚑ foram lidas na íntegra (frontmatter + corpo), as
demais só por tamanho + nome + posição no README — vereditos dessas 16 são
**[inferido]** a partir do título e do checklist de referência que citam.

| Skill | KB | Refs/Scripts | Domínio | Veredito | Motivo |
| :--- | ---: | :--- | :--- | :--- | :--- |
| using-agent-skills ⚑ | 10,2 | — | meta/roteamento | **REFERENCE** | Meta-skill de descoberta é útil como *design* (flowchart), mas a ADE já resolve seleção via Skill Fabric, não via meta-skill textual |
| api-and-interface-design | 14,5 | — | design de API | **ADAPT** | Domínio sem cobertura direta no catálogo atual; não lido em profundidade |
| browser-testing-with-devtools | 14,2 | — | testes/DevTools | **REFERENCE** | Sobrepõe `e2e-testing`/`browser-qa` já no ECC |
| ci-cd-and-automation | 11,1 | — | CI/CD | **REFERENCE** | Sobrepõe `deployment-patterns`/`github-ops` do ECC |
| code-review-and-quality ⚑ | 20,1 | — | revisão de código | **REFERENCE** | Sobrepõe `/code-review` nativo + skill `code-review` do ECC + `superpowers:requesting/receiving-code-review` |
| code-simplification ⚑ | 13,2 | — | simplificação | **REJECT** | Duplica `/simplify` nativo do harness e a filosofia Ponytail já ativa nesta instalação |
| constraint-driven-development | 20,5 | referências | qualidade/gates | **ADOPT** | "Decidir a barra uma vez, aplicar sempre" sem equivalente direto; único com `references/` real |
| context-engineering | 15,1 | — | engenharia de contexto | **REFERENCE** | Sobrepõe o próprio Context Pack / `context-budget` da ADE — ler para comparar, não importar |
| debugging-and-error-recovery ⚑ | 10,7 | — | debugging | **REJECT** | Duplica `superpowers:systematic-debugging`, já a "obra" de referência do catálogo |
| deprecation-and-migration | 12,3 | — | migração | **ADOPT** | Domínio sem cobertura direta |
| documentation-and-adrs | 9,6 | — | ADRs | **REFERENCE** | Sobrepõe `architecture-decision-records` do ECC |
| doubt-driven-development | 16,3 | — | stress-test de planos | **ADOPT** | Framing distinto (questionar hipóteses antes de comprometer plano); sem equivalente |
| frontend-ui-engineering ⚑ | 10,5 | — | UI/frontend | **REJECT** | Duplica `frontend-design` (skill de alto investimento já ativa) e `ibelick/ui-skills` (já ADOTADO) |
| git-workflow-and-versioning | 13,8 | — | git | **REFERENCE** | Sobrepõe `git-workflow` do ECC |
| idea-refine ⚑ | 7,9 | script (mkdir) | ideação | **ADOPT** | Divergente→convergente com gatilhos claros; script trivial e seguro |
| incremental-implementation | 9,4 | — | execução incremental | **REFERENCE** | Sobrepõe TDD + planning já cobertos |
| interview-me | 14,0 | — | levantamento de requisitos | **ADOPT** | "Uma pergunta por vez" ataca o gap de instruction-following já identificado na pesquisa (Intent Compiler) |
| observability-and-instrumentation | 13,6 | — | observabilidade | **ADOPT** | Domínio sem cobertura direta |
| performance-optimization | 21,2 | — | performance | **REFERENCE** | Sobrepõe `performance-optimizer` do ECC; corpo grande (~5,4k tok) |
| planning-and-task-breakdown ⚑ | 10,3 | — | planejamento | **REJECT** | Duplica `superpowers:writing-plans` |
| security-and-hardening ⚑ | 27,3 | — | segurança | **REFERENCE** | Conteúdo bom (5 gatilhos distintos, cobre OWASP + supply chain + privacidade) mas maior arquivo do repo (~7k tok, estoura teto) e duplica `security-review`/`security-scan` do ECC |
| shipping-and-launch | 11,1 | — | ship/launch | **ADOPT** | Etapa de ciclo de vida sem skill equivalente no catálogo |
| source-driven-development | 9,8 | — | grounding em fonte upstream | **ADOPT** | Framing distinto (ler o framework-fonte em vez de adivinhar API); sem equivalente |
| spec-driven-development | 12,3 | — | spec-driven | **REFERENCE** | Território já coberto por `landscape-dev-workflows.md` (BMAD, Spec Kit) |
| test-driven-development ⚑ | 16,1 | — | TDD | **REJECT** | Duplica `superpowers:test-driven-development` |

Contagem: **7 ADOPT**, **4 REJECT**, **12 REFERENCE**, **2 ADAPT** (sem contar a
skill que se sobrepõe a si mesma na meta-categoria). Não há nenhuma skill fora do
padrão — todas passam Tier 1 estrutural pelo próprio CI do repo.

---

## 7. Decisão final — linha da matriz do catálogo

| Projeto | Problema resolvido | Ideias úteis | Custo | Risco | Compatibilidade | Decisão |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `addyosmani/agent-skills` | Skills de ciclo de vida de engenharia (define→ship) com processo de evals formal; ~7 de 25 skills preenchem lacunas reais do catálogo (API design, migração, ideação, requisitos, observabilidade, ship-gate, grounding em fonte) | **Framework de evals 3-camadas** (`evals/`) como método para validar recall@8/precision@3 do Skill Fabric; ledger `skill-impact.md` como padrão de governança do catálogo; hook de cache HTTP por validador (`sdd-cache`) como referência para custo de `WebFetch` repetido; regra anti-duplicação (`skills-contributing.md`) para o processo de ingestão | Índice: 25 skills ≈ 3,5k tok médio/corpo (4 das 25 excedem 5k); zero mirrors, então índice bruto = índice útil (diferente do ECC) | Médio: `hooks/` executa automaticamente se instalado como plugin (SessionStart injeta contexto; Read/Edit/Write interceptados por `simplify-ignore.sh`, que reescreve arquivos no disco); scripts dentro de `skills/` são triviais (1 script, mkdir) | MIT limpo (raiz, sem exceção por skill); multi-CLI declarado e testado: Claude Code, Cursor, Gemini CLI, Windsurf, OpenCode, Copilot, Codex | **ADAPT** — sincronizar só `skills/` (nunca `hooks/`, nunca `scripts/` de contribuinte, nunca instalar como plugin); adotar o framework de evals e o ledger de rejeição como método, não como dependência de código |

### Linha pronta para `docs/catalog-sources.md`

Formato do arquivo existente (`## Fontes de skills (sincronizadas)`):

```
| `addyosmani/agent-skills` | 95k | 25 skills de ciclo de vida (spec→ship); framework de evals 3-camadas adotado como método de validação do Skill Fabric; ingerir só `skills/`, nunca `hooks/` (execução automática) |
```

---

## Resumo (8 linhas)

`addyosmani/agent-skills` (Addy Osmani, MIT, 95k★, push 2026-09-12): 25 skills
canônicas (sem mirrors reais), média 3,5k tok/corpo, 4 delas acima do teto de 5k
já adotado pela ADE. Frontmatter é `name`+`description` puro, sem `metadata`/
`allowed-tools`/gate negativo no texto — mas as descrições são acionáveis e o
gate negativo existe testável em `evals/cases/*.json`. O achado real não são as
skills (metade duplica `superpowers`/ECC/`ui-skills` já adotados: TDD, debugging,
planning, frontend, code-review) — é o **framework de evals em 3 camadas**
(estrutural/roteamento TF-IDF com rank-1 e detector de colisão/comportamental via
`claude -p`), diretamente aplicável à hipótese pendente de recall@8/precision@3
do Skill Fabric, mais o ledger `skill-impact.md` e a regra anti-duplicação.
Risco real: `hooks/` roda automaticamente se instalado como plugin (SessionStart
injeta contexto; um hook reescreve arquivos no disco em `Read`/`Edit`) — ingerir
só `skills/`. **Decisão: ADAPT.** Arquivo completo em
`docs/research/ref-addyosmani-agent-skills.md`.
