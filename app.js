import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import 'dotenv/config'
import { randomUUID } from 'crypto'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { extFromMime } from './lib/images.js'
import { createImageCleanup } from './lib/image-cleanup.js'
import express from 'express'
import { WebSocketServer } from 'ws'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const Y = require('yjs')
const { setupWSConnection, setPersistence, docs } = require('y-websocket/bin/utils')

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, 'data')
mkdirSync(DATA_DIR, { recursive: true })

const BUCKET = process.env.B2_BUCKET
const FOLDER = process.env.B2_BUCKET_FOLDER // path prefix within the bucket; required to scope a shared bucket
const objectKey = key => FOLDER ? `${FOLDER}/${key}` : key
const s3 = new S3Client({
    endpoint: process.env.B2_ENDPOINT,
    region: process.env.B2_REGION,
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
    // Recent AWS SDK versions send x-amz-checksum-* headers by default, which
    // B2 rejects ("Unsupported header 'x-amz-checksum-crc32'"). Disable them.
    // (Matches Backblaze's official v3 example, which omits forcePathStyle and
    // uses virtual-hosted style. If uploads fail with an addressing error,
    // add forcePathStyle: true as a fallback.)
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
})

const imageCleanup = createImageCleanup({ s3, bucket: BUCKET, folder: FOLDER, dataDir: DATA_DIR, docs })

setPersistence({
    bindState: (docName, ydoc) => {
        const dbFile = join(DATA_DIR, docName.replace(/[^a-zA-Z0-9-_]/g, '_') + '.bin')
        try {
            Y.applyUpdate(ydoc, readFileSync(dbFile))
        } catch (e) { if (e.code !== 'ENOENT') throw e }
        imageCleanup.noteReferences(ydoc.getText('codemirror').toString())
        ydoc.on('update', () => {
            writeFileSync(dbFile, Buffer.from(Y.encodeStateAsUpdate(ydoc)))
            imageCleanup.noteReferences(ydoc.getText('codemirror').toString())
        })
    },
    writeState: () => Promise.resolve()
})

const wss = new WebSocketServer({ port: 9873 })
wss.on('connection', (ws, req) => setupWSConnection(ws, req))

const app = express()
app.use(express.static(join(__dirname, 'dist')))
app.use(express.urlencoded({ extended: false, limit: '50mb' }))

app.post('/add-to-clipboard', (req, res) => {
    const yText = docs.get('clipboard')?.getText('codemirror')
    if (!yText || !req.body.data) { res.status(400).send('Bad request'); return }
    yText.insert(yText.length, (yText.length > 0 ? '\n\n' : '') + req.body.data)
    res.send('Added to Shared Clipboard!')
})

app.post('/upload', express.raw({ type: 'image/*', limit: '10mb' }), async (req, res) => {
    const ext = extFromMime(req.headers['content-type'])
    if (!ext) { res.status(415).send('Unsupported image type'); return }
    if (!req.body || !req.body.length) { res.status(400).send('Empty body'); return }
    const key = randomUUID() + '.' + ext
    try {
        await s3.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: objectKey(key),
            Body: req.body,
            ContentType: req.headers['content-type'],
        }))
        res.json({ url: '/img/' + key })
    } catch (e) {
        console.error('Upload failed:', e)
        res.status(502).send('Upload to storage failed')
    }
})

app.get('/img/:key', async (req, res) => {
    const key = req.params.key
    if (!/^[0-9a-f-]+\.(png|jpg|gif|webp)$/i.test(key)) {
        res.status(404).send('Not found')
        return
    }
    try {
        // ?proxy streams the bytes through this origin so the browser can fetch
        // them without CORS (Backblaze sends no Access-Control-Allow-Origin).
        // Used by the chip's "copy image to clipboard" action.
        if (req.query.proxy !== undefined) {
            const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: objectKey(key) }))
            res.set('Cache-Control', 'no-store')
            if (out.ContentType) res.set('Content-Type', out.ContentType)
            out.Body.on('error', err => { console.error('Image proxy stream failed:', err); res.destroy(err) })
            out.Body.pipe(res)
            return
        }
        const url = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET, Key: objectKey(key) }),
            { expiresIn: 900 } // 15 minutes
        )
        res.set('Cache-Control', 'no-store')
        res.redirect(302, url)
    } catch (e) {
        console.error('Presign failed:', e)
        res.status(500).send('Failed to generate URL')
    }
})

imageCleanup.start()

app.listen(9872)
