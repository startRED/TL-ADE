# TL-ADE — Carta do Projeto

## O que a ADE é

A ADE é um scheduler durável, um compilador de contexto e um compilador de intenção. Ela recebe uma
intenção do operador, produz um plano de Task Contracts com aprovação única, e despacha esse plano
para assistentes de IA reais (Claude Code, Codex e, opcionalmente, Antigravity) através de um engine
que escreve tudo em um journal encadeado por hash, com lease, worktree por story, contenção pós-fato
e reconciliação por classe de efeito. Cada story roda um ciclo eval-first: a prova nasce vermelha,
o Maker implementa, a prova fica verde, e o resultado termina em um commit local. A ADE existe para
que uma story rode sozinha do começo ao commit, de forma auditável e recuperável de qualquer crash.

## O que a ADE não é

A ADE não é um IDE, não é um chat de propósito geral e não é um substituto para o julgamento do
operador: o portão substitui a revisão linha a linha, não o humano. A ADE não é um orquestrador que
aposta em janela de contexto maior — o gargalo de missões longas é seguir instrução, não tamanho de
contexto, e o investimento vai para o contrato, não para o modelo. A ADE não reimplementa o que os
binários instalados já fazem nativamente (`claude`, `codex`); ela só escreve o que é insubstituível:
o journal, o Task Contract com eval provado, e o Context Pack.

## Regra de ampliação de escopo (o que não pode entrar no código nesta fatia)

Esta fatia entrega apenas a fundação: o pacote TypeScript estrito na raiz, os oito contratos de dados
publicados (`journal-event`, `ade-config`, `plan`, `task-contract`, `eval`, `unit-result`,
`review-result`, `capability-set`) com seus validadores ajv, e a canonicalização JCS com o digest de
16 hex do SHA-256. Nada além disso entra em `src/` nesta fatia: sem painel web, sem Intent Compiler,
sem entrevista, sem push/PR/merge, sem scheduler, sem adapters de despacho real. `proto/` é a demo e
continua funcionando como está, intocada. Qualquer pedido de ampliar o escopo desta fatia — adicionar
um recurso não listado nos critérios de aceite da story atual — é recusado até a story seguinte ser
aberta explicitamente; a ordem do roadmap é fixa e não é renegociada dentro de uma fatia em andamento.
