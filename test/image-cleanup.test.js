import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { ListObjectVersionsCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { createImageCleanup, ORPHAN_GRACE_MS, ORPHAN_SWEEP_MS } from '../lib/image-cleanup.js'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const key = 'notes/12345678-1234-1234-1234-123456789abc.png'
const key2 = 'notes/12345678-1234-1234-1234-123456789def.jpg'
const link = `![](/img/${key.slice('notes/'.length)})`

function fixture(t) {
    const dataDir = mkdtempSync(join(tmpdir(), 'notepad-cleanup-'))
    const docs = new Map()
    t.after(() => {
        for (const doc of docs.values()) doc.destroy()
        rmSync(dataDir, { recursive: true, force: true })
    })
    const f = {
        time: 1000000000, calls: [], errors: [], warnings: [], docs, dataDir,
        versions: [{ Key: key, VersionId: 'v1', LastModified: new Date(0) }],
        deletes: [],
    }
    f.s3 = { async send(command) {
        f.calls.push(command)
        if (command instanceof ListObjectVersionsCommand) {
            if (f.list) return f.list(command.input)
            return { Versions: [...f.versions] }
        }
        assert.ok(command instanceof DeleteObjectCommand)
        if (f.beforeDelete) await f.beforeDelete(command.input)
        f.deletes.push(command.input)
        f.versions = f.versions.filter(v => v.Key !== command.input.Key || v.VersionId !== command.input.VersionId)
        return {}
    } }
    f.options = {
        s3: f.s3, bucket: 'bucket', folder: 'notes', dataDir, docs, now: () => f.time,
        logger: { error: (...args) => f.errors.push(args), warn: (...args) => f.warnings.push(args), log() {} },
    }
    f.create = () => createImageCleanup(f.options)
    f.cleanup = f.create()
    f.state = () => JSON.parse(readFileSync(join(dataDir, 'image-orphans.json'), 'utf8')).orphanedAt
    f.saveDoc = (name, text) => {
        const doc = new Y.Doc()
        doc.getText('codemirror').insert(0, text)
        writeFileSync(join(dataDir, `${name}.bin`), Y.encodeStateAsUpdate(doc))
        doc.destroy()
    }
    return f
}

test('starts seven days at first unused observation, not upload time, and survives restart', async t => {
    const f = fixture(t)
    await f.cleanup.sweep()
    const firstSeen = f.time
    assert.equal(f.state()[key], firstSeen)
    assert.equal(f.deletes.length, 0)
    f.time += ORPHAN_GRACE_MS - 1
    f.cleanup = f.create()
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 0)
    f.time++
    await f.cleanup.sweep()
    assert.deepEqual(f.deletes, [{ Bucket: 'bucket', Key: key, VersionId: 'v1' }])
    assert.deepEqual(f.state(), {})
})

test('ordinary edits and repeated restarts do not extend unused image deadlines', async t => {
    const f = fixture(t)
    await f.cleanup.sweep()
    const firstSeen = f.time
    for (let day = 1; day <= 7; day++) {
        f.time += ORPHAN_GRACE_MS / 7
        const text = `Unrelated note edit on day ${day}`
        f.saveDoc('note', text)
        f.cleanup.noteReferences(text)
        f.cleanup = f.create()
        await f.cleanup.sweep()
        if (day < 7) {
            assert.equal(f.state()[key], firstSeen)
            assert.equal(f.deletes.length, 0)
        }
    }
    assert.deepEqual(f.deletes, [{ Bucket: 'bucket', Key: key, VersionId: 'v1' }])
    assert.deepEqual(f.state(), {})
    assert.equal(f.errors.length, 0)
})

test('ordinary edits need no cleanup checkpoint when there are no tracked images', t => {
    const f = fixture(t)
    mkdirSync(join(f.dataDir, 'image-orphans.json.tmp'))
    f.saveDoc('note', 'Unrelated edit')
    assert.doesNotThrow(() => f.cleanup.noteReferences('Unrelated edit'))
    assert.equal(f.errors.length, 0)
})

test('saved references in any note and live references protect images', async t => {
    const f = fixture(t)
    f.versions.push({ Key: key2, VersionId: 'v2' })
    f.saveDoc('other-tab', link)
    const live = new Y.Doc()
    live.getText('codemirror').insert(0, `/img/${key2.slice(6)}`)
    f.docs.set('live-tab', live)
    await f.cleanup.sweep()
    f.time += ORPHAN_GRACE_MS * 2
    await f.cleanup.sweep()
    assert.deepEqual(f.state(), {})
    assert.equal(f.deletes.length, 0)
    f.saveDoc('other-tab', '')
    await f.cleanup.sweep()
    assert.equal(f.state()[key], f.time)
    assert.equal(f.deletes.length, 0)
})

test('restoring and removing between sweeps resets grace, including across restart', async t => {
    const f = fixture(t)
    await f.cleanup.sweep()
    f.time += ORPHAN_GRACE_MS - 1
    f.cleanup.noteReferences(link)
    f.cleanup.noteReferences('')
    assert.deepEqual(f.state(), {})
    f.cleanup = f.create()
    f.time++
    await f.cleanup.sweep()
    assert.equal(f.state()[key], f.time)
    assert.equal(f.deletes.length, 0)
    f.time += ORPHAN_GRACE_MS
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 1)
})

test('tracking write failure does not interrupt notes or reuse stale deadlines after restart', async t => {
    const f = fixture(t)
    const doc = new Y.Doc()
    f.docs.set('note', doc)
    const text = doc.getText('codemirror')
    const save = () => writeFileSync(join(f.dataDir, 'note.bin'), Y.encodeStateAsUpdate(doc))
    save()
    await f.cleanup.sweep()
    f.time += ORPHAN_GRACE_MS - 1

    // Make only cleanup metadata unwritable; note persistence still works.
    const temporaryState = join(f.dataDir, 'image-orphans.json.tmp')
    mkdirSync(temporaryState)
    text.insert(0, link)
    save()
    assert.doesNotThrow(() => f.cleanup.noteReferences(text.toString()))
    assert.equal(f.errors.length, 1)
    text.delete(0, text.length)
    save()
    assert.doesNotThrow(() => f.cleanup.noteReferences(''))
    rmSync(temporaryState, { recursive: true })

    f.cleanup = f.create()
    f.time++
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 0)
    assert.equal(f.state()[key], f.time)
    f.time += ORPHAN_GRACE_MS
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 1)
})

test('failed tracking write during sweep prevents deletion until persistence recovers', async t => {
    const f = fixture(t)
    await f.cleanup.sweep()
    f.time += ORPHAN_GRACE_MS
    const temporaryState = join(f.dataDir, 'image-orphans.json.tmp')
    mkdirSync(temporaryState)
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 0)
    assert.equal(f.errors.length, 1)
    rmSync(temporaryState, { recursive: true })
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 1)
})

test('unreadable saved documents abort cleanup without deleting expired images', async t => {
    const f = fixture(t)
    await f.cleanup.sweep()
    f.time += ORPHAN_GRACE_MS
    writeFileSync(join(f.dataDir, 'broken.bin'), Buffer.from([255]))
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 0)
    assert.equal(f.errors.length, 1)
    assert.equal(f.state()[key], 1000000000)
})

test('missing bucket or folder never accesses storage', async t => {
    const f = fixture(t)
    for (const overrides of [{ bucket: undefined }, { folder: undefined }, { folder: '' }]) {
        await createImageCleanup({ ...f.options, ...overrides }).sweep()
    }
    assert.equal(f.calls.length, 0)
})

test('invalid tracking state safely starts a new grace period', async t => {
    const f = fixture(t)
    for (const state of ['broken json', JSON.stringify({ bucket: 'bucket', folder: 'notes', orphanedAt: { [key]: 'bad' } })]) {
        writeFileSync(join(f.dataDir, 'image-orphans.json'), state)
        f.cleanup = f.create()
        await f.cleanup.sweep()
        assert.equal(f.state()[key], f.time)
        assert.equal(f.deletes.length, 0)
        f.time += ORPHAN_GRACE_MS
    }
    assert.equal(f.warnings.length, 2)
})

test('tracking from a different storage scope does not reuse old deadlines', async t => {
    const f = fixture(t)
    writeFileSync(join(f.dataDir, 'image-orphans.json'), JSON.stringify({
        bucket: 'another-bucket', folder: 'notes', orphanedAt: { [key]: 0 },
    }))
    f.cleanup = f.create()
    await f.cleanup.sweep()
    assert.equal(f.state()[key], f.time)
    assert.equal(f.deletes.length, 0)
})

test('lists all pages and removes all versions and delete markers, but not unrelated files', async t => {
    const f = fixture(t)
    f.list = input => {
        assert.equal(input.Prefix, 'notes/')
        if (!input.KeyMarker) return {
            Versions: [{ Key: key, VersionId: 'v1' }, { Key: 'notes/backup.json', VersionId: 'keep' }],
            IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: 'v1',
        }
        assert.equal(input.KeyMarker, key)
        assert.equal(input.VersionIdMarker, 'v1')
        return {
            Versions: [{ Key: key, VersionId: 'v2' }, { Key: `elsewhere/${key.slice(6)}`, VersionId: 'keep' }],
            DeleteMarkers: [{ Key: key, VersionId: 'hidden' }],
        }
    }
    await f.cleanup.sweep()
    assert.deepEqual(Object.keys(f.state()), [key])
    f.time += ORPHAN_GRACE_MS
    await f.cleanup.sweep()
    assert.deepEqual(f.deletes.map(d => d.VersionId), ['v1', 'v2', 'hidden'])
    assert.ok(f.deletes.every(d => d.Key === key))
})

test('a later listing-page failure prevents any deletion and the next sweep retries', async t => {
    const f = fixture(t)
    await f.cleanup.sweep()
    f.time += ORPHAN_GRACE_MS
    f.list = input => {
        if (input.KeyMarker) throw new Error('storage unavailable')
        return { Versions: f.versions, IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: 'v1' }
    }
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 0)
    assert.equal(f.errors.length, 1)
    f.list = undefined
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 1)
})

test('failed deletion retains its deadline for retry', async t => {
    const f = fixture(t)
    await f.cleanup.sweep()
    f.time += ORPHAN_GRACE_MS
    f.beforeDelete = () => { throw new Error('delete denied') }
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 0)
    assert.equal(f.state()[key], 1000000000)
    f.beforeDelete = undefined
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 1)
})

test('references restored during listing protect expired images', async t => {
    const f = fixture(t)
    await f.cleanup.sweep()
    f.time += ORPHAN_GRACE_MS
    f.list = () => {
        f.saveDoc('restored', link)
        return { Versions: f.versions }
    }
    await f.cleanup.sweep()
    assert.equal(f.deletes.length, 0)
    assert.deepEqual(f.state(), {})
})

test('rechecks references between deletions rather than using an old snapshot', async t => {
    const f = fixture(t)
    f.versions.push({ Key: key2, VersionId: 'v2' })
    await f.cleanup.sweep()
    f.time += ORPHAN_GRACE_MS
    f.beforeDelete = () => f.saveDoc('restored', `/img/${key2.slice(6)}`)
    await f.cleanup.sweep()
    assert.deepEqual(f.deletes.map(d => d.Key), [key])
    assert.deepEqual(f.state(), {})
})

test('overlapping sweeps are skipped', async t => {
    const f = fixture(t)
    let release
    f.list = () => new Promise(resolve => { release = resolve })
    const first = f.cleanup.sweep()
    await f.cleanup.sweep()
    assert.equal(f.calls.length, 1)
    release({ Versions: f.versions })
    await first
    assert.equal(f.errors.length, 0)
})

test('starts cleanup immediately and schedules an hourly non-blocking timer', async t => {
    const f = fixture(t)
    let callback, delay, unrefCalled = false
    const timer = { unref() { unrefCalled = true } }
    t.mock.method(globalThis, 'setInterval', (fn, ms) => { callback = fn; delay = ms; return timer })
    assert.equal(f.cleanup.start(), timer)
    assert.equal(f.calls.length, 1)
    assert.equal(delay, ORPHAN_SWEEP_MS)
    assert.equal(delay, 60 * 60 * 1000)
    assert.equal(unrefCalled, true)
    await new Promise(resolve => setImmediate(resolve))
    callback()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.calls.length, 2)
})
