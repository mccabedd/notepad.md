param([string]$Exe)
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
. "$PSScriptRoot\cdpkeys.ps1"
Copy-Item "$PSScriptRoot\fixtures\sample.md" "$sp\test.md" -Force
Start-App $Exe "$sp\test.md"
Install-KeyLog

$results = New-Object System.Collections.ArrayList
function Check([string]$name, [string]$focusCtx, $before, $after, [bool]$pass) {
    $kl = Pop-KeyLog
    [void]$results.Add([pscustomobject]@{ Shortcut = $name; Focus = $focusCtx; Before = "$before"; After = "$after"; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Event = $kl })
}

function Focus-Ctx([string]$ctx) {
    switch ($ctx) {
        'preview' { Eval "setLayoutMode(layoutMode==='edit-only'?'preview-only':layoutMode); preview.focus(); document.activeElement===preview" | Out-Null }
        'editor'  { Eval "if(layoutMode==='preview-only') setLayoutMode('split-ep'); editor.focus(); editorHasFocus()" | Out-Null }
        'body'    { Eval "document.activeElement && document.activeElement.blur(); true" | Out-Null }
    }
}

foreach ($ctx in 'preview', 'editor', 'body') {
    Eval "setLayoutMode('preview-only'); true" | Out-Null
    Focus-Ctx $ctx

    # ---- Layout modes (the red box) ----
    $layoutTests = @(
        @{ n = 'Ctrl+Alt+2'; k = '2'; c = 'Digit2'; vk = 0x32; want = 'preview-only' },
        @{ n = 'Ctrl+Alt+3'; k = '3'; c = 'Digit3'; vk = 0x33; want = 'split-ep' },
        @{ n = 'Ctrl+Alt+4'; k = '4'; c = 'Digit4'; vk = 0x34; want = 'split-pe' },
        @{ n = 'Ctrl+Alt+1'; k = '1'; c = 'Digit1'; vk = 0x31; want = 'edit-only' },
        @{ n = 'Ctrl+Alt+2 (Nordic AltGr: key=@)'; k = '@'; c = 'Digit2'; vk = 0x32; want = 'preview-only' },
        @{ n = 'Ctrl+Alt+3 (German AltGr: key=3sup)'; k = [string][char]0x00B3; c = 'Digit3'; vk = 0x33; want = 'split-ep' },
        @{ n = 'Ctrl+Alt+4 (UK AltGr: key=EUR)'; k = [string][char]0x20AC; c = 'Digit4'; vk = 0x34; want = 'split-pe' },
        @{ n = 'Ctrl+Alt+1 (key=Unidentified)'; k = 'Unidentified'; c = 'Digit1'; vk = 0x31; want = 'edit-only' },
        @{ n = 'Ctrl+Alt+Numpad2'; k = '2'; c = 'Numpad2'; vk = 0x62; want = 'preview-only' },
        @{ n = 'Ctrl+Alt+Numpad1'; k = '1'; c = 'Numpad1'; vk = 0x61; want = 'edit-only' }
    )
    foreach ($t in $layoutTests) {
        Focus-Ctx $ctx
        $b = Eval 'layoutMode'
        Send-Key @('CTRL', 'ALT') $t.k $t.c $t.vk
        $a = Eval 'layoutMode'
        Check $t.n $ctx $b $a ($a -eq $t.want)
    }
    Eval "setLayoutMode('preview-only'); true" | Out-Null
    Focus-Ctx $ctx

    # ---- Toggles ----
    $b = Eval "toolbarEl.classList.contains('hidden')"; Send-Key @('CTRL') 't' 'KeyT' 0x54; $a = Eval "toolbarEl.classList.contains('hidden')"
    Check 'Ctrl+T (toolbar)' $ctx "hidden=$b" "hidden=$a" ($a -ne $b)
    Send-Key @('CTRL') 't' 'KeyT' 0x54; [void](Pop-KeyLog)

    $b = Eval 'lineNumbersVisible'; Send-Key @('CTRL', 'SHIFT') 'L' 'KeyL' 0x4C; $a = Eval 'lineNumbersVisible'
    Check 'Ctrl+Shift+L (line numbers)' $ctx $b $a ($a -ne $b)
    Send-Key @('CTRL', 'SHIFT') 'L' 'KeyL' 0x4C; [void](Pop-KeyLog)

    $b = Eval "document.documentElement.dataset.theme"; Send-Key @('CTRL', 'SHIFT') 'D' 'KeyD' 0x44; $a = Eval "document.documentElement.dataset.theme"
    Check 'Ctrl+Shift+D (theme)' $ctx $b $a ($a -ne $b)
    Send-Key @('CTRL', 'SHIFT') 'D' 'KeyD' 0x44; [void](Pop-KeyLog)

    # ---- Font size ----
    Focus-Ctx $ctx
    $b = Eval 'getActive().fontSize'; Send-Key @('CTRL') '=' 'Equal' 0xBB; $a = Eval 'getActive().fontSize'
    Check 'Ctrl+= (font up)' $ctx $b $a ([int]$a -eq [int]$b + 1)
    $b = $a; Send-Key @('CTRL', 'SHIFT') '+' 'Equal' 0xBB; $a = Eval 'getActive().fontSize'
    Check 'Ctrl+Shift+= i.e. Ctrl++ (font up)' $ctx $b $a ([int]$a -eq [int]$b + 1)
    $b = $a; Send-Key @('CTRL') '+' 'NumpadAdd' 0x6B; $a = Eval 'getActive().fontSize'
    Check 'Ctrl+Numpad+ (font up)' $ctx $b $a ([int]$a -eq [int]$b + 1)
    $b = $a; Send-Key @('CTRL') '-' 'Minus' 0xBD; $a = Eval 'getActive().fontSize'
    Check 'Ctrl+- (font down)' $ctx $b $a ([int]$a -eq [int]$b - 1)
    $b = $a; Send-Key @('CTRL') '-' 'NumpadSubtract' 0x6D; $a = Eval 'getActive().fontSize'
    Check 'Ctrl+Numpad- (font down)' $ctx $b $a ([int]$a -eq [int]$b - 1)
    Eval "getActive().fontSize=14; applyFontSize(); true" | Out-Null
    [void](Pop-KeyLog)
    Eval "1" | Out-Null

    # ---- Find ----
    Focus-Ctx $ctx
    $b = Eval "findBar.classList.contains('hidden')"; Send-Key @('CTRL') 'f' 'KeyF' 0x46; $a = Eval "findBar.classList.contains('hidden')"
    Check 'Ctrl+F (find)' $ctx "hidden=$b" "hidden=$a" ($a -eq $false)
    Send-Key @() 'Escape' 'Escape' 0x1B; $a2 = Eval "findBar.classList.contains('hidden')"
    Check 'Esc in find box (close find)' 'find-input' 'hidden=False' "hidden=$a2" ($a2 -eq $true)

    # ---- Tabs ----
    Focus-Ctx $ctx
    $b = Eval 'docs.length'; Send-Key @('CTRL') 'n' 'KeyN' 0x4E; $a = Eval 'docs.length'
    Check 'Ctrl+N (new doc)' $ctx "docs=$b" "docs=$a" ([int]$a -eq [int]$b + 1)
    Focus-Ctx $ctx
    $b = Eval 'activeId'; Send-Key @('CTRL') 'Tab' 'Tab' 0x09; $a = Eval 'activeId'
    Check 'Ctrl+Tab (next tab)' $ctx "active=$b" "active=$a" ($a -ne $b)
    Focus-Ctx $ctx
    $b = $a; Send-Key @('CTRL', 'SHIFT') 'Tab' 'Tab' 0x09; $a = Eval 'activeId'
    Check 'Ctrl+Shift+Tab (prev tab)' $ctx "active=$b" "active=$a" ($a -ne $b)
    Focus-Ctx $ctx
    Eval "setActiveTab(docs[docs.length-1].id); true" | Out-Null
    $b = Eval 'docs.length'; Send-Key @('CTRL') 'w' 'KeyW' 0x57; $a = Eval 'docs.length'
    Check 'Ctrl+W (close tab)' $ctx "docs=$b" "docs=$a" ([int]$a -eq [int]$b - 1)
    Close-Dialogs | Out-Null

    # ---- File ops ----
    Focus-Ctx $ctx
    $mt = (Get-Item "$sp\test.md").LastWriteTimeUtc
    Start-Sleep -Milliseconds 1100
    Send-Key @('CTRL') 's' 'KeyS' 0x53; Start-Sleep -Milliseconds 500
    $mt2 = (Get-Item "$sp\test.md").LastWriteTimeUtc
    Check 'Ctrl+S (save)' $ctx "mtime=$($mt.ToString('HH:mm:ss'))" "mtime=$($mt2.ToString('HH:mm:ss'))" ($mt2 -gt $mt)

    Focus-Ctx $ctx
    Send-Key @('CTRL') 'o' 'KeyO' 0x4F; for ($i = 0; $i -lt 25 -and -not (Has-Dialog); $i++) { Start-Sleep -Milliseconds 200 }
    $d = Has-Dialog; Close-Dialogs | Out-Null; Start-Sleep -Milliseconds 300
    Check 'Ctrl+O (open dialog)' $ctx 'no dialog' "dialog=$d" $d

    Focus-Ctx $ctx
    Send-Key @('CTRL', 'SHIFT') 'S' 'KeyS' 0x53; for ($i = 0; $i -lt 25 -and -not (Has-Dialog); $i++) { Start-Sleep -Milliseconds 200 }
    $d = Has-Dialog; Close-Dialogs | Out-Null; Start-Sleep -Milliseconds 300
    Check 'Ctrl+Shift+S (save-as dialog)' $ctx 'no dialog' "dialog=$d" $d
}

Stop-App
$results | Format-Table -AutoSize -Wrap | Out-String -Width 260
"PASS: $(($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(($results | Where-Object Result -eq 'FAIL').Count)"
