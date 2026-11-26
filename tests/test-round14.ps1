param([string]$Exe)
# v1.0.6: View > Language submenu (every language, ticked), log.txt colouring.
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class Menu14 {
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr m, int pos);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
    [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr m, uint id, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr m, uint id, StringBuilder sb, int max, uint flags);
    static string Name(IntPtr m, int i) { var s = new StringBuilder(256); GetMenuString(m, (uint)i, s, 256, 0x400); return s.ToString(); }
    public static IntPtr Find(IntPtr m, string start) { int n = GetMenuItemCount(m); for (int i = 0; i < n; i++) if (Name(m, i).StartsWith(start)) return GetSubMenu(m, i); return IntPtr.Zero; }
    // "label" with a * when ticked
    public static string Items(IntPtr m) { var sb = new StringBuilder(); int n = GetMenuItemCount(m); for (int i = 0; i < n; i++) { string s = Name(m, i); if (s == "") continue; sb.Append(s); if ((GetMenuState(m, (uint)i, 0x400) & 0x8) != 0) sb.Append("*"); sb.Append("|"); } return sb.ToString(); }
}
"@ -ErrorAction SilentlyContinue
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
function Write-NoBom([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }
function LangMenu { $h = (Get-Process -Id $script:proc.Id).MainWindowHandle; $view = [Menu14]::GetSubMenu([Menu14]::GetMenu($h), 2); return [Menu14]::Items([Menu14]::Find($view, 'Language')) }
$work = "$sp\work14"; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
$w = $work.Replace('\', '\\')

Start-App $Exe $null
Start-Sleep -Milliseconds 500
$r = J "return document.getElementById('about-version').textContent"
T "About shows v$AppVersion" $r ($r -eq "v$AppVersion")
$m = LangMenu
T 'View > Language lists every language' $m ($m -eq 'Auto-detect from File Name*|Markdown*|Plain Text|BBCode|Log File|Web and Data|Scripts|Configuration|Programming|Certificates and Keys|')

# New tab, type HTML, View > Language > HTML (the menu click sends menu-lang-html)
J "addDocAndActivate(newUntitledDoc()); setLayoutMode('preview-only'); return 1" | Out-Null
J "setLayoutMode('edit-only'); editor.focus(); editor.value='<!DOCTYPE html>\n<html>\n  <body class=main>\n    <p>Hello</p>\n  </body>\n</html>\n'; editor.dispatchEvent(new Event('input')); return 1" | Out-Null
$r = J "return JSON.stringify([getActive().lang, edLayer().querySelectorAll('.hljs-tag').length])"
T 'Before: a new tab is Markdown' $r ($r.StartsWith('["markdown",'))
J "await window.__TAURI__.event.emit('menu-lang-html'); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null
$r = J "return JSON.stringify([getActive().lang, (editor.isCodeMirror || editor.classList.contains('hl-active')), edLayer().querySelectorAll('.hljs-tag').length > 3, !!edLayer().querySelector('.hljs-attr'), statusLang.textContent, getActive().layoutMode])"
T 'View > Language > HTML colours the HTML in the editor' $r ($r -eq '["html",true,true,true,"HTML","edit-only"]')
Start-Sleep -Milliseconds 300
$m = LangMenu
$h = J "return JSON.stringify([currentMenuChecks().lang_html, currentMenuChecks().lang_auto])"
T 'The menu ticks HTML (not Auto-detect)' "$m $h" (($m -like 'Auto-detect from File Name|Markdown|*') -and $h -eq '[true,false]')
J "await window.__TAURI__.event.emit('menu-lang-python'); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null
$r = J "return getActive().lang + '|' + statusLang.textContent"
T 'Any other language can be chosen the same way' $r ($r -eq 'python|Python')
J "await window.__TAURI__.event.emit('menu-lang-auto'); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null
$r = J "return getActive().lang"
T 'Auto-detect puts an untitled tab back to Markdown' $r ($r -eq 'markdown')
J "await window.__TAURI__.event.emit('menu-lang-html'); setLayoutMode('preview-only'); await window.__TAURI__.event.emit('menu-lang-css'); await new Promise(r=>setTimeout(r,300)); return 1" | Out-Null
$r = J "return getActive().layoutMode"
T 'Choosing a code language from Preview Only shows the editor' $r ($r -eq 'edit-only')

# log.txt (any case) is coloured; other .txt files are not
$logText = "2024-10-14 14:30:05,431 INFO  [main] Service started successfully`n2024-10-14 14:30:06,002 WARN  Disk space low: free=512MB`n2024-10-14 14:30:07,100 ERROR Move Operation failed for C:\Data\file.edf id=3f2504e0-4f89-11d3-9a0c-0305e82c3301`n   at Nox.Mover.Run()`n2024-10-14 14:30:08,000 DEBUG heartbeat`n"
foreach ($n in 'log.txt', 'LOG.TXT', 'Log.Txt') {
    $i14++; $sub = "$work\dir$i14"; New-Item -ItemType Directory $sub | Out-Null
    Write-NoBom "$sub\$n" $logText
    $p = "$sub\$n".Replace('\', '\\')
    $r = J "await openPath('$p'); return JSON.stringify([getActive().lang, statusLang.textContent, getActive().layoutMode])"
    T "$n opens as a Log File (Edit Only)" $r ($r -eq '["log","Log File","edit-only"]')
}
$r = J "const q=(c)=>[...edLayer().querySelectorAll('.hljs-'+c)].map(e=>e.textContent); return JSON.stringify({err:q('logerror'), warn:q('logwarn'), info:q('loginfo'), dbg:q('logdebug'), ok:q('logok'), time:q('logtime').length, path:q('logpath'), stack:q('comment').length, num:q('number').length})"
$o = $r | ConvertFrom-Json
T 'Log colours: ERROR / failed red, WARN amber, INFO blue, DEBUG grey' $r ((@($o.err) -contains 'ERROR') -and (@($o.err) -contains 'failed') -and (@($o.warn) -contains 'WARN') -and (@($o.info) -contains 'INFO') -and (@($o.dbg) -contains 'DEBUG'))
T 'Log colours: times, success words, paths, ids and stack lines' $r ($o.time -ge 4 -and (@($o.ok) -contains 'successfully') -and ($o.path -join '') -like 'C:\Data\file.edf*' -and $o.stack -ge 1 -and $o.num -ge 2)
$r = J "return getComputedStyle(edLayer().querySelector('.hljs-logerror')).color + '|' + getComputedStyle(edLayer().querySelector('.hljs-logwarn')).color"
T 'Log colours are actually applied' $r ($r -match '^rgb\(\d+, \d+, \d+\)\|rgb\(\d+, \d+, \d+\)$' -and $r.Split('|')[0] -ne $r.Split('|')[1])
$r = J "const s=getComputedStyle(edLayer().querySelector('.hljs-logerror')); return s.fontWeight + '|' + s.fontStyle"
T 'Log colours keep the editor text widths (no bold/italic)' $r ($r -eq '400|normal')
foreach ($n in 'notes.txt', 'mylog.txt', 'log.txt.bak', 'app.log') {
    Write-NoBom "$work\$n" $logText
    $r = J "await openPath('$w\\$n'); return getActive().lang"
    # Every .log file is a Log File (since the extended file types); other .txt files stay plain text.
    $want = if ($n -like '*.log') { 'log' } else { 'plaintext' }
    T "$n opens as $want" $r ($r -eq $want)
}

# A Log tab and a language chosen for an untitled tab survive a restart
J "for (const d of docs) { if (d.dirty && d.path) { d.savedContent=d.content; d.dirty=false; } } await saveSessionNow(); return 1" | Out-Null
Stop-App
Start-Sleep -Milliseconds 800
Start-App $Exe $null -KeepSession
Start-Sleep -Milliseconds 800
$r = J "return JSON.stringify([docs.filter(d=>d.path && basename(d.path).toLowerCase()==='log.txt').map(d=>d.lang), docs.filter(d=>!d.path && d.lang==='css').length])"
T 'After a restart: log.txt tabs are still Log, the untitled CSS tab is still CSS' $r ($r -eq '[["log","log","log"],1]')
Stop-App
$results | Format-Table -AutoSize -Wrap | Out-String -Width 220
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
