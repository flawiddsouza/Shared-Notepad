import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import express from 'express'
import { WebSocketServer } from 'ws'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const Y = require('yjs')
const { setupWSConnection, setPersistence, docs } = require('y-websocket/bin/utils')

const __dirname = dirname(fileURLToPath(import.meta.url))

const DOC_NAME = 'clipboard'
const DB_FILE = join(__dirname, 'clipboard.bin')

setPersistence({
    bindState: (docName, ydoc) => {
        try {
            Y.applyUpdate(ydoc, readFileSync(DB_FILE))
        } catch (e) { if (e.code !== 'ENOENT') throw e }
        ydoc.on('update', () => writeFileSync(DB_FILE, Buffer.from(Y.encodeStateAsUpdate(ydoc))))
    },
    writeState: () => Promise.resolve()
})

const wss = new WebSocketServer({ port: 9873 })
wss.on('connection', (ws, req) => setupWSConnection(ws, req, { docName: DOC_NAME }))

const app = express()
app.use(express.static(join(__dirname, 'dist')))
app.use(express.urlencoded({ extended: false, limit: '50mb' }))

app.post('/add-to-clipboard', (req, res) => {
    const yText = docs.get(DOC_NAME)?.getText('codemirror')
    if (!yText || !req.body.data) { res.status(400).send('Bad request'); return }
    yText.insert(yText.length, (yText.length > 0 ? '\n\n' : '') + req.body.data)
    res.send('Added to Shared Clipboard!')
})

app.listen(9872)
