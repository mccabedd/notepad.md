param([string]$Exe)
# Security and data-safety checks: preview sanitising, BBCode escaping, ANSI encoding,
# crash-safe saving and its failure cases, save conflicts, and the updater's refusals.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
$utf8 = New-Object Text.UTF8Encoding $false
$work = "$sp\work-hardening"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
$w = $work.Replace('\', '/')

# ---------- Markdown preview: hostile HTML ----------
$evil = @'
# Hostile document

Normal **bold**, a [good link](https://example.com) and `code`.

- [ ] task one
- [x] task two

| a | b |
|---|---|
| 1 | 2 |

<img src="nope.png" onerror="window.__pwn='img'">

<script>window.__pwn='script'</script>

[click](javascript:window.__pwn='link')

<a href="jav&#x09;ascript:window.__pwn='tab'">tab trick</a>

<iframe src="https://example.com"></iframe>

<meta http-equiv="refresh" content="0;url=https://example.com">

<form action="https://example.com"><input type="text" name="q"><button>Go</button></form>

<details open ontoggle="window.__pwn='details'"><summary>More</summary>Inside</details>

<svg width="10" height="10"><a><animate attributeName="href" values="javascript:window.__pwn='svg'"/><rect width="10" height="10"/></a></svg>

<div id="editor">clobber attempt</div>

<object data="x.swf"></object>

<base href="https://example.com/">

<style>body { display: none }</style>

```js
const x = 1;
```
'@
[IO.File]::WriteAllText("$work\evil.md", $evil, $utf8)

Start-App $Exe $null
$r = J "window.__pwn = undefined; const d = await openPath('$w/evil.md'); setLayoutMode('split-ep'); await new Promise(r=>setTimeout(r,800)); return JSON.stringify([String(window.__pwn), preview.querySelectorAll('script,iframe,meta,form,object,base,style,animate,button:not(.code-copy-btn)').length, preview.querySelectorAll('[onerror],[ontoggle],[onclick]').length])"
T 'Hostile Markdown: nothing runs, dangerous elements removed' $r ($r -eq '["undefined",0,0]')
$r = J "return JSON.stringify([...preview.querySelectorAll('a')].filter(a=>a.textContent.trim()).map(a=>a.getAttribute('href')))"
T 'javascript: links lose their address (normal links kept)' $r ($r -eq '["https://example.com",null,null]')
$r = J "return JSON.stringify([preview.querySelectorAll('input[type=checkbox]').length, !!preview.querySelector('table td'), !!preview.querySelector('pre code .hljs-keyword'), !!preview.querySelector('details summary'), !!preview.querySelector('img'), preview.querySelectorAll('#editor').length, document.getElementById('editor').tagName])"
T 'Normal Markdown still renders (tasks, table, code colours, details, image)' $r ($r -eq '[2,true,true,true,true,0,"TEXTAREA"]')
$r = J "return getComputedStyle(document.body).display"
T 'A <style> in the document cannot restyle the app' $r ($r -ne 'none')
# Edit in the preview: the blocked HTML must survive in the Markdown source.
$r = J "const h = preview.querySelector('h1'); h.textContent = 'Hostile document edited'; preview.dispatchEvent(new Event('input', {bubbles:true})); await new Promise(r=>setTimeout(r,600)); const c = getActive().content; return JSON.stringify([c.includes('# Hostile document edited'), c.includes(`"<script>window.__pwn='script'</script>`"), c.includes('<iframe src=`"https://example.com`"></iframe>'), /- \[x\] +task two/.test(c), String(window.__pwn)])"
T 'Editing the preview keeps the blocked HTML in the Markdown (round trip)' $r ($r -eq '[true,true,true,true,"undefined"]')
$r = J "const html = buildExportHtml(getActive()); return JSON.stringify([/<script|onerror|ontoggle|<iframe|javascript:/i.test(html.replace(/<style>[\s\S]*?<\/style>/,'')), html.includes('<table>')])"
T 'Export as HTML leaves out scripts and handlers' $r ($r -eq '[false,true]')

# Ordinary Markdown is unchanged by the sanitiser (the README, sample document).
$sample = [IO.File]::ReadAllText("$PSScriptRoot\fixtures\sample.md") + "`n" + [IO.File]::ReadAllText("$PSScriptRoot\..\README.md")
[IO.File]::WriteAllText("$work\ordinary.md", $sample, $utf8)
$r = J "const d = await openPath('$w/ordinary.md'); const raw = marked_.parse(d.content); const t = document.createElement('template'); t.innerHTML = raw; const box = document.createElement('div'); box.appendChild(t.content); return JSON.stringify([sanitizeHtml(raw) === box.innerHTML, raw.length > 5000])"
T 'Sample + README Markdown: sanitiser changes nothing' $r ($r -eq '[true,true]')
$r = J "const d = getActive(); const before = d.content; const t = performance.now(); for (let i=0;i<10;i++) renderPreview(d); return JSON.stringify([Math.round((performance.now()-t)/10), before === d.content])"
T 'Preview render time with sanitiser (ms, informational)' $r ($r -like '*,true]')

# ---------- BBCode ----------
$r = J "return renderBBCode('[url=javascript:alert(1)]x[/url] [img]javascript:alert(2)[/img] [color=red`" onmouseover=`"alert(3)]c[/color] <b onclick=x>t</b> [url]https://ok.example[/url]')"
T 'BBCode: unsafe links/images/attributes stay as text' $r (($r -notmatch 'href="javascript|src="javascript|<[^>]*onmouseover|<b ') -and $r -match '<a href="https://ok.example">')

# ---------- ANSI (Windows-1252) ----------
$ansi = [byte[]](0x93,0x43,0x61,0x66,0xE9,0x94,0x20,0x80,0x31,0x30,0x20,0x96,0x20,0x6E,0x61,0xEF,0x76,0x65,0x85,0x0D,0x0A)
[IO.File]::WriteAllBytes("$work\ansi.txt", $ansi)
$r = J "const d = await openPath('$w/ansi.txt'); await new Promise(r=>setTimeout(r,200)); return JSON.stringify([d.encoding, d.content, document.getElementById('status-encoding') ? document.getElementById('status-encoding').textContent : ''])"
$o = $r | ConvertFrom-Json; $want = [string][char]0x201C + 'Caf' + [char]0xE9 + [char]0x201D + ' ' + [char]0x20AC + '10 ' + [char]0x2013 + ' na' + [char]0xEF + 've' + [char]0x2026 + "`r`n"
T 'ANSI file: smart quotes, euro, dash and accents read correctly' $r ($o[0] -eq 'latin1' -and ($o[1] -eq $want -or $o[1] -eq $want.Replace("`r`n", "`n")))
$r = J "const d = getActive(); d.content = d.content.replace('10', '12'); editor.value = d.content; editor.dispatchEvent(new Event('input')); return String(await saveDocGeneric(d))"
$bytes = [IO.File]::ReadAllBytes("$work\ansi.txt")
$expect = $ansi.Clone(); $expect[9] = 0x32
T 'ANSI file saved back as ANSI, byte for byte' (($bytes | ForEach-Object { $_.ToString('X2') }) -join ' ') ($r -eq 'true' -and [Convert]::ToBase64String($bytes) -eq [Convert]::ToBase64String($expect))
$r = J "const d = getActive(); d.content = d.content + 'Japanese: \u65E5\u672C'; editor.value = d.content; editor.dispatchEvent(new Event('input')); await saveDocGeneric(d); return JSON.stringify([d.encoding, statusDirty.textContent])"
$txt = [IO.File]::ReadAllText("$work\ansi.txt", $utf8)
T 'Text ANSI cannot hold is saved as UTF-8, and the user is told' "$r | $txt" ($r -match '^\["utf8","Saved as UTF-8' -and $txt.Contains([string][char]0x65E5) -and $txt.Contains([string][char]0x201C))

# ---------- Saving: failures leave the original intact ----------
[IO.File]::WriteAllText("$work\ro.txt", 'original', $utf8)
J "await openPath('$w/ro.txt'); return 1" | Out-Null
(Get-Item "$work\ro.txt").IsReadOnly = $true
$r = J "window.__msgs = []; const orig = dialogApi.message; dialogApi.message = async (m) => { window.__msgs.push(m); }; const d = getActive(); d.content = 'changed'; editor.value = d.content; editor.dispatchEvent(new Event('input')); const ok = await saveDocGeneric(d); dialogApi.message = orig; return JSON.stringify([ok, window.__msgs[0] || '', d.dirty])"
(Get-Item "$work\ro.txt").IsReadOnly = $false
T 'Read-only file: clear message, file untouched, still unsaved' "$r | $([IO.File]::ReadAllText("$work\ro.txt"))" ($r -match '^\[false,".*read-only.*",true\]$' -and [IO.File]::ReadAllText("$work\ro.txt") -eq 'original')

[IO.File]::WriteAllText("$work\locked.txt", 'original', $utf8)
J "await openPath('$w/locked.txt'); return 1" | Out-Null
$lock = [IO.File]::Open("$work\locked.txt", 'Open', 'Read', 'None')
$r = J "window.__msgs = []; const orig = dialogApi.message; dialogApi.message = async (m) => { window.__msgs.push(m); }; const d = getActive(); d.content = 'changed'; editor.value = d.content; editor.dispatchEvent(new Event('input')); const ok = await saveDocGeneric(d); dialogApi.message = orig; return JSON.stringify([ok, window.__msgs[0] || ''])"
$lock.Close()
$left = @(Get-ChildItem $work -Force -Filter '*.notepadmd-tmp').Count
T 'File locked by another program: clear message, file untouched, no temp files' "$r | left=$left" ($r -match '^\[false,".*in use by another program' -and [IO.File]::ReadAllText("$work\locked.txt") -eq 'original' -and $left -eq 0)
$r = J "const d = getActive(); return String(await saveDocGeneric(d))"
T 'Once the lock is gone, saving works' $r ($r -eq 'true' -and [IO.File]::ReadAllText("$work\locked.txt") -eq 'changed')

# Attributes and CRLF/UTF-16 survive the temp-file swap
$u16 = New-Object Text.UnicodeEncoding $false, $true
[IO.File]::WriteAllText("$work\u16.txt", "line1`r`nline2`r`n", $u16)
(Get-Item "$work\u16.txt").Attributes = 'Hidden, Archive'
$created = (Get-Item "$work\u16.txt" -Force).CreationTimeUtc = [datetime]'2020-01-02T03:04:05Z'
$r = J "const d = await openPath('$w/u16.txt'); d.content = d.content + 'line3\n'; editor.value = d.content; editor.dispatchEvent(new Event('input')); return JSON.stringify([d.encoding, d.eol, await saveDocGeneric(d)])"
$fi = Get-Item "$work\u16.txt" -Force
$b = [IO.File]::ReadAllBytes("$work\u16.txt")
T 'UTF-16 + CRLF file: encoding, line endings, hidden attribute and creation date kept' "$r attrs=$($fi.Attributes) created=$($fi.CreationTimeUtc.ToString('s'))" ($r -eq '["utf16le","crlf",true]' -and $b[0] -eq 0xFF -and $b[1] -eq 0xFE -and [Text.Encoding]::Unicode.GetString($b, 2, $b.Length - 2) -eq "line1`r`nline2`r`nline3`r`n" -and ($fi.Attributes -band [IO.FileAttributes]::Hidden) -and $fi.CreationTimeUtc.ToString('s') -eq '2020-01-02T03:04:05')

# Changed by another program in the moment between the check and the write
[IO.File]::WriteAllText("$work\race.txt", 'v1', $utf8)
J "await openPath('$w/race.txt'); return 1" | Out-Null
J "const d = getActive(); d.content = 'mine'; editor.value = d.content; editor.dispatchEvent(new Event('input')); window.__asked = 0; dialogApi.ask = async () => { window.__asked++; return false; }; return 1" | Out-Null
# Simulate the other program: hold the save just after its check passes, change the file, then let it write.
$r = J "const d = getActive(); const realCheck = confirmOverwriteIfChanged; confirmOverwriteIfChanged = async (doc, p) => { const res = await realCheck(doc, p); window.__checked = true; await new Promise(r=>setTimeout(r,1500)); return res; }; window.__p = saveDocGeneric(d).finally(() => { confirmOverwriteIfChanged = realCheck; }); await new Promise(r=>setTimeout(r,400)); return String(window.__checked)"
[IO.File]::WriteAllText("$work\race.txt", 'changed by someone else', $utf8)
$r = J "const ok = await window.__p; return JSON.stringify([ok, window.__asked])"
T 'Changed on disk between check and write: user is asked, nothing overwritten' "$r | $([IO.File]::ReadAllText("$work\race.txt"))" ($r -eq '[false,1]' -and [IO.File]::ReadAllText("$work\race.txt") -eq 'changed by someone else')
J "dialogApi.ask = async () => true; return 1" | Out-Null
Stop-App

# ---------- Updater refusals (run against a copy of the app) ----------
$appDir = "$sp\update-hardening"; Remove-Item $appDir -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $appDir | Out-Null
Copy-Item $Exe "$appDir\notepad.md.exe"
$origHash = (Get-FileHash "$appDir\notepad.md.exe").Hash
$rel = "$sp\update-hardening-rel"; Remove-Item $rel -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $rel | Out-Null
$newBytes = [IO.File]::ReadAllBytes($Exe) + [Text.Encoding]::ASCII.GetBytes('NEW-VERSION')
[IO.File]::WriteAllBytes("$rel\new.exe", $newBytes)
$goodHash = (Get-FileHash "$rel\new.exe" -Algorithm SHA256).Hash.ToLower()
$fileUrl = 'file:///' + ("$rel\new.exe").Replace('\', '/')
function Write-Release([string]$url, $digest, $size) {
  $o = @{ tag_name = 'v9.9.9'; html_url = 'https://github.com/mccabedd/notepad.md/releases/tag/v9.9.9'; body = 'Test'; assets = @(@{ name = 'notepad.md-v9.9.9-win-x64.exe'; browser_download_url = $url; size = $size; digest = $digest }) }
  [IO.File]::WriteAllText("$rel\release.json", ($o | ConvertTo-Json -Depth 5), $utf8)
}
$env:NOTEPADMD_UPDATE_URL = 'file:///' + ("$rel\release.json").Replace('\', '/')
Start-App "$appDir\notepad.md.exe" $null
$cases = @(
  @('No checksum on the release', $fileUrl, $null, $newBytes.Length, 'no checksum'),
  @('Malformed checksum', $fileUrl, 'sha256:1234', $newBytes.Length, 'no checksum'),
  @('Wrong checksum (tampered download)', $fileUrl, ('sha256:' + ('0' * 64)), $newBytes.Length, 'checksum test'),
  @('Wrong size', $fileUrl, "sha256:$goodHash", 12345, 'incomplete'),
  @('Download from outside the project releases', 'https://example.com/NotepadMD.exe', "sha256:$goodHash", $newBytes.Length, 'outside the notepad.md releases')
)
foreach ($c in $cases) {
  Write-Release $c[1] $c[2] $c[3]
  $r = J "dialogApi.ask = async () => true; await showAbout(); await checkForUpdates(); return aboutStatus.textContent + '|' + aboutStatus.classList.contains('error')"
  $staged = Test-Path "$appDir\notepad.md.exe.download"
  $same = (Get-FileHash "$appDir\notepad.md.exe").Hash -eq $origHash
  T "Update refused: $($c[0])" "$r staged=$staged unchanged=$same" ($r -like "*$($c[4])*|true" -and -not $staged -and $same -and -not $script:proc.HasExited)
}
# The page can no longer hand the installer its own download address.
Write-Release $fileUrl $null $newBytes.Length
$r = J "try { await invoke('cmd_install_update', { assetUrl: 'https://example.com/evil.exe', digest: null, size: null }); return 'installed?'; } catch (e) { return String(e); }"
T 'Installer ignores addresses passed from the page' $r ($r -like '*no checksum*' -and (Get-FileHash "$appDir\notepad.md.exe").Hash -eq $origHash)
Stop-App
Remove-Item Env:NOTEPADMD_UPDATE_URL

$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
