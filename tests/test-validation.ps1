param([string]$Exe)
# File recognition (extensions, special names), Settings > File Types (in a throwaway registry key),
# syntax validation (JSON, JSONC, JSON5, JSON Lines, YAML, TOML, XML), markers, fixes and navigation.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
function Lit([string]$s) { return ($s | ConvertTo-Json -Compress) }
# -like with [ and ] taken literally (they are wildcard characters otherwise).
function L([string]$s, [string]$pat) { return $s -like $pat.Replace('[', '`[').Replace(']', '`]') }
function Key($key, $code, $vk, $mods = 0) {
    Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = $key; code = $code; windowsVirtualKeyCode = $vk; modifiers = $mods } | Out-Null
    Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $key; code = $code; windowsVirtualKeyCode = $vk; modifiers = $mods } | Out-Null
}
# Puts text in the tab as language $lang, checks it now and returns the problems as JSON.
function Check([string]$lang, [string]$text) {
    $t = Lit $text
    J "const d = getActive(); setDocLanguage('$lang'); editor.value = $t; syncFromEditor(); runValidation(d); for (let i = 0; i < 100 && !(d.diag && d.diag.text === d.content); i++) await new Promise(r => setTimeout(r, 30)); return JSON.stringify((d.diag ? d.diag.list : null) && d.diag.list.map(x => [x.line + 1, x.col + 1, x.severity, x.message, x.fix ? x.fix.label : null]))"
}

$regRoot = "Software\NotepadMD-Test-$PID"
$env:NOTEPADMD_REG_ROOT = "$regRoot\Classes"
Start-App $Exe $null
Remove-Item Env:NOTEPADMD_REG_ROOT
Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1100; height = 700; deviceScaleFactor = 1; mobile = $false } | Out-Null
Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null

# --- file recognition ---
$names = [ordered]@{
    'C:\x\Dockerfile' = 'dockerfile'; 'C:\x\Dockerfile.production' = 'dockerfile'; 'C:\x\Containerfile' = 'dockerfile'
    'C:\x\Makefile' = 'makefile'; 'C:\x\GNUmakefile' = 'makefile'; 'C:\x\Jenkinsfile' = 'groovy'; 'C:\x\Vagrantfile' = 'ruby'
    'C:\x\.env' = 'env'; 'C:\x\.env.production' = 'env'; 'C:\x\.bashrc' = 'bash'; 'C:\x\.zshrc' = 'bash'; 'C:\x\.profile' = 'bash'
    'C:\x\.gitignore' = 'ignore'; 'C:\x\.dockerignore' = 'ignore'; 'C:\x\.gitmodules' = 'ini'; 'C:\x\.editorconfig' = 'ini'
    'C:\x\.htaccess' = 'apache'; 'C:\x\.htpasswd' = 'htpasswd'; 'C:\x\requirements.txt' = 'requirements'; 'C:\x\Pipfile' = 'toml'
    'C:\x\Gemfile' = 'ruby'; 'C:\x\CMakeLists.txt' = 'cmake'; 'C:\x\compose.yaml' = 'compose'; 'C:\x\docker-compose.yml' = 'compose'
    'C:\x\docker-compose.prod.yml' = 'compose'; 'C:\x\compose.override.yaml' = 'compose'; 'C:\etc\nginx\nginx.conf' = 'nginx'
    'C:\etc\nginx\conf.d\site.conf' = 'nginx'; 'C:\x\app.conf' = 'ini'; 'C:\x\run.sh' = 'bash'; 'C:\x\a.zsh' = 'bash'
    'C:\x\a.fish' = 'bash'; 'C:\x\a.pl' = 'perl'; 'C:\x\a.rb' = 'ruby'; 'C:\x\a.awk' = 'awk'; 'C:\x\a.sql' = 'sql'
    'C:\x\a.jsonl' = 'jsonl'; 'C:\x\a.ndjson' = 'jsonl'; 'C:\x\a.jsonc' = 'jsonc'; 'C:\x\a.json5' = 'json5'
    'C:\x\main.tf' = 'hcl'; 'C:\x\a.tfvars' = 'hcl'; 'C:\x\a.service' = 'systemd'; 'C:\x\a.timer' = 'systemd'
    'C:\x\a.desktop' = 'desktop'; 'C:\x\a.patch' = 'diff'; 'C:\x\a.pem' = 'pem'; 'C:\x\a.crt' = 'pem'; 'C:\x\id_rsa.pub' = 'pem'
    'C:\x\a.log' = 'log'; 'C:\x\log.txt' = 'log'; 'C:\x\notes.txt' = 'plaintext'; 'C:\x\README.md' = 'markdown'
}
$bad = @()
foreach ($k in $names.Keys) {
    $p = $k.Replace('\', '\\')
    $got = J "return langForPath('$p')"
    if ($got -ne $names[$k]) { $bad += "$k=$got" }
}
T "Special file names, patterns and new extensions ($($names.Count) cases)" ($bad -join '; ') ($bad.Count -eq 0)
$r = J "return JSON.stringify(['dockerfile','nginx','apache','hcl','dotenv','ignorefile','pem','bash','sql','diff','perl','ruby','makefile'].filter(l => !hljs.getLanguage(l)))"
T 'Every new grammar is available for colouring' $r ($r -eq '[]')
$r = J "addDocAndActivate(newUntitledDoc()); setLayoutMode('edit-only'); setDocLanguage('dockerfile'); editor.value = 'FROM alpine:3.20 AS base\nRUN echo hi'; syncFromEditor(); await new Promise(r => setTimeout(r, 300)); return edLayer().querySelectorAll('.hljs-keyword').length"
T 'A Dockerfile is coloured' $r ([int]$r -ge 2)
$r = J "return JSON.stringify([Object.keys(EXT_LANG).includes('dockerfile'), Object.keys(EXT_LANG).some(e => e.startsWith('.') || /file$/.test(e) && e !== 'dockerfile'), supportedExtensions().includes('env'), supportedExtensions().includes('bashrc')])"
T 'Registerable list: real extensions only (no Makefile, .bashrc...)' $r ($r -eq '[true,false,true,false]')

# --- validation: JSON family ---
$r = Check 'json' "{`n  `"a`": 1,`n  `"b`": [true, null, `"x`"]`n}"
T 'Valid JSON: no problems' $r ($r -eq '[]')
$r = Check 'json' "{`n  `"name`": `"x`"`n  `"port`": 80`n}"
T 'JSON: missing comma (line, column, fix)' $r ($r -eq '[[2,14,"error","Expected a comma between object properties.","Insert a comma"]]')
$r = Check 'json' "{`"a`": [1, 2,],`n `"b`": 3,`n}"
T 'JSON: trailing commas (both found, fix offered)' $r (((L $r '*Trailing comma: there is no value after it.*')) -and ((L $r '*Trailing comma: there is no property after it.*')) -and ((L $r '*Remove the comma*')))
$r = Check 'json' "{`"path`": `"C:\qtemp`"}"
T 'JSON: invalid escape sequence (with fix)' $r (L $r '*Invalid escape sequence \\q.*Escape the backslash*')
$r = Check 'json' "{`"a`": `"abc,`n `"b`": 1}"
T 'JSON: unclosed string' $r ((L $r '*This string is not closed*Close the string*'))
$r = Check 'json' "{`"a`": [1, 2}"
T 'JSON: mismatched bracket' $r ((L $r '*Expected ] to close the [ on line 1, but found }*'))
$r = Check 'json' "{`"a`": {`"b`": 1}"
T 'JSON: unclosed brace at the end (fix adds it)' $r ((L $r '*is never closed*Add the missing }*'))
$r = Check 'json' "{name: 'x', ok: True}"
T 'JSON: unquoted key, single quotes, True (all with fixes)' $r (((L $r '*Property names must be in double quotes*')) -and ((L $r '*Strings must use double quotes*')) -and ((L $r '*Change it to true*')))
$r = Check 'json' "// comment`n{}"
T 'Strict JSON: comments are an error' $r ((L $r '*Comments are not allowed in JSON*'))
$r = Check 'json' "{`"a`": 1}`n{`"b`": 2}"
T 'JSON: extra content after the root value' $r ((L $r '*after the end of the JSON value*'))
$r = Check 'json' "{`"a`": 1, `"a`": 2}"
T 'JSON: duplicate key is a warning' $r ((L $r '*"warning","Duplicate key*'))
$r = Check 'jsonc' "{`n  // comment`n  /* block */ `"a`": [1, 2,],`n}"
T 'JSON with Comments: comments and trailing commas are fine' $r ($r -eq '[]')
$r = Check 'json5' "{unquoted: 'single', hex: 0xFF, inf: Infinity, half: .5, trailing: [1,],}"
T 'JSON5: its own syntax is fine' $r ($r -eq '[]')
$r = Check 'json5' "{a: 1 b: 2}"
T 'JSON5: still finds a missing comma' $r ((L $r '*Expected a comma*'))
$r = Check 'jsonl' "{`"a`": 1}`n{`"b`": 2,}`n`n[1, 2]"
T 'JSON Lines: each line checked on its own (line 2)' $r ((L $r '[[2,*Trailing comma*'))

# --- YAML, Docker Compose ---
$yamlOk = "services:`n  authelia:`n    image: authelia/authelia:latest`n    ports:`n      - `"9091:9091`"`n    restart: unless-stopped`n"
$r = Check 'yaml' $yamlOk
T 'Valid YAML: no problems' $r ($r -eq '[]')
$yamlBad = "services:`n  authelia:`n    image: authelia/authelia:latest`n    ports:`n      - `"9091:9091`"`n     restart: unless-stopped`n"
$r = Check 'compose' $yamlBad
T 'Compose (YAML): wrong indentation on line 6' $r ((L $r '[[6,6,"error","The indentation of this line does not fit*'))
$r = J "return getActive().diag.list[0].hint"
T 'YAML: the hint says what the line should line up with' $r ((L $r '*indented by 5 spaces*4 (ports)*'))
$r = Check 'yaml' "a: 1`nb: 2`na: 3`n"
T 'YAML: duplicate key' $r ((L $r '*Duplicate key*'))
$r = Check 'yaml' "a: 1`nb: `"unclosed"
T 'YAML: unclosed quote' $r ((L $r '*never closed*'))
$r = Check 'yaml' "a: *missing`n"
T 'YAML: undefined alias' $r ((L $r '*alias*missing*'))

# --- TOML ---
$r = Check 'toml' "title = `"x`"`n[server]`nport = 80`nhosts = [`"a`", `"b`"]`n"
T 'Valid TOML: no problems' $r ($r -eq '[]')
$r = Check 'toml' "title `"x`"`n"
T 'TOML: invalid assignment' $r ((L $r '[[1,*"error"*'))
$r = Check 'toml' "a = 1`na = 2`n"
T 'TOML: duplicate key' $r ((L $r '[[2,*'))
$r = Check 'toml' "[t]`nx = 1`n[t]`ny = 2`n"
T 'TOML: table defined twice' $r ((L $r '[[3,*'))

# --- XML ---
$r = Check 'xml' "<?xml version=`"1.0`"?>`n<root>`n  <item id=`"1`">x</item>`n</root>"
T 'Valid XML: no problems' $r ($r -eq '[]')
$r = Check 'xml' "<root>`n  <item>`n</root>"
T 'XML: unclosed / mismatched tag (line 3)' $r ((L $r '[[3,*does not match the open <item>*'))
$r = Check 'xml' "<root a=1></root>"
T 'XML: unquoted attribute' $r ((L $r '*Attribute values must be in quotes*'))
$r = Check 'xml' "<root>Tom & Jerry</root>"
T 'XML: bare &' $r ((L $r '*&amp;*'))
$r = J "const d = getActive(); setDocLanguage(null); d.path = 'C:\\x\\web.config'; d.lang = 'xml'; editor.value = '[not xml]'; syncFromEditor(); return String(validationMode(d))"
T '.config that is not XML is not checked as XML' $r ($r -eq 'null')
J "getActive().path = null; return 1" | Out-Null

# --- languages without a checker ---
$r = Check 'sql' "SELECT ( FROM"
T 'SQL: no misleading diagnostics (not checked)' $r ($r -eq 'null')
$r = J "return JSON.stringify([document.getElementById('status-diag').textContent])"
T 'Status bar says No syntax check for unchecked languages' $r ($r -eq '["No syntax check"]')

# --- editor integration ---
J "if (!lineNumbersVisible) toggleLineNumbers(); return 1" | Out-Null
$r = Check 'json' "{`n  `"name`": `"x`"`n  `"port`": 80`n}"
Start-Sleep -Milliseconds 300
$r = J "const g = edGutterRow(1); const m = g && g.diag; return JSON.stringify([!!m && (m.classList.contains('error') ? 'error' : m.className), edLayer().querySelectorAll('.diag-error').length, document.getElementById('status-diag').textContent])"
T 'Marker in the gutter, wavy underline, count in the status bar' $r ((L $r '["error",1,"*1 error"]'))
$r = J "const d = getActive(); d.bookmarks = {1: 'Red'}; bookmarksChanged(); await new Promise(r => setTimeout(r, 100)); const g = edGutterRow(1); return JSON.stringify([!!g.diag && g.diag.classList.contains('error'), g.margin.classList.contains('bm-red')])"
T 'Error marker and bookmark side by side on one line' $r ($r -eq '[true,true]')
$r = J "const d = getActive(); editor.focus(); editor.setSelectionRange(0, 0); editorInsertText('\n'); await new Promise(r => setTimeout(r, 100)); return JSON.stringify([!!(edGutterRow(2) || {}).diag, Object.keys(d.bookmarks)])"
T 'Marker and bookmark move down when a line is inserted above' $r ($r -eq '[true,["2"]]')
$r = J "const d = getActive(); for (let i = 0; i < 100 && !(d.diag && d.diag.text === d.content); i++) await new Promise(r => setTimeout(r, 30)); editor.setSelectionRange(0, 0); return 1"
Key 'F8' 'F8' 119 0
Start-Sleep -Milliseconds 400
$r = J "const pop = document.querySelector('.diag-pop'); return JSON.stringify([editor.selectionStart === getActive().diag.list[0].s, !!pop && pop.textContent.includes('Line 3, Column 14'), !!pop && !!pop.querySelector('button[data-act=apply]')])"
T 'F8 goes to the problem and explains it (Line 3, Column 14, Apply fix)' $r ($r -eq '[true,true,true]')
J "document.querySelector('.diag-pop button[data-act=apply]').click(); return 1" | Out-Null
Start-Sleep -Milliseconds 300
$r = J "const d = getActive(); for (let i = 0; i < 100 && !(d.diag && d.diag.text === d.content); i++) await new Promise(r => setTimeout(r, 30)); return JSON.stringify([d.content, d.diag.list.length])"
T 'Apply fix inserts the comma and the check passes' $r ($r -eq '["\n{\n  \"name\": \"x\",\n  \"port\": 80\n}",0]')
$r = J "editor.focus(); runToolbarCommand('undo'); await new Promise(r => setTimeout(r, 50)); return JSON.stringify(getActive().content)"
T 'Undo takes the fix back in one step' $r ($r -eq '"\n{\n  \"name\": \"x\"\n  \"port\": 80\n}"')
$r = J "const d = getActive(); const before = d.content; editor.value = '{}'; syncFromEditor(); finishValidation(d, before, 'json', [{s: 0, e: 1, line: 0, col: 0, severity: 'error', title: 'x', message: 'old'}]); return JSON.stringify(d.diag && d.diag.list.some(x => x.message === 'old'))"
T 'A result for older text is thrown away' $r ($r -eq 'false')

# switching tabs keeps each tab's own problems
$r = J "const a = getActive(); setDocLanguage('json'); editor.value = '{,}'; syncFromEditor(); runValidation(a); await new Promise(r => setTimeout(r, 300)); const b = newUntitledDoc(); addDocAndActivate(b); setLayoutMode('edit-only'); setDocLanguage('json'); editor.value = '{}'; syncFromEditor(); runValidation(b); await new Promise(r => setTimeout(r, 300)); const nb = b.diag.list.length; setActiveTab(a.id); await new Promise(r => setTimeout(r, 300)); const na = a.diag.list.length; const marks = editor.isCodeMirror ? editor.api.view.dom.querySelectorAll('.np-d').length : (renderGutter(), lineNumbersEl.querySelectorAll('.ln-d').length); setActiveTab(b.id); b.content = ''; b.savedContent = ''; b.dirty = false; await closeTab(b.id); return JSON.stringify([na > 0, nb, marks > 0])"
T 'Each tab keeps its own problems when switching' $r ($r -eq '[true,0,true]')

# settings
$r = J "changeSetting('validateEnabled', false); await new Promise(r => setTimeout(r, 200)); const d = getActive(); return JSON.stringify([d.diag, edLayer().querySelectorAll('.diag-error').length, document.getElementById('status-diag').classList.contains('hidden')])"
T 'Switching validation off removes every marker' $r ($r -eq '[null,0,true]')
J "changeSetting('validateEnabled', true); return 1" | Out-Null
$r = J "const d = getActive(); editor.value = '{' + ' '.repeat(6 * 1024 * 1024) + '}'; syncFromEditor(); await new Promise(r => setTimeout(r, 1200)); return JSON.stringify([d.diag, document.getElementById('status-diag').textContent])"
T 'Over 5 MB: not checked automatically' $r ($r -eq '[null,"JSON: not checked"]')
$r = J "const d = getActive(); const t0 = performance.now(); validateNow(); for (let i = 0; i < 200 && !(d.diag && d.diag.text === d.content); i++) await new Promise(r => setTimeout(r, 30)); return JSON.stringify([!!d.diag, Math.round(performance.now() - t0)])"
T 'Check Syntax Now still checks it (ms)' $r ((L $r '[true,*'))
J "editor.value = '{}'; syncFromEditor(); return 1" | Out-Null

# --- Settings > File Types (throwaway registry key) ---
J "openSettings(); showSettingsTab('filetypes'); await new Promise(r => setTimeout(r, 600)); return 1" | Out-Null
$r = J "const boxes = [...ftGrid.querySelectorAll('input[data-ext]')]; const rows = Number(ftGrid.style.getPropertyValue('--ft-rows')); const b0 = boxes[0].getBoundingClientRect(), b1 = boxes[1].getBoundingClientRect(), bR = boxes[rows].getBoundingClientRect(); return JSON.stringify([boxes.length === supportedExtensions().length, b1.top > b0.top && Math.abs(b1.left - b0.left) < 2, bR.left > b0.left + 50, ftCount.textContent, ftAll.checked, ftAll.indeterminate])"
T 'File Types: one box per extension, filled down each column, none registered' $r ((L $r '[true,true,true,"0 of *registered",false,false]'))
$r = J "const box = ftGrid.querySelector('input[data-ext=`"bat`"]'); box.click(); await new Promise(r => setTimeout(r, 100)); for (let i = 0; i < 200 && ftBusy; i++) await new Promise(r => setTimeout(r, 50)); await new Promise(r => setTimeout(r, 300)); return JSON.stringify([box.checked, ftAll.indeterminate, ftCount.textContent.startsWith('1 of'), box.closest('label').title.includes('still does what it did')])"
T 'Ticking .bat registers it (only Open with), All/None shows some' $r ($r -eq '[true,true,true,true]')
$batDefault = (Get-ItemProperty "HKCU:\$regRoot\Classes\.bat" -ErrorAction SilentlyContinue).'(default)'
$batProg = (Get-ItemProperty "HKCU:\$regRoot\Classes\.bat\OpenWithProgids" -ErrorAction SilentlyContinue).'NotepadMD.Document'
T 'Registry: .bat gets an Open with entry, its default is not set' "default=[$batDefault] openwith=$($batProg -ne $null)" (($batDefault -eq $null) -and ($batProg -ne $null))
$r = J "ftAll.click(); await new Promise(r => setTimeout(r, 100)); for (let i = 0; i < 200 && ftBusy; i++) await new Promise(r => setTimeout(r, 50)); await new Promise(r => setTimeout(r, 300)); return JSON.stringify([ftAll.checked, ftAll.indeterminate, [...ftGrid.querySelectorAll('input')].every(b => b.checked)])"
T 'All / None: registers every type' $r ($r -eq '[true,false,true]')
Remove-ItemProperty "HKCU:\$regRoot\Classes\.md\OpenWithProgids" -Name 'NotepadMD.Document' -ErrorAction SilentlyContinue
$r = J "closeSettings(true); openSettings(); await new Promise(r => setTimeout(r, 600)); return JSON.stringify([ftGrid.querySelector('input[data-ext=`"md`"]').checked, ftAll.indeterminate, settings.settingsTab])"
T 'A change made outside the app shows when Settings reopens (and the tab is remembered)' $r ($r -eq '[false,true,"filetypes"]')
$r = J "ftAll.click(); await new Promise(r => setTimeout(r, 100)); for (let i = 0; i < 200 && ftBusy; i++) await new Promise(r => setTimeout(r, 50)); await new Promise(r => setTimeout(r, 300)); return JSON.stringify([ftAll.checked, ftAll.indeterminate, [...ftGrid.querySelectorAll('input')].some(b => b.checked)])"
$r2 = J "ftAll.click(); await new Promise(r => setTimeout(r, 100)); for (let i = 0; i < 200 && ftBusy; i++) await new Promise(r => setTimeout(r, 50)); await new Promise(r => setTimeout(r, 300)); return JSON.stringify([ftAll.checked, ftAll.indeterminate, [...ftGrid.querySelectorAll('input')].some(b => b.checked)])"
T 'All / None from some: all; again: none' "$r then $r2" (($r -eq '[true,false,true]') -and ($r2 -eq '[false,false,false]'))
$prog = Test-Path "HKCU:\$regRoot\Classes\NotepadMD.Document"
T 'None registered: the shared Open with entry is removed too' "progid exists=$prog" (-not $prog)
$r = J "const tabs = [...document.querySelectorAll('.settings-tabs [role=tab]')]; tabs[1].focus(); tabs[1].dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true})); return JSON.stringify([settings.settingsTab, document.activeElement.id, [...document.querySelectorAll('#settings-body > section')].filter(s => !s.hidden).map(s => s.dataset.tab)[0]])"
T 'Arrow keys move between Settings pages' $r ($r -eq '["validation","stab-validation","validation"]')
J "showSettingsTab('general'); closeSettings(true); return 1" | Out-Null

Stop-App
Remove-Item "HKCU:\$regRoot" -Recurse -ErrorAction SilentlyContinue

$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
