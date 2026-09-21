// Uso de modelo organizado a partir do journal do motor: um evento `model_call` por chamada.
// "Cota" segue a definição do roteiro (docs/roadmap.md, emenda de 18/09, item 15): tokens_in + cache_read + tokens_out.
// Em Codex e Gemini o cache não desconta da cota; no Claude desconta, então `quota` é o teto de consumo, não o custo exato.
// A pergunta que isto responde: quanto de cota cada família gasta e quanto entrega — é o que decide quais planos manter.

const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0)

export function callRow(e) {
  const input = num(e.tokens_in), cache = num(e.cache_read), output = num(e.tokens_out)
  return {
    ts: e.ts, mission: e.mission ?? null, family: e.family, role: e.role, model: e.model, effort: e.effort ?? null,
    story: e.story_id ?? (e.story == null ? null : String(e.story)),
    input, cache, output, quota: input + cache + output, usd: num(e.usd),
    // o maker do Codex grava duration_ms; os demais, wall_ms
    wall_s: (e.wall_ms ?? e.duration_ms) ? Math.round((e.wall_ms ?? e.duration_ms) / 1000) : null, // o maker do Codex gravava só touched antes de 21/09
    files: Number.isInteger(e.files ?? e.touched) ? (e.files ?? e.touched) : null,
  }
}

function group(rows, key) {
  const m = new Map()
  for (const r of rows) {
    const k = key(r)
    const g = m.get(k) || { key: k, calls: 0, input: 0, cache: 0, output: 0, quota: 0, usd: 0, files: 0, file_calls: 0, zero_file_calls: 0, wall_s: 0, timed_calls: 0 }
    g.calls++; g.input += r.input; g.cache += r.cache; g.output += r.output; g.quota += r.quota; g.usd += r.usd
    if (r.wall_s != null) { g.timed_calls++; g.wall_s += r.wall_s }
    if (r.files != null) { g.file_calls++; g.files += r.files; if (r.files === 0) g.zero_file_calls++ }
    m.set(k, g)
  }
  return [...m.values()]
    .map((g) => ({
      ...g,
      usd: +g.usd.toFixed(2),
      cache_share: g.input + g.cache ? +(g.cache / (g.input + g.cache)).toFixed(3) : 0,
      quota_per_call: Math.round(g.quota / g.calls),
      // só chamadas de quem escreve sabem quantos arquivos mudaram; as outras ficam fora desta conta
      // no Gemini Flash o token é barato: o que pesa é o tempo até terminar
      min_per_call: g.timed_calls ? +(g.wall_s / g.timed_calls / 60).toFixed(1) : null,
      min_per_file: g.files && g.timed_calls === g.calls ? +(g.wall_s / g.files / 60).toFixed(1) : null,
      quota_per_file: g.files ? Math.round(g.quota / g.files) : null,
    }))
    .sort((a, b) => b.quota - a.quota)
}

export function usageReport(events, { mission = null, since = null, last = 20 } = {}) {
  const rows = events
    .filter((e) => e && e.type === 'model_call' && (!mission || e.mission === mission) && (!since || String(e.ts) >= since))
    .map(callRow)
  const total = group(rows, () => 'total')[0] || null
  return {
    calls: rows.length,
    total,
    by_family: group(rows, (r) => r.family),
    by_role: group(rows, (r) => `${r.family} · ${r.role}`),
    by_model: group(rows, (r) => `${r.family} · ${r.model}${r.effort ? ` · ${r.effort}` : ''}`),
    by_story: group(rows.filter((r) => r.story != null), (r) => r.story),
    recent: rows.slice(-last).reverse(),
  }
}

export function parseJournal(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('"model_call"')) continue
    try { out.push(JSON.parse(line)) } catch { /* linha cortada no meio de uma escrita: ignora */ }
  }
  return out
}
