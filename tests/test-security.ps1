param([string]$Exe)
# Adversarial checks for the preview's HTML cleaning (DOMPurify + the app's own rules), the editable
# preview's round trip of removed HTML, HTML export, and BBCode. Every attack sets window.__pwn if it
# ever runs; none may. Runs in the test profile only.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
$utf8 = New-Object Text.UTF8Encoding $false
$work = "$sp\work-security"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
$w = $work.Replace('\', '/')

# Each line is one attack; they are rendered one at a time so a failure names the attack.
$attacks = @(
    '<img src=x onerror="window.__pwn=1">',
    '<svg onload="window.__pwn=1"></svg>',
    '<svg><script>window.__pwn=1</script></svg>',
    '<svg><a xlink:href="javascript:window.__pwn=1"><text y="10">s</text></a></svg>',
    '<svg><use href="data:image/svg+xml,&lt;svg id=x xmlns=http://www.w3.org/2000/svg&gt;&lt;image href=1 onerror=window.__pwn=1 /&gt;&lt;/svg&gt;#x"></use></svg>',
    '<svg><animate onbegin="window.__pwn=1" attributeName="x" dur="1s"/></svg>',
    '<math><mtext><table><mglyph><style><img src=x onerror="window.__pwn=1"></style></mglyph></table></mtext></math>',
    '<math><mi xlink:href="javascript:window.__pwn=1">x</mi></math>',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror="window.__pwn=1">',
    '<noscript><p title="</noscript><img src=x onerror=window.__pwn=1>"></noscript>',
    '<!-- <img src=x onerror="window.__pwn=1"> -->',
    '<a href="&#x6A;avascript:window.__pwn=1">entity</a>',
    '<a href="jav&#x09;ascript:window.__pwn=1">tab</a>',
    '<a href="  JaVaScRiPt:window.__pwn=1">case</a>',
    '<a href="data:text/html,&lt;script&gt;parent.__pwn=1&lt;/script&gt;">data link</a>',
    '<a href="vbscript:msgbox(1)">vb</a>',
    '<img srcset="javascript:window.__pwn=1 1x, x.png 2x">',
    '<iframe srcdoc="&lt;script&gt;parent.__pwn=1&lt;/script&gt;"></iframe>',
    '<object data="javascript:window.__pwn=1"></object>',
    '<embed src="javascript:window.__pwn=1">',
    '<meta http-equiv="refresh" content="0;url=javascript:window.__pwn=1">',
    '<base href="javascript:/">',
    '<form action="javascript:window.__pwn=1"><button>go</button></form>',
    '<button formaction="javascript:window.__pwn=1">b</button>',
    '<details open ontoggle="window.__pwn=1"><summary>s</summary>x</details>',
    '<div style="background:url(javascript:window.__pwn=1)">css</div>',
    '<template><img src=x onerror="window.__pwn=1"></template>',
    '<isindex type=image src=1 onerror="window.__pwn=1">',
    '<input autofocus onfocus="window.__pwn=1">',
    '<video><source onerror="window.__pwn=1"></video>',
    '<body onload="window.__pwn=1">',
    '<marquee onstart="window.__pwn=1">m</marquee>',
    '<a id="find-input" name="preview" href="#">clobber</a>',
    '<img name="getElementById" src="x.png"><form id="docs"></form>'
)
Start-App $Exe $null
J "setLayoutMode('split-ep'); return 1" | Out-Null
$failed = @()
$i = 0
foreach ($a in $attacks) {
    $i++
    $js = ConvertTo-Json -Compress $a
    $r = J "window.__pwn = undefined; const d = getActive(); editor.value = 'Attack $i' + '\n\n' + $js + '\n\nafter'; syncFromEditor(); renderPreview(d); await new Promise(r => setTimeout(r, 250)); const bad = preview.querySelectorAll('script,iframe,object,embed,meta,base,form,button,style,template,animate,use,input:not([type=checkbox])').length; const handlers = [...preview.querySelectorAll('*')].filter(el => [...el.attributes].some(at => /^on/i.test(at.name))).length; const urls = [...preview.querySelectorAll('[href],[src],[srcset],[xlink\\:href],[action],[formaction]')].map(el => (el.getAttribute('href') || '') + (el.getAttribute('src') || '') + (el.getAttribute('srcset') || '') + (el.getAttribute('xlink:href') || '')).filter(u => /^\s*(javascript|vbscript|data:text)/i.test(u.replace(/[\u0000- ]/g, ''))).length; const appIds = ['find-input', 'preview', 'editor']; const clob = [...preview.querySelectorAll('[id],[name]')].some(e => appIds.includes(e.id) || appIds.includes(e.getAttribute('name'))) || appIds.some(id => document.getElementById(id) && document.getElementById(id) !== preview && preview.contains(document.getElementById(id))) || typeof document.getElementById !== 'function'; return JSON.stringify([String(window.__pwn), bad, handlers, urls, clob])"
    if ($r -ne '["undefined",0,0,0,false]') { $failed += "#$i $a => $r" }
}
Start-Sleep -Milliseconds 800
$late = J "return String(window.__pwn)"
T "Attack corpus ($($attacks.Count) cases): nothing runs, no handlers, no script URLs, no clobbering" (($failed -join ' | ') + " late=$late") ($failed.Count -eq 0 -and $late -eq 'undefined')

# The editable preview keeps removed HTML in the Markdown, including <style> and <script> blocks
# (stored encoded in their markers) and an image that lost its onerror.
$doc = @'
# Round trip

Intro paragraph.

<style>p { color: red } /* --> */</style>

<script>window.__pwn = 'round'</script>

<img src="pic.png" onerror="window.__pwn='img'" alt="pic">

Last paragraph.
'@
[IO.File]::WriteAllText("$work\round.md", $doc, $utf8)
$r = J "window.__pwn = undefined; const d = await openPath('$w/round.md'); setLayoutMode('split-ep'); await new Promise(r => setTimeout(r, 600)); const h = preview.querySelector('h1'); h.textContent = 'Round trip edited'; preview.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 700)); const c = getActive().content; return JSON.stringify([c.includes('# Round trip edited'), c.includes('<style>p { color: red } /* --> */</style>'), c.includes(`"<script>window.__pwn = 'round'</script>`"), /<img src=`"pic.png`" onerror=/.test(c), c.includes('Last paragraph.'), String(window.__pwn)])"
T 'Editing the preview keeps <style>, <script> and a cleaned <img> in the Markdown' $r ($r -eq '[true,true,true,true,true,"undefined"]')
$r = J "return JSON.stringify([...preview.querySelectorAll('[data-np-raw]')].map(e => e.getAttribute('data-np-raw').slice(0, 2)))"
T 'Removed HTML is stored encoded in its marker' $r ($r -match '^\["u:"(,"u:")*\]$')
# A document can't plant its own marker to inject source text.
$r = J "const d = getActive(); editor.value = '<span data-np-raw=`"INJECTED`">x</span> <wbr data-np-raw=`"u:INJECTED2`">'; syncFromEditor(); renderPreview(d); await new Promise(r => setTimeout(r, 200)); return JSON.stringify([...preview.querySelectorAll('[data-np-raw]')].map(e => e.getAttribute('data-np-raw')))"
T 'A document cannot plant its own round-trip markers' $r ($r -eq '[]')

# A document's CSS can't draw over the app: fixed positioning stays inside the preview.
$r = J "const d = getActive(); editor.value = '<div id=`"cover`" style=`"position:fixed;left:0;top:0;width:100vw;height:100vh;background:red`">cover</div>'; syncFromEditor(); renderPreview(d); await new Promise(r => setTimeout(r, 200)); const c = preview.querySelector('div[style]'); const r = c.getBoundingClientRect(); const p = preview.getBoundingClientRect(); return JSON.stringify([r.left >= p.left - 1, r.top >= p.top - 1, document.elementFromPoint(5, 5) === c || c.contains(document.elementFromPoint(5, 5))])"
T 'position:fixed in a document stays inside the preview' $r ($r -eq '[true,true,false]')

# Export: a Content-Security-Policy that blocks every script, and nothing dangerous in the page.
J "const d = getActive(); editor.value = 'Export test\n\n<img src=x onerror=`"window.__pwn=1`">\n\n<script>window.__pwn=2</script>\n\n| a |\n|---|\n| 1 |'; syncFromEditor(); return 1" | Out-Null
$r = J "const html = buildExportHtml(getActive()); const csp = (html.match(/<meta http-equiv=`"Content-Security-Policy`" content=`"([^`"]+)`"/) || [])[1] || ''; return JSON.stringify([/script-src 'none'/.test(csp) && /default-src 'none'/.test(csp), /<script|onerror|javascript:/i.test(html.replace(/<style>[\s\S]*?<\/style>/, '')), html.includes('<table>'), html.indexOf('Content-Security-Policy') < html.indexOf('<title>')])"
T 'Export as HTML: CSP blocks all scripts, page is clean, CSP comes first' $r ($r -eq '[true,false,true,true]')

# BBCode still renders after cleaning.
$r = J "const d = getActive(); d.lang = 'bbcode'; editor.value = '[b]bold[/b] [color=red]red[/color] [url=https://ok.example]link[/url] [url=javascript:alert(1)]bad[/url]'; syncFromEditor(); renderPreview(d); await new Promise(r => setTimeout(r, 200)); return JSON.stringify([!!preview.querySelector('b,strong'), !!preview.querySelector('span[style*=color]'), [...preview.querySelectorAll('a')].map(a => a.getAttribute('href'))])"
T 'BBCode preview renders through the sanitiser' $r ($r -eq '[true,true,["https://ok.example"]]')

Stop-App
$results | Format-Table -AutoSize -Wrap | Out-String -Width 250
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
