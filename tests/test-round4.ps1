param([string]$Exe)
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
. "$PSScriptRoot\cdpkeys.ps1"
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class MenuApi { [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h); }
"@ -ErrorAction SilentlyContinue

$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) {
    [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" })
}
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message + ' @ ' + (e.stack||'').split('\n')[1]; } })()" }
function Shot([string]$name) {
    $r = Cdp 'Page.captureScreenshot' @{ format = 'png' }
    [IO.File]::WriteAllBytes("$sp\r4-$name.png", [Convert]::FromBase64String($r.result.data))
}
function P([string]$name) { ("$W\" + $name).Replace('\', '\\') }
function MenuShown { $h = [KB]::MainWin([uint32]$script:proc.Id); return ([MenuApi]::GetMenu($h) -ne [IntPtr]::Zero) }
function StubClipboard { J "clipboard.writeText = async (t) => { window.__clip = t; }; clipboard.readText = async () => window.__clip; return typeof clipboard.writeText" | Out-Null }
function AltTap { Send-Key @() 'Alt' 'AltLeft' 0x12 }

$W = "$sp\work4"; Remove-Item $W -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item "$PSScriptRoot\fixtures\samples" $W -Recurse
Set-Content "$W\table.md" -Encoding utf8 -NoNewline -Value "# Tables`n`n| Name | Qty |`n| --- | ---: |`n| Apple | 3 |`n| Pear | 5 |`n`nAfter."

Start-App $Exe $null
StubClipboard

# ---------- word wrap ----------
J "await openPath('$(P 'app.log')'); setLayoutMode('edit-only'); editor.value = 'x'.repeat(400) + '\n' + editor.value; syncFromEditor(); return 1" | Out-Null
$r = J "return settings.wordWrap + '|' + getComputedStyle(edTextEl()).whiteSpace + '|' + (editor.scrollWidth > editor.clientWidth)"
T 'Word wrap on by default' $r ($r -eq 'true|pre-wrap|false' -or $r -eq 'true|break-spaces|false')
Send-Key @('ALT') 'z' 'KeyZ' 0x5A
$r = J "await new Promise(r=>requestAnimationFrame(()=>r())); return settings.wordWrap + '|' + getComputedStyle(edTextEl()).whiteSpace + '|' + getComputedStyle(editorHighlight).whiteSpace + '|' + (editor.scrollWidth > editor.clientWidth) + '|' + editor.getAttribute('wrap')"
T 'Alt+Z turns word wrap off (editor + colour layer)' $r ($r -eq 'false|pre|pre|true|off')
if (IsCM) { 'SKIPPED in CodeMirror: no separate coloured layer to keep in step' } else {
$r = J "editor.scrollLeft = 300; editor.dispatchEvent(new Event('scroll')); return editor.scrollLeft + '/' + editorHighlight.scrollLeft + ' h=' + editor.clientHeight + '/' + editorHighlight.clientHeight"
$m = [regex]::Match($r, '(\d+)/(\d+) h=(\d+)/(\d+)')
T 'No-wrap: layers scroll sideways together, same height' $r ($m.Success -and $m.Groups[1].Value -eq $m.Groups[2].Value -and $m.Groups[3].Value -eq $m.Groups[4].Value -and [int]$m.Groups[1].Value -gt 0)
}
Shot 'nowrap'
J "editor.scrollLeft=0; editor.dispatchEvent(new Event('scroll')); return 1" | Out-Null

# ---------- sidebar / status bar / menu bar ----------
Send-Key @('CTRL', 'SHIFT') 'E' 'KeyE' 0x45
T 'Ctrl+Shift+E hides the sidebar' (J "return sidebarEl.offsetWidth") ((J "return sidebarEl.offsetWidth") -eq 0)
Send-Key @('CTRL', 'SHIFT') 'E' 'KeyE' 0x45
T 'Ctrl+Shift+E shows it again' (J "return sidebarEl.offsetWidth") ([int](J "return sidebarEl.offsetWidth") -gt 20)
$m0 = MenuShown
AltTap; Start-Sleep -Milliseconds 400
$m1 = MenuShown
J "changeSetting('menuBar', false); return 1" | Out-Null; Start-Sleep -Milliseconds 400
$m2 = MenuShown
AltTap; Start-Sleep -Milliseconds 400
$m3 = MenuShown; $s3 = J "return settings.menuBar"
AltTap; Start-Sleep -Milliseconds 400
$m4 = MenuShown
J "changeSetting('menuBar', true); return 1" | Out-Null; Start-Sleep -Milliseconds 400
T 'Alt shows a hidden menu bar for now, Alt again hides it' "on=$m0 afterAlt=$m1 off=$m2 peek=$m3 (setting $s3) afterAlt2=$m4" ($m0 -and $m1 -and -not $m2 -and $m3 -and $s3 -eq $false -and -not $m4)
Send-Key @('ALT') 'z' 'KeyZ' 0x5A
T 'Alt+Z does not toggle the menu bar' "menu=$(MenuShown) wrap=$(J 'return settings.wordWrap')" ((MenuShown) -and (J 'return settings.wordWrap') -eq $true)
Send-Key @('ALT') 'z' 'KeyZ' 0x5A   # wrap back off for the persistence test
J "toggleStatusBar(); return 1" | Out-Null
T 'Status bar can be hidden' (J "return document.querySelector('.statusbar').offsetHeight") ((J "return document.querySelector('.statusbar').offsetHeight") -eq 0)
J "toggleStatusBar(); return 1" | Out-Null

# ---------- settings dialog ----------
Send-Key @('CTRL') ',' 'Comma' 0xBC
$r = J "return !settingsEl.classList.contains('hidden') + '|' + settingsEl.querySelectorAll('[data-s]').length"
T 'Ctrl+, opens Settings' $r ($r -like 'true|3*')
$r = J @"
const set = (k, v) => { const el = settingsEl.querySelector('[data-s=' + k + ']'); if (el.type === 'checkbox') el.checked = v; else el.value = v; el.dispatchEvent(new Event(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', {bubbles:true})); };
set('editFont', 'Courier New'); set('editStyle', 'bold-italic'); set('editColor', '#112233'); set('editBg', '#fff8e0');
set('previewFont', 'Georgia'); set('previewStyle', 'italic'); set('previewColor', '#334455'); set('previewBg', '#eef7ff');
set('tabSize', '8'); set('lineNumbers', true); set('newTabView', 'split-ep'); set('editFontSize', '18'); set('previewFontSize', '18');
await new Promise(r=>requestAnimationFrame(()=>r()));
const e = getComputedStyle(edTextEl()), h = getComputedStyle(editorHighlight), p = getComputedStyle(preview), w = getComputedStyle(editorHighlight.parentElement);
return [e.fontFamily.split(',')[0], e.fontWeight, e.fontStyle, h.fontFamily.split(',')[0], h.fontWeight, h.color, w.backgroundColor, e.tabSize, p.fontFamily.split(',')[0], p.fontStyle, p.color, p.backgroundColor, lineNumbersVisible].join('|');
"@
T 'Editor + preview font, style, colours, tab width apply live' $r ($r -eq '"Courier New"|700|italic|"Courier New"|700|rgb(17, 34, 51)|rgb(255, 248, 224)|8|Georgia|italic|rgb(51, 68, 85)|rgb(238, 247, 255)|true')
Shot 'settings'
$r = J "settingsEl.querySelector('[data-clear=previewBg]').click(); await new Promise(r=>setTimeout(r,50)); return settings.previewBg + '|' + settingsEl.querySelector('[data-theme-flag=previewBg]').textContent + '|' + getComputedStyle(preview).backgroundColor"
T '"Use theme" clears a custom colour' $r ($r -like '|theme|rgb(*' -and $r -notlike '*238, 247, 255*')
Send-Key @() 'Escape' 'Escape' 0x1B
T 'Esc closes Settings' (J "return settingsEl.classList.contains('hidden')") ((J "return settingsEl.classList.contains('hidden')") -eq $true)
$r = J "addDocAndActivate(newUntitledDoc()); return getActive().layoutMode + '|' + getComputedStyle(edTextEl()).fontSize + '|' + getComputedStyle(preview).fontSize + '|' + statusZoom.textContent"
T 'New tab uses default view + editor/preview font sizes from Settings' $r ($r -eq 'split-ep|18px|18px|100%')
$r = J "await openPath('$(P 'notes.md')'); const a=getActive().layoutMode; await openPath('$(P 'data.json')'); return a + '|' + getActive().layoutMode + '|' + getComputedStyle(edTextEl()).fontSize"
T 'Opened Markdown follows default view; code stays Edit Only' $r ($r -eq 'split-ep|edit-only|18px')

# ---------- table editing ----------
J "await openPath('$(P 'table.md')'); setLayoutMode('split-ep'); return 1" | Out-Null
function MdTable { J "return getActive().content.split('\n').filter(l=>l.startsWith('|')).join(' / ').replace(/-{2,}/g, '---')" }
function CellXY([int]$row, [int]$col) { J "const t=preview.querySelector('table'); const c=t.rows[$row].cells[$col]; c.scrollIntoView({block:'nearest'}); const r=c.getBoundingClientRect(); return Math.round(r.left+8)+','+Math.round(r.top+r.height/2)" }
function RightClickCell([int]$row, [int]$col) {
    $x, $y = (CellXY $row $col).Split(',')
    Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [int]$x; y = [int]$y; button = 'right'; clickCount = 1 } | Out-Null
    Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = [int]$x; y = [int]$y; button = 'right'; clickCount = 1 } | Out-Null
    Start-Sleep -Milliseconds 250
}
function MenuClick([string]$label, [string]$sub = '') {
    if ($sub) {
        J "const b=[...ctxMenu.querySelectorAll('button')].find(b=>b.querySelector('.ctx-label').textContent==='$label'); b.dispatchEvent(new MouseEvent('mouseenter')); const s=document.querySelectorAll('.ctx-menu')[1]; [...s.querySelectorAll('button')].find(b=>b.querySelector('.ctx-label').textContent==='$sub').click(); return 1" | Out-Null
    } else {
        J "[...ctxMenu.querySelectorAll('button')].find(b=>b.querySelector('.ctx-label').textContent==='$label').click(); return 1" | Out-Null
    }
    Start-Sleep -Milliseconds 250
}
T 'Table starts as expected' (MdTable) ((MdTable) -eq '| Name | Qty | / | --- | ---: | / | Apple | 3 | / | Pear | 5 |')
RightClickCell 1 0
$items = J "return [...ctxMenu.children].map(c=>c.className==='ctx-header'?'['+c.textContent+']':c.className==='ctx-sep'?'-':c.querySelector('.ctx-label').textContent + (c.disabled?'(x)':'')).join(' ; ')"
T 'Right-click a cell shows the table menu' $items ($items -like '`[TABLE · ROW 1 · COLUMN 1`] ; Add row above ; Add row below ; Add column left ; Add column right ; - ; Move row up(x) ; Move row down ; Move column left(x) ; Move column right ; - ; Align column ; - ; Delete row ; Delete column ; Delete table')
MenuClick 'Add row below'
Cdp 'Input.insertText' @{ text = 'Banana' } | Out-Null; Start-Sleep -Milliseconds 300
T 'Add row below + type into the new cell' (MdTable) ((MdTable) -eq '| Name | Qty | / | --- | ---: | / | Apple | 3 | / | Banana |  | / | Pear | 5 |')
RightClickCell 0 0; MenuClick 'Add column right'
Cdp 'Input.insertText' @{ text = 'Colour' } | Out-Null; Start-Sleep -Milliseconds 300
T 'Add column right (header) + type' (MdTable) ((MdTable) -eq '| Name | Colour | Qty | / | --- | --- | ---: | / | Apple |  | 3 | / | Banana |  |  | / | Pear |  | 5 |')
RightClickCell 3 0; MenuClick 'Move row up'
T 'Move row up' (MdTable) ((MdTable) -like '*| Apple *| / | Pear *| / | Banana *')
RightClickCell 1 2; MenuClick 'Move column left'
T 'Move column left keeps alignment with its column' (MdTable) ((MdTable) -eq '| Name | Qty | Colour | / | --- | ---: | --- | / | Apple | 3 |  | / | Pear | 5 |  | / | Banana |  |  |')
RightClickCell 1 2; MenuClick 'Align column' 'Center'
T 'Align column center' (MdTable) ((MdTable) -like '| Name | Qty | Colour | / | --- | ---: | :-*: |*')
RightClickCell 2 2; MenuClick 'Delete column'
RightClickCell 3 0; MenuClick 'Delete row'
T 'Delete column + delete row' (MdTable) ((MdTable) -eq '| Name | Qty | / | --- | ---: | / | Apple | 3 | / | Pear | 5 |')
# Tab navigation: Tab moves to the next cell, Tab in the last cell adds a row
J "const t=preview.querySelector('table'); const c=t.rows[2].cells[1]; preview.focus(); const r=document.createRange(); r.selectNodeContents(c); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); return 1" | Out-Null
Send-Key @() 'Tab' 'Tab' 0x09
Cdp 'Input.insertText' @{ text = 'Kiwi' } | Out-Null
Send-Key @() 'Tab' 'Tab' 0x09
Cdp 'Input.insertText' @{ text = '9' } | Out-Null; Start-Sleep -Milliseconds 300
T 'Tab in last cell adds a row; Tab moves on' (MdTable) ((MdTable) -eq '| Name | Qty | / | --- | ---: | / | Apple | 3 | / | Pear | 5 | / | Kiwi | 9 |')
Send-Key @('SHIFT') 'Tab' 'Tab' 0x09
$r = J "return getSelection().toString()"
T 'Shift+Tab goes back (selects the cell)' $r ($r -eq 'Kiwi')
Shot 'table'
RightClickCell 1 0; MenuClick 'Delete table'
T 'Delete table' (J "return getActive().content.includes('|') + '|' + !!preview.querySelector('table')") ((J "return getActive().content.includes('|') + '|' + !!preview.querySelector('table')") -eq 'false|false')

# ---------- everything survives a restart ----------
$before = J "return JSON.stringify({wrap:settings.wordWrap, menu:settings.menuBar, side:settings.sidebar, s:settings.editFont+settings.editStyle+settings.editColor+settings.previewFont+settings.newTabView+settings.editFontSize+settings.previewFontSize+settings.tabSize, ln:lineNumbersVisible})"
J "toggleMenuBar(); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null   # leave the menu bar hidden
$before = J "return JSON.stringify({wrap:settings.wordWrap, menu:settings.menuBar, side:settings.sidebar, s:settings.editFont+settings.editStyle+settings.editColor+settings.previewFont+settings.newTabView+settings.editFontSize+settings.previewFontSize+settings.tabSize, ln:lineNumbersVisible})"
$hwnd = [KB]::MainWin([uint32]$script:proc.Id)
[void][W32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
$exited = $script:proc.WaitForExit(6000)
try { $script:ws.Dispose() } catch {}
Start-App $Exe $null -KeepSession
Start-Sleep -Milliseconds 1200
$after = J "return JSON.stringify({wrap:settings.wordWrap, menu:settings.menuBar, side:settings.sidebar, s:settings.editFont+settings.editStyle+settings.editColor+settings.previewFont+settings.newTabView+settings.editFontSize+settings.previewFontSize+settings.tabSize, ln:lineNumbersVisible})"
T 'Word wrap, menu bar, settings survive a restart' "exited=$exited before=$before after=$after" ($exited -and $before -eq $after -and $after -like '*"wrap":false,"menu":false*')
T 'Menu bar really hidden after restart' "GetMenu present=$(MenuShown)" (-not (MenuShown))
J "toggleMenuBar(); return 1" | Out-Null; Start-Sleep -Milliseconds 300
T 'Menu bar comes back' "GetMenu present=$(MenuShown)" (MenuShown)

# ---------- restore session OFF: closing asks to save instead of keeping edits ----------
$r = J "settings.restoreSession=false; scheduleSessionSave(); const d=getActive(); editor.value += '\nunsaved line'; syncFromEditor(); await new Promise(r=>setTimeout(r,1000)); return d.dirty + '|' + tabTitle(d)"
$hwnd = [KB]::MainWin([uint32]$script:proc.Id)
[void][W32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds 5500    # longer than the 4s safety-net timer
$dialog = J "return !document.getElementById('save-ask').classList.contains('hidden') + '|' + document.getElementById('save-ask-text').textContent.slice(0, 40)"
$alive = -not $script:proc.HasExited
T 'Restore off: close shows the Yes / No / Cancel prompt and the window waits for it' "dirty=$r dialog=$dialog alive=$alive" ($dialog -like 'true|Save changes to*' -and $alive)
J "document.getElementById('save-ask-cancel').click(); return 1" | Out-Null   # Cancel: the app must stay open
Start-Sleep -Milliseconds 5500    # longer than the 4s safety-net timer
$alive = -not $script:proc.HasExited
$still = J "return getActive().dirty"
T 'Cancel keeps the app open with the unsaved text' "alive=$alive dirty=$still" ($alive -and $still -eq $true)
[void][W32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds 1500
J "document.getElementById('save-ask-no').click(); return 1" | Out-Null   # No: close without saving
$exited = $script:proc.WaitForExit(6000)
$disk = Get-Content "$W\table.md" -Raw
T "Don't Save closes the app and leaves the file alone" "exited=$exited fileChanged=$($disk.Contains('unsaved line'))" ($exited -and -not $disk.Contains('unsaved line'))
try { $script:ws.Dispose() } catch {}
Start-App $Exe $null -KeepSession
Start-Sleep -Milliseconds 1200
$r = J "return docs.length + '|' + tabTitle(getActive()) + '|' + JSON.stringify(getActive().content) + '|' + settings.restoreSession"
T 'Restore off: next launch starts with a fresh tab' $r ($r -eq '1|Untitled|""|false')
# ...and the Save answer writes the file before closing
J "await openPath('$(P 'plain.txt')'); setLayoutMode('edit-only'); editor.value += 'SAVED ON CLOSE'; syncFromEditor(); await new Promise(r=>setTimeout(r,900)); return 1" | Out-Null
$hwnd = [KB]::MainWin([uint32]$script:proc.Id)
[void][W32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds 1200
J "document.getElementById('save-ask-yes').click(); return 1" | Out-Null   # Yes: save, then close
$exited = $script:proc.WaitForExit(6000)
$disk = Get-Content "$W\plain.txt" -Raw
T 'Save answer saves, then closes' "exited=$exited saved=$($disk.Contains('SAVED ON CLOSE'))" ($exited -and $disk.Contains('SAVED ON CLOSE'))
try { $script:ws.Dispose() } catch {}
Start-App $Exe $null -KeepSession
J "settings.restoreSession=true; scheduleSessionSave(); await new Promise(r=>setTimeout(r,1200)); return 1" | Out-Null

Stop-App
$results | Format-Table -AutoSize -Wrap | Out-String -Width 260
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
