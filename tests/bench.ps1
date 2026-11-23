param([string]$Exe, [int]$Runs = 5)
# Before/after benchmark: startup, typing, Markdown render, save.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
function Med($a) { $s = @($a | Sort-Object); $s[[int][Math]::Floor($s.Count / 2)] }
$work = "$sp\workbench"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
$readme = [IO.File]::ReadAllText("$PSScriptRoot\..\README.md")
$md = ($readme + "`n") * [Math]::Ceiling(200000 / $readme.Length)
[IO.File]::WriteAllText("$work\bench.md", $md, (New-Object Text.UTF8Encoding $false))
$w = $work.Replace('\', '/')

# Startup: process start -> page ready (5 cold-ish runs)
$starts = @()
for ($i = 0; $i -lt $Runs; $i++) {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($sp) -and $_.ProcessName -match '^(notepad-md|notepad.md|np[0-9]+)$' } | Stop-Process -Force
  Start-Sleep -Milliseconds 1200
  $env:NOTEPADMD_DATA_DIR = "$sp\appdata"; Remove-Item "$sp\appdata\session.json" -ErrorAction SilentlyContinue
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'; $env:WEBVIEW2_USER_DATA_FOLDER = "$sp\wv2data"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $script:proc = Start-Process $Exe -PassThru
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS; Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER
  $wsUrl = $null
  while (-not $wsUrl -and $sw.ElapsedMilliseconds -lt 20000) { try { $p = (Invoke-RestMethod 'http://127.0.0.1:9333/json' -TimeoutSec 1) | Where-Object { $_.type -eq 'page' } | Select-Object -First 1; if ($p) { $wsUrl = $p.webSocketDebuggerUrl } } catch { Start-Sleep -Milliseconds 30 } }
  $script:ws = New-Object System.Net.WebSockets.ClientWebSocket
  $script:ws.ConnectAsync([Uri]$wsUrl, [Threading.CancellationToken]::None).Wait()
  while ((Eval "typeof statusLayout !== 'undefined' && !!statusLayout.textContent && typeof docs !== 'undefined' && docs.length > 0 && !!activeId") -ne $true) { Start-Sleep -Milliseconds 20 }
  $starts += $sw.ElapsedMilliseconds
  if ($i -lt $Runs - 1) { try { $script:ws.Dispose() } catch {} }
}
"Startup to ready (ms, median of $Runs): $(Med $starts)   [$($starts -join ', ')]"

# Markdown render of a ~200 KB document (split view), median of 10
$r = J "const d = await openPath('$w/bench.md'); setLayoutMode('split-ep'); await new Promise(r=>setTimeout(r,500)); const t=[]; for (let i=0;i<10;i++){ const a=performance.now(); renderPreview(d); t.push(performance.now()-a); } t.sort((x,y)=>x-y); return Math.round(t[5]);"
"Markdown render, 200 KB (ms, median of 10): $r"

# Typing: 60 characters one at a time into a small Markdown doc in split view (CDP round trip incl. render)
J "newTab && newTab(); setLayoutMode('split-ep'); editor.value='# Title\n\nSome **bold** text.\n'; editor.dispatchEvent(new Event('input')); editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); return 1" | Out-Null
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null
$keys = @()
foreach ($c in ('The quick brown fox jumps over the lazy dog again and again.'.ToCharArray())) { $sw = [Diagnostics.Stopwatch]::StartNew(); Cdp 'Input.insertText' @{ text = "$c" } | Out-Null; Eval "new Promise(r=>requestAnimationFrame(()=>r(1)))" | Out-Null; $keys += $sw.Elapsed.TotalMilliseconds }
"Typing, small doc split view (ms per key incl. paint, median of 60): $([Math]::Round((Med $keys),1))"
$r = J "const d = await openPath('$w/bench.md'); editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); return 1"
$keys = @()
foreach ($c in ('Typing at the end of the 200 KB document.'.ToCharArray())) { $sw = [Diagnostics.Stopwatch]::StartNew(); Cdp 'Input.insertText' @{ text = "$c" } | Out-Null; Eval "new Promise(r=>requestAnimationFrame(()=>r(1)))" | Out-Null; $keys += $sw.Elapsed.TotalMilliseconds }
"Typing, 200 KB doc split view (ms per key incl. paint, median): $([Math]::Round((Med $keys),1))"

# Save: write a 1 MB document through the backend, median of 10
$r = J "const s='x'.repeat(100)+'\n'; const c=s.repeat(10400); const t=[]; for (let i=0;i<10;i++){ const a=performance.now(); await invoke('cmd_write_file',{path:'$w/save.txt',content:c,encoding:'utf8'}); t.push(performance.now()-a);} t.sort((x,y)=>x-y); return Math.round(t[5]*10)/10;"
"Save 1 MB (ms, median of 10): $r"
Stop-App
"Exe size: $((Get-Item $Exe).Length) bytes"
