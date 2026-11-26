param([string]$Exe)
# Settings > Spelling > Spell-check log files: off by default (log files are mostly program
# output), on: misspelt words in a log are underlined; remembered after a restart. Plain text is
# always checked. Works with either editor.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
$work = "$sp\work-spelllogs"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
$log = "2026-11-20 08:36:06.979 [ERROR] worker-3 request failed: speling mitsake in the message`n2026-11-20 08:36:07.016 [INFO] worker-14 request completed`n"
[IO.File]::WriteAllText("$work\app.log", $log, (New-Object Text.UTF8Encoding $false))
[IO.File]::WriteAllText("$work\notes.txt", "A speling mitsake in plain text.`n", (New-Object Text.UTF8Encoding $false))
$w = $work.Replace('\', '/')
# The words underlined in the editor, once the spellchecker has answered.
$errs = "const errs = async () => { for (let i = 0; i < 40; i++) { const e = [...edLayer().querySelectorAll('.spell-err')].map(s => s.dataset.w || s.textContent); if (e.length) return e; await new Promise(r => setTimeout(r, 150)); } return []; };"

Start-App $Exe $null
$r = J "openSettings(); const box = document.querySelector('#settings [data-s=spellLogs]'); const out = JSON.stringify([settings.spellLogs, !!box, box && box.checked]); closeSettings(); return out"
T 'Spell-check log files is off by default (checkbox in Settings > Spelling)' $r ($r -eq '[false,true,false]')
$r = J "$errs const d = await openPath('$w/app.log'); setLayoutMode('edit-only'); await new Promise(r => setTimeout(r, 1500)); return JSON.stringify([d.lang, (await errs()).length])"
T 'A log file is not spell-checked by default' $r ($r -eq '["log",0]')
$r = J "$errs await openPath('$w/notes.txt'); setLayoutMode('edit-only'); return JSON.stringify((await errs()).sort())"
T 'Plain text is spell-checked as before' $r ($r -eq '["mitsake","speling"]')

# Turn it on with the checkbox, as a user would.
$r = J "$errs setActiveTab(docs.find(d => d.path && d.path.endsWith('app.log')).id); openSettings(); const box = document.querySelector('#settings [data-s=spellLogs]'); box.click(); closeSettings(); return JSON.stringify([settings.spellLogs, (await errs()).sort()])"
T 'Ticking it underlines the misspelt words in the log at once' $r ($r -eq '[true,["mitsake","speling"]]')
$r = J "$errs const e = await errs(); return JSON.stringify(e.filter(w => /^(ERROR|INFO|worker|request)$/i.test(w)))"
T 'Log words that are real English are not flagged (ERROR, INFO, worker, request)' $r ($r -eq '[]')
J "await saveSessionNow(); return 1" | Out-Null
Stop-App
Start-App $Exe $null -KeepSession
$r = J "$errs const d = docs.find(x => x.path && x.path.endsWith('app.log')); setActiveTab(d.id); setLayoutMode('edit-only'); return JSON.stringify([settings.spellLogs, (await errs()).sort()])"
T 'The setting is remembered after a restart' $r ($r -eq '[true,["mitsake","speling"]]')
$r = J "openSettings(); document.querySelector('#settings [data-s=spellLogs]').click(); closeSettings(); await new Promise(r => setTimeout(r, 600)); return JSON.stringify([settings.spellLogs, edLayer().querySelectorAll('.spell-err').length])"
T 'Unticking it removes the underlines from the log' $r ($r -eq '[false,0]')
Stop-App
$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
