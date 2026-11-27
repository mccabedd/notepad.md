param([string]$Exe)
# Memory work after v2.0.0: the colouring queue (latest wins, shared identical jobs, worker failure),
# the per-tab colour cache, closed tabs that keep no text for saved files, and memory let go after
# closing big files. CodeMirror editor only (the parts tested here are CodeMirror's).
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message + ' @ ' + (e.stack||'').split('\n')[1]; } })()" }
function Write-NoBom([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }
$work = "$sp\workmem"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
$w = $work.Replace('\', '\\')

# Big logs (coloured in the worker: over 300,000 characters). Each one different.
function New-Log([string]$name, [int]$lines, [string]$tag) {
    $sb = New-Object Text.StringBuilder
    $lv = 'INFO', 'WARN', 'ERROR', 'DEBUG'
    for ($i = 0; $i -lt $lines; $i++) {
        $line = "2026-11-27 10:{0:D2}:{1:D2}.{2:D3} {3} [worker-{4}] {5} request {6} took {7} ms from 10.0.{8}.{9}`n" -f ($i % 60), ($i % 60), ($i % 1000), $lv[$i % 4], ($i % 7), $tag, $i, ($i * 7 % 1000), ($i % 255), ($i % 200)
        [void]$sb.Append($line)
    }
    Write-NoBom "$work\$name" $sb.ToString()
}
foreach ($n in 'a', 'b', 'c', 'd', 'e') { New-Log "$n.log" 30000 "file-$n" }   # ~2.6 MB each
New-Log 'big.log' 110000 'big'                                                # ~9.5 MB

Start-App $Exe $null
$cm = (J "return editor.isCodeMirror ? 'cm' : 'textarea'") -eq 'cm'
J "dialogApi.message = async (m) => { (window.__msgs = window.__msgs || []).push(m); }; askSaveYesNoCancel = async () => window.__save || 'no'; return 1" | Out-Null
# Counts what the colouring worker is really asked to do.
J @"
window.__posts = 0;
const post = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (m, t) { if (m && typeof m.text === 'string' && m.text.length > 300000) __posts++; return post.call(this, m, t); };
window.__frame = () => new Promise((r) => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = r; ch.port2.postMessage(0); }));
window.__idle = async () => { for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 100)); const s = editor.api ? editor.api.colourState() : null; if (!hlActive && !hlNext && (!s || (!s.pending && (s.current || !s.lang)))) return true; } return false; };
return 1
"@ | Out-Null

# ---------- the queue ----------
$r = J "const t = docs[0].content + 'x'.repeat(10); const s = await highlightInWorker('2026-11-27 10:00:00 INFO hello\n'.repeat(20000), 'logfile', true); return JSON.stringify([!!s && s.starts.length > 0, hlActive === null, hlNext === null])"
T 'One request: coloured ranges come back, nothing left waiting' $r ($r -eq '[true,true,true]')

$r = J @"
const base = '2026-11-27 10:00:00 INFO hello world\n'.repeat(60000);
const p0 = __posts;
const ps = [];
for (let i = 0; i < 6; i++) ps.push(highlightInWorker(base + i, 'logfile', true));
const out = await Promise.all(ps);
const kinds = out.map((x) => (x === HL_SUPERSEDED ? 'S' : x && x.starts ? 'R' : String(x)));
return kinds.join('') + '|' + (__posts - p0) + '|' + (hlActive === null && hlNext === null);
"@
T 'Six requests in a row: the first and the last are coloured, the 4 between are replaced' $r ($r -eq 'RSSSSR|2|true')

$r = J "const t = '2026-11-27 10:00:00 INFO same\n'.repeat(40000); const p0 = __posts; const a = highlightInWorker(t, 'logfile', true); const b = highlightInWorker(t, 'logfile', true); const c = highlightInWorker(t, 'ini', true); const x = await a; await c; return [a === b, __posts - p0, !!x.starts].join('|')"
T 'The same text asked for twice shares one job; another language is a job of its own' $r ($r -eq 'true|2|true')

$r = J @"
const t1 = '2026-11-27 10:00:00 INFO one\n'.repeat(60000), t2 = t1 + 'two';
const a = highlightInWorker(t1, 'logfile', true), b = highlightInWorker(t2, 'logfile', true);
const old = hlWorker;
hlWorkerFailed(hlWorker, new Error('test failure'));
const res = await Promise.allSettled([a, b]);
const after = await highlightInWorker('2026-11-27 10:00:00 INFO three\n'.repeat(20000), 'logfile', true);
return [res.map((x) => x.status).join(','), hlWorker !== old, !!(after && after.starts.length), hlActive === null && hlNext === null].join('|');
"@
T 'A worker failure ends every job (none left waiting) and the next request starts a new worker' $r ($r -eq 'rejected,rejected|true|true|true')

# ---------- CodeMirror: colours in the editor, and the colour cache ----------
if ($cm) {
$r = J "await openPath('$w\\a.log'); return String(await __idle())"
$cs = J "return JSON.stringify(editor.api.colourState())"
T 'A big log opens coloured (made in the worker)' "$r $cs" ($r -eq 'true' -and $cs -match '"current":true' -and $cs -match '"lang":"logfile"')

# Typing faster than the file can be coloured: at most one job running and one waiting.
$r = J @"
const p0 = __posts;
editor.focus();
for (let i = 0; i < 30; i++) { editor.setSelectionRange(1000 + i, 1000 + i); editor.insertText('z'); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 800)); }
const peak = [];
const ok = await __idle();
const s = editor.api.colourState();
return [ok, s.current, s.ranges > 0, (__posts - p0) <= 6].join('|') + ' jobs=' + (__posts - p0);
"@
T 'Typing in bursts: colours end up made for the final text, without a backlog' $r ($r -like 'true|true|true|true*')

# A language change while the file is being coloured.
$r = J "editor.focus(); editor.setSelectionRange(5, 5); editor.insertText('q'); await new Promise((r) => setTimeout(r, 750)); setDocLanguage('ini'); const ok = await __idle(); const s = editor.api.colourState(); setDocLanguage(''); await __idle(); return [ok, s.lang, s.spansLang, s.current].join('|')"
T 'Changing the language while colouring: the colours are for the new language' $r ($r -eq 'true|ini|ini|true')

# ---------- the colour cache ----------
$r = J "await openPath('$w\\b.log'); await __idle(); const a = docs.find((d) => d.path && d.path.endsWith('a.log')); const p0 = __posts; setActiveTab(a.id); const s = editor.api.colourState(); await __frame(); await new Promise((r) => setTimeout(r, 1500)); return [s.current, s.ranges > 0, __posts - p0].join('|')"
T 'Switching back to an unchanged big tab: its colours are there at once, nothing recoloured' $r ($r -eq 'true|true|0')

$r = J "const b = docs.find((d) => d.path && d.path.endsWith('b.log')); b.content = b.content.replace('file-b', 'file-B'); const p0 = __posts; setActiveTab(b.id); const s = editor.api.colourState(); await __idle(); const s2 = editor.api.colourState(); return [s.current, __posts - p0, s2.current].join('|')"
T 'A tab whose text changed while away is coloured again (old colours not used)' $r ($r -eq 'false|1|true')

$r = J "const a = docs.find((d) => d.path && d.path.endsWith('a.log')); const b = getActive(); setActiveTab(a.id); await __idle(); setDocLanguage('ini'); await __idle(); setActiveTab(b.id); await __idle(); const p0 = __posts; setActiveTab(a.id); const s = editor.api.colourState(); await __idle(); const jobs = __posts - p0; setDocLanguage(''); await __idle(); return [s.current, s.lang, jobs].join('|')"
T 'A cached tab comes back in the language it has now' $r ($r -eq 'true|ini|0')

foreach ($n in 'c', 'd', 'e') { J "await openPath('$w\\$n.log'); await __idle(); return 1" | Out-Null }
$r = J "for (let k = 0; k < 3; k++) for (const d of docs.filter((x) => x.path)) { setActiveTab(d.id); await __frame(); } await __idle(); const i = editor.api.colourCacheInfo(); return [i.keys.length <= 3, i.bytes <= 32 * 1048576, i.keys.every((k) => docs.some((d) => d.id === k && d.id !== activeId))].join('|') + ' keys=' + i.keys.length + ' MB=' + (i.bytes / 1048576).toFixed(1)"
T 'Five big tabs, switched round: the cache keeps at most 3 tabs and 32 MB' $r ($r -like 'true|true|true*')

$r = J "const i0 = editor.api.colourCacheInfo().keys; const gone = docs.find((d) => i0.includes(d.id)); await closeTab(gone.id); await __frame(); const i = editor.api.colourCacheInfo(); return String(!i.keys.includes(gone.id))"
T 'Closing a tab drops its cached colours' $r ($r -eq 'true')

# Switching quickly among five tabs: no backlog, and the last tab ends up coloured.
$r = J "const ids = docs.filter((d) => d.path).map((d) => d.id); const p0 = __posts; for (let k = 0; k < 4; k++) for (const id of ids) { setActiveTab(id); await __frame(); } const ok = await __idle(); const s = editor.api.colourState(); return [ok, s.current, s.ranges > 0].join('|') + ' jobs=' + (__posts - p0)"
T 'Quick switching among the tabs: the tab in view ends up coloured, no backlog left' $r ($r -like 'true|true|true*')

# Closing a tab while it is being coloured.
$r = J "const d = docs.find((x) => x.path && x.content.length > 300000); setActiveTab(d.id); await __idle(); editor.setSelectionRange(3, 3); editor.insertText('w'); await new Promise((r) => setTimeout(r, 760)); const busy = !!hlActive; await closeTab(d.id); const ok = await __idle(); return [busy, ok, hlActive === null && hlNext === null].join('|')"
T 'Closing a tab while it is being coloured leaves nothing waiting' $r ($r -eq 'true|true|true')
}

# ---------- closed tabs ----------
J "for (const d of [...docs]) { d.dirty = false; await closeTab(d.id); } closedTabs.length = 0; return 1" | Out-Null
$r = J "await openPath('$w\\big.log'); await __idle(); await closeTab(getActive().id); const c = closedTabs[closedTabs.length - 1]; return [c.content === null, !!c.disk, c.path.endsWith('big.log')].join('|')"
T 'A closed saved file keeps no text (only where it is)' $r ($r -eq 'true|true|true')
$r = J "editor.focus(); await reopenClosedTab(); await __frame(); const d = getActive(); return [d.path.endsWith('big.log'), d.dirty, d.content.length > 9000000, d.content.slice(0, 10)].join('|')"
T 'It reopens from the disk, unchanged and saved' $r ($r -eq 'true|false|true|2026-11-27')

$r = J "for (let i = 0; i < 10; i++) { await openPath('$w\\big.log'); await __frame(); await closeTab(getActive().id); await __frame(); } return closedTabs.length + '|' + closedTabs.reduce((n, c) => n + ((c.content && c.content.length) || 0), 0)"
T 'Ten 10 MB saved files opened and closed: no text kept in closed-tab history' $r ($r -match '^\d+\|0$')

# Unsaved edits to a saved file: the text is kept and comes back unsaved.
Write-NoBom "$work\edit.txt" "line one`nline two`n"
$r = J "await openPath('$w\\edit.txt'); editor.value = 'line one\nline two CHANGED\n'; editor.dispatchEvent(new Event('input')); window.__save = 'no'; await closeTab(getActive().id); const c = closedTabs[closedTabs.length - 1]; await reopenClosedTab(); const d = getActive(); return [c.content !== null, d.content.includes('CHANGED'), d.dirty].join('|')"
T 'A saved file closed with unsaved changes comes back with them, still unsaved' $r ($r -eq 'true|true|true')
J "getActive().dirty = false; await closeTab(getActive().id); return 1" | Out-Null

# Changed on disk after closing: shows the file as it is now, and says so.
Write-NoBom "$work\ext.txt" "before`n"
J "await openPath('$w\\ext.txt'); await closeTab(getActive().id); return 1" | Out-Null
Start-Sleep -Milliseconds 1100
Write-NoBom "$work\ext.txt" "after, changed by another program`n"
$r = J "await reopenClosedTab(); await __frame(); return getActive().content + '|' + getActive().dirty + '|' + (statusDirty.textContent + findStatus.textContent).includes('changed since')"
T 'Changed on disk since closing: reopens as it is now, with a note' $r ($r -eq "after, changed by another program`n|false|true")
J "await closeTab(getActive().id); return 1" | Out-Null

# Deleted or moved after closing: a message, and no empty tab.
Write-NoBom "$work\gone.txt" "soon gone`n"
J "await openPath('$w\\gone.txt'); await closeTab(getActive().id); return 1" | Out-Null
Move-Item "$work\gone.txt" "$work\moved.txt"
$r = J "window.__msgs = []; const n = docs.length; await reopenClosedTab(); return [docs.length === n, window.__msgs.length === 1, (window.__msgs[0] || '').includes('no longer exists')].join('|')"
T 'Moved or deleted after closing: a message, and no tab opened' $r ($r -eq 'true|true|true')

# Encoding, line endings, selection and scroll position come back.
[IO.File]::WriteAllText("$work\crlf.txt", ((1..400 | ForEach-Object { "row $_ with some text" }) -join "`r`n") + "`r`n", (New-Object Text.UnicodeEncoding $false, $true))
$r = J "await openPath('$w\\crlf.txt'); await __frame(); editor.setSelectionRange(2000, 2010); await __frame(); const before = [getActive().encoding, getActive().eol].join(','); await closeTab(getActive().id); await reopenClosedTab(); await __frame(); await __frame(); const d = getActive(); return before + '|' + [d.encoding, d.eol, editor.selectionStart, editor.selectionEnd, d.dirty].join(',')"
T 'Encoding, line endings and selection come back' $r ($r -match '^(.+),crlf\|\1,crlf,2000,2010,false$')

# An untitled tab with text: kept in full (as before).
$r = J "addDocAndActivate(newUntitledDoc()); editor.value = 'untitled words'; editor.dispatchEvent(new Event('input')); window.__save = 'no'; await closeTab(getActive().id); await reopenClosedTab(); return getActive().content + '|' + !getActive().path"
T 'An untitled tab with text comes back with it' $r ($r -eq 'untitled words|true')

# ---------- memory let go after closing big files ----------
J "for (const d of [...docs]) { d.dirty = false; await closeTab(d.id); } closedTabs.length = 0; await __idle(); return 1" | Out-Null
Cdp 'HeapProfiler.collectGarbage' @{} | Out-Null; Start-Sleep -Milliseconds 500; Cdp 'HeapProfiler.collectGarbage' @{} | Out-Null
$h0 = (Cdp 'Runtime.getHeapUsage' @{}).result.usedSize / 1MB
J "await openPath('$w\\big.log'); await __idle(); await closeTab(getActive().id); closedTabs.length = 0; await __idle(); return 1" | Out-Null
Cdp 'HeapProfiler.collectGarbage' @{} | Out-Null; Start-Sleep -Milliseconds 500; Cdp 'HeapProfiler.collectGarbage' @{} | Out-Null
$h1 = (Cdp 'Runtime.getHeapUsage' @{}).result.usedSize / 1MB
$d = [Math]::Round($h1 - $h0, 1)
T 'A 10 MB file opened, coloured and closed: the page keeps less than 3 MB of it (diagnostic GC)' "$d MB" ($d -lt 3)

Stop-App
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
$results | Format-Table -AutoSize -Wrap | Out-String -Width 250
$p = ($results | Where-Object Result -eq 'PASS').Count
$f = ($results | Where-Object Result -eq 'FAIL').Count
"PASS: $p  FAIL: $f"
