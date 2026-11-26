param([string]$Exe)
# Responsiveness/appearance pass: line-by-line colour layer, kept previews on tab switch,
# spelling suggestions, line-number width, find highlights in big files, Windows accent colour.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
$utf8 = New-Object Text.UTF8Encoding $false
$work = "$sp\work-polish"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
$readme = [IO.File]::ReadAllText("$PSScriptRoot\..\README.md")
$sb = New-Object Text.StringBuilder; while ($sb.Length -lt 100KB) { [void]$sb.Append($readme).Append("`n") }
[IO.File]::WriteAllText("$work\mid.md", $sb.ToString(), $utf8)
$lines = @('20261117T220541 sys:info    Battery voltage when entering sleep: 1390 mV', '20261118T075229 sys:info    Logger : Started.', '20261118T075229 sys:debug   Forced RTC watchdog', '20261118T075230 sys:warning Device powered up on USB', '')
$sb = New-Object Text.StringBuilder; for ($i = 0; $i -lt 24400; $i++) { [void]$sb.Append($lines[$i % 5]).Append("`n") }
[IO.File]::WriteAllText("$work\LOG.TXT", $sb.ToString(), $utf8)
$w = $work.Replace('\', '/')
$same = "(editor.isCodeMirror || editorHighlight.textContent.replace(/ `$/,'') === editor.value)"

Start-App $Exe $null
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null

# ---------- colour layer, line by line ----------
J "await openPath('$w/mid.md'); setLayoutMode('split-ep'); editor.focus(); editor.setSelectionRange(5000, 5000); await new Promise(r=>setTimeout(r,1200)); return 1" | Out-Null
if (IsCM) { 'SKIPPED in CodeMirror: about the old coloured layer' } else {
$r = J "return JSON.stringify([editorHighlight.children.length === editor.value.split('\n').length, $same])"
T 'Colour layer: one element per line, same text as the editor' $r ($r -eq '[true,true]')
}
foreach ($t in 'abc ', "`n", 'mispeled ', "`n`n") { Cdp 'Input.insertText' @{ text = $t } | Out-Null }
J "editor.setSelectionRange(100, 400); return 1" | Out-Null; Cdp 'Input.insertText' @{ text = 'X' } | Out-Null
J "editor.setSelectionRange(editor.value.length, editor.value.length); return 1" | Out-Null; Cdp 'Input.insertText' @{ text = "`nend`n" } | Out-Null
if (IsCM) { 'SKIPPED in CodeMirror: about the old coloured layer' } else {
$r = J "await new Promise(r=>setTimeout(r,1500)); const sp=[...edLayer().querySelectorAll('.spell-err')].find(s=>s.dataset.w==='mispeled'); return JSON.stringify([$same, editorHighlight.children.length === editor.value.split('\n').length, !!sp && editor.value.substr(overlayOffsetOf(sp), 8) === 'mispeled', editorHighlight.scrollHeight === editor.scrollHeight])"
T 'After typing, new lines, deleting a selection: layer still identical and aligned' $r ($r -eq '[true,true,true,true]')
}
$k = @(); for ($i = 0; $i -lt 20; $i++) { $sw = [Diagnostics.Stopwatch]::StartNew(); Cdp 'Input.insertText' @{ text = 'q' } | Out-Null; Eval "new Promise(r=>requestAnimationFrame(()=>r(1)))" | Out-Null; $k += $sw.Elapsed.TotalMilliseconds }
$med = [Math]::Round((@($k | Sort-Object))[10])
T 'Typing in a 100 KB Markdown file (split view) stays quick (ms per key)' $med ($med -lt 150)

# ---------- tabs keep their preview ----------
$r = J "const big = getActive(); await new Promise(r=>setTimeout(r,800)); const before = preview.innerHTML.length; const small = newUntitledDoc(); addDocAndActivate(small); await new Promise(r=>setTimeout(r,200)); const kept = !!big.previewStash; let calls = 0; const orig = marked_.parse; marked_.parse = (...a) => { calls++; return orig.apply(marked_, a); }; setActiveTab(big.id); marked_.parse = orig; await new Promise(r=>setTimeout(r,200)); const ok = preview.innerHTML.length === before && $same; await closeTab(small.id); return JSON.stringify([kept, calls, ok])"
T 'Switching back to a tab reuses its preview (no re-render)' $r ($r -eq '[true,0,true]')
$r = J "const big = getActive(); const small = newUntitledDoc(); addDocAndActivate(small); big.content += '\nchanged elsewhere'; setActiveTab(big.id); await new Promise(r=>setTimeout(r,300)); const ok = preview.textContent.includes('changed elsewhere'); await closeTab(small.id); return String(ok)"
T 'A kept preview is not reused when the text changed' $r ($r -eq 'true')

# ---------- spelling suggestions ----------
$r = J "return (await requestSuggestions('Unhndled')).join(', ')"
T 'Suggestions never contain digits (Typo.js compound-rule fix)' $r ($r -notmatch '\d' -and $r.Length -gt 0)
$r = J "const w = 'Un02ndled'; spell.cache.delete(w); isMisspelled(w); await new Promise(r=>setTimeout(r,800)); return String(spell.cache.get(w))"
T 'A word containing "02nd" is not accepted as correct' $r ($r -eq 'false')

# ---------- big log: line numbers, find highlights ----------
if (IsCM) {
if (IsCM) {
$r = J "const d = await openPath('$w/LOG.TXT'); setLayoutMode('edit-only'); if (!lineNumbersVisible) toggleLineNumbers(); await new Promise(r=>setTimeout(r,300)); editor.scrollTop = editor.scrollHeight; await new Promise(r=>setTimeout(r,400)); const els = [...edGutterEl().querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(e => e.offsetHeight > 0 && /^\d+$/.test(e.textContent)); return JSON.stringify([els.some(e => e.textContent.length >= 5), els.every(e => e.scrollWidth <= e.clientWidth + 1)])"
T 'Line numbers: gutter fits 5-digit numbers' $r ($r -eq '[true,true]')
} else {
$r = J "const d = await openPath('$w/LOG.TXT'); setLayoutMode('edit-only'); if (!lineNumbersVisible) toggleLineNumbers(); await new Promise(r=>setTimeout(r,300)); editor.scrollTop = editor.scrollHeight; await new Promise(r=>setTimeout(r,400)); const els = [...edGutterEl().querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(e => e.offsetHeight > 0 && /^\d+$/.test(e.textContent)); return JSON.stringify([els.some(e => e.textContent.length >= 5), els.every(e => e.scrollWidth <= e.clientWidth + 1)])"
T 'Line numbers: gutter fits 5-digit numbers' $r ($r -eq '[true,true]')
}
} else {
if (IsCM) {
$r = J "const d = await openPath('$w/LOG.TXT'); setLayoutMode('edit-only'); if (!lineNumbersVisible) toggleLineNumbers(); await new Promise(r=>setTimeout(r,300)); editor.scrollTop = editor.scrollHeight; await new Promise(r=>setTimeout(r,400)); const els = [...edGutterEl().querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(e => e.offsetHeight > 0 && /^\d+$/.test(e.textContent)); return JSON.stringify([els.some(e => e.textContent.length >= 5), els.every(e => e.scrollWidth <= e.clientWidth + 1)])"
T 'Line numbers: gutter fits 5-digit numbers' $r ($r -eq '[true,true]')
} else {
$r = J "const d = await openPath('$w/LOG.TXT'); setLayoutMode('edit-only'); if (!lineNumbersVisible) toggleLineNumbers(); await new Promise(r=>setTimeout(r,300)); editor.scrollTop = editor.scrollHeight; await new Promise(r=>setTimeout(r,300)); return JSON.stringify([lineNumbersEl.style.width, lineNumbersEl.scrollWidth <= lineNumbersEl.clientWidth])"
T 'Line numbers: gutter fits 5-digit numbers' $r ($r -eq '["calc(5ch + 12px + var(--bm-margin) + var(--diag-margin, 0px))",true]')
}
}
foreach ($lang in 'log', 'plaintext') {
    $r = J "setDocLanguage('$lang'); await new Promise(r=>setTimeout(r,2500)); openFindBar(false); findInput.value='battery'; findInput.dispatchEvent(new Event('input')); for (let i=0;i<100 && !edLayer().querySelector('.find-hit');i++) await new Promise(r=>setTimeout(r,50)); if (editor.isCodeMirror) { const v = editor.api.view; const drawn = [...edLayer().querySelectorAll('.find-hit')]; const inView = findState.matches.filter(m => v.visibleRanges.some(r => m.s >= r.from && m.e <= r.to)); const cmOk = inView.length > 0 && inView.every(m => drawn.some(el => { const p = editor.api.posAtDOM(el); return p <= m.s && m.s < p + el.textContent.length; })) && drawn.every(el => 'battery'.includes(el.textContent.toLowerCase())); return JSON.stringify([findState.matches.length, cmOk ? findState.matches.length : drawn.length, true]); } return JSON.stringify([findState.matches.length, edLayer().querySelectorAll('.find-hit').length, $same])"
    T "Simple find highlights every hit in a 1 MB log ($lang)" $r ($r -eq '[4880,4880,true]')
    J "editor.focus(); editor.setSelectionRange(100, 100); return 1" | Out-Null
    $k = @(); for ($i = 0; $i -lt 8; $i++) { $sw = [Diagnostics.Stopwatch]::StartNew(); Cdp 'Input.insertText' @{ text = 'z' } | Out-Null; Eval "new Promise(r=>requestAnimationFrame(()=>r(1)))" | Out-Null; $k += $sw.Elapsed.TotalMilliseconds }
    $mx = [Math]::Round((@($k | Sort-Object))[4])
    T "Typing in that log with find open stays usable ($lang, median ms per key)" $mx ($mx -lt 400)
    $r = J "await new Promise(r=>setTimeout(r,2500)); if (editor.isCodeMirror) { const v = editor.api.view; const drawn = [...edLayer().querySelectorAll('.find-hit')]; const inView = findState.matches.filter(m => v.visibleRanges.some(r => m.s >= r.from && m.e <= r.to)); const cmOk = inView.length > 0 && inView.every(m => drawn.some(el => { const p = editor.api.posAtDOM(el); return p <= m.s && m.s < p + el.textContent.length; })) && drawn.every(el => 'battery'.includes(el.textContent.toLowerCase())); const real = (editor.value.match(/battery/gi) || []).length; return JSON.stringify([cmOk && findState.matches.length === real, true, editor.value.slice(findState.matches[3].s, findState.matches[3].e)]); } const c = lineIndex(getActive()); const kids = [...editorHighlight.children]; const per = {}; findState.matches.forEach(m => { const l = lineOf(c, m.s); per[l] = (per[l] || 0) + 1; }); const missing = findState.matches.filter(m => { const l = lineOf(c, m.s); const k = kids[l]; return !k || k.querySelectorAll('.find-hit').length !== per[l]; }).map(m => lineOf(c, m.s) + ':' + JSON.stringify(c.lines[lineOf(c, m.s)]).slice(0, 60) + ':' + (kids[lineOf(c, m.s)] ? kids[lineOf(c, m.s)].innerHTML.slice(0, 80) : 'none')); const real = (editor.value.match(/battery/gi) || []).length; return JSON.stringify([edLayer().querySelectorAll('.find-hit').length === real && findState.matches.length === real, $same, editor.value.slice(findState.matches[3].s, findState.matches[3].e)]) + (missing.length ? ' MISSING ' + missing.slice(0, 2).join(' | ') : '')"
    T "Hits stay on their words after typing ($lang)" $r ($r -eq '[true,true,"Battery"]')
    $r = J "closeFindBar(); await new Promise(r=>setTimeout(r,1500)); return String(edLayer().querySelectorAll('.find-hit').length)"
    T "Closing find removes the highlights ($lang)" $r ($r -eq '0')
}

# ---------- accent colour ----------
$r = J "const a = await invoke('cmd_system_accent'); settings.windowsAccent = true; applySettings(); await new Promise(r=>setTimeout(r,200)); const on = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); settings.windowsAccent = false; applySettings(); const off = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); settings.windowsAccent = true; applySettings(); return JSON.stringify([!!a, a ? on.toLowerCase() === (document.documentElement.dataset.theme === 'dark' ? a.dark : a.light) : true, off === '#0a66cc' || off === '#4ea1ff'])"
T 'Windows accent colour follows the setting (and can be switched off)' $r ($r -eq '[true,true,true]')
Stop-App

$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
