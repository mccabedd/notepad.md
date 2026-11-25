param([string]$Exe, [string]$OldExe = "$PSScriptRoot\..\src-tauri\target\release\NotePad-MD-v1.2.0-win-x64.exe")
# The rename from NotePad-MD to notepad.md: the new name everywhere it shows, a session written by
# NotePad-MD v1.2.0 opening unchanged in notepad.md.exe (same data folder), a v1.2.0 settings
# export importing, and "Use this copy" taking over registrations of a copy that no longer exists
# (in a throwaway registry key).
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
function L([string]$s, [string]$pat) { return $s -like $pat.Replace('[', '`[').Replace(']', '`]') }

$bin = "$sp\rebrand"
New-Item -ItemType Directory $bin -Force | Out-Null
Copy-Item $Exe "$bin\notepad.md.exe" -Force
$new = "$bin\notepad.md.exe"

# --- the exe itself ---
$vi = (Get-Item $new).VersionInfo
T 'Exe details: product name and description are notepad.md' "$($vi.ProductName) | $($vi.FileDescription) | $($vi.ProductVersion)" ($vi.ProductName -eq 'notepad.md' -and $vi.FileDescription -eq 'notepad.md' -and $vi.ProductVersion -eq $AppVersion)

# --- a session written by NotePad-MD v1.2.0 ---
if (Test-Path $OldExe) {
    Copy-Item $OldExe "$bin\notepad-md.exe" -Force
    Start-App "$bin\notepad-md.exe" $null
    $r = J @'
const a = docs[0];
a.content = 'unsaved text from v1.2.0'; editor.value = a.content; syncFromEditor();
a.bookmarks = { 0: 'Red' };
const b = makeDoc(null, '{"a": 1}', { lang: 'json' }); docs.push(b); renderTabs();
changeSetting('bookmarkColour', 'Orange'); changeSetting('validateWarnings', false); changeSetting('wordWrap', false);
spell.userWords.add('rebrandword');
await saveSessionNow();
return JSON.stringify([docs.length, a.dirty, document.title]);
'@
    T 'NotePad-MD v1.2.0 writes a session (tabs, unsaved text, bookmarks, settings)' $r ($r -like '*true*NotePad-MD*')
    Stop-App
    Start-Sleep -Milliseconds 800
    Start-App $new $null -KeepSession
    Start-Sleep -Milliseconds 600
    $r = J "const a = docs[0]; return JSON.stringify([docs.length, a.content, a.dirty, a.bookmarks, docs.some(d => d.lang === 'json' && d.content === '{\`"a\`": 1}'), settings.bookmarkColour, settings.validateWarnings, settings.wordWrap, spell.userWords.has('rebrandword')])"
    T 'notepad.md.exe opens that session unchanged (same data folder)' $r ($r -eq '[2,"unsaved text from v1.2.0",true,{"0":"Red"},true,"Orange",false,false,true]')
    Stop-App
} else {
    # Not a failure of this build: the old release exe just isn't on this PC (download it from the v1.2.0 release to run this part).
    "SKIPPED: NotePad-MD v1.2.0 session checks (old exe not found: $OldExe)"
}

# --- the new name in the app, a v1.2.0 settings export, "Use this copy" ---
$regRoot = "Software\NotepadMD-Rebrand-$PID"
# Your real registrations: read before and after, to show the test never touches them.
function RealState {
    $a = Get-ItemProperty 'HKCU:\Software\Classes\Applications\notepad.md.exe\shell\open\command' -ErrorAction SilentlyContinue
    $p = Get-ItemProperty 'HKCU:\Software\Classes\NotepadMD.Document\shell\open\command' -ErrorAction SilentlyContinue
    return "app=[$($a.'(default)')] prog=[$($p.'(default)')]"
}
$realBefore = RealState
$env:NOTEPADMD_REG_ROOT = "$regRoot\Classes"
Start-App $new $null
Remove-Item Env:NOTEPADMD_REG_ROOT
Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1000; height = 700; deviceScaleFactor = 1; mobile = $false } | Out-Null
$r = J "await showAbout(); await new Promise(r => setTimeout(r, 300)); const x = [document.title, document.getElementById('about-title').textContent, document.querySelector('.about-name').textContent.trim(), document.getElementById('about-link').href]; hideAbout(); openSettings(); x.push(document.getElementById('settings-title').textContent); closeSettings(true); return JSON.stringify(x)"
T 'Window, About and Settings say notepad.md; the link is the new repository' $r (L $r "[`"*notepad.md`",`"About notepad.md`",`"notepad.md v$AppVersion`",`"https://github.com/mccabedd/notepad.md`",`"notepad.md Settings`"]")
$r = J "return [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /NotePad-MD|NotepadMD|Notepad MD/.test(e.textContent + ' ' + (e.title || ''))).map(e => e.id || e.className).join(',') || 'none'"
T 'No old name left anywhere on the page' $r ($r -eq 'none')
$old = '{"app":"NotePad-MD","kind":"settings","version":1,"settings":{"tabSize":8,"bookmarkColour":"Red","validateDelay":900},"theme":"dark","spell":{"enabled":true,"lang":"en_US","userWords":["oldexportword"]}}'
$r = J "applyImportedSettings($old); return JSON.stringify([settings.tabSize, settings.bookmarkColour, settings.validateDelay, spell.userWords.has('oldexportword'), exportableSettings().app])"
T 'A settings export from NotePad-MD v1.2.0 still imports (new exports say notepad.md)' $r ($r -eq '[8,"Red",900,true,"notepad.md"]')
J "applySettings(); return 1" | Out-Null

# Registrations left by NotePad-MD v1.2.0 (notepad-md.exe) that no longer exists.
$root = "HKCU:\$regRoot\Classes"
$gone = '"C:\Gone\notepad-md.exe" "%1"'
New-Item "$root\NotepadMD.Document\shell\open\command" -Force | Out-Null
Set-ItemProperty "$root\NotepadMD.Document\shell\open\command" '(default)' $gone
New-Item "$root\Applications\notepad-md.exe\shell\open\command" -Force | Out-Null
Set-ItemProperty "$root\Applications\notepad-md.exe" 'FriendlyAppName' 'NotePad-MD'
Set-ItemProperty "$root\Applications\notepad-md.exe\shell\open\command" '(default)' $gone
New-Item "$root\Applications\other-app.exe\shell\open\command" -Force | Out-Null
Set-ItemProperty "$root\Applications\other-app.exe" 'FriendlyAppName' 'Other App'
Set-ItemProperty "$root\Applications\other-app.exe\shell\open\command" '(default)' $gone
foreach ($e in 'md', 'json', 'bat') { New-Item "$root\.$e\OpenWithProgids" -Force | Out-Null; New-ItemProperty "$root\.$e\OpenWithProgids" 'NotepadMD.Document' -Value '' -Force | Out-Null }
Set-ItemProperty "$root\.bat" '(default)' 'batfile'
New-Item "$root\*\shell\NotepadMD.Edit\command" -Force | Out-Null
Set-ItemProperty -LiteralPath "$root\*\shell\NotepadMD.Edit" '(default)' 'Edit in NotePad-MD'
Set-ItemProperty -LiteralPath "$root\*\shell\NotepadMD.Edit\command" '(default)' $gone

$r = J "openSettings(); showSettingsTab('filetypes'); await new Promise(r => setTimeout(r, 700)); return JSON.stringify([ftCount.textContent, document.getElementById('ft-repair-row').hidden, ftStatus.textContent.includes('moved or deleted')])"
T 'File Types: the old registrations show (3 ticked) and Use this copy is offered' $r (L $r '["3 of * registered",false,true]')
$r = J "document.getElementById('ft-repair').click(); for (let i = 0; i < 60 && !document.getElementById('ft-repair-row').hidden; i++) await new Promise(r => setTimeout(r, 100)); await new Promise(r => setTimeout(r, 300)); return JSON.stringify([ftCount.textContent, settingsMsg.textContent, ftStatus.textContent])"
T 'Use this copy: the 3 types now open notepad.md.exe' $r (L $r '["3 of * registered","Open with now uses this copy for 3 file type(s), and so does the Explorer menu item*",""]')
$exeReal = (Get-Item $new).FullName
$cmd = (Get-ItemProperty "$root\NotepadMD.Document\shell\open\command").'(default)'
$verb = (Get-ItemProperty -LiteralPath "$root\*\shell\NotepadMD.Edit").'(default)'
$verbCmd = (Get-ItemProperty -LiteralPath "$root\*\shell\NotepadMD.Edit\command").'(default)'
$friendly = (Get-ItemProperty "$root\Applications\notepad.md.exe" -ErrorAction SilentlyContinue).FriendlyAppName
$oldKey = Test-Path "$root\Applications\notepad-md.exe"
$otherKey = Test-Path "$root\Applications\other-app.exe"
$bat = (Get-ItemProperty "$root\.bat").'(default)'
T 'Registry: commands point at notepad.md.exe, names say notepad.md' "cmd=$cmd verb=$verb verbCmd=$verbCmd friendly=$friendly" ($cmd -eq "`"$exeReal`" `"%1`"" -and $verbCmd -eq "`"$exeReal`" `"%1`"" -and $verb -eq 'Edit in notepad.md' -and $friendly -eq 'notepad.md')
T 'Registry: the old copy''s stale key is removed; other programs and default apps are untouched' "oldKey=$oldKey otherKey=$otherKey bat=$bat" (-not $oldKey -and $otherKey -and $bat -eq 'batfile')
$realAfter = RealState
T 'Real registry not touched by this test (your own registrations are the same before and after)' "before=$realBefore after=$realAfter" ($realBefore -eq $realAfter)
J "closeSettings(true); return 1" | Out-Null
$proc = Get-Process -Id $script:proc.Id -ErrorAction SilentlyContinue
T 'The running process is notepad.md' $proc.ProcessName ($proc.ProcessName -eq 'notepad.md')
Stop-App
Remove-Item "HKCU:\$regRoot" -Recurse -ErrorAction SilentlyContinue

$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
