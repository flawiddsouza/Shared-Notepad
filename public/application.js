function insertAtCaret(element, text) {
    var txtarea = element
    var scrollPos = txtarea.scrollTop
    var caretPos = txtarea.selectionStart

    var front = (txtarea.value).substring(0, caretPos)
    var back = (txtarea.value).substring(txtarea.selectionEnd, txtarea.value.length)
    txtarea.value = front + text + back
    caretPos = caretPos + text.length
    txtarea.selectionStart = caretPos
    txtarea.selectionEnd = caretPos
    txtarea.focus()
    txtarea.scrollTop = scrollPos
}

function dispatchInputEvent(textarea) {
    var event = new Event('input')
    textarea.dispatchEvent(event)
}

document.addEventListener('DOMContentLoaded', function() {

    var ws = new ReconnectingWebSocket('ws://' + location.hostname + ':9873')
    var textArea = document.getElementsByTagName('textarea')['clipboard']
    var status = document.getElementsByTagName('p')['status']
    var clear = document.getElementsByTagName('button')['clear']
    var undoClear = document.getElementsByTagName('button')['undo-clear']
    var insertDate = document.getElementsByTagName('button')['insert-date']
    var insertTime = document.getElementsByTagName('button')['insert-time']
    var insertDateTime = document.getElementsByTagName('button')['insert-date-time']

    ws.onopen = function() {
        status.innerText = "Status: Connected"
    }

    ws.onerror = function(error) {
        status.innerText = "Status: Error"
    }

    ws.onclose = function() {
        status.innerText = "Status: Disconnected"
    }

    textArea.addEventListener('input', function() {
        if(ws.readyState !== ws.CLOSED && ws.readyState !== ws.CLOSING && ws.readyState !== ws.CONNECTING) {
            ws.send(textArea.value)
        }
    })

    ws.onmessage = function(message) {
        // This if condition prevents unnecessary updates if the sent and received data is the same
        if(message.data != textArea.value) {
            textArea.value = message.data
            textArea.scrollTop = textArea.scrollHeight
        }
    }

    textArea.focus()

    var clipboard_before_clear = null

    // clear clipboard
    clear.addEventListener('click', function(e){
        clipboard_before_clear = textArea.value
        textArea.value = ''
        dispatchInputEvent(textArea)
    })

    // undo clear clipboard
    undoClear.addEventListener('click', function(e){
        if(textArea.value == ''){
            textArea.value = clipboard_before_clear
            dispatchInputEvent(textArea)
        }
    })

    // insert date at cursor
    insertDate.addEventListener('click', function(e){
        var date = moment().format('DD-MMM-YY')
        insertAtCaret(textArea, date)
        dispatchInputEvent(textArea)
    })

    // insert time at cursor
    insertTime.addEventListener('click', function(e){
        var time = moment().format('h:mm A')
        time = `(${time}) `
        insertAtCaret(textArea, time)
        dispatchInputEvent(textArea)
    })

    // insert date & time at cursor
    insertDateTime.addEventListener('click', function(e){
        var dateTime = moment().format('DD-MMM-YY h:mm A')
        dateTime = dateTime + ': '
        insertAtCaret(textArea, dateTime)
        dispatchInputEvent(textArea)
    })

    // adding keyboard shortcuts
    window.addEventListener('keydown', handleEvent)

    function handleEvent(e) {
        if(e.keyCode == 122) { // "F11" key
            insertTime.dispatchEvent(new Event('click'))
            e.preventDefault()
        }
        if(e.keyCode == 123) { // "F12" key
            insertDateTime.dispatchEvent(new Event('click'))
            e.preventDefault()
        }
    }   
})