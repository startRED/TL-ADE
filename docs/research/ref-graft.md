# Referência: trailhq/Graft para a ADE

Data: 2026-09-16. Fontes primárias: `gh api repos/trailhq/Graft` (README, releases, tags,
issues, contributors, commits — consultado 2026-09-16), integração já existente em
`E:\Documentos\ProjetosIA\tl-orchestrator-release\docs\GRAFT.md` e
`scripts/tl_graft.py`, npm registry (`@nanonets/graft`), busca web para alternativas.

## Veredito

**ADOPT — como já está integrado no tl-orchestrator (opcional, local, graft-first com
fallback automático a `rg`/leitura direta).** Portar `docs/GRAFT.md` +
`scripts/tl_graft.py` quase inalterados para a ADE em vez de reprojetar. Não há
alternativa madura que supere Graft no eixo "grátis, determinístico (tree-sitter),
23 linguagens, sem servidor" — as concorrentes diretas (CodeGraph, GitNexus, Potpie)
são mais novas, menos maduras ou pedem infra extra (grafo em banco, browser).
Ver §4 para o desenho de isolamento e o eval que provaria o ganho dentro da ADE
especificamente.

---

## 1. O que Graft faz

[verificado: README trailhq/Graft, commit `de8456e8`/tag v0.18.0, 2026-09-10]

- **Comandos:** `graft init` (detecta agentes instalados, escreve wiring — hooks,
  statusline, MCP config, `AGENTS.md`/`.claude/skills/graft/SKILL.md`), `graft build`
  (gera o grafo em `graft/`, tier 1 sem modelo), `graft build --deep` (camada LLM:
  resumo por arquivo + síntese de nós, exige chave de provedor), `graft ask`, `graft grep`,
  `graft map`, `graft skeleton`, `graft callers`, `graft check` (frescor), `graft viz`.
  Opcional `--lsp` adiciona arestas `lsp_resolved` via rust-analyzer/clangd/gopls/
  pyright/typescript-language-server, se presentes no `PATH`.
- **Índice:** grafo de markdown (`graft/*.md`, um nó por subsistema/conceito, não por
  arquivo) + `graft/.graph/wiring.json` (grafo estrutural por símbolo — função, classe,
  aresta de chamada). O nó markdown carrega resumo em prosa + "crux" (trecho de código
  que carrega a lógica, armazenado como texto, não como número de linha) + links
  tipados (`depends_on`, `part_of`, `uses`, `implements`, `produces`) + notas do
  usuário preservadas entre regenerações.
- **Linguagens:** 23 no total. Fidelidade alta (extratores dedicados, resolução de
  chamada/import entre arquivos): TypeScript/JavaScript (+ JSX/TSX), Python, Go, Java,
  Kotlin, PHP, Swift, R. Fidelidade ampla (símbolos + arestas por gramática
  tree-sitter genérica): Rust, C, C++, C#, Ruby, Scala, Elixir, Solidity, OCaml, Zig,
  Dart, Clojure, Nix, Lua. Arquivo de linguagem não listada é ignorado, não indexado.
- **Incremental:** sim, por hash de conteúdo — tier 1 (tree-sitter) e a camada LLM
  (`--deep`) são cacheadas separadamente; só arquivos alterados são reprocessados.
  Número do próprio README (repo do Graft, 124 arquivos): 0,74s a frio, 0,18s após 1
  arquivo editado, 0,18s sem mudança nenhuma. **Toda consulta** (`ask`/`grep`/`callers`/
  `skeleton`/`map`) primeiro faz um `stat` da árvore contra o fingerprint do último
  build (~3ms) e só reconstrói se algo mudou — inclui edições não commitadas
  (unstaged/staged, tanto faz).
- **Custo de build em repo grande:** não há número absoluto para "repo grande" no
  README (só o benchmark no próprio repo Graft, pequeno-médio). [inferido] O custo
  estrutural (tier 1) escala com contagem de arquivos e é paralelo/determinístico —
  plausivelmente segundos a poucos minutos num monorepo grande; sem medição própria a
  ADE não deve prometer número. O `--deep` (LLM) é o caro: 1 chamada de modelo por
  arquivo na primeira passada, custo e tempo proporcionais ao tamanho do repo e ao
  provedor escolhido — **fora do escopo da integração atual** (ver Isolamento §4).
- **Windows:** funciona, mas com atrito documentado. Achados próprios do
  tl-orchestrator (`docs/GRAFT.md`): `install_failed` em raiz de caminho muito longo
  (>260 chars, MAX_PATH) por dependência nativa compilada — mitigado com raiz curta ou
  `LongPathsEnabled`+`core.longpaths`. Issues abertas no upstream confirmam atrito
  Windows-específico: #360 (janela de console pisca no auto-rebuild), #393 (hook
  destacado abre console visível por falta de `windowsHide`), #384 (`--dir` em outro
  drive quebra guarda de fora-do-repo), #323 (`tree-sitter-kotlin@0.3.8` sem prebuilds
  quebra em `require()` sem toolchain C), #385 (`--lsp` reporta `lsp:none` mesmo com
  clangd/pyright no PATH, por checar via `cmd.exe`). [verificado: issues 360/393/384/
  323/385, trailhq/Graft, abertas em 2026-09-16] — nenhum bloqueador fatal, mas confirma
  que a integração precisa tratar Windows como caminho não trivial (o que
  `tl_graft.py` já faz).

## 2. Maturidade e risco de supply chain

[verificado: `gh api repos/trailhq/Graft`, `contributors`, `tags`, npm registry,
2026-09-16]

| Sinal | Valor |
|---|---|
| Licença | MIT |
| Estrelas / forks | 8.112 / 735 |
| Issues abertas | 164 |
| Linguagem | TypeScript (100% do repo) |
| Tamanho | ~68 MB (repo git) |
| Criado / último push | 2026-07-03 / 2026-09-16 (mesmo dia da pesquisa — atividade diária) |
| Releases (tags) | v0.7.1 → v0.18.0, 2026-08-24 a 2026-09-10 — **~1 release a cada poucos dias** durante esse período |
| npm `latest` | 0.18.0 (bate com o pin do tl-orchestrator) |
| Contribuidores | 34 no total; **top 2 concentram a maioria** (`shhdwi` 229 commits, `anirudhkumar-nanonets` 140; terceiro cai para 25) |

**Bus factor: baixo-médio.** Dois mantenedores fazem a maior parte do trabalho, mas
o projeto é mantido por uma organização comercial (`trailhq`/NanoNets, produto
"Trail Brain" — SaaS de skill/regra compartilhada, cross-promovido agressivamente no
README: badge, CTA, seção de features). [inferido] Isso é ambivalente: dá o projeto
um patrocinador com incentivo a manter (cresce a base de usuários do produto pago),
mas também significa que a direção do OSS pode se curvar a objetivos comerciais e que
não há garantia de continuidade se a empresa mudar de foco — típico de "open-core
growth engine", não de projeto comunitário independente.

**Risco de instalação nativa:** dependências nativas compiladas (`tree-sitter-*`)
já causaram falha registrada em Windows (ver §1) — mitigado, não eliminado, pela raiz
curta / `longpaths`.

**Transparência sobre concorrência:** issues #386 ("Graft vs CodeGraph") e #71 ("How
is this different from all the other code context graphs?"), ambas abertas, **sem
resposta dos mantenedores** até a data desta pesquisa. Um comentário em #71 (usuário
`Spirarel`, não mantenedor) menciona desconfiança no espaço "since the accusations
levied against Graphify" — comentário de terceiro, não verificado, citado aqui só como
sinal de que o nicho tem disputas de credibilidade, não como fato sobre o Graft.
[inferido: ausência de resposta é fraqueza de comunicação, não evidência técnica
contra o projeto]

**Telemetria:** ativada por padrão, mas documentada (`TELEMETRY.md`), sem código/
caminhos/repo/símbolos — só contadores agregados; `DO_NOT_TRACK=1` desliga. A
integração do tl-orchestrator já força essa variável e também zera chaves de provedor
herdadas do ambiente (`ENV_STRIP_*` em `tl_graft.py`), então o modo `--deep` (o único
que sairia da máquina do usuário) é estruturalmente inatingível a partir do helper.

## 3. Sobreposição com a ADE

A ADE (spec v2, `docs/specs/2026-09-16-ade-design.md`) já cita Graft três vezes:
tabela de decisões (linha 45: "Contexto por grafo é mais barato que grep+read"),
diagrama de arquitetura (linha 83: "graft (grafo por worktree)"), e regras de
harness (linha 262: "`ade` roda `graft init`/`build` por worktree; prompts instruem
graft-first... antes de grep+read"). `docs/catalog-sources.md` linha 25 já lista
`trailhq/Graft` com 8,1k estrelas para "embutido no harness".

- **Intent Compiler (linha 152 da spec):** o compilador de intenção usa Graft para
  estimar tamanho (S/M/L) e domínios detectados de uma tarefa antes de gerar o plano.
  Isso é exatamente o caso de uso que Graft resolve melhor: pergunta ampla e
  arquitetural ("como funciona X", "quem chama Y") respondida por um nó markdown em
  prosa, sem abrir N arquivos. **Encaixe direto.**
- **Context Pack:** onde a tarefa já sabe o arquivo exato, a spec e o próprio README
  do Graft concordam — ler o arquivo direto, sem consultar o grafo. Graft entra só
  para exploração ambígua (linha 262: "graft-first... antes de grep+read", já com a
  ressalva de que "se o caminho exato do código já é conhecido, o agente continua
  lendo o arquivo diretamente" em `docs/GRAFT.md`). **Encaixe parcial, já desenhado
  corretamente na integração existente.**
- **Skills (catálogo em escala, seção 9 da spec):** **sem sobreposição.** Skills são
  conteúdo de terceiro (procedimento, prompt, regra) versionado e selecionado por
  índice (`~/.ade/catalog/index.json`); Graft é um mapa estrutural do código do
  projeto do usuário, gerado localmente, nunca uma fonte de instrução. Um nó Graft não
  deveria nunca ser tratado como skill (mesma cautela de segurança que a spec já
  aplica a skills de catálogo não se aplica a Graft, e vice-versa — grafo é dado sobre
  código, não instrução sobre como agir).
- **Onde Graft NÃO entra:** (a) linguagem fora das 23 suportadas (config declarativa
  pura — YAML/Terraform/SQL — cai de volta para grep/leitura, correto); (b) tarefa de
  edição pontual com arquivo já conhecido (Context Pack já resolve, ver acima); (c)
  qualquer coisa que dependa do modo `--deep`/LLM — deliberadamente fora do escopo,
  bloqueado pelo helper.

## 4. Isolamento e eval

**Como isolar (já resolvido no tl-orchestrator, portar sem redesenhar):**
dependência **opcional** instalada num cache local por worktree
(`.tl-orc-graft-cache/`, renomear para convenção da ADE, ex. `.ade-graft-cache/`),
nunca no `PATH`/global; nunca roda `graft init` (que escreveria em `.claude/`,
`AGENTS.md`, `~/.codex/` — a ADE gerencia esses arquivos ela mesma); cache
auto-excluído de git/`rg` antes de qualquer instalação; ausência de Node/npm,
timeout, erro ou grafo desatualizado (`stale_graph`) sempre cai para `rg`/leitura
direta — nunca bloqueia a tarefa nem é apresentado como "código não existe";
verificação de frescor (`graft check`) obrigatória antes de aceitar uma resposta como
boa. Camada `--deep`/LLM permanece inatingível (chaves de provedor removidas do
ambiente do subprocesso). Esse desenho já resolve os 3 riscos do §2 (supply chain via
rede após install, vazamento de credencial, resposta obsoleta silenciosa) — a ADE
herda o `tl_graft.py` como está, ajustando só nomes de cache/pacote se a convenção da
ADE divergir do tl-orchestrator.

**Eval que provaria que compensa:** tokens totais + chamadas de ferramenta por story,
pareado (mesma story, dois braços, mesmo modelo/orçamento) — braço A: Context Pack +
`rg`/leitura direta apenas; braço B: Context Pack + Graft graft-first habilitado.
Story deve exigir pergunta arquitetural real ("onde X é decidido", "quem depende de
Y") em repositório de porte médio (>50 arquivos) numa das 8 linguagens de fidelidade
alta — testes S/pontuais não vão mostrar diferença (a própria Graft admite isso: braço
"pull" do benchmark do README ganha em correção, não em velocidade, quando a pergunta
é pontual). Métrica de aceite: reduzir tokens/chamadas sem piorar correção (taxa de
aceite do eval da story) — replica a metodologia do próprio benchmark do Graft
(cost-aware, juiz de correção com piso obrigatório), não apenas o número que o README
anuncia. **Não adotar o número do README (+42% tokens, +46% tool-calls) como
verdade para a ADE sem essa medição própria** — é medição deles, no repo deles, não
na composição real do harness da ADE (Context Pack + skills + evals já cortam parte
da mesma exploração redundante que o Graft ataca, então o ganho incremental pode ser
menor).

## Alternativas — comparação

| Ferramenta | Abordagem | Linguagens/infra | Maturidade | Evidência de economia de tokens | Nota |
|---|---|---|---|---|---|
| **Graft** (trailhq) | Grafo markdown (prosa) + grafo estrutural tree-sitter; sem servidor, arquivos no repo | 23 linguagens, tier alto em 8 | 8,1k★, ativo diário, releases frequentes, MIT | [verificado: benchmark próprio, README] 162 execuções, 2 repos: +42% tokens, +46% tool-calls, +60% tempo, correção igual (93%=93%); SWE-bench Verified 50 instâncias: 66% vs 54% correção, +23% tokens | Já integrado no tl-orchestrator |
| **Aider repo-map** | Tags tree-sitter (def/ref) → grafo dirigido → PageRank personalizado com restart no chat atual → top-N definições dentro de orçamento de tokens | Muitas via tree-sitter; sem infra externa | Maduro, parte do Aider (ativo há anos) | [inferido] Só relatos de melhor acurácia de edição vs inclusão ingênua de arquivo; sem benchmark tokens-vs-grep publicado equivalente ao do Graft | Puramente estrutural, sem camada de prosa/resumo — mais "índice", menos "explicação" |
| **Sourcegraph/Cody context** | Busca híbrida (embeddings + grafo de símbolo via SCIP/LSIF) + infra de indexação em servidor | Múltiplas, via SCIP | Maduro, produto comercial com motor OSS parcial | Não publica benchmark tokens-vs-grep diretamente comparável | Pede infra de indexação (servidor Sourcegraph); peso maior que Graft para uso local |
| **Claude Code nativo** | `Grep`/`Glob`/leitura direta; sem grafo, sem LSP embutido | Qualquer texto | Produto oficial, muito maduro | N/A — é a baseline "cold" que todos os concorrentes comparam contra | Baseline correta para o eval do §4 |
| **CodeGraph/Potpie** | Grafo de símbolo (AST) exposto via dezenas de tools MCP; "CodeGraph" é nome usado por múltiplos projetos não relacionados (`codegraph-ai`, `colbymchenry`, `CodeGraphContext`) — risco de confusão de marca | 38 linguagens (codegraph-ai) | [verificado: busca web] Um dos "CodeGraph" (`colbymchenry`) cresceu rápido (~54k★, maio/2026) mas é recente; Potpie é produto com camada SaaS (SDLC completo, não só código) | Alegações de terceiros (59% tokens, 49% mais rápido, 70% menos tool-calls) sem harness público equivalente ao SWE-bench do Graft | Issue #386 aberta no Graft pedindo comparação — sem resposta dos mantenedores de nenhum dos lados até 2026-09-16 |
| **Serena MCP** (oraios) | LSP real (go-to-def, find-references, rename) via MCP, nível de símbolo | Qualquer linguagem com LSP disponível | Ativo, comunidade MCP estabelecida | Nenhum benchmark tokens-vs-grep publicado encontrado | Mais "IDE via MCP" que "mapa pré-computado"; sem cache de prosa/resumo — cada consulta é uma chamada LSP ao vivo |
| **ast-grep** | Busca/reescrita estrutural via AST (padrão tipo grep, mas casando nós de sintaxe) | Muitas, via tree-sitter | Maduro, Rust, uso amplo (lint/rewrite) | N/A — não é um índice/grafo, é uma ferramenta de busca pontual | Complementar, não concorrente: resolve "achar padrão exato", não "entender arquitetura" |
| **GitNexus** | Grafo em banco (client-side, roda no browser) + Graph RAG agent, exposto via MCP | Múltiplas | [verificado: busca web] Projeto recente (~abril/2026), menor tração | Alegações de marketing próprio, sem harness público | Exige rodar em browser/motor próprio — mais pesado que arquivos-markdown do Graft |
| **Graphify** (skill local do usuário) | Qualquer input (código, docs, papers, imagens) → grafo de conhecimento → comunidades clusterizadas → HTML+JSON+relatório | Não é específico de código-fonte | Skill pessoal instalada (`~/.claude/skills/graphify`) | N/A | Escopo diferente: conhecimento genérico, não mapa de código para agente; não é substituto nem concorrente direto do Graft |

**Conclusão da comparação:** nenhuma alternativa combina, ao mesmo tempo, (a) zero
servidor/infra externa, (b) custo estrutural \$0 sem chave de API, (c) 23 linguagens
com 8 em fidelidade alta, (d) benchmark próprio metodologicamente sério (SWE-bench
Verified oficial, não só harness caseiro) e (e) integração Windows já testada em
produção pelo tl-orchestrator. Isso sustenta o veredito ADOPT por portar, não por
reavaliar do zero.

## Fontes

- https://github.com/trailhq/Graft (README, `gh api repos/trailhq/Graft`, tags, contributors, commits, issues — consultado 2026-09-16)
- https://github.com/trailhq/Graft/issues/386 (Graft vs CodeGraph, sem resposta)
- https://github.com/trailhq/Graft/issues/71 (comparação com outros grafos de contexto, sem resposta)
- https://github.com/trailhq/Graft/issues/360, /393, /384, /323, /385 (atrito Windows)
- https://registry.npmjs.org/@nanonets/graft (dist-tags, histórico de versão)
- `E:\Documentos\ProjetosIA\tl-orchestrator-release\docs\GRAFT.md` e `scripts/tl_graft.py` (integração de referência)
- https://aider.chat/2023/10/22/repomap.html (Aider repo-map, tree-sitter + PageRank)
- https://anishgandhi.com/aider-pagerank-codebase-ranking/
- https://github.com/oraios/serena (Serena MCP)
- https://github.com/codegraph-ai/CodeGraph, https://github.com/colbymchenry/codegraph, https://github.com/CodeGraphContext/CodeGraphContext (ambiguidade de nome "CodeGraph")
- https://github.com/potpie-ai/potpie
- https://github.com/ast-grep/ast-grep
- https://github.com/abhigyanpatwari/GitNexus / acme-architecture/gitnexus
- `E:\Documentos\ProjetosIA\TL-ADE\docs\specs\2026-09-16-ade-design.md` (linhas 45, 83, 152, 262)
- `E:\Documentos\ProjetosIA\TL-ADE\docs\catalog-sources.md` (linha 25)
