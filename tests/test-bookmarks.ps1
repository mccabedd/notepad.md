param([string]$Exe)
# Bookmark margin, Search > Bookmark commands, hidden characters, Advanced Find wildcard and
# double-click copy, and the menu bar shown with Alt.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
function Mouse($x, $y, $button = 'left', $count = 1) {
    Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y } | Out-Null
    for ($c = 1; $c -le $count; $c++) {
        Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = $button; buttons = $(if ($button -eq 'left') { 1 } else { 2 }); clickCount = $c } | Out-Null
        Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = $button; buttons = 0; clickCount = $c } | Out-Null
    }
}
function Key($key, $code, $vk, $mods = 0) {
    Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = $key; code = $code; windowsVirtualKeyCode = $vk; modifiers = $mods } | Out-Null
    Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $key; code = $code; windowsVirtualKeyCode = $vk; modifiers = $mods } | Out-Null
}
# Centre of a gutter part (.ln-n or .ln-m) for a line (0-based).
function GutterPoint($line, $part) {
    (J "return JSON.stringify(edGutterPoint($line, '$part' === '.ln-m' ? 'margin' : 'number'))") | ConvertFrom-Json
}

Start-App $Exe $null

# --- Alt shows a hidden menu bar until it is used (measured before any viewport emulation) ---
J "changeSetting('menuBar', false); return 1" | Out-Null
Start-Sleep -Milliseconds 500
$h0 = J "return window.innerHeight"
Key 'Alt' 'AltLeft' 18 0
Start-Sleep -Milliseconds 500
$r = J "return JSON.stringify([menuPeek, window.innerHeight < $h0, settings.menuBar])"
T 'Alt shows the hidden menu bar for now (setting stays off)' $r ($r -eq '[true,true,false]')
Mouse 200 300
Start-Sleep -Milliseconds 500
$r = J "return JSON.stringify([menuPeek, window.innerHeight === $h0])"
T 'A click in the window hides it again' $r ($r -eq '[false,true]')
J "changeSetting('menuBar', true); return 1" | Out-Null
Start-Sleep -Milliseconds 400
Key 'Alt' 'AltLeft' 18 0
Start-Sleep -Milliseconds 300
$r = J "return JSON.stringify([menuPeek, settings.menuBar])"
T 'Alt leaves a menu bar that is switched on alone' $r ($r -eq '[false,true]')

Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1000; height = 650; deviceScaleFactor = 1; mobile = $false } | Out-Null
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null
J "window.__copied = null; clipboard.writeText = async (t) => { window.__copied = t; }; window.__clip = ''; clipboard.readText = async () => window.__clip; return 1" | Out-Null

# --- the gutter follows wrapped lines ---
J "addDocAndActivate(newUntitledDoc()); setLayoutMode('edit-only'); changeSetting('wordWrap', true); if (!lineNumbersVisible) toggleLineNumbers(); editor.value = 'one\n' + 'long '.repeat(200) + '\nthree\nfour'; syncFromEditor(); return 1" | Out-Null
Start-Sleep -Milliseconds 700
$r = J "const g = edGutterRow(2); const top = editor.isCodeMirror ? editor.api.view.domAtPos(editor.value.indexOf('three') + 1).node.parentElement.closest('.cm-line').getBoundingClientRect().top : editorHighlight.children[2].getBoundingClientRect().top; return g ? String(Math.min(1, Math.round(Math.abs(g.number.getBoundingClientRect().top - top) / 3))) : 'no row'"
T 'Line number 3 sits beside line 3 when line 2 wraps' $r ($r -eq '0')

# --- clicks in the bookmark margin ---
J "const d = getActive(); d.bookmarks = {}; editor.value = 'a\nb\nc\nd\ne\nf'; syncFromEditor(); setBookmarkColour('Green'); return 1" | Out-Null
Start-Sleep -Milliseconds 500
$p = GutterPoint 1 '.ln-m'
Mouse $p.x $p.y
Start-Sleep -Milliseconds 200
$r = J "return JSON.stringify(getActive().bookmarks)"
T 'Click in the margin bookmarks the line in the current colour' $r ($r -eq '{"1":"Green"}')
$r = J "const m = edGutterRow(1).margin; return (m.classList.contains('bm-green') ? 'bm-green' : m.className) + '|' + getComputedStyle(m, '::before').backgroundColor"
T 'The margin shows a green dot' $r ($r -like 'bm-green|rgb(*')
Mouse $p.x $p.y
Start-Sleep -Milliseconds 200
$r = J "return JSON.stringify(getActive().bookmarks)"
T 'Clicking the dot removes the bookmark' $r ($r -eq '{}')

$p = GutterPoint 3 '.ln-m'
Mouse $p.x $p.y 'right'
Start-Sleep -Milliseconds 300
$r = J "const items = [...ctxMenu.querySelectorAll('button')].map(b => b.textContent.trim()); return JSON.stringify([ctxMenu.classList.contains('hidden'), items.some(t => t.startsWith('Green') && t.includes('Click')), items.some(t => t.startsWith('Orange')), items.some(t => t.startsWith('Red'))])"
T 'Right-click in the margin offers the colours (current one marked Click)' $r ($r -eq '[false,true,true,true]')
J "[...ctxMenu.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Orange')).click(); return 1" | Out-Null
Start-Sleep -Milliseconds 200
$r = J "return JSON.stringify([getActive().bookmarks, settings.bookmarkColour])"
T 'Picking Orange bookmarks the line and makes Orange the click colour' $r ($r -eq '[{"3":"Orange"},"Orange"]')
$p = GutterPoint 0 '.ln-m'
Mouse $p.x $p.y
Start-Sleep -Milliseconds 200
J "editor.focus(); editor.setSelectionRange(editor.value.indexOf('f'), editor.value.indexOf('f')); return 1" | Out-Null
Key 'F2' 'F2' 113 2
Start-Sleep -Milliseconds 200
$r = J "return JSON.stringify(getActive().bookmarks)"
T 'Next click and Ctrl+F2 use Orange too' $r ($r -eq '{"0":"Orange","3":"Orange","5":"Orange"}')
$r = J "openFindBar(true); advScope.value = 'tab'; refreshFind(false); await new Promise(r => setTimeout(r, 200)); return JSON.stringify([bookmarkOf(getActive(), 3), findState.rows.length])"
T 'Advanced Find sees the same bookmark colour' $r ($r -eq '["Orange",6]')
J "closeFindBar(); return 1" | Out-Null
$p = GutterPoint 2 '.ln-n'
Mouse $p.x $p.y
Start-Sleep -Milliseconds 200
$r = J "return JSON.stringify(editor.value.slice(editor.selectionStart, editor.selectionEnd))"
T 'Clicking a line number selects that line' $r ($r -eq '"c\n"')
J "setBookmarkColour('Green'); return 1" | Out-Null
$r = J "return JSON.stringify(currentMenuChecks().bookmark_colour_green && !currentMenuChecks().bookmark_colour_orange)"
T 'Search > Bookmark > Bookmark Colour shows the current colour' $r ($r -eq 'true')

# --- Search > Bookmark commands ---
function Setup { J "const d = getActive(); editor.value = 'a\nb\nc\nd\ne'; syncFromEditor(); d.bookmarks = {1: 'Red', 3: 'Green'}; bookmarksChanged(); return 1" | Out-Null; Start-Sleep -Milliseconds 150 }
Setup
$r = J "await bookmarkedLinesAction('copy'); return JSON.stringify([window.__copied, editor.value])"
T 'Copy Bookmarked Lines' $r ($r -eq '["b\nd\n","a\nb\nc\nd\ne"]')
Setup
$r = J "await bookmarkedLinesAction('cut'); return JSON.stringify([window.__copied, editor.value, getActive().bookmarks])"
T 'Cut Bookmarked Lines' $r ($r -eq '["b\nd\n","a\nc\ne",{}]')
$r = J "editor.focus(); runToolbarCommand('undo'); return JSON.stringify(editor.value)"
T 'Undo brings the cut lines back in one step' $r ($r -eq '"a\nb\nc\nd\ne"')
Setup
$r = J "window.__clip = 'X'; await bookmarkedLinesAction('paste'); return JSON.stringify([editor.value, getActive().bookmarks])"
T 'Paste to (Replace) Bookmarked Lines' $r ($r -eq '["a\nX\nc\nX\ne",{"1":"Red","3":"Green"}]')
Setup
$r = J "await bookmarkedLinesAction('remove'); return JSON.stringify([editor.value, getActive().bookmarks])"
T 'Remove Bookmarked Lines' $r ($r -eq '["a\nc\ne",{}]')
Setup
$r = J "await bookmarkedLinesAction('remove-others'); return JSON.stringify([editor.value, getActive().bookmarks])"
T 'Remove Non-Bookmarked Lines (colours kept)' $r ($r -eq '["b\nd",{"0":"Red","1":"Green"}]')
Setup
$r = J "await bookmarkedLinesAction('inverse'); return JSON.stringify([editor.value, Object.keys(getActive().bookmarks)])"
T 'Inverse Bookmarks' $r ($r -eq '["a\nb\nc\nd\ne",["0","2","4"]]')

# --- hidden characters ---
J "const d = getActive(); d.bookmarks = {}; d.eol = 'crlf'; editor.value = 'API_KEY=abc\u200B \n\tx\u00A0y\nlast'; syncFromEditor(); return 1" | Out-Null
Key 'H' 'KeyH' 72 10
Start-Sleep -Milliseconds 500
$r = J "const q = (s) => edLayer().querySelectorAll(s).length; return JSON.stringify([settings.showHidden, q('.hc-zw[data-c=`"200B`"]'), q('.hc-trail'), q('.hc-tab'), q('.hc-nb'), [...edLayer().querySelectorAll('.hc-eol')].map(e => e.dataset.e), q('.hc-sp') > 0])"
T 'Ctrl+Shift+H shows hidden characters' $r ($r -eq '[true,1,1,1,1,["CRLF","CRLF"],true]')
$r = J "return statusDirty.textContent"
T 'The status bar reports the zero-width space and trailing space' $r (($r -like '*zero-width space (U+200B, first: line 1)*') -and ($r -like '*1 line(s) end in spaces*') -and ($r -like '*CRLF*'))
$r = J "window.__hOn = editor.scrollHeight; return JSON.stringify(editor.isCodeMirror ? [true, editor.api.view.state.doc.lines] : [editorHighlight.scrollHeight === editor.scrollHeight, editorHighlight.children.length])"
T 'Hidden characters change no widths (layers still line up)' $r ($r -eq '[true,3]')
Key 'H' 'KeyH' 72 10
Start-Sleep -Milliseconds 400
$r = J "return JSON.stringify([settings.showHidden, edLayer().querySelectorAll('.hc-sp, .hc-eol').length, editor.scrollHeight === window.__hOn])"
T 'Ctrl+Shift+H again hides them (and they took no extra height)' $r ($r -eq '[false,0,true]')

# --- Advanced Find: wildcard and double-click copy ---
J "const d = getActive(); editor.value = '2024-10-14 14:30:05 error: disk timeout\n2024-10-14 14:30:06 error ok\n2024-10-14 14:30:07 warn timeout'; syncFromEditor(); openFindBar(true); advToggle.checked = true; applyAdvancedVisibility(); advScope.value = 'tab'; advRegex.checked = false; advWild.checked = true; advWild.dispatchEvent(new Event('change')); findInput.value = 'error*timeout'; findInput.dispatchEvent(new Event('input')); return 1" | Out-Null
Start-Sleep -Milliseconds 500
$r = J "return JSON.stringify([findState.rows.map(r => r.line), findState.matches.length])"
T 'Wildcard: error*timeout finds only the line with both' $r ($r -eq '[[0],1]')
$r = J "findInput.value = ''; findInput.dispatchEvent(new Event('input')); advHide.value = 'warn*out'; advHide.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 400)); return JSON.stringify(findState.rows.map(r => r.line))"
T 'Wildcard in Hide hides warn ... timeout' $r ($r -eq '[0,1]')
$r = J "advRegex.checked = true; advRegex.dispatchEvent(new Event('change')); return JSON.stringify([advWild.checked, advRegex.checked])"
T 'Ticking Regex unticks Wildcard' $r ($r -eq '[false,true]')
J "advRegex.checked = false; advRegex.dispatchEvent(new Event('change')); advHide.value = ''; advHide.dispatchEvent(new Event('input')); return 1" | Out-Null
Start-Sleep -Milliseconds 500
$p = (J "renderGrid(); const b = advRows.querySelector('.adv-row[data-i=`"1`"] .c-time').getBoundingClientRect(); return JSON.stringify({x: Math.round(b.left + 20), y: Math.round(b.top + b.height/2)})") | ConvertFrom-Json
Mouse $p.x $p.y 'left' 2
Start-Sleep -Milliseconds 200
$r = J "return JSON.stringify(window.__copied)"
T 'Double-click a Time cell copies the time' $r ($r -eq '"2024-10-14 14:30:06"')
$p = (J "const b = advRows.querySelector('.adv-row[data-i=`"2`"] .c-text').getBoundingClientRect(); return JSON.stringify({x: Math.round(b.left + 30), y: Math.round(b.top + b.height/2)})") | ConvertFrom-Json
Mouse $p.x $p.y 'left' 2
Start-Sleep -Milliseconds 200
$r = J "return JSON.stringify(window.__copied)"
T 'Double-click a Text cell copies the whole line' $r ($r -eq '"2024-10-14 14:30:07 warn timeout"')
J "advWild.checked = false; advWild.dispatchEvent(new Event('change')); closeFindBar(); const d = getActive(); d.content = ''; d.savedContent = ''; d.dirty = false; await closeTab(d.id); return 1" | Out-Null
Stop-App

$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
