let buffer = Buffer.alloc(0)

process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const boundary = buffer.indexOf("\r\n\r\n")
    if (boundary < 0) return
    const header = buffer.subarray(0, boundary).toString("ascii")
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (!match) process.exit(1)
    const length = Number(match[1])
    const end = boundary + 4 + length
    if (buffer.length < end) return
    const message = JSON.parse(buffer.subarray(boundary + 4, end).toString("utf8"))
    buffer = buffer.subarray(end)
    if (message.id == null) continue
    const result = message.method === "textDocument/hover" ? { contents: "fake hover" } : {}
    send({ jsonrpc: "2.0", id: message.id, result })
  }
})

function send(message) {
  const payload = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)
}
