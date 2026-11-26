param([string]$Exe)
# v1.0.6 features: external changes + follow, recent files, reopen closed tab, save all, go to line,
# print / export, large files, outline, auto-pairing, Ctrl+B / Ctrl+I, Advanced Ctrl+Shift+B.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
. "$PSScriptRoot\cdpkeys.ps1"
. "$PSScriptRoot\winmsg.ps1"
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class MenuRead {
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr m, int pos);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr m, uint id, StringBuilder sb, int max, uint flags);
    public static string Items(IntPtr m) {
        var sb = new StringBuilder(); int n = GetMenuItemCount(m);
        for (int i = 0; i < n; i++) { var s = new StringBuilder(512); GetMenuString(m, (uint)i, s, 512, 0x400); sb.Append(s.ToString()).Append("|"); }
        return sb.ToString();
    }
    public static string Recent(IntPtr hwnd) {
        IntPtr file = GetSubMenu(GetMenu(hwnd), 0); int n = GetMenuItemCount(file);
        for (int i = 0; i < n; i++) { var s = new StringBuilder(256); GetMenuString(file, (uint)i, s, 256, 0x400); if (s.ToString().StartsWith("Recent")) return Items(GetSubMenu(file, i)); }
        return "no recent submenu";
    }
}
"@ -ErrorAction SilentlyContinue
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message + ' @ ' + (e.stack||'').split('\n')[1]; } })()" }
function K([string]$combo, [string]$key, [string]$code, [int]$vk, [string]$text = '') { $m = @(); if ($combo) { $m = $combo.Split('+') }; Send-Key $m $key $code $vk $text }
function TypeText([string]$s) { foreach ($ch in $s.ToCharArray()) { $c = [string]$ch; Cdp 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = $c; text = $c; unmodifiedText = $c } | Out-Null; Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $c } | Out-Null }; Start-Sleep -Milliseconds 150 }
function Write-NoBom([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }
$work = "$sp\work13"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
$w = $work.Replace('\', '\\')

Start-App $Exe $null
Focus-App | Out-Null
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null
J "dialogApi.ask = async (m) => { (window.__asks = window.__asks || []).push(m); return window.__askAnswer !== false; }; askSaveYesNoCancel = async (m) => { (window.__asks = window.__asks || []).push(m); return window.__askAnswer === false ? 'no' : 'yes'; }; dialogApi.message = async (m, o) => { (window.__msgs = window.__msgs || []).push(m); if (o && o.buttons) { (window.__asks = window.__asks || []).push(m); return window.__askAnswer === false ? 'No' : 'Yes'; } }; return 1" | Out-Null
$r = J "return document.getElementById('about-version').textContent"
T "About shows v$AppVersion" $r ($r -eq "v$AppVersion")

# ---------- files changed outside the app ----------
Write-NoBom "$work\a.txt" "one`n"
J "await openPath('$w\\a.txt'); return 1" | Out-Null
Start-Sleep -Milliseconds 300
Write-NoBom "$work\a.txt" "one`ntwo from outside`n"
$r = J "await checkExternalChanges(false); const d=getActive(); return JSON.stringify([editor.value, d.dirty])"
T 'Clean tab reloads when another program changes the file' $r ($r -eq '["one\ntwo from outside\n",false]')
J "editor.value = 'one\nmy edit\n'; editor.dispatchEvent(new Event('input')); return 1" | Out-Null
Write-NoBom "$work\a.txt" "one`nthird version from outside`n"
Start-Sleep -Milliseconds 100
$r = J "await checkExternalChanges(false); return JSON.stringify([editor.value, getActive().dirty, !document.getElementById('disk-notice').classList.contains('hidden'), document.getElementById('disk-notice-text').textContent])"
T 'Tab with unsaved edits keeps them and shows the changed-on-disk bar' $r ($r.StartsWith('["one\nmy edit\n",true,true,') -and $r.Contains('changed outside'))
$r = J "[...document.querySelectorAll('#disk-notice-btns button')].find(b=>b.textContent.startsWith('Keep')).click(); await checkExternalChanges(false); return JSON.stringify([document.getElementById('disk-notice').classList.contains('hidden'), editor.value])"
T 'Keep my version hides the bar and does not ask again' $r ($r -eq '[true,"one\nmy edit\n"]')
$r = J "window.__asks=[]; const ok = await saveDocGeneric(getActive()); return JSON.stringify([ok, window.__asks.length])"
$disk = [IO.File]::ReadAllText("$work\a.txt")
T 'Saving after Keep my version writes without asking' "$r disk=$($disk.Replace("`n",'\n'))" ($r -eq '[true,0]' -and $disk -eq "one`nmy edit`n")

# Save guard: changed on disk, then Save
Write-NoBom "$work\b.txt" "b1`n"
J "await openPath('$w\\b.txt'); editor.value='b1 mine\n'; editor.dispatchEvent(new Event('input')); return 1" | Out-Null
Start-Sleep -Milliseconds 1100
Write-NoBom "$work\b.txt" "b2 outside`n"
$r = J "window.__asks=[]; window.__askAnswer=false; const ok = await saveDocGeneric(getActive()); window.__askAnswer=true; return JSON.stringify([ok, window.__asks.length, (window.__asks[0]||'').includes('changed outside')])"
$disk = [IO.File]::ReadAllText("$work\b.txt")
T 'Save asks before overwriting a file changed outside (Cancel keeps theirs)' "$r disk=$disk" ($r -eq '[false,1,true]' -and $disk -eq "b2 outside`n")
$r = J "window.__asks=[]; const ok = await saveDocGeneric(getActive()); return JSON.stringify([ok, window.__asks.length])"
$disk = [IO.File]::ReadAllText("$work\b.txt")
T 'Overwrite writes my version' "$r disk=$disk" ($r -eq '[true,1]' -and $disk -eq "b1 mine`n")

# Deleted on disk
Write-NoBom "$work\c.txt" "keep me`n"
J "await openPath('$w\\c.txt'); return 1" | Out-Null
Remove-Item "$work\c.txt"
$r = J "await checkExternalChanges(false); const d=getActive(); return JSON.stringify([d.dirty, d.missing, editor.value, document.getElementById('disk-notice-text').textContent.includes('deleted')])"
T 'Deleted file: text kept, tab marked unsaved, bar explains' $r ($r -eq '[true,true,"keep me\n",true]')
$r = J "[...document.querySelectorAll('#disk-notice-btns button')].find(b=>b.textContent==='Save').click(); await new Promise(r=>setTimeout(r,500)); return JSON.stringify([getActive().dirty, document.getElementById('disk-notice').classList.contains('hidden')])"
T 'Save on the bar writes the file back' "$r exists=$(Test-Path "$work\c.txt")" ($r -eq '[false,true]' -and (Test-Path "$work\c.txt"))

# Automatic check when the window has focus (no manual call)
Write-NoBom "$work\d.txt" "d1`n"
J "await openPath('$w\\d.txt'); return 1" | Out-Null
Focus-App | Out-Null
Start-Sleep -Milliseconds 300
Write-NoBom "$work\d.txt" "d1`nd2 auto`n"
Start-Sleep -Milliseconds 3000
$r = J "return editor.value"
T 'Changes are picked up automatically while the window is active' $r ($r -eq "d1`nd2 auto`n".Replace("`n", "`n"))

# Follow (tail)
$log = "$work\app.log"
Write-NoBom $log ((1..200 | ForEach-Object { "2024-10-14 10:00:00 INFO line $_" }) -join "`n")
J "await openPath('$w\\app.log'); return 1" | Out-Null
$r = J "toggleFollow(); return JSON.stringify([getActive().follow, !document.getElementById('status-follow').classList.contains('hidden')])"
T 'Follow File turns on (status bar shows Following)' $r ($r -eq '[true,true]')
[IO.File]::AppendAllText($log, "`n2024-10-14 10:05:00 ERROR new line at the end", (New-Object Text.UTF8Encoding $false))
Start-Sleep -Milliseconds 2200
$r = J "const v=editor.value; return JSON.stringify([v.endsWith('ERROR new line at the end'), editor.selectionStart===v.length, editor.scrollTop + editor.clientHeight >= editor.scrollHeight - 40])"
T 'Followed file: new lines appear and the view stays at the end' $r ($r -eq '[true,true,true]')
$r = J "return JSON.stringify(currentMenuChecks().follow_file)"
T 'View > Follow File shows a tick' $r ($r -eq 'true')

# Reload from Disk (menu) on a clean tab
Write-NoBom "$work\d.txt" "reloaded by menu`n"
$r = J "setActiveTab(docs.find(d=>d.path && d.path.endsWith('d.txt')).id); getActive().disk=null; await reloadActiveFromDisk(); return editor.value"
T 'File > Reload from Disk re-reads the file' $r ($r -eq "reloaded by menu`n")

# ---------- recent files ----------
$r = J "return JSON.stringify(recentFiles.map(p=>p.split(String.fromCharCode(92)).pop()))"
T 'Recent files list (newest first)' $r ($r.StartsWith('["app.log","d.txt","c.txt","b.txt","a.txt"'))
Start-Sleep -Milliseconds 400
$m = [MenuRead]::Recent($script:hwnd)
T 'File > Recent Files menu lists them' $m ($m -like '&1 *app.log|&2 *d.txt|*|Clear Recent Files|')
$r = J "const d=docs.find(x=>x.path && x.path.endsWith('a.txt')); await closeTab(d.id); await openRecent(recentFiles.findIndex(p=>p.endsWith('a.txt'))); return getActive().path.split(String.fromCharCode(92)).pop()"
T 'Choosing a recent file opens it' $r ($r -eq 'a.txt')
Write-NoBom "$work\gone.txt" "x"
J "await openPath('$w\\gone.txt'); await closeTab(getActive().id); return 1" | Out-Null
Remove-Item "$work\gone.txt"
$r = J "window.__msgs=[]; await openRecent(recentFiles.findIndex(p=>p.endsWith('gone.txt'))); return JSON.stringify([recentFiles.some(p=>p.endsWith('gone.txt')), window.__msgs.length])"
T 'A recent file that no longer exists is removed (with a message)' $r ($r -eq '[false,1]')

# ---------- reopen closed tab ----------
J "addDocAndActivate(newUntitledDoc()); editor.value='unsaved words to bring back'; editor.dispatchEvent(new Event('input')); window.__askAnswer=false; await closeTab(getActive().id); window.__askAnswer=true; return 1" | Out-Null
$r = J "return docs.some(d=>d.content==='unsaved words to bring back')"
T 'Untitled tab with text closed (chose not to save)' $r ($r -eq $false)
K 'CTRL+SHIFT' 'T' 'KeyT' 0x54
$r = J "return JSON.stringify([getActive().content, getActive().path])"
T 'Ctrl+Shift+T brings it back with its text' $r ($r -eq '["unsaved words to bring back",null]')
J "await closeTab(docs.find(d=>d.path && d.path.endsWith('b.txt')).id); return 1" | Out-Null
K 'CTRL+SHIFT' 'T' 'KeyT' 0x54
$r = J "return getActive().path ? getActive().path.split(String.fromCharCode(92)).pop() + '|' + getActive().dirty : 'none'"
T 'Reopen Closed Tab brings a closed file back' $r ($r -eq 'b.txt|false')

# ---------- save all ----------
J "for (const d of docs.filter(d=>!d.path)) { d.content=''; d.savedContent=''; d.dirty=false; } for (const n of ['a.txt','b.txt']) { const d=docs.find(x=>x.path && x.path.endsWith(n)); setActiveTab(d.id); editor.value='saved by save all ' + n + '\n'; editor.dispatchEvent(new Event('input')); } return 1" | Out-Null
K 'CTRL+ALT' 's' 'KeyS' 0x53
Start-Sleep -Milliseconds 600
$a = [IO.File]::ReadAllText("$work\a.txt"); $b = [IO.File]::ReadAllText("$work\b.txt")
$r = J "return docs.filter(d=>d.dirty).length"
T 'Ctrl+Alt+S saves every changed tab' "dirty=$r a=$a b=$b" ($r -eq 0 -and $a -eq "saved by save all a.txt`n" -and $b -eq "saved by save all b.txt`n")

# ---------- go to line ----------
J "setActiveTab(docs.find(d=>d.path && d.path.endsWith('app.log')).id); getActive().follow=false; setLayoutMode('edit-only'); editor.focus(); editor.setSelectionRange(0,0); return 1" | Out-Null
K 'CTRL' 'g' 'KeyG' 0x47
$r = J "return JSON.stringify([!document.getElementById('goto').classList.contains('hidden'), document.activeElement.id, document.getElementById('goto-label').textContent])"
T 'Ctrl+G opens Go to Line' $r ($r.StartsWith('[true,"goto-input","Line number (1 ') -and $r.EndsWith(' 201)"]'))
J "document.getElementById('goto-input').value=''; return 1" | Out-Null
TypeText '150'
K '' 'Enter' 'Enter' 0x0D
$r = J "const c=lineIndex(getActive()); return JSON.stringify([document.getElementById('goto').classList.contains('hidden'), lineOf(c, editor.selectionStart)+1, document.activeElement===editor, editor.value.slice(editor.selectionStart, editor.selectionStart+33)])"
T 'Typing 150 + Enter puts the caret on line 150' $r ($r -eq '[true,150,true,"2024-10-14 10:00:00 INFO line 150"]')
K 'CTRL' 'g' 'KeyG' 0x47
K '' 'Escape' 'Escape' 0x1B
$r = J "return document.getElementById('goto').classList.contains('hidden')"
T 'Esc closes Go to Line' $r ($r -eq $true)

# ---------- print and export ----------
Write-NoBom "$work\doc.md" "# Report Title`n`nSome **bold** text and a [link](https://example.com).`n`n## Section Two`n`n``````js`nconst x = 1;`n```````n`n| A | B |`n|---|---|`n| 1 | 2 |`n"
J "await openPath('$w\\doc.md'); setLayoutMode('preview-only'); return 1" | Out-Null
$r = J "const root = preparePrintRoot(getActive()); return JSON.stringify([root.querySelector('h1').textContent, !!root.querySelector('table'), !!root.querySelector('code.hljs'), root.querySelectorAll('.code-copy-btn').length])"
T 'Print page holds the rendered document' $r ($r -eq '["Report Title",true,true,0]')
Cdp 'Emulation.setEmulatedMedia' @{ media = 'print' } | Out-Null
$r = J "return JSON.stringify([getComputedStyle(document.querySelector('.main-area')).display, getComputedStyle(document.querySelector('.tabbar-wrap')).display, getComputedStyle(document.getElementById('print-root')).display, getComputedStyle(document.getElementById('print-root')).backgroundColor])"
Cdp 'Emulation.setEmulatedMedia' @{ media = '' } | Out-Null
J "clearPrintRoot(); return 1" | Out-Null
T 'When printing only the document shows (white page, no tabs/toolbars)' $r ($r -eq '["none","none","block","rgb(255, 255, 255)"]')
$pdf = "$work\report.pdf"
$r = J "preparePrintRoot(getActive()); try { await invoke('cmd_print_to_pdf', { path: '$w\\report.pdf' }); return 'ok'; } catch (e) { return 'ERR ' + e } finally { clearPrintRoot(); }"
$head = if (Test-Path $pdf) { [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($pdf)[0..4]) } else { '' }
$size = if (Test-Path $pdf) { (Get-Item $pdf).Length } else { 0 }
T 'Export as PDF writes a real PDF' "$r head=$head size=$size" ($r -eq 'ok' -and $head -eq '%PDF-' -and $size -gt 3000)
$html = "$work\report.html"
$r = J "const h = buildExportHtml(getActive()); await invoke('cmd_write_file', { path: '$w\\report.html', content: h, encoding: 'utf8' }); return JSON.stringify([h.startsWith('<!DOCTYPE html>'), h.includes('<h1'), h.includes('Report Title'), h.includes('.np-doc'), h.includes('contenteditable'), h.includes('<title>doc</title>')])"
T 'Export as HTML: a standalone page with styles' $r ($r -eq '[true,true,true,true,false,true]')
$r = J "editor.value = '![pic](images/a%20b.png) and ![abs](C:/pics/x.png)'; editor.dispatchEvent(new Event('input')); const h = renderDocHtml(getActive(), true); return JSON.stringify([h.includes('images/a%20b.png'), h.includes('file:///C:/pics/x.png'), h.includes('localimg')])"
T 'Exported HTML keeps relative image paths (absolute ones become file:///)' $r ($r -eq '[true,true,false]')
J "editor.value = getActive().savedContent; editor.dispatchEvent(new Event('input')); return 1" | Out-Null

# Export through the real save dialog (driven with window messages, so it also works on a locked PC)
J "window.__ex = 'pending'; exportPdf().then(()=>window.__ex='done'); return 1" | Out-Null
$ok = Save-DialogMsg $script:proc.Id "$work\via-menu.pdf"
for ($i = 0; $i -lt 30 -and (J "return window.__ex") -ne 'done'; $i++) { Start-Sleep -Milliseconds 300 }
$size = if (Test-Path "$work\via-menu.pdf") { (Get-Item "$work\via-menu.pdf").Length } else { 0 }
T 'File > Export as PDF (with the save dialog) writes the file' "dialog=$ok size=$size" ($ok -and $size -gt 3000)
J "window.__ex = 'pending'; exportHtml().then(()=>window.__ex='done'); return 1" | Out-Null
$ok = Save-DialogMsg $script:proc.Id "$work\via-menu.html"
for ($i = 0; $i -lt 30 -and (J "return window.__ex") -ne 'done'; $i++) { Start-Sleep -Milliseconds 300 }
$txt = if (Test-Path "$work\via-menu.html") { [IO.File]::ReadAllText("$work\via-menu.html") } else { '' }
T 'File > Export as HTML (with the save dialog) writes the file' "dialog=$ok len=$($txt.Length)" ($ok -and $txt -like '*Report Title*')

# Ctrl+P: the print preview opens (its own page, edge://print); its Cancel button closes it.
function CdpOnce([string]$wsUrl, [string]$method, $params) {
    $ws2 = New-Object System.Net.WebSockets.ClientWebSocket
    $ws2.ConnectAsync([Uri]$wsUrl, [Threading.CancellationToken]::None).Wait()
    $msg = @{ id = 1; method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
    $ws2.SendAsync([ArraySegment[byte]][Text.Encoding]::UTF8.GetBytes($msg), 'Text', $true, [Threading.CancellationToken]::None).Wait()
    $buf = New-Object byte[] 65536
    $t = $ws2.ReceiveAsync([ArraySegment[byte]]$buf, [Threading.CancellationToken]::None); $t.Wait(3000) | Out-Null
    $ws2.Dispose()
}
J "setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true })), 100); return 1" | Out-Null
$pt = $null
for ($i = 0; $i -lt 50 -and -not $pt; $i++) { Start-Sleep -Milliseconds 400; $pt = (Invoke-RestMethod "http://127.0.0.1:9333/json") | Where-Object { $_.url -like 'edge://print*' -or $_.url -like 'chrome://print*' } | Select-Object -First 1 }
if ($pt) {
    Start-Sleep -Milliseconds 1500
    # Click the preview's own Cancel button, as a user would.
    $js = "(()=>{ const all=[]; const walk=(r)=>r.querySelectorAll('*').forEach(el=>{ all.push(el); if (el.shadowRoot) walk(el.shadowRoot); }); walk(document); const c = all.find(b => /BUTTON/.test(b.tagName) && (b.textContent||'').trim()==='Cancel'); if (c) { c.click(); return 'clicked'; } return 'none'; })()"
    # The preview's buttons appear a moment after the page: keep clicking Cancel until it has closed.
    for ($i = 0; $i -lt 30; $i++) {
        $open = (Invoke-RestMethod "http://127.0.0.1:9333/json") | Where-Object { $_.url -like 'edge://print*' } | Select-Object -First 1
        if (-not $open) { break }
        try { CdpOnce $open.webSocketDebuggerUrl 'Runtime.evaluate' @{ expression = $js; returnByValue = $true } } catch {}
        Start-Sleep -Milliseconds 700
    }
}
$still = [bool]((Invoke-RestMethod "http://127.0.0.1:9333/json") | Where-Object { $_.url -like '*://print*' })
$r = if ($still) { 'preview still open' } else { J "await new Promise(r=>setTimeout(r,700)); return JSON.stringify([document.body.classList.contains('printing'), (document.getElementById('print-root')||{}).innerHTML === ''])" }
T 'Ctrl+P opens the print preview; Esc closes it and the app is back' "preview=$([bool]$pt) after=$r" ($pt -and $r -eq '[false,true]')

# ---------- large files ----------
$big = "$work\big.log"
$line = '2024-10-14 14:30:05,431 INFO  Some fairly typical log line with a few words in it and an id 1234567890'
$sb = New-Object Text.StringBuilder
for ($i = 0; $i -lt 260000; $i++) { [void]$sb.Append($line).Append("`n") }
Write-NoBom $big $sb.ToString()
$mb = [math]::Round((Get-Item $big).Length / 1MB, 1)
$r = J "const t=performance.now(); await openPath('$w\\big.log'); const ms=Math.round(performance.now()-t); const d=getActive(); return JSON.stringify([d.layoutMode, editor.classList.contains('hl-active'), ms])"
$o = $r | ConvertFrom-Json
T "A $mb MB log opens (Edit Only, no colouring)" $r ($o[0] -eq 'edit-only' -and $o[1] -eq $false -and $o[2] -lt 15000)
# Most of a key's time in a file this big is the browser's own text box, which varies a lot between
# PCs and runs. So this checks what the app controls: its own work per key, against the bare text
# box measured in the same run (median of 7 keys each), plus a generous absolute ceiling.
$r = J "editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); const med = () => { const a = []; for (let i = 0; i < 7; i++) { const t = performance.now(); document.execCommand('insertText', false, 'x'); a.push(performance.now() - t); } a.sort((x, y) => x - y); return a[3]; }; med(); const app = med(); editor.removeEventListener('input', syncFromEditor); const bare = med(); editor.addEventListener('input', syncFromEditor); syncFromEditor(); return JSON.stringify([Math.round(app), Math.round(bare)])"
$o = $r | ConvertFrom-Json
T 'Typing in the large file: app work per key is small next to the text box itself ([app, bare] ms)' $r ($o[0] -le $o[1] * 1.3 + 15 -and $o[0] -lt 1500)
$r = J "const t=performance.now(); openFindBar(); findInput.value='id 1234567890'; await refreshFind(false); await new Promise(r=>setTimeout(r,300)); return Math.round(performance.now()-t)"
T 'Find in the large file works' $r ([int]$r -lt 15000)
J "closeFindBar(); window.__askAnswer=false; await closeTab(getActive().id); window.__askAnswer=true; return 1" | Out-Null
$huge = "$work\huge.log"
$fs = [IO.File]::Create($huge); $fs.SetLength(101MB); $fs.Close()
$r = J "window.__msgs=[]; const d = await openPath('$w\\huge.log'); return JSON.stringify([!!d, (window.__msgs[0]||'').includes('100 MB')])"
T 'Files over 100 MB are refused with a clear message' $r ($r -eq '[false,true]')
Remove-Item $huge

# ---------- outline ----------
Write-NoBom "$work\outline.md" "# Top`n`nintro`n`n## Part A`n`ntext`n`n``````md`n# not a heading (in code)`n```````n`nSetext Title`n------------`n`n### Deep **Bold** item`n`n## Part B`n"
J "await openPath('$w\\outline.md'); setLayoutMode('preview-only'); return 1" | Out-Null
K 'CTRL+SHIFT' 'O' 'KeyO' 0x4F
$r = J "return JSON.stringify([settings.outline, !document.getElementById('outline').classList.contains('hidden'), [...document.querySelectorAll('.outline-item')].map(b=>b.className.replace('outline-item ','').replace(' active','')+':'+b.textContent)])"
T 'Ctrl+Shift+O shows the outline with every heading (not ones in code)' $r ($r -eq '[true,true,["lvl-1:Top","lvl-2:Part A","lvl-2:Setext Title","lvl-3:Deep Bold item","lvl-2:Part B"]]')
$r = J "for (let i=0;i<40;i++) { editor.value += '\n\nfiller paragraph ' + i; } editor.dispatchEvent(new Event('input')); getActive().content += ''; return 1"
J "editor.value = editor.value + '\n\n## Part C\n\nend'; editor.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,400)); return 1" | Out-Null
$r = J "const items=[...document.querySelectorAll('.outline-item')]; const last=items[items.length-1]; last.click(); await new Promise(r=>setTimeout(r,200)); const h=[...preview.querySelectorAll('h2')].pop(); const off=Math.round(h.getBoundingClientRect().top - preview.getBoundingClientRect().top); await new Promise(r=>setTimeout(r,700)); return JSON.stringify([last.textContent, off >= 0 && off < preview.clientHeight - 20 && preview.scrollTop > 0, last.classList.contains('active')])"
T 'Outline updates as you type, and clicking a heading scrolls to it' $r ($r -eq '["Part C",true,true]')
$r = J "setLayoutMode('edit-only'); document.querySelectorAll('.outline-item')[1].click(); await new Promise(r=>setTimeout(r,100)); const c=lineIndex(getActive()); return JSON.stringify([lineOf(c, editor.selectionStart)+1, document.activeElement===editor])"
T 'In the editor, clicking a heading puts the caret on its line' $r ($r -eq '[5,true]')
$r = J "return JSON.stringify(currentMenuChecks().outline)"
T 'View > Outline shows a tick' $r ($r -eq 'true')

# ---------- auto-pairing ----------
J "addDocAndActivate(newUntitledDoc()); setLayoutMode('edit-only'); editor.focus(); return 1" | Out-Null
TypeText '('
$r = J "return JSON.stringify([editor.value, editor.selectionStart])"
T 'Typing ( adds ) after the caret' $r ($r -eq '["()",1]')
TypeText 'a)'
$r = J "return JSON.stringify([editor.value, editor.selectionStart])"
T 'Typing ) steps over the added one' $r ($r -eq '["(a)",3]')
TypeText ' ['
K '' 'Backspace' 'Backspace' 0x08
$r = J "return JSON.stringify([editor.value, editor.selectionStart])"
T 'Backspace in an empty pair removes both' $r ($r -eq '["(a) ",4]')
TypeText "don't "
$r = J "return editor.value"
T "An apostrophe (don't) is not paired" $r ($r -eq "(a) don't ")
TypeText '"'
$r = J "return JSON.stringify([editor.value, editor.selectionStart])"
T 'A quote at the start of a word is paired' $r ($r -eq "[`"(a) don't \`"\`"`",11]")
J "editor.value='wrap me'; editor.dispatchEvent(new Event('input')); editor.setSelectionRange(0,4); return 1" | Out-Null
TypeText '['
$r = J "return JSON.stringify([editor.value, editor.value.slice(editor.selectionStart, editor.selectionEnd)])"
T 'Typing [ with text selected wraps it' $r ($r -eq '["[wrap] me","wrap"]')
K 'CTRL' 'z' 'KeyZ' 0x5A
$r = J "return editor.value"
T 'Ctrl+Z undoes the wrap in one step' $r ($r -eq 'wrap me')
J "changeSetting('autoPair', false); editor.value=''; editor.dispatchEvent(new Event('input')); return 1" | Out-Null
TypeText '('
$r = J "const v=editor.value; changeSetting('autoPair', true); return v"
T 'Settings: auto-close can be turned off' $r ($r -eq '(')

# ---------- Ctrl+B / Ctrl+I ----------
J "editor.value='make this bold'; editor.dispatchEvent(new Event('input')); editor.focus(); editor.setSelectionRange(10,14); return 1" | Out-Null
K 'CTRL' 'b' 'KeyB' 0x42
$r = J "return JSON.stringify([editor.value, editor.value.slice(editor.selectionStart, editor.selectionEnd)])"
T 'Ctrl+B in the editor makes the selection **bold**' $r ($r -eq '["make this **bold**","bold"]')
K 'CTRL' 'b' 'KeyB' 0x42
$r = J "return editor.value"
T 'Ctrl+B again removes it' $r ($r -eq 'make this bold')
K 'CTRL' 'i' 'KeyI' 0x49
$r = J "return editor.value"
T 'Ctrl+I makes it _italic_' $r ($r -eq 'make this _bold_')
J "setDocLanguage('bbcode'); setLayoutMode('edit-only'); editor.value='bb text'; editor.dispatchEvent(new Event('input')); editor.focus(); editor.setSelectionRange(3,7); return 1" | Out-Null
K 'CTRL' 'b' 'KeyB' 0x42
$r = J "return editor.value"
T 'Ctrl+B in a BBCode tab uses [b]...[/b]' $r ($r -eq 'bb [b]text[/b]')
J "setDocLanguage('json'); editor.value='[1, 2]'; editor.dispatchEvent(new Event('input')); editor.focus(); editor.setSelectionRange(1,4); return 1" | Out-Null
K 'CTRL' 'b' 'KeyB' 0x42
$r = J "return editor.value"
T 'Ctrl+B does nothing in a code file' $r ($r -eq '[1, 2]')
J "setDocLanguage('markdown'); setLayoutMode('preview-only'); editor.value='preview words here'; getActive().content=editor.value; editor.dispatchEvent(new Event('input')); renderPreview(getActive()); preview.focus(); const t=preview.querySelector('p').firstChild; const r=document.createRange(); r.setStart(t,8); r.setEnd(t,13); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return 1" | Out-Null
K 'CTRL' 'b' 'KeyB' 0x42
$r = J "return getActive().content.trim()"
T 'Ctrl+B in the preview makes the Markdown bold' $r ($r -eq 'preview **words** here')

# ---------- Advanced pane: Ctrl+Shift+B ----------
J "setLayoutMode('edit-only'); editor.value='alpha\nbeta\ngamma'; editor.dispatchEvent(new Event('input')); getActive().bookmarks={}; openFindBar(true); findInput.value=''; advFrom.value=''; advTo.value=''; advHide.value=''; refreshFind(false); for (let i=0;i<20 && findState.rows.length<3;i++) await new Promise(r=>setTimeout(r,150)); selectOnly(1); advBody.focus(); return 1" | Out-Null
K 'CTRL' 'b' 'KeyB' 0x42
$r1 = J "return JSON.stringify(getActive().bookmarks)"
K 'CTRL+SHIFT' 'B' 'KeyB' 0x42
$r2 = J "return JSON.stringify(getActive().bookmarks)"
K 'CTRL+SHIFT' 'B' 'KeyB' 0x42
$r3 = J "return JSON.stringify(getActive().bookmarks)"
T 'Advanced pane: Ctrl+Shift+B toggles a bookmark (Ctrl+B no longer does)' "$r1 / $r2 / $r3" ($r1 -eq '{}' -and $r2 -eq '{"1":"Green"}' -and $r3 -eq '{}')
J "closeFindBar(); return 1" | Out-Null

# ---------- remembered across a restart ----------
J "setActiveTab(docs.find(d=>d.path && d.path.endsWith('app.log')).id); getActive().follow=true; updateFollowStatus(); for (const d of docs.filter(d=>d.dirty)) { d.savedContent=d.content; d.dirty=false; } await saveSessionNow(); return 1" | Out-Null
Stop-App
Start-Sleep -Milliseconds 800
Start-App $Exe $null -KeepSession
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null
Start-Sleep -Milliseconds 600
$r = J "const d=docs.find(d=>d.path && d.path.endsWith('app.log')); return JSON.stringify([!!(d && d.follow), settings.outline, recentFiles.length >= 5])"
T 'Follow, Outline and Recent Files survive a restart' $r ($r -eq '[true,true,true]')
Start-Sleep -Milliseconds 300
$m = [MenuRead]::Recent((Get-Process -Id $script:proc.Id).MainWindowHandle)
T 'Recent Files menu is filled again after a restart' $m ($m -like '&1 *')
$file = [MenuRead]::Items([MenuRead]::GetSubMenu([MenuRead]::GetMenu((Get-Process -Id $script:proc.Id).MainWindowHandle), 0))
T 'File menu has the new items' $file ($file -like 'New*|Open...*|Recent Files|Reopen Closed Tab*|Reload from Disk|*Save All*|*Print...*|Export as PDF...|Export as HTML...|*')
$edit = [MenuRead]::Items([MenuRead]::GetSubMenu([MenuRead]::GetMenu((Get-Process -Id $script:proc.Id).MainWindowHandle), 1))
T 'Edit menu has Go to Line, Bold, Italic' $edit ($edit -like '*Go to Line...*Bold*Italic*')
Stop-App
$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
