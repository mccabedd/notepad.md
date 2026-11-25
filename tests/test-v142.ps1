param([string]$Exe)
# The find bar's Aa / ab / .* buttons, Clear, recent searches, In selection and Bookmark All; every
# question / message box being the in-window dialog; the link box only for links that hide their address.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
$wait = 'await new Promise(r => setTimeout(r, 250));'
$key = 'const key = (k) => document.getElementById(''save-ask'').dispatchEvent(new KeyboardEvent(''keydown'', { key: k, bubbles: true }));'
$dlg = 'const dlg = () => { const b = document.getElementById(''save-ask''); return { shown: !b.classList.contains(''hidden''), title: document.getElementById(''save-ask-title'').textContent, text: document.getElementById(''save-ask-text'').textContent, kind: b.querySelector(''.save-ask-icon'').dataset.kind, buttons: [...b.querySelectorAll(''.modal-foot button'')].map(x => x.textContent), focus: document.activeElement.textContent }; };'

Start-App $Exe $null
Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1100; height = 720; deviceScaleFactor = 1; mobile = $false } | Out-Null
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null

# ---------- dialogs ----------
$r = J "$key $dlg const p = dialogApi.ask('Discard your changes?', { title: 'Reload from Disk', kind: 'warning', okLabel: 'Reload', cancelLabel: 'Cancel' }); $wait const a = dlg(); key('Escape'); const ans = await p; return JSON.stringify([a.shown, a.title, a.kind, a.buttons, a.focus, ans, dlg().shown])"
T 'ask() with custom buttons is the in-window dialog (warning icon); Esc = Cancel = false' $r ($r -eq '[true,"Reload from Disk","warning",["Reload","Cancel"],"Reload",false,false]')
$r = J "$key $dlg const p = dialogApi.ask('Remove all bookmarks?', { title: 'Clear Bookmarks' }); $wait const a = dlg(); key('y'); return JSON.stringify([a.buttons, a.kind, await p])"
T 'ask() default buttons Yes / No; Y answers Yes' $r ($r -eq '[["Yes","No"],"question",true]')
$r = J "$key $dlg const p = dialogApi.message('Could not save.', { title: 'Save', kind: 'error' }); $wait const a = dlg(); document.querySelector('#save-ask .modal-foot button').click(); await p; return JSON.stringify([a.buttons, a.kind, dlg().shown])"
T 'message() is the in-window dialog with OK (error icon)' $r ($r -eq '[["OK"],"error",false]')
$r = J "$key $dlg const about = document.getElementById('about'); about.classList.remove('hidden'); const p = dialogApi.ask('Update now?', { title: 'Update available', okLabel: 'Update now', cancelLabel: 'Later' }); $wait const panel = document.querySelector('#save-ask .modal-panel').getBoundingClientRect(); const top = document.elementFromPoint(panel.left + panel.width / 2, panel.top + panel.height / 2); const onTop = !!top.closest('#save-ask'); key('Escape'); await p; about.classList.add('hidden'); return JSON.stringify([onTop, document.activeElement.closest ? !document.activeElement.closest('#save-ask') : true])"
T 'A question asked from About appears on top of About' $r ($r -eq '[true,true]')
$r = J "$key $dlg addDocAndActivate(newUntitledDoc()); setLayoutMode('edit-only'); editor.value = 'a\nb\nc'; syncFromEditor(); setBookmarks(getActive(), [0, 2], 'Green'); const p = clearAllBookmarks(getActive()); $wait const a = dlg(); key('Enter'); await p; return JSON.stringify([a.title, a.buttons, Object.keys(getActive().bookmarks).length])"
T 'Real flow: Clear all bookmarks asks in the window, Enter = Yes clears them' $r ($r -eq '["Clear Bookmarks",["Yes","No"],0]')
$r = J "$key $dlg const p = deleteActiveFile(); $wait const a = dlg(); key('Enter'); await p; return JSON.stringify([a.title, a.text, a.kind, a.buttons])"
T 'Real flow: Delete File on an unsaved tab shows the in-window message' $r ($r -eq '["Delete File","This file has not been saved yet.","info",["OK"]]')

# ---------- link box ----------
$r = J "const d = getActive(); setLayoutMode('preview-only'); setDocLanguage('markdown'); editor.value = '<https://learn.microsoft.com/en-us/dotnet/desktop/wpf/overview/>\n\n[Microsoft WPF overview](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/overview/)\n\nhttps://example.com/x'; syncFromEditor(); renderPreview(d); $wait const hover = async (a) => { hideLinkPopup(); a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise(r => setTimeout(r, 500)); return !!document.querySelector('.link-pop'); }; const a = preview.querySelectorAll('a'); const res = [a.length, await hover(a[0]), await hover(a[1]), await hover(a[2])]; hideLinkPopup(); return JSON.stringify(res)"
T 'Link box: not for a link showing its full address, shown for a named link' $r ($r -eq '[3,false,true,false]')

# ---------- find bar buttons ----------
$r = J "setLayoutMode('edit-only'); setDocLanguage('plaintext'); editor.value = 'Foo foo food\nfoo bar'; syncFromEditor(); openFindBar(false); findInput.value = 'foo'; findInput.dispatchEvent(new Event('input')); $wait const n = () => findState.matches.length; const out = [n()]; document.getElementById('find-case').click(); $wait out.push(n(), advCase.checked, document.getElementById('find-case').getAttribute('aria-pressed')); document.getElementById('find-word').click(); $wait out.push(n()); document.getElementById('find-case').click(); document.getElementById('find-word').click(); findInput.value = 'fo+d'; findInput.dispatchEvent(new Event('input')); $wait out.push(n()); document.getElementById('find-regex').click(); $wait out.push(n(), findStatus.textContent); document.getElementById('find-regex').click(); return JSON.stringify(out)"
T 'Aa / ab / .* work on the basic find bar (same settings as Advanced)' $r ($r -eq '[4,3,true,"true",2,0,1,"1 of 1"]')
$r = J "findInput.value = 'fo+d'; findInput.dispatchEvent(new Event('input')); $wait stepMatch(1); findInput.value = 'bar'; findInput.dispatchEvent(new Event('input')); $wait stepMatch(1); document.getElementById('find-clear').click(); $wait return JSON.stringify([findInput.value, advFind.value, findStatus.textContent, findState.matches.length, document.activeElement === findInput, findState.history.find.slice(0, 2)])"
T 'Clear empties the Find box (and remembers what was there)' $r ($r -eq '["","","",0,true,["bar","fo+d"]]')
$r = J "document.getElementById('find-hist').click(); $wait const items = [...ctxMenu.querySelectorAll('button .ctx-label')].map(x => x.textContent); const box = findInput.getBoundingClientRect(); const above = ctxMenu.getBoundingClientRect().bottom <= box.top + 1; ctxMenu.querySelectorAll('button')[1].click(); $wait return JSON.stringify([items.slice(0, 2), items.includes('Clear this list'), above, findInput.value, findState.matches.length])"
T 'Recent searches list opens above the box; picking one searches for it' $r ($r -eq '[["bar","fo+d"],true,true,"fo+d",0]')

# ---------- In selection ----------
$r = J "editor.value = 'a x a\na x a\na x a'; syncFromEditor(); findInput.value = 'a'; findInput.dispatchEvent(new Event('input')); $wait editor.focus(); editor.setSelectionRange(6, 11); document.getElementById('find-insel').click(); $wait const before = [findState.matches.length, findStatus.textContent]; replaceInput.value = 'bb'; replaceAll(); $wait return JSON.stringify([before, editor.value, findState.inSel && [findState.inSel.s, findState.inSel.e], findState.matches.length, findState.history.replace[0]])"
T 'In selection: finds and Replace All only inside the selected text' $r ($r -eq '[[2,"1 of 2 in selection"],"a x a\nbb x bb\na x a",[6,13],0,"bb"]')
$r = J "document.getElementById('find-insel').click(); $wait const off = [findState.inSel, findState.matches.length]; setLayoutMode('preview-only'); document.getElementById('find-insel').click(); const pv = [findState.inSel, findStatus.textContent.startsWith('In selection works on the editor')]; setLayoutMode('edit-only'); editor.setSelectionRange(3, 3); document.getElementById('find-insel').click(); return JSON.stringify([off, pv, findState.inSel, findStatus.textContent.startsWith('Select some text')])"
T 'In selection: off again searches everything; needs a selection in the editor' $r ($r -eq '[[null,4],[null,true],null,true]')

# ---------- Bookmark All ----------
$r = J "setBookmarkColour('Orange'); editor.value = 'ok\nerror one\nok\nERROR two error\nok'; syncFromEditor(); findInput.value = 'error'; findInput.dispatchEvent(new Event('input')); $wait document.getElementById('find-bookmark').click(); $wait const bm = JSON.stringify(getActive().bookmarks) + '|' + findStatus.textContent; setBookmarkColour('Green'); return bm"
T 'Bookmark All bookmarks each line with a match, in the current colour' $r ($r -eq '{"1":"Orange","3":"Orange"}|Bookmarked 2 lines (orange)')

# ---------- history survives a restart ----------
$r = J "const d = getActive(); d.content = d.savedContent = ''; d.dirty = false; await saveSessionNow(); return JSON.stringify(findState.history)"
Stop-App
Start-App $Exe $null -KeepSession
$r2 = J "return JSON.stringify(findState.history)"
T 'Recent searches and replacements are remembered after a restart' "$r2" ($r2 -eq $r -and $r2 -like '*"bb"*' -and $r2 -like '*"error"*')
Stop-App

$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
