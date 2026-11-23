# Test harness: launch notepad.md with a CDP debug port, send real keystrokes, read JS state.
# Everything the tests write (session, WebView2 profile, sample files) lives in $script:TestDir
# (NOTEPADMD_TEST_DIR, default %TEMP%\notepadmd-tests), never in your real profile.
$script:TestDir = . "$PSScriptRoot\testdir.ps1"
# The version being tested (About box, update checks) comes from the project, not the test.
$script:AppVersion = (Get-Content "$PSScriptRoot\..\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KB {
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
    public static bool ForceForeground(IntPtr h) {
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(fg, out dummy);
        uint me = GetCurrentThreadId();
        AttachThreadInput(me, fgThread, true);
        ShowWindow(h, 9);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        AttachThreadInput(me, fgThread, false);
        if (GetForegroundWindow() != h) SwitchToThisWindow(h, true);
        return GetForegroundWindow() == h;
    }
    public static IntPtr MainWin(uint pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p == pid && IsWindowVisible(h)) {
                var t = new StringBuilder(256); GetWindowText(h, t, 256);
                if (t.ToString().Contains("notepad.md")) { found = h; return false; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    public static void Key(byte vk, bool up) {
        uint flags = up ? 2u : 0u;
        // extended keys
        if (vk == 0x2D || vk == 0x2E || (vk >= 0x21 && vk <= 0x28) || vk == 0x6F) flags |= 1u;
        keybd_event(vk, (byte)MapVirtualKey(vk, 0), flags, UIntPtr.Zero);
    }
    public static string ProcWindows(uint pid) {
        var sb = new StringBuilder();
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p == pid && IsWindowVisible(h)) {
                var c = new StringBuilder(256); GetClassName(h, c, 256);
                var t = new StringBuilder(256); GetWindowText(h, t, 256);
                sb.Append(c.ToString() + "|" + t.ToString() + ";");
            }
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }
}
"@

$script:ws = $null
$script:msgId = 0

function Start-App([string]$exe, [string]$file, [int]$port = 9333, [switch]$KeepSession) {
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($script:TestDir) -and $_.ProcessName -match "^(notepad-md|notepad.md|np[0-9]+)$" } | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    $env:NOTEPADMD_DATA_DIR = "$script:TestDir\appdata"
    if (-not $KeepSession) { Remove-Item "$env:NOTEPADMD_DATA_DIR\session.json" -ErrorAction SilentlyContinue }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
    # separate profile so we don't clash with a copy of the app the user has open
    $env:WEBVIEW2_USER_DATA_FOLDER = "$script:TestDir\wv2data"
    if ($file) { $script:proc = Start-Process $exe -ArgumentList "`"$file`"" -PassThru } else { $script:proc = Start-Process $exe -PassThru }
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER
    $wsUrl = $null
    for ($i = 0; $i -lt 40 -and -not $wsUrl; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $targets = Invoke-RestMethod "http://127.0.0.1:$port/json" -TimeoutSec 2
            $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
            if ($page) { $wsUrl = $page.webSocketDebuggerUrl }
        } catch {}
    }
    if (-not $wsUrl) { throw "No CDP target found" }
    $script:ws = New-Object System.Net.WebSockets.ClientWebSocket
    $script:ws.ConnectAsync([Uri]$wsUrl, [Threading.CancellationToken]::None).Wait()
    # wait for the app's init to finish
    for ($i = 0; $i -lt 20; $i++) { if ((Eval "typeof statusLayout !== 'undefined' && !!statusLayout.textContent") -eq $true) { break }; Start-Sleep -Milliseconds 250 }
}

function Cdp([string]$method, $params) {
    $script:msgId++
    $id = $script:msgId
    $msg = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
    $script:ws.SendAsync([ArraySegment[byte]]$bytes, 'Text', $true, [Threading.CancellationToken]::None).Wait()
    while ($true) {
        $buf = New-Object byte[] 1048576
        $sb = New-Object Text.StringBuilder
        do {
            $r = $script:ws.ReceiveAsync([ArraySegment[byte]]$buf, [Threading.CancellationToken]::None).Result
            [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
        } while (-not $r.EndOfMessage)
        $resp = $sb.ToString() | ConvertFrom-Json
        if ($resp.id -eq $id) { return $resp }
    }
}

function Eval([string]$expr) {
    $r = Cdp 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true; awaitPromise = $true }
    if ($r.result.exceptionDetails) { return "EXC: " + $r.result.exceptionDetails.exception.description }
    return $r.result.result.value
}

function Focus-App {
    $h = [IntPtr]::Zero
    for ($i = 0; $i -lt 20 -and $h -eq [IntPtr]::Zero; $i++) { $h = [KB]::MainWin([uint32]$script:proc.Id); if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 } }
    $script:hwnd = $h
    if ($h -eq [IntPtr]::Zero) { return $false }
    for ($i = 0; $i -lt 5; $i++) { if ([KB]::ForceForeground($h)) { break }; Start-Sleep -Milliseconds 200 }
    Start-Sleep -Milliseconds 300
    # make sure the page has keyboard focus
    Eval "(document.getElementById('preview')||document.body).focus(); true" | Out-Null
    Start-Sleep -Milliseconds 150
    return ([KB]::GetForegroundWindow() -eq $h)
}

$VK = @{ CTRL = 0x11; ALT = 0x12; SHIFT = 0x10; TAB = 0x09; ESC = 0x1B; ENTER = 0x0D
         OEM_PLUS = 0xBB; OEM_MINUS = 0xBD; ADD = 0x6B; SUBTRACT = 0x6D
         NUM1 = 0x61; NUM2 = 0x62; NUM3 = 0x63; NUM4 = 0x64 }

# Press a combo like 'CTRL+ALT+1' or 'CTRL+SHIFT+OEM_PLUS'
function Send-Combo([string]$combo) {
    if ([KB]::GetForegroundWindow() -ne $script:hwnd) {
        if (-not [KB]::ForceForeground($script:hwnd)) { throw "notepad.md lost focus; refusing to send $combo" }
        Start-Sleep -Milliseconds 200
    }
    $parts = $combo.Split('+')
    $codes = foreach ($p in $parts) {
        if ($VK.ContainsKey($p)) { [byte]$VK[$p] }
        elseif ($p.Length -eq 1) { [byte][char]$p.ToUpper() }
        else { throw "Unknown key $p" }
    }
    foreach ($c in $codes) { [KB]::Key($c, $false); Start-Sleep -Milliseconds 30 }
    [array]::Reverse($codes)
    foreach ($c in $codes) { [KB]::Key($c, $true); Start-Sleep -Milliseconds 30 }
    Start-Sleep -Milliseconds 400
}

function Install-KeyLog {
    Eval @"
window.__kl = [];
window.addEventListener('keydown', e => {
  if (['Control','Alt','Shift','AltGraph'].includes(e.key)) return;
  window.__kl.push(e.key + '/' + e.code + (e.ctrlKey?' C':'') + (e.altKey?' A':'') + (e.shiftKey?' S':'') + (e.getModifierState('AltGraph')?' AltGr':'') + (e.defaultPrevented?' handled':' NOT-handled'));
}, false);
true
"@ | Out-Null
}

function Pop-KeyLog { $v = Eval "JSON.stringify(window.__kl.splice(0))"; return $v }

function Proc-Windows { return [KB]::ProcWindows([uint32]$script:proc.Id) }

function Stop-App {
    try { $script:ws.Dispose() } catch {}
    if ($script:proc) { try { Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($script:TestDir) -and $_.ProcessName -match "^(notepad-md|notepad.md|np[0-9]+)$" } | Stop-Process -Force
}
