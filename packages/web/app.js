// @ts-check

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(window.location.search)
const sessionToken = params.get('session') || ''

let snapshot = null
let selectedMissionId = ''
let selectedStoryId = ''
let selectedTab = 'diff'
let logFilter = ''
let lastSeq = 0
let ws = null
let reconnectTimer = null

const pillText = {
  committed: 'Pronta',
  delivered: 'Pronta',
  complete: 'Pronta',
  in_progress: 'Em andamento',
  running: 'Em andamento',
  awaiting_operator: 'Aguardando você',
  await: 'Aguardando você',
  queued: 'Na fila',
  planned: 'Na fila',
}

const unavailable = 'Indisponível'

function formatMoney(value) {
  return value == null ? unavailable : `US$ ${Number(value).toFixed(2)}`
}

function statusClass(status) {
  if (status === 'committed' || status === 'delivered') return 'complete'
  if (status === 'in_progress') return 'running'
  if (status === 'awaiting_operator') return 'await'
  return 'queued'
}

function toast(message) {
  const t = $('toast')
  if (!t) return
  t.textContent = message
  t.classList.add('on')
  setTimeout(() => t.classList.remove('on'), 2500)
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

async function loadSnapshot() {
  try {
    const res = await fetch(`/api/snapshot?session=${encodeURIComponent(sessionToken)}`)
    if (!res.ok) {
      throw new Error(`Falha ao carregar snapshot: HTTP ${res.status}`)
    }
    snapshot = await res.json()
    render()
  } catch (err) {
    const center = $('center')
    if (center) {
      center.innerHTML = `<div class="empty"><b>Erro de conexão</b><span>${escapeHtml(err instanceof Error ? err.message : String(err))}</span></div>`
    }
  }
}

function connectWebSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${proto}//${location.host}/api/events?since=${lastSeq}&session=${encodeURIComponent(sessionToken)}`

  try {
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      const live = $('liveStatus')
      if (live) live.textContent = 'ao vivo'
    }

    ws.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data)
        if (payload.seq && payload.seq > lastSeq) {
          lastSeq = payload.seq
        }
        handleEvent(payload)
      } catch (err) {
        console.error('Erro ao processar evento WebSocket:', err)
      }
    }

    ws.onclose = () => {
      const live = $('liveStatus')
      if (live) live.textContent = 'desconectado'
      reconnectTimer = setTimeout(connectWebSocket, 3000)
    }

    ws.onerror = () => {
      if (ws) ws.close()
    }
  } catch {
    reconnectTimer = setTimeout(connectWebSocket, 3000)
  }
}

function handleEvent(event) {
  const logSummary = $('logSummary')
  if (logSummary) {
    logSummary.textContent = `${event.kind} (seq ${event.seq ?? '?'}) ${event.unit ? `[${event.unit}]` : ''}`
  }

  loadSnapshot()
}

function render() {
  if (!snapshot || !snapshot.selectedMission) return

  if (!selectedMissionId) selectedMissionId = snapshot.selectedMission.id
  const mission = snapshot.missions.find((item) => item.id === selectedMissionId) || snapshot.selectedMission
  const stories = mission.stories || []

  if (!selectedStoryId && stories.length > 0) {
    selectedStoryId = stories[0].id
  }

  // Header
  const statusMission = $('statusMission')
  if (statusMission) statusMission.textContent = mission.id || 'sem missão'

  const statusAutonomy = $('statusAutonomy')
  if (statusAutonomy) statusAutonomy.textContent = mission.autonomy ?? unavailable

  const statusCost = $('statusCost')
  if (statusCost) {
    statusCost.textContent = `${formatMoney(mission.consumed_usd)} / ${formatMoney(mission.max_usd)}`
  }

  // Mission panel
  const missionTitle = $('missionTitle')
  if (missionTitle) missionTitle.textContent = mission.intent || mission.title || unavailable
  const missionSummary = $('missionSummary')
  if (missionSummary) missionSummary.textContent = mission.intent || unavailable

  const projects = $('projectList')
  if (projects) {
    projects.innerHTML = (snapshot.projects || []).length
      ? snapshot.projects.map((project) => `<li><b>${escapeHtml(project.name)}</b><span>${escapeHtml(project.path)}</span></li>`).join('')
      : `<li>${unavailable}</li>`
  }

  const history = $('missionHistory')
  if (history) {
    history.innerHTML = (snapshot.missions || []).map((item) => `
      <button type="button" data-mission-id="${escapeHtml(item.id)}" aria-current="${item.id === mission.id ? 'true' : 'false'}">
        ${escapeHtml(item.id)} · ${escapeHtml(item.intent || item.title || unavailable)}
      </button>`).join('')
    history.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
      selectedMissionId = button.getAttribute('data-mission-id') || ''
      selectedStoryId = ''
      render()
    }))
  }

  const epicProgress = $('epicProgress')
  if (epicProgress) {
    epicProgress.innerHTML = (mission.epics || []).length
      ? mission.epics.map((epic) => {
          const epicStories = (epic.stories || []).map((id) => stories.find((story) => story.id === id)).filter(Boolean)
          const done = epicStories.filter((story) => statusClass(story.status) === 'complete').length
          return `<li><b>${escapeHtml(epic.title || epic.id)}</b><span>${done}/${epicStories.length} stories</span></li>`
        }).join('')
      : `<li>${unavailable}</li>`
  }

  const storyCount = $('storyCount')
  if (storyCount) storyCount.textContent = String(stories.length)

  const prog = $('prog')
  if (prog) {
    prog.innerHTML = stories
      .map((s) => {
        const cls = statusClass(s.status)
        return `<i class="${cls}"></i>`
      })
      .join('')
  }

  // Stories list
  const storyList = $('storyList')
  if (storyList) {
    storyList.innerHTML = stories
      .map((s) => {
        const st = s.status
        const cls = statusClass(st)
        const isSel = s.id === selectedStoryId
        return `
          <button class="story s-${cls}" role="option" aria-selected="${isSel}" data-id="${escapeHtml(s.id)}">
            <span class="stripe"></span>
            <span>
              <span class="row">
                <span class="id">${escapeHtml(s.id)} · ${escapeHtml(s.complexity ?? unavailable)}</span>
                <span class="pill p-${cls}">${escapeHtml(pillText[st] || st || unavailable)}</span>
              </span>
              <span class="title">${escapeHtml(s.title || s.task || s.id)}</span>
            </span>
          </button>
        `
      })
      .join('')

    storyList.querySelectorAll('.story').forEach((b) => {
      b.addEventListener('click', () => {
        selectedStoryId = b.getAttribute('data-id') || ''
        render()
      })
    })
  }

  const currentStory = stories.find((s) => s.id === selectedStoryId) || stories[0]

  renderTabs(currentStory)
  renderCenter(currentStory, mission)
  renderReport(currentStory, mission)
}

function renderTabs(story) {
  const tabsContainer = $('tabs')
  if (!tabsContainer || !story) return

  const hasDiff = story.diff && story.diff.length > 0
  const hasTests = story.tests && story.tests.length > 0
  const hasVisual = Boolean(story.visual)
  const hasReview = Boolean(story.review)

  const tabDefs = [
    { key: 'diff', label: 'Alterações', count: hasDiff ? story.diff.length : '' },
    { key: 'tests', label: 'Testes', count: hasTests ? story.tests.length : '' },
    { key: 'visual', label: 'Visual', count: hasVisual ? '1' : '' },
    { key: 'review', label: 'Revisão', count: hasReview ? '1' : '' },
    { key: 'log', label: 'Log', count: '' },
  ]

  tabsContainer.innerHTML = tabDefs
    .map(
      (t) => `
      <button class="tab" role="tab" aria-selected="${selectedTab === t.key}" data-key="${t.key}">
        ${t.label}
        ${t.count ? `<span class="n">${t.count}</span>` : ''}
      </button>
    `,
    )
    .join('')

  tabsContainer.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => {
      selectedTab = b.getAttribute('data-key') || 'diff'
      render()
    })
  })
}

function renderCenter(story, mission) {
  const center = $('center')
  if (!center) return

  if (!story) {
    center.innerHTML = '<div class="empty"><b>Nenhuma story selecionada</b></div>'
    return
  }

  let h = `
    <div class="head">
      <h3>${escapeHtml(story.title || story.task || story.id)}</h3>
      <div class="meta">${story.calls} chamadas · ${formatMoney(story.cost)} · maker ${escapeHtml(story.maker?.family || unavailable)}${story.maker?.model_id ? ` (${escapeHtml(story.maker.model_id)})` : ''}</div>
    </div>
  `

  if (selectedTab === 'diff') {
    if (story.diff && story.diff.length > 0) {
      h += '<div class="diff">'
      for (const f of story.diff) {
        h += `<div class="file">${escapeHtml(f.file)}</div><pre>`
        for (const line of f.lines || []) {
          const type = line[0] === 'a' ? 'a' : line[0] === 'd' ? 'd' : 'c'
          const prefix = line[0] === 'a' ? '+ ' : line[0] === 'd' ? '- ' : '  '
          h += `<span class="${type}">${prefix}${escapeHtml(line[1] || '')}</span>`
        }
        h += '</pre>'
      }
      h += '</div>'
    } else {
      h += '<div class="empty"><b>Alterações indisponíveis</b><span>A projeção não forneceu diferenças para esta story.</span></div>'
    }
  } else if (selectedTab === 'tests') {
    if (story.tests && story.tests.length > 0) {
      h += `
        <table>
          <thead><tr><th>Prova</th><th>Antes</th><th>Depois</th></tr></thead>
          <tbody>
      `
      for (const t of story.tests) {
        const beforeCls = /vermelho|red|fail/i.test(t[1]) ? 'bad' : ''
        const afterCls = /verde|green|pass|ok/i.test(t[2]) ? 'ok' : /running|rodando/i.test(t[2]) ? 'warn' : ''
        h += `<tr><td>${escapeHtml(t[0])}</td><td class="${beforeCls}">${escapeHtml(t[1])}</td><td class="${afterCls}">${escapeHtml(t[2])}</td></tr>`
      }
      h += `
          </tbody>
        </table>
        <p class="hint">"Vermelho antes" prova a sensibilidade da prova. "Verde depois" confirma o comportamento correto.</p>
      `
    } else {
      h += '<div class="empty"><b>Provas indisponíveis</b><span>A projeção não forneceu provas para esta story.</span></div>'
    }
  } else if (selectedTab === 'visual') {
    if (story.visual) {
      const v = story.visual
      const score = Number(v.final).toFixed(1)
      const isPass = v.verdict === 'pass'

      h += `
        <div class="score">
          <b class="${isPass ? 'ok' : 'warn'}">${score}</b>
          <span class="of">veredito ${escapeHtml(v.verdict)} · juiz ${escapeHtml(v.judge.family)} (${escapeHtml(v.judge.model_id)})</span>
        </div>
        <div class="bar" style="--w:${Number(score) * 10}%">
          <i></i>
        </div>
      `

      if (v.criteria && v.criteria.length > 0) {
        h += '<ul style="margin:0 0 14px;padding-left:18px;color:var(--text2)">'
        for (const c of v.criteria) {
          h += `<li><b>${escapeHtml(c.id)}:</b> ${c.score != null ? c.score : 'N/A'} — ${escapeHtml(c.note || '')}</li>`
        }
        h += '</ul>'
      }

      if (v.captures && v.captures.length > 0) {
        h += '<div class="shots">'
        for (const cap of v.captures) {
          const artifactRef = String(cap.path).replace(/^artifacts[\\/]/, '')
          const imgUrl = `/api/artifacts/${artifactRef.split('/').map(encodeURIComponent).join('/')}?session=${encodeURIComponent(sessionToken)}`
          h += `
            <div class="shot">
              <img src="${imgUrl}" alt="Captura da rota ${escapeHtml(cap.route)}" loading="lazy">
              <div class="cap">${escapeHtml(cap.route)} (${cap.width}px, ${escapeHtml(cap.theme)})</div>
            </div>
          `
        }
        h += '</div>'
      }
    } else {
      h += '<div class="empty"><b>Avaliação visual indisponível</b><span>A projeção não forneceu resultado visual para esta story.</span></div>'
    }
  } else if (selectedTab === 'review') {
    if (story.review) {
      const r = story.review
      h += `
        <p style="margin:0 0 8px"><b>${escapeHtml(r.who || unavailable)}</b> · <span class="${r.verdict === 'approved' ? 'ok' : 'warn'}">${escapeHtml(r.verdict || unavailable)}</span></p>
        <ul style="margin:0;padding-left:18px;color:var(--text2)">
      `
      for (const n of r.notes || []) {
        h += `<li>${escapeHtml(n)}</li>`
      }
      h += `</ul><p class="hint">Quem revisa é sempre uma IA de família diferente da que escreveu o código.</p>`
    } else {
      h += '<div class="empty"><b>Revisão indisponível</b><span>A projeção não forneceu revisão para esta story.</span></div>'
    }
  } else if (selectedTab === 'log') {
    const events = mission.events || []
    if (events.length > 0) {
      h += `<label class="log-filter">Filtrar log <input id="logFilter" value="${escapeHtml(logFilter)}" placeholder="tipo, story ou sequência"></label><pre>`
      for (const e of events.filter((event) => JSON.stringify(event).toLowerCase().includes(logFilter.toLowerCase()))) {
        h += `seq ${e.seq ?? '?'}: ${escapeHtml(e.kind)} ${e.unit ? `[${escapeHtml(e.unit)}]` : ''}\n`
      }
      h += '</pre>'
    } else {
      h += '<div class="empty"><b>Journal vazio</b></div>'
    }
  }

  center.innerHTML = h
  const filterInput = $('logFilter')
  if (filterInput) filterInput.addEventListener('input', () => {
    logFilter = filterInput.value
    renderCenter(story, mission)
    const next = $('logFilter')
    if (next) {
      next.focus()
      next.setSelectionRange(logFilter.length, logFilter.length)
    }
  })
}

function renderReport(story, mission) {
  const report = $('report')
  if (!report || !story) return

  const st = story.status
  const isAwait = st === 'awaiting_operator'

  let h = `
    <div class="card ${isAwait ? 'await-box' : ''}">
      <h4>${escapeHtml(pillText[st] || st || unavailable)}</h4>
      <p>${escapeHtml(story.reason || unavailable)}</p>
    </div>
  `

  if (isAwait) {
    h += `
      <div class="decide">
        <button class="btn primary" id="btnApprove" data-action="approve">
          Aprovar / Aceitar como está
          <small>Confirma a aprovação da missão e registra a decisão durável no journal.</small>
        </button>
      </div>
    `
  }

  h += `
    <div class="card">
      <h4>Missão</h4>
      <dl class="kv">
        <dt>ID</dt><dd>${escapeHtml(mission.id || '—')}</dd>
        <dt>Autonomia</dt><dd>${escapeHtml(mission.autonomy ?? unavailable)}</dd>
        <dt>Gasto</dt><dd>${formatMoney(mission.consumed_usd)} de ${formatMoney(mission.max_usd)}</dd>
        <dt>Decisões</dt><dd>${(mission.decisions || []).length}</dd>
      </dl>
      ${(mission.decisions || []).length ? `<ul>${mission.decisions.map((decision) => `<li><b>seq ${decision.seq}</b> ${escapeHtml(decision.decision || unavailable)} · ${escapeHtml(decision.source || unavailable)}</li>`).join('')}</ul>` : `<p>${unavailable}</p>`}
    </div>
  `

  report.innerHTML = h

  const btnApprove = $('btnApprove')
  if (btnApprove) {
    btnApprove.addEventListener('click', async () => {
      try {
        const res = await fetch(`/api/actions/approve?session=${encodeURIComponent(sessionToken)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mission_id: mission.id,
            digest: mission.digest || mission.immutable_digest,
          }),
        })
        const data = await res.json()
        if (data.approved) {
          toast('Missão aprovada com sucesso!')
          loadSnapshot()
        } else {
          toast(`Aprovação recusada: ${data.reason || 'erro'}`)
        }
      } catch (err) {
        toast(`Erro: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }
}

// Inicialização
$('runForm')?.addEventListener('submit', (event) => {
  event.preventDefault()
  toast('O painel não executa comandos; use ade run no terminal.')
})
$('navMission')?.addEventListener('click', () => $('storyList')?.focus())
$('navHistory')?.addEventListener('click', () => {
  const panel = $('historyPanel')
  if (panel) panel.open = true
  panel?.querySelector('summary')?.focus()
})
$('navSkills')?.addEventListener('click', () => toast('Skills não estão disponíveis nesta projeção.'))
$('navCosts')?.addEventListener('click', () => $('report')?.scrollIntoView({ block: 'start' }))
$('navHealth')?.addEventListener('click', () => toast('Use ade doctor para verificar o ambiente.'))
loadSnapshot()
connectWebSocket()
