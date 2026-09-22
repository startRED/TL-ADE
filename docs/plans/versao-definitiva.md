# TL-ADE — versão definitiva

Pedido único do Erick (22/09/2026). A v1 fechou em `m-mu8usf5z` (US$ 360, 864 provas verdes). Esta versão deixa a TL-ADE real
mais completa que a demo (`proto/`), com tudo o que a demo aprendeu em cinco dias de missão real. As versões abaixo saem em
ordem, dentro de um pedido só; cada uma termina com a suíte inteira verde e commitada.

## Stack (decisão do Erick: "escolha um stack muito bom")

- **Backend:** TypeScript estrito executado direto pelo Node 24 (type stripping nativo, `erasableSyntaxOnly`), sem passo de
  build no backend. `src/**/*.js` com JSDoc vira `src/**/*.ts`. SQLite (`better-sqlite3`) continua. Vitest continua.
- **Frontend:** React 19 + TypeScript + Vite em `packages/web`, Radix Themes, ícones Phosphor. O painel da demo
  (`proto/src/App.jsx`, `PermissionCard.jsx`, `index.css`) é o ponto de partida, não um rascunho a ignorar. O build do front é
  portão: parte que quebra o build não passa.
- **Provas de interface:** Playwright para os fluxos do painel (pedido → plano → partes → aprovação, cartão de permissão, filas).
- Um ADR novo emenda o ADR 0023 (produção em `.js` com JSDoc) e o ADR 0027 (sem build) e atualiza `AGENTS.md`: `.ts` e build
  do front passam a valer; `npx` segue proibido; `maxBuffer` explícito e sem `shell` seguem valendo.

## v2 — Limpeza e confiança

1. **Dívida zerada.** Os 216 erros de tipos e lint (170 tsc + 46 lint no HEAD de 22/09) e as 5 provas vermelhas antigas
   (budget-controls `ca4_quota_receipt_validation_and_rejection`, engine-quota `CA1`/`CA3` — bombas de relógio datadas —,
   portões de tipos e de lint). Nenhuma supressão (`ts-ignore`, `oxlint-disable`), nenhum afrouxamento de `strict`.
2. **Migração para TypeScript** (junto com a limpeza, arquivo por arquivo, provas verdes a cada passo).
3. **Portões por diagnóstico, não por prova agregada.** Tipos e lint comparados com o último commit: erro NOVO trava a parte;
   dívida antiga não esconde regressão (lição: uma prova agregada vermelha na largada deixou passar erro novo em toda parte).
4. **As lições do motor da demo, cada uma com prova própria.** Fontes: `proto/server.mjs`, `proto/rounds.mjs`,
   `proto/lanes.mjs`, `proto/runners.mjs`, `proto/planning.mjs` e os comentários que citam a missão de origem. Mínimo:
   - Diff de uma parte medido contra o commit-base dela, nunca contra o índice; restaurar árvore descartada faz `reset` do índice.
   - Nenhum caminho apaga trabalho sem guardar a árvore numa ref (`refs/ade/descartada/<hora>`); pausa e retomada guardam a
     árvore de parte interrompida quando ela pertence ao contrato.
   - Estado da missão religado por id ao carregar (nunca referência de objeto); estado por épico zerado ao começar o épico;
     suíte de fim de épico e revisão de plano pendentes são estado durável.
   - Prova vermelha na largada não é cobrada da parte, uma a uma; prova que só estoura tempo repete com limite folgado por
     prova antes de abrir rodada; a suíte de fim de épico faz o mesmo ignorando as vermelhas da largada.
   - Maker cortado no teto de turnos repete no mesmo degrau com mais turnos; subir de degrau nunca dá menos turnos.
   - Chamada que termina sem mudar arquivo, ou bloqueada pelo ambiente, passa ao próximo modelo e não conta como rodada.
   - Escada de correção: 2 rodadas por degrau, reserva fora da escada, sem correção de correção, a correção não marca a
     original como pronta e leva os achados graves junto das provas vermelhas.
   - Revisor recebe o mesmo contrato que o maker (escopo, `do_not_touch`, `out_of_scope`, interfaces, decisões do plano),
     os achados anteriores e a resposta do maker; retira achado recusado com citação válida; achado novo só se grave.
   - "Prova errada" julgada por um revisor antes de o maker poder mexer só naquela prova.
   - Cota esgotada pausa com hora de renovação e retoma sozinha; texto de conversa e `error_max_turns` nunca viram cota.
   - Trilhos paralelos em worktrees sem estado global do git (nada de `stash`); pasta de estado fora do dev server.
   - Planejador sem contagens fixas de épicos e partes; story cujo critério depende de dado só do operador vira decisão humana;
     crítica do plano com fallback para outra empresa quando falha.
   - Runner universal: resultado prova a prova (JUnit XML/JSON/TRX/`go -json`/cargo), suítes em subpastas, `node --test`.
5. **Custo por chamada e por parte** registrados no journal (preço de API equivalente, tokens, cache, minutos) e a medida da
   parte no commit (critérios, arquivos, rodadas, US$).

## v3 — Modelos pelos planos

1. Porta de `proto/models.mjs`: catálogo com dados da Artificial Analysis (inteligência, custo por tarefa, tempo de resposta),
   planos por empresa (Claude Pro/Max 5x/Max 20x/API; ChatGPT Plus/Pro 5x/Pro 20x/API; Google Gratuito/AI Pro/AI Ultra R$ 750/
   AI Ultra R$ 1.000), papéis com mínimo de inteligência, volume e peso do tempo.
2. Dois retornos separados: **capacidade** (ritmo da cota semanal projetado até a renovação; sem leitura, pelo tamanho do
   plano) e **qualidade** (aprovação do revisor e chamadas sem mudança, medidas no journal, só em papéis de quem escreve).
3. Filas refeitas a cada leitura de cota; quem escreve e quem revisa de empresas diferentes; escada sobe em inteligência e
   termina com reserva de outra empresa; esforços `low` a `max` por CLI; modelos bloqueados pelo usuário.
4. **Rodadas de correção pelo risco da parte** (ideia do astra-flash-orchestrator): parte comum ganha menos rodadas antes de
   subir de degrau; segurança, login, pagamento e migração de banco ganham mais.
5. Campo para o usuário informar à mão a cota de quem não expõe leitura (Google).
6. Relatório de uso por empresa: cota consumida × trabalho entregue, custo por 1.000 linhas aprovadas, tempo por chamada —
   base para o usuário decidir quais planos manter.

## v4 — Do pedido ao produto

1. **Descoberta de produto** no Intent Compiler: entrevista curta de múltipla escolha (recomendação primeiro, no máximo 5
   perguntas) antes do plano técnico, com a origem de cada decisão (usuário, IA supondo, padrão).
2. **Briefing** em pedido grande: o que entra, o que fica fora, o que é pronto, versões; o usuário aprova.
3. **Commit ligado à conversa:** todo commit do motor leva no rodapé missão, parte, rodada, modelo e o id da chamada no
   journal; `ade` abre a conversa que gerou um commit.
4. **Medição de entrega:** tempo até a entrega aprovada, rodadas por parte, correções feitas pelo usuário depois.
5. Crítica do plano revalidada depois de o plano ser corrigido; contexto por trechos e símbolos no pacote do maker.

## v5 — Painel completo

Tudo o que o painel da demo faz, no painel da real, sobre a API e o WebSocket da real: vários projetos abertos; pedido,
entrevista, briefing, plano e aprovação; partes com passos, diff, provas e parecer do revisor; chat com cópia do projeto e
cartão de permissão (aprovar/recusar); página Modelos com planos, filas montadas e o porquê; cota da semana por empresa;
relatório de uso; skills e plugins; opções (modo noturno, autonomia, tetos, faixa rápida, portão visual, imagens,
pesquisa). O painel é servido do último build (parte que edita o painel não derruba a tela do usuário).

## Ponto de virada

Quando a real fizer tudo o que a demo faz, ela passa a desenvolver a si mesma (`ade run`) e a demo vira referência. Esta
versão só fecha com um dogfood: a real executa um pedido pequeno de ponta a ponta sobre um projeto de exemplo, com
filas pelos planos, revisão de outra empresa e painel, registrado em `docs/operations/`.

## Fora do escopo

- Publicar sessões ou código em serviço externo; `git push`.
- Alterar `proto/**` (a demo fica como está e segue desenvolvendo a real).
