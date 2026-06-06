import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extFromMime, findImageRefs, extractImageKeys } from '../lib/images.js'

test('extFromMime maps allowed types', () => {
    assert.equal(extFromMime('image/png'), 'png')
    assert.equal(extFromMime('image/jpeg'), 'jpg')
    assert.equal(extFromMime('image/gif'), 'gif')
    assert.equal(extFromMime('image/webp'), 'webp')
})

test('extFromMime rejects disallowed or empty types', () => {
    assert.equal(extFromMime('image/svg+xml'), null)
    assert.equal(extFromMime('text/plain'), null)
    assert.equal(extFromMime(undefined), null)
})

test('findImageRefs returns refs with positions and url', () => {
    const text = 'a ![](/img/x.png) b ![alt](/img/y.jpg)'
    const refs = findImageRefs(text)
    assert.equal(refs.length, 2)
    assert.deepEqual(refs[0], { from: 2, to: 17, url: '/img/x.png' })
    assert.equal(refs[1].url, '/img/y.jpg')
})

test('findImageRefs returns empty when no images', () => {
    assert.deepEqual(findImageRefs('just text'), [])
})

test('extractImageKeys pulls keys from /img/ references', () => {
    const text = '![](/img/abc.png) text ![](/img/def.webp)'
    assert.deepEqual(extractImageKeys(text), ['abc.png', 'def.webp'])
})

test('extractImageKeys returns empty when none', () => {
    assert.deepEqual(extractImageKeys('no images here'), [])
})
