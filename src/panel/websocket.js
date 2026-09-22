// @ts-check
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readJournal } from '../journal/journal.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * Codifica uma string de texto em um frame WebSocket RFC 6455 não mascarado (servidor para cliente).
 *
 * @param {string} text
 * @returns {Buffer}
 */
export function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header

  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len <= 65535) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }

  return Buffer.concat([header, payload])
}

/**
 * Cria o manipulador do canal unidirecional de eventos WebSocket (/api/events).
 *
 * @param {{
 *   sessionManager: { validateToken: (t: string | null) => boolean, validateOrigin: (o: string | null | undefined) => boolean },
 *   repoDir: string,
 *   onJournalChanged?: () => Promise<unknown>,
 *   onError?: (error: unknown) => void,
 * }} options
 */
export function createWebSocketHandler({ sessionManager, repoDir, onJournalChanged = async () => {}, onError = () => {} }) {
  /** @type {Set<import('node:net').Socket>} */
  const clients = new Set()

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
   *
   * @param {number} since
   * @returns {any[]}
   */
  function getPastEvents(since) {
    const journalPath = latestJournalPath()
    if (!journalPath) return []
    const { events } = readJournal(journalPath)
    return events.filter((e) => (e.seq ?? 0) > since)
  }

  /**
   * Trata o upgrade HTTP para WebSocket no servidor nativo.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} _head
   */
  function handleUpgrade(req, socket, _head) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)

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

    const secKey = req.headers['sec-websocket-key']
    if (!secKey || typeof secKey !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    // Handshake RFC 6455
    const acceptKey = createHash('sha1')
      .update(secKey + WS_GUID)
      .digest('base64')

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

    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n')

    socket.write(responseHeaders)
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
   *
   * @param {any} event
   */
  function broadcast(event) {
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
