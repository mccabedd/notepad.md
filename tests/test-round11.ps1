param([string]$Exe)
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
Start-App $Exe $null
J "editor.value='one\ntwo\nthree'; editor.dispatchEvent(new Event('input')); setLineNumbersVisible(true); return 1" | Out-Null
$vis = "(el) => !!el && el.offsetParent !== null && el.getBoundingClientRect().width > 0"
foreach ($m in 'split-ep','split-pe','preview-only','edit-only') {
    $r = J "setLayoutMode('$m'); await new Promise(r=>setTimeout(r,150)); const v=$vis; return v(edGutterEl()) + '|' + v(lineNumbersPreviewEl)"
    $want = if ($m -eq 'preview-only') { 'false|false' } else { 'true|false' }
    T "$m : editor numbers / preview numbers" $r ($r -eq $want)
}
$r = J "toggleLineNumbers(); await new Promise(r=>setTimeout(r,300)); toggleLineNumbers(); setLayoutMode('split-ep'); await new Promise(r=>setTimeout(r,150)); const v=$vis; return v(edGutterEl()) + '|' + v(lineNumbersPreviewEl)"
T 'Toggling line numbers keeps them off the preview' $r ($r -eq 'true|false')
Stop-App
$results | Format-Table -AutoSize | Out-String -Width 200
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
