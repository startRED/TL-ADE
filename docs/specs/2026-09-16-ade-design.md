> **Superada em 2026-09-17.** Documento histórico. A arquitetura canônica é `docs/architecture.md`; a spec mestra é `docs/specs/2026-09-17-master-spec.md`. Premissas derrubadas em `docs/research/README.md`.

# TL-ADE — Agentic Development Environment (design v2)

Data: 2026-09-16. Estado: design aprovado em entrevista; v2 incorpora os requisitos adicionais de Erick
(catálogo de skills em escala, fluxo frontend em duas etapas, harness com boas práticas automáticas,
Graft embutido, matriz de capacidades por CLI). Sucessora do tl-orchestrator. A v1 desta spec vive no
clone `tl-orchestrator-release`, ramo `docs/ade-design` (commit `b036d79`); esta é a versão canônica.

## 1. Objetivo

Uma ADE local, universal para qualquer repositório, que recebe um pedido em linguagem natural
("quero melhorar o design", "refaz o frontend inteiro mais profissional"), transforma o pedido em
objetivos claros em camadas e num plano executável com o mínimo de perguntas, executa com agentes de
várias CLIs (Claude Code, Codex, Gemini/Antigravity) sem supervisão, aplica sozinha as melhores práticas
de harness (skills certas, economia de contexto, evals estritos, Graft), e mostra tudo num painel onde o
operador vê os agentes trabalhando e pode assumir o terminal de qualquer um.

Princípios, em ordem de prioridade quando conflitam:

1. **Preguiça do operador.** O operador não conhece método, prompts, skills nem CLIs. A ADE conhece por
   ele: reconhece o tipo de pedido, escolhe skills, roteia modelos, define evals. Ele descreve, responde
   poucas perguntas, aprova um resumo e volta quando quiser.
2. **Autonomia durável.** Um lote aprovado continua sozinho por horas, sobrevive a queda de processo e
   retoma sem repetir efeito já feito. O tl-orchestrator v0.17.0 prova isso; a ADE porta, não reinventa.
3. **Qualidade verificável.** Nenhuma story fecha sem eval executável que pode falhar. Revisão por agente
   de outra família. Interface passa por avaliação visual com rubrica anti-slop e nota mínima.
4. **Economia de tokens.** Contexto novo por story, prompts consolidados, modelo barato para classificar,
   saída de ferramenta filtrada, skills só quando a tarefa pede. Menos-é-mais: instrução que o modelo
   resolveria sozinho é ruído e sai.

## 2. Decisões fixadas

| Decisão | Escolha | Motivo |
| :--- | :--- | :--- |
| Relação com o tl-orchestrator | Sucessora; motor portado, não mantido | Qualidade e experiência acima de reaproveitar código; runtime v0.17.0 vira referência e suíte de paridade |
| Forma da interface | Web app local no navegador | Vários agentes lado a lado; casca desktop (Tauri) opcional depois |
| Nível de intervenção | Terminal completo embutido (PTY real) | Erick digita direto na CLI do agente |
| CLIs na v1 | Claude Code, Codex, Gemini (binário `gemini` ou `antigravity`) | Três famílias; adapter genérico por baixo |
| Planejamento | Entrevista curta (3–5 perguntas) + um ponto de aprovação | Preguiça máxima com um controle |
| Método | Próprio e enxuto, BMAD só como inspiração | Sobrevivem spec falsificável, Maker/Checker separados, portões com evidência |
| Stack | TypeScript ponta a ponta (seção 3) | Melhor terminal embutido existente; um runtime só |
| Chamadas de modelo | Todas pelos adapters de CLI | Uma autenticação; usa assinaturas existentes; sem chave de API obrigatória |
| Skills | Catálogo em escala (dezenas–centenas), seleção automática por pedido | Requisito central: pedido simples vira flow completo com as skills certas |
| Frontend | Fluxo em duas etapas Claude (design) → Codex (engenharia) + guardrails estéticos | Junta o ponto forte de cada família; elimina AI slop na origem |
| Pronto = eval | Toda story exige verificação executável estrita definida no plano | Agente sem critério rígido estagna ou entra em loop (Cherny) |
| Graft | Embutido no harness de todo worktree | Contexto por grafo é mais barato que grep+read |
| Harness | Boas práticas aplicadas automaticamente (seção 12) | O usuário não deve precisar conhecê-las |

## 3. Stack

| Camada | Escolha | Observação |
| :--- | :--- | :--- |
| Runtime | Node 22 LTS, TypeScript estrito, ESM | Um runtime para servidor, motor, CLI e build |
| Monorepo | pnpm workspace: `core` (motor, adapters, servidor, CLI) e `web` (painel) | Dois pacotes porque o Vite precisa do próprio; nada além |
| Servidor local | Fastify + `@fastify/websocket` | Serve painel estático e WebSocket de eventos |
| Terminais | `node-pty` (ConPTY no Windows ≥ 10 1809) + `@xterm/xterm` | O par do VS Code |
| Painel | React 19, Vite, Tailwind 4 | Estático; sem SSR |
| Journal | JSONL com cadeia de hash, um por lote (portado do runtime) | Seção 6; SQLite só como índice derivado |
| Índice | `better-sqlite3`, reconstruível dos JSONL | Consultas do painel e histórico entre lotes |
| Validação | Schemas JSON do runtime validados com `ajv`; tipos por `json-schema-to-typescript` | Contrato preservado literalmente |
| Testes | Vitest; Playwright para painel e loop visual | Paridade com `scripts/tests/test_tl_runtime.py` |
| Empacotamento | `npm i -g @thinglab/ade` → comando `ade` | Tauri fora da v1 |

Descartados: Rust/Tauri como núcleo (gargalo é LLM, não CPU); Python (dois runtimes); Electron (peso sem ganho).

## 4. Arquitetura

Um processo Node (`ade serve`) e um painel no navegador:

```
navegador ── WebSocket ──┐
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ ade serve (Node)                                               │
│  ┌──────────┐  ┌────────────┐  ┌───────────┐  ┌───────────┐    │
│  │ tradutor │→ │ engine     │→ │ adapters  │→ │ PTYs      │    │
│  │ + pesq.  │  │ DAG+journal│  │ claude/   │  │ node-pty  │    │
│  │ + skills │  │ + portões  │  │ codex/    │  │ 1 por     │    │
│  │ + evals  │  │ + loop vis.│  │ gemini    │  │ agente    │    │
│  └──────────┘  └────────────┘  └───────────┘  └───────────┘    │
│        ▲              │                            │            │
│        └── eventos ───┴──── journal.jsonl ─────────┘            │
│                             índice.sqlite (derivado)            │
│  catálogo ~/.ade/catalog/ ── graft (grafo por worktree)         │
└────────────────────────────────────────────────────────────────┘
                git worktrees por story em <repo>/.ade/wt/
```

Estado por repositório em `<repo>/.ade/` (config, lotes, journals, worktrees). Estado global em
`~/.ade/` (catálogo de skills, índice SQLite, preferências).

## 5. Adapters de CLI e terminais

Interface única:

```ts
interface AgentAdapter {
  readonly family: "claude" | "codex" | "gemini";
  readonly capabilities: CapabilitySet;   // seção 13
  spawn(opts: { cwd: string; prompt: string; mode: "headless" | "interactive";
                resume?: string; model?: string; effort?: string;
                allowedTools?: string[]; attachments?: string[] }): AgentProcess;
  parseEvents(chunk: string): AgentEvent[];   // texto, tool_use, custo, fim
  costOf(events: AgentEvent[]): CostReport;    // { usd: number | "unknown", tokens }
}
```

Regras:

- **Headless por padrão** (`claude -p --output-format stream-json`, `codex exec --json`, saída JSON do
  Gemini quando disponível), rodando dentro de PTY para o painel espelhar com cores.
- **Assumir o terminal**: pausa no checkpoint (fim da chamada atual) → relança a mesma CLI interativa no
  mesmo worktree com resume (`--resume <sessionId>` / `codex resume <id>`) → step `human_takeover` no
  journal. Ao soltar, `human_release` grava a árvore como checkpoint e o ciclo retoma (contain → gates →
  review). Digitação do operador não é interpretada; só o resultado na árvore.
- **Gemini/Antigravity**: o acesso consumidor do Gemini CLI acabou em 2026-06-18 (migrado para
  Antigravity CLI; Gemini CLI segue via Code Assist pago/API). O adapter `gemini` detecta qual binário
  existe (`gemini` ou `antigravity`) no `ade doctor` e usa o disponível; mesma família para fins de
  revisão cruzada.
- Custo desconhecido gera aviso, nunca bloqueio (regra do runtime). Cada adapter tem CLI falsa em
  `fixtures/` para testes sem rede.
- Windows: `claude` resolve para `claude.cmd` (nunca assumir PATH); prompt do `claude -p` antes de
  `--allowedTools`.

## 6. Engine, journal e durabilidade

Porte fiel do `scripts/tl_runtime.py` (documentado em `docs/RUNTIME.md` do tl-orchestrator):

- Mesmo modelo de **Step** (`step_intent` antes do efeito, `step_result` depois, `tree_before`/
  `tree_after`, cadeia de hash `prev`), mesmas classes de efeito e mesma tabela de reconciliação na
  retomada. Novas classes: `human_takeover`, `human_release`, `visual_eval`, `research`, `eval_run`.
- **Journal JSONL**, um por lote em `<repo>/.ade/lotes/<id>/journal.jsonl`, escritor único com lock,
  `fsync` por linha. SQLite (`~/.ade/index.sqlite`) é índice derivado, reconstruível
  (`ade index --rebuild`); o painel só lê do índice.
- **Scheduler** com os mesmos estados e a mesma regra de próxima unidade; concorrência 1 na v1.
- **Ciclo da story:** `prepare → implement → contain → gates → review → rework(≤N) → commit → push →
  pull_request → ci → merge → complete`. `gates` sempre inclui o **eval da story** (seção 7); story de UI
  inclui o loop visual (seção 10).
- **Falhas e movimentos**: mesmas classes (`retry`, `rework`, `park`, `stop`), mesmo detector de loop
  (assinatura normalizada, oscilação de árvore, estagnação do Checker), orçamentos por story e por lote.
- **Escalação para humano** vira item na fila do painel (`retry`/`skip`/`assumir terminal`) +
  notificação de sistema opcional.
- Entrega: PR com merge commit (`--merge`), nunca squash; `gh` para PRs.

Config por repositório em `<repo>/.ade/config.json`, validada por schema estendido
(`panel`, `visual`, `research`, `catalog`, `harness`, `evals`). Campo fora do schema é recusado.

## 7. Tradutor de intenção e evals

Sessão do orquestrador via adapter `claude`, headless, protocolo de saída estruturada:

1. **Classificar.** Classificador barato (Haiku via `claude -p --model haiku`) lê pedido + mapa do repo
   (via Graft) e devolve tamanho `S`/`M`/`L` e domínios detectados (frontend, API, infra, dados, 3D...).
2. **Expandir em camadas.** O pedido simples vira objetivos em camadas: intenção → resultados
   observáveis → restrições → critérios de pronto. Exemplo: "quero melhorar o design" vira direção
   estética a escolher, páginas/estados no escopo, guardrails tipográficos e de cor, evals visuais.
   É esta expansão que as perguntas da entrevista confirmam, não o pedido cru.
3. **Pesquisar** se houver incógnitas (seção 8).
4. **Entrevistar.** Máximo cinco perguntas, uma por vez, múltipla escolha com recomendação primeiro.
   Pergunta cuja resposta está no repositório é proibida.
5. **Emitir o plano** validado por `plan.schema.json`: epics, stories com spec falsificável
   (aceite verificável, arquivos:linhas, fronteiras invioláveis), dependências, skills por story,
   **eval por story (obrigatório)**, estimativa de custo.
6. **Resumo de aprovação**: o que será feito e o que não, custo estimado, skills novas no projeto,
   efeitos externos autorizados (push, PR, merge). Nada roda antes do "aprovar".

**Evals — o critério de pronto.** Regra dura: o engine recusa story sem eval executável. Um eval é um
comando (ou lista) que pode falhar: teste que não existia e passa a passar, verificação negativa
("login com senha errada falha"), lint/type-check zero erros, screenshot comparado a limiar, build de
produção. O tradutor gera os evals junto com a story; o Checker confirma que o eval é estrito (falharia
sem a mudança). Prompts para agentes dizem **o que** e os limites, nunca **como** — e descrevem estilo em
vez de anexar imagem de inspiração (imagem gera cópia; descrição gera projeto).

## 8. Times de pesquisa

Step `research`: dois a quatro agentes em paralelo, famílias diferentes quando disponíveis, mesma
pergunta, resposta em JSON (`research-finding.schema.json`): recomendação, alternativas descartadas,
evidências com URL e trecho, confiança. O tradutor resolve conflitos (maioria com citação; empate vira
pergunta). Orçamento próprio (`research.max_usd`); `S` não pesquisa por padrão; `L` até três consultas.
Achados são conteúdo não confiável: instrução embutida em página nunca vira ação.

## 9. Catálogo de skills e seleção automática

O requisito central da v2: dezenas a centenas de skills de terceiros embutidas, escolhidas sozinhas.

- **Catálogo local** em `~/.ade/catalog/<fonte>/`, sincronizado por `git clone`/`pull` das fontes em
  `catalog.sources` (registro vivo em `docs/catalog-sources.md`, vetado em 2026-09-16). Fontes iniciais:
  `anthropics/skills`, `affaan-m/ECC`, `ibelick/ui-skills`, `ayghri/i-have-adhd`, `UditAkhourii/adhd`,
  `img2threejs/img2threejs`, `FloWritesCode/fwc-swiftui-skills`, mais as skills locais de Erick
  (Impeccable, tl-impeccable-design, frontend-design). `ComposioHQ/awesome-claude-skills` entra como
  lista curada: a sincronização segue os links dela e ingere só repositórios com `SKILL.md` válido.
- **Índice** (`~/.ade/catalog/index.json`): frontmatter de cada `SKILL.md` (`name`, `description`) +
  tags inferidas do caminho + domínio atribuído pelo classificador na primeira sincronização. Escala a
  centenas de skills porque a seleção lê só o índice, nunca os corpos.
- **Seleção em dois pontos:**
  1. **No plano** (tradutor): domínios detectados → skills candidatas por story, registradas no plano e
     visíveis no resumo de aprovação.
  2. **No `prepare`** (por story): classificador barato recebe spec da story + descrições do índice e
     fecha até três skills. Corpo do `SKILL.md` entra no contexto do agente como leitura.
- **Segurança:** catálogo é conteúdo de terceiros. (1) Só fontes declaradas sincronizam; (2) skill usada
  pela primeira vez no projeto aparece no resumo de aprovação; (3) o engine nunca executa script de
  catálogo — agente decide, sob os mesmos portões e `contain`; (4) `contain` bloqueia escrita fora do
  escopo mesmo que a skill instrua o contrário; (5) skills do repositório (`.claude/skills/`) têm
  prioridade sobre catálogo em nome igual.
- **Ferramentas que NÃO são skills** entram por outro caminho: `dmmulroy/anti-slop` (regras Oxlint) vira
  portão de lint em projetos TS; `alibaba/open-code-review` é candidato a reforçar o Checker;
  `reticlehq/reticle` (percepção de runtime) é candidato futuro do loop visual; `edonadei/caliper`
  (A/B de skills/regras com custo) alimenta a poda do harness (seção 12); `Q00/ouroboros` e
  `JayPokale/Chisle` ficam como inspiração (evolução de agente; compressão de saída — já coberta por
  rtk/caveman/ponytail).

## 10. Loop de qualidade visual (frontend)

Ativa quando a story tem portão `visual`. Fluxo em **duas etapas de implementação** + avaliação:

1. **Direção e design (Claude).** Maker `claude` com skill de design (Impeccable /
   `tl-impeccable-design` / frontend-design) declara a direção estética (ex.: editorial, brutalist,
   luxury) antes de codar e produz os componentes de alta fidelidade: layout exato, hex das cores,
   tipografia. Guardrails estéticos fixos no contrato do prompt:
   - fontes genéricas banidas (Arial, Roboto, Inter, Space Grotesk); pares tipográficos com personalidade;
   - paleta coesa via CSS variables, cor dominante + acentos nítidos, nunca cinzas tímidos uniformes;
   - motion CSS-first, micro-interações de alto impacto no carregamento, não efeitos espalhados;
   - estados completos (vazio, carregando, erro, foco, hover) desde o primeiro comp.
2. **Engenharia (Codex).** O tradutor gera um refactoring prompt + rastreador `.md`; Maker `codex`
   recebe o código do passo 1 e estrutura a arquitetura de produção (estados, temas, componentes
   robustos) numa passada limpa. Checker continua de família diferente do último que editou.
3. **Capturar.** Playwright sobe `visual.serve_command`/`visual.url`, screenshots das rotas/estados
   (`visual.routes`, padrão `/`) em 1280 e 390, claro e escuro quando o projeto declara. Console e rede
   limpos são pré-condição.
4. **Avaliar.** Avaliador de família diferente recebe screenshots + spec + rubrica e devolve JSON
   (`visual-eval.schema.json`): nota 0–10 por critério, defeitos com posição e severidade, nota final.
   Rubrica: hierarquia e espaçamento; tipografia; contraste acessível (WCAG AA); estados completos;
   responsividade; consistência com `DESIGN.md` quando existe; ausência de clichês de IA.
5. **Decidir.** Passa com todos os critérios ≥ 7, final ≥ 8, zero `critical`. Senão defeitos viram
   rework (dentro do limite da story) e volta ao passo 3. Teto `visual.max_rounds` (padrão 4) e custo;
   estourou → `awaiting_operator` com histórico de notas no painel.
- **Assets por imagem:** quando a story precisa de imagem (logo, ilustração, textura, mockup de
  referência interna), o engine usa o `$imagegen` do Codex (gpt-image-2, até 16 imagens de referência,
  1K–4K) como step `model_call` do adapter `codex`. Imagens geradas nunca entram como "inspiração para
  copiar" no prompt de design — só como asset final ou material de comparação do avaliador.

## 11. Painel

Três áreas numa página: **Chat** (pedido, cartões de pergunta, resumo de aprovação, escalações — cada
mensagem linka o step do journal), **Missão** (plano vivo: epics → stories, estado, custo, nota visual,
ações pausar/pular/reordenar/diff/PR) e **Agentes** (grade de terminais xterm.js com título, custo,
botão "assumir", indicador headless/interativo; histórico por story). Um WebSocket por navegador;
servidor só em `127.0.0.1`, recusa outras origens; sem autenticação na v1.

## 12. Harness automático e economia de contexto

As boas práticas que o operador não deve precisar conhecer, aplicadas pelo engine em todo agente:

| Prática | Como a ADE aplica |
| :--- | :--- |
| Contexto limpo por tarefa | Cada story roda em sessão nova da CLI (equivalente automático do `/clear`); nada de sujeira entre stories |
| Prompts consolidados | O engine monta UM prompt por chamada com spec + skills + contexto Graft; nunca pinga instrução em turnos |
| Roteamento de modelo | Classificação e seleção em modelo barato (Haiku); implementação no modelo forte da família; effort padrão médio, elevado só quando a spec marca complexidade alta |
| Hierarquia de informação | Prompt → regras do projeto (`CLAUDE.md`/`AGENTS.md` mínimos) → skill (lida sob demanda) → MCP só quando a informação é inacessível de outro jeito; CLI antes de MCP sempre |
| Saída filtrada | Portões rodam via wrapper que descarta o que passou e devolve só falhas (o padrão dos hooks de filtro); caps de tamanho de saída de terminal para o modelo |
| Rewind ≈ checkpoint | Erro no meio da story não é "corrigido por cima": a árvore volta ao checkpoint gravado e o rework parte limpo (já é o modelo do runtime) |
| Menos-é-mais | `ade doctor` inclui um passe de poda: instrução de config que o modelo resolveria sozinho é apontada para remoção; medição A/B estilo Caliper (rodar com e sem skill/regra, comparar resultado e custo) valida o que fica |
| Graft embutido | `ade` roda `graft init`/`build` por worktree; prompts instruem graft-first (ask/grep/skeleton/callers antes de grep+read); `ade doctor` verifica o grafo |
| Monitoramento | Custo por story/lote no painel (journal já grava); ranking do que drena tokens |
| Advisor próprio | Sem advisor nativo das CLIs; a segunda opinião é o Checker de outra família com contexto mínimo (diff + spec), nunca o histórico inteiro |
| Rotinas > workflows dinâmicos | Backlog v2: `ade routines` — lotes recorrentes de manutenção (limpar código morto, escrever testes de features novas, mesclar duplicação) agendados, cada um com eval próprio |

## 13. Matriz de capacidades e roteamento de papéis

Tabela viva (config `harness.capabilities`, atualizada quando as CLIs mudam):

| Família | Forças (2026) | Papéis preferidos na ADE |
| :--- | :--- | :--- |
| Claude Code | Melhor implementador multi-arquivo; skills/hooks/subagentes; sandbox de SO | Maker padrão; etapa de design do fluxo frontend; tradutor de intenção |
| Codex | Melhor revisor; CI-nativo; `$imagegen` com gpt-image-2 (16 refs, 1K–4K); nativo no Windows | Checker padrão; etapa de engenharia do fluxo frontend; geração de assets de imagem |
| Gemini/Antigravity | Contexto 1M; multimodal; pesquisa barata (quando acessível — ver seção 5) | Time de pesquisa; leitura de bases grandes; terceira opinião em conflito |

O tradutor usa esta matriz ao montar o plano: papel de cada story já sai com a família certa. Quando uma
família está indisponível (sem assinatura, binário ausente), o `ade doctor` reporta e o roteamento
degrada para as disponíveis, mantendo Maker ≠ Checker.

## 14. Sub-projetos e ordem

Cada um com spec própria derivada desta, plano e ciclo de entrega:

1. **Núcleo** — monorepo, engine portado (journal JSONL + índice SQLite), adapter `claude` com CLI
   falsa, evals como portão, `ade run <lote>` sem painel. Pronto: paridade com a suíte Python + dogfood
   de um lote real de uma story.
2. **Painel e adapters** — `ade serve`, três áreas, PTY com "assumir", adapters `codex` e
   `gemini/antigravity`, matriz de capacidades. Pronto: assumir terminal no meio de story, soltar, engine
   retoma do checkpoint.
3. **Tradutor, evals e pesquisa** — classificador, expansão em camadas, entrevista, time de pesquisa,
   plano com evals obrigatórios, resumo de aprovação. Pronto: pedido de uma frase vira lote executado
   ponta a ponta com eval estrito.
4. **Catálogo de skills** — sincronização das fontes, índice, seleção em dois pontos, regras de
   segurança, anti-slop como portão TS. Pronto: "quero melhorar o design" seleciona sozinho as skills de
   design certas.
5. **Loop visual** — duas etapas Claude→Codex, guardrails, captura, avaliador, rubrica, `$imagegen`.
   Pronto: story de UI reprovada na rodada 1 passa até a rodada 4 sem intervenção.

**Backlog v2** (fora da v1, ordem a decidir): rotinas recorrentes (`ade routines`); poda medida do
harness (Caliper-style A/B + passe doctor a cada modelo novo); Reticle para percepção de runtime no loop
visual; open-code-review no Checker; concorrência de worktrees; casca Tauri; SDK direto da API; sandbox
de FS do worker; multiusuário.

## 15. Testes

- **Paridade do engine:** cada caso de `test_tl_runtime.py` portado para Vitest com o mesmo nome; os 10
  casos com falha pré-existente no Windows devem passar nos dois sistemas.
- **Adapters:** CLIs falsas cobrem saída normal, truncada, custo ausente, resume, ANSI.
- **Journal:** cadeia de hash quebrada é recusada; índice reconstruído idêntico ao incremental.
- **Tradutor:** fixtures de pedidos ("quero melhorar o design", "refaz o frontend", bugfix simples) com
  plano esperado: tamanho, domínios, skills selecionadas, evals gerados.
- **Painel:** Playwright cobre entrevista, assumir/soltar terminal, escalação.
- **Loop visual:** fixture ruim precisa reprovar; fixture boa passa em uma rodada.
- **Dogfood de release:** antes de cada versão, a ADE constrói uma story dela mesma.

## 16. Riscos e mitigações

| Risco | Mitigação |
| :--- | :--- |
| `--resume` infiel em alguma CLI | "Assumir" degrada para sessão nova no worktree com "continue do checkpoint"; journal registra o modo |
| Custo do loop visual escapa | Teto de rodadas e custo; avaliador em modelo mais barato que o Maker |
| Catálogo em escala injeta instrução maliciosa | Skills só como leitura; `contain` inviolável; primeira aparição exige aprovação; fontes só declaradas |
| Catálogo em escala polui seleção (skills demais parecidas) | Seleção lê só índice; máximo 3 skills por story; medição Caliper-style poda as que não ajudam |
| Porte do engine diverge do runtime | Suíte de paridade obrigatória; comportamento novo só com teste novo |
| Gemini inacessível (migração Antigravity) | Adapter detecta binário; roteamento degrada para duas famílias |
| ConPTY em Windows antigo | `ade doctor` verifica; erro claro |
| Eval frouxo aprova trabalho ruim | Checker valida que o eval falharia sem a mudança; eval que nunca falhou em rework algum é sinalizado |

## 17. Perguntas resolvidas

- **Por que JSONL e não SQLite como journal?** Um escritor, poucas mil linhas por lote, greppável, à
  prova de edição; índice derivado dá as consultas.
- **Por que tudo por CLI e não pela API?** Uma autenticação, assinaturas existentes, três famílias com o
  mesmo mecanismo; fixtures cobrem o custo de depender do formato de saída.
- **Por que skills de catálogo como leitura e não instalação?** Segurança (conteúdo de terceiros) e
  economia (só entra no contexto quando selecionada).
- **Por que duas etapas no frontend?** Claude projeta melhor; Codex estrutura melhor; a divisão é a
  recomendação convergente da comunidade em 2026 e casa com Maker ≠ Checker.
- **Por que evals mandatórios?** "Pronto" sem verificação estrita é a causa número um de agente
  estagnado; um eval que pode falhar substitui supervisão humana.
