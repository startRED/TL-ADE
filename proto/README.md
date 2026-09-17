# TL-ADE — demonstração

Versão de demonstração da ADE: incompleta, mas real. Constrói software de verdade em qualquer pasta do seu PC usando as suas assinaturas de Claude Code, Codex e Antigravity. Não tem ainda o motor durável (diário à prova de crash, retomada), nem o painel de vários projetos em paralelo. O que ela tem funciona de ponta a ponta.

## Como usar

Duplo clique em `abrir.bat`. Na primeira vez instala as dependências (1 a 2 minutos) e abre o painel no navegador.

1. Escolha a pasta do projeto (ícone de pasta). Qualquer pasta serve; se não existir, a ADE cria; se não for git, o botão "Iniciar git" resolve.
2. Escreva o pedido em português, do seu jeito, e clique em Rodar.
3. Acompanhe: plano, atividade ao vivo, alterações, provas, portão visual, revisão.
4. Em pedidos médios e grandes a ADE faz uma entrevista curta (2 a 5 perguntas de múltipla escolha, a primeira opção é a recomendada) para você escolher o jeito do programa; "Seguir com as recomendações" pula tudo. Depois vem o plano, com explicação em palavras simples; você aprova, pede mudanças (em texto livre) ou descarta.
5. Se o plano pede fotos ou ilustrações, o Codex gera as imagens (`$imagegen`) em `assets/img` antes das partes começarem, e elas aparecem na aba Plano.
6. Decida só quando a ADE pedir. Por padrão ela segue sozinha: após 6 rodadas de revisão com provas verdes e nada grave, aceita e vai para a próxima parte (opção "Depois de 6 rodadas"). Cada parte tem orçamento (US$ 4 no Claude por padrão, em Opções): estourou, não há novas rodadas. Cada rodada tem teto de ações (prova 20, implementação 30); a 3ª rodada sobe o maker para o modelo do planejador.
7. Duas ADEs ao mesmo tempo (dois projetos): `abrir.bat 2` abre uma segunda instância em `localhost:5174` (servidor 4318).
8. Anexos: cole imagens com Ctrl+V, arraste arquivos, ou use o "+" (abre o Explorer). Vão para `.ade-attachments/` no projeto (ignorado pelo git) e as IAs abrem com Read. O "+" e a página Projetos também abrem o Explorer para escolher ou criar a pasta do projeto.
9. Faixa rápida: pedido curto de correção ("corrija o botão…") num projeto existente pula entrevista e plano; vai direto para prova, correção e revisão (~US$ 0,9 medido). Desligável em Opções.
10. Pedido grande (vários subsistemas): a ADE divide sozinha em **épicos** com dependências, um por vez; cada épico é planejado na hora (vendo o código dos anteriores) e roda como missão pequena. Parte grande demais (mais de 4 critérios, mais de 120 palavras, "e também") volta ao planejador para dividir antes de gastar. Parte que depende de outra não concluída é pulada sem gastar. Parte rejeitada pelo revisor com achado grave vira uma parte de correção só com os achados, mantendo o trabalho feito.
11. Economia medida: cada fase é uma sessão nova do Claude, mas o prompt já leva a árvore do projeto, o conteúdo dos arquivos tocados e o resumo da fase anterior (pacote de contexto); turnos por chamada caíram pela metade. Telemetria por chamada em `.ade/journal.jsonl` (`model_call`).
12. Esforço por papel (Modelos): baixo, médio ou alto. Claude recebe `--effort`; Codex `model_reasoning_effort`; Antigravity usa o sufixo do modelo (`gemini-3.8-flash-medium`; Pro só tem alto/baixo). Padrão: entender médio, planejar alto, escrever alto, revisar médio.
13. Batedor (Gemini via Antigravity, `scout.mjs`): lê muito e devolve um recibo curto (resumo, fatos, arquivos com linhas, fontes). O motor chama antes de planejar um pedido de funcionalidade para cima em projeto com código (e a cada épico); quem escreve chama sob demanda (`node scout.mjs "pergunta" [arquivos] [--web]`) para documentação, arquivo grande ou pesquisa na web/GitHub. Junto vai o **mapa do código** (símbolo@linha, sem IA) para ler só o trecho.
14. Quem planeja: o entendedor mede a dificuldade (leve, normal, pesada) e recomenda o planejador (Sonnet médio, Opus médio, Fable alto). Se diferir do configurado, você escolhe no painel "Sua vez" (ou na entrevista); no modo noturno a recomendação vale.
15. Conversa (chip "Pergunta" no compositor): pergunta ou pedido pequeno vai para um chat só leitura com o modelo e o esforço que você escolher (Claude, Codex ou Antigravity), sem virar missão. Detecta pergunta sozinha ("?", "como", "o que"…); histórico por pasta em `.ade/chats/`.
16. Quadro: botão no topo que mostra épicos e partes do pedido atual (prontas, em andamento, na fila, puladas, dependências e custo por épico).

## O que acontece por baixo

| Passo | Quem | O que faz |
| --- | --- | --- |
| Entender o pedido | Claude Opus (entendedor) | Lê o pedido e a pasta; classifica o pedido e escolhe, do catálogo (84 skills: as suas em `~/.claude/skills` + plugins), as skills de cada papel: planejador, maker, revisor, pesquisador. Regras fixas por cima: interface ou design ⇒ maker com `design-taste-frontend` + `impeccable`; revisor sempre com `code-review-and-quality`. Skills entram inteiras, sem corte. |
| Montar o plano | Claude Opus (planejador) + suas skills | Devolve partes (stories), critérios de aceite, dica de prova e uma explicação leiga, em JSON validado. Plano com mais de 2 partes espera aprovação; "Pedir mudanças" replaneja com o seu texto. |
| Pesquisa | Antigravity (Gemini) | Só quando o plano depende de um fato externo. Resposta com fontes, em JSON. |
| Escrever a prova | Claude Sonnet (maker) | Escreve só o teste da parte, sem implementar. |
| Prova falha antes | motor | Roda o runner (Vitest, `npm test` ou pytest). A prova nova tem de falhar. |
| Implementar | Claude Sonnet + skills | Implementa até a prova passar e os critérios valerem. |
| Prova passa depois | motor | Todas as provas verdes. |
| Portão visual | Impeccable detect | Em pedidos com interface: varre o código atrás de cara de template; se achar, força uma rodada de retoque. |
| Revisão | Codex GPT-5.6 Terra (revisor) | Lê o diff (sem `node_modules`) em modo somente leitura, isolado da sua configuração pessoal, e recebe o resultado das provas já rodadas pelo motor (não roda nada). Aprova ou pede mudanças: até 6 rodadas automáticas; da 3ª em diante o maker sobe para o modelo do planejador. |
| Entrega | motor | Cada parte aprovada vira um commit `ade: <parte>` na sua pasta. |

Quem escreve e quem revisa têm de ser de empresas diferentes. Modelos por papel em "Modelos": Claude (Sonnet, Opus, Fable, Haiku), Codex (GPT-5.6 Terra/Sol/Luna, GPT-6 Astra, GPT-5.5), Antigravity (Gemini 3.1 Pro, 3.8 Flash, e Claude/GPT-OSS via Google).

## Proteções

- A pasta precisa estar sem alterações pendentes para começar: assim "descartar" desfaz só o que a ADE fez.
- O Claude roda em `--safe-mode`: sem os seus hooks, CLAUDE.md, MCPs e skills globais; só recebe o que a ADE injeta.
- Com "rodar comandos" ligado, a IA pode instalar dependências e criar o projeto (equivale a "ignorar permissões" do Claude desktop). Desligue em Opções para ela só ler e editar.
- O Codex revisa em sandbox somente leitura.

## Limites conhecidos

- Cota do plano (5 h / semanal), por empresa, lida de onde cada CLI deixa o dado:
  - **Claude**: a linha de status do Claude Code recebe `rate_limits` a cada turno interativo; `~/.claude/statusline.mjs` grava isso em `~/.claude/ade-usage.json` (chamadas silenciosas da ADE não atualizam; abra o Claude Code de vez em quando).
  - **Codex**: cada sessão grava `rate_limits` em `~/.codex/sessions/…jsonl`; a ADE lê a sessão mais recente (as revisões da ADE também contam, por isso rodam sem `--ephemeral`).
  - **Antigravity**: não deixa nada legível; abra o `agy` → Models & Quota.
- Tokens acima de 1000k aparecem em M; custo em dólar com vírgula (US$ 1,41).
- Queda do servidor no meio de uma parte: a missão volta como pausada e a parte em andamento recomeça do zero ao continuar.
- O Gemini CLI (`gemini`) fica de fora enquanto não estiver logado (`oauth_creds.json`); o Gemini entra pelo Antigravity (`agy`).
- A conversa é só leitura: para mudar arquivos, mande um pedido.

## Arquivos

- `server.mjs`: motor, adaptadores das três CLIs, catálogo de skills, API e eventos ao vivo.
- `src/App.jsx`: painel (React + Radix Themes + Tailwind + Geist).
- `review.schema.json`, `research.schema.json`: formatos de resposta do revisor e da pesquisa.
- `.ade/`: configurações, projetos recentes, histórico e journal (não versionado).
- `example/`: projeto de exemplo com um bug de propósito.
