param([string]$Exe)
# Hardening round: the preview sanitiser against a list of attacks, pasting into the preview (links,
# sanitised HTML), the link box on hover, the new-tab format (Markdown / Plain Text, restored as they
# were), the Plain Text preview, split-view scroll sync and keeping the place when switching view.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
function L([string]$s, [string]$pat) { return $s -like $pat.Replace('[', '`[').Replace(']', '`]') }
function Lit([string]$s) { return ($s.Replace("`r`n", "`n") | ConvertTo-Json -Compress) }

Start-App $Exe $null
Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1200; height = 760; deviceScaleFactor = 1; mobile = $false } | Out-Null
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null
J "window.__copied = null; clipboard.writeText = async (t) => { window.__copied = t; }; window.__opened = null; openUrl = (u) => { window.__opened = u; }; window.__alert = 0; return 1" | Out-Null

# --- 1. the preview sanitiser against attacks (Markdown is rendered exactly as for a document) ---
$attacks = @'
Safe **bold**, a [link](https://example.com) and ![img](https://example.com/a.png)

<script>window.__alert++</script>
<img src=x onerror="window.__alert++">
<a href="javascript:window.__alert++">a</a>
<a href="  JaVaScRiPt:window.__alert++">b</a>
<a href="java&#x09;script:window.__alert++">c</a>
<a href="&#106;avascript:window.__alert++">d</a>
<a href="data:text/html,<script>window.__alert++</script>">e</a>
<svg><script>window.__alert++</script><animate onbegin="window.__alert++" attributeName="x"/><a xlink:href="javascript:window.__alert++"><text>s</text></a></svg>
<math><mtext><table><mglyph><style><img src=x onerror="window.__alert++"></style></mglyph></table></mtext></math>
<iframe src="https://example.com"></iframe><object data="x.swf"></object><embed src="x.swf">
<div style="background:url(javascript:alert(1))">css</div>
<form id="preview"><input name="settings"></form>
<img id="editor" src="x.png"><a id="settings" name="docs">clobber</a>
<details open ontoggle="window.__alert++">t</details>
<!-- <img src=x onerror="window.__alert++"> -->
<noscript><p title="</noscript><img src=x onerror=window.__alert++>"></noscript>
'@
$r = J "const d = getActive(); setLayoutMode('preview-only'); setDocLanguage('markdown'); editor.value = $(Lit $attacks); syncFromEditor(); renderPreview(d); await new Promise(r => setTimeout(r, 600)); const bad = [...preview.querySelectorAll('*')].filter(el => [...el.attributes].some(a => /^on/i.test(a.name) || /^\s*(javascript|data:text)/i.test(a.value.replace(/[\s\u0000-\u001f]/g, '')) && /href|src|data|action/.test(a.name))).map(el => el.outerHTML.slice(0, 60)); const banned = preview.querySelectorAll('script, iframe, object, embed, form, animate, set, foreignObject, style, base, meta, link').length; return JSON.stringify([window.__alert, bad, banned, typeof settings.newTabView, editor.id, document.getElementById('preview') === preview, !!preview.querySelector('strong'), !!preview.querySelector('a[href=`"https://example.com`"]')])"
T 'Sanitiser: no attack runs, no handler, script URL, frame, object or style survives; ids not clobbered' $r ($r -eq '[0,[],0,"string","editor",true,true,true]')
$r = J "const before = editor.value; const d = getActive(); preview.focus(); const p = preview.querySelector('p'); const range = document.createRange(); range.selectNodeContents(p); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); document.execCommand('insertText', false, ' more'); await new Promise(r => setTimeout(r, 300)); return JSON.stringify([d.content.includes('<script>window.__alert++</script>'), d.content.includes('<img src=' + String.fromCharCode(34) + 'x' + String.fromCharCode(34) + ' onerror='), d.content.includes('more'), window.__alert])"
T 'Editing the preview keeps the blocked HTML (and the cleaned <img>) unchanged in the source; nothing runs' $r ($r -eq '[true,true,true,0]')
$r = J "renderPreview(getActive()); await new Promise(r => setTimeout(r, 300)); return JSON.stringify([window.__alert, preview.querySelectorAll('script, iframe').length])"
T 'Rendered again after the round trip: still nothing runs' $r ($r -eq '[0,0]')

# --- 2. pasting into the preview ---
function Paste([string]$plain, [string]$html, [string]$setup) {
    J "const d = getActive(); setLayoutMode('preview-only'); editor.value = $(Lit $setup); syncFromEditor(); renderPreview(d); preview.focus(); const range = document.createRange(); range.selectNodeContents(preview.lastElementChild || preview); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); const dt = new DataTransfer(); dt.setData('text/plain', $(Lit $plain)); if ($(Lit $html)) dt.setData('text/html', $(Lit $html)); preview.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 300)); return JSON.stringify([getActive().content, preview.querySelectorAll('a[href]').length, window.__alert])"
}
J "setDocLanguage('markdown'); return 1" | Out-Null
$r = Paste 'https://ffmpeg.org/ffmpeg.html' '' 'See '
T 'Paste a URL into the Markdown preview: a link at once' $r (L $r '["See*https://ffmpeg.org/ffmpeg.html",1,0]')
$r = Paste 'Docs at https://example.com/a and www.example.org.' '' 'Text'
T 'Paste text with URLs: they become links (end punctuation left out)' $r (L $r '["Text*https://example.com/a*www.example.org.",2,0]')
$r = Paste 'x' '<b>bold</b><img src=x onerror="window.__alert++"><script>window.__alert++</script><a href="javascript:alert(1)">bad</a>' 'Start'
T 'Paste HTML: formatting kept, handlers, scripts and script links removed' $r (L $r '["Start*bold**bad*",0,0]' -or (L $r '["Start*bold*bad*",0,0]'))
J "setDocLanguage('bbcode'); return 1" | Out-Null
$r = Paste 'https://example.com/x' '' 'Hi '
T 'Paste a URL into the BBCode preview: [url]' $r (L $r '["Hi*[url]https://example.com/x[/url]",1,0]')
J "setDocLanguage('markdown'); return 1" | Out-Null

# --- 3. the link box on hover ---
$r = J "const d = getActive(); setLayoutMode('preview-only'); editor.value = 'Read [FFmpeg CLI](https://ffmpeg.org/ffmpeg.html) now.'; syncFromEditor(); renderPreview(d); await new Promise(r => setTimeout(r, 200)); const a = preview.querySelector('a'); a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise(r => setTimeout(r, 500)); const pop = document.querySelector('.link-pop'); const url = pop && pop.querySelector('.lp-url').textContent; const btns = pop ? [...pop.querySelectorAll('button')].map(b => b.dataset.act) : []; const ur = pop.querySelector('.lp-url').getBoundingClientRect(), br = pop.querySelector('button').getBoundingClientRect(); pop.querySelector('[data-act=copy]').click(); return JSON.stringify([url, btns, br.left >= ur.right - 1, window.__copied])"
T 'Hovering a link shows its full address with Open and Copy beside it; Copy copies' $r ($r -eq '["https://ffmpeg.org/ffmpeg.html",["open","copy"],true,"https://ffmpeg.org/ffmpeg.html"]')
$r = J "const a = preview.querySelector('a'); a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise(r => setTimeout(r, 500)); document.querySelector('.link-pop [data-act=open]').click(); return JSON.stringify([window.__opened, !!document.querySelector('.link-pop')])"
T 'Open opens the link and closes the box' $r ($r -eq '["https://ffmpeg.org/ffmpeg.html",false]')

# --- 4. new-tab format and the Plain Text preview ---
$r = J "return JSON.stringify([settings.newTabFormat, settings.syncScroll])"
T 'Defaults: new tabs are Markdown, scroll sync is on' $r ($r -eq '["markdown",true]')
$r = J "const a = newUntitledDoc(); addDocAndActivate(a); a.content = '# md tab'; changeSetting('newTabFormat', 'plaintext'); const before = getActive().lang; openNewTab(); await new Promise(r => setTimeout(r, 200)); const b = getActive(); b.content = '# not a heading'; editor.value = b.content; syncFromEditor(); setLayoutMode('preview-only'); renderPreview(b); await new Promise(r => setTimeout(r, 200)); return JSON.stringify([before, a.lang, b.lang, preview.getAttribute('contenteditable'), !!preview.querySelector('h1'), preview.textContent, langInfo(b).exts[0], langInfo(a).exts[0]])"
T 'Plain Text new tab: shown as written (no Markdown), editable as text; the Markdown tab is unchanged; .txt / .md suggested' $r ($r -eq '["markdown","markdown","plaintext","plaintext-only",false,"# not a heading","txt","md"]')
$r = J "const b = getActive(); preview.focus(); const r = document.createRange(); r.selectNodeContents(preview); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('insertText', false, '\n**still text**'); await new Promise(r => setTimeout(r, 200)); return JSON.stringify(b.content)"
T 'Typing in the Plain Text preview writes plain text to the source' $r ($r -eq '"# not a heading\n**still text**"')
$r = J "const b = getActive(); const x = [...document.querySelectorAll('#toolbar [data-cmd=bold], #toolbar [data-heading=`"1`"]')].map(e => e.disabled); return JSON.stringify(x)"
T 'Toolbar formatting is off on Plain Text tabs' $r ($r -eq '[true,true]')
$r = J "const ids = docs.map(d => d.id + ':' + d.lang).join(','); await saveSessionNow(); return ids"
Stop-App
Start-App $Exe $null -KeepSession
$r2 = J "return JSON.stringify([docs.filter(d => !d.path).map(d => d.lang), settings.newTabFormat])"
T 'After a restart each tab keeps its own format, and the setting is remembered' "$r -> $r2" ((L $r2 '*"markdown"*"plaintext"*') -and (L $r2 '*,"plaintext"]'))
$r = J "const old = { app: 'NotePad-MD', kind: 'settings', version: 1, settings: { tabSize: 2 } }; applyImportedSettings(old); return JSON.stringify([settings.newTabFormat, settings.syncScroll, exportableSettings().settings.newTabFormat])"
T 'Importing older settings (no format): Markdown and sync on; exports include the setting' $r ($r -eq '["markdown",true,"markdown"]')
J "changeSetting('newTabFormat', 'markdown'); return 1" | Out-Null

# --- 5. split view follows, switching view keeps the place ---
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null
$long = (1..120 | ForEach-Object { "## Section $_`n`nParagraph $_ with some text that is long enough to wrap in a narrow pane, about the topic of section number $_.`n`n- item $_ a`n- item $_ b`n" }) -join "`n"
J "const d = newUntitledDoc(); addDocAndActivate(d); setDocLanguage('markdown'); editor.value = $(Lit $long); syncFromEditor(); setLayoutMode('split-ep'); renderPreview(d); await new Promise(r => setTimeout(r, 800)); return 1" | Out-Null
function SectionAtTop([string]$pane) {
    if ($pane -eq 'preview') { return J "const top = preview.getBoundingClientRect().top; const h = [...preview.querySelectorAll('h2')].filter(h => h.getBoundingClientRect().bottom > top + 2)[0]; return h ? Number(h.textContent.replace(/\D/g, '')) : -1" }
    return J "const pos = offsetForEditorY(editor.scrollTop + 4); const before = editor.value.slice(0, pos + 200); const m = [...before.matchAll(/## Section (\d+)/g)]; const after = /## Section (\d+)/.exec(editor.value.slice(pos)); return m.length ? Number((editor.value.slice(pos).startsWith('## Section') ? after[1] : m[m.length - 1][1])) : -1"
}
$r = J "editor.scrollTop = editorYForOffset(editor.value.indexOf('## Section 60')); editor.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 300)); return 1"
$e = SectionAtTop 'editor'; $p = SectionAtTop 'preview'
T 'Split view: scrolling the editor to section 60 brings the preview there' "editor=$e preview=$p" ([Math]::Abs([int]$e - [int]$p) -le 1 -and [int]$p -ge 58)
$r = J "preview.scrollTop = previewYForOffset(getActive(), editor.value.indexOf('## Section 90')); preview.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 300)); return 1"
$e = SectionAtTop 'editor'; $p = SectionAtTop 'preview'
T 'Split view: scrolling the preview to section 90 brings the editor there' "editor=$e preview=$p" ([Math]::Abs([int]$e - [int]$p) -le 1 -and [int]$e -ge 88)
$r = J "editor.focus(); const pos = editor.value.indexOf('Paragraph 20 with'); revealRange(getActive(), pos, pos, true); await new Promise(r => setTimeout(r, 200)); editor.setSelectionRange(pos, pos); editor.dispatchEvent(new KeyboardEvent('keyup')); await new Promise(r => setTimeout(r, 300)); const t = [...preview.querySelectorAll('p')].find(p => p.textContent.startsWith('Paragraph 20 ')); const r = t.getBoundingClientRect(), pr = preview.getBoundingClientRect(); return JSON.stringify(r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1)"
T 'Split view: moving the caret (no typing) brings its paragraph into the preview' $r ($r -eq 'true')

# Switching view without editing: caret on section 75 in Edit -> Preview shows it -> back to Edit, caret kept.
$r = J "setLayoutMode('edit-only'); await new Promise(r => setTimeout(r, 200)); editor.focus(); const pos = editor.value.indexOf('Paragraph 75 with') + 10; editor.setSelectionRange(pos, pos); revealRange(getActive(), pos, pos, true); editor.dispatchEvent(new KeyboardEvent('keyup')); window.__pos = pos; setLayoutMode('preview-only'); focusForTyping(); await new Promise(r => setTimeout(r, 400)); const t = [...preview.querySelectorAll('p')].find(p => p.textContent.startsWith('Paragraph 75 ')); const r = t.getBoundingClientRect(), pr = preview.getBoundingClientRect(); const sel = getSelection(); return JSON.stringify([r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1, t.contains(sel.anchorNode)])"
T 'Edit -> Preview: the paragraph with the caret is in view, and the preview caret is in it' $r ($r -eq '[true,true]')
$r = J "setLayoutMode('edit-only'); focusForTyping(); await new Promise(r => setTimeout(r, 300)); const y = editorYForOffset(window.__pos); return JSON.stringify([editor.selectionStart === window.__pos || Math.abs(editor.selectionStart - window.__pos) < 60, y >= editor.scrollTop && y <= editor.scrollTop + editor.clientHeight, getActive().content.length === $($long.Length)])"
T 'Preview -> Edit: the same place is in view and the caret is back there; no text changed' $r ($r -eq '[true,true,true]')
$r = J "setLayoutMode('preview-only'); await new Promise(r => setTimeout(r, 300)); preview.scrollTop = previewYForOffset(getActive(), editor.value.indexOf('## Section 30')); preview.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 150)); setLayoutMode('edit-only'); await new Promise(r => setTimeout(r, 300)); return 1"
$e = SectionAtTop 'editor'
T 'Scrolling the preview (caret elsewhere), then Edit: the editor shows what was being looked at' "editor=$e" ([Math]::Abs([int]$e - 30) -le 1)
J "changeSetting('syncScroll', false); setLayoutMode('split-ep'); await new Promise(r => setTimeout(r, 300)); return 1" | Out-Null
$before = SectionAtTop 'preview'
J "editor.scrollTop = editorYForOffset(editor.value.indexOf('## Section 100')); editor.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 300)); return 1" | Out-Null
$after = SectionAtTop 'preview'
T 'Sync off: scrolling the editor leaves the preview alone' "preview before=$before after=$after" ($before -eq $after)
$r = J "editor.focus(); const pos = editor.value.indexOf('Paragraph 110 with'); editor.setSelectionRange(pos, pos); editor.dispatchEvent(new KeyboardEvent('keyup')); setLayoutMode('preview-only'); await new Promise(r => setTimeout(r, 400)); const t = [...preview.querySelectorAll('p')].find(p => p.textContent.startsWith('Paragraph 110 ')); const r = t.getBoundingClientRect(), pr = preview.getBoundingClientRect(); return JSON.stringify(r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1)"
T 'Sync off: switching view still keeps the place' $r ($r -eq 'true')
J "changeSetting('syncScroll', true); return 1" | Out-Null
$r = J "const t0 = performance.now(); for (let i = 0; i < 50; i++) { editor.scrollTop += 37; editor.dispatchEvent(new Event('scroll')); await new Promise(r => requestAnimationFrame(r)); } setLayoutMode('split-ep'); return Math.round((performance.now() - t0) / 50)"
T 'Scrolling in split view stays smooth (ms per frame)' $r ([int]$r -lt 40)
Stop-App

$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
