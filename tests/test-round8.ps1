param([string]$Exe)
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
. "$PSScriptRoot\cdpkeys.ps1"
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class MN {
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
    [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr m, int i);
    [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr m, uint i, uint f);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr m, uint i, StringBuilder sb, int max, uint f);
    public static string Text(IntPtr m, int i) { var sb = new StringBuilder(128); GetMenuString(m, (uint)i, sb, 128, 0x400); return sb.ToString(); }
}
"@ -ErrorAction SilentlyContinue

$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) {
    [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" })
}
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message + ' @ ' + (e.stack||'').split('\n')[1]; } })()" }
function Shot([string]$name) {
    $r = Cdp 'Page.captureScreenshot' @{ format = 'png' }
    [IO.File]::WriteAllBytes("$sp\r8-$name.png", [Convert]::FromBase64String($r.result.data))
}
function Mouse([string]$type, [double]$x, [double]$y, [string]$button = 'left', [int]$count = 1, [int]$mods = 0) {
    $b = @{ none = 0; left = 1; right = 2 }[$button]
    Cdp 'Input.dispatchMouseEvent' @{ type = $type; x = $x; y = $y; button = $button; buttons = $b; clickCount = $count; modifiers = $mods } | Out-Null
}
function Click([double]$x, [double]$y, [string]$button = 'left', [int]$mods = 0) { Mouse 'mouseMoved' $x $y 'none' 1 $mods; Mouse 'mousePressed' $x $y $button 1 $mods; Mouse 'mouseReleased' $x $y $button 1 $mods }
function DblClick([double]$x, [double]$y) { Click $x $y; Mouse 'mousePressed' $x $y 'left' 2; Mouse 'mouseReleased' $x $y 'left' 2 }
function Pt([string]$jsRectExpr) { $r = J "const r=($jsRectExpr); if(!r) return 'none'; return JSON.stringify({x:r.left+Math.min(8,r.width/2),y:r.top+r.height/2})"; if ($r -eq 'none' -or $r -like 'EXC*') { return $null }; return ($r | ConvertFrom-Json) }
function FindIn([IntPtr]$s, [string]$label) { for ($j = 0; $j -lt [MN]::GetMenuItemCount($s); $j++) { if ([MN]::Text($s, $j) -like "$label*") { return @($s, $j) }; $sub = [MN]::GetSubMenu($s, $j); if ($sub -ne [IntPtr]::Zero) { $x = FindIn $sub $label; if ($x) { return $x } } }; return $null }
function MenuWithText([string]$label) { return (FindIn ([MN]::GetMenu($script:hwnd)) $label) }
function Ticked([string]$label) { $x = MenuWithText $label; if (-not $x) { return 'missing' }; return (([MN]::GetMenuState($x[0], [uint32]$x[1], 0x400) -band 8) -ne 0) }

$W = "$sp\work8"; Remove-Item $W -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $W | Out-Null
[IO.File]::WriteAllText("$W\links.md", "https://example.com/browse/MF-1`nhttps://example.com/browse/MF-2`nhttps://example.com/browse/MF-3`n")
[IO.File]::WriteAllText("$W\old name.txt", "hello`n")

Start-App $Exe $null
Focus-App | Out-Null

# ---------- the cause of the broken right-click menus ----------
$r = J "const ids=[...document.querySelectorAll('[id]')].map(e=>e.id); return ids.filter((v,i)=>ids.indexOf(v)!==i).join(',')"
T 'No duplicate element ids in the page' "dupes=[$r]" ($r -eq '')

# ---------- tab right-click menu (real mouse) ----------
J "editor.value='x'; editor.dispatchEvent(new Event('input')); return 1" | Out-Null
$p = Pt "document.querySelector('.tab .tab-title').getBoundingClientRect()"
Click $p.x $p.y 'right'; Start-Sleep -Milliseconds 300
$r = J "return ctxMenu.classList.contains('hidden') + '|' + ctxMenu.getBoundingClientRect().height"
T 'Tab right-click menu is shown' $r ($r -like 'false|*' -and $r -notlike '*|0')
$p = Pt "[...ctxMenu.querySelectorAll('button')].find(b=>b.textContent.includes('Pin Tab')).getBoundingClientRect()"
Click $p.x $p.y; Start-Sleep -Milliseconds 300
$r = J "return docs[0].pinned + '|' + ctxMenu.classList.contains('hidden')"
T 'Clicking Pin Tab in it works' $r ($r -eq 'true|true')
J "togglePin(docs[0].id); return 1" | Out-Null

# ---------- spelling right-click ----------
J "setLayoutMode('edit-only'); editor.focus(); editor.value='This is a mispeled word'; editor.dispatchEvent(new Event('input')); return 1" | Out-Null
Start-Sleep -Milliseconds 1500
$p = Pt "edLayer().querySelector('.spell-err').getClientRects()[0]"
Click $p.x $p.y 'right'; Start-Sleep -Milliseconds 1200
$r = J "return [...ctxMenu.querySelectorAll('.ctx-label')].map(e=>e.textContent).join('|')"
T 'Misspelt word right-click shows suggestions' $r ($r -like 'misspelled*Add "mispeled" to dictionary|Ignore')
$p = Pt "[...ctxMenu.querySelectorAll('button')].find(b=>b.textContent.trim()==='misspelled').getBoundingClientRect()"
Click $p.x $p.y; Start-Sleep -Milliseconds 300
$r = J "return JSON.stringify(editor.value)"
T 'Picking a suggestion corrects the word' $r ($r -eq '"This is a misspelled word"')
Shot 'spell'

# ---------- Tab key in the editor ----------
J "editor.focus(); editor.value='abc'; editor.setSelectionRange(3,3); editor.dispatchEvent(new Event('input')); return 1" | Out-Null
Send-Key @() 'Tab' 'Tab' 9
$r = J "return JSON.stringify(editor.value) + '|' + (editorHasFocus())"
T 'Tab inserts a tab and keeps focus in the editor' $r ($r -eq '"abc\t"|true')
J "editor.value='one\ntwo\nthree'; editor.dispatchEvent(new Event('input')); editor.setSelectionRange(0, 7); return 1" | Out-Null
Send-Key @() 'Tab' 'Tab' 9
$r = J "return JSON.stringify(editor.value)"
T 'Tab with lines selected indents them' $r ($r -eq '"\tone\n\ttwo\nthree"')
Send-Key @('SHIFT') 'Tab' 'Tab' 9
$r = J "return JSON.stringify(editor.value)"
T 'Shift+Tab outdents them' $r ($r -eq '"one\ntwo\nthree"')
Send-Key @('CTRL') 'z' 'KeyZ' 90
$r = J "return JSON.stringify(editor.value)"
T 'Ctrl+Z undoes the outdent' $r ($r -eq '"\tone\n\ttwo\nthree"')

# ---------- indent guides ----------
J "editor.value='root\n\tlevel1\n\t\tlevel2\n        eight spaces'; editor.dispatchEvent(new Event('input')); return 1" | Out-Null
Start-Sleep -Milliseconds 200
$r = J "return edLayer().querySelectorAll('.ig').length + '|' + editorHighlight.textContent.length + '|' + editor.value.length"
T 'Indent guides drawn (1+2+2), text unchanged' $r ($r -eq '5|42|42')
Shot 'guides'

# ---------- links in the editor ----------
J "editor.value='See https://example.com/a?x=1&y=2. and (https://en.wikipedia.org/wiki/Foo_(bar))'; editor.dispatchEvent(new Event('input')); return 1" | Out-Null
Start-Sleep -Milliseconds 200
$r = J "return [...edLayer().querySelectorAll('.ov-url')].map(s=>s.textContent).join('') + '|' + urlRanges(editor.value).length"
T 'Links are underlined in the editor' $r ($r -eq 'https://example.com/a?x=1&y=2https://en.wikipedia.org/wiki/Foo_(bar)|2')
J "window.__opened=null; openUrl=(u)=>{window.__opened=u}; return 1" | Out-Null
$p = Pt "edLayer().querySelector('.ov-url').getClientRects()[0]"
Click ($p.x + 30) $p.y 'left' 0
$r = J "return String(window.__opened)"
T 'Plain click on a link only places the caret' $r ($r -eq 'null')
Click ($p.x + 30) $p.y 'left' 2
$r = J "return String(window.__opened)"
T 'Ctrl+click on a link opens it' $r ($r -eq 'https://example.com/a?x=1&y=2')

# ---------- new lines in the preview (page of URLs) ----------
$lp = "$W\links.md".Replace('\', '\\')
J "await openPath('$lp'); setLayoutMode('preview-only'); return 1" | Out-Null
Start-Sleep -Milliseconds 300
$r = J "return preview.querySelectorAll('a').length + '|' + preview.querySelectorAll('br').length"
T 'Each line of the URL list stays on its own line' $r ($r -eq '3|2')
Shot 'links-preview'
J "preview.focus(); const a=preview.querySelector('a'); placeCaret(a.firstChild, 5); document.execCommand('insertText', false, 's'); return 1" | Out-Null
$r = J "return JSON.stringify(getActive().content)"
T 'Editing the preview keeps the lines (no trailing spaces)' $r ($r -eq '"httpss://example.com/browse/MF-1\nhttps://example.com/browse/MF-2\nhttps://example.com/browse/MF-3"')

# ---------- lists: no indent drift, Tab nests ----------
J "addDocAndActivate(newUntitledDoc()); setLayoutMode('preview-only'); editor.value='- one\n- two\n- three'; syncFromEditor(); renderPreview(getActive()); return 1" | Out-Null
J "preview.focus(); const li=preview.querySelectorAll('li')[0]; placeCaret(li.firstChild, 3); document.execCommand('insertText', false, '!'); return 1" | Out-Null
$r = J "return JSON.stringify(getActive().content)"
T 'Preview edit keeps "- item" (one space)' $r ($r -eq '"- one!\n- two\n- three"')
J "preview.focus(); const li=preview.querySelectorAll('li')[1]; placeCaret(li.firstChild, 1); return 1" | Out-Null
Send-Key @() 'Tab' 'Tab' 9
$r = J "return JSON.stringify(getActive().content) + '|' + (document.activeElement===preview)"
T 'Tab in a preview list item nests it' $r ($r -eq '"- one!\n  - two\n- three"|true')
J "for (let i=0;i<3;i++){ syncFromPreview(); renderPreview(getActive()); } return 1" | Out-Null
$r = J "return JSON.stringify(getActive().content)"
T 'Repeated round trips do not grow the indent' $r ($r -eq '"- one!\n  - two\n- three"')
J "const li=preview.querySelectorAll('li')[1]; preview.focus(); placeCaret(li.firstChild, 1); return 1" | Out-Null
Send-Key @('SHIFT') 'Tab' 'Tab' 9
$r = J "return JSON.stringify(getActive().content)"
T 'Shift+Tab un-nests it' $r ($r -eq '"- one!\n- two\n- three"')

# ---------- getting out of a code block ----------
J "editor.value=''; syncFromEditor(); renderPreview(getActive()); preview.focus(); placeCaret(preview, 0); codeBlockPreview(); return 1" | Out-Null
$r = J "return preview.lastElementChild.nodeName + '|' + preview.querySelectorAll('pre').length"
T 'A code block always has a paragraph after it' $r ($r -eq 'P|1')
J "const c=preview.querySelector('pre code'); placeCaret(c.firstChild, c.firstChild.length); return 1" | Out-Null
Send-Key @() 'ArrowDown' 'ArrowDown' 40
$r = J "const n=selectionNode(); return (n && n.closest('pre') ? 'in-pre' : n ? n.nodeName : 'none')"
T 'Arrow Down at the end of a code block leaves it' $r ($r -eq 'P')
Send-Key @() 'x' 'KeyX' 88 'x'
$r = J "return JSON.stringify(getActive().content)"
T 'Typing after it goes below the block' $r ($r -eq '"``````\ncode\n``````\n\nx"'.Replace('``````', '```'))
# Enter twice at the end of a code block
J "const F=String.fromCharCode(96).repeat(3); editor.value=F+'\nabc\n'+F; syncFromEditor(); renderPreview(getActive()); const c=preview.querySelector('pre code'); preview.focus(); placeCaret(c.firstChild, 3); return 1" | Out-Null
Send-Combo 'ENTER'
Send-Combo 'ENTER'
$r = J "const n=selectionNode(); return (n && n.closest('pre') ? 'in-pre' : n ? n.nodeName : 'none') + '|' + JSON.stringify(preview.querySelector('pre code').textContent)"
T 'Enter on an empty last line leaves the code block' $r ($r -eq 'P|"abc"')
J "editor.value=''; syncFromEditor(); return 1" | Out-Null

# ---------- rename tabs ----------
$p = Pt "document.querySelector('.tab.active .tab-title').getBoundingClientRect()"
DblClick $p.x $p.y; Start-Sleep -Milliseconds 300
$r = J "const i=document.querySelector('.tab-rename'); return i ? i.value + '|' + (document.activeElement===i) : 'none'"
T 'Double-clicking a tab name starts renaming' $r ($r -like 'Untitled*|true')
J "const i=document.activeElement; i.value=''; return 1" | Out-Null
foreach ($ch in 'Notes'.ToCharArray()) { Send-Key @() "$ch" "Key$([char]::ToUpper($ch))" ([int][char]::ToUpper($ch)) "$ch" }
Send-Combo 'ENTER'
$r = J "return document.querySelector('.tab.active .tab-title').textContent + '|' + getActive().customTitle + '|' + lastWindowTitle"
T 'Untitled tab renamed' $r ($r -like 'Notes|Notes|*Notes*')
J "saveSessionNow && await saveSessionNow(); return 1" | Out-Null
$f = "$W\old name.txt".Replace('\', '\\')
J "await openPath('$f'); return 1" | Out-Null
$p = Pt "document.querySelector('.tab.active .tab-title').getBoundingClientRect()"
DblClick $p.x $p.y; Start-Sleep -Milliseconds 300
$r = J "const i=document.querySelector('.tab-rename'); return i.value.slice(i.selectionStart, i.selectionEnd)"
T 'Rename selects the name without the extension' $r ($r -eq 'old name')
J "const i=document.querySelector('.tab-rename'); i.value='new name.md'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await new Promise(r=>setTimeout(r,400)); return 1" | Out-Null
$r = J "return getActive().path + '|' + getActive().lang + '|' + document.querySelector('.tab.active .tab-title').textContent"
T 'Saved file renamed on disk (language follows)' "$r old=$(Test-Path "$W\old name.txt") new=$(Test-Path "$W\new name.md")" ($r -like '*\new name.md|markdown|new name.md' -and -not (Test-Path "$W\old name.txt") -and (Test-Path "$W\new name.md"))
[IO.File]::WriteAllText("$W\taken.md", "x")
$rn = J "const d=getActive(); window.__rn = renameDoc(d, 'taken.md').then(()=>'done', e=>'ERR '+e); return 1"
Start-Sleep -Milliseconds 900
$dlg = Has-Dialog
Close-Dialogs | Out-Null
$r = J "return getActive().path"
T 'Renaming onto an existing file is refused' "$r dialog=$dlg rn=$rn" ($r -like '*\new name.md' -and $dlg)

# ---------- tab header font size ----------
J "openSettings(); const i=settingsEl.querySelector('[data-s=tabFontSize]'); i.value='16'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1" | Out-Null
$r = J "return getComputedStyle(document.querySelector('.tab')).fontSize + '|' + settings.tabFontSize"
T 'Tab header font size setting' $r ($r -eq '16px|16')
Shot 'tabfont'
J "const i=settingsEl.querySelector('[data-s=tabFontSize]'); i.value='12.5'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1" | Out-Null

# ---------- dark scrollbars ----------
J "themeOverride='dark'; applyTheme(); return 1" | Out-Null
$r = J "return getComputedStyle(document.documentElement).colorScheme + '|' + getComputedStyle(document.querySelector('.modal-body')).scrollbarColor + '|' + getComputedStyle(toolbarEl).scrollbarColor"
T 'Dark theme: dark scrollbars in Settings and the toolbar' $r ($r -like 'dark|rgb(74, 74, 74) rgba(0, 0, 0, 0)|rgb(74, 74, 74) rgba(0, 0, 0, 0)')
Shot 'settings-dark'
J "closeSettings(); return 1" | Out-Null

# ---------- native menu: order and ticks ----------
$m = [MN]::GetMenu($script:hwnd)
$tops = (0..([MN]::GetMenuItemCount($m) - 1) | ForEach-Object { [MN]::Text($m, $_) }) -join ','
T 'Menu order File, Edit, View, Search, About' $tops ($tops -eq 'File,Edit,View,Search,About')
J "changeSetting('wordWrap', true); return 1" | Out-Null; Start-Sleep -Milliseconds 300
$a = Ticked 'Word Wrap'
J "changeSetting('wordWrap', false); return 1" | Out-Null; Start-Sleep -Milliseconds 300
$b = Ticked 'Word Wrap'
J "changeSetting('wordWrap', true); return 1" | Out-Null; Start-Sleep -Milliseconds 300
T 'Word Wrap tick follows the setting' "on=$a off=$b" ($a -eq $true -and $b -eq $false)
J "setLayoutMode('split-ep'); return 1" | Out-Null; Start-Sleep -Milliseconds 300
$r = "edit=$(Ticked 'Edit Only') split=$(Ticked 'Edit Left') md=$(Ticked 'Preview as Markdown') bb=$(Ticked 'Preview as BBCode') dark=$(Ticked 'Dark Theme') spell=$(Ticked 'Spell Check') gb=$(Ticked 'English (UK)') us=$(Ticked 'English (US)')"
T 'Layout, preview mode, theme and spelling ticks' $r ($r -eq 'edit=False split=True md=True bb=False dark=True spell=True gb=True us=False')

# ---------- version ----------
$r = J "await showAbout(); await new Promise(r=>setTimeout(r,300)); return aboutEl.querySelector('.about-name').textContent.trim()"
T "About shows v$AppVersion" $r ($r -eq "notepad.md v$AppVersion")

Stop-App

$results | Format-Table -AutoSize -Wrap | Out-String -Width 260
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
