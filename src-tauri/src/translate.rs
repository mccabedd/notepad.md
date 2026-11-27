//! Translate (right-click in the editor > Translate), by one of two providers:
//! - "free": Google Translate's free web endpoint (translate.googleapis.com/translate_a/single,
//!   client=gtx), the one Google's own web tools use. No key and no cost, but unofficial: Google
//!   may limit or change it at any time.
//! - "cloud": Google Cloud Translation API (v2) with the user's own API key.
//!
//! - The key is kept encrypted for the current Windows user (DPAPI) in the app's data folder; the
//!   page can save or remove it but never read it back.
//! - Text is sent line by line (leading/trailing spaces stay here), so line breaks, blank lines and
//!   indentation come back exactly as they were. Lines over SEG_MAX characters are cut at a sentence
//!   or word boundary. Requests carry at most BATCH_SEGS lines / BATCH_CHARS characters.
//! - Like the updater, requests go through Windows' curl.exe. The key and the text are handed to it
//!   on stdin (a curl config), never on its command line.

use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use tauri::Manager;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

const API_HOST: &str = "https://translation.googleapis.com";
const API_PATH: &str = "/language/translate/v2";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SEG_MAX: usize = 4500;
const BATCH_SEGS: usize = 100;
const BATCH_CHARS: usize = 25_000;
const FREE_HOST: &str = "https://translate.googleapis.com";
const FREE_PATH: &str = "/translate_a/single?client=gtx&sl=auto&dt=t&tl=";
/// The free endpoint takes one text per request: lines are joined with line breaks, up to this many characters.
const FREE_BATCH_CHARS: usize = 4500;

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = match std::env::var_os("NOTEPADMD_DATA_DIR") {
        Some(d) => PathBuf::from(d),
        None => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("translate-key.bin"))
}

/* ---------------- the key, encrypted for this Windows user ---------------- */

fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        let r = if protect {
            CryptProtectData(&input, windows::core::w!("notepad.md translate key"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        r.map_err(|e| e.to_string())?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
        Ok(v)
    }
}

fn key_is_valid(key: &str) -> bool {
    !key.is_empty() && key.len() <= 200 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn load_key(app: &tauri::AppHandle) -> Option<String> {
    let bytes = std::fs::read(key_path(app).ok()?).ok()?;
    let plain = dpapi(&bytes, false).ok()?;
    String::from_utf8(plain).ok().filter(|k| key_is_valid(k))
}

/// Whether a key is saved (the key itself never goes back to the page).
#[tauri::command]
pub fn cmd_translate_key_status(app: tauri::AppHandle) -> bool {
    load_key(&app).is_some()
}

/// Saves the key (encrypted), or removes it when `key` is empty.
#[tauri::command]
pub fn cmd_translate_key_set(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let path = key_path(&app)?;
    let key = key.trim();
    if key.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if !key_is_valid(key) {
        return Err("That doesn't look like a Google Cloud API key (letters, digits, '-' and '_' only).".into());
    }
    std::fs::write(&path, dpapi(key.as_bytes(), true)?).map_err(|e| e.to_string())
}

/* ---------------- splitting the text into pieces to translate ---------------- */

/// A piece of the text: `lead` and `trail` (spaces) stay as they are, `core` is translated
/// (nothing is sent for an empty core). `newline`: a line break follows this piece.
#[derive(Debug, Clone, PartialEq)]
struct Piece {
    lead: String,
    core: String,
    trail: String,
    newline: bool,
}

fn piece(s: &str, newline: bool) -> Piece {
    let core = s.trim();
    let start = s.len() - s.trim_start().len();
    let end = start + core.len();
    Piece { lead: s[..start].to_string(), core: core.to_string(), trail: s[end..].to_string(), newline }
}

/// Cuts `line` into parts of at most SEG_MAX characters, after a sentence end if there is one in
/// the second half of the part, otherwise after a space, otherwise anywhere.
fn cut_long(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = line;
    while rest.chars().count() > SEG_MAX {
        let limit = rest.char_indices().nth(SEG_MAX).map(|(i, _)| i).unwrap_or(rest.len());
        let window = &rest[..limit];
        let half = window.len() / 2;
        let cut = ['.', '!', '?', '。', '！', '？']
            .iter()
            .filter_map(|p| window.rfind(*p).map(|i| i + p.len_utf8()))
            .filter(|&i| i > half)
            .max()
            .or_else(|| window.rfind(char::is_whitespace).filter(|&i| i > 0).map(|i| i + 1))
            .unwrap_or(limit);
        let cut = if rest.is_char_boundary(cut) { cut } else { limit };
        out.push(&rest[..cut]);
        rest = &rest[cut..];
    }
    out.push(rest);
    out
}

fn split_text(text: &str) -> Vec<Piece> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let last_line = i + 1 == lines.len();
        let (body, cr) = match line.strip_suffix('\r') {
            Some(b) => (b, "\r"),
            None => (*line, ""),
        };
        let parts = cut_long(body);
        let n = parts.len();
        for (k, p) in parts.into_iter().enumerate() {
            let mut pc = piece(p, k + 1 == n && !last_line);
            if k + 1 == n {
                pc.trail.push_str(cr);
            }
            out.push(pc);
        }
    }
    out
}

fn join_text(pieces: &[Piece], translated: &[String]) -> String {
    let mut out = String::new();
    let mut t = translated.iter();
    for p in pieces {
        out.push_str(&p.lead);
        if !p.core.is_empty() {
            out.push_str(t.next().map(String::as_str).unwrap_or(&p.core));
        }
        out.push_str(&p.trail);
        if p.newline {
            out.push('\n');
        }
    }
    out
}

/// Groups the cores to send into requests (indexes into the list of non-empty cores).
fn batches(cores: &[&str]) -> Vec<std::ops::Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut chars = 0;
    for (i, c) in cores.iter().enumerate() {
        let n = c.chars().count();
        if i > start && (i - start >= BATCH_SEGS || chars + n > BATCH_CHARS) {
            out.push(start..i);
            start = i;
            chars = 0;
        }
        chars += n;
    }
    if start < cores.len() {
        out.push(start..cores.len());
    }
    out
}

/* ---------------- talking to Google ---------------- */

/// A value for a curl config file: quoted, with \ and " escaped (JSON never has raw newlines).
fn config_quote(s: &str) -> String {
    let mut q = String::with_capacity(s.len() + 2);
    q.push('"');
    for c in s.chars() {
        match c {
            '\\' => q.push_str("\\\\"),
            '"' => q.push_str("\\\""),
            '\n' => q.push_str("\\n"),
            '\r' => q.push_str("\\r"),
            '\t' => q.push_str("\\t"),
            _ => q.push(c),
        }
    }
    q.push('"');
    q
}

/// `host` + `path`. Tests point the host at a fake server on this PC
/// (NOTEPADMD_TRANSLATE_URL=http://127.0.0.1:<port>). Nothing else is accepted there, so the
/// variable can't send the key or the text anywhere else.
fn endpoint(host: &str, path: &str) -> (String, &'static str) {
    match std::env::var("NOTEPADMD_TRANSLATE_URL") {
        Ok(u) if u.starts_with("http://127.0.0.1:") && !u[17..].contains(['/', '@', '?', '#']) => (format!("{}{}", u, path), "=http"),
        _ => (format!("{}{}", host, path), "=https"),
    }
}

/// Runs curl.exe with `config` on stdin; returns (body, HTTP status).
fn curl(config: &str, proto: &str) -> Result<(String, u16), String> {
    let mut child = Command::new("curl.exe")
        .args(["-sS", "--proto", proto, "--max-time", "120", "-K", "-", "-w", "\n%{http_code}"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Could not run curl.exe: {}", e))?;
    {
        let mut stdin = child.stdin.take().ok_or("Could not talk to curl.exe")?;
        stdin.write_all(config.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() { "Could not reach Google Translate.".into() } else { format!("Could not reach Google Translate: {}", msg) });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let (body, code) = text.rsplit_once('\n').unwrap_or(("", &text));
    Ok((body.to_string(), code.trim().parse().unwrap_or(0)))
}

fn google_error(body: &serde_json::Value, status: u16) -> String {
    let msg = body["error"]["message"].as_str().unwrap_or("").trim().to_string();
    let base = match status {
        400 if msg.to_ascii_lowercase().contains("api key") => "Google didn't accept the API key",
        400 => "Google couldn't translate this",
        401 | 403 => "Google refused the request (is the Cloud Translation API enabled, with billing, for this key?)",
        429 => "Google's limit for this key has been reached; try again later",
        _ => "Google Translate didn't work",
    };
    if msg.is_empty() { format!("{} (HTTP {}).", base, status) } else { format!("{}: {}", base, msg) }
}

fn request(key: &str, cores: &[&str], target: &str) -> Result<(Vec<String>, Option<String>), String> {
    let body = serde_json::json!({ "q": cores, "target": target, "format": "text" }).to_string();
    let (url, proto) = endpoint(API_HOST, API_PATH);
    let config = format!(
        "url = {}\nrequest = \"POST\"\nheader = \"Content-Type: application/json; charset=utf-8\"\nheader = {}\ndata-binary = {}\n",
        config_quote(&url),
        config_quote(&format!("X-goog-api-key: {}", key)),
        config_quote(&body)
    );
    let (json, status) = curl(&config, proto)?;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
    if status != 200 {
        return Err(google_error(&v, status));
    }
    let list = v["data"]["translations"].as_array().ok_or("Google Translate sent an unexpected reply.")?;
    if list.len() != cores.len() {
        return Err("Google Translate sent back a different number of lines than were sent.".into());
    }
    let detected = list.iter().find_map(|t| t["detectedSourceLanguage"].as_str().map(String::from));
    let texts = list.iter().map(|t| t["translatedText"].as_str().unwrap_or("").to_string()).collect();
    Ok((texts, detected))
}

/* ---------------- the free endpoint ---------------- */

/// Reads the free endpoint's reply: [[["translated", "original", ...], ...], null, "detected", ...].
fn parse_free(json: &str) -> Option<(String, Option<String>)> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let mut out = String::new();
    for seg in v.get(0)?.as_array()? {
        if let Some(t) = seg.get(0).and_then(|t| t.as_str()) {
            out.push_str(t);
        }
    }
    Some((out, v.get(2).and_then(|d| d.as_str()).map(String::from)))
}

fn free_one(text: &str, target: &str) -> Result<(String, Option<String>), String> {
    let (url, proto) = endpoint(FREE_HOST, &format!("{}{}", FREE_PATH, target));
    let config = format!("url = {}\nrequest = \"POST\"\ndata-urlencode = {}\n", config_quote(&url), config_quote(&format!("q={}", text)));
    let (body, status) = curl(&config, proto)?;
    match status {
        200 => parse_free(&body).ok_or_else(|| "Google Translate sent an unexpected reply.".to_string()),
        429 | 503 => Err("Google Translate (free) is limiting requests from this PC just now. Try again later, or use your own Google Cloud key (Settings > Translate).".into()),
        _ => Err(format!("Google Translate (free) didn't work (HTTP {}).", status)),
    }
}

/// Lines go together in one request, one per line; if the reply doesn't have the same number of
/// lines (Google merged or split some), each line of that group is sent on its own instead.
fn request_free(cores: &[&str], target: &str) -> Result<(Vec<String>, Option<String>, usize), String> {
    let (joined, detected) = free_one(&cores.join("\n"), target)?;
    let lines: Vec<String> = joined.split('\n').map(|l| l.trim().to_string()).collect();
    if lines.len() == cores.len() {
        return Ok((lines, detected, 1));
    }
    let mut out = Vec::with_capacity(cores.len());
    for c in cores {
        out.push(free_one(c, target)?.0.trim().to_string());
    }
    Ok((out, detected, 1 + cores.len()))
}

/// Groups for the free endpoint: whole lines, up to FREE_BATCH_CHARS characters (and BATCH_SEGS lines).
fn free_batches(cores: &[&str]) -> Vec<std::ops::Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut chars = 0;
    for (i, c) in cores.iter().enumerate() {
        let n = c.chars().count() + 1;
        if i > start && (i - start >= BATCH_SEGS || chars + n > FREE_BATCH_CHARS) {
            out.push(start..i);
            start = i;
            chars = 0;
        }
        chars += n;
    }
    if start < cores.len() {
        out.push(start..cores.len());
    }
    out
}

#[derive(serde::Serialize)]
pub struct Translated {
    text: String,
    detected: Option<String>,
    chars: usize,
    requests: usize,
}

/// Translates `text` into `target` (a language code such as "en" or "is"), with `provider`
/// "free" (Google Translate's free web endpoint) or "cloud" (Google Cloud with the saved key).
#[tauri::command]
pub async fn cmd_translate(app: tauri::AppHandle, text: String, target: String, provider: Option<String>) -> Result<Translated, String> {
    let target_ok = (2..=8).contains(&target.len()) && target.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !target_ok {
        return Err("Unknown language.".into());
    }
    let free = provider.as_deref() == Some("free");
    let key = if free { String::new() } else { load_key(&app).ok_or("No Google Cloud API key is saved: add one in Settings > Translate.")? };
    let pieces = split_text(&text);
    let cores: Vec<&str> = pieces.iter().filter(|p| !p.core.is_empty()).map(|p| p.core.as_str()).collect();
    let chars = cores.iter().map(|c| c.chars().count()).sum();
    if cores.is_empty() {
        return Ok(Translated { text, detected: None, chars: 0, requests: 0 });
    }
    let mut translated = Vec::with_capacity(cores.len());
    let mut detected = None;
    let mut requests = 0;
    let groups = if free { free_batches(&cores) } else { batches(&cores) };
    for g in &groups {
        let (t, d) = if free {
            let (t, d, n) = request_free(&cores[g.clone()], &target)?;
            requests += n;
            (t, d)
        } else {
            requests += 1;
            request(&key, &cores[g.clone()], &target)?
        };
        translated.extend(t);
        if detected.is_none() {
            detected = d;
        }
    }
    Ok(Translated { text: join_text(&pieces, &translated), detected, chars, requests })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(text: &str) -> String {
        let pieces = split_text(text);
        let cores: Vec<String> = pieces.iter().filter(|p| !p.core.is_empty()).map(|p| p.core.clone()).collect();
        join_text(&pieces, &cores)
    }

    #[test]
    fn splitting_and_joining_gives_back_the_same_text() {
        for t in ["", "one", "one\ntwo", "  indented\n\n\ttab\n", "trailing  \nx\r\ny\r\n", "\n\n", "a\n  \nb"] {
            assert_eq!(round_trip(t), t, "{:?}", t);
        }
    }

    #[test]
    fn only_text_is_sent_not_spaces_or_empty_lines() {
        let p = split_text("  Hello  \n\n\tWorld");
        let cores: Vec<&str> = p.iter().filter(|x| !x.core.is_empty()).map(|x| x.core.as_str()).collect();
        assert_eq!(cores, ["Hello", "World"]);
        let out = join_text(&p, &["Halló".into(), "Heimur".into()]);
        assert_eq!(out, "  Halló  \n\n\tHeimur");
    }

    #[test]
    fn long_lines_are_cut_at_sentences_and_kept_whole() {
        let sentence = "This is a sentence of some length. ";
        let line = sentence.repeat(400); // ~14,000 characters
        let parts = cut_long(&line);
        assert!(parts.len() >= 3);
        assert!(parts.iter().all(|p| p.chars().count() <= SEG_MAX));
        assert!(parts[..parts.len() - 1].iter().all(|p| p.trim_end().ends_with('.')));
        assert_eq!(parts.concat(), line);
        assert_eq!(round_trip(&line), line);
        let nospace = "x".repeat(10_000);
        assert_eq!(cut_long(&nospace).concat(), nospace);
        let wide = "é".repeat(9_001);
        assert!(cut_long(&wide).iter().all(|p| p.chars().count() <= SEG_MAX));
    }

    #[test]
    fn batches_respect_both_limits() {
        let many: Vec<&str> = vec!["word"; 250];
        let b = batches(&many);
        assert_eq!(b.len(), 3);
        assert!(b.iter().all(|r| r.len() <= BATCH_SEGS));
        let big = "y".repeat(4000);
        let long: Vec<&str> = vec![big.as_str(); 10];
        assert!(batches(&long).iter().all(|r| r.len() * 4000 <= BATCH_CHARS));
    }

    #[test]
    fn config_values_are_escaped() {
        assert_eq!(config_quote(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(config_quote("x\ny"), "\"x\\ny\"");
    }

    #[test]
    fn free_replies_are_read() {
        let r = r#"[[["Hello world. ","Hallo heimur. ",null,null,3],["This is a test.\n","Thetta er prof.\n",null,null,3],["Line two.","Lina tvo.",null,null,3]],null,"is",null]"#;
        let (t, d) = parse_free(r).unwrap();
        assert_eq!(t, "Hello world. This is a test.\nLine two.");
        assert_eq!(d.as_deref(), Some("is"));
        assert!(parse_free("not json").is_none());
    }

    #[test]
    fn free_batches_keep_whole_lines_under_the_limit() {
        let line = "z".repeat(1000);
        let cores: Vec<&str> = vec![line.as_str(); 12];
        let b = free_batches(&cores);
        assert!(b.len() >= 3);
        assert!(b.iter().all(|r| r.len() * 1001 <= FREE_BATCH_CHARS));
        assert_eq!(b.iter().map(|r| r.len()).sum::<usize>(), 12);
    }

    #[test]
    fn keys_are_checked() {
        assert!(key_is_valid("AIzaSyA-abc_123"));
        assert!(!key_is_valid(""));
        assert!(!key_is_valid("has space"));
        assert!(!key_is_valid("quote\"inject"));
        assert!(!key_is_valid("new\nline"));
    }
}
