# Estado da arte — evals para coding agents e agentes visuais/frontend

Pesquisa para a rodada de rearquitetação da TL-ADE. Data: 2026-09-16. Alvo: decisões do eval-first
(spec v2 §7) e do Frontend Quality Engine (spec v2 §10).

Classificação usada em todo o documento: **[V]** verificado em fonte primária (com fonte), **[I]**
inferido a partir de fontes verificadas, **[H]** hipótese não verificada. URLs completas na seção
Fontes.

---

## 0. Sumário das respostas

| # | Decisão | Resposta curta |
| :--- | :--- | :--- |
| 1 | Taxonomia de evals | 5 classes, um único formato de registro (`cmd + expect_exit + evidence + strictness`). Prova de estritez = rodar o eval contra `tree_before` do journal e exigir exit ≠ 0. Custo marginal quase zero porque o runtime já grava `tree_before`. |
| 2 | Loop visual | Playwright como **biblioteca**, nunca MCP. Camada determinística (7 portões) antes do juiz. Rubrica ponderada de 6 critérios, corte final **7,5** (não 8), especificidade ≥ 7, zero `critical`. Teto **2 rodadas**, não 4. Custo do juiz é irrelevante (~US$ 0,04–0,18/rodada); o caro é o rework. |
| 3 | Direção antes do código | Brief = `PRODUCT.md` (durável) + `DESIGN.md` (tokens) + brief de superfície (modo). ~70% dos guardrails estéticos são automatizáveis hoje por detector determinístico (Impeccable, 30+ regras nomeadas) + computed style via Playwright; o resto (especificidade) é juízo. |
| 4 | Evals de missão | 7 métricas por lote extraíveis do journal sem instrumentação nova; suíte de dogfood de 20–50 tarefas com `pass^3`. |
| 5 | YAGNI v1 | Fora: pixel-a-pixel como portão de story nova, SaaS de regressão visual, computer use, MCP de browser, frameworks de eval externos, benchmarks públicos como métrica. |

---

## 1. Benchmarks públicos: o que muda (quase nada) e o que ensina (muito)

Nenhum benchmark público vira métrica da ADE — eles medem modelo, não harness. O que importa é o
**modo de falha** deles, porque é o mesmo modo de falha de um eval frouxo de story.

| Benchmark | Estado 2026 | Lição para a ADE |
| :--- | :--- | :--- |
| SWE-bench Verified | OpenAI parou de reportar por contaminação; auditoria de 138 tarefas difíceis achou **59% com falhas materiais** — testes estreitos demais para aceitar solução correta, ou frouxos demais para rejeitar errada [I, via agregadores 2026] | O erro dominante de eval não é ausência, é **calibração**: ou rejeita certo, ou aceita errado. Justifica o gate de estritez bidirecional (§2.3). |
| SWE-bench Pro | Resistente a contaminação por codebases privados; auditoria Datacurve (maio/2026) reporta **~1/3 dos julgamentos errados** pelos graders [I] | Grader automático também precisa de eval. Ver §4 (o Checker do eval). |
| Terminal-Bench 2.0 + Harbor | Substituiu a 1.0; verificação manual + assistida por LM de cada tarefa; Harbor = harness de containers, registry, interface para qualquer agente instalável em container [V: tbench.ai]. Número de tarefas (89) vem de secundária [I] | O formato Harbor (tarefa = container + verificação) é o desenho certo para a suíte de dogfood da ADE (§5). |
| Aider polyglot | Ativo; 225 exercícios Exercism em 6 linguagens, 2 tentativas com feedback do erro [I] | O padrão "2 tentativas com feedback" é exatamente o teto de rework; valida `rework ≤ N` pequeno. |
| LiveCodeBench | Problemas pós-cutoff; resistente a memorização [I] | Irrelevante para a ADE (competitive programming). |

**Decisão:** benchmarks públicos entram na spec apenas como justificativa do princípio "eval estrito
obrigatório", nunca como número reportado. **[decisão: não rastrear]**

---

## 2. Decisão 1 — Taxonomia de evals e prova de estritez

### 2.1 Formato mínimo executável (um só, para todas as classes)

A spec v2 §7 diz "um comando que pode falhar". Isso é pouco: sem evidência declarada o portão passa
sem rastro auditável, e sem prova de estritez o eval pode ser verde por acaso. Registro proposto
(`eval.schema.json`):

```json
{
  "id": "story-14/regression",
  "kind": "command | http | visual | schema",
  "cmd": ["pnpm", "vitest", "run", "tests/auth.spec.ts"],
  "cwd": ".",
  "expect_exit": 0,
  "evidence": ["reports/junit.xml"],
  "timeout_s": 300,
  "max_output_bytes": 8192,
  "strictness": { "mode": "tree_before", "must_fail": true }
}
```

Quatro campos carregam todo o peso: `cmd` (pode falhar), `expect_exit` (falsificável), `evidence`
(o que vai para o journal como prova) e `strictness` (§2.3). `max_output_bytes` implementa a saída
filtrada da §12 no próprio contrato do eval, não num wrapper separado.

Base doutrinária: a Anthropic separa graders em **code-based** (rápido, barato, objetivo,
reproduzível, frágil a variações válidas), **model-based** (flexível, capta nuance, não
determinístico, exige calibração) e **human** (padrão-ouro, usado para calibrar os outros)
[V: Anthropic, "Demystifying evals for AI agents", 2026-01-09]. Regra derivada: **model-based só
onde code-based é impossível** — na ADE isso significa exatamente um lugar, a nota estética (§3).

Outra regra da mesma fonte, diretamente aplicável ao `contain`/`gates`: *"There is a common instinct
to check that agents followed very specific steps like a sequence of tool calls in the right order.
We've found this approach too rigid."* [V] — o eval verifica **outcome** (estado final da árvore e do
sistema), não trajetória. A trajetória fica no journal para auditoria, não como critério.

### 2.2 Taxonomia por classe de tarefa

| Classe | Eval obrigatório (code-based) | Caso negativo obrigatório | Evidência no journal |
| :--- | :--- | :--- | :--- |
| **bugfix** | teste que reproduz o bug e passa depois | o próprio teste contra `tree_before` | exit code + junit/tap |
| **API** | teste de contrato: status + schema da resposta | auth inválida → 401/403; payload inválido → 4xx | corpo da resposta + schema validado |
| **UI** | 7 portões determinísticos (§3.2) + rubrica visual | fixture ruim reprova (já na spec §15) | screenshots com metadados + JSON do avaliador |
| **infra** | comando idempotente + health check pós-aplicação | segunda aplicação não muda estado (diff vazio) | saída do `plan`/`diff` + health check |
| **dados** | assertiva de schema + invariante (contagem, unicidade, nulos) | linha corrompida injetada → pipeline falha | relatório do validador |

O caso negativo é o que separa eval de teatro: um eval só positivo ("o endpoint responde 200")
aceita quase qualquer implementação. Isso é a versão de story do erro de 59% do SWE-bench Verified.

### 2.3 Como o Checker prova que o eval é estrito — `tree_before` como mutante universal

O runtime v0.17.0 já grava `tree_before` e `tree_after` por step, com checkpoint da árvore
[V: docs/RUNTIME.md do tl-orchestrator, referenciado na spec v2 §6]. Isso entrega a prova de
estritez **de graça**, sem mutation testing de verdade:

```
gate strictness:
  1. checkpoint atual (tree_after) já existe
  2. restaurar tree_before num worktree descartável
  3. rodar o MESMO cmd do eval
  4. exigir exit != 0
  5. restaurar tree_after; gravar step eval_run{mode:"strictness", passed:bool}
```

Se o eval passa contra `tree_before`, ele não testa a mudança — é frouxo por construção, e a story
volta para o tradutor reescrever o eval, não para o Maker reescrever o código. Custo: uma execução
extra do eval por story (segundos para teste, minutos para build).

Quando `tree_before` não é discriminativo — mudança puramente aditiva, eval que também falharia por
ausência de arquivo — cai no modo `mutate`: o Checker comenta a guarda específica que a spec nomeia
e exige falha. Esse modo é o caro e deve ser exceção. A prática é conhecida como **sabotage
spot-check** (comentar ou fazer early-return no código sob teste e reexecutar) e como **mutation
testing** clássico (mutante "morto" = teste eficaz; mutante "sobrevivente" = lacuna) [I: literatura
de mutation testing e discussões 2026; sem fonte primária de vendor].

> **Ganho arquitetural:** o campo `strictness` fecha o risco "eval frouxo aprova trabalho ruim" da
> spec §16 com mecanismo, não com heurística. A heurística atual da spec ("eval que nunca falhou em
> rework algum é sinalizado") continua útil como segunda rede, mas é tardia — só dispara depois de
> várias stories.

### 2.4 Métricas de eval que valem armazenar

Da Anthropic [V]: **pass@k** (≥1 sucesso em k tentativas) e **pass^k** (todas as k tentativas
passam) divergem muito — em k=10, pass@k tende a 100% enquanto pass^k despenca. Regra prática da
mesma fonte: eval de **capacidade** começa com taxa de acerto baixa; eval de **regressão** deve ficar
em ~100%. Na ADE: o eval da story é regressão (≈100% exigido); a suíte de dogfood é capacidade
(§5).

---

## 3. Decisão 2 — Loop visual

### 3.1 Ferramenta: Playwright direto, MCP nunca (no caminho automático)

| Opção | Ferramentas expostas | Veredito |
| :--- | :--- | :--- |
| Playwright como biblioteca (`@playwright/test` no engine) | — | **Escolhida.** O engine controla a captura; o agente nunca produz a imagem que será julgada. |
| Playwright MCP | 70+ tools [I: docs Playwright MCP 2026] | Fora do caminho automático. Serve ao operador quando ele **assume o terminal**. |
| Chrome DevTools MCP | **58 tools** em 11 categorias, incluindo 13 de heap snapshot e `lighthouse_audit` [V: tool-reference.md do repositório ChromeDevTools/chrome-devtools-mcp] | Fora. 58 descrições de ferramenta no contexto contradizem a §12 (economia de contexto) para ganho zero: tudo que a ADE precisa (`console`, `network`, `screenshot`, a11y tree, trace) o Playwright dá por API. |
| Vercel `agent-browser` | CLI em Rust, snapshot com refs numeradas (`@e1`), skill oficial para Claude Code [I: repo vercel-labs/agent-browser] | Fora da v1. Resolve o problema do *agente* navegar, não o do *engine* capturar. Candidato de backlog se o loop visual precisar percorrer jornada. |

**Regra de custo que vale mais que a escolha da ferramenta:** o snapshot de acessibilidade custa
~200–400 tokens; uma screenshot custa milhares [I: docs e análises Playwright MCP 2026]. Portanto a
ordem certa é **a11y snapshot e portões determinísticos primeiro; screenshot só quando o julgamento
estético é inevitável**.

### 3.2 Pipeline recomendada

```
0. build de produção verde                       (portão existente)
1. serve_command sobe; espera readiness
2. para cada rota × {1280, 390} × {claro, escuro}:
     a11y snapshot + console + network + computed styles
3. PORTÕES DETERMINÍSTICOS D1–D7  ── falhou? → rework SEM chamar o juiz
4. screenshots (viewport, não fullPage) com metadados assinados
5. juiz de outra família: screenshots + spec + DESIGN.md + rubrica → JSON
6. decisão; defeitos viram rework; teto de 2 rodadas
```

**Portões determinísticos (D1–D7), todos code-based, todos baratos:**

| ID | Portão | Como | Severidade |
| :--- | :--- | :--- | :--- |
| D1 | console sem `error`/`warning` não-allowlistado | Playwright `page.on('console')` | critical |
| D2 | zero requisição 4xx/5xx | `page.on('response')` | critical |
| D3 | contraste WCAG AA (4.5:1 corpo, 3:1 texto grande) | axe-core injetado, ou regra `low-contrast` do detector | critical |
| D4 | sem scroll horizontal em 390px | `scrollWidth > clientWidth` | critical |
| D5 | detector estético determinístico limpo | `impeccable detect --json` (exit 0 limpo, 2 com achados) [V: reference/critique.md, Impeccable 4.3.1] | major |
| D6 | lint anti-slop zero erros (projetos TS) | `oxlint` com plugin vendorizado `dmmulroy/anti-slop` [V: README do repo, 2026-09-10] | major |
| D7 | estados declarados renderizam | rotas de estado (`?state=empty|error|loading`) declaradas em `visual.routes` | major |

D5 é o maior ganho por linha de código escrita: o detector do Impeccable é determinístico, em Rust,
e cobre nominalmente regras que a spec v2 §10 descreve em prosa — `gradient-text`,
`kicker-above-heading`, `hero-eyebrow-chip`, `icon-tile-stack`, `italic-serif-display`,
`ai-color-palette`, `low-contrast`, `gray-on-color`, `dark-glow`, `tracked-caps`,
`flat-type-hierarchy`, `border-accent-on-rounded`, `bounce-easing`, `accent-bold`,
`dash-prefix`, `side-tab`, entre outras [V: `crates/foundation/src/rules/types.rs` e
`crates/core/src/checks/rules.rs` da instalação local, v4.3.1]. Ele roda em dois níveis: tier
imediato por edição (via hook `PostToolUse`) e passe profundo no `Stop` [V: reference/hooks.md].

> **A ADE orquestra o detector, não o reimplementa.** Escrever 30 regras de CSS/JSX é semanas de
> trabalho para reproduzir algo Apache-2.0 já instalado na máquina do Erick.

### 3.3 Rubrica anti-slop concreta (a parte que só o juiz faz)

Chamar o juiz para contraste ou console é desperdício — D1–D7 já resolveram. O juiz existe para o
único critério que nenhum detector captura: **especificidade de design** ("esta interface poderia
ser de outro produto sem mudar nada?").

| # | Critério | Peso | 0–10 avalia |
| :--- | :--- | ---: | :--- |
| 1 | **Especificidade** | 3,0 | A composição, o vocabulário visual e o elemento-assinatura são deste produto ou intercambiáveis com qualquer outro |
| 2 | Hierarquia e composição | 2,0 | O que importa domina; agrupamento por proximidade; densidade adequada ao modo |
| 3 | Tipografia | 2,0 | Par display/corpo com personalidade; escala e pesos com degraus óbvios; medida 65–75ch |
| 4 | Cor e superfície | 1,5 | Paleta coesa via tokens; dominante + acentos; tema escuro real (não inversão) |
| 5 | Estados e bordas | 1,0 | vazio, carregando, erro, foco, hover, desabilitado — presentes e desenhados |
| 6 | Movimento | 0,5 | Um momento autorado, não efeitos espalhados; `prefers-reduced-motion` com alternativa |
| | **Total ponderado** | **10,0** | |

**Corte proposto: final ≥ 7,5; critério 1 ≥ 7; nenhum critério < 6; zero defeito `critical`;
D1–D7 verdes.**

> **Contradiz a spec v2 §10.5** ("todos os critérios ≥ 7, final ≥ 8"). Motivo: o Impeccable calibra
> explicitamente a escala equivalente com *"Be honest with scores. A 4 means genuinely excellent.
> Most real interfaces score 20-32 out of 40"* [V: reference/critique.md] — ou seja, interface real
> boa vive entre 5 e 8 numa escala 0–10. Um corte de 8 em **todos** os critérios põe a barra acima do
> que interface humana de produção atinge, e o resultado previsível é esgotar `max_rounds` e cair em
> `awaiting_operator` em trabalho bom. Um corte ponderado de 7,5 com piso duro no critério 1 mantém
> o rigor onde ele importa (slop) e afrouxa onde não importa (movimento).

Escala de severidade de defeito, alinhada ao Impeccable [V: reference/audit.md]: `P0` (critical,
bloqueia), `P1` (major, conta no corte), `P2`/`P3` (registrados, não bloqueiam).

### 3.4 Teto de rodadas: **2**, não 4

O próprio Impeccable, que é a fonte do método, proíbe o loop aberto no seu texto normativo:

> *"Verify in bounded passes, not a loop... Build fully, inspect once with a batched round (desktop
> and mobile together on the web), fix everything it shows in one batch, confirm with at most one
> more round, and stop polishing. Open-ended self-QA burns the user's money doing worse what the
> finish handoffs do better."* [V: SKILL.md do Impeccable 4.3.1]

Ou seja: **1 rodada de inspeção em lote + no máximo 1 de confirmação**. Isso converge com o Aider
polyglot (2 tentativas com feedback) [I]. Recomendação: `visual.max_rounds` padrão **2**, teto
configurável 3; a quarta rodada quase nunca muda o veredito e sempre custa.

### 3.5 Custo por rodada (e por que o teto não é sobre o juiz)

Fórmula da Anthropic para tokens de imagem: `tokens ≈ (largura × altura) / 750`
[I: fórmula documentada pela Anthropic, confirmada por agregadores em 2026-09].

| Captura | Pixels | Tokens |
| :--- | ---: | ---: |
| 1280×800 (viewport) | 1.024.000 | ~1.365 |
| 390×844 (viewport) | 329.160 | ~439 |
| 1280×3000 (fullPage) | 3.840.000 | **~5.120** |

Quatro capturas de viewport (2 larguras × 2 temas): **~3.600 tokens**. Somando rubrica + spec +
`DESIGN.md` (~2.500) e a saída JSON (~1.200): **~6.100 in / ~1.200 out por avaliação**.

A preços da ordem de US$ 3/M in e US$ 15/M out, isso é **~US$ 0,04 por rodada**; a preços de modelo
de topo (ordem de US$ 15/US$ 75), **~US$ 0,18** [I: aritmética sobre a fórmula; preços de tabela
não verificados em fonte primária nesta pesquisa]. Um rework de implementação multi-arquivo consome
tipicamente 30–150k tokens, isto é **10 a 50 vezes mais que o juiz** [H].

> **Contradiz a mitigação da spec v2 §16** ("avaliador em modelo mais barato que o Maker"). A
> economia é ruído orçamentário e o preço é julgamento pior. O que precisa de teto é o **rework**,
> não a avaliação. Recomendação: juiz no melhor modelo multimodal disponível de família diferente;
> orçamento contado sobre as rodadas de rework.

Duas regras de captura que valem dinheiro real: **`fullPage: false`** (viewport custa 3–4× menos que
página inteira) e **eixo longo ≤ 1024px** quando a rota for longa — screenshots de documento não
perdem informação útil ao serem reduzidas [I].

### 3.6 Como evitar que o avaliador seja enganado

Oito regras, quase todas gratuitas:

1. **O engine captura, o agente nunca entrega imagem.** Screenshot produzida pelo Maker é imagem
   sem proveniência. A captura é step do engine, com metadados (URL, viewport, tema, SHA do commit,
   timestamp) e hash da imagem gravados no step `visual_eval`.
2. **O juiz não vê o diff nem o prompt do Maker.** Só screenshots + spec + `DESIGN.md` + rubrica.
   Ver o diff faz o juiz avaliar a intenção declarada em vez do resultado.
3. **Determinístico antes do juiz.** D1–D7 reprovados nem chegam ao modelo. Impede "página bonita
   com console vermelho" e corta custo de rodadas obviamente perdidas.
4. **Julgamento estético antes do detector no contexto.** O Impeccable é explícito: *"Assessment A
   must finish before detector findings enter the parent synthesis context. Detector output is
   deterministic, but it still anchors judgment."* [V: reference/critique.md]. Achado determinístico
   ancora a nota subjetiva para baixo ou para cima; separar as duas avaliações em contextos isolados
   é a mitigação.
5. **Sem histórico de rodadas anteriores no contexto do juiz.** Caso contrário aparece deriva de
   leniência ("já melhorou muito, passa").
6. **Escape hatch obrigatório.** *"give the LLM a way out, like providing an instruction to return
   'Unknown' when it doesn't have enough information"* [V: Anthropic, 2026]. Critério não avaliável
   vira `n/a` e o total é renormalizado sobre o máximo aplicável — mecânica que o Impeccable já
   formaliza (`/32` em vez de `/40` quando dois critérios são `n/a`) [V].
7. **Família diferente da que editou por último**, já na spec. A evidência publicada é indireta:
   relatos de campanhas cross-vendor onde revisor Codex achou defeitos que revisores da família
   Claude não acharam, e vice-versa; o argumento estrutural é que famílias compartilham pontos cegos
   correlacionados [I: blogs de engenharia e vendors 2026, sem paper]. Números de melhoria citados
   por vendors não são confiáveis.
8. **Sem randomização de posição na v1.** Viés de posição (10–15 pontos de vantagem para o slot A)
   vale para comparação **pareada** [I: literatura LLM-as-judge 2026]. A avaliação da ADE é
   pontuação absoluta de um item; o viés relevante ali é auto-preferência e leniência, tratados por
   (5), (6) e (7). Dobrar o custo com swap A/B não compra nada aqui.

**Evidência de que "juiz multimodal de outra família com rubrica reduz slop":** não encontrei
medição pública direta. O que existe:

- *MLLM as a UI Judge* (arXiv 2510.08783, Adobe Research/UC Berkeley/Georgia Tech): compara GPT-4o,
  Claude e Llama contra percepção humana em 30 interfaces; conclusão é que MLLMs *"approximate human
  preferences on some dimensions but diverge on others"* — úteis para **estreitar opções cedo**, não
  para substituir validação humana [V: abstract].
- *WebVR* (arXiv 2603.13391): benchmark de recriação de página a partir de vídeo com rubricas
  visuais alinhadas a humanos; números de concordância não extraídos (PDF) [V: existência; **[?]**
  números].
- Vercel: a medição mais próxima de causal que encontrei, e é sobre **brief**, não sobre juiz — ver
  §4.2.

**Conclusão honesta:** a rubrica multimodal é defensável como filtro barato de slop e como
substituta de supervisão humana rodada-a-rodada, **não** como medida absoluta de qualidade. A ADE
deve medir isso em casa (§5), porque a literatura não fecha a questão. **[lacuna assumida]**

---

## 4. Decisão 3 — Direção visual antes do código

### 4.1 Formato do design brief

Convergência de três fontes primárias. Nenhuma delas usa um arquivo só; todas separam **contexto de
produto durável** de **tokens** de **brief da superfície**.

| Camada | Fonte | Conteúdo | Vida |
| :--- | :--- | :--- | :--- |
| `PRODUCT.md` | Impeccable `init` [V] | produto, público, verdade factual, plataforma | durável, raramente muda |
| `DESIGN.md` | Impeccable `document`/`extract` [V] | tokens: cor, tipo, espaçamento, raio, sombra, motion | muda em redesign |
| brief de superfície | Impeccable "modes" [V] | **modo** da superfície: Persuade / Operate / Read / Experience | por superfície |
| plano de direção | frontend-design da Anthropic [V] | Color (4–6 hex nomeados), Type (2+ papéis), Layout (prosa + wireframe ASCII), **Signature** (o único elemento memorável) | por story de UI |

O **modo** é o achado mais subestimado: ele muda o que a rubrica deve premiar. *"Choose the mode from
the requested surface, not the product... A tool's landing page is still Persuade; a fashion house's
documentation is still Read"* [V: SKILL.md Impeccable]. Numa superfície Operate, escaneabilidade e
expectativas nativas **superam** expressão; numa Persuade, o contrário. Sem isso, a rubrica pune
dashboard por ser sóbrio e premia landing por ser barulhenta.

O plano de direção da Anthropic é o que a spec v2 §10.1 chama de "declarar a direção estética antes
de codar", com uma exigência a mais que a spec não tem: **auto-crítica contra o default**. *"review
that plan against the brief before building: if any part of it reads like the generic default you
would produce for any similar page... revise that part, say what you changed and why"* [V].

A mesma fonte nomeia os três clichês de IA de 2026, o que os torna verificáveis:
(1) fundo creme ~`#F4F1EA` + serifada de alto contraste + acento terracota; (2) fundo quase preto +
um acento verde-ácido ou vermelhão; (3) layout broadsheet com fios de 1px, `border-radius: 0` e
colunas densas [V]. São **defaults a evitar quando o eixo está livre**, não banimentos — *"Where the
brief pins down a visual direction, follow it exactly — the brief's own words always win"* [V].

> **Conflito com a spec v2 §10.1.** A spec bane fontes ("Arial, Roboto, Inter, Space Grotesk") como
> regra absoluta. As duas fontes primárias de design convergem na regra oposta: **o brief vence**
> ("Honor pinned aesthetics, eras, materials, fonts, and palettes even when they conflict with a
> saturated-pattern warning. Redirecting a clear brief toward your taste is failure" [V: Impeccable];
> "the brief's own words always win" [V: frontend-design]). Recomendação: reclassificar de *banimento*
> para *default penalizado quando o eixo está livre*, com um único banimento absoluto sobrevivendo —
> o Impeccable mantém exatamente um: *"A kicker or eyebrow above a heading. This one is a ban, not a
> default: no brief earns it back"* [V].

### 4.2 Evidência de que o brief funciona (a única medição causal que achei)

Vercel publicou o resultado do `design.md` [V: blog Vercel, "How our agents build on-brand pages with
design.md"]:

- 7 cenários de eval congelados, com entradas simuladas e configurações de render;
- testados em Claude Opus 4.8 e Codex com GPT-5.5; **>200 execuções** no total;
- baseline gerado **sem** o contexto de design, depois **com**, sem re-rolls;
- medição final: 6 páginas geradas duas vezes cada → **39 falhas com o arquivo contra 91 sem = 57%
  menos falhas**;
- revisores humanos fizeram A/B cego para as qualidades subjetivas.

Dois princípios de redação transferíveis direto para o `DESIGN.md` da ADE:
1. **Regras observáveis, não subjetivas**: *"Let evidence tables use the full available width"* em
   vez de "deixe a tabela menos apertada" [V].
2. **O stylesheet não entra no contexto do modelo** — o brief é prosa, o CSS carrega no browser [V].
   Isso é economia de contexto (§12) com ganho de qualidade junto.

O método de medição deles é exatamente o A/B estilo Caliper que a spec v2 §12 coloca no backlog:
**fixtures rodando sem a skill como baseline, rubrica cega, N trials, taxa de sustentação**. Vale
adiantar para a v1 porque é o único jeito de saber se as centenas de skills do catálogo (§9) ajudam
ou só custam.

### 4.3 O que é automatizável por lint/CSS (e o que não é)

| Guardrail da spec §10.1 | Automatizável por | Determinístico? |
| :--- | :--- | :--- |
| fontes genéricas | detector (`overused-font`, com `--all-values` para ignorar) [V] + grep em `tailwind.config`/`@font-face` | **sim** |
| paleta via CSS variables, sem hex solto | detector + stylelint `declaration-property-value-disallowed-list`; dimensão "Theming" do `audit` [V] | **sim** |
| cinzas tímidos sobre superfície colorida | regra `gray-on-color` [V] | **sim** |
| paleta clichê de IA | regra `ai-color-palette` [V] | **sim** |
| gradiente em texto | regra `gradient-text` [V] | **sim** |
| halo/glow sem offset | regras `dark-glow`, `checkGlow` [V] | **sim** |
| eyebrow/kicker acima de heading | regras `hero-eyebrow-chip`, `kicker-above-heading` [V] | **sim** |
| numeração 01/02/03 decorativa | `checkNumberedSectionLabels` [V] | **sim** |
| pilha ícone+título+texto como estrutura | `icon-tile-stack` [V] | **sim** |
| hierarquia tipográfica plana | `flat-type-hierarchy` [V] | **sim** |
| contraste AA | axe-core / `low-contrast` [V] | **sim** |
| medida 65–75ch, display ≤ 6rem, tracking ≥ −0,04em | `getComputedStyle` via Playwright; números do `craft-floor.md` [V] | **sim** |
| alvo de toque ≥ 44×44px | computed style [V: audit.md] | **sim** |
| `prefers-reduced-motion` com alternativa real (não `0.01ms` global) | emular preferência e comparar capturas [V: audit.md] | **sim** |
| sem overflow horizontal @390 | `scrollWidth > clientWidth` | **sim** |
| estados completos | presença: grep de variantes; render: exige rota de estado declarada | **parcial** |
| "um momento de motion autorado, não espalhado" | contagem de `@keyframes`/`transition` é proxy fraco | **não** |
| **especificidade de design / signature** | — | **não → juiz** |

Cobertura: **~70% dos guardrails da spec §10.1 são determinísticos hoje** [I: contagem sobre a
tabela]. O juiz multimodal fica com dois itens. Isso justifica a arquitetura da §3.2 (determinístico
primeiro) e reduz drasticamente quantas rodadas chegam ao modelo.

Nota sobre `dmmulroy/anti-slop`: a spec v2 §9 o classifica como portão de lint TS, o que é correto,
mas convém registrar que ele **não é estético** — é *"Opinionated Oxlint rules that reject
low-evidence and low-signal TypeScript and JavaScript patterns"*, com regras como
`no-array-filter-map`, `no-chained-type-assertions`, `no-runtime-typeof`, `no-module-mocking`
[V: README, 2026-09-10]. E é **feito para ser vendorizado, não instalado como dependência**: *"This
project is meant to be vendored... There is no official npm package"* [V]. O `ade doctor` deve
copiar as regras para `tools/oxlint/anti-slop/` do projeto-alvo, não adicionar dependência.

---

## 5. Decisão 4 — Evals de missão inteira (jornadas)

### 5.1 Métricas do lote, todas derivadas do journal

Nenhuma exige instrumentação nova: o journal já grava step, custo, árvore e resultado de portão.

| Métrica | Definição | Fonte no journal |
| :--- | :--- | :--- |
| `eval_pass_first` | stories com gates verdes sem rework ÷ total | `gates` sem `rework` subsequente |
| `rework_rounds` | mediana e p90 de rodadas por story | contagem de steps `rework` |
| `escaped_defects` | defeitos achados **depois** de `complete` (CI, Checker do lote seguinte, operador) ÷ stories | steps de lote posterior referenciando arquivo de story anterior |
| `visual_score` | mediana da nota final e % reprovada na rodada 1 | `visual_eval.final` |
| `human_interventions` | (`human_takeover` + `awaiting_operator`) ÷ stories | classes de step já previstas na §6 |
| `cost_per_story` | USD e tokens | `costOf()` dos adapters |
| `strictness_fail` | evals reprovados no gate de estritez ÷ evals | `eval_run{mode:"strictness"}` |

`escaped_defects` e `human_interventions` são as duas que medem se a ADE cumpre a promessa central
(qualidade verificável + preguiça do operador). As outras cinco são diagnóstico.

### 5.2 Suíte de dogfood

Regra da Anthropic para tamanho inicial: *"20-50 simple tasks drawn from real failures is a great
start"*, porque no início do desenvolvimento o efeito das mudanças é grande e amostra pequena basta
[V]. E o critério de boa tarefa: *"A good task is one where two domain experts would independently
reach the same pass/fail verdict"* [V].

Composição proposta (20–50 no total), com `runs: 3` e reporte em **pass^3**:

| Grupo | n | Exemplo |
| :--- | ---: | :--- |
| Tradutor (fixtures da §15) | 6–10 | "quero melhorar o design", "refaz o frontend", bugfix de uma linha → plano esperado (tamanho, domínios, skills, evals) |
| Jornadas ponta a ponta | 6–10 | pedido de uma frase → lote executado → PR mergeado, num repo sandbox versionado |
| Loop visual | 4–6 | fixture ruim **deve** reprovar; fixture boa **deve** passar em 1 rodada |
| Estritez | 4–6 | story com eval deliberadamente frouxo **deve** ser recusada pelo gate `tree_before` |
| Durabilidade | 4–6 | matar o processo no meio da story → retomada não repete efeito (paridade com a suíte Python) |

**Desenho de diretório** (empresta do `@vercel/agent-eval`, que resolve o mesmo problema
[V: README do repo vercel-labs/agent-eval, 260 estrelas, push 2026-09-03]):

```
results/<experimento>/<timestamp>/<eval>/run-N/
  result.json          outcome + métricas de comportamento
  transcript.json      ações do agente
  outputs/             resultados de teste e scripts
```

Na ADE o `transcript.json` **é o journal** — não há nada a construir. O que falta é o agregador por
experimento, que cabe no índice SQLite.

O `agent-eval` também dá o vocabulário certo para o eval subjetivo, e vale copiar literalmente na
forma do `eval.schema.json`:

```ts
await expect(environment).toSatisfyCriterion('uses Server Components');
await expect(transcript).toScoreAtLeast('quality bar', 0.8);
```

com a opção de **fixar o modelo do juiz** (`judge`) para que comparações entre rodadas sejam
válidas [V]. Fixar o modelo do juiz é obrigatório para que `visual_score` seja comparável ao longo do
tempo — caso contrário a métrica anda quando o modelo muda, não quando a qualidade muda. A spec v2
não tem esse campo.

### 5.3 Frameworks de eval externos: por que nenhum entra

| Framework | O que traz | Veredito |
| :--- | :--- | :--- |
| Inspect AI (UK AISI, MIT) | Task = dataset + solvers + scorer; sandbox Docker; log estruturado por run [I] | Fora: Python-first (a ADE é TS ponta a ponta, §3) e duplicaria journal + scheduler. |
| promptfoo | YAML-first, ergonomia de CI, red-team [I] | Fora: sem camada de observabilidade; o journal já é melhor para o caso. |
| Braintrust | SaaS com traces e scoring online [I] | Fora: serviço externo, contradiz "local e universal". |
| `@vercel/agent-eval` | Roda o mesmo eval em claude-code, codex, cursor, gemini, opencode; sandbox Vercel/Docker; cache por fingerprint SHA-256 [V] | Fora como dependência, **dentro como referência de desenho** (§5.2). Notável: o modelo multi-agente dele é o mesmo da matriz §13. |

---

## 6. Decisão 5 — O que é YAGNI na v1

| Item | Veredito | Quando entra |
| :--- | :--- | :--- |
| **Regressão pixel-a-pixel como portão de story nova** | **Fora.** Não existe baseline numa tela que acabou de nascer; `toHaveScreenshot` compara contra golden aprovado. Rubrica e pixel-diff resolvem problemas diferentes: rubrica = "isto é bom?", pixel-diff = "isto mudou?" | Modo manutenção/rotinas (backlog §14): capturas do último `complete` viram goldens candidatos; o diff só liga quando o operador aprova a tela. API pronta: `threshold` padrão **0.2**, `animations: "disabled"`, `caret: "hide"`, `scale: "css"`, `maskColor: "#FF00FF"`, `maxDiffPixels`/`maxDiffPixelRatio` sem default [V: docs Playwright] |
| **SaaS de regressão visual** (Chromatic, Percy, Argos) | **Fora.** Conta, custo recorrente e CI externo contra uma ADE local. Para registro 2026: Argos ~US$ 100/mês por 35k screenshots, Chromatic Starter ~US$ 179/mês por 35k snapshots, Percy a partir de ~US$ 599/mês [I: comparativo publicado pela Argos — fonte interessada] | Não entra |
| **Lost Pixel** | **Fora — descontinuado.** Time entrou para a Figma; repositório arquivado em 2026-04-22 [I] | Nunca |
| **Computer use** (Gemini / Claude) para avaliar UI | **Fora.** Screenshot + rubrica responde "é bom?" por US$ 0,04; computer use responde "consigo usar?" por muitos passos de modelo. É ferramenta de **jornada**, não de julgamento estético | Backlog, junto com Reticle, quando houver eval de jornada de usuário real |
| **Playwright MCP / Chrome DevTools MCP no caminho automático** | **Fora.** 70+ e 58 ferramentas no contexto [V/I] para capacidade que a API do Playwright já dá. Contradiz §12 | Disponíveis ao operador quando ele assume o terminal |
| **Benchmarks públicos como métrica da ADE** | **Fora.** Medem modelo, não harness; contaminados; nenhuma decisão muda com o número | Nunca |
| **Framework de eval externo** | **Fora** (§5.3) | Nunca |
| **Ensemble de juízes / swap A/B de posição** | **Fora.** Pontuação absoluta de item único não sofre viés de posição; dobra custo sem comprar nada (§3.6.8) | Se a ADE passar a comparar variantes (`generate` do Impeccable), aí sim |
| **Reimplementar detector estético** | **Fora.** 30+ regras determinísticas já existem, Apache-2.0, instaladas | Nunca |
| **Gate de estritez por `tree_before`** | **DENTRO.** Custo marginal ~zero, fecha o risco nº 1 da §16 | v1, núcleo |
| **Portões determinísticos D1–D7** | **DENTRO.** Code-based, baratos, cortam a maioria das rodadas antes do modelo | v1, loop visual |
| **A/B do brief (fixtures sem skill)** | **DENTRO**, na versão mínima: 6 fixtures × 2 condições. É a única evidência publicada de ganho causal (57% menos falhas) e valida o catálogo de centenas de skills | v1, catálogo |

---

## 7. Impactos concretos na spec v2

| § | Mudança proposta | Motivo |
| :--- | :--- | :--- |
| §7 | `eval.schema.json` ganha `evidence`, `max_output_bytes` e `strictness{mode, must_fail}`; gate de estritez roda contra `tree_before` | §2.1, §2.3 |
| §7 | Toda classe de eval exige **um caso negativo** | §2.2; erro de 59% do SWE-bench Verified |
| §10.1 | Fontes banidas viram "defaults penalizados quando o eixo está livre"; sobrevive um banimento absoluto (kicker/eyebrow) | §4.1 — "o brief vence" em ambas as fontes primárias |
| §10.1 | Brief ganha **modo da superfície** (Persuade/Operate/Read/Experience) e **Signature** | §4.1 |
| §10.3 | Camada determinística D1–D7 antes do juiz; `fullPage: false`; eixo longo ≤1024px | §3.2, §3.5 |
| §10.4 | Rubrica de 6 critérios ponderados; `n/a` com renormalização; escape hatch; juiz sem diff, sem histórico, sem achado do detector antes do julgamento estético | §3.3, §3.6 |
| §10.5 | Corte final **7,5** (crit. 1 ≥ 7, nenhum < 6); `visual.max_rounds` padrão **2** | §3.3, §3.4 |
| §12 | A/B estilo Caliper sai do backlog e entra na v1 em versão mínima | §4.2 |
| §13 | `codex review` confirmado como subcomando não-interativo com `--uncommitted` e `--base <BRANCH>` [V: `codex review --help`, codex-cli 0.154.0 local] — o Checker não precisa de prompt custom | verificação local |
| §16 | Remover "avaliador em modelo mais barato que o Maker"; o teto vale para rework | §3.5 |
| §16 | Risco novo: **juiz fixo** — modelo do juiz precisa ser pinado para `visual_score` ser comparável entre lotes | §5.2 |

---

## 8. Achados que contradizem a spec v2 ou o prompt (resumo)

1. **Teto de 4 rodadas visuais** contradiz a fonte do método: o Impeccable normatiza 1 rodada em
   lote + no máximo 1 de confirmação, e chama loop aberto de "queimar o dinheiro do usuário" [V].
2. **Corte final ≥ 8 em todos os critérios** está acima da banda calibrada — o Impeccable diz que
   interface real boa fica em 20–32/40 [V]. Levaria a `awaiting_operator` em trabalho bom.
3. **"Avaliador em modelo mais barato"** economiza ~US$ 0,14/rodada num orçamento dominado pelo
   rework; troca julgamento por ruído.
4. **Fontes banidas** contradizem a regra "o brief vence" das duas fontes primárias de design [V].
5. **O detector estético já existe** (Impeccable 4.3.1, Rust, Apache-2.0, 30+ regras nomeadas, hooks
   PostToolUse/Stop, `detect --json` com exit 0/2), instalado na máquina. A §10 descreve em prosa o
   que ele faz em código.
6. **Anti-anchoring**: o Impeccable exige que o julgamento estético termine antes de achados
   determinísticos entrarem no contexto. A spec v2 não tem essa regra e a arquitetura ingênua
   (detector + juiz no mesmo prompt) a viola.
7. **`dmmulroy/anti-slop` não é estético** e é feito para ser vendorizado, não instalado [V]. A §9 o
   descreve como "regras Oxlint anti-slop", o que é ambíguo.
8. **SWE-bench Verified foi abandonado pela OpenAI por contaminação**, com 59% de falhas materiais
   numa auditoria de 138 tarefas difíceis [I] — o eval frouxo não é risco teórico, é o estado da arte
   dos benchmarks canônicos.
9. **`gpt-image-2` como asset**: o prompt pede confirmação do uso "como asset, não referência". A
   fonte do catálogo é secundária (blog + fórum) [registro em `docs/catalog-sources.md`]; não
   encontrei documentação primária da OpenAI nesta pesquisa confirmando a skill `$imagegen` embutida
   no Codex CLI com 16 imagens de referência. **[não verificado]**

---

## 9. Perguntas em aberto

1. Não há medição pública de que **juiz de família diferente com rubrica sobre screenshot reduz
   slop**. A evidência é indireta (MLLM-as-UI-judge: alinhamento parcial; cross-model review: relatos
   de vendor). A ADE precisa medir isso em casa com o A/B de fixtures (§4.2/§5.2).
2. Números do WebVR (rubrica visual alinhada a humanos) não extraídos — PDF de 6 MB não parseado.
3. Terminal-Bench 2.0: contagem de 89 tarefas vem de secundária; a página de anúncio não a confirmou
   no fetch.
4. Preços de tabela dos modelos em 2026-09 não foram verificados em fonte primária; a aritmética de
   custo da §3.5 é robusta à escala (a conclusão "o juiz é ruído no orçamento" vale em qualquer faixa
   plausível), mas os valores absolutos são [I].
5. `$imagegen` do Codex: falta fonte primária (ver §8.9).
6. Impeccable `live` e `generate` (variantes escolhidas no browser) podem substituir parte do loop de
   rework com custo menor que uma rodada completa — não avaliado nesta pesquisa.
7. Rubrica por **modo** (Persuade/Operate/Read/Experience) implica pesos diferentes por modo; os
   pesos da §3.3 estão calibrados para um caso geral e precisam de ajuste por modo. Não medido.

---

## Fontes

**Primárias — instaladas localmente (inspecionadas nesta pesquisa)**

- Impeccable 4.3.1 (Paul Bakaus, Apache-2.0) — `SKILL.md`, `reference/craft-floor.md`,
  `reference/critique.md`, `reference/audit.md`, `reference/hooks.md`,
  `crates/foundation/src/rules/types.rs`, `crates/core/src/checks/rules.rs`, em
  `C:\Users\Erick\.claude\plugins\marketplaces\impeccable\`. Site: https://impeccable.style/ ·
  repositório: https://github.com/pbakaus/impeccable
- `frontend-design` (Anthropic, plugin oficial) — `skills/frontend-design/SKILL.md` em
  `C:\Users\Erick\.claude\plugins\marketplaces\claude-plugins-official\plugins\frontend-design\`
- `codex review --help`, codex-cli 0.154.0 (verificação local em 2026-09-16)

**Primárias — web**

- Anthropic, "Demystifying evals for AI agents" (2026-01-09):
  https://anthropic.com/engineering/demystifying-evals-for-ai-agents
- Anthropic, "Building effective agents" (2024-12-19):
  https://www.anthropic.com/research/building-effective-agents
- Playwright — `toHaveScreenshot` (opções e defaults):
  https://playwright.dev/docs/api/class-locatorassertions#locator-assertions-to-have-screenshot-1
- Playwright — Visual comparisons: https://playwright.dev/docs/test-snapshots
- Playwright MCP — snapshots de acessibilidade: https://playwright.dev/mcp/snapshots ·
  https://github.com/microsoft/playwright-mcp
- Chrome DevTools MCP — referência completa de ferramentas (58):
  https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md
- Terminal-Bench 2.0 e Harbor (anúncio): https://www.tbench.ai/news/announcement-2-0 ·
  https://github.com/harbor-framework/terminal-bench
- Vercel, "How our agents build on-brand pages with design.md":
  https://vercel.com/blog/how-our-agents-build-on-brand-pages-with-design-md
- Vercel, "Eval-driven development: Build better AI faster":
  https://vercel.com/blog/eval-driven-development-build-better-ai-faster
- `@vercel/agent-eval` (README e árvore do repositório):
  https://github.com/vercel-labs/agent-eval
- `dmmulroy/anti-slop` (README, push 2026-09-10): https://github.com/dmmulroy/anti-slop
- `vercel-labs/agent-browser`: https://github.com/vercel-labs/agent-browser

**Papers**

- *MLLM as a UI Judge: Benchmarking Multimodal LLMs for Predicting Human Perception of User
  Interfaces* — arXiv 2510.08783: https://arxiv.org/abs/2510.08783
- *WebVR: Benchmarking Multimodal LLMs for WebPage Recreation from Videos via Human-Aligned Visual
  Rubrics* — arXiv 2603.13391: https://arxiv.org/pdf/2603.13391
- *A Survey on LLM-as-a-Judge* — arXiv 2411.15594: https://arxiv.org/html/2411.15594v6
- *Self-Preference Bias in LLM-as-a-Judge* — arXiv 2410.21819: https://arxiv.org/pdf/2410.21819
- *Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Command Line Interfaces* —
  arXiv 2601.11868: https://arxiv.org/pdf/2601.11868

**Secundárias (usadas só para [I], nunca para [V])**

- Argos, comparativo de preços e ferramentas de regressão visual (fonte interessada):
  https://argos-ci.com/blog/percy-vs-chromatic-vs-argos ·
  https://argos-ci.com/blog/visual-testing-pricing · https://argos-ci.com/blog/lost-pixel-alternatives
- Contaminação do SWE-bench / estado dos leaderboards 2026:
  https://www.buildmvpfast.com/blog/benchmark-contamination-ai-coding-leaderboard-swe-bench-2026 ·
  https://www.morphllm.com/swe-bench-pro
- Snorkel AI, Terminal-Bench 2.0:
  https://snorkel.ai/blog/terminal-bench-2-0-raising-the-bar-for-ai-agent-evaluation/
- Revisão cross-model / cross-vendor (blogs de engenharia e vendors, não papers):
  https://codex.danielvaughan.com/2026/03/28/cross-model-adversarial-review/ ·
  https://www.augmentcode.com/guides/adversarial-code-review
- Custo de tokens de imagem (fórmula `(w × h) / 750` e agregadores):
  https://blog.roboflow.com/image-token-cost-vlm/ · https://mochify.app/guides/llm-image-token-costs
- Mutation testing para código escrito por agente:
  https://www.awesome-testing.com/2026/08/mutation-testing-for-agent-written-code
- Comparativos de frameworks de eval (Inspect / promptfoo / Braintrust):
  https://benchmarkingagents.com/inspect-uk-aisi/ ·
  https://www.braintrust.dev/articles/braintrust-vs-promptfoo
