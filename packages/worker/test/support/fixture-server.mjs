// A tiny static server for the HTML fixtures (Playwright's webServer starts it). Usage: node fixture-server.mjs <port>
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const port = Number(process.argv[2])
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

createServer(async (req, res) => {
  const file = resolve(join(root, decodeURIComponent(new URL(req.url, 'http://localhost').pathname)))
  if (!file.startsWith(root + sep)) return void res.writeHead(403).end()
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    res.writeHead(404).end('not found')
  }
}).listen(port)
