param([string]$Exe, [string]$Part = 'all')
$sp = . "$PSScriptRoot\testdir.ps1"
$S = "$sp\samples"; Remove-Item $S -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item "$PSScriptRoot\fixtures\samples" $S -Recurse
. "$PSScriptRoot\harness.ps1"
. "$PSScriptRoot\cdpkeys.ps1"

$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) {
    [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" })
}
function J([string]$js) { Eval "(async () => { $js })()" }
function Shot([string]$name) {
    $r = Cdp 'Page.captureScreenshot' @{ format = 'png' }
    [IO.File]::WriteAllBytes("$sp\shot-$name.png", [Convert]::FromBase64String($r.result.data))
}
function WaitFor([string]$cond, [int]$ms = 8000) {
    $t = 0; while ($t -lt $ms) { if ((Eval $cond) -eq $true) { return $true }; Start-Sleep -Milliseconds 200; $t += 200 }; return $false
}

# fresh working copies so saves don't touch the originals
$W = "$sp\work"; Remove-Item $W -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item $S $W -Recurse

Start-App $Exe $null
Eval "localStorage.clear(); spell.userWords.clear(); spell.ignored.clear(); true" | Out-Null

# ---------- startup ----------
T 'Tab bar visible with 1 tab' (J "return tabbarEl.offsetHeight + 'px, tabs=' + tabbarEl.querySelectorAll('.tab').length") ((J "return !tabbarEl.classList.contains('hidden') && tabbarEl.querySelectorAll('.tab').length===1") -eq $true)
$langs = J "return ['markdown','xml','yaml','json','ini','python','javascript','powershell','dos','php'].filter(l => !hljs.getLanguage(l)).join(',')"
T 'highlight.js has all grammars' "missing=[$langs]" ($langs -eq '')
T 'Sidebar has 4 view buttons' (J "return sidebarEl.querySelectorAll('button[data-layout]').length") ((J "return sidebarEl.querySelectorAll('button[data-layout]').length") -eq 4)

# ---------- open every language ----------
$files = @(
  @('notes.md','markdown','preview-only'), @('plain.txt','plaintext','preview-only'), @('data.xml','xml','edit-only'),
  @('page.html','html','edit-only'), @('conf.yml','yaml','edit-only'), @('conf.yaml','yaml','edit-only'),
  @('data.json','json','edit-only'), @('settings.ini','ini','edit-only'), @('script.py','python','edit-only'),
  @('app.js','javascript','edit-only'), @('script.ps1','powershell','edit-only'), @('run.bat','dos','edit-only'),
  @('index.php','php','edit-only'), @('config.toml','toml','edit-only'))
foreach ($f in $files) {
    $p = ("$W\" + $f[0]).Replace('\', '\\')
    $info = J "const d = await openPath('$p'); await new Promise(r=>requestAnimationFrame(()=>r())); return JSON.stringify({lang:d.lang, layout:d.layoutMode, spans: edLayer().querySelectorAll('[class^=hljs-]').length, status: statusLang.textContent, enc: d.encoding, eol: d.eol})"
    $o = $info | ConvertFrom-Json
    $needSpans = $f[1] -ne 'plaintext'
    $ok = ($o.lang -eq $f[1]) -and ($o.layout -eq $f[2]) -and ((-not $needSpans) -or $o.spans -gt 0)
    T ("Open " + $f[0]) "lang=$($o.lang) layout=$($o.layout) colouredSpans=$($o.spans) status='$($o.status)' $($o.enc)/$($o.eol)" $ok
}
T 'PS1 decoded as UTF-16 LE' (J "return docs.find(d=>d.path.endsWith('script.ps1')).encoding") ((J "const d=docs.find(d=>d.path.endsWith('script.ps1')); return d.encoding==='utf16le' && d.content.includes('Get-Greeting')") -eq $true)
T 'BAT keeps CRLF' (J "return docs.find(d=>d.path.endsWith('run.bat')).eol") ((J "return docs.find(d=>d.path.endsWith('run.bat')).eol==='crlf'") -eq $true)
T 'Opening an already-open file switches to it' (J "const n=docs.length; await openPath('$("$W\data.json".Replace('\','\\'))'); return n + '->' + docs.length + ' active=' + getActive().path.split('\\').pop()") ((J "const n=docs.length; await openPath('$("$W\data.json".Replace('\','\\'))'); return n===docs.length && getActive().path.endsWith('data.json')") -eq $true)

$r = J "return !document.getElementById('tab-scroll').classList.contains('hidden') + '|' + getComputedStyle(tabbarEl).scrollbarWidth"
T 'Tab overflow shows arrows, no scrollbar' $r ($r -eq 'true|none')
$r = J "const sb=document.querySelector('.statusbar'); return sb.offsetHeight"
T 'Status bar stays one line' "$r px" ([int]$r -lt 30)

# coloured screenshots of a couple of languages
J "setActiveTab(docs.find(d=>d.path&&d.path.endsWith('script.ps1')).id); return 1" | Out-Null; Start-Sleep -Milliseconds 300; Shot 'ps1-light'
J "setActiveTab(docs.find(d=>d.path&&d.path.endsWith('page.html')).id); setLayoutMode('split-ep'); return 1" | Out-Null; Start-Sleep -Milliseconds 300; Shot 'html-split-light'

# ---------- per-tab views ----------
$r = J @"
const md = docs.find(d=>d.path&&d.path.endsWith('notes.md'));
const js = docs.find(d=>d.path&&d.path.endsWith('data.json'));
setActiveTab(md.id); setLayoutMode('split-pe');
setActiveTab(js.id); const jsMode = layoutMode;
setLayoutMode('split-ep');
setActiveTab(md.id); const mdMode = layoutMode, mdSidebar = sidebarEl.querySelector('button.active').dataset.layout;
setActiveTab(js.id); const jsMode2 = layoutMode;
return [mdMode, mdSidebar, jsMode, jsMode2].join(',');
"@
T 'Per-tab views (md=split-pe, json kept own mode)' $r ($r -eq 'split-pe,split-pe,edit-only,split-ep')
$r = J "sidebarEl.querySelector('button[data-layout=preview-only]').click(); return layoutMode + '/' + getActive().layoutMode"
T 'Sidebar button changes view' $r ($r -eq 'preview-only/preview-only')

# ---------- dirty asterisk via real typing ----------
J "setActiveTab(docs.find(d=>d.path&&d.path.endsWith('notes.md')).id); setLayoutMode('split-ep'); editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); return 1" | Out-Null
Cdp 'Input.insertText' @{ text = "`nNew line typed." } | Out-Null
Start-Sleep -Milliseconds 300
$r = J "const t=tabbarEl.querySelector('.tab.active'); return t.querySelector('.tab-dirty').textContent + '|' + t.querySelector('.tab-title').textContent + '|' + document.title"
T 'Unsaved tab shows * before name' $r ($r -like '*|notes.md|*')
$r = J "const t=tabbarEl.querySelector('.tab.active .tab-dirty'); return (t.compareDocumentPosition(tabbarEl.querySelector('.tab.active .tab-title')) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'left-of-name' : 'right'"
T 'Asterisk sits left of the name' $r ($r -eq 'left-of-name')
# undo back to saved text clears the marker
J "editor.focus(); runToolbarCommand('undo'); return 1" | Out-Null; Start-Sleep -Milliseconds 200
$r = J "const d=getActive(); return d.dirty + '|' + tabbarEl.querySelector('.tab.active .tab-dirty').textContent"
T 'Undo to saved text clears *' $r ($r -eq 'false|')
Cdp 'Input.insertText' @{ text = "`nNew line typed." } | Out-Null; Start-Sleep -Milliseconds 300

# ---------- active tab red bar ----------
$r = J "return getComputedStyle(tabbarEl.querySelector('.tab.active')).boxShadow"
T 'Active tab has red top bar' $r ($r -match 'rgb\((211, 47, 47|241, 76, 76)\) 0px 3px 0px 0px inset')

# ---------- pinning ----------
$r = J @"
const json = docs.find(d=>d.path&&d.path.endsWith('data.json'));
const tab = tabbarEl.querySelector('.tab[data-id="'+json.id+'"]');
tab.querySelector('.tab-pin').click();
const first = tabbarEl.querySelector('.tab');
return first.dataset.id === json.id && first.classList.contains('pinned') ? 'pinned-first' : 'no';
"@
T 'Pin moves tab to front and marks it' $r ($r -eq 'pinned-first')
$r = J @"
const json = docs.find(d=>d.path&&d.path.endsWith('data.json'));
const unpinned = docs.filter(d=>!d.pinned);
await closeMany(unpinned.filter(d=>!d.dirty));
return docs.length + ':' + docs.map(d=>(d.path||'').split('\\').pop()).join(',');
"@
T 'Close All keeps pinned + unsaved tabs' $r ($r -match '^2:data.json,notes.md$')

# ---------- spellcheck ----------
J "setActiveTab(docs.find(d=>d.path&&d.path.endsWith('notes.md')).id); setSpellLang('en_GB'); return 1" | Out-Null
$ok = WaitFor "edLayer().querySelectorAll('.spell-err').length > 0" 15000
$gb = J "return [...edLayer().querySelectorAll('.spell-err')].map(s=>s.textContent).join(',')"
T 'en-GB flags editor words' $gb ($ok -and $gb -match 'color' -and $gb -match 'Ths' -and $gb -match 'mispeled' -and $gb -notmatch 'colour')
T 'Code, URLs, camelCase not flagged' $gb ($gb -notmatch 'inlineCodeWord|https|example|somepath|greeting|const')
$pv = J "return [...CSS.highlights.get('spell')].map(r=>r.toString()).join(',')"
T 'Preview underlines (Highlight API)' $pv ($pv -match 'color' -and $pv -match 'mispeled' -and $pv -notmatch 'colour')
Shot 'spell-gb'
J "setSpellLang('en_US'); return 1" | Out-Null
$ok = WaitFor "[...edLayer().querySelectorAll('.spell-err')].some(s=>s.textContent==='colour')" 15000
$us = J "return [...edLayer().querySelectorAll('.spell-err')].map(s=>s.textContent).join(',')"
T 'en-US flags colour, not color' $us ($ok -and $us -match 'colour' -and $us -notmatch '(^|,)color(,|$)')
T 'Status bar shows language' (J "return statusSpell.textContent") ((J "return statusSpell.textContent") -eq 'English (US)')
$sg = J "return (await requestSuggestions('mispeled')).join(',')"
T 'Suggestions for mispeled' $sg ($sg -match 'misspelled')
$r = J @"
const span=[...edLayer().querySelectorAll('.spell-err')].find(s=>s.textContent==='mispeled');
const o=overlayOffsetOf(span); replaceEditorRange(o, o+8, 'misspelled');
await new Promise(r=>setTimeout(r,100));
return getActive().content.includes('a misspelled word') + '|' + preview.textContent.includes('a misspelled word');
"@
T 'Replace from suggestion (editor+preview synced)' $r ($r -eq 'true|true')
$r = J "addUserWord('Ths'); await new Promise(r=>setTimeout(r,200)); return [...edLayer().querySelectorAll('.spell-err')].some(s=>s.textContent==='Ths')"
T 'Add to dictionary removes underline' $r ($r -eq $false)
$r = J "toggleSpell(); await new Promise(r=>setTimeout(r,350)); return edLayer().querySelectorAll('.spell-err').length + '|' + statusSpell.textContent"
T 'F7 toggle turns spellcheck off' $r ($r -eq '0|Spelling off')
J "toggleSpell(); setSpellLang('en_GB'); return 1" | Out-Null
# right-click in preview opens suggestion menu
Start-Sleep -Milliseconds 800
$r = J @"
const r=[...CSS.highlights.get('spell')].find(r=>r.toString()==='color'); const rc=r.getClientRects()[0];
preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rc.left+3,clientY:rc.top+5}));
await new Promise(r=>setTimeout(r,1500));
return [...ctxMenu.querySelectorAll('button')].map(b=>b.textContent).join('|');
"@
T 'Right-click misspelling shows suggestions' $r ($r -match 'colour' -and $r -match 'Add "color" to dictionary')
Shot 'spell-menu'
J "hideContextMenu(); return 1" | Out-Null

# ---------- save keeps encoding / line endings ----------
$r = J @"
await openPath('$("$W\script.ps1".Replace('\','\\'))'); const d=getActive();
d.content = d.content.replace('World','Planet'); markDirty(d); await saveDocGeneric(d); return d.dirty;
"@
$bytes = [IO.File]::ReadAllBytes("$W\script.ps1")
$text = [Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
T 'Save keeps UTF-16 LE + CRLF' ("bom={0:X2}{1:X2} crlf={2} planet={3}" -f $bytes[0], $bytes[1], $text.Contains("`r`n"), $text.Contains('Planet')) ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE -and $text.Contains("`r`n") -and $text.Contains('Planet') -and $r -eq $false)

# ---------- drag & drop (event path) ----------
$r = J @"
const n = docs.length;
await window.__TAURI__.event.emit('tauri://drag-drop', { paths: ['$("$W\app.js".Replace('\','\\'))', '$("$W\config.toml".Replace('\','\\'))'], position: {x:10,y:10} });
await new Promise(r=>setTimeout(r,800));
return (docs.length - n) + ' new, active=' + getActive().path.split('\\').pop();
"@
T 'Dropped files open in tabs' $r ($r -eq '2 new, active=config.toml')

# ---------- dark theme screenshot ----------
J "setActiveTab(docs.find(d=>d.path&&d.path.endsWith('notes.md')).id); setLayoutMode('split-ep'); toggleTheme(); return 1" | Out-Null; Start-Sleep -Milliseconds 500; Shot 'md-split-dark'
J "setActiveTab(docs.find(d=>d.path&&d.path.endsWith('app.js')).id); return 1" | Out-Null; Start-Sleep -Milliseconds 300; Shot 'js-dark'

# ---------- overlay alignment check ----------
if (IsCM) { 'SKIPPED in CodeMirror: about the old coloured layer' } else {
$r = J @"
setActiveTab(docs.find(d=>d.path&&d.path.endsWith('notes.md')).id); setLayoutMode('edit-only');
const long = 'word '.repeat(400) + '\n' + 'x'.repeat(50) + '\n\n';
editor.value = long + editor.value; syncFromEditor(); await new Promise(r=>requestAnimationFrame(()=>r()));
const a = editor.scrollHeight, b = editorHighlight.scrollHeight;
editor.scrollTop = 999999; editor.dispatchEvent(new Event('scroll'));
return a + '/' + b + ' top=' + editor.scrollTop + '/' + editorHighlight.scrollTop;
"@
$m = [regex]::Match($r, '(\d+)/(\d+) top=(\d+)/(\d+)')
T 'Overlay wraps + scrolls exactly like textarea' $r ($m.Success -and [math]::Abs([int]$m.Groups[1].Value - [int]$m.Groups[2].Value) -le 1 -and [math]::Abs([int]$m.Groups[3].Value - [int]$m.Groups[4].Value) -le 1)
}

# ---------- session: close + relaunch ----------
$before = J @"
const md = docs.find(d=>d.path&&d.path.endsWith('notes.md'));
setActiveTab(md.id); setLayoutMode('split-pe');
addDocAndActivate(newUntitledDoc()); editor.value='Untitled scratch text'; syncFromEditor();
setActiveTab(md.id);
return JSON.stringify(docs.map(d=>({n:(d.path||'').split('\\').pop()||tabTitle(d), pin:d.pinned, dirty:d.dirty, mode:d.layoutMode})).concat([{active: tabTitle(getActive())}]));
"@
$hwnd = [KB]::MainWin([uint32]$script:proc.Id)
[void][W32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)   # WM_CLOSE = clicking the X
$exited = $script:proc.WaitForExit(6000)
T 'Window closes without prompting' "exited=$exited" $exited
try { $script:ws.Dispose() } catch {}
$sessionJson = Get-Content "$sp\appdata\session.json" -Raw
T 'Session file written' "$($sessionJson.Length) bytes" ($sessionJson.Length -gt 100)

Start-App $Exe $null -KeepSession
Start-Sleep -Milliseconds 800
$after = J "return JSON.stringify(docs.map(d=>({n:(d.path||'').split('\\').pop()||tabTitle(d), pin:d.pinned, dirty:d.dirty, mode:d.layoutMode})).concat([{active: tabTitle(getActive())}]))"
T 'Relaunch restores tabs/pins/unsaved/views/active' "before=$before after=$after" ($before -eq $after)
$r = J "const d=docs.find(d=>d.path&&d.path.endsWith('notes.md')); const t=[...tabbarEl.querySelectorAll('.tab')].find(x=>x.dataset.id===d.id); return d.content.includes('New line typed.') + '|' + t.querySelector('.tab-dirty').textContent"
T 'Unsaved edits restored with *' $r ($r -eq 'true|*')
$r = J "const d=docs.find(d=>!d.path); return d ? d.content : 'none'"
T 'Untitled tab content restored' $r ($r -eq 'Untitled scratch text')
Shot 'restored'

Stop-App
$results | Format-Table -AutoSize -Wrap | Out-String -Width 250
"PASS: $(($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(($results | Where-Object Result -eq 'FAIL').Count)"
