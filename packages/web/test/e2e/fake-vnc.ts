// A stand-in for a worker's noVNC server, for accounts.spec.ts: it speaks just enough of the VNC handshake (RFB 3.8, VNC
// password security, a 64x48 screen) for noVNC to report a connection. It prints {"port": n} once it listens, and closes
// every connection when a line "close" arrives on stdin. The password is not checked.
const server = Bun.serve<{ step: number }>({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (request, s) => (s.upgrade(request, { data: { step: 0 } }) ? undefined : new Response('no', { status: 400 })),
  websocket: {
    open(ws) {
      ws.sendBinary(Buffer.from('RFB 003.008\n'))
    },
    message(ws) {
      ws.data.step++
      if (ws.data.step === 1) ws.sendBinary(Buffer.from([1, 2]))
      else if (ws.data.step === 2) ws.sendBinary(Buffer.alloc(16, 1))
      else if (ws.data.step === 3) ws.sendBinary(Buffer.alloc(4))
      else if (ws.data.step === 4) {
        const init = Buffer.alloc(28)
        init.writeUInt16BE(64, 0)
        init.writeUInt16BE(48, 2)
        init.set([32, 24, 0, 1], 4)
        init.writeUInt16BE(255, 8)
        init.writeUInt16BE(255, 10)
        init.writeUInt16BE(255, 12)
        init.set([16, 8, 0], 14)
        init.writeUInt32BE(4, 20)
        init.write('desk', 24)
        ws.sendBinary(init)
      }
    }
  }
})
console.log(JSON.stringify({ port: server.port }))
for await (const line of console) if (line.trim() === 'close') server.stop(true)
