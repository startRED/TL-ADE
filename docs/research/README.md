# Pesquisa da rodada de rearquitetação — índice e digest

Data: 2026-09-16. Vinte agentes (13 de pesquisa, 1 crítico de completude, 6 de lacunas) mais 2 agentes
avulsos. Todo documento marca cada afirmação como **[verificado: fonte]**, **[inferido]** ou
**[hipótese]**. Este README é o brief de entrada: quem for projetar ou revisar a ADE lê isto primeiro e
abre o documento específico só quando precisar da evidência.

## Documentos

| Documento | Responde |
| :--- | :--- |
| `runtime-port-map.md` | 66 invariantes de durabilidade do runtime v0.17.0 com código, teste e porte TS; YAGNI; concorrência N>1; Context Pack compiler |
| `method-inheritance.md` | O que do método tl-orchestrator vira componente, prompt ou morre |
| `capabilities-claude-code.md` | Claude Code 2.1.271 verificado em `--help`, docs e smoke test; CapabilitySet |
| `capabilities-codex.md` | Codex CLI 0.154.0 idem |
| `capabilities-gemini-antigravity.md` + `addendum-gemini-family-viability.md` | Gemini CLI 0.59.0, Antigravity CLI (`agy`), migração de 2026-06-18, viabilidade da família |
| `adapters-and-acp.md` + `addendum-adapter-transport-acp-vs-cli.md` | ACP vs JSON bespoke; 4º provider; CapabilitySet comum; medições reais de sessões ACP |
| `ref-graft.md`, `ref-skill-sources.md`, `ref-tools.md` | Matriz ADOPT/ADAPT/REFERENCE/REJECT das fontes do catálogo |
| `landscape-harnesses.md` | Estado da arte em harnesses e multi-agente; spec-driven; orquestração de terminais |
| `landscape-context-observability.md` | Context engineering, memória, Tool Output Firewall, telemetria, harness doctor |
| `landscape-evals-visual.md` + `addendum-frontend-engine-anchor.md` | Evals por classe; loop visual; Impeccable; rubrica; `$imagegen` testado |
| `landscape-routing-skills-terminal.md` | Roteamento por papel com benchmark; seleção de skills; segurança de skills; node-pty |
| `models-by-role-2026-09.md` | Benchmarks de 2026-09 (SWE-bench Pro, Terminal-Bench, GPQA, HLE, preço, velocidade) e medição das missões da demo; modelo recomendado por papel |
| `landscape-dev-workflows.md` | Como construir a própria ADE: BMAD, Spec Kit, Superpowers, Ralph, Orca (`stablyai/orca`) |
| `addendum-checker-contract-review-result.md` | Comando do Checker por família (medido); forma do review-result; ultrareview |
| `addendum-autonomia-permissoes-por-repositorio.md` | Flags de modo desatendido por família; auto-mode; execpolicy; sandbox |
| `addendum-durable-receipt-process-containment-windows.md` | Job Object via libuv; lease; JCS; shims do npm no Windows |
| `addendum-video-claims.md` | Verificação das dicas de vídeo (cache, advisor, /doctor) |
| `design-panel/proposal-A-minimal.md`, `proposal-B-durable.md`, `proposal-C-intent.md`, `judgment-J1-implementability.md`, `judgment-J2-journeys.md`, `judgment-J3-durability-security-cost.md` | Painel de arquiteturas: as três propostas e os três julgamentos que `architecture.md` §1 usa como base (A com enxertos de B e C) e que §11 cita na arbitragem (E8 ← J3) |
| `ref-affaan-mustafa-ecc.md` | Everything Claude Code: fonte dos 14 adendos A1–A14 de `architecture.md` §10 |
| `ref-addyosmani-agent-skills.md` | `addyosmani/agent-skills`: framework de evals de skills adotado como método (evals §10, skill-fabric §9) |

## Premissas do PROMPT.md e da spec v2 que a pesquisa derrubou

Todas verificadas em fonte primária ou por execução local nesta máquina.

1. **"10 testes falham no Windows"**: falso. `test_tl_runtime.py` passa 93/93 no Windows (1 skip). Os 10 vêm de `test_context_ledger`/`test_resume_generate`, helpers que a ADE não porta. Critério de paridade precisa ser reescrito.
2. **Binário `antigravity`**: nunca existiu. O Antigravity CLI está instalado e autenticado como `agy` (`%LOCALAPPDATA%\agy\bin\agy.exe`, 1.2.x, auto-atualiza). O `gemini` 0.59.0 só funciona com `GEMINI_API_KEY`/Vertex; o OAuth pessoal está morto localmente. O projeto gemini-cli continua vivo (0.60.0 em 2026-09-15).
3. **`agy` serve modelos de outras famílias** (claude-sonnet, claude-opus-thinking, gpt-oss). Maker ≠ Checker tem de chavear por `model_id`, não por binário.
4. **"Sem advisor nativo nas CLIs"**: falso. Claude Code tem `--advisor <model>` (post oficial "The advisor strategy", 2026-04-09: executor barato + advisor forte sob demanda, +2,7 pp SWE-bench com −11,9 % de custo). Codex tem subagentes e hooks estáveis por padrão.
5. **"Codex = melhor revisor"**: parcialmente falso. CR-bench (arXiv 2603.23448v3, 184 PRs): Claude Code 32,1 % vs Codex 20,1 % de pass rate; Codex ganha em precisão (88 % vs 78 %). Checker de rodada (precisão) ≠ Checker de portão (cobertura).
6. **`codex review` como Checker**: inviável. `codex review` não tem `--json`/`--output-schema`; `codex exec review` aceita `--output-schema` mas o ignora em silêncio (medido). O Checker Codex é `codex exec --json --output-schema` com o Context Pack no prompt.
7. **`--full-auto`** não existe no binário 0.154.0 (parser recusa). `codex exec` não tem `-a`; só sandbox + `--approve-for-me`.
8. **Sandbox de SO do Claude Code** não roda em Windows nativo. `contain` não pode delegar a ele.
9. **`--bare`** quebra a autenticação por assinatura. O isolamento correto é `--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (auto memory vem ligada por padrão e quebra determinismo).
10. **Saída estruturada por schema já existe**: `claude -p --json-schema '<json inline>'` (campo `structured_output`), `codex exec --output-schema <arquivo>`, `agy --json-schema` (coage mesmo sob instrução de desobedecer). O "protocolo de saída estruturada" por prompt da spec §7 é desnecessário. `gemini` 0.59.0 não tem schema.
11. **Orçamento por chamada é nativo**: `claude --max-budget-usd`, `--max-turns`. `--session-id <uuid>` permite cunhar o id antes do spawn (ouro para write-ahead do journal). ACP `session/new` não permite pré-cunhar.
12. **ComposioHQ/awesome-claude-skills** não é lista curada: vendoriza 864 SKILL.md, 832 wrappers templatados do Rube MCP. **anthropics/skills** não tem licença de repo; docx/pdf/pptx/xlsx são proprietárias (proibem cópia fora dos serviços Anthropic). **openai/skills** (27k estrelas, já em `~/.codex/skills/.system/`) não declara licença. ECC tem 292 skills, não 903.
13. **Contagem real**: ~1.188 SKILL.md brutos → ~320 de qualidade → ~60–80 relevantes para a stack da ADE. O gargalo é o índice (~60k tokens por turno para 1.188 descrições), não o corpo (~6–7k para 3 skills). O mecanismo nativo de skills do Claude Code trunca descrições a 1.536 chars e limita a listagem a ~1 % do contexto: seleção externa é requisito, não otimização.
14. **Não existe diretório de skills comum às três CLIs**: Codex e Gemini leem `.agents/skills`; Claude Code não. Injeção como bloco do pack é a única via uniforme.
15. **Precedência de skills do Claude Code** é pessoal (`~/.claude`) > projeto (`.claude`), inverso da spec §9.
16. **Teto de 4 rodadas visuais** contradiz a fonte (Impeccable 4.3.1: "Verify in bounded passes, not a loop"; 1 inspeção + 1 confirmação). Teto correto: 2. O corte final 8/10 é o teto da banda calibrada (32/40); trabalho bom cairia em `awaiting_operator`.
17. **"Avaliador em modelo mais barato"** economiza centavos num orçamento dominado pelo rework (10–50×). O juiz deve ser o melhor multimodal de família diferente; o teto vale para o rework.
18. **Lista de fontes banidas** contradiz Impeccable e frontend-design: "o brief vence". Guardrail estético é default, não veto.
19. **Impeccable 4.3.1 está instalado** (plugin de marketplace, detector Rust Apache-2.0 com 30+ regras, hooks para Claude/Codex/Cursor). O modo de arquivo estático captura só um subconjunto das regras (2 de 6 anti-patterns numa fixture); o modo URL/renderizado é o completo. `npx impeccable@4.3.1` não existe no npm público (só 4.1.0): pinar por `ENGINE_VERSION` do binário.
20. **`$imagegen` funciona em `codex exec` headless** (testado: imagem real, sem chave de API, salva em `$CODEX_HOME/generated_images/`). Exige stdin fechado (senão pendura) e `--skip-git-repo-check` fora de repo git. Nenhuma CLI Google gera imagem.
21. **Playwright MCP / Chrome DevTools MCP** trazem 58–70 ferramentas; nunca no caminho automático. Playwright como biblioteca no engine. Snapshot de acessibilidade custa 200–400 tokens vs milhares por screenshot: a11y + portões determinísticos primeiro, screenshot só para julgamento estético.
22. **Harness de longa duração da Anthropic não usa DAG**: lista plana de features com um único campo gravável (`passes`). O DAG é contribuição da ADE e precisa se pagar por classe de complexidade.
23. **"Sessão nova por story bate sessão longa com compaction"** tem convergência de 5 fontes e nenhum A/B público. É hipótese de projeto: primeiro experimento do harness doctor.
24. **Vibe Kanban** está sendo desligado (2026-04-10); **Crystal** virou Nimbalyst e parou; **Claude Squad** é AGPL-3.0; **RouteLLM** abandonado (2024-08); **Lost Pixel** arquivado (2026-04-22); **Aider** sem push desde 2026-05. Nenhum orquestrador de terceiros entra como dependência.
25. **Claude Code já tem** `--worktree`, `--tmux`, `--bg` + `claude agents --json|attach|logs|stop|respawn`, `--fork-session`, `--teleport`, Workflow tool, `/loop`, routines, `claude ultrareview --json` (cloud, cota de 3 grátis, 5–10 min), `claude plugin eval` (A/B com braço baseline), `/skill-doctor`. Decisão obrigatória: quem é dono do ciclo de vida de worktree e processo (a ADE), com ADR.
26. **`claude -p --model haiku` faturou como claude-sonnet-5** (US$ 0,37 para ecoar 200 bytes). Custo do classificador barato precisa ser medido, não assumido.
27. **Piso de custo do Codex headless** é ~19,4k tokens de entrada (instruções + AGENTS.md + catálogo de skills). Chamadas curtas precisam de `--ignore-user-config` e poda.
28. **Codex não reporta USD** (só tokens, inclusive `cache_write_input_tokens` não documentado); janela de 272k em todos os modelos (nunca 1M). Claude reporta `total_cost_usd` com `costBasis: 'list'`. `agy` tem anomalia (`cache_read_tokens` > `total_tokens`). OTel `gen_ai.*` está em status Development e não tem tipo de token de cache.
29. **node-pty** nunca teve 1.2.0 estável; bug #967 (2026-09-12): `kill()` pode matar processo não relacionado até 5 s depois. Nunca depender de `pty.kill()`; encerrar por `taskkill /T /F /PID`. node-pty não usa Job Object.
30. **libuv já cria Job Object com `KILL_ON_JOB_CLOSE`** para filhos não-detached no Windows: contenção da árvore de processos vem de graça no caso comum; addon nativo vira backlog. `proper-lockfile` está abandonado (lease: ~60 linhas próprias). JCS: pacote `canonicalize` (Apache-2.0, 0 deps). `spawn('npx.cmd')` sem `shell:true` falha com EINVAL no Node 24/Windows. `claude` tem 3 shims (sh, .cmd, .ps1): resolver o `.exe` real.
31. **`{pack_text}` com 60k de pack estoura os 32.767 chars de `lpCommandLine`** do Windows: sempre `{pack_path}`.
32. **`review-result.schema.json` e o runtime discordam** (`target_role/problem/required_action` vs `target/summary`), em dois pontos (`classify_dispatch`, `Runtime.review`): `intent_gap` para humano nunca escala e `stagnation` dispara falso. Adotar a forma rica; `summary` derivado.
33. **`tl_supervisor.py`** (pool de worktrees, claim de escopo, fila de merge, sweep de órfãs) está pronto, testado e nunca chamado pelo runtime. Git por worktree em vez de singleton é barato antes do primeiro commit e caro depois.
34. **Sanitização estática de skills em build time** é a defesa mais eficaz e mais barata contra skill injection (ASR 36,0 % → 7,2 %), melhor que interceptação em runtime (12,9 %); defesa só por system prompt é quase inútil (26,6 %).
35. **ACP (Agent Client Protocol)**: claude-agent-acp 0.78 (emite `usage_update.cost` em USD, medido), codex-acp 1.12 (sem custo, medido), `gemini --acp` nativo, `antigravity-acp` (Python, separado do `agy`, com binário Windows no registry, sem sha256). Cobre resume/fork, imagens, effort (`thought_level`), permissões roteadas ao cliente, steering (`_meta`, RFD upstream aberto). Não cobre: structured output, id de sessão pré-cunhado, allowlist, sandbox, PTY. Sessão ACP do Claude é a mesma que `claude --resume <id>` abre (verificado).
36. **4º provider**: OpenCode (anomalyco/opencode, MIT, 207k estrelas, ACP nativo, 75+ providers, custo em USD real). Custa o princípio "sem chave de API": não usa assinatura Claude (plugins removidos pela Anthropic).
37. **Modo desatendido por família** (medido): Claude `--permission-mode bypassPermissions --permission-prompts none` + `--disallowedTools` para git/gh (nunca `--permission-mode auto`, que só ativa com esse valor literal); Codex `codex exec --sandbox workspace-write --approve-for-me` (+ `.rules` de `execpolicy`, carregado automaticamente); `agy`/`gemini` `--approval-mode yolo`. `codex sandbox` como jaula universal: não (fail-closed até para escrita no próprio cwd sem chave não documentada). **Um `claude -p` pode reportar sucesso depois de ferramenta bloqueada**: prova por eval, nunca por relato.
38. **`agy` escreveu em `~/.gemini/antigravity-cli/scratch/` em vez do `--add-dir` pedido**, sem aviso. Isolamento por worktree tem de ser verificado pelo engine em toda família.
39. **Codex omite skills silenciosamente** acima de 2 % da janela ou 8.000 chars na listagem; AGENTS.md trunca a 32 KiB. Manter AGENTS.md ≤ 8 KB.
40. **Orca** (`stablyai/orca`): ADE para frota de agentes; ~11k commits e ~9,9k PRs em 6 meses, zero revisão humana, ~30 portões de CI. Gas City (Yegge) sem malha: ~23 % de CI verde. O portão substitui o humano; o modelo não.

## Confirmações importantes

- Plano de controle em código, chamadas curtas, estado durável fora do modelo: 5 fontes primárias convergem (Anthropic long-running harness, context engineering, Manus, ADK "graph-based workflows", Cognition). Cognition "don't build multi-agents" ataca escritores paralelos sem contexto compartilhado, não a ADE.
- Paralelize só trabalho somente-leitura, independente e comprimível em sumário (+90 % em pesquisa por ~15× tokens); serialize escrita na mesma árvore.
- SWE-EVO: o gargalo de horizonte longo é instruction following (>60 % das falhas), não janela. Investimento vai para Intent Compiler e Task Contract.
- Template de contrato oficial: tarefa + guardrails + critérios de aceitação + verificação própria. EARS ("WHEN … THE SYSTEM SHALL …") como forma canônica de aceite, 1:1 com nome de teste.
- Eval estrito provado por execução vermelha antes da mudança, gravada no journal; eval que nasce verde é recusado. Substitui a atestação por LLM.
- Vercel mediu 57 % menos falhas com `design.md` carregado (>200 runs, baseline sem skill, rubrica cega): o brief é a alavanca mais forte da qualidade visual, e o método é o A/B Caliper.
- Graft: ADOPT como dependência opcional com fallback silencioso para rg (porte de `tl_graft.py`); ganho real a medir no dogfood.
- Caliper: ADOPT o protocolo (ablação pareada + `activates`/`expect`/`assert`); `claude plugin eval` já tem braço baseline.
- Runtime: os 66 invariantes são portáveis; riscos altos resolvidos ou rebaixados (JCS, lease, Job Object, shims). Conjunto mínimo de 7 schemas: journal-event, ade-config, plan, unit-result, review-result, visual-eval, research-finding.

## Hipóteses assumidas (o dogfood mede)

| Hipótese | Onde mora | Como medir |
| :--- | :--- | :--- |
| Sessão nova por story + estado externo > sessão longa com compaction | engine | mesmo lote nos dois modos; custo, eval pass, rework |
| Tetos de pack (40k tokens; 2,5k/skill; 7,5k skills; 6k contexto; 1,5k invariantes) | Context Pack | telemetria por seção; ajustar por p90 |
| Rubrica visual (6 critérios, corte 7,5, 2 rodadas) e juiz multimodal de outra família reduz slop | FQE | nota por família; defeitos escapados; MLLM-as-UI-judge alinha só parcialmente |
| Claude projeta / Codex estrutura (duas etapas) | FQE | configurável; nota por família; default é Maker único |
| recall@8 ≥ 0,85 e precision@3 ≥ 0,75 na seleção de skills | Skill Fabric | fixtures de pedidos com skills esperadas |
| Poda do harness melhora resultado | harness doctor | ablação pareada por item |
| Tabela classe de complexidade → forma de execução | Intent Compiler | intervenções e custo por classe |
| Janela e cotas do `agy` | Capability Registry | sondagem do `ade doctor` |
