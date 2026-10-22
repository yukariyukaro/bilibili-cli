import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME_BYTES = 4 * 1024 * 1024

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, body])
}

function closePayload(code = 1000, reason = '') {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason))
  body.writeUInt16BE(code, 0)
  body.write(reason, 2)
  return body
}

/**
 * 最小本地控制面 WebSocket 服务，只实现 bridge 协议用到的
 * register/register_ack、reply、ping/pong、close 和文本帧。
 * 它不是 B 站后端，也不产生任何 B 站业务成功。
 */
export async function startWsServer({ token = 'test-token', path = '/bridge/ws', autoAck = true } = {}) {
  if (!token) throw new Error('startWsServer 需要 token')
  const events = []
  const waiters = new Set()
  const sockets = new Set()
  const connections = []
  let closed = false

  const notify = (event) => {
    events.push(event)
    for (const waiter of [...waiters]) {
      let matched = false
      try { matched = waiter.predicate(event) === true } catch { matched = false }
      if (!matched) continue
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.resolve(event)
    }
  }

  const server = createServer((_request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' })
    response.end('WebSocket upgrade required')
  })

  server.on('upgrade', (request, socket) => {
    let url
    try { url = new URL(request.url || '/', 'http://127.0.0.1') } catch { socket.destroy(); return }
    if (url.pathname !== path || url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    if (!key) { socket.destroy(); return }
    const accept = createHash('sha1').update(String(key) + GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n',
    )
    socket.setNoDelay(true)
    sockets.add(socket)

    let buffer = Buffer.alloc(0)
    let closedByPeer = false

    const connection = {
      socket,
      sendJson(message) {
        if (socket.destroyed) return
        socket.write(encodeFrame(1, Buffer.from(JSON.stringify(message), 'utf8')))
      },
      close(code = 1000, reason = '') {
        if (socket.destroyed) return
        try { socket.write(encodeFrame(8, closePayload(code, reason))) } catch {}
        socket.end()
      },
    }
    connections.push(connection)

    const handleMessage = (message) => {
      if (autoAck && message?.type === 'register') {
        connection.sendJson({ type: 'register_ack', ok: true })
      }
      notify({ connection, message, at: Date.now() })
    }

    const parse = () => {
      while (!socket.destroyed) {
        if (buffer.length < 2) return
        const first = buffer[0]
        const second = buffer[1]
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          const big = buffer.readBigUInt64BE(2)
          if (big > BigInt(MAX_FRAME_BYTES)) { socket.destroy(); return }
          length = Number(big)
          offset = 10
        }
        let mask = null
        if (masked) {
          if (buffer.length < offset + 4) return
          mask = buffer.subarray(offset, offset + 4)
          offset += 4
        }
        if (buffer.length < offset + length) return
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        buffer = buffer.subarray(offset + length)
        if (mask) {
          for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
        }
        if (!fin) { socket.destroy(); return }

        if (opcode === 1) {
          let message
          try { message = JSON.parse(payload.toString('utf8')) } catch { continue }
          handleMessage(message)
        } else if (opcode === 8) {
          closedByPeer = true
          try { socket.write(encodeFrame(8, payload.subarray(0, 2))) } catch {}
          socket.end()
          return
        } else if (opcode === 9) {
          try { socket.write(encodeFrame(10, payload)) } catch {}
        }
        // opcode 10 (pong) 与未知帧类型仅忽略。
      }
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      parse()
    })
    socket.on('close', () => {
      sockets.delete(socket)
      if (!closedByPeer) closedByPeer = true
    })
    socket.on('error', () => {})
  })

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('error', onError)
      rejectListen(error)
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolveListen()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    url: 'ws://127.0.0.1:' + port + path,
    port,
    path,
    events,
    connections,
    messages: () => events.filter((event) => event.message?.type === 'message').map((event) => event.message),
    registers: () => events.filter((event) => event.message?.type === 'register').map((event) => event.message),
    hasEvent: (predicate) => events.some(predicate),
    waitFor(predicate, { timeout = 15000, description = '本地控制面事件' } = {}) {
      const found = events.find(predicate)
      if (found) return Promise.resolve(found)
      return new Promise((resolveWait, rejectWait) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            rejectWait(new Error('等待' + description + '超时（' + timeout + 'ms）；已收到 ' + events.length + ' 个事件'))
          }, timeout),
        }
        waiters.add(waiter)
      })
    },
    closeConnections(code = 1000, reason = 'fixture disconnect') {
      for (const connection of [...connections]) connection.close(code, reason)
      connections.length = 0
    },
    async close() {
      closed = true
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('本地控制面已关闭'))
      }
      waiters.clear()
      for (const socket of sockets) {
        try { socket.destroy() } catch {}
      }
      sockets.clear()
      await new Promise((resolveClose) => {
        const timer = setTimeout(resolveClose, 2000)
        server.close(() => { clearTimeout(timer); resolveClose() })
      })
    },
  }
}
