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
    [IO.File]::WriteAllBytes("$sp\r3-$name.png", [Convert]::FromBase64String($r.result.data))
}
function Wheel($x, $y, $dy, $mods = 0, $dx = 0) {
    Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseWheel'; x = $x; y = $y; deltaX = $dx; deltaY = $dy; modifiers = $mods } | Out-Null
    Start-Sleep -Milliseconds 150
}
function Mouse($type, $x, $y, $button = 'left', $clicks = 1, $mods = 0) {
    Cdp 'Input.dispatchMouseEvent' @{ type = $type; x = $x; y = $y; button = $button; clickCount = $clicks; modifiers = $mods } | Out-Null
}
function P([string]$name) { ("$W\" + $name).Replace('\', '\\') }
function Wait1 { Start-Sleep -Milliseconds 350 }

$W = "$sp\work3"; Remove-Item $W -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item "$PSScriptRoot\fixtures\samples" $W -Recurse

Start-App $Exe $null
Eval "spell.userWords.clear(); true" | Out-Null
J "clipboard.writeText = async (t) => { window.__clip = t; }; clipboard.readText = async () => window.__clip; return 1" | Out-Null

# ---------- layout: find bar at the bottom ----------
$r = J "openFindBar(); const f=findBar.getBoundingClientRect(), w=document.querySelector('.main-area').getBoundingClientRect(), s=document.querySelector('.statusbar').getBoundingClientRect(); return (f.top >= w.bottom - 1) + '|' + (f.bottom <= s.top + 1) + '|' + [...findBar.querySelectorAll('input,button')].map(c=>c.id).join(',')"
T 'Find bar sits at the bottom, above status bar' $r ($r -like 'true|true|find-input,find-hist,find-clear,find-case,find-word,find-regex,find-insel,replace-input,replace-hist,find-prev,find-next,replace-one,replace-all,find-bookmark,find-advanced,find-close')
J "closeFindBar(); return 1" | Out-Null

# ---------- per-tab font size, Ctrl+wheel, Ctrl+0 ----------
J "await openPath('$(P 'notes.md')'); await openPath('$(P 'app.js')'); return 1" | Out-Null
$iw = J "return window.innerWidth"
Wheel 400 300 (-120) 2; Wheel 400 300 (-120) 2
$r = J "return getActive().fontSize + '|' + getComputedStyle(document.documentElement).getPropertyValue('--content-font-size').trim() + '|' + statusZoom.textContent"
T 'Ctrl+wheel up zooms the tab (+2)' $r ($r -eq '16|16px|114%')
T 'Ctrl+wheel does not zoom the whole page' "innerWidth $iw -> $(J 'return window.innerWidth')" ((J 'return window.innerWidth') -eq $iw)
Wheel 400 300 120 2
T 'Ctrl+wheel down zooms out' (J "return getActive().fontSize") ((J "return getActive().fontSize") -eq 15)
$r = J "const js=getActive(); setActiveTab(docs.find(d=>d.path&&d.path.endsWith('notes.md')).id); const md=getActive(); const css=getComputedStyle(document.documentElement).getPropertyValue('--content-font-size').trim(); setActiveTab(js.id); return md.fontSize + '|' + css + '|' + js.fontSize"
T 'Font size is per tab' $r ($r -eq '14|14px|15')
Send-Key @('CTRL') '0' 'Digit0' 0x30
T 'Ctrl+0 resets the tab' (J "return getActive().fontSize") ((J "return getActive().fontSize") -eq 14)
J "changeFontSize(3); return 1" | Out-Null

# ---------- wheel over tabs = arrow buttons ----------
foreach ($f in 'data.xml','page.html','conf.yml','data.json','settings.ini','script.py','script.ps1','run.bat','index.php','config.toml','plain.txt') { J "await openPath('$(P $f)'); return 1" | Out-Null }
$tb = J "const r=tabbarEl.getBoundingClientRect(); tabbarEl.scrollLeft=0; return Math.round(r.left+100)+','+Math.round(r.top+r.height/2)"
$x, $y = $tb.Split(',')
Start-Sleep -Milliseconds 300
Wheel ([int]$x) ([int]$y) 120; Start-Sleep -Milliseconds 600
$r1 = J "return Math.round(tabbarEl.scrollLeft)"
Wheel ([int]$x) ([int]$y) 120; Start-Sleep -Milliseconds 600
$r2 = J "return Math.round(tabbarEl.scrollLeft)"
Wheel ([int]$x) ([int]$y) (-120); Start-Sleep -Milliseconds 600
$r3 = J "return Math.round(tabbarEl.scrollLeft)"
$mx = J "return tabbarEl.scrollWidth - tabbarEl.clientWidth"; T 'Mouse wheel steps tabs like the arrows (200px)' "$r1 -> $r2 -> $r3 (max $mx)" ([int]$r1 -eq 200 -and [int]$r2 -eq [math]::Min(400,[int]$mx) -and [int]$r3 -eq [int]$r2 - 200)
Wheel ([int]$x) ([int]$y) 0 0 15; Start-Sleep -Milliseconds 300
T 'Touchpad sideways scroll moves smoothly' (J "return Math.round(tabbarEl.scrollLeft)") ([int](J "return Math.round(tabbarEl.scrollLeft)") -eq [int]$r3 + 15)

# ---------- tab context menu: Save / Save As ----------
$r = J @"
const d = docs.find(d=>d.path&&d.path.endsWith('data.json'));
d.content = d.content.replace('test','saved-from-tab-menu'); markDirty(d);
const t=[...tabbarEl.querySelectorAll('.tab')].find(x=>x.dataset.id===d.id);
t.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:20}));
const labels=[...ctxMenu.querySelectorAll('button .ctx-label')].map(b=>b.textContent);
const save=[...ctxMenu.querySelectorAll('button')].find(b=>b.querySelector('.ctx-label').textContent==='Save');
save.click(); await new Promise(r=>setTimeout(r,500));
return labels.slice(0,2).join(',') + '|dirty=' + d.dirty;
"@
$disk = Get-Content "$W\data.json" -Raw
T 'Tab right-click has Save / Save As; Save works on that tab' "$r disk=$($disk.Contains('saved-from-tab-menu'))" ($r -eq 'Save,Save As...|dirty=false' -and $disk.Contains('saved-from-tab-menu'))
J "hideContextMenu(); return 1" | Out-Null

# ---------- BBCode ----------
$r = J @"
await openPath('$(P 'forum.bbcode')'); setLayoutMode('split-ep');
await new Promise(r=>requestAnimationFrame(()=>r()));
const d=getActive();
return JSON.stringify({lang:d.lang, tags: edLayer().querySelectorAll('.hljs-tag').length, editable: preview.getAttribute('contenteditable'),
 strong: !!preview.querySelector('strong'), link: [...preview.querySelectorAll('a')].map(a=>a.getAttribute('href')).join(' '),
 quote: (preview.querySelector('blockquote')||{}).textContent, li: preview.querySelectorAll('li').length, color: !!preview.querySelector('span[style*=red]'),
 code: (preview.querySelector('pre code')||{}).textContent, script: preview.querySelectorAll('script').length, scriptText: preview.textContent.includes('<script>alert'),
 badSize: preview.textContent.includes('[size=larrge]'), details: !!preview.querySelector('details'), status: statusLang.textContent});
"@
$o = $r | ConvertFrom-Json
T 'BBCode: coloured editor, editable preview' "lang=$($o.lang) tags=$($o.tags) editable=$($o.editable) status=$($o.status)" ($o.lang -eq 'bbcode' -and $o.tags -gt 5 -and $o.editable -eq 'true' -and $o.status -eq 'BBCode')
T 'BBCode: formatting renders' "strong=$($o.strong) li=$($o.li) color=$($o.color) quote='$($o.quote)' details=$($o.details)" ($o.strong -and $o.li -eq 2 -and $o.color -and $o.quote -like 'Alice wrote:*Quoted text*' -and $o.details)
T 'BBCode: only safe links' "hrefs=[$($o.link)]" ($o.link -eq 'https://example.com https://example.org')
T 'BBCode: no HTML injection, code kept literal' "scripts=$($o.script) literal=$($o.scriptText) code='$($o.code)'" ($o.script -eq 0 -and $o.scriptText -and $o.code -eq 'if (a < b) { x = "<script>"; }')
Start-Sleep -Milliseconds 1500
$r = J "return [...edLayer().querySelectorAll('.spell-err')].map(s=>s.dataset.w).join(',')"
T 'BBCode: spellcheck text, not tags/values' $r ($r -match 'Helo' -and $r -notmatch 'larrge|spoiler|quote')
Shot 'bbcode'

# ---------- Advanced find ----------
J "await openPath('$(P 'app.log')'); setLayoutMode('edit-only'); openFindBar(true); return 1" | Out-Null
Start-Sleep -Milliseconds 300
$r = J "return !advPane.classList.contains('hidden') + '|' + findState.rows.length + '|' + advStatus.textContent"
T 'Advanced checkbox opens pane listing all lines' $r ($r -eq 'true|8|Showing 8 of 8 lines.')
function SetBox($id, $v) { $v = $v.Replace('\', '\\').Replace("'", "\'"); J "const el=document.getElementById('$id'); el.value='$v'; el.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,350)); return 1" | Out-Null }
function Lines { J "return findState.rows.map(r=>r.line+1).join(',')" }
SetBox 'adv-find' 'error, warn'
T 'Find: comma terms (any)' (Lines) ((Lines) -eq '2,4,6')
T 'Find box mirrors bottom Find box' (J "return findInput.value") ((J "return findInput.value") -eq 'error, warn')
SetBox 'adv-hide' 'disk'
T 'Hide: excludes terms' (Lines) ((Lines) -eq '4')
SetBox 'adv-find' ''; SetBox 'adv-hide' ''
SetBox 'adv-from' '#3'; SetBox 'adv-to' '6'
T 'From/To line numbers (inclusive)' (Lines) ((Lines) -eq '3,4,5,6')
SetBox 'adv-from' '14:30'; SetBox 'adv-to' '14:30'
T 'From/To time-only, minute inclusive; continuation inherits time' (Lines) ((Lines) -eq '2,3,4,5')
SetBox 'adv-from' '2024-10-14 14:31'; SetBox 'adv-to' '20241014'
T 'From datetime / To date (whole day)' (Lines) ((Lines) -eq '6,7,8')
SetBox 'adv-from' 'abc'; SetBox 'adv-to' ''
$r = J "return findState.rows.length + '|' + advStatus.textContent"
T 'Invalid range warns and is not applied' $r ($r -like '8|*Could not read*not applied*')
SetBox 'adv-from' '7'; SetBox 'adv-to' '3'
T 'From after To is an error' (J "return advStatus.textContent") ((J "return advStatus.textContent") -like '*From (line 7) is after To (line 3)*')
SetBox 'adv-from' ''; SetBox 'adv-to' ''
J "advRegex.checked=true; advCase.checked=true; advRegex.dispatchEvent(new Event('change')); return 1" | Out-Null
SetBox 'adv-find' 'ERROR\s+\w+ (Operation|write)'
T 'Regex + Match case' (Lines) ((Lines) -eq '4,6')
SetBox 'adv-find' 'error'
T 'Match case excludes "error" vs "ERROR"' (Lines) ((Lines) -eq '6')
J "advRegex.checked=false; advCase.checked=false; advWord.checked=true; advWord.dispatchEvent(new Event('change')); return 1" | Out-Null
SetBox 'adv-find' 'Disk'
T 'Whole word' (Lines) ((Lines) -eq '2,6')
J "advWord.checked=false; advWord.dispatchEvent(new Event('change')); return 1" | Out-Null
SetBox 'adv-find' ''

# row click jumps to the line in the editor
$r = J @"
const row=[...advRows.querySelectorAll('.adv-row')].find(r=>r.querySelector('.c-line').textContent==='4');
const rc=row.getBoundingClientRect(); return Math.round(rc.left+200)+','+Math.round(rc.top+10);
"@
$x, $y = $r.Split(','); Mouse 'mousePressed' ([int]$x) ([int]$y); Mouse 'mouseReleased' ([int]$x) ([int]$y); Wait1
$r = J "const c=lineIndex(getActive()); return lineOf(c, editor.selectionStart)+1 + '|' + [...edLayer().querySelectorAll('.nav-line')].map(e => e.textContent).join('')"
T 'Clicking a row selects that line in the editor' $r ($r -eq '4|2024-10-14 14:30:05,431 ERROR Move Operation failed')

# keyboard: Ctrl+Shift+B bookmarks, Down, Ctrl+C
Send-Key @('CTRL','SHIFT') 'B' 'KeyB' 0x42
$r = J "return JSON.stringify(getActive().bookmarks) + '|' + !!advRows.querySelector('.adv-row.bm-green') + '|' + !!edLayer().querySelector('.bm-line.bm-green')"
T 'Ctrl+Shift+B in the list bookmarks the line (green), shown in list + editor' $r ($r -eq '{"3":"Green"}|true|true')
Send-Key @() 'ArrowDown' 'ArrowDown' 0x28; Send-Key @('SHIFT') 'ArrowDown' 'ArrowDown' 0x28
Send-Key @('CTRL') 'c' 'KeyC' 0x43
$clip = J "return await clipboard.readText()"
T 'Arrow keys + Shift select; Ctrl+C copies the lines' $clip ($clip -eq "2024-10-14 14:30:59,999 INFO  Retrying move`n2024-10-14 14:31:00,000 ERROR Disk write error")
Send-Key @('CTRL', 'SHIFT') 'C' 'KeyC' 0x43
T 'Ctrl+Shift+C copies line numbers' (J "return await clipboard.readText()") ((J "return await clipboard.readText()") -eq "5`n6")

# context menu with bookmark submenu
function RightClickRow([string]$lineNo, [string]$col = 'c-text') {
    $xy = J "const row=[...advRows.querySelectorAll('.adv-row')].find(r=>r.querySelector('.c-line').textContent==='$lineNo'); row.scrollIntoView({block:'nearest'}); const rc=row.querySelector('.$col').getBoundingClientRect(); return Math.round(rc.left+30)+','+Math.round(rc.top+10)"
    $x, $y = $xy.Split(',')
    Mouse 'mousePressed' ([int]$x) ([int]$y) 'right'; Mouse 'mouseReleased' ([int]$x) ([int]$y) 'right'
    Start-Sleep -Milliseconds 300
}
RightClickRow '8'
$r = J @"
const items=[...ctxMenu.children].map(c=>c.className==='ctx-header'?'['+c.textContent+']':c.className==='ctx-sep'?'-':c.querySelector('.ctx-label').textContent);
const bm=[...ctxMenu.querySelectorAll('button')].find(b=>b.querySelector('.ctx-label').textContent.startsWith('Bookmark'));
bm.dispatchEvent(new MouseEvent('mouseenter'));
const sub=document.querySelectorAll('.ctx-menu')[1]; const subItems=[...sub.querySelectorAll('button .ctx-label')].map(b=>b.textContent);
[...sub.querySelectorAll('button')].find(b=>b.querySelector('.ctx-label').textContent==='Orange').click();
return items.join(' ; ') + ' || ' + subItems.join(',') + ' || ' + JSON.stringify(getActive().bookmarks);
"@
T 'Row menu: Timeline-style items' $r ($r -like '`[LINE 8 · 2024-10-14 14:33:00,000`] ; Bookmark ; Remove from the list ; - ; Copy *heartbeat* ; Copy line ; Copy line number ; Copy as table*; - ; Show from here*; Show up to here*; Filter by*; - ; Go to line ; Select all listed rows*')
T 'Bookmark submenu sets Orange' $r ($r -like '*Green,Orange,Red,Remove bookmark,Clear all bookmarks in this file…*{"3":"Green","7":"Orange"}')
RightClickRow '5'
$r = J @"
[...ctxMenu.querySelectorAll('button')].find(b=>b.querySelector('.ctx-label').textContent.startsWith('Show from here')).click();
await new Promise(r=>setTimeout(r,400)); return advFrom.value + '|' + findState.rows.map(r=>r.line+1).join(',');
"@
T 'Show from here puts the row time in From' $r ($r -eq '2024-10-14 14:30:59,999|5,6,7,8')
SetBox 'adv-from' ''

# Delete removes; Reset restores
J "selectOnly(findState.rows.findIndex(r=>r.line===0)); renderGrid(); advBody.focus(); return 1" | Out-Null
Send-Key @() 'Delete' 'Delete' 0x2E
$r = J "return findState.rows.length + '|' + advStatus.textContent"
T 'Delete removes the row from the list' $r ($r -like '7|*1 removed*')
J "advReset.click(); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null
T 'Reset brings removed rows back' (J "return findState.rows.length") ((J "return findState.rows.length") -eq 8)

# Add Bookmarks + block navigation
J "setBookmarks(getActive(), [1,2], 'Red'); return 1" | Out-Null   # lines 2-3 red (line 4 green, 8 orange)
SetBox 'adv-find' 'INFO'
$before = Lines
J "advAddBm.checked=true; advAddBm.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null
$after = Lines
T 'Add Bookmarks lists bookmarked lines too' "$before -> $after label=$(J 'return advAddBmLabel.textContent')" ($before -eq '1,5,7' -and $after -eq '1,2,3,4,5,7,8' -and (J 'return advAddBmLabel.textContent') -eq 'Remove Bookmarks')
J "selectOnly(0); renderGrid(); return 1" | Out-Null
J "advNextBm.click(); return 1" | Out-Null
$s1 = J "return (findState.rows[findState.current].line+1) + '|' + advStatus.textContent"
J "advNextBm.click(); return 1" | Out-Null
$s2 = J "return (findState.rows[findState.current].line+1) + '|' + advStatus.textContent"
J "advPrevBm.click(); return 1" | Out-Null
$s3 = J "return (findState.rows[findState.current].line+1) + '|' + advStatus.textContent"
T 'Bookmark Next/Previous move by blocks' "$s1 / $s2 / $s3" ($s1 -eq '2|Bookmarked block: lines 2–4 (3 rows).' -and $s2 -eq '8|Bookmark at line 8.' -and $s3 -eq '2|Bookmarked block: lines 2–4 (3 rows).')
J "advAddBm.checked=false; advAddBm.dispatchEvent(new Event('change')); return 1" | Out-Null
SetBox 'adv-find' ''
Shot 'advanced'

# bookmarks follow their text when lines are inserted above
$r = J @"
editor.focus(); editor.setSelectionRange(0,0); document.execCommand('insertText', false, 'NEW FIRST LINE\n');
await new Promise(r=>setTimeout(r,400)); return JSON.stringify(getActive().bookmarks);
"@
T 'Bookmarks move down when a line is inserted above' $r ($r -eq '{"2":"Red","3":"Red","4":"Green","8":"Orange"}')
J "runToolbarCommand('undo'); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null

# Ctrl+F2 / F2 in the editor
$r = J @"
editor.focus(); editor.setSelectionRange(0,0);
document.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}));
const l1 = lineOf(lineIndex(getActive()), editor.selectionStart)+1;
document.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',shiftKey:true,bubbles:true}));
const l2 = lineOf(lineIndex(getActive()), editor.selectionStart)+1;
editor.setSelectionRange(lineIndex(getActive()).starts[6], lineIndex(getActive()).starts[6]);
document.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',ctrlKey:true,bubbles:true}));
return l1 + ',' + l2 + '|' + JSON.stringify(getActive().bookmarks);
"@
T 'F2 / Shift+F2 jump between bookmarks, Ctrl+F2 toggles' $r ($r -eq '2,8|{"1":"Red","2":"Red","3":"Green","6":"Orange","7":"Orange"}') # Ctrl+F2 uses the colour last picked (Orange, above)

# Replace All in Advanced mode only touches listed lines
$r = J @"
advFrom.value='5'; advFrom.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300));
findInput.value='ERROR'; findInput.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300));
replaceInput.value='FAIL'; replaceAll(); await new Promise(r=>setTimeout(r,300));
const t=getActive().content; return (t.match(/ERROR/g)||[]).length + '|' + (t.match(/FAIL/g)||[]).length + '|' + findStatus.textContent + '|' + replaceInput.value;
"@
# lines 5-8 contain "ERROR" and "error" (case-insensitive) on line 6; line 4's ERROR is outside the range
T 'Replace All (Advanced) only in listed lines' $r ($r -eq '1|2|Replaced 2|FAIL')
$r = J @"
setLayoutMode('preview-only'); advFrom.value='5'; advFrom.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300));
findInput.value='Retrying'; findInput.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300));
replaceInput.focus(); replaceInput.value='Again'; replaceAll(); await new Promise(r=>setTimeout(r,300));
const out = getActive().content.includes('Again move') + '|' + replaceInput.value; setLayoutMode('edit-only'); return out;
"@
T 'Replace All with the editor hidden edits the file, not the Replace box' $r ($r -eq 'true|Again')
# put the document back exactly as it is on disk
J "const d=getActive(); editor.value=d.savedContent; syncFromEditor(); advFrom.value=''; advFrom.dispatchEvent(new Event('input')); replaceInput.value=''; await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null
J "advFrom.value=''; advFrom.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null

# Basic (non-advanced) find stays literal, F3 navigation
J "advToggle.checked=false; advToggle.dispatchEvent(new Event('change')); findInput.value='Disk space low, on'; findInput.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null
T 'Basic find is literal (commas are text)' (J "return findState.matches.length") ((J "return findState.matches.length") -eq 0)
J "findInput.value='INFO'; findInput.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300)); editor.setSelectionRange(0,0); return 1" | Out-Null
$r = J @"
const pos=[]; for (let i=0;i<3;i++){ document.dispatchEvent(new KeyboardEvent('keydown',{key:'F3',bubbles:true})); pos.push(lineOf(lineIndex(getActive()), findState.matches[findState.index].s)+1);}
document.dispatchEvent(new KeyboardEvent('keydown',{key:'F3',shiftKey:true,bubbles:true})); pos.push(lineOf(lineIndex(getActive()), findState.matches[findState.index].s)+1);
return pos.join(',') + '|' + findStatus.textContent + '|' + edLayer().querySelectorAll('.find-hit').length + '/' + edLayer().querySelectorAll('.find-current').length;
"@
T 'F3 / Shift+F3 step through matches; all hits highlighted' $r ($r -eq '5,7,1,7|3 of 3|3/1')
J "advToggle.checked=true; advToggle.dispatchEvent(new Event('change')); findInput.value=''; findInput.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null

# All tabs scope + sorting
$r = J @"
advScope.value='all'; advScope.dispatchEvent(new Event('change'));
advFind.value='Hello'; advFind.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,400));
return advGrid.classList.contains('show-file') + '|' + [...new Set(findState.rows.map(r=>tabTitle(r.doc)))].join(',');
"@
T 'All open tabs: File column + rows from several tabs' $r ($r -like 'true|*app.js*' -and ($r.Split('|')[1].Split(',').Count -ge 3))
$r = J @"
advScope.value='tab'; advScope.dispatchEvent(new Event('change')); advFind.value=''; advFind.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300));
advHeader.querySelector('[data-sort=text]').click(); const asc=findState.rows.map(r=>r.line+1).join(',');
advHeader.querySelector('[data-sort=text]').click(); const desc=findState.rows.map(r=>r.line+1).join(',');
advHeader.querySelector('[data-sort=line]').click(); return asc + '|' + desc + '|' + advHeader.textContent;
"@
T 'Header click sorts (asc/desc)' $r ($r -like '3,1,2,4,5,6,7,8|8,7,6,5,4,2,1,3|Line # ▲*')

# splitter drag & maximise
$sb = J "const r=advSplitter.getBoundingClientRect(); return Math.round(r.left+300)+','+Math.round(r.top+3)+','+advPane.offsetHeight"
$x, $y, $h0 = $sb.Split(',')
Mouse 'mousePressed' ([int]$x) ([int]$y); Mouse 'mouseMoved' ([int]$x) ([int]$y - 60); Mouse 'mouseMoved' ([int]$x) ([int]$y - 100); Mouse 'mouseReleased' ([int]$x) ([int]$y - 100); Wait1
$h1 = J "return advPane.offsetHeight"
T 'Splitter resizes the pane' "$h0 -> $h1" ([int]$h1 -ge [int]$h0 + 95 -and [int]$h1 -le [int]$h0 + 105)
$r = J "advMax.click(); const a=getComputedStyle(document.querySelector('.main-area')).display; const t=advMax.textContent; advMax.click(); return a + '|' + t + '|' + getComputedStyle(document.querySelector('.main-area')).display"
T 'Maximise fills the window and back' $r ($r -eq 'none|Restore|flex')

# ---------- remembered state across restart ----------
$r = J @"
setLineNumbersVisible(true); setToolbarVisible(true); themeOverride='light'; applyTheme();
advFrom.value='#2'; advFrom.dispatchEvent(new Event('input'));
const w = window.__TAURI__.window.getCurrentWindow();
// Stay on the monitor the window is on (moving it to another monitor with different scaling makes Windows resize it).
const p0 = await w.outerPosition(); window.__winTarget = { x: p0.x + 30, y: p0.y + 20 };
await w.setSize(new window.__TAURI__.dpi.PhysicalSize(1000, 650)); await w.setPosition(new window.__TAURI__.dpi.PhysicalPosition(window.__winTarget.x, window.__winTarget.y));
await new Promise(r=>setTimeout(r,900));
scheduleSessionSave(); await new Promise(r=>setTimeout(r,1000));
return JSON.stringify(windowState);
"@
$before = J "return JSON.stringify({ln:lineNumbersVisible, tb:!toolbarEl.classList.contains('hidden'), theme:document.documentElement.dataset.theme, find:!findBar.classList.contains('hidden'), adv:advToggle.checked, from:advFrom.value, h:findState.paneHeight, active:tabTitle(getActive()), bm:JSON.stringify(getActive().bookmarks), fonts:docs.map(d=>d.fontSize).join(','), win:windowState})"
$winTarget = J "return window.__winTarget.x + ',' + window.__winTarget.y"
$hwnd = [KB]::MainWin([uint32]$script:proc.Id)
[void][W32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
$exited = $script:proc.WaitForExit(6000)
try { $script:ws.Dispose() } catch {}
Start-App $Exe $null -KeepSession
Start-Sleep -Milliseconds 1500
$after = J "return JSON.stringify({ln:lineNumbersVisible, tb:!toolbarEl.classList.contains('hidden'), theme:document.documentElement.dataset.theme, find:!findBar.classList.contains('hidden'), adv:advToggle.checked, from:advFrom.value, h:findState.paneHeight, active:tabTitle(getActive()), bm:JSON.stringify(getActive().bookmarks), fonts:docs.map(d=>d.fontSize).join(','), win:windowState})"
T 'Restart restores line numbers, toolbar, theme, find/Advanced state, bookmarks, per-tab fonts, window' "exited=$exited`nbefore=$before`nafter =$after" ($exited -and $before -eq $after)
$sz = J "const w=window.__TAURI__.window.getCurrentWindow(); const s=await w.innerSize(); const p=await w.outerPosition(); return s.width+'x'+s.height+'@'+p.x+','+p.y"
T 'Window really reopened at saved size/position (no growth)' $sz ($sz -eq "1000x650@$winTarget")
Shot 'restored'

Stop-App
$results | Format-Table -AutoSize -Wrap | Out-String -Width 260
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
