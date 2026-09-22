# ADR 0027 — Ativação da v0.4b: Painel local, índice SQLite descartável e interface acessível sem compilação

**Status:** Aceito (confirmado por Erick em 2026-09-21)

## Contexto

O roadmap normativo (`docs/roadmap.md`) e a autorização expressa concedida por Erick em 2026-09-19 ([ADR 0024](0024-autorizacao-roadmap-ate-v1.md)) estabelecem a execução autônoma sequencial até a v1, abrangendo o fechamento da v0.2, a v0.3, a v0.4a, a v0.4b, a v0.5 e a v1.

A v0.4a entregou a Skill Fabric (catálogo curado com 12 controles de segurança e seleção de skills sob limites de contexto) e o Frontend Quality Engine (FQE com portões determinísticos D1–D6 e juiz multimodal em 2 rodadas). A etapa seguinte, v0.4b, cumpre o requisito de tornar o estado da missão observável sem depender de leitura manual de arquivos JSONL, fornecendo um painel local escuro, acessível e semelhante a um IDE, aberto por lançador de dois cliques e sem qualquer etapa de compilação.

Em conformidade com a governança da TL-ADE, decisões aceitas (ADRs 0001 a 0026) permanecem imutáveis, e qualquer nova delimitação de marco ativo deve ser formalizada por meio de novo ADR e atualização correspondente dos documentos públicos.

## Decisão

Formalizar a ativação da **v0.4b** sob a autorização contínua até a v1, estabelecendo os seguintes requisitos e restrições:

1. **Entrega em story única e escopo da v0.4b:**
   - A v0.4b é entregue em uma única unidade atômica porque o painel, a projeção SQLite, o workspace `packages/web` e a dependência nativa nascem juntos no roadmap.
   - Componentes incluídos: `ade init` com gerador de `ade.bat`, `ade serve`, `ade index --rebuild`, servidor HTTP e WebSocket nativo em `src/panel/server.js`, projeção determinística em `src/panel/projection.js`, índice em `src/panel/sqlite-index.js`, workspace `packages/web` e o 9º schema publicado `schemas/visual-eval.schema.json`.

2. **Painel estritamente como projeção descartável (sem estado próprio):**
   - O painel é puramente uma projeção das fontes canônicas e duráveis: `plan.json`, `journal.jsonl`, `artifacts/` e `stories/*.json`.
   - `.ade/index.sqlite` é um índice derivado e descartável. A exclusão do arquivo SQLite e sua reconstrução via `ade index --rebuild` produzem um conteúdo idêntico byte a byte a partir das mesmas fontes duráveis.
   - Nenhuma informação de estado da missão é originada no navegador ou no SQLite; o banco pode ser apagado a qualquer momento sem qualquer perda de dados da missão.

3. **Reconstrução atômica com validação de integridade:**
   - A reconstrução da projeção é executada em arquivo temporário isolado (`.tmp`) e promovida atomicamente para `.ade/index.sqlite` apenas se todas as fontes forem válidas: integridade da cadeia de hash do journal, caminhos seguros de artefatos e conformidade de avaliações visuais.
   - Na presença de journal corrompido ou adulterado, a reconstrução falha imediatamente (`JournalIntegrityError`), cancela a operação e preserva integralmente o índice SQLite anterior.

4. **Segurança de transporte local e credencial efêmera (D1):**
   - O servidor aceita requisições estritamente em `127.0.0.1` (`localhost`), recusando inicialização caso configurado com endereços externos ou genéricos (0.0.0.0).
   - Cada execução de `ade serve` gera uma credencial criptográfica aleatória de 32 caracteres hexadecimais (`sessionToken`), exibida exclusivamente no terminal no momento da inicialização. Essa credencial **nunca** é persistida no projeto, no índice SQLite ou no journal.
   - Validação estrita de cabeçalho `Origin`: requisições de origens que não pertençam ao servidor local (`http://127.0.0.1:<port>` ou `http://localhost:<port>`) são recusadas com código 403 Forbidden sem vazamento de metadados da missão.
   - Rotas de API (`/api/snapshot`, `/api/artifacts/*`, `/api/actions/*`) e conexão WebSocket exigem o token de sessão ativo.

5. **Lease exclusivo e contenção de concorrência:**
   - Apenas uma instância de `ade serve` pode operar por projeto/repositório, garantida por lease de processo (`.ade/serve.lease`). Conflito de coordenador encerra o processo com código de saída 5 (`CoordinatorConflictError`).
   - Conflito de porta (`EADDRINUSE`) encerra o processo imediatamente com código de saída 1, sem tentar portas alternativas aleatórias.

6. **Atualização ao vivo unidirecional via WebSocket nativo:**
   - Eventos do journal são transmitidos de forma unidirecional para os navegadores conectados através de WebSocket nativo do Node (RFC 6455), sem dependência de bibliotecas externas.
   - O cliente pode reconectar passando o parâmetro `since=<seq>`, recebendo todos os eventos posteriores ordenados sequencialmente a partir do journal durável.

7. **Aprovação originada na interface:**
   - A única mutação permitida pelo painel é a confirmação de aprovação (`POST /api/actions/approve`).
   - A ação é despachada diretamente para o caso de uso existente (`approveMission`), exigindo obrigatoriamente `mission_id` e o `digest` SHA-256 canônico imutável do resumo do plano. Divergência ou aprovação vencida são bloqueadas categoricamente.

8. **Dependência nativa e diagnóstico antecipado:**
   - `better-sqlite3: ^13.0.3` é a única dependência nativa de produção adicionada.
   - O diagnóstico `ade doctor --native` e o preflight de comandos que utilizam o painel validam a integridade e funcionalidade da compilação nativa no Windows antes de qualquer criação ou modificação de arquivos de índice. Falha nativa encerra com erro claro instruindo os passos de correção (`npm rebuild better-sqlite3`).

9. **Interface web sem build e acessibilidade (D4):**
   - O arquivo `index.html` na raiz carrega módulos ES nativos de `packages/web/app.js` e `packages/web/styles.css` sem nenhum empacotador (bundler), transpilador ou dependência de rede externa (zero CDNs ou Google Fonts).
   - A interface segue a paleta e referências de layout do IDE familiar: três áreas integradas (Projetos/Missões, Detalhes/Evidências/Abas, Log/Journal), suporte a `:focus-visible`, navegação completa por teclado, landmarks ARIA e `prefers-reduced-motion`.

10. **9º Schema publicado:**
    - O contrato `schemas/visual-eval.schema.json` é publicado como o nono schema formal da TL-ADE, validando o objeto `VisualEval` produzido pelo FQE em múltiplos consumidores (FQE e Painel de Evidências).

11. **Limites e itens expressamente fora de escopo:**
    - Terminal interativo embutido (PTY), comandos livres pelo navegador e takeover interativo pertencem à v0.5.
    - Concorrência paralela (N > 1), múltiplos provedores simultâneos e trabalho noturno desatendido pertencem à v0.5 e v1.
    - Git remoto real (push, PR, merge no GitHub público) fica estritamente fora até testes em repositório bare local na v1.
    - O diretório `proto/**` permanece como referência estática histórica e jamais deve ser editado ou reaproveitado como código de produção.

## Evidência

- Autorização expressa de Erick em 2026-09-19: *"Eu, Erick, autorizo ampliar o escopo além do slice 1 até a v1; registre essa autorização como emenda (ADR novo e charter), sem editar ADR aceito."*
- `docs/roadmap.md` §4 especifica os requisitos de v0.4b: lançador de dois cliques, interface com aparência de IDE, painel projeção somente-leitura + SQLite reconstruível, token aleatório de sessão, checagem de Origin, 9º schema publicado e workspaces com `packages/web`.
- Objeção de segurança D1 em `docs/security/README.md` satisfeita por token efêmero por sessão, validação de cabeçalho Origin e amarração restrita a `127.0.0.1`.

## Trade-offs

- **Positivo:** O operador ganha visibilidade completa das missões, com árvore de épicos/stories, diffs de código, relatórios de teste, capturas visuais do FQE, custos e log do journal sem perder a durabilidade e sem comprometer a segurança da máquina local.
- **Positivo:** A eliminação de bundlers garante que a interface possa ser servida diretamente do disco em qualquer ambiente com Node 22+.
- **Risco controlado:** A introdução de `better-sqlite3` adiciona uma dependência em C++ nativo para Windows; esse risco é mitigado pela verificação antecipada em `ade doctor --native` e isolamento atômico das operações de reconstrução.

## Alternativas rejeitadas

| Alternativa | Motivo do descarte |
| :--- | :--- |
| Estado próprio no SQLite ou localStorage | Viola o princípio de durabilidade: o journal e o plano são as únicas fontes de verdade autoritativas. |
| Fastify ou Express como servidor web | Adiciona dezenas de dependências externas desnecessárias; os módulos nativos `node:http` e `node:crypto` atendem integralmente ao escopo com menor superfície de ataque. |
| Bundler (Vite / Webpack / esbuild) para o frontend | Viola a simplicidade operacional do projeto e introduz scripts intermediários de build na entrega de arquivos estáticos. |
| Confiar cegamente em `127.0.0.1` sem autenticação | Descartado pela análise de segurança D1: qualquer script ou página rodando no navegador do operador poderia ler dados de missões privadas locais sem o token efêmero e a validação de Origin. |
| Terminal interativo / PTY nesta versão | Descartado para manter a v0.4b focada na projeção observável e segura; PTY é escopo da v0.5. |

## Como reverter

1. Remover o comando `ade serve`, `ade init` e `ade index` da CLI.
2. Desinstalar `better-sqlite3` e excluir o workspace `packages/web` e a raiz `index.html`.
3. Revogar formalmente este ADR por determinação de Erick.

## Consequências para outros documentos

- `PROJECT_CHARTER.md`: atualizado para registrar a ativação da v0.4b e a inclusão controlada de `src/panel/`, `packages/web/`, `index.html` e `better-sqlite3`.
- `docs/roadmap.md`: atualizado para refletir a entrega dos critérios de aceite da v0.4b.
- `docs/adr/README.md`: indexa o ADR 0027 na tabela e mapeamento temático.
- `docs/security/README.md`: documenta os controles do painel local (token efêmero, origem, lease e bind 127.0.0.1).
- `README.md`: atualizado para refletir os novos comandos `init`, `serve` e `index` da v0.4b.
