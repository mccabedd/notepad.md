param([string]$Exe)
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
. "$PSScriptRoot\cdpkeys.ps1"

$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) {
    [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" })
}
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message + ' @ ' + (e.stack||'').split('\n')[1]; } })()" }
function Shot([string]$name) {
    $r = Cdp 'Page.captureScreenshot' @{ format = 'png' }
    [IO.File]::WriteAllBytes("$sp\r7-$name.png", [Convert]::FromBase64String($r.result.data))
}

$W = "$sp\work7"; Remove-Item $W -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $W | Out-Null
$files = @{
    'Main.java' = "public class Main {`n  public static void main(String[] args) { System.out.println(""hi""); }`n}`n"
    'site.css' = "body { color: #333; margin: 0 auto; }`n"
    'prog.c' = "#include <stdio.h>`nint main(void) { return 0; }`n"
    'Program.cs' = "using System;`nclass P { static void Main() { Console.WriteLine(""hi""); } }`n"
    'app.cpp' = "#include <vector>`nint main() { std::vector<int> v; return 0; }`n"
    'run.cmd' = "@echo off`necho hello`n"
    'run.bat' = "@echo off`nset X=1`n"
    'tool.ps1' = "Get-ChildItem | Where-Object { `$_.Length -gt 0 }`n"
    'app.js' = "const x = 1;`n"
}
foreach ($k in $files.Keys) { [IO.File]::WriteAllText("$W\$k", $files[$k]) }

$TestReg = 'Software\NotepadMD-Test\Classes'
$env:NOTEPADMD_REG_ROOT = $TestReg
Remove-Item "HKCU:\Software\NotepadMD-Test" -Recurse -Force -ErrorAction SilentlyContinue
$realBefore = Test-Path -LiteralPath 'HKCU:\Software\Classes\*\shell\NotepadMD.Edit'

Start-App $Exe $null

# ---------- languages ----------
$expect = [ordered]@{ 'Main.java' = 'Java'; 'site.css' = 'CSS'; 'prog.c' = 'C'; 'Program.cs' = 'C#'; 'app.cpp' = 'C++'; 'run.cmd' = 'MS-DOS Batch'; 'run.bat' = 'MS-DOS Batch'; 'tool.ps1' = 'PowerShell'; 'app.js' = 'JavaScript' }
foreach ($k in $expect.Keys) {
    $p = "$W\$k".Replace('\', '\\')
    $r = J "await openPath('$p'); await new Promise(r=>setTimeout(r,150)); return langInfo(getActive()).label + '|' + layoutMode + '|' + (edLayer().querySelectorAll('[class^=hljs-]').length > 0) + '|' + statusLang.textContent.trim()"
    $want = $expect[$k]
    T "$k opens as $want, coloured, Edit Only" $r ($r -eq "$want|edit-only|true|$want")
}
Shot 'cpp'
$r = J "return ['h','hpp','cc','cxx','cs'].map(e=>langForPath('x.'+e)).join(',')"
T 'Header / alternative extensions' $r ($r -eq 'c,cpp,cpp,cpp,csharp')
$r = J "return ['java','css','c','csharp','cpp'].every(k=>!!hljs.getLanguage(LANGS[k].hljs))"
T 'Grammars for the new languages are bundled' $r ($r -eq $true)
$r = J "showLanguageMenu(statusLang); await new Promise(r=>setTimeout(r,100)); const seen = new Set(); for (const g of ['Web and Data', 'Programming']) { const b = [...ctxMenu.querySelectorAll('button')].find(x => x.textContent.trim().startsWith(g)); b.dispatchEvent(new MouseEvent('mouseenter')); await new Promise(r=>setTimeout(r,100)); document.querySelectorAll('.ctx-label').forEach(e => seen.add(e.textContent.trim())); } document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); hideContextMenu(); return ['Java','CSS','C','C#','C++'].every(n=>seen.has(n))"
T 'Language menu lists Java, CSS, C, C#, C++' $r ($r -eq $true)
$r = J "return supportedExtensions().filter(e=>['java','css','c','h','cs','cpp','hpp','cmd','bat','ps1','js'].includes(e)).length"
T 'New extensions are in the Register file types list' $r ($r -eq 11)

# ---------- Explorer right-click menu (throwaway registry key) ----------
$verb = "HKCU:\$TestReg\*\shell\NotepadMD.Edit"
$r = J "openSettings(); await refreshFileTypeStatus(); return ctxMenuBox.checked"
T 'Right-click item is off at first' $r ($r -eq $false)
Shot 'settings-files'
$r = J "ctxMenuBox.checked = true; ctxMenuBox.dispatchEvent(new Event('change', {bubbles:true})); await new Promise(r=>setTimeout(r,500)); return ctxMenuBox.checked + '|' + settingsMsg.textContent"
$exeReal = (Get-Item $Exe).FullName
$label = (Get-ItemProperty -LiteralPath $verb -ErrorAction SilentlyContinue).'(default)'
$icon = (Get-ItemProperty -LiteralPath $verb -ErrorAction SilentlyContinue).Icon
$cmd = (Get-ItemProperty -LiteralPath "$verb\command" -ErrorAction SilentlyContinue).'(default)'
T 'Ticking adds "Edit in notepad.md" with the app icon' "$r | label=$label icon=$icon cmd=$cmd" ($r -like 'true|*added*' -and $label -eq 'Edit in notepad.md' -and $icon -eq "`"$exeReal`",0" -and $cmd -eq "`"$exeReal`" `"%1`"")
$r = J "await refreshContextMenuStatus(); return ctxMenuBox.checked"
T 'Status reads back as on' $r ($r -eq $true)
Set-ItemProperty -LiteralPath "$verb\command" -Name '(default)' -Value '"C:\Old\notepad-md.exe" "%1"'
$r = J "await refreshContextMenuStatus(); return ctxMenuBox.checked + '|' + ctxStatus.textContent"
T 'Pointing at another copy is reported' $r ($r -like 'false|*different copy*')
$r = J "ctxMenuBox.checked = false; ctxMenuBox.dispatchEvent(new Event('change', {bubbles:true})); await new Promise(r=>setTimeout(r,500)); return ctxMenuBox.checked"
T 'Unticking removes it' "$r exists=$(Test-Path -LiteralPath $verb)" ($r -eq $false -and -not (Test-Path -LiteralPath $verb))
$r = J "return JSON.stringify(settings).includes('ctx')"
T 'Checkbox is not stored as a setting' $r ($r -eq $false)
$realAfter = Test-Path -LiteralPath 'HKCU:\Software\Classes\*\shell\NotepadMD.Edit'
T 'Real right-click menu untouched by the test' "before=$realBefore after=$realAfter" ($realBefore -eq $realAfter)

# ---------- version ----------
$r = J "await showAbout(); await new Promise(r=>setTimeout(r,300)); return aboutEl.querySelector('.about-name').textContent.trim()"
T "About shows v$AppVersion" $r ($r -eq "notepad.md v$AppVersion")

Stop-App
Remove-Item Env:NOTEPADMD_REG_ROOT
Remove-Item "HKCU:\Software\NotepadMD-Test" -Recurse -Force -ErrorAction SilentlyContinue

$results | Format-Table -AutoSize -Wrap | Out-String -Width 260
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
