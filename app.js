import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import 'dotenv/config'
import { randomUUID } from 'crypto'
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { extFromMime, extractImageKeys } from './lib/images.js'
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

setPersistence({
    bindState: (docName, ydoc) => {
        const dbFile = join(DATA_DIR, docName.replace(/[^a-zA-Z0-9-_]/g, '_') + '.bin')
        try {
            Y.applyUpdate(ydoc, readFileSync(dbFile))
        } catch (e) { if (e.code !== 'ENOENT') throw e }
        ydoc.on('update', () => writeFileSync(dbFile, Buffer.from(Y.encodeStateAsUpdate(ydoc))))
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

const ORPHAN_GRACE_MS = 60 * 60 * 1000 // 1 hour

async function sweepOrphans() {
    if (!BUCKET) return
    if (!FOLDER) {
        console.warn('B2_BUCKET_FOLDER not set - skipping orphan sweep to avoid scanning the whole bucket')
        return
    }
    // Collect every referenced image key across all persisted docs.
    const referenced = new Set()
    for (const file of readdirSync(DATA_DIR)) {
        if (!file.endsWith('.bin')) continue
        const doc = new Y.Doc()
        try {
            Y.applyUpdate(doc, readFileSync(join(DATA_DIR, file)))
            for (const key of extractImageKeys(doc.getText('codemirror').toString())) {
                referenced.add(objectKey(key))
            }
        } catch (e) {
            // Can't read a doc -> reference set is incomplete. Deleting on a
            // partial set could remove a still-referenced image, so abort the
            // sweep rather than risk data loss.
            console.error('Orphan sweep aborted - unreadable doc:', file, e)
            return
        } finally {
            doc.destroy()
        }
    }
    // Delete bucket objects that are unreferenced and older than the grace period.
    const cutoff = Date.now() - ORPHAN_GRACE_MS
    let token
    do {
        const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${FOLDER}/`, ContinuationToken: token }))
        for (const obj of out.Contents || []) {
            if (referenced.has(obj.Key)) continue
            if (obj.LastModified && obj.LastModified.getTime() > cutoff) continue
            await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }))
            console.log('Swept orphan image:', obj.Key)
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (token)
}

sweepOrphans().catch(e => console.error('Orphan sweep failed:', e))

app.listen(9872)
