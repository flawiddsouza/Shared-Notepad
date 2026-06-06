// Allowed image content-types mapped to file extensions. SVG is excluded on
// purpose to avoid stored-XSS from an SVG served same-origin.
const MIME_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}

export function extFromMime(mime) {
    return MIME_EXT[mime] || null
}

// Matches a markdown image, capturing the URL inside ![](...). Use only with
// String.matchAll (the /g flag makes .exec stateful across calls).
const IMAGE_MD_RE = /!\[[^\]]*\]\(([^)]+)\)/g

// Find markdown image references in text.
// Returns [{ from, to, url }] with from/to as string indices.
export function findImageRefs(text) {
    const refs = []
    for (const m of text.matchAll(IMAGE_MD_RE)) {
        refs.push({ from: m.index, to: m.index + m[0].length, url: m[1] })
    }
    return refs
}

// Extract B2 object keys from /img/<key> references in text.
export function extractImageKeys(text) {
    const keys = []
    for (const m of text.matchAll(/\/img\/([A-Za-z0-9._-]+)/g)) {
        keys.push(m[1])
    }
    return keys
}
