# Checks that the third-party files in ui\vendor are exactly the ones recorded in
# tests\vendor-sha256.txt (no file changed, added or missing).
#   powershell -ExecutionPolicy Bypass -File tests\check-vendor.ps1           (check)
#   powershell -ExecutionPolicy Bypass -File tests\check-vendor.ps1 -Update   (record the current files,
#                                                                              after deliberately updating one)
param([switch]$Update)
$root = (Resolve-Path "$PSScriptRoot\..\ui\vendor").Path
$list = "$PSScriptRoot\vendor-sha256.txt"
# Hashed with Windows line endings turned into plain ones, so a Git checkout that converts line
# endings (core.autocrlf) gives the same result everywhere. All vendored files are text.
$sha = [Security.Cryptography.SHA256]::Create()
function Get-NormalHash([string]$path) {
    $b = [IO.File]::ReadAllBytes($path)
    $out = New-Object System.Collections.Generic.List[byte] ($b.Length)
    for ($i = 0; $i -lt $b.Length; $i++) { if (-not ($b[$i] -eq 13 -and $i + 1 -lt $b.Length -and $b[$i + 1] -eq 10)) { $out.Add($b[$i]) } }
    ($sha.ComputeHash($out.ToArray()) | ForEach-Object { $_.ToString('x2') }) -join ''
}
$now = Get-ChildItem $root -Recurse -File | Sort-Object FullName | ForEach-Object {
    '{0}  {1}' -f (Get-NormalHash $_.FullName), $_.FullName.Substring($root.Length + 1).Replace('\', '/')
}
if ($Update) {
    [IO.File]::WriteAllLines($list, [string[]]$now)
    "Recorded $($now.Count) files in $list"
    exit 0
}
$want = Get-Content $list | Where-Object { $_.Trim() }
$diff = Compare-Object $want $now
if ($diff) {
    $diff | ForEach-Object { '{0} {1}' -f $(if ($_.SideIndicator -eq '<=') { 'expected:' } else { 'found:   ' }), $_.InputObject }
    Write-Error "ui\vendor differs from tests\vendor-sha256.txt"
    exit 1
}
"All $($now.Count) vendored files match tests\vendor-sha256.txt"
