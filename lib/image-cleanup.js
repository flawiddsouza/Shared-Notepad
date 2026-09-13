import { readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { ListObjectVersionsCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { extractImageKeys } from './images.js'

const require = createRequire(import.meta.url)
const Y = require('yjs')

export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000
export const ORPHAN_SWEEP_MS = 60 * 60 * 1000
const IMAGE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/i

export function createImageCleanup({ s3, bucket, folder, dataDir, docs = new Map(), now = Date.now, logger = console }) {
    const stateFile = join(dataDir, 'image-orphans.json')
    const prefix = `${folder}/`
    let orphanedAt = new Map()
    let running = false

    try {
        const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (saved.bucket === bucket && saved.folder === folder) {
            if (!saved.orphanedAt || typeof saved.orphanedAt !== 'object' || Array.isArray(saved.orphanedAt)) {
                throw new Error('Invalid orphan timestamps')
            }
            const entries = Object.entries(saved.orphanedAt)
            if (entries.some(([, timestamp]) => !Number.isFinite(timestamp) || timestamp < 0)) {
                throw new Error('Invalid orphan timestamp')
            }
            // A note may have been restored and cleared while a tracking write failed.
            if (saved.docsHash === docsHash()) orphanedAt = new Map(entries)
        }
    } catch (e) {
        // Lost or invalid tracking data starts a fresh grace period, never immediate deletion.
        if (e.code !== 'ENOENT') logger.warn('Image cleanup tracking reset:', e)
    }

    function docsHash() {
        const hash = createHash('sha256')
        for (const file of readdirSync(dataDir).filter(file => file.endsWith('.bin')).sort()) {
            hash.update(JSON.stringify(file))
            hash.update(createHash('sha256').update(readFileSync(join(dataDir, file))).digest())
        }
        return hash.digest('hex')
    }

    function saveState() {
        writeFileSync(`${stateFile}.tmp`, JSON.stringify({
            bucket, folder, docsHash: docsHash(), orphanedAt: Object.fromEntries(orphanedAt),
        }))
        renameSync(`${stateFile}.tmp`, stateFile)
    }

    function noteReferences(text) {
        let changed = false
        for (const key of extractImageKeys(text)) {
            if (orphanedAt.delete(prefix + key)) changed = true
        }
        // Keep the document checkpoint current even for ordinary edits, so a restart
        // preserves existing deadlines. A restore still resets its image between sweeps.
        if (changed || orphanedAt.size > 0) {
            try {
                saveState()
            } catch (e) {
                // The next sweep retries; a changed document hash invalidates stale state on restart.
                logger.error('Image cleanup tracking save failed:', e)
            }
        }
    }

    function referencedKeys() {
        const referenced = new Set()
        const add = doc => {
            for (const key of extractImageKeys(doc.getText('codemirror').toString())) referenced.add(prefix + key)
        }
        for (const file of readdirSync(dataDir)) {
            if (!file.endsWith('.bin')) continue
            const doc = new Y.Doc()
            try {
                Y.applyUpdate(doc, readFileSync(join(dataDir, file)))
                add(doc)
            } finally {
                doc.destroy()
            }
        }
        for (const doc of docs.values()) add(doc)
        return referenced
    }

    async function sweep() {
        if (running || !bucket) return
        if (!folder) {
            logger.warn('B2_BUCKET_FOLDER not set - skipping image cleanup')
            return
        }
        running = true
        try {
            // Finish listing before deletion so pagination never depends on a deleted version.
            const images = new Map()
            let keyMarker, versionIdMarker
            do {
                const out = await s3.send(new ListObjectVersionsCommand({
                    Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker,
                }))
                for (const version of [...(out.Versions || []), ...(out.DeleteMarkers || [])]) {
                    if (!version.Key?.startsWith(prefix) || !IMAGE_KEY_RE.test(version.Key.slice(prefix.length))) continue
                    if (!version.VersionId) throw new Error('Image version ID missing')
                    if (!images.has(version.Key)) images.set(version.Key, [])
                    images.get(version.Key).push(version.VersionId)
                }
                if (!out.IsTruncated) break
                if (!out.NextKeyMarker || (out.NextKeyMarker === keyMarker && out.NextVersionIdMarker === versionIdMarker)) {
                    throw new Error('Image listing did not advance')
                }
                keyMarker = out.NextKeyMarker
                versionIdMarker = out.NextVersionIdMarker
            } while (true)

            // An unreadable document throws and aborts the sweep rather than risking its images.
            const referenced = referencedKeys()
            for (const key of orphanedAt.keys()) {
                if (!images.has(key) || referenced.has(key)) orphanedAt.delete(key)
            }
            for (const key of images.keys()) {
                if (!referenced.has(key) && !orphanedAt.has(key)) orphanedAt.set(key, now())
            }
            saveState()

            for (const [key, versions] of images) {
                if (!orphanedAt.has(key) || now() - orphanedAt.get(key) < ORPHAN_GRACE_MS) continue
                let restored = false
                for (const versionId of versions) {
                    // Recheck after network waits, including restores in other notes.
                    if (!orphanedAt.has(key) || referencedKeys().has(key)) {
                        restored = true
                        break
                    }
                    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }))
                }
                orphanedAt.delete(key)
                if (!restored) logger.log('Swept orphan image:', key)
            }
            saveState()
        } catch (e) {
            logger.error('Image cleanup failed:', e)
        } finally {
            running = false
        }
    }

    function start() {
        void sweep()
        const timer = setInterval(() => { void sweep() }, ORPHAN_SWEEP_MS)
        timer.unref()
        return timer
    }

    return { noteReferences, sweep, start }
}
