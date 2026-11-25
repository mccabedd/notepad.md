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
    [IO.File]::WriteAllBytes("$sp\r5-$name.png", [Convert]::FromBase64String($r.result.data))
}
function P([string]$name) { ("$W\" + $name).Replace('\', '\\') }

$W = "$sp\work5"; Remove-Item $W -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item "$PSScriptRoot\fixtures\samples" $W -Recurse
# Registry writes go to a throwaway key, never the real file associations.
$TestReg = 'Software\NotepadMD-Test\Classes'
$env:NOTEPADMD_REG_ROOT = $TestReg
# The real associations (notepad.md may really be registered on this PC): they must be exactly the same afterwards.
function Get-RealAssoc { $k = 'HKCU:\Software\Classes\NotepadMD.Document'; if (-not (Test-Path $k)) { return 'none' }; return [string](Get-ItemProperty "$k\shell\open\command" -ErrorAction SilentlyContinue).'(default)' }
$realBefore = Get-RealAssoc
Remove-Item "HKCU:\Software\NotepadMD-Test" -Recurse -Force -ErrorAction SilentlyContinue

Start-App $Exe $null

# ---------- Advanced pane: Maximize wording + close X ----------
$r = J "openFindBar(true); await new Promise(r=>setTimeout(r,300)); const b=[...document.querySelectorAll('.adv-head button')].map(b=>b.id+':'+b.textContent.trim()); return b.join(',')"
T 'Advanced header: Reset, Maximize, X (in that order)' $r ($r -eq 'adv-reset:Reset,adv-max:Maximize,adv-close:✕')
$r = J "document.getElementById('adv-close').click(); await new Promise(r=>setTimeout(r,200)); return advPane.classList.contains('hidden') + '|' + advToggle.checked + '|' + !findBar.classList.contains('hidden') + '|' + (document.activeElement===findInput)"
T 'X closes the Advanced pane (find bar stays)' $r ($r -eq 'true|false|true|true')
J "closeFindBar(); return 1" | Out-Null

# ---------- view order ----------
$r = J "return [...sidebarEl.querySelectorAll('[data-layout]')].map(b=>b.dataset.layout + '=' + b.title.match(/Alt\+(\d)/)[1]).join(',')"
T 'Sidebar order: Edit, Preview, Edit/Preview, Preview/Edit (Ctrl+Alt+1-4)' $r ($r -eq 'edit-only=1,preview-only=2,split-ep=3,split-pe=4')
$seq = @()
foreach ($d in 1..4) { Send-Key @('CTRL', 'ALT') "$d" "Digit$d" (0x30 + $d); $seq += (J 'return layoutMode') }
T 'Ctrl+Alt+1..4 follow the new order' ($seq -join ',') (($seq -join ',') -eq 'edit-only,preview-only,split-ep,split-pe')
$r = J "return [...settingsEl.querySelectorAll('[data-s=newTabView] option')].map(o=>o.value).join(',')"
T 'Settings default-view list uses the same order' $r ($r -eq 'edit-only,preview-only,split-ep,split-pe,same')

# ---------- About ----------
$r = J "await showAbout(); return [!aboutEl.classList.contains('hidden'), aboutEl.querySelector('.about-name').textContent.trim(), document.getElementById('about-link').textContent, aboutEl.querySelector('.about-body').textContent.includes('Created by David McCabe'), document.getElementById('about-update').textContent].join('|')"
T 'About shows name/version, link, author, Check for Updates' $r ($r -eq "true|notepad.md v$AppVersion|" + 'https://github.com/mccabedd/notepad.md|true|Check for Updates')
Shot 'about'
Send-Key @() 'Escape' 'Escape' 0x1B
T 'Esc closes About' (J "return aboutEl.classList.contains('hidden')") ((J "return aboutEl.classList.contains('hidden')") -eq $true)

# ---------- settings export / import ----------
$exportPath = "$W\exported-settings.json"
$r = J @"
settings.editFont='Cascadia Code'; settings.wordWrap=false; settings.newTabFontSize=17; spell.userWords.add('notepadmd'); applySettings();
await invoke('cmd_write_file', { path: '$($exportPath.Replace('\','\\'))', content: JSON.stringify(exportableSettings(), null, 2) });
loadSettings(null); spell.userWords.clear(); applySettings();
const before = settings.editFont + '|' + settings.wordWrap + '|' + settings.newTabFontSize;
const file = await invoke('cmd_read_file', { path: '$($exportPath.Replace('\','\\'))' });
applyImportedSettings(JSON.parse(file.content));
return before + ' -> ' + settings.editFont + '|' + settings.wordWrap + '|' + settings.newTabFontSize + '|' + spell.userWords.has('notepadmd') + '|' + document.body.classList.contains('nowrap');
"@
$json = Get-Content $exportPath -Raw | ConvertFrom-Json
T 'Export writes a settings file' "kind=$($json.kind) font=$($json.settings.editFont) words=$($json.spell.userWords -join ',')" ($json.kind -eq 'settings' -and $json.settings.editFont -eq 'Cascadia Code' -and ($json.spell.userWords -contains 'notepadmd'))
T 'Import restores settings + dictionary and applies them' $r ($r -eq 'Consolas|true|14 -> Cascadia Code|false|17|true|true')
$r = J "try { applyImportedSettings({hello:1}); return 'accepted'; } catch (e) { return e.message; }"
T 'Import rejects a non-settings file' $r ($r -eq 'This is not a notepad.md settings file.')
J "openSettings(); return 1" | Out-Null
function WaitDialog { for ($i = 0; $i -lt 20; $i++) { if (Has-Dialog) { return $true }; Start-Sleep -Milliseconds 250 }; return $false }
J "document.getElementById('settings-export').click(); return 1" | Out-Null
$d1 = WaitDialog; Close-Dialogs | Out-Null; Start-Sleep -Milliseconds 600
J "document.getElementById('settings-import').click(); return 1" | Out-Null
$d2 = WaitDialog; Close-Dialogs | Out-Null; Start-Sleep -Milliseconds 600
T 'Export... / Import... buttons open Save / Open dialogs' "export=$d1 import=$d2" ($d1 -and $d2)

# ---------- register file types (throwaway registry key) ----------
$r = J "await refreshFileTypeStatus(); return ftCount.textContent"
T 'File types: not registered at first' $r ($r -like '0 of * registered')
$r = J "await setFileTypes(supportedExtensions(), true); return settingsMsg.textContent + '|' + ftCount.textContent"
$root = "HKCU:\$TestReg"
$exeReal = (Get-Item $Exe).FullName
$cmd = (Get-ItemProperty "$root\NotepadMD.Document\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
$mdProg = (Get-Item "$root\.md\OpenWithProgids" -ErrorAction SilentlyContinue).Property -contains 'NotepadMD.Document'
$psProg = (Get-Item "$root\.ps1\OpenWithProgids" -ErrorAction SilentlyContinue).Property -contains 'NotepadMD.Document'
$types = @((Get-Item "$root\Applications\notepad.md.exe\SupportedTypes" -ErrorAction SilentlyContinue).Property).Count
$expected = [int](J "return supportedExtensions().length")
T 'Register writes ProgID + Open-with entries for every type' "msg=$r cmd=$cmd md=$mdProg ps1=$psProg types=$types/$expected" ($cmd -eq "`"$exeReal`" `"%1`"" -and $mdProg -and $psProg -and $types -eq $expected -and $r -eq "Registered $expected file types.|$expected of $expected registered")
$realAfter = Get-RealAssoc
T 'Real file associations untouched by the test' "before=$realBefore after=$realAfter" ($realAfter -eq $realBefore -and $realAfter -notlike "*$exeReal*")
$r = J "await setFileTypes(supportedExtensions(), false); return ftCount.textContent"
$left = (Test-Path "$root\NotepadMD.Document") -or ((Get-Item "$root\.md\OpenWithProgids" -ErrorAction SilentlyContinue).Property -contains 'NotepadMD.Document') -or (Test-Path "$root\Applications\notepad.md.exe")
T 'Unregister removes them again' "status=$r leftovers=$left" ($r -like '0 of * registered' -and -not $left)
Shot 'settings-files'
J "closeSettings(); return 1" | Out-Null

# ---------- per-tab preview mode ----------
J "await openPath('$(P 'notes.md')'); setLayoutMode('split-ep'); return 1" | Out-Null
$r = J "return previewModeBtn.textContent + '|' + !!preview.querySelector('h1') + '|' + statusLang.textContent"
T 'Markdown file: sidebar shows MD, preview is Markdown' $r ($r -eq 'MD|true|Markdown')
$r = J "previewModeBtn.click(); await new Promise(r=>setTimeout(r,200)); const d=getActive(); return previewModeBtn.textContent + '|' + !!preview.querySelector('h1') + '|' + preview.textContent.includes('# Colour test') + '|' + statusLang.textContent + '|' + d.langOverride + '|' + preview.getAttribute('contenteditable')"
T 'Sidebar button switches this tab to BBCode preview (which can be typed into)' $r ($r -eq 'BB|false|true|BBCode|true|true')
Send-Key @('CTRL', 'ALT') 'm' 'KeyM' 0x4D
T 'Ctrl+Alt+M back to Markdown preview' (J "return previewModeBtn.textContent + '|' + getActive().langOverride") ((J "return previewModeBtn.textContent + '|' + getActive().langOverride") -eq 'MD|false')
Send-Key @('CTRL', 'ALT') 'b' 'KeyB' 0x42
T 'Ctrl+Alt+B to BBCode preview' (J "return previewModeBtn.textContent") ((J "return previewModeBtn.textContent") -eq 'BB')
$r = J "statusLang.click(); await new Promise(r=>setTimeout(r,100)); return [...ctxMenu.querySelectorAll('button')].map(b=>b.querySelector('.ctx-label').textContent + (b.querySelector('.ctx-gesture').textContent.includes('✓')?'*':'')).slice(0,4).join(' ; ')"
T 'Status-bar language menu (auto-detect + every language, current ticked)' $r ($r -eq 'Auto-detect from file extension (Markdown) ; Markdown  (Markdown preview) ; Plain Text ; BBCode  (BBCode preview)*')  # Plain Text shows its text as written (no Markdown preview)
Shot 'language-menu'
J "hideContextMenu(); return 1" | Out-Null
$r = J "await openPath('$(P 'forum.bbcode')'); setLayoutMode('split-ep'); return previewModeBtn.textContent + '|' + getActive().langOverride"
T 'BBCode file is BB by default (auto)' $r ($r -eq 'BB|false')
$r = J "await openPath('$(P 'data.json')'); return previewModeBtn.textContent"
T 'Code file shows { }' $r ($r -eq '{ }')

# override survives a restart
$hwnd = [KB]::MainWin([uint32]$script:proc.Id)
[void][W32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
$exited = $script:proc.WaitForExit(6000)
try { $script:ws.Dispose() } catch {}
Start-App $Exe $null -KeepSession
Start-Sleep -Milliseconds 1500
$r = J "const d=docs.find(d=>d.path&&d.path.endsWith('notes.md')); setActiveTab(d.id); return d.lang + '|' + d.langOverride + '|' + previewModeBtn.textContent"
T 'Preview mode choice survives a restart' "exited=$exited $r" ($exited -and $r -eq 'bbcode|true|BB')

# ---------- updates: already up to date ----------
$rel = "$sp\update-test"; Remove-Item $rel -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $rel | Out-Null
$exeUrl = 'file:///' + ("$rel\new.exe").Replace('\', '/')
function Write-Release([string]$tag, [string]$digest, [long]$size) {
    $o = @{ tag_name = $tag; html_url = 'https://github.com/mccabedd/notepad.md/releases/tag/' + $tag; body = "Test release $tag"; assets = @(@{ name = 'notepad.md-' + $tag + '-win-x64.exe'; browser_download_url = $exeUrl; size = $size; digest = $digest }) }
    [IO.File]::WriteAllText("$rel\release.json", ($o | ConvertTo-Json -Depth 5))
}
Stop-App
$env:NOTEPADMD_UPDATE_URL = 'file:///' + ("$rel\release.json").Replace('\', '/')
Write-Release "v$AppVersion" $null 0
Start-App $Exe $null -KeepSession
Start-Sleep -Milliseconds 800
$r = J "await showAbout(); await checkForUpdates(); return aboutStatus.textContent"
T 'Check for Updates: same version -> up to date' $r ($r -eq "✓ You have the latest version (v$AppVersion).")
Copy-Item $Exe "$rel\new.exe"
Write-Release 'v99.0.0' 'sha256:0000000000000000000000000000000000000000000000000000000000000000' (Get-Item "$rel\new.exe").Length
$r = J "const p = checkForUpdates(); await new Promise(r=>setTimeout(r,1500)); return aboutStatus.textContent"
Start-Sleep -Milliseconds 300
# The update question is notepad.md's own dialog (since v1.4.2): check it's showing, then click "Update now".
$askShown = (J "const box = document.getElementById('save-ask'); const b = document.getElementById('save-ask-yes'); if (box.classList.contains('hidden') || !b || b.textContent !== 'Update now') return 'no'; b.click(); return 'yes'") -eq 'yes'
Start-Sleep -Milliseconds 3000
$r = J "return aboutStatus.textContent + '|' + aboutStatus.classList.contains('error')"
T 'Corrupted download is rejected (checksum), app keeps running' "ask=$askShown $r" ($askShown -and $r -eq 'The download failed its checksum test, so it was not installed.|true' -and -not $script:proc.HasExited)
Stop-App

# ---------- updates: full install on a COPY of the app ----------
$appDir = "$sp\update-app"; Remove-Item $appDir -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $appDir | Out-Null
Copy-Item $Exe "$appDir\notepad.md.exe"
# "new version" = same program with a marker appended (still a valid exe)
$bytes = [IO.File]::ReadAllBytes($Exe) + [Text.Encoding]::ASCII.GetBytes('NOTEPADMD-UPDATE-TEST-MARKER')
[IO.File]::WriteAllBytes("$rel\new.exe", $bytes)
$hash = (Get-FileHash "$rel\new.exe" -Algorithm SHA256).Hash.ToLower()
Write-Release 'v9.9.9' "sha256:$hash" $bytes.Length
Start-App "$appDir\notepad.md.exe" $null -KeepSession
Start-Sleep -Milliseconds 800
$oldPid = $script:proc.Id
J "await showAbout(); checkForUpdates(); return 1" | Out-Null
Start-Sleep -Milliseconds 1500
# The update question is notepad.md's own dialog (since v1.4.2): check it's showing, then click "Update now".
$askShown = (J "const box = document.getElementById('save-ask'); const b = document.getElementById('save-ask-yes'); if (box.classList.contains('hidden') || !b || b.textContent !== 'Update now') return 'no'; b.click(); return 'yes'") -eq 'yes'
$gone = $script:proc.WaitForExit(15000)
Start-Sleep -Milliseconds 2500
$newProc = Get-Process notepad.md -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$appDir\notepad.md.exe" -and $_.Id -ne $oldPid } | Select-Object -First 1
$installedHash = (Get-FileHash "$appDir\notepad.md.exe" -Algorithm SHA256).Hash.ToLower()
$oldLeft = Test-Path "$appDir\notepad.md.old"
T 'Update: confirm prompt -> old app exits -> exe replaced -> new app running' "ask=$askShown exited=$gone replaced=$($installedHash -eq $hash) newProcess=$([bool]$newProc) oldFileCleanedUp=$(-not $oldLeft)" ($askShown -and $gone -and $installedHash -eq $hash -and $newProc -and -not $oldLeft)
if ($newProc) {
    # The relaunched copy inherited the DevTools port: check it reopened the tabs.
    $script:proc = $newProc
    try {
        $script:ws = $null
        $targets = Invoke-RestMethod "http://127.0.0.1:9333/json" -TimeoutSec 3
        $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
        $script:ws = New-Object System.Net.WebSockets.ClientWebSocket
        $script:ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
        # Wait until the restarted page has loaded (startup takes a moment longer on a busy machine).
        for ($k = 0; $k -lt 40 -and (Eval "typeof docs !== 'undefined' && docs.length > 0") -ne $true; $k++) { Start-Sleep -Milliseconds 250 }
        $r = J "return docs.map(d=>tabTitle(d)).join(',')"
        T 'Updated app reopened the tabs' $r ($r -like '*notes.md*forum.bbcode*data.json*')
    } catch { T 'Updated app reopened the tabs' "could not connect: $_" $false }
}
Stop-App
Remove-Item Env:NOTEPADMD_UPDATE_URL
Remove-Item "HKCU:\Software\NotepadMD-Test" -Recurse -Force -ErrorAction SilentlyContinue

$results | Format-Table -AutoSize -Wrap | Out-String -Width 260
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
