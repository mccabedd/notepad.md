param([string]$Exe)
# Big files are coloured in the editor too (in the background, once typing pauses).
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
function Write-NoBom([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }
$work = "$sp\work15"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
$lines = @('20210422T052446 sys:info    Logger : Started.', '20210422T052446 sys:debug   Forced RTC watchdog', '20210422T052447 sys:warning Field calibration checksum incorrect', '20210422T052450 sys:info    SETUP.INI Hash=00000000', '20210422T052448  fs:info    Factory reset successful', '')
$sb = New-Object Text.StringBuilder
for ($i = 0; $i -lt 68000; $i++) { [void]$sb.Append($lines[$i % 6]).Append("`n") }
Write-NoBom "$work\LOG.TXT" $sb.ToString()
$sb2 = New-Object Text.StringBuilder
for ($i = 0; $i -lt 190000; $i++) { [void]$sb2.Append($lines[$i % 6]).Append("`n") }
Write-NoBom "$work\big9\LOG.TXT" '' 2>$null
New-Item -ItemType Directory "$work\big9" -Force | Out-Null
Write-NoBom "$work\big9\LOG.TXT" $sb2.ToString()
Write-NoBom "$work\small.json" '{ "a": [1, 2, 3] }'
$w = $work.Replace('\', '/')

Start-App $Exe $null
$r = J "const d = await openPath('$w/LOG.TXT'); setLayoutMode('split-ep'); return JSON.stringify([d.lang, editor.value.length])"
T 'A 3.2 MB LOG.TXT opens as a Log File' $r ($r -like '["log",3*')
if (IsCM) {
# CodeMirror draws only the lines in view, so "coloured" means the lines on screen are coloured.
$q = "const q = (c) => edLayer().querySelectorAll('.hljs-' + c).length;"
$r = J "window.__gap=0; let last=performance.now(); window.__iv=setInterval(()=>{const n=performance.now(); window.__gap=Math.max(window.__gap, n-last-50); last=n;},50); $q for (let i=0;i<80 && !q('loginfo');i++) await new Promise(r=>setTimeout(r,100)); await new Promise(r=>setTimeout(r,200)); clearInterval(window.__iv); return JSON.stringify([q('loginfo') > 0, q('logwarn') > 0, Math.round(window.__gap), !!hlWorker])"
$o = $r | ConvertFrom-Json
T 'The editor is coloured (info blue, warnings amber... on the lines in view)' $r ($o[0] -and $o[1])
T 'Colouring runs in a background worker (worst pause ms reported)' $r ($o[3] -and $o[2] -lt 6000)
$r = J "editor.scrollTop = 200000; await new Promise(r=>setTimeout(r,300)); $q return JSON.stringify([editor.scrollTop > 0, q('loginfo') > 0, getComputedStyle(edLayer().querySelector('.hljs-logwarn')).fontWeight])"
T 'Scrolled far down, the lines there are coloured too (normal weight)' $r ($r -eq '[true,true,"400"]')
J "editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); return 1" | Out-Null
Cdp 'Input.insertText' @{ text = '20210422T999999 sys:error   Typed by the test' } | Out-Null
$r = J "let last = null; for (let i=0;i<80;i++) { last=[...edLayer().querySelectorAll('.hljs-logerror')].pop(); if (last && edLayer().textContent.includes('Typed by the test')) break; await new Promise(r=>setTimeout(r,100)); } return JSON.stringify([editor.value.endsWith('Typed by the test'), edLayer().textContent.includes('Typed by the test'), last && last.textContent])"
T 'A moment after typing stops the new line is coloured too' $r ($r -eq '[true,true,"error"]')
$r = J "for (let i=0;i<40 && !preview.textContent.includes('Typed by the test');i++) await new Promise(r=>setTimeout(r,100)); return preview.textContent.includes('Typed by the test')"
T 'The preview catches up after a pause' $r ($r -eq $true)
$r = J "const big=getActive(); await openPath('$w/small.json'); await new Promise(r=>setTimeout(r,200)); const t=performance.now(); setActiveTab(big.id); const ms=Math.round(performance.now()-t); $q for (let i=0;i<60 && !q('loginfo');i++) await new Promise(r=>setTimeout(r,100)); return JSON.stringify([q('loginfo') > 0, ms])"
$o = $r | ConvertFrom-Json
T 'Switching back to the big tab shows it coloured (switch ms reported)' $r ($o[0])
$r = J "setActiveTab(docs.find(d=>d.path && d.path.endsWith('small.json')).id); return JSON.stringify(!!edLayer().querySelector('.hljs-number'))"
T 'Small files are still coloured immediately' $r ($r -eq 'true')
$r = J "await openPath('$w/big9/LOG.TXT'); $q for (let i=0;i<100 && !q('loginfo');i++) await new Promise(r=>setTimeout(r,100)); return JSON.stringify([editor.value.length > 4194304, q('loginfo') > 0])"
T 'A 9 MB log is coloured too (CodeMirror draws only the lines in view)' $r ($r -eq '[true,true]')
} else {
# While it is being coloured, measure how long the page is blocked (a 50 ms timer's worst delay).
$r = J "window.__gap=0; let last=performance.now(); window.__iv=setInterval(()=>{const n=performance.now(); window.__gap=Math.max(window.__gap, n-last-50); last=n;},50); for (let i=0;i<80 && !(editor.isCodeMirror || editor.classList.contains('hl-active'));i++) await new Promise(r=>setTimeout(r,100)); await new Promise(r=>setTimeout(r,200)); clearInterval(window.__iv); return JSON.stringify([(editor.isCodeMirror || editor.classList.contains('hl-active')), !editorHighlight.classList.contains('hidden'), edLayer().querySelectorAll('.hljs-loginfo').length > 1000, edLayer().querySelectorAll('.hljs-logwarn').length > 1000, Math.round(window.__gap), !!hlWorker])"
$o = $r | ConvertFrom-Json
T 'The editor is coloured (info blue, warnings amber...)' $r ($o[0] -and $o[1] -and $o[2] -and $o[3])
T 'Colouring runs in a background worker (worst pause ms reported)' $r ($o[5] -and $o[4] -lt 6000)
$r = J "return JSON.stringify([editorHighlight.textContent.replace(/ $/,'') === editor.value, getComputedStyle(edLayer().querySelector('.hljs-logwarn')).fontWeight])"
T 'Coloured layer matches the text exactly (so it lines up)' $r ($r -eq '[true,"400"]')
$r = J "editor.scrollTop = 200000; editor.dispatchEvent(new Event('scroll')); await new Promise(r=>setTimeout(r,100)); return JSON.stringify([editor.scrollTop > 0, Math.abs(editor.scrollTop - editorHighlight.scrollTop) < 2])"
T 'Scrolling keeps the coloured layer in step' $r ($r -eq '[true,true]')

# Typing: plain while typing, coloured again after a pause, preview catches up
J "editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); return 1" | Out-Null
Cdp 'Input.insertText' @{ text = '20210422T999999 sys:error   Typed by the test' } | Out-Null
$r = J "return JSON.stringify([editor.value.endsWith('Typed by the test'), (editor.isCodeMirror || editor.classList.contains('hl-active'))])"
T 'While typing the text shows plainly (no stale colours)' $r ($r -eq '[true,false]')
$r = J "for (let i=0;i<80 && !(editor.isCodeMirror || editor.classList.contains('hl-active'));i++) await new Promise(r=>setTimeout(r,100)); const last=[...edLayer().querySelectorAll('.hljs-logerror')].pop(); return JSON.stringify([(editor.isCodeMirror || editor.classList.contains('hl-active')), editorHighlight.textContent.includes('Typed by the test'), last && last.textContent])"
T 'A moment after typing stops it is coloured again, including the new line' $r ($r -eq '[true,true,"error"]')
$r = J "for (let i=0;i<40 && !preview.textContent.includes('Typed by the test');i++) await new Promise(r=>setTimeout(r,100)); return preview.textContent.includes('Typed by the test')"
T 'The preview catches up after a pause' $r ($r -eq $true)

# Tab switch uses the remembered colours
$r = J "const big=getActive(); await openPath('$w/small.json'); await new Promise(r=>setTimeout(r,200)); const t=performance.now(); setActiveTab(big.id); const ms=Math.round(performance.now()-t); for (let i=0;i<30 && !(editor.isCodeMirror || editor.classList.contains('hl-active'));i++) await new Promise(r=>setTimeout(r,100)); return JSON.stringify([(editor.isCodeMirror || editor.classList.contains('hl-active')), edLayer().querySelectorAll('.hljs-loginfo').length > 1000, ms])"
$o = $r | ConvertFrom-Json
T 'Switching back to the big tab reuses its colours (no recolouring)' $r ($o[0] -and $o[1])
$r = J "setActiveTab(docs.find(d=>d.path && d.path.endsWith('small.json')).id); return JSON.stringify([(editor.isCodeMirror || editor.classList.contains('hl-active')), !!edLayer().querySelector('.hljs-number')])"
T 'Small files are still coloured immediately' $r ($r -eq '[true,true]')

# Over 8 MB: plain text (the browser can't keep up)
$r = J "await openPath('$w/big9/LOG.TXT'); await new Promise(r=>setTimeout(r,2500)); return JSON.stringify([editor.value.length > 4194304, (editor.isCodeMirror || editor.classList.contains('hl-active'))])"
T 'Over 4 MB the editor stays plain text' $r ($r -eq '[true,false]')
}
Stop-App
$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
