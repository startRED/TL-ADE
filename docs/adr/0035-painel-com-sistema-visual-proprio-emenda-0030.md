# ADR 0035 — Painel com sistema visual próprio, sem Radix Themes (emenda o ADR 0030)

**Status:** Aceito (pedido de Erick, 2026-09-23: frontend no nível do site do Hermes Agent e do Alethe, com animação e paletas)

## Contexto

O [ADR 0030](0030-typescript-no-motor-e-build-do-painel.md) fixou o painel em React 19 + TypeScript + Vite com Radix Themes
e ícones Phosphor. O Radix Themes entrega um visual pronto e genérico; o pedido é o contrário: um mundo visual próprio,
com tipografia, ilustração, movimento e paletas escolhidas. ADR aceito não se edita; este emenda o 0030.

## Decisão

1. **Sai o Radix Themes; ficam React, Vite e Phosphor.** Os controles são elementos nativos (`button`, `input type=radio`,
   `textarea`) com `role` e nomes acessíveis explícitos; o estilo mora em `packages/web/src/app.css`, em variáveis CSS.
2. **Mundo "Partitura".** A missão é desenhada como partitura de regente: uma pauta por papel (escreve, prova, revisa,
   motor), um compasso por parte, a batuta no agora. Notação real pela fonte Bravura (SMuFL, OFL).
3. **Dependências novas só no painel:** `motion` (animação), `lenis` (rolagem suave) e fontes auto-hospedadas pelo
   Fontsource (Bodoni Moda, Geist, Geist Mono, Bravura). Nenhuma chamada a CDN: o painel roda offline.
4. **Aparência:** modo claro, escuro ou do sistema e cinco paletas (Grafite, Meia-noite, Brasa, Mono, Ardósia), guardados
   no navegador. `data-theme` e `data-palette` na raiz do documento.
5. **Ilustrações** são gravuras geradas pelo Codex, convertidas para WebP com a tinta como canal alfa; os prompts ficam em
   `packages/web/.impeccable/prompts/`.

## Consequências

- As provas de interface procuram papel e nome acessível, não classes do Radix; a do modo noturno lê `data-theme`.
- Movimento respeita `prefers-reduced-motion`.

## Como reverter

Voltar `packages/web/src` e `packages/web/package.json` ao commit anterior a este ADR.
