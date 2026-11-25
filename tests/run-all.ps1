param([string]$Exe = "$PSScriptRoot\..\src-tauri\target\release\notepad.md.exe", [string[]]$Only, [int]$TimeoutMinutes = 12, [switch]$Interactive)
# Runs every app-level suite against a copy of the exe in the test folder.
# Each suite runs in its own PowerShell process with a time limit, and its full output is saved to
# <test folder>\results\<suite>.txt as soon as it finishes, so a hung suite can't lose the others' results.
# Rust unit tests run separately:  cd src-tauri; cargo test
$sp = . "$PSScriptRoot\testdir.ps1"
New-Item -ItemType Directory -Force "$sp\bin", "$sp\results" | Out-Null
Copy-Item $Exe "$sp\bin\notepad.md.exe" -Force   # some suites need this exact file name
$exeCopy = "$sp\bin\notepad.md.exe"
$suites = 'test-hardening','test-polish','test-v109','test-v110','test-bookmarks','test-validation','test-validation2','test-rebrand','test-sync','test-v141','test-v142','test-round15','test-round14','test-round13','test-all','test-features','test-round3','test-round4','test-round5','test-round6','test-round7','test-round9','test-round10','test-round11'
# These press real keys on the Windows keyboard: only run them when nobody is using the PC.
if ($Interactive) { $suites += 'test-round8', 'test-round12', 'test-layout' }
if ($Only) { $suites = @($suites) + @('test-round8', 'test-round12', 'test-layout') | Where-Object { $Only -contains $_ } | Select-Object -Unique }
$summary = "$sp\results\summary.txt"
"Run started $(Get-Date -Format s) with $Exe" | Set-Content $summary
foreach ($t in $suites) {
    $log = "$sp\results\$t.txt"
    $p = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "& '$PSScriptRoot\$t.ps1' -Exe '$exeCopy' *>&1 | Out-String -Width 250 | Set-Content -Encoding UTF8 '$log'" -WindowStyle Hidden -PassThru
    if (-not $p.WaitForExit($TimeoutMinutes * 60000)) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        "TIMED OUT after $TimeoutMinutes minutes" | Add-Content $log
    }
    # Never leave a test copy of the app (or its dialogs) behind for the next suite.
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($sp) -and $_.ProcessName -match '^(notepad-md|notepad.md|np[0-9]+)$' } | Stop-Process -Force
    $out = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
    $sum = ($out -split "`n" | Where-Object { $_ -match 'PASS: \d+|TIMED OUT' } | Select-Object -Last 1)
    $lines = @("== $t  $sum") + @($out -split "`n" | Where-Object { $_ -match '\sFAIL\s' } | ForEach-Object { "   " + $_.Trim().Substring(0, [Math]::Min(220, $_.Trim().Length)) })
    $lines | Add-Content $summary
    $lines
}
