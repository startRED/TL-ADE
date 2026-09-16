# Prompt para a rodada de rearquitetação da TL-ADE

Antes de colar, no chat novo (Claude Code aberto em `E:\Documentos\ProjetosIA\TL-ADE`, modelo
Claude Fable 5.1): rode `/effort ultracode` — ativa o modo de esforço máximo com orquestração
multi-agente. A palavra `ultracode` no início da mensagem reforça a opção por orquestração
(Workflow) no turno. `CLAUDE_CODE_SUBAGENT_MODEL` não é verificado — se quiser rotear subagentes
para modelo mais barato, confirme na doc antes de usar.

---

ultracode

# TL-ADE — pesquisa, rearquitetação e revisão adversarial

Você é Principal Architect + Adversarial Systems Designer + AI Harness Engineer da **TL-ADE**.
Vou me ausentar. Trabalhe autonomamente até completar
`inspecionar → pesquisar → estudar capacidades → rearquitetar → revisão adversarial → master spec →
roadmap → plano do primeiro vertical slice`. Sem código de produção nesta rodada.
Use orquestração multi-agente e esforço alto só onde inteligência agrega (pesquisa, síntese,
crítica adversarial); trabalho mecânico vai para agente/modelo barato.

## 0. Estado real — verificado em 2026-09-16, não re-derive

- **Repo canônico (você está nele):** `E:\Documentos\ProjetosIA\TL-ADE`. Leia primeiro:
  `README.md`, `docs/specs/2026-09-16-ade-design.md` (spec v2, aprovada em entrevista hoje),
  `docs/catalog-sources.md` (fontes de skills vetadas via API do GitHub, com classificação
  skill/ferramenta/inspiração e estrelas).
- **Referência de motor:** `E:\Documentos\ProjetosIA\tl-orchestrator-release` — leia
  `docs/RUNTIME.md`, `schemas/*.schema.json`, `scripts/tl_runtime.py`,
  `scripts/tests/test_tl_runtime.py` (93 casos; 10 falham no Windows por baseline conhecida; CI Linux
  passa). O runtime v0.17.0 prova: journal JSONL com cadeia de hash e write-ahead por step,
  reconciliação na retomada (crash não redespaha efeito já feito), scheduler DAG, orçamentos por
  story/lote, detector de loop, portões com evidência. Essa durabilidade é inegociável: porte-a ou
  supere-a, nunca a perca.
- **Decisões já tomadas por Erick** (contexto válido, não dogma — pode derrubar com ADR
  justificado): TypeScript ponta a ponta; web app local (Chat / Mission / Agents); terminal PTY
  completo com "assumir"; 3 CLIs (Claude Code, Codex, Gemini/Antigravity) via adapter genérico;
  entrevista ≤5 perguntas + um único ponto de aprovação; método próprio enxuto (do BMAD sobrevivem
  spec falsificável, Maker≠Checker de famílias diferentes, portões com evidência); evals executáveis
  obrigatórios por story; todas as chamadas de modelo via CLI (assinaturas existentes, sem chave de
  API obrigatória).
- **Fatos de 2026 já verificados** (fontes em `docs/catalog-sources.md`): Codex tem `$imagegen`
  embutido com gpt-image-2 (16 imagens de referência, 1K–4K) e é o mais forte em revisão/CI; Claude
  Code é o mais forte implementador multi-arquivo, com sandbox de SO; o acesso consumidor do Gemini
  CLI migrou para o Antigravity CLI em 2026-06-18 (Gemini CLI segue via Code Assist pago/API).
- **Máquina:** Windows 11. No Bash, `gh` exige
  `export PATH="$PATH:/c/Program Files/GitHub CLI"`. `claude` resolve para `claude.cmd`. Grave
  arquivos com a ferramenta Write — heredoc do Bash mutila barras invertidas.

## 1. Autonomia desta rodada

Autorizado sem perguntar: pesquisar; inspecionar repositórios; comparar tecnologias; levantar
capacidades reais das CLIs; rever e reescrever decisões anteriores (inclusive ≥50% da spec v2, se a
evidência pedir); escolher defaults; resolver ambiguidades reversíveis; criar/modificar
documentação e ADRs; estruturar roadmap e arquitetura; commitar artefatos de planejamento neste
repositório.

Para cada escolha relevante, registre ADR: decisão, evidência, trade-offs, alternativas rejeitadas,
como reverter. Pergunte só o irreversível, o de produto que não dá para inferir, ou o que causaria
grande desperdício se errado. Não reinicie a entrevista: as respostas anteriores valem. Não me dê
updates cosméticos.

## 2. North Star

Uma **ADE universal** que transforma intenção humana simples em software de alta qualidade com o
mínimo de conhecimento operacional do usuário. "Quero melhorar o design" ou "refaça o frontend
inteiro mais profissional" não vira prompt cru: vira
`intenção → interpretação → context discovery → pesquisa se necessário → objetivos → restrições →
direção de design → fases → epics → stories → skills → agentes/modelos → implementação → testes →
evals → revisão independente → refinamento → evidência → entrega` — com o processo dimensionado à
complexidade. O usuário pode ser preguiçoso; a inteligência operacional mora no harness.

## 3. Princípios de arquitetura (reconcilie, não escolha um extremo)

1. **Menos prompt, mais harness.** O que um modelo moderno infere sozinho não vira regra
   permanente. Hierarquia: objetivo atual → invariantes globais mínimos → contexto recuperado sob
   demanda → skills só quando necessárias → ferramentas → MCP só para capacidade inacessível de
   outra forma. Projete um **harness doctor** periódico: mede custo de contexto, detecta regra
   redundante/skill nunca usada/prompt obsoleto, compara desempenho com e sem (estilo Caliper),
   poda o peso morto.
2. **Evals definem "pronto".** Nenhum agente decide subjetivamente que terminou. Cada trabalho gera
   critério verificável que pode falhar (teste, contrato, screenshot/regressão visual, verificação
   negativa, reprodução de bug antes/depois). A pergunta do harness: "que evidência objetiva prova
   que isto terminou correto?"
3. **Poder sem caos.** DAG determinístico, contratos, estados explícitos, checkpoints, gates,
   budgets; inteligência dinâmica só nos pontos onde agrega mais que custa (tokens, latência,
   depuração). Missões de muitas horas sem conversa gigante acumulando contexto.
4. **Capability Registry, não dogma de marca.** Adapters anunciam capacidades reais (modelos,
   effort, contexto, resume, imagens entrada/saída, browser, MCP, sandbox, custo, structured
   output...). Verifique você mesmo as capacidades atuais das três CLIs — não confie nas minhas
   afirmações. Roteamento de papel por capacidade + histórico de desempenho, com default inicial
   (Claude implementa/projeta, Codex revisa/gera imagem, Gemini pesquisa) que a evidência pode
   trocar. Arquitetura aberta a um quarto provider sem reescrever o workflow.
5. **Skill Fabric.** Centenas de skills disponíveis, pouquíssimas no contexto de cada tarefa.
   `intent → classificação → requisitos de capacidade → descoberta → ranking → composição →
   injeção mínima`. Metadata normalizada, tags, dedup, versão/pinning, precedência (skills locais >
   catálogo), compatibilidade por agente, lazy loading. Supply chain: trust levels, allowlist,
   inspeção estática, quarentena, proteção a prompt injection; skill externa nunca vira código
   confiável automaticamente; `contain` inviolável.
6. **Intent Compiler.** Da linguagem imprecisa ("esse painel está feio, melhora") para um **Task
   Contract** estruturado via context discovery + inferência de requisitos + detecção de
   incógnitas + mínimo de perguntas. Estude se a ideia se sustenta; projete melhor se achar.
7. **Frontend Quality Engine.** Detecção automática de tarefa com UI; direção visual declarada
   antes do código; guardrails estéticos (fontes genéricas banidas, paleta coesa via CSS variables
   com cor dominante + acentos, motion CSS-first de alto impacto, estados completos); loop
   implementar → renderizar → capturar (Playwright, 2 larguras, claro/escuro) → avaliar por família
   independente com rubrica anti-slop → corrigir; threshold de nota, teto de rodadas e budget,
   escalação na falha. `$imagegen` para assets, nunca como referência de cópia (descrever estilo >
   anexar inspiração).
8. **Pesquisa como subsistema.** Reconhecer "não tenho evidência para planejar"; time temporário
   com papéis distintos (docs oficiais, soluções existentes, comparação, crítica adversarial);
   `dedupe → ranking de evidência → síntese`; hierarquia de fontes (oficial > código > release
   notes > papers > engenharia > comunidade); separar fato verificado, inferência, hipótese,
   preferência.
9. **Context engineering + token observability de primeira classe.** Sessão nova por tarefa,
   context packets, estado externo (journal + artifacts), resumos estruturados, diff em vez de
   arquivo inteiro. **Tool Output Firewall**: saída bruta vira artifact persistido; o agente recebe
   só o extrato relevante (falhas, não os 742 testes que passaram) com drill-down sob demanda.
   Telemetria por missão: tokens por agente/skill/etapa, cache, desperdício, custo.
10. **Durabilidade.** Missão sobrevive a browser fechado, servidor caído, CLI morta, máquina
    reiniciada. Preserve journal/checkpoint/reconciliação/idempotência/worktrees do runtime.
11. **Autonomia proporcional ao risco.** Níveis: safe (ler, editar, testar, branch, commit) →
    controlled (PR, dependências, migrations) → restricted (produção, segredos, operações
    destrutivas). Política por repositório.
12. **Metodologia que escala.** Classificador de complexidade (trivial / bounded / feature /
    subsystem / project); cada classe libera só o processo necessário. Processo demais também é bug.
    Correção de 5 minutos não ganha epic; projeto de meses roda autônomo.
13. **Rotinas autônomas** (dead code, cobertura, duplicação, regressão visual, harness doctor,
    token waste) com budget, escopo, evidência e política de PR — provável pós-v1; decida.
14. **Versionamento da inteligência.** Toda decisão registra versão de harness/modelo/skill/
    prompt/eval/evidência — para responder "por que a ADE decidiu isso?" e comparar versões.
15. **Evolução por evidência.** Telemetria que responda: qual família resolve melhor cada classe de
    tarefa, qual skill sobe success rate vs só sobe tokens, quando multi-agente compensa. Sem ML
    complexo na v1; primeiro coleta correta.

## 4. Estudo sistemático de referências

Para cada fonte de `docs/catalog-sources.md` e para `trailhq/Graft` especificamente (o que faz,
maturidade, licença, sobreposição com a ADE, incorporar/integrar/adaptar/descartar): classifique
`ADOPT / ADAPT / REFERENCE / REJECT` com motivo, numa matriz
`Projeto | Problema resolvido | Ideias úteis | Custo | Risco | Compatibilidade | Decisão`.
Depois descubra o que eu NÃO citei: estado da arte de agentic coding harnesses, multi-agent coding,
skill systems, context engineering, agent memory, evals, visual coding agents, model routing, agent
observability, terminal orchestration. Cada pesquisa deve responder uma decisão concreta — sem
research theater. Não confie no material de vídeos/blogs que motivou este projeto (dicas de
"/effort ultracode", "safe mode", "advisor" etc. podem estar erradas ou desatualizadas): verifique
em fonte primária antes de virar arquitetura.

## 5. Jornadas obrigatórias (valide a arquitetura contra elas)

1. "Corrija esse botão que não funciona." 2. "Melhore o design dessa página." 3. "Refaça todo o
frontend para parecer produto profissional." 4. "Adicione billing com Stripe." 5. "Crie um SaaS
novo a partir dessa ideia." 6. "Continue desenvolvendo sozinho enquanto durmo."
Para cada uma mostre: interpretação, perguntas (se houver), pesquisa, skills, agentes/modelos,
evals, DAG, gates, resultado esperado. Pesado demais no caso 1 = arquitetura falhou; raso demais no
5/6 = também falhou.

## 6. Artefatos e roadmap

Neste repositório, uma única fonte canônica (estrutura sugerida, melhore se quiser):
`docs/vision.md`, `docs/architecture.md`, `docs/roadmap.md`, `docs/research/` (landscape,
referências, capacidades de agentes, ecossistema de skills, context engineering), `docs/specs/`
(master design — pode substituir a spec v2), `docs/adr/`, `docs/evals/`, `docs/security/`
(supply chain de skills), `docs/operations/` (autonomia e permissões). Commite tudo.

Roadmap por vertical slices com valor real cedo; cada fase com objetivo, acceptance criteria,
evals, dependências, riscos e definição objetiva de pronto; MVP / v0.x / v1 / futuro;
must / should / experimental. **Dogfood progressivo** como eval do projeto: da ADE executando
tarefas pequenas em si mesma até conduzir missão inteira do próprio desenvolvimento. YAGNI
agressivo: minha visão é grande, sua obrigação é impedir que ela afunde a v1.

## 7. Métricas

Qualidade (eval pass, defeitos escapados, nota visual), autonomia (intervenções humanas, recovery),
eficiência (tokens, custo, wall time, tamanho de contexto e de tool output), confiabilidade
(recuperação de crash, gates determinísticos), UX (perguntas ao usuário, tempo até o trabalho
começar, conhecimento exigido do operador). Objetivo: **máximo de software correto e de alta
qualidade por unidade de atenção humana, tempo e custo** — não máximo de agentes.

## 8. Critério de sucesso da rodada

Termina quando você defende tecnicamente, com artefatos commitados: como intenção vira trabalho
executável; como skills entram sem explodir contexto; como agentes/modelos/ferramentas são
escolhidos; como qualidade é provada; o tratamento especializado de frontend; pesquisa eficiente;
contexto pequeno; tool output controlado; tokens observados; sobrevivência a crash; segurança e
permissões; intervenção humana; evolução quando novos modelos surgem; trabalho pequeno continua
simples e trabalho gigante roda autônomo; tudo testável e implementável incrementalmente.

Entregue no fim um resumo executivo: arquitetura final; principais mudanças sobre a spec v2;
descobertas de pesquisa mais importantes; decisões ADOPT/ADAPT/REJECT relevantes; roadmap; maior
risco restante; primeiro vertical slice recomendado; arquivos e commits; e as poucas decisões que
realmente precisam de mim antes da implementação.

Não seja conservador porque já existe uma arquitetura; não seja complexo porque pode. Quando achar
algo melhor que a minha ideia, use e registre; quando uma ideia minha for ruim, descarte e explique
no ADR. Profundidade e coerência acima de velocidade. Construa o melhor plano possível para a
TL-ADE.
