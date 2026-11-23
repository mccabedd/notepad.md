param([string]$Exe)
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
. "$PSScriptRoot\cdpkeys.ps1"

$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) {
    [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" })
}
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message + ' @ ' + (e.stack||'').split('\n')[1]; } })()" }
function Shot([string]$name) {
    $r = Cdp 'Page.captureScreenshot' @{ format = 'png' }
    [IO.File]::WriteAllBytes("$sp\r6-$name.png", [Convert]::FromBase64String($r.result.data))
}
function Mouse([string]$type, [double]$x, [double]$y) {
    $btns = 1; if ($type -eq 'mouseReleased') { $btns = 0 }
    Cdp 'Input.dispatchMouseEvent' @{ type = $type; x = $x; y = $y; button = 'left'; buttons = $btns; clickCount = 1 } | Out-Null
}
function Titles { J "return docs.map(d=>tabTitle(d)).join(',')" }
function JsPath([string]$p) { $p.Replace('\', '\\') }

$W = "$sp\work6"; Remove-Item $W -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item "$PSScriptRoot\fixtures\samples" $W -Recurse
New-Item -ItemType Directory "$W\pics" | Out-Null
Copy-Item "$PSScriptRoot\fixtures\icon256.png" "$W\pics\my pic.png"

# ---------- empty untitled tabs survive a restart; numbers are reused ----------
Start-App $Exe $null
J "addDocAndActivate(newUntitledDoc()); addDocAndActivate(newUntitledDoc()); addDocAndActivate(newUntitledDoc()); return 1" | Out-Null
$r = Titles
T 'New tabs: Untitled, Untitled 2, 3, 4' $r ($r -eq 'Untitled,Untitled 2,Untitled 3,Untitled 4')
J "closeTab(docs[1].id); await new Promise(r=>setTimeout(r,200)); addDocAndActivate(newUntitledDoc()); return 1" | Out-Null
$r = Titles
T 'Closing Untitled 2 frees its number for the next new tab' $r ($r -eq 'Untitled,Untitled 3,Untitled 4,Untitled 2')
J "await saveSessionNow(); return 1" | Out-Null
Start-Sleep -Milliseconds 500
Stop-App
Start-App $Exe $null -KeepSession
$r = Titles
T 'Empty untitled tabs come back after a restart' $r ($r -eq 'Untitled,Untitled 3,Untitled 4,Untitled 2')
J "addDocAndActivate(newUntitledDoc()); return 1" | Out-Null
$r = Titles
T 'Next new tab after restart takes the lowest free number (5)' $r ($r -eq 'Untitled,Untitled 3,Untitled 4,Untitled 2,Untitled 5')
J "closeTab(docs[1].id); closeTab(docs[1].id); await new Promise(r=>setTimeout(r,200)); addDocAndActivate(newUntitledDoc()); return 1" | Out-Null
$r = Titles
T 'Gap after closing tabs is filled first' $r ($r -eq 'Untitled,Untitled 2,Untitled 5,Untitled 3')

# ---------- single instance ----------
$first = $script:proc.Id
$p2 = Start-Process $Exe -ArgumentList "`"$W\notes.md`"" -PassThru
$exited = $p2.WaitForExit(8000)
Start-Sleep -Milliseconds 800
$r = J "return tabTitle(getActive())"
$count = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($sp) -and $_.ProcessName -match "^(notepad-md|notepad.md|np[0-9]+)$" }).Count
T 'Second launch with a file: hands it over and exits' "exited=$exited active=$r processes=$count" ($exited -and $r -eq 'notes.md' -and $count -eq 1)
$p3 = Start-Process $Exe -ArgumentList 'data.json' -WorkingDirectory $W -PassThru
$exited3 = $p3.WaitForExit(8000)
Start-Sleep -Milliseconds 800
$r = J "return (getActive().path||'')"
T 'Relative path from another folder opens the right file' "exited=$exited3 $r" ($exited3 -and $r -like '*work6\data.json')
$p4 = Start-Process $Exe -PassThru
$exited4 = $p4.WaitForExit(8000)
$count = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($sp) -and $_.ProcessName -match "^(notepad-md|notepad.md|np[0-9]+)$" }).Count
T 'Second launch with no file just exits (one window)' "exited=$exited4 processes=$count" ($exited4 -and $count -eq 1)
$p5 = Start-Process $Exe -ArgumentList "`"$W\notes.md`"" -PassThru
$p5.WaitForExit(8000) | Out-Null
Start-Sleep -Milliseconds 600
$r = J "return docs.filter(d=>d.path && d.path.endsWith('notes.md')).length"
T 'Opening an already-open file again does not duplicate the tab' $r ($r -eq 1)
$inst = Get-Content "$env:NOTEPADMD_DATA_DIR\instance.json" -Raw | ConvertFrom-Json
T 'instance.json records the running process' "pid=$($inst.pid) port=$($inst.port)" ($inst.pid -eq $first -and $inst.port -gt 0)

# ---------- images ----------
$md = JsPath "$W\notes.md"
$pic = JsPath "$W\pics\my pic.png"
$apic = JsPath "$W\pics\a.png"
$r = J "await openPath('$md'); const d=getActive(); return imageRefFor('$pic', d) + '|' + imageRefFor('C:\\Other\\x y.png', d) + '|' + imageRefFor('$apic', {path:null})"
$expect = 'pics/my%20pic.png|C:/Other/x%20y.png|' + "$W\pics\a.png".Replace('\', '/').Replace(' ', '%20')
T 'Image path: relative to the document, %20 for spaces; absolute when unsaved' $r ($r -eq $expect)
$r = J "setLayoutMode('preview-only'); const d=getActive(); editor.value = '# Pics\n\n![my pic](pics/my%20pic.png)\n\n![web](https://example.invalid/x.png)\n'; syncFromEditor(); renderPreview(d); const img = preview.querySelector('img'); await new Promise(r => { if (img.complete && img.naturalWidth) r(); else { img.onload = r; img.onerror = r; setTimeout(r, 3000); } }); return img.getAttribute('data-md-src') + '|' + img.src.startsWith('http://localimg.localhost/') + '|' + img.naturalWidth + '|' + preview.querySelectorAll('img')[1].getAttribute('data-md-src');"
T 'Local image shows in the preview (served by the app)' $r ($r -eq 'pics/my%20pic.png|true|256|null')
Shot 'image'
$r = J "preview.querySelector('h1').textContent='Pictures'; syncFromPreview(); return getActive().content"
T 'Editing in the preview keeps the original image path' $r ($r.Contains('![my pic](pics/my%20pic.png)') -and $r.Contains('# Pictures') -and -not $r.Contains('localimg'))
$np = "$W\notes.md".Replace('\', '/')
$r = J "const i=new Image(); i.src=localImageUrl('$np'); await new Promise(r=>{i.onload=()=>r();i.onerror=()=>r()}); return i.naturalWidth"
T 'Non-image files are not served' $r ($r -eq 0)
$r = J "return !!document.querySelector('#toolbar [data-cmd=image]')"
T 'Toolbar has an Insert image button' $r ($r -eq $true)
J "setLayoutMode('edit-only'); lastFocused='editor'; editor.focus(); editor.selectionStart=editor.selectionEnd=0; document.querySelector('#toolbar [data-cmd=image]').click(); return 1" | Out-Null
$dlg = $false; for ($i = 0; $i -lt 20; $i++) { if (Has-Dialog) { $dlg = $true; break }; Start-Sleep -Milliseconds 250 }
Close-Dialogs | Out-Null
Start-Sleep -Milliseconds 500
$r = J "return getActive().content.startsWith('# Pictures')"
T 'Insert image opens a file picker (cancel inserts nothing)' "dialog=$dlg unchanged=$r" ($dlg -and $r -eq $true)

# ---------- drag tabs to reorder ----------
J "for (const d of docs) { d.savedContent = d.content; d.dirty = false; } docs = docs.slice(0,4); activeId = docs[0].id; renderTabs(); loadActiveDocIntoPanes(); return 1" | Out-Null
function TabBox([int]$i) {
    $r = J "const r=tabbarEl.querySelectorAll('.tab')[$i].getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2, r.left, r.right].join(',')"
    return @($r.Split(',') | ForEach-Object { [double]$_ })
}
$before = Titles
$a = TabBox 0; $c = TabBox 3
Mouse 'mousePressed' $a[0] $a[1]
Mouse 'mouseMoved' ($a[0] + 20) $a[1]
Mouse 'mouseMoved' ($c[3] - 3) $c[1]
$marker = J "return tabbarEl.querySelector('.drop-after,.drop-before') ? 'yes' : 'no'"
Mouse 'mouseReleased' ($c[3] - 3) $c[1]
Start-Sleep -Milliseconds 200
$after = Titles
$b = $before.Split(',')
$expect = @($b[1], $b[2], $b[3], $b[0]) -join ','
T 'Dragging the first tab to the end moves it there' "$before -> $after (marker $marker)" ($after -eq $expect -and $marker -eq 'yes')
$r = J "return tabTitle(getActive())"
T 'A drag does not count as a click (active tab unchanged)' $r ($r -eq $b[0])
$x = TabBox 0
Mouse 'mousePressed' $x[0] $x[1]
Mouse 'mouseReleased' ($x[0] + 2) $x[1]
Start-Sleep -Milliseconds 200
$r = J "return tabTitle(getActive())"
T 'A plain click still selects the tab' $r ($r -eq $b[1])
J "togglePin(docs[2].id); return 1" | Out-Null
$before = Titles
$p = TabBox 0; $u = TabBox 3
Mouse 'mousePressed' $u[0] $u[1]
Mouse 'mouseMoved' ($u[0] - 20) $u[1]
Mouse 'mouseMoved' ($p[2] + 2) $p[1]
Mouse 'mouseReleased' ($p[2] + 2) $p[1]
Start-Sleep -Milliseconds 200
$after = Titles
$bb = $before.Split(',')
$aa = $after.Split(',')
T 'Unpinned tab dropped on the pinned one lands just after it' "$before -> $after" ($aa[0] -eq $bb[0] -and $aa[1] -eq $bb[3])
J "await saveSessionNow(); return 1" | Out-Null
Start-Sleep -Milliseconds 400
Stop-App
Start-App $Exe $null -KeepSession
$r = Titles
T 'Tab order survives a restart' "$after -> $r" ($r -eq $after)
Shot 'tabs'
Stop-App

$results | Format-Table -AutoSize -Wrap | Out-String -Width 260
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
