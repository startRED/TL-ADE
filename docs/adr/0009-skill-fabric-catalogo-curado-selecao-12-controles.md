# ADR 0009 — Skill Fabric: catálogo curado, seleção externa e 12 controles de supply chain

**Status:** aceito 2026-09-17

## Contexto

Skills são a forma barata de dar competência específica ao Maker, e também a superfície de ataque mais
exposta da ADE. O mecanismo nativo de skills não serve para seleção (trunca e limita a listagem), não
há diretório comum às CLIs, e o ecossistema aberto tem incidente documentado de escala.

## Decisão

Catálogo **curado** de 60–80 skills em `~/.ade/catalog/`, com `index.json` mantendo a extensão de
metadados **fora** do `SKILL.md` (o upstream fica byte-idêntico). Sync = `fetch` + checkout do **commit
pinado**, nunca `pull`; sha256 por arquivo. SkillGuard aplica os **12 controles** de
`ref-skill-sources.md` §6, incluindo os cinco que o painel não cobria: pin por commit, **licença por
skill**, `skills-ref validate`, `allowed-tools`/frontmatter **removido antes da injeção**, e nunca
ingerir `install.sh`/`hooks/`. Scripts nunca são executados pelo engine; skill com `scripts/` nasce em
quarentena; primeira aparição no projeto exige aprovação (em lote desatendido, `awaiting_operator`);
skills locais do repositório vencem por nome. Seleção: filtro duro (domínio/linguagem/família) → **BM25
top-8** local (~80 linhas, $0) → seletor barato fecha **≤3** → bloco fixo do pack ordenado por id
estável. Alvos: `recall@8 ≥ 0,85`, `precision@3 ≥ 0,75`.

## Evidência

- Digest #13: ~1.188 `SKILL.md` brutos → ~320 de qualidade → ~60–80 relevantes. O gargalo é o **índice**
  (~60k tokens/turno para 1.188 descrições), não o corpo (~6–7k para 3 skills). O Claude Code trunca
  `description` a 1.536 chars e limita a listagem a ~1 % do contexto: **seleção externa é requisito**.
- Digest #12: Composio vendoriza 864 `SKILL.md` (832 wrappers do Rube MCP); `anthropics/skills` não tem
  licença de repo e docx/pdf/pptx/xlsx são proprietárias; `openai/skills` não declara licença.
- Digest #14 e #15: não existe diretório de skills comum às três CLIs (bloco do pack é a única via
  uniforme); a precedência do Claude Code é pessoal > projeto, inverso da spec v2 §9.
- Digest #34: sanitização estática em **build time** leva ASR de 36,0 % → 7,2 %; interceptação em
  runtime fica em 12,9 %; defesa só por system prompt, 26,6 %.
- Digest #39: Codex omite skills silenciosamente acima de 2 % da janela ou 8.000 chars na listagem.
- `ref-skill-sources.md` §6 (Snyk "ToxicSkills", 2026-02-05): 3 984 skills escaneadas, 36,82 % com
  falha, 13,4 % críticas, 76 payloads confirmados, **91 % via prompt injection**; categoria nomeada
  "comprometimento persistente por manipulação da memória do agente".
- `landscape-routing-skills-terminal.md` §"BM25": arXiv 2605.24660 — BFCL+BM25 com K≈7,4 cobre 90,3 %
  (equivalente a K=50 fixo) e **lista curta melhora a escolha do LLM: 93,1 % vs 87,1 %**. ToolRet: BM25
  22,32 vs NV-Embed 33,83 de nDCG@10 (~11 pontos), ao custo de chave de API.
- `judgment-J3-durability-security-cost.md` §4: cinco controles não apareciam em proposta alguma; e
  nenhuma removia o frontmatter antes da injeção, de modo que `allowed-tools` viajava como texto.
- `ref-addyosmani-agent-skills.md`: framework de evals usado como fixtures de seleção (roteamento rank-1
  e colisão de descrições).

## Trade-offs

Curadoria de 60–80 skills é trabalho humano recorrente. BM25 fica ~11 pontos abaixo de embedding, mas
embedding exige chave de API — princípio inegociável da ADE. O bloco fixo gasta tokens mesmo quando a
skill não é citada; a telemetria `skills_injected[].cited` (ADR 0011) é quem mede esse desperdício.
Sanitização em build time não protege contra conteúdo legítimo mal escrito.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Mecanismo nativo de skills das CLIs | trunca descrições e limita listagem (#13); omissão silenciosa no Codex (#39) |
| ComposioHQ/awesome-claude-skills como lista curada | 832 wrappers templatados, sem licença (#12) |
| `anthropics/skills` inteiro | sem licença de repo; 4 skills proprietárias (#12) |
| Embeddings na v1 | chave de API obrigatória; ganho de ~11 pontos não paga o princípio |
| Engine executando scripts do catálogo | controle 7; o agente pode, sob `contain` |
| Repassar `allowed-tools` do catálogo | controle 8; a skill se autoconcede ferramentas |

## Como reverter

Gatilho: catálogo acima de ~500 skills ou `precision@3` medida abaixo de 0,7 → híbrido BM25+embedding
local. Custo: uma etapa a mais no seletor; `index.json` já carrega os campos.

## Consequências para outros documentos

`docs/catalog-sources.md`, `~/.ade/catalog/index.json`, `docs/specs/` (Skill Fabric, SkillGuard),
ADR 0008 (skills decididas no `prepare`), ADR 0011 (teto de 7,5k e `cited`), ADR 0017, ADR 0019.
