import './style.css'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { EditorView, minimalSetup } from 'codemirror'
import { yCollab } from 'y-codemirror.next'
import dayjs from 'dayjs'

const ydoc = new Y.Doc()
const yText = ydoc.getText('codemirror')
const provider = new WebsocketProvider('ws://' + location.hostname + ':9873', 'clipboard', ydoc)

const stored = JSON.parse(sessionStorage.getItem('user') || 'null')
const user = stored ?? {
    name: 'Guest-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
    color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
}
if (!stored) sessionStorage.setItem('user', JSON.stringify(user))
provider.awareness.setLocalStateField('user', user)

// Hide local cursor overlay — others still see ours, we still see theirs
const remoteOnlyAwareness = new Proxy(provider.awareness, {
    get(target, prop) {
        if (prop === 'getStates') {
            return () => {
                const states = new Map(target.getStates())
                states.delete(target.clientID)
                return states
            }
        }
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
    }
})

const view = new EditorView({
    extensions: [minimalSetup, EditorView.lineWrapping, yCollab(yText, remoteOnlyAwareness)],
    parent: document.getElementById('editor')
})

view.focus()

const status = document.getElementsByTagName('p')['status']
provider.on('status', ({ status: s }) => {
    status.innerText = 'Status: ' + (s === 'connected' ? 'Connected' : s === 'disconnected' ? 'Disconnected' : 'Connecting...')
})

function insert(text) {
    const { from, to } = view.state.selection.main
    view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length }
    })
    view.focus()
}

let beforeClear = null

document.getElementsByTagName('button')['clear'].addEventListener('click', () => {
    beforeClear = yText.toString()
    yText.delete(0, yText.length)
})

document.getElementsByTagName('button')['undo-clear'].addEventListener('click', () => {
    if (yText.length === 0 && beforeClear) yText.insert(0, beforeClear)
})

document.getElementsByTagName('button')['insert-date'].addEventListener('click', () =>
    insert(dayjs().format('DD-MMM-YY'))
)

document.getElementsByTagName('button')['insert-time'].addEventListener('click', () =>
    insert(`(${dayjs().format('h:mm A')}) `)
)

document.getElementsByTagName('button')['insert-date-time'].addEventListener('click', () =>
    insert(dayjs().format('DD-MMM-YY h:mm A') + ': ')
)

document.addEventListener('keydown', e => {
    if (e.key === 'F11') { e.preventDefault(); insert(`(${dayjs().format('h:mm A')}) `) }
    if (e.key === 'F12') { e.preventDefault(); insert(dayjs().format('DD-MMM-YY h:mm A') + ': ') }
})
