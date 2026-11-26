param([string]$Exe, [string]$RealLog)
# Line numbers in very big wrapped files (no coloured layer), link colours (dark mode, visited, cleared
# with Recent Files), Shift+click ranges in the bookmark margin, softer bookmark colours, and the
# Yes / No / Cancel save prompt.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }

# A 6 MB log: short lines, long wrapped ones (stack traces, data), tabs and control characters.
$work = "$sp\work141"; New-Item -ItemType Directory $work -Force | Out-Null
$sb = New-Object Text.StringBuilder
$i = 0
$stx = [char]2; $etx = [char]3
while ($sb.Length -lt 6MB) {
    [void]$sb.Append("2026-11-17 20:19:$('{0:00}' -f ($i % 60)),782 [34] DEBUG Nox.ScoringEngine.Scorings - Auto-saving scoring line $i`r`n")
    if ($i % 7 -eq 0) { [void]$sb.Append("   at Nox.DerivedSignals.StandardDerivedSignals.RespRateSignal.$stx(Period $stx, ISession $etx) in a very long frame description that wraps " + ('x' * 180) + " end $i`r`n") }
    if ($i % 11 -eq 0) { [void]$sb.Append("`tdata=" + ('ABCDEFGHIJ' * 40) + "`r`n") }
    $i++
}
[IO.File]::WriteAllText("$work\big.log.1", $sb.ToString(), (New-Object Text.UTF8Encoding $true))
$w = $work.Replace('\', '/')

Start-App $Exe $null
Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1100; height = 720; deviceScaleFactor = 1; mobile = $false } | Out-Null
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null

# Where a line really starts in the textarea: measured with a copy of the editor's text layout.
$measure = @'
async function realY(lineNo) {
  const cs = getComputedStyle(edTextEl());
  const m = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingLeft', 'paddingRight', 'paddingTop', 'boxSizing', 'whiteSpace', 'overflowWrap', 'wordBreak']) m.style[p] = cs[p];
  m.style.width = editor.clientWidth + 'px';
  m.style.position = 'absolute'; m.style.left = '-99999px'; m.style.top = '0'; m.style.whiteSpace = settings.wordWrap ? 'pre-wrap' : 'pre';
  const v = editor.value; let pos = 0;
  for (let k = 0; k < lineNo; k++) pos = v.indexOf('\n', pos) + 1;
  m.textContent = v.slice(0, pos);
  const mark = document.createElement('span'); mark.textContent = '​'; m.appendChild(mark);
  document.body.appendChild(m);
  const y = mark.offsetTop; m.remove();
  return { y, pos };
}
'@
function CheckLine([int]$lineNo) {
    J "$measure if (editor.isCodeMirror) { const c = lineIndex(getActive()); const pos = c.starts[$lineNo]; revealRange(getActive(), pos, pos, true); await new Promise(res => setTimeout(res, 300)); const g = edGutterRow($lineNo); if (!g) return 'no row'; return JSON.stringify([Number(g.number.textContent), Math.round(g.number.getBoundingClientRect().top - editor.api.rectAt(pos).top)]); } const r = await realY($lineNo); revealRange(getActive(), r.pos, r.pos, true); await new Promise(res => setTimeout(res, 300)); renderGutter(); const row = lineNumbersEl.querySelector('.ln-row[data-l=`"$lineNo`"]'); if (!row) return 'no row'; const gutterY = row.getBoundingClientRect().top - lineNumbersEl.getBoundingClientRect().top + editor.scrollTop; const shown = Number(row.querySelector('.ln-n').textContent); return JSON.stringify([shown, Math.round(gutterY - r.y)])"
}
$r = J "const d = await openPath('$w/big.log.1'); setDocLanguage('plaintext'); setLayoutMode('edit-only'); if (!lineNumbersVisible) toggleLineNumbers(); changeSetting('wordWrap', true); await new Promise(r => setTimeout(r, 800)); return JSON.stringify([d.content.length > 5e6, editorHighlight.classList.contains('hidden') || editorHighlight.children.length === 0])"
T 'A 6 MB log opens without the coloured layer (too big for it)' $r ($r -eq '[true,true]')
foreach ($n in 40, 3513, 25000) {
    $r = CheckLine $n
    $o = $r | ConvertFrom-Json
    T "Word wrap on: line number $($n + 1) sits beside its line (number, pixels off)" $r ($o[0] -eq $n + 1 -and [Math]::Abs($o[1]) -le 21)
}
$r = J "changeSetting('wordWrap', false); await new Promise(r => setTimeout(r, 300)); return 1"
$r = CheckLine 25000
$o = $r | ConvertFrom-Json
T 'Word wrap off: line number 25001 sits beside its line' $r ($o[0] -eq 25001 -and [Math]::Abs($o[1]) -le 21)
J "changeSetting('wordWrap', true); const d = getActive(); d.content = d.savedContent; d.dirty = false; await closeTab(d.id); return 1" | Out-Null

if ($RealLog -and (Test-Path $RealLog)) {
    Copy-Item $RealLog "$work\real.log.1" -Force
    J "const d = await openPath('$w/real.log.1'); setDocLanguage('plaintext'); setLayoutMode('edit-only'); await new Promise(r => setTimeout(r, 800)); return 1" | Out-Null
    $line = [int](J "const v = editor.value; const p = v.indexOf('20:24:16,482 [Main Thread] INFO'); return v.slice(0, p).split('\n').length - 1")
    $r = CheckLine $line
    T "Your log: the line 'Video stopped' is numbered $($line + 1) (Notepad++ says 3514) and sits beside it" $r ((($r | ConvertFrom-Json)[0] -eq 3514))
    J "const d = getActive(); d.content = d.savedContent; d.dirty = false; await closeTab(d.id); return 1" | Out-Null
}

# --- links: dark mode colour, visited links, Clear Recent Files ---
$r = J "addDocAndActivate(newUntitledDoc()); setLayoutMode('preview-only'); setDocLanguage('markdown'); editor.value = '[one](https://example.com/one) and [two](https://example.com/two)'; syncFromEditor(); renderPreview(getActive()); const old = document.documentElement.getAttribute('data-theme'); document.documentElement.setAttribute('data-theme', 'dark'); const a = preview.querySelectorAll('a'); const dark = getComputedStyle(a[0]).color; noteVisitedLink('https://example.com/one'); const vis = getComputedStyle(a[0]).color; const unv = getComputedStyle(a[1]).color; document.documentElement.setAttribute('data-theme', 'light'); const visLight = getComputedStyle(a[0]).color; document.documentElement.setAttribute('data-theme', old); return JSON.stringify([dark, vis, unv, visLight])"
T 'Dark mode: links #4ea1ff, visited #a78ae1 (light mode visited: a darker purple)' $r ($r -eq '["rgb(78, 161, 255)","rgb(167, 138, 225)","rgb(78, 161, 255)","rgb(123, 82, 201)"]')
$r = J "window.__opened = null; const realOpen = invoke; openUrl = (u) => { noteVisitedLink(u); window.__opened = u; }; const a = preview.querySelectorAll('a')[1]; a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise(r => setTimeout(r, 500)); document.querySelector('.link-pop [data-act=open]').click(); return JSON.stringify([window.__opened, a.classList.contains('np-visited')])"
T 'Opening a link (from the hover box) marks it visited' $r ($r -eq '["https://example.com/two",true]')
$r = J "await saveSessionNow(); return 1"
Stop-App
Start-App $Exe $null -KeepSession
$r = J "const d = docs.find(x => x.content.includes('example.com/one')); setActiveTab(d.id); setLayoutMode('preview-only'); renderPreview(d); await new Promise(r => setTimeout(r, 200)); const a = [...preview.querySelectorAll('a')].map(x => x.classList.contains('np-visited')); clearRecent(); const b = [...preview.querySelectorAll('a')].map(x => x.classList.contains('np-visited')); return JSON.stringify([a, b, visitedLinks.size])"
T 'Visited links are remembered after a restart; Clear Recent Files clears them' $r ($r -eq '[[true,true],[false,false],0]')

# --- Shift+click in the bookmark margin ---
Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1100; height = 720; deviceScaleFactor = 1; mobile = $false } | Out-Null
function MarginClick([int]$line, [int]$mods = 0) {
    $p = (J "return JSON.stringify(edGutterPoint($line, 'margin'))") | ConvertFrom-Json
    Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $p.x; y = $p.y; button = 'left'; buttons = 1; clickCount = 1; modifiers = $mods } | Out-Null
    Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $p.x; y = $p.y; button = 'left'; buttons = 0; clickCount = 1; modifiers = $mods } | Out-Null
    Start-Sleep -Milliseconds 150
}
J "addDocAndActivate(newUntitledDoc()); setLayoutMode('edit-only'); if (!lineNumbersVisible) toggleLineNumbers(); editor.value = Array.from({length: 12}, (_, i) => 'line ' + (i + 1)).join('\n'); syncFromEditor(); setBookmarkColour('Orange'); await new Promise(r => setTimeout(r, 300)); return 1" | Out-Null
MarginClick 2
MarginClick 6 8
$r = J "return JSON.stringify(getActive().bookmarks)"
T 'Click line 3, Shift+click line 7: lines 3-7 bookmarked in the current colour' $r ($r -eq '{"2":"Orange","3":"Orange","4":"Orange","5":"Orange","6":"Orange"}')
MarginClick 4
MarginClick 6 8
$r = J "return JSON.stringify(getActive().bookmarks)"
T 'Click a dot (removes it), Shift+click further down: the range loses its bookmarks too' $r ($r -eq '{"2":"Orange","3":"Orange"}')
$r = J "const s = getComputedStyle(document.documentElement); return [s.getPropertyValue('--bm-red-bg'), s.getPropertyValue('--bm-orange-bg'), s.getPropertyValue('--bm-green-bg')].map(x => x.trim()).join(',')"
T 'Bookmark tints are lighter than before' $r ($r -ne '#fbdde0,#fde6cc,#d4f0e0' -and $r -ne '#7a1e27,#70400d,#145b35')

# --- the save prompt: Yes / No / Cancel ---
$r = J "const d = getActive(); d.dirty = true; const box = document.getElementById('save-ask'); let p = closeTab(d.id); await new Promise(r => setTimeout(r, 100)); const shown = !box.classList.contains('hidden'); const buttons = [...box.querySelectorAll('button')].map(b => b.textContent); const focused = document.activeElement.id; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await p; const kept = docs.includes(d); p = closeTab(d.id); await new Promise(r => setTimeout(r, 100)); document.getElementById('save-ask-no').click(); await p; return JSON.stringify([shown, buttons, focused, kept, docs.includes(d), box.classList.contains('hidden')])"
T 'Closing an unsaved tab asks Yes / No / Cancel (Yes ready for Enter); Esc = Cancel keeps it, No closes it' $r ($r -eq '[true,["Yes","No","Cancel"],"save-ask-yes",true,false,true]')
Stop-App

$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
