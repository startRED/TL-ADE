# TL-ADE — demonstração

Versão de demonstração da ADE: incompleta, mas real. Constrói software de verdade em qualquer pasta do seu PC usando as suas assinaturas de Claude Code, Codex e Antigravity. Não tem ainda o motor durável (diário à prova de crash, retomada), nem o painel de vários projetos em paralelo. O que ela tem funciona de ponta a ponta.

## Como usar

Duplo clique em `abrir.bat`. Na primeira vez instala as dependências (1 a 2 minutos) e abre o painel no navegador.

1. Escolha a pasta do projeto (ícone de pasta). Qualquer pasta serve; se não existir, a ADE cria; se não for git, o botão "Iniciar git" resolve.
2. Escreva o pedido em português, do seu jeito, e clique em Rodar.
3. Acompanhe: plano, atividade ao vivo, alterações, provas, portão visual, revisão.
4. Decida só quando a ADE pedir: aprovar um plano grande (ou pedir mudanças nele, do seu jeito, e conferir de novo), responder uma dúvida, aceitar/repetir/pular/descartar uma parte. Todo plano vem com uma explicação em palavras simples.

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
| Revisão | Codex GPT-5.6 Terra (revisor) | Lê o diff (sem `node_modules`) em modo somente leitura, isolado da sua configuração pessoal, e recebe o resultado das provas já rodadas pelo motor (não roda nada). Aprova ou pede mudanças: até 4 rodadas automáticas; da 3ª em diante o maker sobe para o modelo do planejador. |
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
- Sem retomada após queda do servidor: uma missão interrompida fica registrada em `.ade/journal.jsonl`, mas não continua sozinha.
- Um projeto por vez.
- O seletor de pasta é um campo de texto, não uma janela do Windows.

## Arquivos

- `server.mjs`: motor, adaptadores das três CLIs, catálogo de skills, API e eventos ao vivo.
- `src/App.jsx`: painel (React + Radix Themes + Tailwind + Geist).
- `review.schema.json`, `research.schema.json`: formatos de resposta do revisor e da pesquisa.
- `.ade/`: configurações, projetos recentes, histórico e journal (não versionado).
- `example/`: projeto de exemplo com um bug de propósito.
