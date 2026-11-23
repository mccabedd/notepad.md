//! Single instance: launching notepad.md while it is already running hands any files to the
//! running window (which opens them as tabs and comes to the front) instead of opening a second
//! window. Two windows would also fight over the same session.json.
//!
//! A named Windows mutex decides who is first. The first instance listens on a loopback TCP port
//! and writes the port, a random token and its process id to `instance.json` in the data folder;
//! later instances send their file paths there and exit. Only std + kernel32/user32 are used.

use std::ffi::c_void;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};

const ERROR_ALREADY_EXISTS: u32 = 183;

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attrs: *const c_void, initial_owner: i32, name: *const u16) -> *mut c_void;
    fn CloseHandle(h: *mut c_void) -> i32;
    fn GetLastError() -> u32;
}

#[link(name = "user32")]
extern "system" {
    fn AllowSetForegroundWindow(pid: u32) -> i32;
}

/// Same folder Tauri uses for app data (%APPDATA%\com.notepadmd.app), or the test override.
pub fn data_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("NOTEPADMD_DATA_DIR") {
        return Some(PathBuf::from(d));
    }
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("com.notepadmd.app"))
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// One lock per data folder, so test instances with their own folder don't collide with the
/// user's copy.
fn try_lock(dir: &Path) -> bool {
    let name = format!("Local\\NotepadMD-{:016x}", fnv1a(&dir.to_string_lossy()));
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 0, wide.as_ptr());
        if h.is_null() {
            return true; // can't tell; behave as before rather than refuse to start
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(h);
            return false;
        }
        // Deliberately never closed: the mutex lives as long as this process.
        true
    }
}

struct Peer {
    port: u16,
    token: String,
    pid: u32,
}

fn read_peer(dir: &Path) -> Option<Peer> {
    let text = std::fs::read_to_string(dir.join("instance.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(Peer {
        port: v.get("port")?.as_u64()? as u16,
        token: v.get("token")?.as_str()?.to_string(),
        pid: v.get("pid")?.as_u64()? as u32,
    })
}

fn forward(dir: &Path, files: &[PathBuf]) -> bool {
    let Some(peer) = read_peer(dir) else { return false };
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, peer.port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    // Let the running window take the foreground (Windows only allows it when we pass it on).
    unsafe {
        AllowSetForegroundWindow(peer.pid);
    }
    let mut msg = peer.token.clone();
    msg.push('\n');
    for f in files {
        msg.push_str(&f.to_string_lossy());
        msg.push('\n');
    }
    msg.push('\n'); // blank line ends the message
    if s.write_all(msg.as_bytes()).is_err() {
        return false;
    }
    let mut reply = String::new();
    let _ = s.read_to_string(&mut reply);
    reply.trim() == "OK"
}

/// Called first thing in main(). Returns false when the files were handed to an already-running
/// instance and this process should exit.
///
/// `after_update`: we were just started by the updater, so the old instance is about to quit:
/// wait for it instead of forwarding to it.
pub fn acquire(files: &[PathBuf], after_update: bool) -> bool {
    let Some(dir) = data_dir() else { return true };
    let _ = std::fs::create_dir_all(&dir);
    let deadline = Instant::now() + Duration::from_secs(if after_update { 15 } else { 5 });
    loop {
        if try_lock(&dir) {
            return true;
        }
        if !after_update && forward(&dir, files) {
            return false;
        }
        if Instant::now() > deadline {
            // The other instance isn't answering (hung or still starting): run anyway.
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn random_token() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let addr = &nanos as *const u128 as usize;
    format!(
        "{:016x}{:016x}",
        fnv1a(&format!("{}-{}", nanos, std::process::id())),
        fnv1a(&format!("{}-{}", addr, nanos.rotate_left(17)))
    )
}

/// Started from setup() in the first instance: accept file lists from later launches.
pub fn listen(app: tauri::AppHandle) {
    let Some(dir) = data_dir() else { return };
    let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) else { return };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    let token = random_token();
    let info = serde_json::json!({ "port": port, "token": token, "pid": std::process::id() });
    if std::fs::write(dir.join("instance.json"), info.to_string()).is_err() {
        return;
    }
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let mut lines = Vec::new();
            let mut reader = BufReader::new(&stream);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = line.trim_end_matches(['\r', '\n']).to_string();
                        if line.is_empty() {
                            break;
                        }
                        lines.push(line);
                    }
                }
                if lines.len() > 1000 {
                    break;
                }
            }
            if lines.first() != Some(&token) {
                continue; // not one of ours
            }
            let files: Vec<String> =
                lines[1..].iter().filter(|p| Path::new(p).is_file()).cloned().collect();
            let mut s = &stream;
            let _ = s.write_all(b"OK\n");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.emit("open-files", files);
            }
        }
    });
}

/* ---------- local images in the Markdown preview ---------- */

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// Handler for `localimg://` (http://localimg.localhost/<encoded path> in WebView2): serves image
/// files from disk so the preview can show `![](picture.png)`. Only image types are served.
pub fn serve_local_image(req: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let raw = req.uri().path().trim_start_matches('/');
    let path = PathBuf::from(percent_decode(raw));
    let resp = |status: u16, mime: &str, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .header("Cache-Control", "no-cache")
            .body(body)
            .unwrap()
    };
    let Some(mime) = image_mime(&path) else { return resp(403, "text/plain", b"not an image".to_vec()) };
    if !path.is_absolute() {
        return resp(400, "text/plain", Vec::new());
    }
    match std::fs::read(&path) {
        Ok(bytes) => resp(200, mime, bytes),
        Err(_) => resp(404, "text/plain", Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_percent_paths() {
        assert_eq!(percent_decode("C%3A%2FPics%2Fa%20b.png"), "C:/Pics/a b.png");
        assert_eq!(percent_decode("bad%zz%4"), "bad%zz%4");
        assert_eq!(percent_decode("%€x"), "%€x");
        assert_eq!(percent_decode("%E2%82%AC"), "€");
    }
}
