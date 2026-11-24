# Builds the portable app: src-tauri\target\release\notepad.md.exe
#   powershell -ExecutionPolicy Bypass -File build.ps1            (just the exe)
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Release   (also notepad.md-vX.Y.Z-win-x64.exe + SHA-256)
#
# Cargo can't put a dot in a program's name, so it builds notepad-md.exe (the Rust package name,
# kept as it is) and this script copies it to notepad.md.exe, the name the app is distributed under.
param([switch]$Release)
$ErrorActionPreference = 'Stop'
$cargo = (Get-Command cargo -ErrorAction SilentlyContinue).Source
if (-not $cargo) { $cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe" }
Push-Location "$PSScriptRoot\src-tauri"
try {
    & $cargo build --release
    if ($LASTEXITCODE) { throw "cargo build failed ($LASTEXITCODE)" }
} finally { Pop-Location }
$dir = "$PSScriptRoot\src-tauri\target\release"
Copy-Item "$dir\notepad-md.exe" "$dir\notepad.md.exe" -Force
# A copy of the app still running from here keeps the old file: never report a stale build as done.
if ((Get-FileHash "$dir\notepad-md.exe").Hash -ne (Get-FileHash "$dir\notepad.md.exe").Hash) {
    throw "notepad.md.exe was not replaced - is the app still running from $dir ?"
}
$size = (Get-Item "$dir\notepad.md.exe").Length
"Built $dir\notepad.md.exe ($([Math]::Round($size / 1MB, 2)) MB)"
if ($Release) {
    $version = (Get-Content "$PSScriptRoot\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
    $asset = "$dir\notepad.md-v$version-win-x64.exe"
    Copy-Item "$dir\notepad.md.exe" $asset -Force
    "Release asset: $asset"
    "SHA-256: $((Get-FileHash $asset -Algorithm SHA256).Hash)"
}
