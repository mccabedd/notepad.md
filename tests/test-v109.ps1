param([string]$Exe)
# v1.0.9: the [+] new-tab button, and separate default font sizes for the editor and the preview.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
$work = "$sp\work-v109"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
Copy-Item "$PSScriptRoot\fixtures\sample.md" "$work\sample.md"
$w = $work.Replace('\', '/')
function Click($x, $y, $count = 1) {
    Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y } | Out-Null
    for ($c = 1; $c -le $count; $c++) {
        Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; buttons = 1; clickCount = $c } | Out-Null
        Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; buttons = 0; clickCount = $c } | Out-Null
    }
    Start-Sleep -Milliseconds 300
}

Start-App $Exe $null
Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1000; height = 650; deviceScaleFactor = 1; mobile = $false } | Out-Null
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null

# ---------- [+] button ----------
$r = J "await openPath('$w/sample.md'); await new Promise(r=>setTimeout(r,300)); const b = document.getElementById('tab-new').getBoundingClientRect(); const tabs = [...document.querySelectorAll('.tab')]; const last = tabs[tabs.length-1].getBoundingClientRect(); return JSON.stringify({x: b.left + b.width/2, y: b.top + b.height/2, gap: Math.round(b.left - last.right), visible: b.width > 0 && b.height > 0, n: docs.length})"
$o = $r | ConvertFrom-Json
T '[+] button sits right after the last tab' $r ($o.visible -and $o.gap -ge 0 -and $o.gap -le 8)
Click $o.x $o.y
$r = J "return JSON.stringify([docs.length, !getActive().path, document.querySelector('.tab.active .tab-title').textContent])"
T 'Clicking [+] opens a new, active, untitled tab' $r ($r -like "[$($o.n + 1),true,*Untitled*")
# Fill the bar until the tabs overflow
J "for (let i=0;i<25;i++) addDocAndActivate(newUntitledDoc()); await new Promise(r=>setTimeout(r,500)); setActiveTab(docs[0].id); await new Promise(r=>setTimeout(r,500)); return 1" | Out-Null
$r = J "const b = document.getElementById('tab-new').getBoundingClientRect(); return JSON.stringify({x: b.left + b.width/2, y: b.top + b.height/2, inWindow: b.right <= window.innerWidth && b.left >= 0, arrows: !tabScrollEl.classList.contains('hidden'), overflow: tabbarEl.scrollWidth > tabbarEl.clientWidth, n: docs.length})"
$o = $r | ConvertFrom-Json
T 'With overflowing tabs, [+] stays visible beside the scroll arrows' $r ($o.inWindow -and $o.arrows -and $o.overflow)
Click $o.x $o.y
$r = J "await new Promise(r=>setTimeout(r,400)); const t = document.querySelector('.tab.active').getBoundingClientRect(); const bar = tabbarEl.getBoundingClientRect(); return JSON.stringify([docs.length, t.left >= bar.left - 1 && t.right <= bar.right + 1])"
T 'Clicking [+] with overflowing tabs adds a tab and scrolls it into view' $r ($r -eq "[$($o.n + 1),true]")
$r = J "for (const d of docs.filter(d=>!d.path)) await closeTab(d.id); await new Promise(r=>setTimeout(r,300)); const wrap = tabbarEl.parentElement.getBoundingClientRect(); const b = document.getElementById('tab-new').getBoundingClientRect(); return JSON.stringify({x: Math.round((b.right + wrap.right) / 2), y: Math.round(wrap.top + wrap.height/2), n: docs.length})"
$o = $r | ConvertFrom-Json
Click $o.x $o.y 2
$r = J "return String(docs.length)"
T 'Double-clicking the empty part of the tab bar still opens a new tab' $r ($r -eq "$($o.n + 1)")

# ---------- default font sizes ----------
$r = J "openSettings(); const e = settingsEl.querySelector('[data-s=editFontSize]'), p = settingsEl.querySelector('[data-s=previewFontSize]'); const old = settingsEl.querySelector('[data-s=newTabFontSize]'); const r = JSON.stringify([!!e, !!p, !old, e && e.value, p && p.value]); closeSettings(true); return r"
T 'Settings shows Editor and Preview font size (14 by default)' $r ($r -eq '[true,true,true,"14","14"]')
$r = J "setActiveTab(docs.find(d=>d.path).id); setLayoutMode('split-ep'); openSettings(); const e = settingsEl.querySelector('[data-s=editFontSize]'), p = settingsEl.querySelector('[data-s=previewFontSize]'); e.value = '12'; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); p.value = '16'; p.dispatchEvent(new Event('input', {bubbles:true})); p.dispatchEvent(new Event('change', {bubbles:true})); closeSettings(true); await new Promise(r=>setTimeout(r,300)); return JSON.stringify([settings.editFontSize, settings.previewFontSize, getComputedStyle(edTextEl()).fontSize, getComputedStyle(preview).fontSize, statusZoom.textContent])"
T 'Editor 12 px and preview 16 px apply at once (still 100%)' $r ($r -eq '[12,16,"12px","16px","100%"]')
$r = J "changeFontSize(2); await new Promise(r=>setTimeout(r,200)); const a = [getComputedStyle(edTextEl()).fontSize, getComputedStyle(preview).fontSize, statusZoom.textContent]; resetFontSize(); await new Promise(r=>setTimeout(r,200)); return JSON.stringify([...a, getComputedStyle(edTextEl()).fontSize, getComputedStyle(preview).fontSize, statusZoom.textContent])"
T 'Zooming a tab scales both sizes; Ctrl+0 goes back to the defaults' $r ($r -eq '["13.7px","18.3px","114%","12px","16px","100%"]')
if (IsCM) { 'SKIPPED in CodeMirror: about the old coloured layer' } else {
$r = J "changeFontSize(1); await new Promise(r=>setTimeout(r,500)); const ok = [editorHighlight.textContent.replace(/ `$/,'') === editor.value, editorHighlight.scrollHeight === editor.scrollHeight]; resetFontSize(); return JSON.stringify(ok)"
T 'Editor colour layer still lines up at a fractional size' $r ($r -eq '[true,true]')
}
$r = J "const s = {...settings}; loadSettings({ newTabFontSize: 12 }); const a = [settings.editFontSize, settings.previewFontSize]; loadSettings({ newTabFontSize: 12, editFontSize: 13, previewFontSize: 15 }); const b = [settings.editFontSize, settings.previewFontSize]; loadSettings({}); const c = [settings.editFontSize, settings.previewFontSize]; loadSettings(s); applySettings(); return JSON.stringify([a, b, c])"
T 'An older custom new-tab size carries over to both; new settings win' $r ($r -eq '[[12,12],[13,15],[14,14]]')
J "await saveSessionNow(); return 1" | Out-Null
Stop-App
Start-App $Exe $null -KeepSession
$r = J "await new Promise(r=>setTimeout(r,500)); return JSON.stringify([settings.editFontSize, settings.previewFontSize, getComputedStyle(edTextEl()).fontSize])"
T 'The font sizes survive a restart' $r ($r -eq '[12,16,"12px"]')
J "settings.editFontSize = 14; settings.previewFontSize = 14; applySettings(); await saveSessionNow(); return 1" | Out-Null
Stop-App

$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
