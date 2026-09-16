# Matriz de fontes de skills e o padrão Agent Skills — pesquisa para o Skill Fabric da ADE

Data: 2026-09-16. Método: `gh api` + clone raso (`--depth 1`) de cada repositório + análise estática
local dos `SKILL.md`; docs oficiais para o padrão; CLIs instaladas (`codex 0.154.0`, `gemini 0.59.0`,
`claude 2.1.271`) inspecionadas na máquina. Tudo que é contagem ou tamanho abaixo foi **medido**, não
lido de README.

Commits fixados na medição (use como `pin` inicial do catálogo):

| Fonte | Commit | Data do commit |
| :--- | :--- | :--- |
| `anthropics/skills` | `34040c9` | 2026-09-10 |
| `affaan-m/ECC` | `8321021` | 2026-09-12 |
| `ComposioHQ/awesome-claude-skills` | `be2a406` | 2026-07-24 |
| `ayghri/i-have-adhd` | `0a84de4` | 2026-09-15 |
| `UditAkhourii/adhd` | `16dc239` | 2026-08-29 |
| `ibelick/ui-skills` | `c5bcd86` | 2026-09-15 |
| `img2threejs/img2threejs` | `6e60b5e` | 2026-09-06 |
| `FloWritesCode/fwc-swiftui-skills` | `c2454e6` | 2026-09-10 |

---

## 1. Achados que mudam a spec v2

Quatro, em ordem de impacto.

1. **`ComposioHQ/awesome-claude-skills` não é uma lista curada.** A spec §9 diz "entra como lista
   curada: a sincronização segue os links dela e ingere só repositórios com `SKILL.md` válido". Medido:
   o repositório **contém 864 `SKILL.md` vendorizados** — 832 gerados por template sob
   `composio-skills/` e 32 escritos à mão na raiz. O plano de ingestão descrito na spec não se aplica
   ao que o repositório é hoje. [verificado: clone `be2a406`, 2026-07-24]
2. **Redistribuição de material proprietário da Anthropic.** `anthropics/skills` **não tem LICENSE de
   repositório**; o licenciamento é por skill. 4 das 19 skills (`docx`, `pdf`, `pptx`, `xlsx`) trazem
   `license: Proprietary` com texto "© 2025 Anthropic, PBC. All rights reserved" que proíbe
   explicitamente "Extract these materials from the Services or retain copies of these materials
   outside the Services", "Reproduce or copy these materials" e "Create derivative works". Essas mesmas
   quatro estão copiadas em `ComposioHQ/awesome-claude-skills/document-skills/` — num repositório **sem
   nenhuma LICENSE**. [verificado: `anthropics_skills/skills/pdf/LICENSE.txt` e
   `ComposioHQ_.../document-skills/docx/LICENSE.txt`, 2026-09-16]
3. **Claude Code não lê `.agents/skills/`; Codex e Gemini leem.** O caminho `.agents/skills/` virou a
   convenção interoperável entre fornecedores, mas a Claude Code documenta explicitamente que **não**
   o suporta. Isso mata a ideia de "um diretório de catálogo que as três CLIs descobrem sozinhas" e
   valida a decisão da spec §9 de injetar o corpo do `SKILL.md` **como leitura** em vez de instalar.
   [verificado: code.claude.com/docs/en/skills; learn.chatgpt.com/docs/build-skills;
   geminicli.com/docs/cli/skills; e `gemini skills list --all` local resolvendo
   `C:\Users\Erick\.agents\skills\...`]
4. **ECC tem 292 skills, não 903.** O clone tem 903 arquivos `SKILL.md`, mas só **294 nomes únicos**:
   609 são espelhos multi-CLI (`.agents/`, `.cursor/`, `.kiro/`) e traduções (`docs/es/skills/…`). O
   diretório canônico é `skills/` com 292. [verificado: clone `8321021`]

---

## 2. Matriz de decisão por fonte

Contagens medidas: "skills" = diretórios com `SKILL.md` no caminho canônico, deduplicados por nome.
"tok" = tokens estimados a 4 bytes/token.

| Projeto | Skills (medido) | Licença | Problema que resolve | Ideias úteis | Custo (índice / corpo mediano) | Risco | Compatibilidade | **Decisão** |
| :--- | ---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `anthropics/skills` | 19 | **Por skill**: 15 Apache-2.0, 4 **Proprietary** | Referência canônica do formato; document/office, design, MCP builder | `skill-creator` (33 KB) é o melhor guia de autoria existente; `spec/` no repo; progressive disclosure real em 6 de 19 | 133 tok/skill · 2.1k tok mediano (p90 8.2k; `claude-api` tem 86 KB ≈ 21k tok) | **Legal**, não técnico: 4 skills não podem ser copiadas p/ `~/.ade/catalog/` | Formato canônico; roda em tudo | **ADOPT** — sincronizar só as 15 Apache; `docx/pdf/pptx/xlsx` na denylist |
| `affaan-m/ECC` | 292 | MIT | Volume e cobertura de domínio (TDD, security, 40 `*-patterns` de linguagem/framework, ops) | AgentShield (scan de prompt/hook/MCP/secret como parte do harness); adaptadores por CLI com manifesto de propriedade e `--dry-run`; `origin:`/`metadata:` no frontmatter | 81 tok/skill → **23.5k tok** se todo o índice entrar · 1.9k tok mediano (p90 4.5k) | **Alto**: 124 scripts dentro de `skills/`; `install.sh` na raiz + instaladores por CLI; 44 `SKILL.md` batem em heurística de injeção (revisão manual: prosa legítima, mas a superfície é grande) | Melhor do conjunto: Claude (plugin), Codex (plugin nativo `ecc@ecc`), Cursor/OpenCode/Gemini/Zed/Copilot/Antigravity/Qwen via adaptador | **ADAPT** — ingerir só `skills/` (nunca `install.sh`, nunca `hooks/`), filtrar por domínio no índice, quarentena de scripts |
| `ComposioHQ/awesome-claude-skills` | 32 à mão + 832 template | **NENHUMA** | — (era esperado: lista curada) | Taxonomia de domínios do `README`; `requires: {mcp: [rube]}` é um precedente útil de campo de dependência | 832 auto: 37 tok/skill → **30.4k tok** de índice para wrappers idênticos | **Alto**: 12 dos 32 escritos à mão têm o mesmo nome de skills da Anthropic, 5 são **byte-idênticos**, e `document-skills/` redistribui as 4 proprietárias — sem licença no repo | Os 832 só funcionam com Rube MCP (Composio) conectado | **REJECT** (subtree `composio-skills/` e `document-skills/`) / **REFERENCE** (os ~20 originais à mão, se relicenciados) |
| `ayghri/i-have-adhd` | 1 (+1 espelho) | MIT | Disciplina de saída: impede enterrar a resposta | `disable-model-invocation: true` (skill só por invocação explícita) + `metadata: {tags, category}` — exatamente a extensão de metadata que a ADE precisa | 69 tok · 1.8k tok | Baixo (19 scripts, todos fora da skill) | Formato puro; roda em tudo | **ADOPT** |
| `UditAkhourii/adhd` | 1 | MIT | Tree-of-thought com poda para decisões abertas (design, naming, API) | Descrição de 534 chars com **gate negativo explícito** ("Skip for syntax, lookups, bugs with known root cause") — modelo de descrição acionável | 140 tok · 2.8k tok | Baixo-médio: implementação em TS sobre Agent SDK; a skill em si é texto | Formato puro | **ADOPT** (a skill) / **REFERENCE** (o runtime TS) |
| `ibelick/ui-skills` | 7 | MIT | Design engineering: auditoria de UI, acessibilidade, motion, metadata | `improve-ui` declara **fronteiras invioláveis no corpo** ("Never modify product source", só escreve em `design-plans/`) e separa auditoria de execução — casa direto com o `contain` e o fluxo frontend em duas etapas da spec §10 | 72 tok/skill · 1.2k tok mediano | Baixo (os 77 scripts são o site Astro de demo, fora de `skills/`) | Formato puro | **ADOPT** |
| `img2threejs/img2threejs` | 1 (+ `skills/`) | Apache-2.0 | Imagem de referência → Three.js procedural com gate de qualidade | Gate de qualidade objetivo antes de aceitar o resultado — padrão reaproveitável pelo Checker | 78 tok · **8.2k tok** (32 KB, acima do recomendado de 5k) | Médio: 235 scripts Python no repo (pipeline, não a skill) | Formato puro | **ADAPT** — só se o domínio 3D aparecer; o corpo precisa de progressive disclosure antes de entrar |
| `FloWritesCode/fwc-swiftui-skills` | 2 (+2 espelhos) | MIT | SwiftUI moderno (Liquid Glass, iPhone Duo) | Descrição em `>-` (block scalar) listando **gatilhos por API** ("ArrangementView, ViewThatFits, AnyLayout") — melhor prática de descrição por keyword | 98 tok/skill · 2.9k tok | **Zero scripts** — fonte mais limpa do conjunto | Espelha `skills/` e `.agents/skills/` | **ADOPT** — irrelevante para a stack atual; manter fora do índice até existir projeto Apple |

### Fontes ausentes do registro que deveriam entrar

| Fonte | Por quê | Decisão sugerida |
| :--- | :--- | :--- |
| `openai/skills` (27.3k ★, sem licença declarada) | Catálogo oficial do Codex: 39 skills em `skills/.curated` + 5 em `skills/.system`. Já está instalado localmente em `~/.codex/skills/.system/` (`imagegen`, `skill-creator`, `skill-installer`, `review-agent`, `openai-docs`, `plugin-creator`) | **ADOPT** como fonte, **mas** licença ausente = mesmo bloqueio legal do Composio; usar como **REFERENCE** até esclarecer |
| `agentskills/agentskills` (25.4k ★, **Apache-2.0**) | Spec normativa + biblioteca `skills-ref` com `skills-ref validate ./my-skill` | **ADOPT** como validador do pipeline de ingestão |
| `vercel-labs/skills` (31.7k ★, MIT, npm `skills@1.5.26`) | Instalador/registry `npx skills find|add|list`, backend skills.sh | **REFERENCE** — não usar como instalador (ver §5) |

---

## 3. O padrão Agent Skills (spec aberta)

[verificado: agentskills.io/specification, acessado 2026-09-16; repo `agentskills/agentskills`,
Apache-2.0, criado 2025-12-16, último push 2026-08-09; **sem releases versionadas** — a spec é
"living", não numerada]

Origem: formato criado pela Anthropic e liberado como padrão aberto.

### Frontmatter normativo

| Campo | Obrigatório | Restrição |
| :--- | :--- | :--- |
| `name` | **Sim** | 1–64 chars, `a-z0-9-`, sem hífen inicial/final, sem `--`, **deve bater com o nome do diretório pai** |
| `description` | **Sim** | 1–1024 chars, não vazio; deve dizer *o que faz* e *quando usar* |
| `license` | Não | Nome da licença ou referência a arquivo empacotado |
| `compatibility` | Não | ≤500 chars; requisitos de ambiente (produto alvo, pacotes, rede) |
| `metadata` | Não | **Mapa string→string arbitrário**; "Clients can use this to store additional properties not defined by the Agent Skills spec" |
| `allowed-tools` | Não | String separada por espaço (`Bash(git:*) Bash(jq:*) Read`). **Experimental**, suporte varia |

Layout: `skill-name/SKILL.md` + opcionais `scripts/`, `references/`, `assets/`. "A skill directory may
contain any files and directories beyond the required `SKILL.md`."

### Progressive disclosure (3 estágios, normativo)

1. **Metadata** (~100 tokens): `name` + `description` de **todas** as skills carregadas no startup.
2. **Instructions** (**< 5000 tokens recomendado**): corpo do `SKILL.md` ao ativar. "Keep your main
   `SKILL.md` under 500 lines."
3. **Resources**: `scripts/`/`references/`/`assets/` sob demanda. Referências relativas, **um nível de
   profundidade**.

### Quem consome e como — matriz de descoberta

| Produto | Diretórios de descoberta | Automático? | Observação decisiva |
| :--- | :--- | :--- | :--- |
| **Claude Code** 2.1.271 | `~/.claude/skills/`, `.claude/skills/` (projeto, aninhado, enterprise, `--add-dir`), `<plugin>/skills/` | Sim, no startup | **Não suporta `.agents/skills/`.** Frontmatter estendido próprio (`when_to_use`, `disable-model-invocation`, `user-invocable`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `paths`, `hooks`, `shell`, `arguments`). `description`+`when_to_use` **truncados em 1536 chars** na listagem |
| **Codex** 0.154.0 | `.agents/skills` (cwd → raiz do repo), `$HOME/.agents/skills`, `/etc/codex/skills`, built-ins. Local: `~/.codex/skills/` também povoado | Sim ("Codex detects skill changes automatically") | Listagem inicial limitada a **2% da janela de contexto ou 8000 chars**; descrições são encurtadas e **skills podem ser omitidas com aviso**. Metadata extra vai em `agents/openai.yaml` (`allow_implicit_invocation`, `dependencies`). `codex plugin` existe; **não há `codex skills` no CLI** |
| **Gemini CLI** 0.59.0 | built-in → extensão → `~/.gemini/skills/` **ou** `~/.agents/skills/` → `.gemini/skills/` **ou** `.agents/skills/`. `.agents/` tem precedência no mesmo tier | Sim — injeta `name`+`description` de todas as habilitadas no system prompt | CLI de primeira classe: `gemini skills list/enable/disable/install/link`. `install` pede **consentimento de segurança**; `--consent` pula o prompt. Ativação chama `activate_skill` e **mostra confirmação com o diretório que o agente vai acessar** |
| Cursor, Copilot/VS Code, OpenCode, Goose, Amp, Kiro, Roo, Factory, Letta, Junie, OpenHands, Mistral Vibe, Spring AI, Laravel Boost, Snowflake Cortex, Databricks Genie, Pulumi Neo… | — | — | ~45 produtos listados no Client Showcase com link para a doc de cada um |

**Consequência para a ADE:** não existe um diretório único que Claude, Codex e Gemini leiam. Ou a ADE
materializa por CLI (`.claude/skills/` + `.agents/skills/`), ou injeta o corpo no prompt. A spec §9 já
escolhe injeção — **decisão confirmada**, e agora com motivo técnico registrado, não só de segurança.

---

## 4. Decisão 2 — formato de metadata do catálogo

**Extensão do Agent Skills spec, não spec pura.** O próprio spec prevê o mecanismo: `metadata` é um
mapa arbitrário e "Clients can use this to store additional properties not defined by the Agent Skills
spec". A ADE não inventa nada: ela escreve seus campos **dentro de `metadata`** e mantém o `SKILL.md`
upstream válido e revalidável por `skills-ref validate`.

Precedente na natureza: `ayghri/i-have-adhd` já usa `metadata: {tags, category}`; ECC usa
`metadata: {origin}` em 307 arquivos; Codex põe sua extensão num arquivo lateral (`agents/openai.yaml`);
Composio inventou um campo de topo (`requires:`) — que é exatamente o que **não** se deve fazer, porque
quebra validadores estritos.

Regra: o `SKILL.md` no catálogo fica **byte-idêntico ao upstream** (necessário para verificar hash e
pin). A extensão da ADE vive no `index.json`, não dentro do arquivo de terceiro. Campos:

| Campo do índice | Origem | Para quê |
| :--- | :--- | :--- |
| `name`, `description` | frontmatter upstream | seleção (é o único que o classificador lê) |
| `source`, `path`, `commit`, `sha256` | git + hash do arquivo | pin e detecção de mudança entre syncs |
| `license` | **por skill**, não do repositório | bloqueio legal (ver `anthropics/skills`) |
| `domain[]` | classificador na 1ª sync | filtro que impede 30k tokens de índice |
| `tags[]` | caminho + frontmatter | desempate na seleção |
| `families[]` | medido | `claude` \| `codex` \| `gemini` — quem consegue consumir |
| `trust` | política local | `vendor` \| `vetted` \| `quarantine` (ver §6) |
| `has_scripts`, `script_paths[]` | scan da árvore | gate: skill com script nunca sobe de `quarantine` sem revisão |
| `body_tokens` | medido | orçamento de contexto por story |
| `first_seen_in_project` | estado do projeto | aciona o resumo de aprovação da spec §9 |

`compatibility` (≤500 chars, campo do spec) é o lugar certo para "precisa de Rube MCP", "precisa de
Python 3.14" — a ADE deve **ler** esse campo quando existir e derivar dele um gate de pré-requisito.

---

## 5. Decisão 3 — quantas skills de qualidade e quanto custa

### Contagem bruta vs. útil

| Camada | Skills | Comentário |
| :--- | ---: | :--- |
| Bruto (soma dos `SKILL.md` clonados) | **1 188** | inclui espelhos e templates |
| Menos espelhos multi-CLI/traduções do ECC | 1 188 → **1 179** (294 nomes ECC, canônico 292) | 609 arquivos eram cópias |
| Menos os 832 wrappers Rube do Composio | **347** | idênticos entre si a menos do nome do toolkit |
| Menos duplicatas entre fontes (12 nomes, 5 byte-idênticas) | **335** | Composio copiando Anthropic |
| Menos as 4 proprietárias da Anthropic + 4 cópias no Composio | **327** | bloqueio legal |
| **De qualidade** (descrição acionável, corpo autocontido, sem dependência de MCP proprietário) | **≈ 320 nomes**, dos quais **~60–80 relevantes para a stack da ADE** (TS/React/Python/design/agentic) | os 40 `*-patterns` do ECC cobrem Django/Laravel/SpringBoot/Kotlin/Perl — inertes aqui, mas custam índice |

Ou seja: **a "escala de centenas" é real em nomes, mas ~75% do volume bruto é ruído** (espelho,
template, cópia). O classificador de domínio da spec §9 não é otimização — é o que torna o catálogo
viável.

### Custo de contexto — medido

Índice (só `name` + `description`, estágio 1 do progressive disclosure):

| Escopo do índice | Skills | Tokens |
| :--- | ---: | ---: |
| Tudo que foi clonado | 1 188 | **~59 800** |
| Sem os 832 wrappers Composio | 356 | **~29 400** |
| Só ECC `skills/` | 292 | 23 552 |
| Núcleo curado (Anthropic-15 + ui-7 + adhd-2 + fwc-2 + img2three-1 + ~60 ECC) | ~87 | **~7 500** |

Corpo do `SKILL.md` injetado por story (estágio 2):

| Fonte | Mediano | p90 | Pior caso |
| :--- | ---: | ---: | ---: |
| ECC | 1 890 | 4 461 | 7 588 |
| Anthropic | 2 136 | 8 247 | 21 693 (`claude-api`) |
| ui-skills | 1 178 | 4 044 | 4 116 |
| Composio (auto) | 738 | 1 042 | — |

**Injeção de 1–3 `SKILL.md` por tarefa: ~2k (1 skill mediana) a ~13k tokens (3 skills no p90).** Média
realista com 3 skills: **~6–7k tokens**. Isso é aceitável — o que não é aceitável é o índice: carregar
os 1 188 nomes custa 60k tokens *por turno*, 5× mais que as três skills injetadas.

**Decisões derivadas:**
- Índice filtrado por domínio antes de chegar ao classificador. Nunca o índice inteiro.
- Cap por corpo: rejeitar/avisar acima de ~5k tokens (limite recomendado pelo spec). Isso barra
  `claude-api` (21.7k) e `img2threejs` (8.2k) na forma atual.
- Orçamento por story: **≤3 skills e ≤10k tokens somados** — alinhado com o teto de 3 da spec §9.
- Codex impõe o próprio teto (2% da janela ou 8000 chars) e **silenciosamente omite skills**. Se algum
  dia a ADE instalar em `.agents/skills/` em vez de injetar, isso vira perda invisível de capacidade.

---

## 6. Decisão 4 — controles de supply chain obrigatórios

### Evidência de incidente real

[verificado: Snyk, "ToxicSkills", publicado **2026-02-05**]

- **3 984 skills** escaneadas em **ClawHub e skills.sh**.
- **36,82% (1 467)** com ao menos uma falha de segurança; **13,4% (534)** críticas.
- **76 payloads maliciosos confirmados** por revisão humana.
- **91%** das skills maliciosas confirmadas usavam **prompt injection**.
- Categorias: download de malware externo, exfiltração ofuscada em base64, desativação de segurança via
  jailbreak; roubo de credenciais AWS/financeiras, backdoor por alteração de arquivos de sistema,
  **comprometimento persistente por manipulação da memória do agente**.
- Atores nomeados: `zaycv`, `Aslaep123`, `pepe276`, `moonshine-100rze`.
- Mitigações recomendadas pela Snyk: escanear com `mcp-scan`, remover skills dos atores, **rotacionar
  credenciais** se instaladas, e **revisar os arquivos de memória do agente**.
- Repo de laboratório: `snyk-labs/toxicskills-goof`, criado 2026-02-07.

Contexto de barreira de entrada [inferido a partir da cobertura secundária do relatório]: publicar em
ClawHub exige apenas um `SKILL.md` e uma conta GitHub de uma semana — sem assinatura de código, sem
revisão, sem sandbox por padrão.

Corroboração do risco pelos próprios fornecedores [verificado]:
- Gemini CLI: `gemini skills install` exige consentimento; a flag literal é `--consent` ("Acknowledge
  the security risks of installing a skill").
- Claude Code: "A skill can grant itself broad tool access, so review the `allowed-tools` of skills
  checked into a repository before you run Claude Code there"; skills podem executar shell via
  `` !`comando` ``; existe política `disableSkillShellExecution`.
- ECC trata o próprio harness como superfície de ataque (AgentShield) e avisa contra mirrors não
  oficiais.

### Superfície medida nas fontes da ADE

| Fonte | Scripts dentro do escopo de skill | `SKILL.md` com padrão de risco (heurística) |
| :--- | ---: | :--- |
| ECC `skills/` | **124** | 44 "injection-like", 35 credenciais, 35 rede |
| `anthropics/skills` | 73 | 2 (prosa legítima) |
| Composio (à mão) | 65 | 5 |
| ui-skills | 77 (fora de `skills/`, site de demo) | 0 |
| img2threejs | 235 (pipeline, fora da skill) | 1 |
| FWC | **0** | 0 |

Os hits de heurística foram revisados por amostra e são **falsos positivos** (prosa contendo
"silently", "without asking", tabela markdown com `| bash`). Nenhum payload malicioso confirmado nestas
8 fontes. O que o número mede é **superfície de revisão**, não malícia.

### Controles obrigatórios

| # | Controle | Por quê (evidência) | Onde na ADE |
| :--- | :--- | :--- | :--- |
| 1 | **Allowlist de fontes** — só repositórios em `catalog.sources`; nunca ClawHub, nunca `npx skills add` de registry aberto, nunca seguir links de listas "awesome" | 3 984 skills de registry aberto, 36,8% com falha | já na spec §9(1); **estender**: proibir instaladores de registry |
| 2 | **Pin por commit + hash por arquivo**; sync é `fetch` + checkout do SHA pinado, nunca `pull` para `main` | Repo legítimo comprometido depois é o vetor óbvio; ECC empurrou commits em 2026-09-12 e 09-15 | novo — campos `commit`/`sha256` no índice |
| 3 | **Licença por skill, não por repositório**; skill sem licença ou com licença proprietária não entra no catálogo | `anthropics/skills` sem LICENSE de repo, 4 skills proprietárias; Composio sem licença nenhuma redistribuindo essas 4 | novo — gate legal no ingest |
| 4 | **Validação estrutural no ingest** (`skills-ref validate`): `name` bate com o diretório, `description` ≤1024, sem campos de topo fora do spec | Composio inventou `requires:` de topo; FWC omite `license` | novo — `agentskills/agentskills`, Apache-2.0 |
| 5 | **Inspeção estática do `SKILL.md`** antes do índice: padrões de injeção, instrução para exfiltrar, instrução para desabilitar gates, referência a `.ssh`/`.env`/chaves, URL fora da allowlist | 91% das maliciosas usavam prompt injection | novo — o scan desta pesquisa é a v0 do detector |
| 6 | **Quarentena por padrão para skill com `scripts/`**; `trust` sobe para `vetted` só por revisão humana registrada | ECC tem 124 scripts em `skills/` | novo — campos `has_scripts`/`trust` |
| 7 | **Engine nunca executa script de catálogo**; o agente pode, sob os mesmos portões e `contain` | — | já na spec §9(3) — manter literal |
| 8 | **`allowed-tools` do catálogo é ignorado**, sempre. Nunca repassar para a CLI | Doc da Claude Code: "A skill can grant itself broad tool access" | novo — a spec não cobre |
| 9 | **`contain` inviolável** mesmo contra instrução da skill | — | já na spec §9(4) |
| 10 | **Primeira aparição no projeto exige aprovação**, mostrando nome, fonte, commit, licença, `trust` e se tem scripts | Consentimento explícito é o que Gemini e Claude Code fazem | já na spec §9(2) — **estender** o que o resumo mostra |
| 11 | **Memória e config do agente no escopo do scan**, não só o `SKILL.md` | "comprometimento persistente por manipulação da memória do agente"; ECC/AgentShield escaneia hooks, MCP, permissões, secrets | novo — `ade doctor` |
| 12 | **Nunca ingerir `install.sh`/`hooks/` das fontes**; só o subdiretório canônico de skills | ECC traz `install.sh` na raiz + instaladores por CLI | novo |

Controles 2, 3, 5, 6, 8, 11 e 12 **não existem na spec v2** e devem entrar na seção 9.

---

## 7. Respostas diretas

**1. Matriz:** §2. ADOPT: `anthropics/skills` (15 de 19), `ayghri/i-have-adhd`, `UditAkhourii/adhd`,
`ibelick/ui-skills`, `FloWritesCode/fwc-swiftui-skills` (dormente), `agentskills/agentskills` (como
validador). ADAPT: `affaan-m/ECC` (só `skills/`, filtrado por domínio), `img2threejs` (só se o domínio
3D existir). REFERENCE: `vercel-labs/skills`, `openai/skills`. REJECT:
`ComposioHQ/awesome-claude-skills` (`composio-skills/` + `document-skills/`).

**2. Metadata:** extensão via `metadata` (mecanismo previsto pelo spec) — mas guardada no `index.json`
da ADE, com o `SKILL.md` upstream byte-idêntico para permitir pin por hash. Campos em §4. Codex e
Gemini **descobrem automaticamente** via `.agents/skills/`; Claude Code **não lê** esse caminho e usa
`.claude/skills/`. Nenhum caminho serve aos três → a ADE injeta o corpo, não instala.

**3. Escala e custo:** 1 188 brutos → **~320 nomes de qualidade**, **~60–80 relevantes** para a stack.
Índice completo custa ~60k tokens/turno (inviável); núcleo curado ~7.5k. Injetar 1–3 `SKILL.md`:
**~2k a ~13k tokens, mediana ~6–7k para três**. Cap por skill: 5k tokens (limite do próprio spec).

**4. Supply chain:** 12 controles em §6, dos quais 7 são novos. Evidência: Snyk ToxicSkills
(2026-02-05) — 3 984 skills, 36,8% com falha, 76 payloads maliciosos, 91% via prompt injection.

---

## 8. Perguntas em aberto

1. `openai/skills` (27.3k ★) não declara licença. Sem isso, o catálogo do Codex é inutilizável
   legalmente pela ADE, apesar de ser a fonte oficial de uma das três CLIs alvo.
2. A spec do Agent Skills não é versionada (sem releases no repo). Como a ADE fixa "conforme ao spec de
   quando"? Provável resposta: pinar o commit de `agentskills/agentskills` junto com `skills-ref`.
3. `allowed-tools` é marcado **Experimental** e "support may vary". Ignorá-lo é seguro hoje; se virar
   normativo e as CLIs passarem a exigi-lo, a política de ignorar precisa de reavaliação.
4. Codex omite skills silenciosamente ao estourar 2%/8000 chars. Não medi o comportamento real com
   catálogo grande — só a doc. Verificar antes de qualquer caminho de instalação em `.agents/skills/`.
5. O detector estático de §6(5) não foi validado contra amostras maliciosas reais. `snyk-labs/toxicskills-goof`
   existe para isso e não foi executado nesta rodada.

---

## 9. Fontes

Docs oficiais (hierarquia 1):
- https://agentskills.io — visão geral e Client Showcase (~45 produtos), acessado 2026-09-16
- https://agentskills.io/specification — spec normativa, acessado 2026-09-16
- https://code.claude.com/docs/en/skills — descoberta, frontmatter e segurança na Claude Code
- https://learn.chatgpt.com/docs/build-skills — descoberta de skills no Codex (redirect de
  https://developers.openai.com/codex/skills/)
- https://geminicli.com/docs/cli/skills/ — descoberta, tiers e consentimento no Gemini CLI

Repositórios (hierarquia 2 — clonados e medidos em 2026-09-16):
- https://github.com/anthropics/skills (176 578 ★, sem LICENSE de repo)
- https://github.com/affaan-m/ECC (259 492 ★, MIT)
- https://github.com/ComposioHQ/awesome-claude-skills (75 165 ★, sem licença)
- https://github.com/ayghri/i-have-adhd (46 423 ★, MIT)
- https://github.com/UditAkhourii/adhd (4 183 ★, MIT)
- https://github.com/ibelick/ui-skills (8 565 ★, MIT)
- https://github.com/img2threejs/img2threejs (16 159 ★, Apache-2.0)
- https://github.com/FloWritesCode/fwc-swiftui-skills (297 ★, MIT)
- https://github.com/agentskills/agentskills (25 386 ★, Apache-2.0)
- https://github.com/openai/skills (27 310 ★, sem licença)
- https://github.com/vercel-labs/skills (31 743 ★, MIT) — https://skills.sh, npm `skills@1.5.26`

Segurança (hierarquia: relatório de fornecedor + repo de laboratório):
- https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/ — ToxicSkills, 2026-02-05
- https://github.com/snyk-labs/toxicskills-goof — amostras, criado 2026-02-07

Local (hierarquia: observação direta):
- `codex --help` / `codex plugin --help` (0.154.0); `~/.codex/skills/.system/`
- `gemini skills list --all`, `gemini skills install --help` (0.59.0)
- Claude Code 2.1.271
