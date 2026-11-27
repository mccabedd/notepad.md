param([string]$Exe)
# After v2.0.1: underscores inside words aren't Markdown italics, text cursor shape and colours,
# selection colour, and Translate (against a fake Google endpoint on this PC: no text leaves it).
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message + ' @ ' + (e.stack||'').split('\n')[1]; } })()" }
$work = "$sp\work202"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null

# ---------- a fake Google Cloud Translation endpoint (stopped at the end, and by itself after 8 minutes) ----------
$port = Get-Random -Minimum 20000 -Maximum 40000
$fakeLog = "$work\fake.log"
$job = Start-Job -ArgumentList $port, $fakeLog -ScriptBlock {
    param($port, $log)
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://127.0.0.1:$port/")
    $l.Start()
    $deadline = (Get-Date).AddMinutes(8)
    while ((Get-Date) -lt $deadline) {
        $t = $l.GetContextAsync()
        while (-not $t.Wait(500)) { if ((Get-Date) -ge $deadline) { break } }
        if (-not $t.IsCompleted) { break }
        $c = $t.Result
        $body = (New-Object IO.StreamReader($c.Request.InputStream, [Text.Encoding]::UTF8)).ReadToEnd()
        if ($c.Request.Url.AbsolutePath -eq '/translate_a/single') {
            # The free endpoint: q=<text> (form), tl=<target>; reply [[["translated","original",...],...],null,"detected"]
            $tl = $c.Request.QueryString['tl']
            $q = ''
            foreach ($pair in $body.Split('&')) { if ($pair.StartsWith('q=')) { $q = [Uri]::UnescapeDataString($pair.Substring(2).Replace('+', ' ')) } }
            $lines = $q.Split("`n")
            Add-Content $log ("free tl=$tl n=$($lines.Count) len=$($q.Length) key=$($c.Request.Headers['X-goog-api-key']) client=$($c.Request.QueryString['client'])")
            if ($q -like '*LIMITME*') { $code = 429; $out = '<html>Too Many Requests</html>' }
            else {
                $code = 200
                $segs = @()
                for ($i = 0; $i -lt $lines.Count; $i++) {
                    $tr = "[$tl] " + $lines[$i]
                    # MERGEME: Google joins two lines into one, so the line count doesn't match.
                    if ($i -lt $lines.Count - 1 -and $q -notlike '*MERGEME*') { $tr += "`n" } elseif ($i -lt $lines.Count - 1) { $tr += ' ' }
                    $segs += '[' + (ConvertTo-Json $tr -Compress) + ',' + (ConvertTo-Json $lines[$i] -Compress) + ',null,null,3]'
                }
                $out = '[[' + ($segs -join ',') + '],null,"is"]'
            }
            $bytes = [Text.Encoding]::UTF8.GetBytes($out)
            $c.Response.StatusCode = $code
            $c.Response.ContentType = 'application/json; charset=utf-8'
            $c.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            $c.Response.Close()
            continue
        }
        $key = $c.Request.Headers['X-goog-api-key']
        $req = $body | ConvertFrom-Json
        $q = @($req.q)
        Add-Content $log ("key=$key n=$($q.Count) max=$(($q | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum) target=$($req.target) format=$($req.format)")
        if ($key -ne 'test-key-123') { $code = 400; $out = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key."}}' }
        elseif ($q -contains 'FAILME') { $code = 403; $out = '{"error":{"code":403,"message":"Cloud Translation API has not been used in project 1 before or it is disabled."}}' }
        else {
            $code = 200
            $tr = @($q | ForEach-Object { @{ translatedText = "[$($req.target)] $_"; detectedSourceLanguage = 'fr' } })
            $out = @{ data = @{ translations = $tr } } | ConvertTo-Json -Depth 5 -Compress
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes($out)
        $c.Response.StatusCode = $code
        $c.Response.ContentType = 'application/json; charset=utf-8'
        $c.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $c.Response.Close()
    }
    $l.Stop()
}
$env:NOTEPADMD_TRANSLATE_URL = "http://127.0.0.1:$port"

try {
Start-App $Exe $null
J "dialogApi.message = async (m) => { (window.__msgs = window.__msgs || []).push(String(m)); }; dialogApi.ask = async (m) => { (window.__asks = window.__asks || []).push(String(m)); return window.__askAnswer !== false; }; window.__frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); return 1" | Out-Null
$cm = (J "return String(!!editor.isCodeMirror)") -eq 'true'

# ---------- underscores in Markdown ----------
$md = 'test_test1_test2 and _real italic_ and snake_case_name and __bold__ and file_name.md'
$r = J "const s = await highlightInWorker('$md', 'markdown', true); const out = []; for (let i = 0; i < s.starts.length; i++) out.push(s.names[s.cls[i]] + ':' + '$md'.slice(s.starts[i], s.ends[i])); return out.join('|')"
T 'Markdown: an underscore inside a word is not italic; _real italic_ and __bold__ still are (worker)' $r ($r -eq 'hljs-emphasis:_real italic_|hljs-strong:__bold__')
$r = J "const h = highlightCode('$md', 'markdown'); const d = document.createElement('div'); d.innerHTML = h; return [...d.querySelectorAll('.hljs-emphasis, .hljs-strong')].map((e) => e.className + ':' + e.textContent).join('|')"
T 'The same in the page (small files)' $r ($r -eq 'hljs-emphasis:_real italic_|hljs-strong:__bold__')
$r = J "const t = 'Þetta_er_próf and _ok_'; const h = highlightCode(t, 'markdown'); const d = document.createElement('div'); d.innerHTML = h; return [...d.querySelectorAll('.hljs-emphasis')].map((e) => e.textContent).join('|')"
T 'Non-English letters count as part of a word too' $r ($r -eq '_ok_')
if ($cm) {
    $r = J "addDocAndActivate(newUntitledDoc()); setDocLanguage('markdown'); setLayoutMode('edit-only'); editor.value = '$md'; syncFromEditor(); await new Promise((r) => setTimeout(r, 400)); return [...editor.api.view.dom.querySelectorAll('.hljs-emphasis')].map((e) => e.textContent).join('|')"
    T 'In the editor: only _real italic_ is drawn in italics' $r ($r -eq '_real italic_')
}

# ---------- text cursor and selection ----------
if ($cm) {
    $r = J "editor.focus(); editor.setSelectionRange(3, 3); changeSetting('caretStyle', 'block'); await new Promise((r) => setTimeout(r, 200)); const c = editor.api.view.dom.querySelector('.cm-cursor'); const cs = getComputedStyle(c); return [document.body.classList.contains('caret-block'), parseFloat(cs.width) > 4, cs.borderLeftWidth, cs.backgroundColor !== 'rgba(0, 0, 0, 0)'].join('|')"
    T 'Text cursor: Block' $r ($r -eq 'true|true|0px|true')
    $r = J "changeSetting('caretStyle', 'underscore'); await new Promise((r) => setTimeout(r, 200)); const cs = getComputedStyle(editor.api.view.dom.querySelector('.cm-cursor')); return [document.body.classList.contains('caret-underscore'), document.body.classList.contains('caret-block'), parseFloat(cs.borderBottomWidth) >= 1.5, cs.borderLeftWidth].join('|')"
    T 'Text cursor: Underscore' $r ($r -eq 'true|false|true|0px')
    $r = J "changeSetting('caretStyle', 'line'); await new Promise((r) => setTimeout(r, 200)); const cs = getComputedStyle(editor.api.view.dom.querySelector('.cm-cursor')); return [document.body.classList.contains('caret-underscore'), parseFloat(cs.borderLeftWidth) >= 1.5].join('|')"
    T 'Text cursor: Line (the default)' $r ($r -eq 'false|true')
    $r = J "changeSetting('caretColor', '#ff0000'); await new Promise((r) => setTimeout(r, 200)); return getComputedStyle(editor.api.view.dom.querySelector('.cm-cursor')).borderLeftColor"
    T 'Text cursor colour' $r ($r -eq 'rgb(255, 0, 0)')
    $r = J "changeSetting('selectionColor', '#00ff00'); editor.setSelectionRange(0, 10); await new Promise((r) => setTimeout(r, 300)); const s = editor.api.view.dom.querySelector('.cm-selectionBackground'); return s ? getComputedStyle(s).backgroundColor : 'none'"
    T 'Selection colour (see-through)' $r ($r -match '^color\(srgb 0 1 0 / 0\.35\)$|^rgba\(0, 255, 0, 0\.35')
    $r = J "openSettings(); const a = document.querySelector('[data-s=caretColor]').value; const b = document.querySelector('[data-s=selectionColor]').value; const fa = document.querySelector('[data-theme-flag=caretColor]').textContent; document.querySelector('[data-clear=caretColor]').click(); document.querySelector('[data-clear=selectionColor]').click(); const a2 = document.querySelector('[data-s=caretColor]').value; closeSettings(); return [a, b, fa, a2 !== '#000000' && a2 !== '#ff0000', getComputedStyle(document.documentElement).getPropertyValue('--caret').trim() !== '#ff0000'].join('|')"
    T 'Settings shows the custom colours, and Use theme puts the theme colours back' $r ($r -eq '#ff0000|#00ff00|custom|true|true')
}
if ($cm) {
    $r = J "addDocAndActivate(newUntitledDoc()); setDocLanguage('markdown'); setLayoutMode('edit-only'); editor.value = 'a\nb\nc'; syncFromEditor(); if (!lineNumbersVisible) toggleLineNumbers(); await new Promise((r) => setTimeout(r, 300)); const w = () => { const g = editor.api.view.dom.querySelector('.cm-gutters'); return [g.querySelector('.cm-np-diag').offsetWidth, g.offsetWidth]; }; const md = w(); setDocLanguage('json'); await new Promise((r) => setTimeout(r, 300)); const js = w(); return JSON.stringify([md[0], js[0], js[1] - md[1]])"
    T 'Line numbers: no empty problem margin for Markdown (only for checked languages such as JSON)' $r ($r -eq '[0,15,15]')
}
$r = J "return [...document.querySelectorAll('[data-s=caretStyle] option')].map((o) => o.textContent).join(',')"
T 'Settings > Editor offers Line, Block and Underscore' $r ($r -eq 'Line,Block,Underscore')

# ---------- Translate: the free provider (the default) ----------
$r = J "await invoke('cmd_translate_key_set', { key: '' }); window.__msgs = []; addDocAndActivate(newUntitledDoc()); setLayoutMode('edit-only'); editor.value = 'Bonjour'; syncFromEditor(); editor.setSelectionRange(0, 0); const p = settings.translateProvider; const res = await translateInEditor('en'); return [p, res.startsWith('Translated from Icelandic into English'), editor.value, window.__msgs.length].join('|')"
T 'Free provider is the default and needs no key' $r ($r -eq 'free|true|[en] Bonjour|0')
$r = J "editor.value = '# Titre\n\n  - un\n\tdeux  \n\nfin'; syncFromEditor(); editor.setSelectionRange(0, 0); await translateInEditor('de'); return JSON.stringify(editor.value)"
T 'Free: whole document in one request, keeping blank lines and indentation' $r ($r -eq '"[de] # Titre\n\n  [de] - un\n\t[de] deux  \n\n[de] fin"')
$r = J "editor.value = 'MERGEME one\ntwo\nthree'; syncFromEditor(); editor.setSelectionRange(0, 0); await translateInEditor('en'); return JSON.stringify(editor.value)"
T 'Free: when Google merges lines, each line is sent on its own' $r ($r -eq '"[en] MERGEME one\n[en] two\n[en] three"')
$r = J "window.__msgs = []; editor.value = 'LIMITME'; syncFromEditor(); editor.setSelectionRange(0, 0); const res = await translateInEditor('en'); return [res, editor.value, (window.__msgs[0] || '').includes('limiting requests')].join('|')"
T 'Free: Google limiting requests is explained, text unchanged' $r ($r -eq 'error|LIMITME|true')
$r = J "window.__asks = []; const big = ('mot ').repeat(8000); editor.value = big; syncFromEditor(); editor.setSelectionRange(0, 0); await translateInEditor('en'); return [window.__asks.length, editor.value.split('[en] ').length - 1 >= 1, editor.value.replace(/\[en\] /g, '') === big].join('|')"
T 'Free: a large document is not asked about (no charge) and comes back whole' $r ($r -eq '0|true|true')
$freeLog = @(Get-Content $fakeLog | Where-Object { $_ -like 'free *' })
$freeBad = @($freeLog | Where-Object { $_ -notmatch 'client=gtx' -or $_ -notmatch 'key= ' -or [int]([regex]::Match($_, 'len=(\d+)').Groups[1].Value) -gt 4600 })
T 'Free requests: client=gtx, no key sent, none over 4,500 characters' "$($freeLog.Count) requests, $($freeBad.Count) bad" ($freeLog.Count -ge 9 -and $freeBad.Count -eq 0)

# ---------- Translate from the spelling menu (right-click on a misspelt word) ----------
$r = J "setSpellLang('en_GB'); editor.value = 'Hello Þetta er próf'; syncFromEditor(); for (let i = 0; i < 150 && !edLayer().querySelector('.spell-err'); i++) await new Promise((r) => setTimeout(r, 100)); const sp = [...edLayer().querySelectorAll('.spell-err')].find((s) => s.dataset.w === 'Þetta'); if (!sp) return 'no spelling mark'; editor.setSelectionRange(6, 19); const rc = sp.getClientRects()[0]; const target = editor.isCodeMirror ? sp : editor; target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rc.left + 2, clientY: rc.top + rc.height / 2 })); await new Promise((r) => setTimeout(r, 300)); const items = [...ctxMenu.querySelectorAll('.ctx-label')].map((e) => e.textContent); const tr = [...ctxMenu.querySelectorAll('button')].find((b) => b.textContent.includes('Translate')); if (!tr) return 'no Translate: ' + items.join(','); tr.dispatchEvent(new MouseEvent('mouseenter')); await new Promise((r) => setTimeout(r, 100)); const subs = subMenuEl ? [...subMenuEl.querySelectorAll('.ctx-label')].map((e) => e.textContent) : []; const go = subMenuEl && [...subMenuEl.querySelectorAll('button')].find((b) => b.textContent.startsWith('Translate to')); go.click(); for (let i = 0; i < 50 && !editor.value.includes('[en]'); i++) await new Promise((r) => setTimeout(r, 100)); return [items.includes('Ignore'), subs.join(','), editor.value, ctxMenu.classList.contains('hidden')].join('|')"
T 'Spelling menu has Translate (to English / Choose Language), and it translates the selection' $r ($r -eq 'true|Translate to English,Choose Language...|Hello [en] Þetta er próf|true')

# ---------- Translate: Google Cloud with a key ----------
$r = J "changeSetting('translateProvider', 'cloud'); window.__msgs = []; editor.value = 'Bonjour'; syncFromEditor(); editor.setSelectionRange(0, 0); const res = await translateInEditor('en'); return res + '|' + (window.__msgs[0] || '').includes('Settings > Translate') + '|' + editor.value"
T 'Cloud without a key: a message pointing to Settings > Translate, text unchanged' $r ($r -eq 'no key|true|Bonjour')
$r = J "try { await invoke('cmd_translate_key_set', { key: 'bad key with spaces' }); return 'accepted'; } catch (e) { return 'refused' }"
T 'A key with spaces is refused' $r ($r -eq 'refused')
$r = J "await invoke('cmd_translate_key_set', { key: 'test-key-123' }); return String(await invoke('cmd_translate_key_status'))"
T 'The key is saved' $r ($r -eq 'true')
$kb = [IO.File]::ReadAllBytes("$script:TestDir\appdata\translate-key.bin")
$plain = [Text.Encoding]::ASCII.GetString($kb).Contains('test-key-123') -or [Text.Encoding]::Unicode.GetString($kb).Contains('test-key-123')
T 'The key file is encrypted (the key is not in it as text)' "$($kb.Length) bytes, readable=$plain" ($kb.Length -gt 20 -and -not $plain)

$r = J "editor.value = 'Hello\nBonjour le monde\nGoodbye'; syncFromEditor(); editor.setSelectionRange(6, 22); const res = await translateInEditor('en'); return JSON.stringify([editor.value, editor.selectionStart, editor.selectionEnd, res.startsWith('Translated from French into English')])"
T 'Selection: only the selection is translated, and stays selected' $r ($r -eq '["Hello\n[en] Bonjour le monde\nGoodbye",6,27,true]')
$r = J "editor.focus(); if (editor.undo) editor.undo(); else document.execCommand('undo'); await __frame(); return editor.value"
T 'Ctrl+Z puts the original text back' $r ($r -eq "Hello`nBonjour le monde`nGoodbye")
$r = J "editor.value = '# Titre\n\n  - un\n\tdeux  \n\nfin'; syncFromEditor(); editor.setSelectionRange(3, 3); await translateInEditor('en'); return JSON.stringify(editor.value)"
T 'Nothing selected: the whole document, keeping blank lines and indentation' $r ($r -eq '"[en] # Titre\n\n  [en] - un\n\t[en] deux  \n\n[en] fin"')
$r = J "editor.value = 'Góðan dag'; syncFromEditor(); editor.setSelectionRange(0, 0); window.__TAURI__.event.emit('translate-menu', 'choose'); for (let i = 0; i < 40 && document.getElementById('translate-dlg').classList.contains('hidden'); i++) await new Promise((r) => setTimeout(r, 50)); const shown = !document.getElementById('translate-dlg').classList.contains('hidden'); const f = document.getElementById('translate-filter'); f.value = 'iceland'; f.dispatchEvent(new Event('input')); const opts = [...document.getElementById('translate-list').options].map((o) => o.value).join(','); document.getElementById('translate-go').click(); for (let i = 0; i < 50 && editor.value === 'Góðan dag'; i++) await new Promise((r) => setTimeout(r, 100)); return [shown, opts, editor.value, document.getElementById('translate-dlg').classList.contains('hidden')].join('|')"
T 'Choose Language: find Icelandic, translate into it' $r ($r -eq 'true|is|[is] Góðan dag|true')
$r = J "editor.value = 'Hola'; syncFromEditor(); editor.setSelectionRange(0, 0); changeSetting('translateTo', 'de'); window.__TAURI__.event.emit('translate-menu', 'default'); for (let i = 0; i < 50 && editor.value === 'Hola'; i++) await new Promise((r) => setTimeout(r, 100)); changeSetting('translateTo', 'en'); return editor.value"
T 'Translate to <default>: the language set in Settings' $r ($r -eq '[de] Hola')
$r = J "window.__msgs = []; editor.value = 'FAILME'; syncFromEditor(); editor.setSelectionRange(0, 0); const res = await translateInEditor('en'); return [res, editor.value, (window.__msgs[0] || '').includes('Cloud Translation API is enabled') || (window.__msgs[0] || '').includes('refused')].join('|')"
T "Google's error is shown and the text stays as it was" $r ($r -eq 'error|FAILME|true')
$r = J "await invoke('cmd_translate_key_set', { key: 'wrong-key' }); window.__msgs = []; editor.value = 'Bonjour'; syncFromEditor(); await translateInEditor('en'); await invoke('cmd_translate_key_set', { key: 'test-key-123' }); return (window.__msgs[0] || '') + '|' + editor.value"
T 'A wrong key: says so' $r ($r -like "Google didn't accept the API key*|Bonjour")
$r = J "const long = 'Une phrase assez longue pour le test. '.repeat(400); editor.value = long; syncFromEditor(); editor.setSelectionRange(0, 0); window.__askAnswer = true; await translateInEditor('en'); const parts = editor.value.split('[en] ').length - 1; return [parts >= 3, editor.value.replace(/\[en\] /g, '') === long].join('|')"
T 'A very long line is sent in pieces and put back together' $r ($r -eq 'true|true')
$r = J "window.__asks = []; window.__askAnswer = false; const big = ('mot ').repeat(8000); editor.value = big; syncFromEditor(); editor.setSelectionRange(0, 0); const res = await translateInEditor('en'); window.__askAnswer = true; return [res, window.__asks.length, editor.value === big].join('|')"
T 'A large document asks first (No leaves it alone)' $r ($r -eq 'cancelled|1|true')
$fake = @(Get-Content $fakeLog | Where-Object { $_ -notlike 'free *' })
$bad = @($fake | Where-Object { $_ -notmatch 'format=text' -or [int]([regex]::Match($_, 'max=(\d+)').Groups[1].Value) -gt 4500 })
T 'Every request: format=text, no piece over 4,500 characters, key in the header' "$($fake.Count) requests, $($bad.Count) bad" ($fake.Count -ge 7 -and $bad.Count -eq 0 -and ($fake | Where-Object { $_ -match '^key=test-key-123' }).Count -ge 6)
$r = J "await invoke('cmd_translate_key_set', { key: '' }); return String(await invoke('cmd_translate_key_status'))"
T 'Remove key' $r ($r -eq 'false')
$r = J "openSettings(); showSettingsTab('general'); await new Promise((r) => setTimeout(r, 300)); const s = document.getElementById('translate-to'); const ok = s.options.length > 100 && s.value === 'en'; const st = document.getElementById('translate-key-status').textContent; const vis = (id) => !document.getElementById(id).classList.contains('hidden'); const a = [document.getElementById('translate-provider').value, vis('translate-cloud'), vis('translate-free-note')]; const p = document.getElementById('translate-provider'); p.value = 'free'; p.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 100)); const b = [settings.translateProvider, vis('translate-cloud'), vis('translate-free-note')]; closeSettings(); return [ok, st, ...a, ...b].join('|')"
T 'Settings > Translate: languages, key status, provider choice shows the key fields only for Cloud' $r ($r -eq 'true|No key saved yet.|cloud|true|false|free|false|true')
$r = J "translateProviderUnset = true; settings.translateProvider = 'free'; await invoke('cmd_translate_key_set', { key: 'test-key-123' }); const hasKey = await translateKeySaved(); const p = translateProvider(hasKey); await invoke('cmd_translate_key_set', { key: '' }); changeSetting('translateProvider', 'free'); return p"
T 'Someone who saved a Cloud key in v2.0.2 keeps using Cloud' $r ($r -eq 'cloud')
} finally {
    Stop-App
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    Remove-Item Env:NOTEPADMD_TRANSLATE_URL -ErrorAction SilentlyContinue
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
$results | Format-Table -AutoSize -Wrap | Out-String -Width 250
$p = ($results | Where-Object Result -eq 'PASS').Count
$f = ($results | Where-Object Result -eq 'FAIL').Count
"PASS: $p  FAIL: $f"
