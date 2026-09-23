import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readJournal } from '../journal/journal.ts'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** Entrada do operador por frame; acima disso o canal do terminal fecha. */
const MAX_TERMINAL_INPUT = 64 * 1024
/** Saída pendente no socket além da qual o terminal descarta até o navegador drenar. */
const MAX_TERMINAL_PENDING = 1024 * 1024

/**
 * Codifica um frame WebSocket RFC 6455 não mascarado (servidor para cliente).
 *
 * @param opcode 0x1 texto, 0x2 binário, 0xa pong
 */
function encodeWsFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length
  let header

  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len <= 65535) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }

  return Buffer.concat([header, payload])
}

export function encodeWsTextFrame(text: string): Buffer {
  return encodeWsFrame(Buffer.from(text, 'utf8'), 0x1)
}

/**
 * Extrai do buffer os frames completos enviados pelo cliente (sempre mascarados).
 */
function decodeClientFrames(buf: Buffer): { frames: Array<{ fin: boolean; opcode: number; payload: Buffer }>; rest: Buffer; error: string | null } {
  const frames = []
  while (buf.length >= 2) {
    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    if ((buf[1] & 0x80) === 0) return { frames, rest: buf, error: 'unmasked' }
    let len = buf[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (buf.length < 4) break
      len = buf.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (buf.length < 10) break
      const big = buf.readBigUInt64BE(2)
      if (big > BigInt(MAX_TERMINAL_INPUT)) return { frames, rest: buf, error: 'too_large' }
      len = Number(big)
      off = 10
    }
    if (len > MAX_TERMINAL_INPUT) return { frames, rest: buf, error: 'too_large' }
    if (buf.length < off + 4 + len) break
    const mask = buf.subarray(off, off + 4)
    const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len))
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    frames.push({ fin, opcode, payload })
    buf = buf.subarray(off + 4 + len)
  }
  return { frames, rest: buf, error: null }
}

function acceptUpgrade(req: import('node:http').IncomingMessage, socket: import('node:net').Socket): boolean {
  const secKey = req.headers['sec-websocket-key']
  if (!secKey || typeof secKey !== 'string') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return false
  }
  const acceptKey = createHash('sha1').update(secKey + WS_GUID).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    '',
  ].join('\r\n'))
  return true
}

type TerminalEntry = {
    session: { onOutput: (cb: (chunk: Buffer) => void) => () => unknown; write: (data: string) => void} 
    socket: import('node:net').Socket | null
}

/**
 * Cria o manipulador do canal unidirecional de eventos WebSocket (/api/events).
 */
export function createWebSocketHandler({ sessionManager, repoDir, onJournalChanged = async () => {}, onError = () => {}, findTerminal = () => null }: {
        sessionManager: { validateToken: (t: string | null) => boolean; validateOrigin: (o: string | null | undefined) => boolean }
        repoDir: string
        onJournalChanged?: () => Promise<unknown>
        onError?: (error: unknown) => void
        findTerminal?: (q: { token: string | null; mission: string | null; story: string | null }) => TerminalEntry | null
    }) {
  
  const clients: Set<import('node:net').Socket> = new Set()

  function latestJournalPath() {
    const missionsDir = path.join(repoDir, '.ade', 'missions')
    if (!fs.existsSync(missionsDir)) return null
    for (const entry of fs.readdirSync(missionsDir).sort().reverse()) {
      const journalPath = path.join(missionsDir, entry, 'journal.jsonl')
      if (fs.existsSync(journalPath)) return journalPath
    }
    return null
  }

  /**
   * Obtém os eventos do journal da missão ativa posteriores a `since`.
   */
  function getPastEvents(since: number): any[] {
    const journalPath = latestJournalPath()
    if (!journalPath) return []
    const { events } = readJournal(journalPath)
    return events.filter((e) => (e.seq ?? 0) > since)
  }

  /**
   * Canal bidirecional do terminal durante o takeover: autorização própria (token do takeover,
   * missão e story), saída só em frames binários e entrada limitada por frame. Cair o canal não
   * devolve o controle; só a ação explícita de devolver faz isso.
   */
  function handleTerminal(req: import('node:http').IncomingMessage, socket: import('node:net').Socket, url: URL) {
    const entry = findTerminal({
      token: url.searchParams.get('session'),
      mission: url.searchParams.get('mission'),
      story: url.searchParams.get('story'),
    })
    if (!entry) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    if (!sessionManager.validateOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    if (!acceptUpgrade(req, socket)) return

    // Um navegador por vez: a conexão nova substitui a anterior.
    entry.socket?.destroy()
    entry.socket = socket
    const off = entry.session.onOutput((chunk) => {
      if (socket.destroyed) return
      // Navegador que não drena perde o canal (reabre pelo mesmo token), nunca a memória do servidor.
      if (socket.writableLength > MAX_TERMINAL_PENDING) {
        socket.destroy()
        return
      }
      socket.write(encodeWsFrame(chunk, 0x2))
    })
    
    let pending: Buffer = Buffer.alloc(0)
    /** @type Fragmentos de uma mensagem ainda sem FIN (RFC 6455 §5.4). */
    let fragments: Buffer[] = []
    socket.on('data', (buf) => {
      const { frames, rest, error } = decodeClientFrames(Buffer.concat([pending, buf]))
      if (error) {
        onError(new Error(`terminal: frame recusado (${error})`))
        socket.destroy()
        return
      }
      pending = rest
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          socket.end()
          return
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeWsFrame(frame.payload, 0xa))
          continue
        }
        if (frame.opcode !== 0x0 && frame.opcode !== 0x1 && frame.opcode !== 0x2) continue
        if (frame.opcode !== 0x0) fragments = []
        fragments.push(frame.payload)
        const message = Buffer.concat(fragments)
        if (message.length > MAX_TERMINAL_INPUT) {
          onError(new Error('terminal: mensagem fragmentada acima do limite'))
          socket.destroy()
          return
        }
        if (!frame.fin) continue
        fragments = []
        entry.session.write(message.toString('utf8'))
      }
    })
    socket.on('close', () => {
      off()
      if (entry.socket === socket) entry.socket = null
    })
    socket.on('error', () => socket.destroy())
  }

  /**
   * Trata o upgrade HTTP para WebSocket no servidor nativo.
   */
  function handleUpgrade(req: import('node:http').IncomingMessage, socket: import('node:net').Socket, _head: Buffer) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)

    if (url.pathname === '/api/terminal') {
      handleTerminal(req, socket, url)
      return
    }

    if (url.pathname !== '/api/events') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const token = url.searchParams.get('session')
    const origin = req.headers.origin

    if (!sessionManager.validateToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    if (!sessionManager.validateOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    const sinceParam = parseInt(url.searchParams.get('since') || '0', 10)
    const since = Number.isNaN(sinceParam) ? 0 : sinceParam
    let pastEvents
    try {
      pastEvents = getPastEvents(since)
    } catch (err) {
      onError(err)
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n')
      socket.destroy()
      return
    }

    if (!acceptUpgrade(req, socket)) return
    clients.add(socket)

    // Parser simples de frames WebSocket do cliente (close/ping)
    socket.on('data', (buf) => {
      if (buf.length < 2) return
      const opcode = buf[0] & 0x0f
      if (opcode === 0x08) {
        // Close frame
        socket.end()
      } else if (opcode === 0x09) {
        // Ping -> Pong
        const pong = Buffer.from([0x8a, 0x00])
        socket.write(pong)
      }
    })

    socket.on('close', () => {
      clients.delete(socket)
    })

    socket.on('error', () => {
      clients.delete(socket)
      socket.destroy()
    })

    for (const ev of pastEvents) {
      if (!socket.destroyed) {
        socket.write(encodeWsTextFrame(JSON.stringify(ev)))
      }
    }
  }

  let observedPath = latestJournalPath()
  let observedSeq = 0
  if (observedPath) {
    try {
      const { events } = readJournal(observedPath)
      observedSeq = events.at(-1)?.seq ?? 0
    } catch (err) {
      onError(err)
    }
  }
  let refreshing = false
  let failedState = ''
  const pollTimer = setInterval(async () => {
    if (refreshing) return
    refreshing = true
    let sourceState = ''
    try {
      const journalPath = latestJournalPath()
      if (!journalPath) return
      const stat = fs.statSync(journalPath)
      sourceState = `${journalPath}:${stat.size}:${stat.mtimeMs}`
      if (sourceState === failedState) return
      const since = journalPath === observedPath ? observedSeq : 0
      const { events } = readJournal(journalPath)
      const fresh = events.filter((event) => event.seq > since)
      if (fresh.length === 0) return
      await onJournalChanged()
      for (const event of fresh) broadcast(event)
      observedPath = journalPath
      observedSeq = fresh[fresh.length - 1].seq
      failedState = ''
    } catch (err) {
      failedState = sourceState
      onError(err)
    } finally {
      refreshing = false
    }
  }, 200)
  pollTimer.unref()

  /**
   * Publica um novo evento em broadcast para todos os clientes conectados.
   */
  function broadcast(event: any) {
    const frame = encodeWsTextFrame(JSON.stringify(event))
    for (const client of clients) {
      if (!client.destroyed) {
        client.write(frame)
      }
    }
  }

  /**
   * Encerra todas as conexões abertas de clientes.
   */
  function closeAll() {
    clearInterval(pollTimer)
    for (const client of clients) {
      try {
        client.destroy()
      } catch {}
    }
    clients.clear()
  }

  return {
    handleUpgrade,
    broadcast,
    closeAll,
    get clientCount() {
      return clients.size
    },
  }
}
