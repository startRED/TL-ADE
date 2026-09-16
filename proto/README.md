# TL-ADE — demonstração

Versão de demonstração da ADE: incompleta, mas real. Constrói software de verdade em qualquer pasta do seu PC usando as suas assinaturas de Claude Code, Codex e Antigravity. Não tem ainda o motor durável (diário à prova de crash, retomada), nem o painel de vários projetos em paralelo. O que ela tem funciona de ponta a ponta.

## Como usar

Duplo clique em `abrir.bat`. Na primeira vez instala as dependências (1 a 2 minutos) e abre o painel no navegador.

1. Escolha a pasta do projeto (ícone de pasta). Qualquer pasta serve; se não existir, a ADE cria; se não for git, o botão "Iniciar git" resolve.
2. Escreva o pedido em português, do seu jeito, e clique em Rodar.
3. Acompanhe: plano, atividade ao vivo, alterações, provas, portão visual, revisão.
4. Decida só quando a ADE pedir: aprovar um plano grande, responder uma dúvida, aceitar/repetir/pular/descartar uma parte.

## O que acontece por baixo

| Passo | Quem | O que faz |
| --- | --- | --- |
| Entender o pedido | Claude Opus (planejador) | Lê o pedido e a pasta; devolve um plano com partes (stories), critérios de aceite e dica de prova, em JSON validado. |
| Skills | motor | Escolhe até 4 skills do catálogo (as suas em `~/.claude/skills` + plugins instalados). Regras fixas: interface ou design ativam `impeccable` + `design-taste-frontend` + `frontend-design`; backend ativa `backend-patterns` + `api-design`; banco ativa `postgres-patterns`; mais afinidade por palavras do pedido. Cada skill cortada em 7,5k tokens; bloco de até 20k. |
| Pesquisa | Antigravity (Gemini) | Só quando o plano depende de um fato externo. Resposta com fontes, em JSON. |
| Escrever a prova | Claude Sonnet (maker) | Escreve só o teste da parte, sem implementar. |
| Prova falha antes | motor | Roda o runner (Vitest, `npm test` ou pytest). A prova nova tem de falhar. |
| Implementar | Claude Sonnet + skills | Implementa até a prova passar e os critérios valerem. |
| Prova passa depois | motor | Todas as provas verdes. |
| Portão visual | Impeccable detect | Em pedidos com interface: varre o código atrás de cara de template; se achar, força uma rodada de retoque. |
| Revisão | Codex GPT-5.6 Terra (revisor) | Lê o diff em modo somente leitura e aprova ou pede mudanças (até 3 rodadas automáticas). |
| Entrega | motor | Cada parte aprovada vira um commit `ade: <parte>` na sua pasta. |

Quem escreve e quem revisa têm de ser de empresas diferentes. Modelos por papel em "Modelos": Claude (Sonnet, Opus, Fable, Haiku), Codex (GPT-5.6 Terra/Sol/Luna, GPT-6 Astra, GPT-5.5), Antigravity (Gemini 3.1 Pro, 3.8 Flash, e Claude/GPT-OSS via Google).

## Proteções

- A pasta precisa estar sem alterações pendentes para começar: assim "descartar" desfaz só o que a ADE fez.
- O Claude roda em `--safe-mode`: sem os seus hooks, CLAUDE.md, MCPs e skills globais; só recebe o que a ADE injeta.
- Com "rodar comandos" ligado, a IA pode instalar dependências e criar o projeto (equivale a "ignorar permissões" do Claude desktop). Desligue em Opções para ela só ler e editar.
- O Codex revisa em sandbox somente leitura.

## Limites conhecidos

- Cota do plano (5 h / semanal) não é exposta pelas CLIs em modo silencioso; o painel mostra chamadas, tokens e custo em dólar do Claude.
- Sem retomada após queda do servidor: uma missão interrompida fica registrada em `.ade/journal.jsonl`, mas não continua sozinha.
- Um projeto por vez.
- O seletor de pasta é um campo de texto, não uma janela do Windows.

## Arquivos

- `server.mjs`: motor, adaptadores das três CLIs, catálogo de skills, API e eventos ao vivo.
- `src/App.jsx`: painel (React + Radix Themes + Tailwind + Geist).
- `review.schema.json`, `research.schema.json`: formatos de resposta do revisor e da pesquisa.
- `.ade/`: configurações, projetos recentes, histórico e journal (não versionado).
- `example/`: projeto de exemplo com um bug de propósito.
