# Modelos por papel — benchmarks e medição própria (setembro de 2026)

Data: 2026-09-19. Responde: qual modelo usar para planejar, escrever, corrigir, revisar e bater (batedor) na
ADE, pelo que dizem os benchmarks públicos e pelo que medimos nas missões da demo (`proto/`).

Marcação: **[relatado: domínio]** = número coletado por pesquisa web (3 buscas no Gemini 3.8 Flash high e 1 no
Sonnet 5, 19/09), com o domínio que a pesquisa citou, sem conferência página a página; **[medido]** = saída do
journal do motor (`proto/.ade/journal.jsonl`, 777 chamadas, 16–19/09). Onde duas fontes divergem, as duas aparecem.

## Cuidados antes de ler os números

- **Versões de benchmark não se comparam.** Terminal-Bench 2.0, 2.1 e 4.0 são provas diferentes: o Gemini 3.8 Flash
  faz 90,8% no 2.1 e ~19% no 4.0. Só compare na mesma coluna.
- **SWE-bench Verified saturou** (topo em ~95–96%, números de agregadores). **SWE-bench Pro** separa melhor.
- **Índice da Artificial Analysis** aparece em versões diferentes (v4.x) nas fontes; ficou de fora das tabelas.
- **Não há benchmark público confiável de revisão de diff.** Os proxies são DeepSWE (achar e consertar bug),
  Frontier-Bench (Anthropic) e o medido aqui.
- Os números de agregadores (llm-stats, benchlm, vellum, datacamp, codingfleet) precisam de conferência na fonte
  primária antes de virar decisão de arquitetura.

## 1. Código com agente

| Modelo | SWE-bench Pro | Terminal-Bench 2.1 | Terminal-Bench 4.0 | LiveCodeBench | Fonte [relatado] |
| :--- | ---: | ---: | ---: | ---: | :--- |
| Claude Fable 5.1 | 81,2% | — | 55,8% (~58%) | ~90,5% | zenmux, datacamp, openrouter |
| Claude Fable 5 | 80,3% | 84,3% | — | ~90% | llm-stats, openrouter |
| Claude Opus 5 | 79,2% | — | 51,8–52,3% | — | zenmux, cometapi, anthropic.com |
| GPT-6 Astra | — | — | 58,2–59,6% | 91,5% | artificialanalysis, llm-stats, openai.com |
| GPT-5.6 Sol | 64,6% | 88,8–89,1% | 37,3% | 82,6% | openai.com, benchlm |
| GPT-5.6 Terra | 63,4% | 87,4% | — | — | codingfleet |
| Claude Sonnet 5 | 63,2% | 80,4% | — | ~82,4% | vellum, openrouter |
| GPT-5.6 Luna | 62,7% | 84,7% | — (3.0: 14,3%) | — | openai.com, chatsmith |
| Gemini 3.8 Flash | 61,6% | **90,8%** | 19,1–19,7% | — | blog.google, deepmind.google |
| Gemini 3.7 Flash | 60,4% | 85,8% | — | 88,7% | blog.google, vals.ai |
| GPT-5.5 | 58,6% | (2.0: 82,7%) | — | Aider 81,3% | openai.com |
| Gemini 3.1 Pro | 54,2% | (2.0: 68,5%) | — | Elo 2887 (Pro) | deepmind.google |
| Claude Sonnet 4.6 | — | 67,0% | — | ~82,1% | vellum |
| Claude Opus 4.6 | — (Verified 80,8%) | — | — | ~88,8% | anthropic.com |
| Claude Haiku 4.5 | — (Verified 73,3%) | — | — | ~41–51% | anthropic.com |
| GPT-OSS 120B | — (Verified 62,4%) | — | — | — | openai.com |

Leitura: em tarefa longa e difícil (SWE-bench Pro, Terminal-Bench 4.0) a fronteira é Fable 5.1, Opus 5 e GPT-6
Astra. Em tarefa de terminal comum (2.1), GPT-5.6 Sol/Terra e Gemini 3.8 Flash empatam no topo, a uma fração do custo.

## 2. Achar bugs e revisar

| Modelo | Proxy de revisão | Fonte [relatado] |
| :--- | :--- | :--- |
| Claude Opus 5 | Frontier-Bench v0.1 43,3% (estado da arte; "4x menos bugs não detectados em code review") | anthropic.com |
| GPT-6 Astra | DeepSWE v1.1 74,1%; ExploitBench 100% | vellum, openai.com |
| Gemini 3.8 Flash | DeepSWE v1.1 73,7% | deepmind.google |
| GPT-5.6 Sol | DeepSWE 72,7%; ExploitBench 78,5% | openai.com, penligent |
| GPT-5.6 Terra | DeepSWE v1.1 69,6% | codingfleet |
| Gemini 3.7 Flash | DeepSWE v1.1 65,3% | deepmind.google |
| Gemini 3.8 Flash Cyber | CWE-Bench 47,2% (acesso restrito, programa Fairwind) | blog.google |

## 3. Raciocínio (planejar, decidir)

| Modelo | GPQA Diamond | HLE | ARC-AGI-2 | Fonte [relatado] |
| :--- | ---: | ---: | ---: | :--- |
| GPT-6 Astra | 96,0% | 54,7–57,2% | (ARC-AGI-3 99,9%) | openai.com, datacamp |
| Claude Fable 5.1 | 93,2–93,7% | 60,9% (65,0% com ferramentas) | 90,0% | anthropic.com, arcprize |
| Claude Opus 5 | 93,2–93,4% | 55–65% (64,7%) | 90,4% | vellum, anthropic.com |
| Claude Sonnet 5 | 91,1–96,2% | ~57% | 84,7% | vellum |
| GPT-5.6 Sol | 94,1–94,6% | 49,5% | (ARC-AGI-3 7,8%) | openai.com |
| Gemini 3.1 Pro | 94,3% | — | 77,1% | deepmind.google |
| GPT-5.6 Terra | 92,9% | 50,4% | — | codingfleet |
| Gemini 3.8 Flash | 59–95,3% (fontes divergem) | 54,9% (HLE-Verified) | — | openrouter, blog.google |
| GPT-5.6 Luna | 89,0–91,1% | — | (ARC-AGI-3 59,6%) | openrouter, arcprize |

## 4. Custo, velocidade e contexto

Preço de API por milhão de tokens (entrada / saída) e velocidade da Artificial Analysis [relatado]. Na ADE do
Erick tudo roda por assinatura (Claude Max, Codex, Google AI Ultra): o custo real é a fatia da cota semanal, e o
preço de API serve de proxy de quanto cada chamada pesa na cota.

| Modelo | Entrada / saída (US$) | Tokens/s | Contexto |
| :--- | :--- | ---: | ---: |
| GPT-5.6 Luna | 0,20 / 1,20 | 110–128 | 1,05M |
| Gemini 3.8 Flash | 0,75 / 3,75 | **~298** | 1M |
| Claude Haiku 4.5 | 1 / 5 | ~96 | 200k |
| Claude Sonnet 5 | 2 / 10 | 72–90 | 1M |
| GPT-5.6 Terra | 2 / 12 | 84–114 | 1,05M |
| Gemini 3.1 Pro | 2 / 12 | 115–121 (latência inicial ~26 s) | 1M |
| Claude Opus 5 | 5 / 25 | ~51 | 1M |
| GPT-5.6 Sol | 5 / 30 | 58–68 | 1,05M |
| Claude Fable 5.1 | 10 / 50 | ~66 | 1M |
| GPT-6 Astra | 10 / 50 | ~50 | 1,05M |

Terra, Sol e Luna são **perfis** da família 5.6, não tamanhos: Sol é o topo (profundidade), Terra o equilibrado,
Luna o econômico [relatado: openai.com]. O registro de modelos do motor chamava o Sol de "mais leve"; corrigido.

## 5. Medido nas missões da demo

Cuidados: projetos e partes diferentes, sem controle de dificuldade; até 19/09 a prova e o código saíam em duas
chamadas por parte, e só depois numa chamada. Serve para achar tendência, não para ranquear.

| Quem escreveu primeiro | Partes | Commitadas | Chamadas de escrever por parte | Custo [medido] |
| :--- | ---: | ---: | ---: | :--- |
| Gemini 3.8 Flash high | 52 | 45 (87%) | 3,2 | cota Google |
| Claude Sonnet 5 | 46 | 30 (65%) | 2,7 | US$ 84,73 (API equivalente) |
| Gemini 3.8 Flash medium | 21 | 18 (86%) | 3,7 | cota Google |
| GPT-5.6 Terra | 16 | 13 (81%) | 2,6 (6 numa chamada só) | cota Codex |
| Claude Opus 5 | 5 | 2 | 2,4 | US$ 64,48 (todas as chamadas de escrever) |

| Revisor | Aprovou | Pediu mudanças [medido] |
| :--- | ---: | ---: |
| GPT-5.6 Terra | 92 | 129 |
| Claude Sonnet 5 | 18 | 1 |
| Claude Opus 5 | 3 | 5 |
| Gemini 3.8 Flash high | 2 | 1 (19/09: pegou o import quebrado que derrubou o painel; as provas não pegaram) |

Tempos medianos [medido]: chamada do Codex 74 s; Gemini 3.8 Flash high escrevendo 177 s; Opus planejando 286 s;
Fable planejando 434 s; Sonnet revisando 85 s; Opus revisando 171 s.

## 6. Recomendação por papel

| Papel | 1ª escolha | Degraus seguintes | Por quê |
| :--- | :--- | :--- | :--- |
| Dividir em épicos | Claude Fable 5.1 | GPT-6 Astra | maior SWE-bench Pro e HLE; Astra lidera Terminal-Bench 4.0 e GPQA |
| Planejar o épico | Claude Opus 5 | GPT-6 Astra | quase o Fable pela metade do preço; Astra quando o Claude está guardado |
| Criticar o plano | GPT-6 Astra | GPT-5.6 Sol | outro fornecedor que o planejador; raciocínio no topo |
| Escrever (prova e código) | GPT-5.6 Terra | Sol, depois Gemini 3.8 Flash high | 87,4% no TB 2.1, rápido; medido: 5 de 6 partes do épico 2 numa rodada |
| Escrever parte leve | GPT-5.6 Luna ou Gemini 3.8 Flash | Terra | 84,7–90,8% no TB 2.1 a 1/10 do preço |
| Corrigir (rodada 3+) | GPT-6 Astra | Claude Opus 5 (ou Opus 4.6 via Google) | tarefa difícil é onde TB 4.0 e SWE-bench Pro separam |
| Revisar | Gemini 3.8 Flash high | Claude Opus 5 (ou Opus 4.6 via Google), Sonnet 5 | fornecedor diferente do Codex; DeepSWE 73,7%; Opus 5 é o melhor revisor medido pela Anthropic |
| Batedor e pesquisa | Gemini 3.8 Flash low/medium | — | ~300 tokens/s, 1M de contexto, cota do Google |
| Entender o pedido | Claude Sonnet 5 | Gemini 3.8 Flash | chamada única e curta |

Regras que ficam: revisor sempre de outro fornecedor que quem escreveu (o motor já evita o mesmo fornecedor); com a
cota de um fornecedor acima de 90%, ele vira último degrau (reserva do motor); o Gemini 3.1 Pro fica de fora (abaixo
do 3.8 Flash em código, mais lento e mais caro).

Estado em 19/09 à tarde: Claude com 90% da cota semanal (renova 22/09), Codex com 11%, Google AI Ultra livre. As
cadeias ativas seguem a tabela acima com Opus 4.6 via Google no lugar do Opus 5 até a cota do Claude renovar.
