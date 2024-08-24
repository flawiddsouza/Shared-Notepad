var jsonfile = require('jsonfile')
var jsonDB = "clipboard.json"

///////////////////////
// WebSocket Server //
/////////////////////

var WebSocketServer = require('ws').Server
var wss = new WebSocketServer({ port: 9873 })
var clientsArr = []
var clipboardObj = {}

wss.on('connection', client => {
    clientsArr.push(client)
    if(clipboardObj['clipboard'] == undefined) { // will be executed only once at the beginning
        try {
            clipboardObj = jsonfile.readFileSync(jsonDB)
        } catch(e) {
            clipboardObj['clipboard'] = null
        }
        client.send(clipboardObj['clipboard'])
    }
    else {
        client.send(clipboardObj['clipboard'])
    }
    client.on('message', message => {
        clipboardObj['clipboard'] = message
        try {
            jsonfile.writeFileSync(jsonDB, clipboardObj, { spaces: 4 })
        } catch(e) {
            console.error(e)
        }
        sendToAllExceptSender(message, client)
    })
    client.on('close', () => {
        clientsArr = clientsArr.filter(clientX => clientX !== client)
    })
})

function sendToAllExceptSender(message, sender) {
    for(var i=0; i < clientsArr.length; i++) {
        if(clientsArr[i] !== sender) {
            clientsArr[i].send(message)
        }
    }
}

//////////////////
// Main Server //
////////////////

var express = require('express')
var app = express()
var bodyParser = require('body-parser')

app.use(express.static(__dirname + '/public')) // houses "index.html"
app.use(bodyParser.urlencoded({ extended: false, limit: '50mb' }))

const WebSocket = require('ws')
const ws = new WebSocket('ws://:9873')

// POST /add-to-clipboard
app.post('/add-to-clipboard', (req, res) => {
    
    try {
        clipboardObj = jsonfile.readFileSync(jsonDB)
    } catch(e) {
        clipboardObj['clipboard'] = null
    }

    if(clipboardObj['clipboard'] != "") {
        clipboardObj['clipboard'] = clipboardObj['clipboard'] + "\n\n" + req.body.data
    }
    else {
        clipboardObj['clipboard'] = req.body.data
    }

    jsonfile.writeFile(jsonDB, clipboardObj, { spaces: 4 }, err => {
        if(!err) {
            res.send("Added to Shared Clipboard!")
            ws.send(clipboardObj['clipboard'])
        }
        else {
            res.send("Failed to add to Shared Clipboard!")
        }
    })

})

app.listen(9872)
