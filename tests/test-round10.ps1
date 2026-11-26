param([string]$Exe)
$sp = . "$PSScriptRoot\testdir.ps1"
. "$PSScriptRoot\harness.ps1"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class MS {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
    public static POINT At(IntPtr h, int cx, int cy) { POINT p = new POINT(); p.X = cx; p.Y = cy; ClientToScreen(h, ref p); return p; }
    public static void Click(int x, int y, bool right) {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(250);
        mouse_event(right ? 0x0008u : 0x0002u, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60);
        mouse_event(right ? 0x0010u : 0x0004u, 0, 0, 0, UIntPtr.Zero);
    }
}
"@ -ErrorAction SilentlyContinue
$results = New-Object System.Collections.ArrayList
function T([string]$name, $actual, [bool]$pass) { [void]$results.Add([pscustomobject]@{ Test = $name; Result = $(if ($pass) { 'PASS' } else { 'FAIL' }); Actual = "$actual" }) }
function J([string]$js) { Eval "(async () => { try { $js } catch (e) { return 'EXC ' + e.message; } })()" }
function Pt([string]$e) { $r = J "const r=($e); if(!r) return 'none'; return JSON.stringify({x:r.left+Math.min(30,r.width/2),y:r.top+r.height/2})"; return ($r | ConvertFrom-Json) }
function Shot([string]$name) {
    $rc = New-Object MS+RECT; [MS]::GetWindowRect($script:hwnd, [ref]$rc) | Out-Null
    $bmp = New-Object System.Drawing.Bitmap ($rc.R - $rc.L), ($rc.B - $rc.T); $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rc.L, $rc.T, 0, 0, $bmp.Size); $bmp.Save("$sp\r10-$name.png"); $g.Dispose(); $bmp.Dispose()
}
# Right-click at a page point, then click the menu row `row` (0 = first) below it. Rows are 32px high.
function MenuPick([double]$x, [double]$y, [int]$row, [string]$shot) {
    [KB]::ForceForeground($script:hwnd) | Out-Null
    $dpr = [double](J "return window.devicePixelRatio")
    $p = [MS]::At($script:hwnd, [int]($x * $dpr), [int]($y * $dpr))
    [MS]::Click($p.X, $p.Y, $true); Start-Sleep -Milliseconds 900
    if ($shot) { Shot $shot }
    if ($row -lt 0) { [KB]::Key(0x1B, $false); [KB]::Key(0x1B, $true); Start-Sleep -Milliseconds 300; return }
    [MS]::Click($p.X + [int](60 * $dpr), $p.Y + [int]((22 + 32 * $row) * $dpr), $false); Start-Sleep -Milliseconds 600
}

Start-App $Exe $null
Focus-App | Out-Null
J "setLayoutMode('edit-only'); editor.value='Ticket: https://example.com/browse/MF-2741 and plain words here'; editor.dispatchEvent(new Event('input')); window.__opened=null; openUrl=(u)=>{window.__opened=u}; window.__copied=null; clipboard.writeText=async (t)=>{window.__copied=t}; window.__saved=null; saveLinkAs=(u)=>{window.__saved=u}; return 1" | Out-Null
Start-Sleep -Milliseconds 300
$p = Pt "edLayer().querySelector('.ov-url').getClientRects()[0]"
MenuPick $p.x $p.y 2 'link'
$r = J "return String(window.__copied)"
T 'Copy link (in the normal right-click menu) copies the address' $r ($r -eq 'https://example.com/browse/MF-2741')
MenuPick $p.x $p.y 0 ''
$r = J "return String(window.__opened)"
T 'Open link in new window opens it' $r ($r -eq 'https://example.com/browse/MF-2741')
MenuPick $p.x $p.y 1 ''
$r = J "return String(window.__saved)"
T 'Save link as starts saving that link' $r ($r -eq 'https://example.com/browse/MF-2741')
$w = Pt "(()=>{const r=document.createRange(); const t=[...editorHighlight.childNodes].find(n=>n.nodeType===3 && n.nodeValue.includes('plain')); const i=t.nodeValue.indexOf('plain'); r.setStart(t,i); r.setEnd(t,i+5); return r.getClientRects()[0];})()"
J "window.__opened=null; window.__copied=null; return 1" | Out-Null
MenuPick $w.x $w.y 0 'plain'
$r = J "return String(window.__opened) + '|' + String(window.__copied)"
T 'On ordinary text the first item is not a link item' $r ($r -eq 'null|null')
Stop-App
$results | Format-Table -AutoSize -Wrap | Out-String -Width 200
"PASS: $(@($results | Where-Object Result -eq 'PASS').Count)  FAIL: $(@($results | Where-Object Result -eq 'FAIL').Count)"
