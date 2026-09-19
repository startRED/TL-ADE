# Modelos por papel — benchmarks independentes e medição própria (setembro de 2026)

Data: 2026-09-19. Responde: qual modelo usar para planejar, escrever, corrigir, revisar e bater (batedor) na
ADE, só com avaliações feitas por terceiros e com o que medimos nas missões da demo (`proto/`).

## Regra desta versão

Número publicado pela própria empresa (blog, cartão do modelo, página de lançamento) ficou de fora. Cada fabricante
escolhe as provas e a configuração em que sai no topo. Entram só placares que um terceiro rodou com o mesmo
arnês para todos os modelos: Artificial Analysis, Vals AI, ARC Prize, Arena (antigo LMArena), Scale Labs,
Terminal-Bench, SWE-bench (equipe SWE-agent), METR, Epoch AI e CodeReviewBench. Estimativas marcadas pela
própria fonte como "estimate" também ficaram de fora.

Como foi coletado: 6 pesquisas web em 19/09 (3 grupos de fontes, cada grupo pesquisado duas vezes: Gemini 3.8
Flash high via agy e GPT-5.6 Terra via `codex --search`). Saíram 354 linhas, cada uma com quem rodou, URL, data e
trecho da página. As linhas brutas estão em [`models-independent-2026-09.json`](models-independent-2026-09.json).

Marcação nas tabelas:

- **[2 buscas]**: as duas pesquisas acharam o mesmo número, cada uma por conta própria.
- **[1 busca]**: só uma pesquisa achou.
- **[conferido]**: abri a página em 19/09 e o número estava lá.

## Cuidados antes de ler os números

- **Arena mede preferência de voto, não acerto.** No Text Arena os intervalos se sobrepõem: de Opus 4.6 (1505) a
  GPT-5.6 Terra (1466) a diferença cabe em poucos desvios. Não separa os modelos para a ADE.
- **O esforço muda muito o resultado.** No índice da Artificial Analysis o GPT-5.6 Terra vai de 30 (medium) a 42
  (max), e o Sol vai de 39 (medium) a 47 (max). Compare modelo e esforço juntos.
- **Placares antigos cobrem modelos antigos.** Scale SWE-Bench Pro, Terminal-Bench 2.1, SWE-bench bash-only e
  METR só têm Opus 4.6, Sonnet 4.6, Haiku 4.5 e Gemini 3.1 Pro. Servem para os modelos Claude que o agy oferece
  pela cota do Google.
- **Lacunas.** Não há SWE-Bench Pro independente para GPT-5.6, GPT-6 Astra, Fable 5.1, Opus 5 ou Gemini 3.8. O
  Aider não testou nenhum destes modelos. As páginas do LiveBench e as de código e agente da Artificial Analysis
  não abriram. **Não há benchmark independente de revisão de código** que cubra estes modelos (seção 5).

## 1. Visão geral: inteligência, custo e velocidade

Fonte: Artificial Analysis, Intelligence Index v4.3, consultado em 19/09 [2 buscas]. Uma pesquisa leu o
[placar](https://artificialanalysis.ai/leaderboards/models) e a outra leu as páginas de cada modelo (por exemplo
[gemini-3-8-flash](https://artificialanalysis.ai/models/gemini-3-8-flash)). O custo é o custo em US$ para rodar o
índice inteiro, em preço de API. Na ADE do Erick tudo roda por assinatura, então esse custo serve de proxy do peso
de cada chamada na cota.

| Modelo (esforço) | Índice | Custo do índice (US$) | Tokens/s |
| :--- | ---: | ---: | ---: |
| GPT-6 Astra (max) | 53 | 3,26 | 57 |
| Claude Fable 5.1 (max) | 53 | 7,63 | 69 |
| Claude Opus 5 (max) | 51 | 5,86 | 51 |
| GPT-6 Astra (medium) | 50 | 1,54 | 49 |
| Claude Opus 5 (high) | 48 | 3,61 | 53 |
| GPT-5.6 Sol (max) | 47 | 1,99 | 61 |
| GPT-5.6 Sol (high) | 42 | 0,81 | 63 |
| GPT-5.6 Terra (max) | 42 | 1,40 | 84 |
| Gemini 3.8 Flash (high) | 41 | 1,24 | **298** |
| Gemini 3.8 Flash (medium) | 40 | 0,93 | — |
| Gemini 3.7 Flash (high) | 39 | 0,93 | 288 |
| GPT-5.5 (xhigh) | 39 | 2,63 | 79 |
| GPT-5.6 Sol (medium) | 39 | 0,50 | 57 |
| Claude Sonnet 5 (max) | 38 | 5,09 | 74 |
| GPT-5.6 Luna (max) | 38 | 0,18 | 130 |
| GPT-5.6 Terra (high) | 34 | 0,34 | 84 |
| Claude Opus 4.6 (max) | 32 | — | 37 |
| GPT-5.6 Luna (high) | 32 | 0,04 | 137 |
| Claude Sonnet 4.6 (max) | 30 | — | 44 |
| GPT-5.6 Terra (medium) | 30 | 0,18 | 69 |
| Gemini 3.1 Pro (preview) | 30 | 0,67 | 119 |
| Claude Haiku 4.5 (reasoning) | 18 | 0,21 | 92 |

Leitura:

- **Topo:** Astra e Fable 5.1 empatam. O Astra custa menos da metade.
- **Sonnet 5:** é o pior custo-benefício da tabela. Faz 38 pontos a US$ 5,09, o mesmo índice do Luna a US$ 0,18.
- **Gemini 3.8 Flash:** empata com o Terra no máximo e é 3,5 vezes mais rápido.
- **Gemini 3.1 Pro:** fica abaixo dos dois Flash em tudo, menos no preço.

## 2. Código com agente

**Vals AI:**

- [Terminal-Bench 4.0](https://www.vals.ai/benchmarks/terminal-bench-4): arnês Terminus 2, média de 3 tentativas,
  atualizado em 16/09.
- [IOI](https://www.vals.ai/benchmarks/ioi): problemas de olimpíada de programação de 2024 a 2026, arnês
  OpenCode, atualizado em 15/09.
- [Vals Index](https://vals.ai/benchmarks), perfil agentic ponderado por PIB: atualizado em 15/09 [1 busca]. A
  ordem dos 3 primeiros foi [conferida].

| Modelo | Terminal-Bench 4.0 | IOI | Vals Index |
| :--- | ---: | ---: | ---: |
| GPT-6 Astra | **57,07%** [conferido] | **100%** | 66,6 |
| Claude Fable 5.1 | 49,49% [conferido] | 90,78% | **68,8** |
| Claude Opus 5 | 45,45% [conferido] | 84,33% | 67,2 |
| GPT-5.6 Sol | — | 91,17% | 63,7 |
| Gemini 3.8 Flash | — | 56,94% | 62,3 |
| Gemini 3.7 Flash | — | 67,83% | 59,3 |
| GPT-5.6 Terra | — | 87,61% | — |
| GPT-5.6 Luna | — | 61,78% | — |
| GPT-5.5 | — | — | 57,4 |
| Claude Sonnet 4.6 | — | — | 50,6 |
| Claude Sonnet 5 | 8,08% | 45,00% | — |
| Gemini 3.1 Pro | — | — | 41,9 |
| Claude Haiku 4.5 | — | — | 22,9 |

No Terminal-Bench 4.0, a Vals diz que os outros 25 modelos testados ficaram entre 27,78% e 0%. Sol, Terra e
Gemini 3.8 Flash estão nessa faixa, sem número individual na página. Fora da Vals, a Artificial Analysis dá ao
GPT-5.6 Sol (max) 65,9% no [Terminal-Bench Hard](https://artificialanalysis.ai/evaluations/terminalbench-hard)
[1 busca].

**Arena, [Code Arena WebDev](https://arena.ai/leaderboard/code/webdev)** (voto da comunidade em apps web gerados,
Elo, 11/09) [2 buscas]:

| Modelo | Elo |
| :--- | ---: |
| GPT-6 Astra (max) | 1800 |
| Claude Fable 5.1 (max) | 1758 |
| Claude Opus 5 (max / high) | 1687 / 1660 |
| GPT-5.6 Sol (xhigh) | 1617 |
| Gemini 3.7 Flash (high) | 1587 |
| Gemini 3.8 Flash (high) | 1568 (preliminar) |
| Claude Opus 4.6 (high) | 1547 |
| Claude Sonnet 5 (high) | 1537 |
| GPT-5.6 Terra (xhigh) | 1521 |
| Claude Sonnet 4.6 | 1521 |
| GPT-5.6 Luna (xhigh) | 1519 |
| GPT-5.5 (xhigh) | 1510 |
| Gemini 3.1 Pro (preview) | 1447 |
| Claude Haiku 4.5 | 1329 |

**Modelos que o agy oferece pela cota do Google** (placares mais antigos):

| Modelo | SWE-Bench Pro público / privado | Terminal-Bench 2.1 | SWE-bench Verified | Horizonte METR |
| :--- | ---: | ---: | ---: | ---: |
| Claude Opus 4.6 | 51,9% / 47,1% [2 buscas] | 63,8% | 75,6% | ~12,0 h |
| Gemini 3.1 Pro | 46,1% / 32,2% [2 buscas] | 70,7% | — | ~6,4 h |
| Claude Sonnet 4.6 | — | 51,5% | — | — |
| Claude Haiku 4.5 | 39,45% / — | — | 66,6% | — |

Fontes da tabela:

- **SWE-Bench Pro:** Scale Labs, arnês mini-swe-agent; placar
  [público](https://labs.scale.com/leaderboard/swe_bench_pro_public) e
  [privado](https://labs.scale.com/leaderboard/swe_bench_pro_private).
- **Terminal-Bench 2.1:** [tbench.ai](https://www.tbench.ai/news/terminal-bench-2-1), Terminus 2, 06/05 [1 busca].
- **SWE-bench Verified:** [swebench.com](https://www.swebench.com), só bash, mini-SWE-agent 2.0, 17/02 [1 busca].
- **Horizonte METR:** [METR](https://metr.org/time-horizons/), duração de tarefa humana que o modelo acerta 50%
  das vezes; 20/02 e 15/04 [1 busca].

## 3. Raciocínio (planejar, decidir)

Fonte: [ARC Prize](https://arcprize.org/leaderboard), resultados de 04/09 [1 busca]. O ARC-AGI-2 do Astra foi
[conferido] na [página do resultado](https://arcprize.org/results/openai-gpt-6-astra).

| Modelo | ARC-AGI-2 | ARC-AGI-3 |
| :--- | ---: | ---: |
| GPT-6 Astra (max) | **95,0%** | 62,71% (arnês padrão) [conferido] |
| GPT-5.6 Sol (max) | 92,5% | 7,78% |
| Claude Opus 5 (max) | 90,42% | 30,16% (high) |
| Claude Fable 5.1 (max) | 90,0% | — |
| GPT-5.5 (xhigh) | 85,0% | 0,43% |
| Gemini 3.7 Flash (high) | 84,58% | — |
| GPT-5.6 Terra (max) | 83,9% | 0,80% |
| Claude Opus 4.6 (max) | 78,33% | — |
| Gemini 3.1 Pro (preview) | 75,0% | 0,42% |
| Claude Sonnet 5 (high) | 68,33% | — |
| GPT-5.6 Luna (max) | 59,54% | 0,18% |
| Claude Sonnet 4.6 (high) | 55,83% | — |
| Claude Haiku 4.5 | 41,67% | — |

O Gemini 3.8 Flash não aparece no ARC. Outros números soltos da Artificial Analysis [1 busca]:

- **GPQA Diamond:** Astra 96,3%, Gemini 3.8 Flash 95,3%.
- **Humanity's Last Exam:** Fable 5.1 59,1%.
- **SciCode:** Fable 5.1 63,1%.

O Epoch Capabilities Index só trouxe o Astra (166, avaliação antes do lançamento).

## 4. Preferência em texto

Fonte: Arena, [Text Arena](https://arena.ai/leaderboard/text), 13/09 [2 buscas]. A faixa vai de 1505 (Opus 4.6
high) a 1452 (Luna). Fable 5.1 faz 1498, Gemini 3.8 Flash 1493 (preliminar) e Opus 5 1493. Com ±3 a ±12 de
intervalo, só o Haiku 4.5 (1415) se separa. Não pesa na escolha.

## 5. Revisão de código

Nenhum placar independente cobre revisão de diff para estes modelos. O único achado foi o
[CodeReviewBench](https://www.codereviewbench.com/leaderboard), mantido pela Kodus, que vende revisor de código
[2 buscas]. Ele só tem o Gemini 3.7 Flash, com F1 de 20,0: precisão de 73,9% e recall de 11,6%. Ou seja, o que
ele aponta costuma ser real, mas ele deixa passar quase tudo.

Por isso a escolha do revisor se apoia em três coisas:

- a medição da seção 6;
- a regra do motor (revisor de outro fornecedor);
- os indicadores gerais: Vals Index, velocidade e custo.

## 6. Medido nas missões da demo

Cuidados: projetos e partes diferentes, sem controle de dificuldade. Até 19/09 a prova e o código saíam em duas
chamadas por parte, e só depois numa chamada. Serve para achar tendência, não para ranquear. Fonte: journal do
motor (`proto/.ade/journal.jsonl`, 777 chamadas, 16–19/09).

| Quem escreveu primeiro | Partes | Commitadas | Chamadas de escrever por parte | Custo |
| :--- | ---: | ---: | ---: | :--- |
| Gemini 3.8 Flash high | 52 | 45 (87%) | 3,2 | cota Google |
| Claude Sonnet 5 | 46 | 30 (65%) | 2,7 | US$ 84,73 (API equivalente) |
| Gemini 3.8 Flash medium | 21 | 18 (86%) | 3,7 | cota Google |
| GPT-5.6 Terra | 16 | 13 (81%) | 2,6 (6 numa chamada só) | cota Codex |
| Claude Opus 5 | 5 | 2 | 2,4 | US$ 64,48 (todas as chamadas de escrever) |

| Revisor | Aprovou | Pediu mudanças |
| :--- | ---: | ---: |
| GPT-5.6 Terra | 92 | 129 |
| Claude Sonnet 5 | 18 | 1 |
| Claude Opus 5 | 3 | 5 |
| Gemini 3.8 Flash high | 2 | 1 (19/09: pegou o import quebrado que derrubou o painel; as provas não pegaram) |

Tempos medianos:

| Chamada | Tempo |
| :--- | ---: |
| Codex (qualquer papel) | 74 s |
| Gemini 3.8 Flash high escrevendo | 177 s |
| Opus planejando | 286 s |
| Fable planejando | 434 s |
| Sonnet revisando | 85 s |
| Opus revisando | 171 s |

Sonnet 5 escrevendo: commitou menos (65%) e custou mais, o que casa com os placares independentes (TB 4.0 8,08%,
IOI 45%).

## 7. Recomendação por papel

| Papel | 1ª escolha | Degraus seguintes | Evidência independente |
| :--- | :--- | :--- | :--- |
| Dividir em épicos | Claude Fable 5.1 | GPT-6 Astra | Fable lidera o Vals Index (68,8) e empata no topo da AA; Astra empata por menos da metade do custo |
| Planejar o épico | Claude Opus 5 | GPT-6 Astra (medium) | Opus 5: AA 48 (high), Vals Index 67,2, TB 4.0 45,45%, ARC-AGI-2 90,4%. Astra medium: AA 50 por US$ 1,54 |
| Criticar o plano | fornecedor diferente do planejador: Astra se planejou Claude; Opus 5 se planejou Astra | GPT-5.6 Sol | Astra lidera TB 4.0, IOI e ARC-AGI-2; Sol vem logo atrás no ARC-AGI-2 (92,5%) |
| Escrever (prova e código) | GPT-5.6 Terra high | Sol, depois Gemini 3.8 Flash high | Terra: IOI 87,6%, 84 tokens/s; medido 81% commitadas. Sol medium faz mais índice que Terra high (39 contra 34) por US$ 0,50 contra 0,34, porém mais devagar. Flash: Vals Index 62,3, perto do Sol, e 87% medido |
| Escrever parte leve | GPT-5.6 Luna high | Terra | Luna max: AA 38 por US$ 0,18 (1/8 do Terra max), 130 tokens/s; IOI 61,8% |
| Corrigir (rodada 3+) | GPT-6 Astra high | Claude Opus 5; via Google, Opus 4.6 | Astra: TB 4.0 57%, IOI 100%. Opus 4.6: SWE-Bench Pro 51,9% (Scale), METR ~12 h |
| Revisar | Gemini 3.8 Flash high | Opus 4.6 via Google, depois Opus 5 | sem placar independente de revisão; Flash é de outro fornecedor que o Codex, Vals Index 62,3, 298 tokens/s; medido: pegou bug que as provas não pegaram |
| Batedor e pesquisa | Gemini 3.8 Flash low/medium | — | AA 40 (medium) por US$ 0,93, o mais rápido da tabela |

Fica de fora:

- **Gemini 3.1 Pro:** AA 30, Vals Index 41,9, WebDev 1447. Abaixo dos dois Flash em quase tudo; ganha só no
  Terminal-Bench 2.1 antigo.
- **Claude Sonnet 5 escrevendo ou corrigindo:** pior custo-benefício da AA, 8% no TB 4.0 e medido pior aqui.
  Serve de último degrau.

Regras que ficam:

- O revisor é sempre de outro fornecedor que quem escreveu. O motor já evita o mesmo fornecedor.
- Com a cota de um fornecedor acima de 90%, ele vira último degrau (reserva do motor).

Estado em 19/09 à tarde: Claude com 90% da cota semanal (renova 22/09), Codex com 11%, Google AI Ultra livre.

Cadeias ativas no motor:

| Papel | Cadeia |
| :--- | :--- |
| Épicos | Fable medium > Astra medium |
| Plano | Opus high > Astra medium |
| Prova | Terra medium > Flash high |
| Escrever | Terra high > Sol medium > Flash high |
| Escrever leve | Luna high > Terra medium |
| Escrever difícil e corrigir | Terra high > Astra high > Opus 4.6 via Google |
| Revisar | Flash high > Opus 4.6 via Google > Opus 5 high |

Elas seguem esta tabela. O segundo degrau do plano passou de Astra low (AA 46) para medium (AA 50) em 19/09.
