# Addendum — âncora do Frontend Quality Engine, dependências reais, `$imagegen` headless

Pesquisa dedicada a fechar a §10 da spec v2. Resolve a contradição factual entre
`method-inheritance.md` §4 (trata Impeccable como [hipótese], não localizada) e
`landscape-evals-visual.md` §3.2/§4.1 (leu Impeccable 4.3.1 instalada e construiu a pipeline sobre
ela). Verificação feita nesta rodada: inspeção direta do diretório, `gh api` no repositório upstream,
execução real do binário via `npx` contra fixture no scratchpad, leitura de `registry.rs` (fonte de
verdade das regras, não `types.rs`), e teste dedicado de `$imagegen` em `codex exec --json` headless.

---

## 1. Veredito de âncora

**`method-inheritance.md` §4 está desatualizado, não errado por raciocínio: a skill existe e está
instalada.** Local exato: `C:\Users\Erick\.claude\plugins\marketplaces\impeccable\`, plugin Claude
Code versão `4.3.1` [verificado: `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`,
`.claude/skills/impeccable/SKILL.md` frontmatter `version: 4.3.1`]. `landscape-evals-visual.md`
acertou o fato base e errou 3 IDs de regra citados por nome (ver §3).

**Veredito: Impeccable ancora o Frontend Quality Engine da ADE, mas como *dependência externa
versionada*, não como "skill local" — a distinção que nenhuma das duas pesquisas anteriores testou.**
Justificativa:

1. **É um binário Rust real, distribuível fora do Claude Code.** `cli/bin/cli.js` é um shim npm que
   resolve, nesta ordem, `$IMPECCABLE_BIN` → pacote `@impeccable/cli-<os>-<arch>` opcional → cache
   `~/.impeccable/bin/<versão>/` → download de
   `https://github.com/pbakaus/impeccable/releases/download/engine-v<versão>/impeccable-<os>-<arch>`
   com verificação SHA-256 obrigatória antes de gravar (recusa "fail closed" se o `.sha256` não
   existir ou não bater) [verificado: `cli/bin/cli.js`, lido linha a linha]. Isso não é uma skill
   Markdown lida por um agente — é uma cadeia de instalação e verificação de binário padrão de
   qualquer CLI Rust distribuída por npm.
2. **Rodei a instalação independente e o `detect --json` fora de qualquer sessão de agente.**
   `npx --yes impeccable@4.1.0 --version` baixou o binário Windows-x64 e respondeu `4.1.0`, exit 0.
   `npx --yes impeccable@4.1.0 detect --json bad.html` contra uma fixture HTML/CSS escrita no
   scratchpad (`nested-cards`, `background-clip:text`, `letter-spacing:-0.08em`, `box-shadow` com
   blur zero, `outline:none` sem `:focus-visible`, classe `eyebrow`) devolveu, **saída literal**:

   ```json
   [
     {
       "antipattern": "low-contrast",
       "name": "Low contrast text",
       "description": "Text does not meet WCAG AA contrast requirements (4.5:1 for body, 3:1 for large text). Increase the contrast between text and background.",
       "severity": "warning",
       "category": "quality",
       "file": "...\\bad.html",
       "line": 0,
       "snippet": "1.0:1 (need 4.5:1) — text #000000 on #000000"
     },
     {
       "antipattern": "cramped-padding",
       "name": "Cramped padding",
       "description": "Text is too close to the edge of its container. ...",
       "severity": "warning",
       "category": "quality",
       "file": "...\\bad.html",
       "line": 0,
       "snippet": "<div> \"card\": children flush against bg on all sides (no inset)"
     }
   ]
   ```
   **Exit code: 2** (achados; 0 = limpo, 1 = falha operacional, 2 = achados — confirmado em
   `detect --help`) [verificado: execução direta, 2026-09-16]. Achado relevante para a spec: em modo
   estático de arquivo (não URL/Puppeteer), o detector **não** pegou `background-clip:text`,
   `nested-cards`, `kicker`/`eyebrow`, `box-shadow` sem blur nem `outline:none` — regras que existem
   no registry (ver §3) mas aparentemente exigem o modo de renderização de navegador (`checkColors`,
   `checkBorders` etc. em `types.rs` recebem valores computados de estilo, não CSS estático bruto).
   **Implicação para a §10 da spec:** o portão D5 proposto por `landscape-evals-visual.md` só cobre
   o conjunto completo de regras quando o alvo é uma **URL renderizada** (Playwright/Puppeteer), não
   quando aponta para arquivos-fonte crus. A pipeline da §10 já captura via Playwright antes de
   avaliar — então `impeccable detect` deve rodar contra a **URL servida** (`visual.url`), não contra
   os arquivos do diff, para ativar o ruleset completo. [inferido: comportamento observado, não
   documentado explicitamente na skill]
3. **Custo/tempo do passe:** ~2,0–2,5s de parede por invocação via `npx` contra 1 arquivo pequeno
   (inclui overhead do `npx` resolvendo o pacote — não isolei o tempo do binário puro) [verificado:
   `time`, 2026-09-16, máquina do Erick, binário já em cache local após o primeiro download]. Para o
   portão D5 da §10, isso é desprezível frente ao custo de build+serve+screenshot+juiz multimodal
   (~US$ 0,04–0,18/rodada, `landscape-evals-visual.md` §3.5).
4. **Licença: Apache-2.0 uniforme em todo o workspace Rust**, `license.workspace = true` herdado de
   `[workspace.package]` em todos os 16 crates [verificado: `Cargo.toml` raiz +
   `crates/*/Cargo.toml`, grep completo]. Única exceção documentada: `NOTICE.md` registra que
   `skill/reference/ios.md` e `android.md` são derivados de `ehmo/platform-design-skills` (MIT)
   [verificado: `NOTICE.md`]. Não há dependência viral (GPL) nem cláusula que impeça vendorização ou
   uso comercial — Apache-2.0 permite ambos.

### O que isso significa para "ADE local e universal"

O plugin de marketplace do Claude Code (`~/.claude/plugins/marketplaces/impeccable/`) é **apenas uma
forma de instalação entre outras** — ele empacota o skill Markdown + o mesmo CLI. O CLI em si:

- instala via `npm install -g impeccable` ou `npx impeccable` em qualquer máquina com Node ≥ 22.18
  (requisito do `package.json` `engines`), **sem Claude Code**;
- tem pacotes de binário nativo para darwin-arm64/x64, linux-x64/arm64, windows-x64
  [verificado: `cli/platform-packages/*/package.json`] — cobre as três famílias de SO que a ADE
  precisa suportar como "universal";
- versiona em **três esquemas independentes que não coincidem**: pacote npm `4.1.0` (mais recente
  publicado no registro nesta data — `npm view impeccable versions` não lista `4.3.1`), plugin
  Claude Code `4.3.1`, engine Rust `0.1.5` (`ENGINE_VERSION`) [verificado: `npm view`, `.claude-
  plugin/marketplace.json`, arquivo `ENGINE_VERSION`]. **A versão do plugin instalada na máquina do
  Erick (`4.3.1`) está à frente do que o `npm view` mostra como último publicado (`4.1.0`)** — ou o
  plugin do marketplace segue um canal de release diferente do pacote npm público, ou há um
  descompasso de propagação. `npx impeccable@4.3.1` falhou com `ETARGET` (versão inexistente no
  registro npm) [verificado: execução direta]. **Isso é o risco central para "local e universal":**
  pinar `impeccable@4.3.1` no manifesto da ADE não é hoje reproduzível via npm público — só via o
  plugin do Claude Code ou baixando o binário direto do release do GitHub
  (`engine-v0.1.5`, verificável) por fora do npm.

**Recomendação:** tratar Impeccable como **dependência externa pinada por *engine* version
(`ENGINE_VERSION`, hoje `0.1.5`), não por versão de pacote npm nem de plugin**, instalada pelo
launcher `cli/bin/cli.js` (que já faz cache + verificação de hash) e invocada só via `npx
impeccable@<engine-pin> detect --json <url>`. Vendorizar o binário não é necessário — o mecanismo de
cache com verificação de hash já dá reprodutibilidade suficiente para uma ADE local; o risco real é
a **ADE noutra máquina sem Node ≥ 22.18** ou sem acesso de rede ao GitHub Releases na primeira
execução (falha fechada nesse caso, por design do shim — não é degradação silenciosa). Não depender
dele é possível (ver §2) mas custa reimplementar ~61 regras determinísticas Apache-2.0 já escritas e
testadas — não vale a pena para a v1. [inferido]

---

## 2. Matriz das três skills

| Eixo | Impeccable 4.3.1 (Rust CLI + skill) | `tl-impeccable-design` (skill local, `audit_ui.py`) | `frontend-design` (plugin oficial Anthropic) |
| :--- | :--- | :--- | :--- |
| **Gera direção estética** | Sim — 24 comandos (`shape`, `bolder`, `colorize`, `delight`, `overdrive`...), 4 "modos" de superfície (Persuade/Operate/Read/Experience), `PRODUCT.md`+`DESIGN.md` como camadas de contexto durável [verificado: `SKILL.md`] | Não — não tem comando de geração; é puramente normativa/auditora [verificado: `SKILL.md`, sem seção de geração] | Sim — processo de 2 passagens (brainstorm de token system: Color/Type/Layout/Signature → crítica contra o brief → build), calibrado explicitamente contra os 3 clichês visuais de 2026 (cream+serif+terracota; near-black+acid accent; broadsheet hairline) [verificado: `SKILL.md`] |
| **Impõe guardrail (bans/tokens)** | Sim, e é o mais extenso: 61 regras registradas (`registry.rs`), categorias `slop`/`quality`, hook `PostToolUse` (tier imediato) + `Stop` (passe profundo) por edição [verificado: `registry.rs`, `reference/hooks.md`] | Sim — tabela fixa de anti-patterns proibidos, tokens obrigatórios (contraste, espaçamento base-4px, `tabular-nums`), 5 estados obrigatórios [verificado: `SKILL.md`] | Parcial — lista qualitativa de bans em prosa (numbered markers, template hero) mas **nenhum mecanismo de imposição automática**; depende inteiramente do juízo do modelo que a está seguindo [verificado: `SKILL.md`, sem menção a detector/CLI] |
| **Audita deterministicamente** | Sim — `impeccable detect --json`, engine Rust, testado nesta pesquisa (§1.2); ~61 regras; exit code semântico (0/1/2) [verificado: execução direta] | Sim — `audit_ui.py`, Python puro stdlib (`html.parser`+regex), fail-closed (exit 1 em qualquer achado ou erro operacional), cobre um subconjunto pequeno e explícito: `background-clip:text`, `letter-spacing`, `box-shadow` blur zero, `outline` sem `:focus-visible`, cor pura `#000`/`#fff`, cards aninhados, classe `eyebrow`/`kicker` [verificado: leitura completa do script, 237 linhas] | Não — nenhum script determinístico; a skill não contém CLI nem lint [verificado: ausência confirmada no diretório do plugin] |
| **Serve de rubrica ao juiz** | Sim, de forma explícita e calibrada: `reference/critique.md` já define o protocolo dual-agent (Assessment A design review + Assessment B detector/browser), a regra "detector output... still anchors judgment" (usada por `landscape-evals-visual.md` §3.6.4), e escala Nielsen 0-4 ×10 heurísticas com banda calibrada ("Most real interfaces score 20-32 out of 40") [verificado: `reference/critique.md`, `reference/audit.md`] | Parcial — dá um checklist de verificação para o Checker (5 itens), mas não uma rubrica numérica nem protocolo de avaliação multimodal [verificado: `SKILL.md` §5] | Não — a skill é só de geração; não define rubrica de avaliação [verificado: ausência confirmada] |

**Resolvendo a pergunta em aberto de `method-inheritance.md`: Impeccable não é redundante com
`frontend-design`, e não o substitui por completo — as duas cobrem a mesma etapa (direção estética,
passo 1 da §10) com filosofias diferentes e sobreposição real, mas Impeccable adiciona duas camadas
que `frontend-design` não tem: guardrail mecânico e rubrica formal de avaliação.** `frontend-design`
é mais enxuto (1 arquivo, sem CLI, sem estado de projeto) e mais focado em originalidade/anti-
genericidade de marca; Impeccable é um sistema completo (skill + CLI + hooks + `PRODUCT.md`/
`DESIGN.md` persistentes + protocolo de crítica dual-agent formalizado). Para a §10 da ADE, que já
separa "direção" (passo 1, Claude) de "gate mecânico" (D1-D7) de "avaliação por rubrica" (passo 4):
**Impeccable cobre as três etapas sozinho; `frontend-design` cobre só a primeira; `tl-impeccable-
design` cobre só a segunda (com um auditor mais pobre que o de Impeccable, mas sem depender de
binário externo).**

**Recomendação de composição para a ADE (não redundante, complementar):**
- **Geração (passo 1):** Impeccable `shape`/`craft` OU `frontend-design`, à escolha do operador via
  config do projeto — ambos produzem token system + brief; não rodar os dois no mesmo passo (custo
  duplicado, nenhum ganho — cobrem o mesmo espaço de decisão).
- **Guardrail mecânico determinístico (D5 da §10):** Impeccable `detect --json` — é estritamente mais
  coberto que `audit_ui.py` (61 regras Rust computadas sobre estilo renderizado vs. ~7 regras Python
  sobre CSS estático) e já está integrado ao fluxo de hooks que a ADE precisaria construir do zero
  para `tl-impeccable-design`.
- **`audit_ui.py` como fallback fail-closed:** mantém valor **só** no cenário em que Impeccable não
  pode ser baixado (offline na primeira execução, sem Node, ambiente air-gapped) — é puro Python
  stdlib, zero dependência de rede. Vale portar como *fallback*, não como âncora primária.
- **Rubrica do juiz (passo 4):** herdar a estrutura de `reference/critique.md` do Impeccable (dual-
  agent, escala calibrada, regra de anti-anchoring) em vez de inventar uma rubrica do zero — ver §3.

---

## 3. Reconciliação dos números propostos por `landscape-evals-visual.md`

| Proposta | Fonte normativa citada | Status após verificação nesta rodada |
| :--- | :--- | :--- |
| **Teto de 2 rodadas** (vs. 4 da spec) | Citação literal do `SKILL.md` do Impeccable: *"Verify in bounded passes, not a loop... Build fully, inspect once with a batched round..., fix everything... in one batch, confirm with at most one more round, and stop polishing."* | **Sobrevive, citação exata confirmada** [verificado: `SKILL.md` linha 9, texto idêntico ao citado]. 1 rodada de inspeção + no máximo 1 de confirmação = 2 rodadas totais. `visual.max_rounds: 2` é a leitura correta da fonte. |
| **Corte final 7,5** (vs. ≥8 da spec) | Paráfrase da calibração do Impeccable: *"Be honest with scores. A 4 means genuinely excellent. Most real interfaces score 20-32 out of 40"* | **Sobrevive como direção, número específico é [inferido].** Confirmei a frase-fonte em `reference/audit.md`/`critique.md`: a banda 20-32/40 normalizada é 5,0-8,0/10 — então um corte de 8/10 (=32/40) já está no **topo** da banda que o Impeccable chama de "interfaces reais boas", não acima dela como `landscape-evals-visual.md` alega ("um corte de 8 em todos os critérios põe a barra acima do que interface humana de produção atinge" é um exagero: 8 = teto da banda, não acima dela). O corte específico "**7,5**" não está em nenhuma fonte primária — é uma escolha de compromisso do pesquisador anterior, não uma medição. **Recomendação:** manter o espírito (não exigir 8 em *todos* os 7 critérios da spec, que é mais rígido que a fonte), mas fixar o corte final como **7,0–7,5 com faixa a validar empiricamente nos primeiros lotes reais da ADE (dogfooding, não literatura)** — nem a spec nem a pesquisa anterior têm medição própria aqui. |
| **Rubrica ponderada de 6 critérios** (vs. 7 da spec, todos peso igual) | Não citada a uma fonte normativa específica — é uma síntese do pesquisador combinando Nielsen heuristics do Impeccable com a lista da spec | **[inferido, sem base primária direta].** O Impeccable usa **10 heurísticas de Nielsen**, não 6 critérios pesados [verificado: `reference/critique.md` menciona "Present the Nielsen's 10 heuristics scores as a table"]. A tabela de 6 critérios com pesos 3,0/2,0/2,0/1,5/1,0/0,5 de `landscape-evals-visual.md` §3.3 não reproduz a estrutura real do Impeccable — é uma rubrica nova, plausível e bem fundamentada nos princípios (peso alto em "especificidade", que é de fato o critério que nenhum detector cobre), mas não é o que a fonte normativa faz. **Recomendação:** usar 6-7 critérios *é* razoável para a ADE (10 heurísticas de Nielsen é overkill para um gate automatizado — a skill do Impeccable usa isso num *dual-agent critique* mais caro, não no gate rápido), mas rotular a rubrica como **desenho próprio da ADE inspirado em, não derivado de**, o Impeccable. |
| **Banimento de fontes reclassificado como "default penalizado"** | Citação da regra "the brief wins" em `SKILL.md`/`craft-floor.md` de ambas as fontes (Impeccable + `frontend-design`) | **Sobrevive, com uma exceção literal confirmada.** `craft-floor.md` diz explicitamente: *"These are the category's defaults, not bans: the brief's own words can earn any of them"* seguido logo depois de **uma exceção nomeada**: *"A kicker or eyebrow above a heading. This one is a ban, not a default: no brief earns it back."* [verificado: `reference/craft-floor.md`, citação literal]. Isso bate exatamente com o que `landscape-evals-visual.md` §8.3 já havia concluído ("sobrevive um banimento absoluto: kicker/eyebrow") — **confirmado na fonte primária agora lida**, não mais [inferido]. |
| **Regra anti-anchoring** (juízo estético termina antes do achado determinístico entrar no contexto) | Citação de `reference/critique.md`: *"Assessment A must finish before detector findings enter the parent synthesis context. Detector output is deterministic, but it still anchors judgment."* | **Sobrevive, citação confirmada verbatim** [verificado: `reference/critique.md`, Hard Invariants, linha 4]. É mais forte do que uma sugestão: o Impeccable trata rodar A e B como **sub-agentes isolados e paralelos** como mandatório ("do not run them inline because it is faster" é citado como a falha mais comum do comando), com um banner `⚠️ DEGRADED` obrigatório quando cai para modo sequencial. A ADE já tem Maker≠Checker de famílias diferentes; a regra adicional que falta na spec v2 §10 é: **o avaliador visual não deve ver o diff nem os achados do D5 antes de terminar seu julgamento subjetivo** — hoje a spec não distingue isso. |

**Resumo do que muda de verdade na §10.5/§16 da spec:**
- `visual.max_rounds`: **4 → 2**, com base em citação primária exata (alta confiança).
- Corte final: manter **≥ 8 por critério é defensável** (é o teto da própria banda do Impeccable, não
  "impossível"); a alternativa 7,5 é uma hipótese de compromisso não testada. **Decisão pendente de
  dogfooding**, não de literatura — nenhuma das duas pesquisas tem dado causal aqui.
- Rubrica: 6-7 critérios pesados é desenho da ADE, não herança direta do Impeccable — documentar como
  tal em vez de citar como se fosse extraído da fonte.
- "Avaliador em modelo mais barato" (§16): nenhuma fonte primária testada nesta rodada resolve isso;
  mantenho a posição de `landscape-evals-visual.md` como [inferido] — argumento estrutural razoável
  (rework domina o orçamento), sem medição.

---

## 4. Portões determinísticos D1-D7 — reconciliados com a ferramenta que os executa

| ID | Portão | Ferramenta real confirmada | Status |
| :--- | :--- | :--- | :--- |
| D1 | console sem erro/warning | Playwright `page.on('console')` | Sem mudança — não depende de Impeccable |
| D2 | zero 4xx/5xx | Playwright `page.on('response')` | Sem mudança |
| D3 | contraste WCAG AA | axe-core **ou** regra `low-contrast` do Impeccable | **Confirmado**: `low-contrast` existe no registry e disparou na fixture de teste desta pesquisa com mensagem literal `"1.0:1 (need 4.5:1)"` [verificado: execução direta] |
| D4 | sem scroll horizontal em 390px | `scrollWidth > clientWidth` via Playwright | Sem mudança |
| D5 | detector estético limpo | `impeccable detect --json` contra a **URL servida** (não os arquivos-fonte — ver §1.2), exit 0/2 | **Confirmado funcional, com a correção de alvo (URL, não source files) que nenhuma pesquisa anterior testou** |
| D6 | lint anti-slop (`oxlint` + `dmmulroy/anti-slop`) | Não testado nesta rodada (fora do escopo desta lacuna) | Sem mudança de status — ainda [verificado: README do repo] de `landscape-evals-visual.md`, não re-verificado aqui |
| D7 | estados declarados renderizam | rotas `?state=` via `visual.routes` | Sem mudança |

---

## 5. Veredito `$imagegen` em `codex exec` headless

**Funcionou.** Comando executado:

```
codex exec --json --sandbox workspace-write --skip-git-repo-check -C <scratchpad>/imagegen-test \
  'Use $imagegen to generate one trivial test image: a 64x64 pixel solid red square PNG. Save it in
   the current working directory as test.png. ...'
```

Duas descobertas operacionais que a doc não menciona:
- **`--skip-git-repo-check` é obrigatório** quando o diretório de trabalho não é um repositório git
  (o scratchpad não é) — sem essa flag, `codex exec` recusa com `"Not inside a trusted directory..."`
  e sai com **exit code 1** antes de qualquer chamada de modelo [verificado: execução direta,
  primeira tentativa].
- **stdin precisa ser explicitamente `/dev/null`** (`< /dev/null`), senão o processo fica esperando
  "Reading additional input from stdin..." (mesmo com o prompt já passado como argumento posicional).
  Sem isso, `codex exec` headless pendura indefinidamente em pipelines não-interativos — risco real
  para a ADE, que precisa passar `< /dev/null` ou equivalente em todo `spawn` do adapter Codex.
  **[verificado: comportamento reproduzido]**

Resultado da segunda tentativa (com as duas correções): **exit code 0**, 14 eventos JSONL
(`thread.started`, `turn.started`, `item.started`/`item.completed` alternados, `turn.completed`).
O agente:
1. Anunciou via `agent_message`: *"Vou usar a skill `imagegen` em modo integrado..."*.
2. Chamou a ferramenta embutida (sem evento JSONL explícito de tipo `image_gen` nesta versão — a
   chamada aparece implícita entre o `agent_message` de anúncio e o primeiro `command_execution`
   seguinte, que já lê um arquivo de config RTK, não a chamada em si).
3. **Gerou um PNG real de 1254×1254, 893.954 bytes**, salvo em
   `C:\Users\Erick\.codex\generated_images\<thread_id>\exec-<uuid>.png`
   [verificado: `file` no artefato, path bate exatamente com o padrão documentado
   `$CODEX_HOME/generated_images/...`].
4. Como o prompt pedia especificamente "solid red square" (um teste sintético, não uma imagem
   fotográfica), o agente decidiu **não confiar no resultado generativo bruto** para essa
   especificação exata e escreveu um script PowerShell (`System.Drawing`) para produzir e
   **verificar pixel a pixel** um PNG 64×64 RGBA(255,0,0,255) determinístico, salvo como `test.png`
   no diretório de trabalho — comportamento razoável do agente para uma primitiva geométrica exata,
   não uma falha do `$imagegen`.
5. **`OPENAI_API_KEY` não estava definida no ambiente** e a chamada funcionou mesmo assim
   [verificado: `echo $OPENAI_API_KEY` vazio antes do teste] — confirma a doc: o caminho embutido
   (`image_gen`, preferido) consome os limites de uso normais do Codex, não uma chave de API
   separada.
6. Custo do turno completo (incluindo a geração de imagem + 3 tentativas de script PowerShell até
   acertar a sintaxe): `input_tokens: 158356` (`cached_input_tokens: 122752`), `output_tokens: 2891`,
   `reasoning_output_tokens: 1147` [verificado: evento `turn.completed`].

**Veredito para a spec §10:** `$imagegen` funciona em `codex exec --json --sandbox workspace-write`
headless, sem chave de API, como passo `model_call` do adapter `codex` — a suposição da spec v2
estava correta e agora está **[verificado: teste direto, 2026-09-16]**, não mais **[não verificado]**
como `landscape-evals-visual.md` §8.9 registrou. Duas correções operacionais entram no adapter Codex
da ADE: `--skip-git-repo-check` (worktrees da ADE podem não ser repos git na raiz exata) e
`stdin: 'ignore'`/`< /dev/null` obrigatório em todo spawn não-interativo. Não há caminho alternativo
necessário para assets de imagem na §10 — o caminho embutido já é headless-safe.

---

## Fontes

- `C:\Users\Erick\.claude\plugins\marketplaces\impeccable\` — checkout local completo, lido: `package.json`,
  `Cargo.toml` (raiz + 16 crates), `ENGINE_VERSION`, `.claude-plugin/marketplace.json`,
  `.claude-plugin/plugin.json`, `NOTICE.md`, `LICENSE`, `cli/bin/cli.js`,
  `crates/foundation/src/registry.rs`, `crates/foundation/src/rules/types.rs`,
  `crates/foundation/src/findings.rs`, `.claude/skills/impeccable/SKILL.md`,
  `.claude/skills/impeccable/reference/{audit,critique,hooks,craft-floor}.md`. [verificado, 2026-09-16]
- `https://github.com/pbakaus/impeccable` — `gh api repos/pbakaus/impeccable` (Apache-2.0 confirmado
  pelo campo `license.spdx_id`, `pushed_at: 2026-09-15`). [verificado, 2026-09-16]
- Registro npm `impeccable`: `npm view impeccable versions --json` (último publicado `4.1.0`);
  `npx --yes impeccable@4.1.0 --version` / `detect --json` / `--help` / `detect --help` /
  `ignores --help` / `ignores list` executados diretamente contra fixture em
  `<scratchpad>/impeccable-fixture/bad.html`. [verificado, 2026-09-16]
- `E:\Documentos\ProjetosIA\tl-orchestrator-release\skills\tl-impeccable-design\SKILL.md` e
  `scripts\audit_ui.py` — lidos por completo. [verificado]
- `C:\Users\Erick\.claude\plugins\marketplaces\claude-plugins-official\plugins\frontend-design\skills\frontend-design\SKILL.md`
  — lido por completo. [verificado]
- `E:\Documentos\ProjetosIA\TL-ADE\docs\specs\2026-09-16-ade-design.md` §10, §16. [verificado]
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\method-inheritance.md` §4;
  `docs\research\landscape-evals-visual.md` §3.2-3.6, §4.1, §6, §7, §8;
  `docs\research\capabilities-codex.md` §6.2. [verificado, conteúdo já existente no repositório]
- Teste dedicado `$imagegen`: `codex exec --json --sandbox workspace-write --skip-git-repo-check -C
  <scratchpad>/imagegen-test '...'` (codex-cli 0.154.0 local), saída JSONL completa inspecionada,
  artefato PNG confirmado em `$CODEX_HOME/generated_images/` e `test.png` de saída verificado com
  `file`. [verificado, 2026-09-16]
