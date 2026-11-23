param([string]$Exe, [string]$Label = '')
# Responsiveness benchmark across document sizes (10 KB, 100 KB, 1 MB, 5 MB Markdown):
# open time, typing latency (edit-only and split view), preview render, tab switch, session save,
# and memory (notepad.md plus its WebView2 processes). Prints one table; numbers are medians.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
function Med($a) { $s = @($a | Sort-Object); if (-not $s.Count) { return $null }; $s[[int][Math]::Floor($s.Count / 2)] }
$work = "$sp\workbench2"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
$readme = [IO.File]::ReadAllText("$PSScriptRoot\..\README.md")
$sizes = [ordered]@{ '10KB' = 10KB; '100KB' = 100KB; '1MB' = 1MB; '5MB' = 5MB }
foreach ($k in $sizes.Keys) {
    $n = $sizes[$k]; $sb = New-Object Text.StringBuilder
    while ($sb.Length -lt $n) { [void]$sb.Append($readme).Append("`n") }
    [IO.File]::WriteAllText("$work\doc$k.md", $sb.ToString().Substring(0, $n), (New-Object Text.UTF8Encoding $false))
}
$w = $work.Replace('\', '/')

function TreeMemoryMB([int]$rootPid) {
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, WorkingSetSize
    $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add($rootPid)
    do { $added = 0; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added++ } } } while ($added)
    [Math]::Round((($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | Measure-Object WorkingSetSize -Sum).Sum) / 1MB)
}

function TypeKeys([int]$count) {
    $t = @()
    $text = 'The quick brown fox jumps over the lazy dog.'
    for ($i = 0; $i -lt $count; $i++) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Cdp 'Input.insertText' @{ text = [string]$text[$i % $text.Length] } | Out-Null
        Eval "new Promise(r=>requestAnimationFrame(()=>r(1)))" | Out-Null
        $t += $sw.Elapsed.TotalMilliseconds
    }
    [Math]::Round((Med $t), 1)
}

Start-App $Exe $null
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null
$memIdle = TreeMemoryMB $script:proc.Id
$rows = @()
foreach ($k in $sizes.Keys) {
    $keys = if ($sizes[$k] -ge 1MB) { 12 } else { 40 }
    $open = J "const t=performance.now(); const d = await openPath('$w/doc$k.md'); await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0))); return Math.round(performance.now()-t)"
    J "setLayoutMode('edit-only'); editor.focus(); editor.setSelectionRange(5000, 5000); return 1" | Out-Null
    Start-Sleep -Milliseconds 300
    $typeEdit = TypeKeys $keys
    J "setLayoutMode('split-ep'); editor.focus(); return 1" | Out-Null
    Start-Sleep -Milliseconds 1500
    $typeSplit = TypeKeys $keys
    Start-Sleep -Milliseconds 1500
    $render = J "const d=getActive(); const t=[]; for (let i=0;i<3;i++){ const a=performance.now(); renderPreview(d); t.push(performance.now()-a);} t.sort((x,y)=>x-y); return Math.round(t[1])"
    # Tab switch: away to a small tab and back (time until the switch call returns and a frame paints)
    $switch = J "const big=getActive(); const small=newUntitledDoc(); addDocAndActivate(small); await new Promise(r=>setTimeout(r,300)); const t=performance.now(); setActiveTab(big.id); await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0))); const ms=Math.round(performance.now()-t); await closeTab(small.id); setActiveTab(big.id); return ms"
    $save = J "const t=performance.now(); await saveSessionNow(); return Math.round(performance.now()-t)"
    $mem = TreeMemoryMB $script:proc.Id
    $rows += [pscustomobject]@{ Size = $k; 'Open ms' = $open; 'Type edit ms/key' = $typeEdit; 'Type split ms/key' = $typeSplit; 'Preview render ms' = $render; 'Tab switch ms' = $switch; 'Session save ms' = $save; 'Memory MB' = $mem }
}
Stop-App
"== $Label  exe=$((Get-Item $Exe).Length) bytes  idle memory=$memIdle MB"
$rows | Format-Table -AutoSize | Out-String -Width 200
