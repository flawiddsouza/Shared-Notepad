import './style.css'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { EditorView, minimalSetup } from 'codemirror'
import { yCollab } from 'y-codemirror.next'
import dayjs from 'dayjs'

const WS_URL = 'ws://' + location.hostname + ':9873'

// Meta doc: shared tab list
const metaDoc = new Y.Doc()
const metaProvider = new WebsocketProvider(WS_URL, 'meta', metaDoc)
const tabOrder = metaDoc.getArray('tabs')    // ordered tab IDs
const tabNames = metaDoc.getMap('tabNames')  // id → display name

// User identity
const stored = JSON.parse(sessionStorage.getItem('user') || 'null')
const user = stored ?? {
    name: 'Guest-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
    color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
}
if (!stored) sessionStorage.setItem('user', JSON.stringify(user))

// Active editor state
let activeTabId = null
let ydoc = null
let provider = null
let view = null
const beforeClear = {}

const status = document.getElementsByTagName('p')['status']

function createEditor(tabId) {
    if (view) { view.destroy(); view = null }
    if (provider) { provider.destroy(); provider = null }
    if (ydoc) { ydoc.destroy(); ydoc = null }

    ydoc = new Y.Doc()
    const yText = ydoc.getText('codemirror')
    provider = new WebsocketProvider(WS_URL, tabId, ydoc)
    provider.awareness.setLocalStateField('user', user)

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

    view = new EditorView({
        extensions: [minimalSetup, EditorView.lineWrapping, yCollab(yText, remoteOnlyAwareness)],
        parent: document.getElementById('editor')
    })

    provider.on('status', ({ status: s }) => {
        status.innerText = 'Status: ' + (s === 'connected' ? 'Connected' : s === 'disconnected' ? 'Disconnected' : 'Connecting...')
    })

    activeTabId = tabId
    renderTabs()
    view.focus()
}

function switchTab(tabId) {
    if (tabId === activeTabId) { view?.focus(); return }
    sessionStorage.setItem('activeTab', tabId)
    createEditor(tabId)
}

function addTab() {
    const id = 'tab-' + Math.random().toString(36).slice(2, 8)
    const name = 'Tab ' + (tabOrder.length + 1)
    metaDoc.transact(() => {
        tabOrder.push([id])
        tabNames.set(id, name)
    })
    switchTab(id)
}

function deleteTab(tabId) {
    if (tabOrder.length <= 1) return
    if (!confirm(`Delete tab "${tabNames.get(tabId) || tabId}"? This cannot be undone.`)) return
    const tabs = tabOrder.toArray()
    const idx = tabs.indexOf(tabId)
    if (idx === -1) return
    metaDoc.transact(() => {
        tabOrder.delete(idx, 1)
        tabNames.delete(tabId)
    })
    const remaining = tabOrder.toArray()
    switchTab(remaining[Math.min(idx, remaining.length - 1)])
}

function renderTabs() {
    const bar = document.getElementById('tab-bar')
    bar.innerHTML = ''
    tabOrder.forEach(id => {
        const tab = document.createElement('div')
        tab.className = 'tab' + (id === activeTabId ? ' active' : '')

        const name = document.createElement('span')
        name.textContent = tabNames.get(id) || id
        name.addEventListener('dblclick', () => {
            const n = prompt('Tab name:', tabNames.get(id) || id)
            if (n?.trim()) tabNames.set(id, n.trim())
        })
        tab.appendChild(name)

        if (tabOrder.length > 1) {
            const x = document.createElement('span')
            x.className = 'tab-close'
            x.textContent = '×'
            x.addEventListener('click', e => { e.stopPropagation(); deleteTab(id) })
            tab.appendChild(x)
        }

        tab.addEventListener('click', () => switchTab(id))
        bar.appendChild(tab)
    })

    const add = document.createElement('button')
    add.className = 'tab-add'
    add.textContent = '+'
    add.addEventListener('click', addTab)
    bar.appendChild(add)
}

function initTabs() {
    if (tabOrder.length === 0) {
        metaDoc.transact(() => {
            tabOrder.push(['clipboard'])
            tabNames.set('clipboard', 'Clipboard')
        })
    }
    const saved = sessionStorage.getItem('activeTab')
    const tabs = tabOrder.toArray()
    createEditor(saved && tabs.includes(saved) ? saved : tabs[0])
}

if (metaProvider.synced) {
    initTabs()
} else {
    metaProvider.once('sync', isSynced => { if (isSynced) initTabs() })
}

tabOrder.observe(renderTabs)
tabNames.observe(renderTabs)

function insert(text) {
    const { from, to } = view.state.selection.main
    view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length }
    })
    view.focus()
}

document.getElementsByTagName('button')['clear'].addEventListener('click', () => {
    const yText = ydoc.getText('codemirror')
    beforeClear[activeTabId] = yText.toString()
    yText.delete(0, yText.length)
})

document.getElementsByTagName('button')['undo-clear'].addEventListener('click', () => {
    const yText = ydoc.getText('codemirror')
    if (yText.length === 0 && beforeClear[activeTabId]) yText.insert(0, beforeClear[activeTabId])
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
