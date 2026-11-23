//! Windows integration: file-type registration ("Open with") and self-update from GitHub releases.

use std::io;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use winreg::enums::*;
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PROG_ID: &str = "NotepadMD.Document";
const UPDATE_API: &str = "https://api.github.com/repos/mccabedd/notepad.md/releases/latest";
const USER_AGENT: &str = "User-Agent: notepad.md-Updater";

fn err<T>(r: io::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

fn exe_path() -> Result<PathBuf, String> {
    err(std::env::current_exe())
}

#[derive(serde::Serialize)]
pub struct AppInfo {
    version: String,
    exe: String,
}

#[tauri::command]
pub fn cmd_app_info() -> Result<AppInfo, String> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        exe: exe_path()?.to_string_lossy().to_string(),
    })
}

/// Deletes the previous executable left behind by an update. Right after an update the old
/// process may still be exiting (its exe stays locked until then), so keep trying for a while.
pub fn cleanup_after_update() {
    if let Ok(exe) = std::env::current_exe() {
        // A download left over from an update that was interrupted (e.g. the PC lost power).
        let _ = std::fs::remove_file(exe.with_extension("exe.download"));
        let old = exe.with_extension("old");
        if !old.exists() {
            return;
        }
        std::thread::spawn(move || {
            for _ in 0..40 {
                if std::fs::remove_file(&old).is_ok() || !old.exists() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        });
    }
}

/* ---------------- file types ---------------- */

/// HKCU\Software\Classes, or another HKCU path from NOTEPADMD_REG_ROOT (used by automated tests).
fn classes_root() -> Result<RegKey, String> {
    let sub = std::env::var("NOTEPADMD_REG_ROOT").unwrap_or_else(|_| "Software\\Classes".into());
    let (key, _) = err(RegKey::predef(HKEY_CURRENT_USER).create_subkey(&sub))?;
    Ok(key)
}

fn valid_ext(ext: &str) -> bool {
    !ext.is_empty() && ext.len() <= 12 && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

fn open_command(exe: &str) -> String {
    format!("\"{}\" \"%1\"", exe)
}

fn exe_file_name(exe: &PathBuf) -> String {
    exe.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "notepad.md.exe".into())
}

#[link(name = "shell32")]
extern "system" {
    fn SHChangeNotify(event_id: i32, flags: u32, item1: *const core::ffi::c_void, item2: *const core::ffi::c_void);
}

fn notify_assoc_changed() {
    // SHCNE_ASSOCCHANGED: tells Explorer to refresh icons and "Open with" lists.
    unsafe { SHChangeNotify(0x0800_0000, 0, std::ptr::null(), std::ptr::null()) };
}

/// Adds notepad.md to the "Open with" list of every extension (per user, no admin rights needed).
/// Windows does not let apps make themselves the default silently; the user confirms that once
/// in "Open with > Always" or Settings > Default apps.
#[tauri::command]
pub fn cmd_register_file_types(exts: Vec<String>) -> Result<usize, String> {
    let exe = exe_path()?;
    let exe_s = exe.to_string_lossy().to_string();
    let cmd = open_command(&exe_s);
    let root = classes_root()?;

    let (prog, _) = err(root.create_subkey(PROG_ID))?;
    err(prog.set_value("", &"notepad.md document"))?;
    err(err(prog.create_subkey("DefaultIcon"))?.0.set_value("", &format!("\"{}\",0", exe_s)))?;
    err(err(prog.create_subkey("shell\\open\\command"))?.0.set_value("", &cmd))?;

    let (app, _) = err(root.create_subkey(format!("Applications\\{}", exe_file_name(&exe))))?;
    err(app.set_value("FriendlyAppName", &"notepad.md"))?;
    err(err(app.create_subkey("shell\\open\\command"))?.0.set_value("", &cmd))?;
    let (types, _) = err(app.create_subkey("SupportedTypes"))?;

    let mut n = 0;
    for ext in exts.iter().map(|e| e.trim_start_matches('.').to_ascii_lowercase()) {
        if !valid_ext(&ext) {
            continue;
        }
        let dot = format!(".{}", ext);
        err(types.set_value(&dot, &""))?;
        let (k, _) = err(root.create_subkey(format!("{}\\OpenWithProgids", dot)))?;
        err(k.set_value(PROG_ID, &""))?;
        n += 1;
    }
    remove_stale_app_keys(&root, &exe_s);
    notify_assoc_changed();
    Ok(n)
}

/// The exe a registry command such as `"C:\Apps\notepad-md.exe" "%1"` points at.
fn command_exe(cmd: &str) -> Option<String> {
    let rest = cmd.trim().strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

/// Which copy of notepad.md a registry command belongs to, compared with this exe.
#[derive(Debug, PartialEq)]
enum Owner {
    /// Missing, or points at this exe.
    Us,
    /// Points at an exe that no longer exists (a moved or deleted copy): safe to clean up.
    Stale,
    /// Points at another copy that still exists: leave it alone.
    Other(String),
}

fn owner_of(cmd: Option<String>, exe: &str) -> Owner {
    let Some(cmd) = cmd else { return Owner::Us };
    match command_exe(&cmd) {
        Some(p) if p.eq_ignore_ascii_case(exe) => Owner::Us,
        Some(p) if std::path::Path::new(&p).is_file() => Owner::Other(p),
        _ => Owner::Stale,
    }
}

fn read_command(root: &RegKey, key: &str) -> Option<String> {
    root.open_subkey(format!("{}\\command", key)).ok().and_then(|k| k.get_value("").ok())
}

/// Deletes a key tree; a key that is already gone is fine (so unregistering twice is harmless).
fn delete_tree(root: &RegKey, key: &str) -> Result<(), String> {
    match root.delete_subkey_all(key) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not remove {}: {}", key, e)),
    }
}

/// Removes this copy's "Open with" entries. Entries that belong to another copy of notepad.md
/// that still exists (a second portable copy) are left alone and reported; entries left by a copy
/// that was moved or deleted are cleaned up. The extensions' own default programs are never touched.
#[tauri::command]
pub fn cmd_unregister_file_types(exts: Vec<String>) -> Result<(), String> {
    let exe = exe_path()?;
    let exe_s = exe.to_string_lossy().to_string();
    let root = classes_root()?;
    let app_key = format!("Applications\\{}", exe_file_name(&exe));
    if !matches!(owner_of(read_command(&root, &format!("{}\\shell\\open", app_key)), &exe_s), Owner::Other(_)) {
        delete_tree(&root, &app_key)?;
    }
    if let Owner::Other(p) = owner_of(read_command(&root, &format!("{}\\shell\\open", PROG_ID)), &exe_s) {
        notify_assoc_changed();
        return Err(format!("The file types are registered to another copy of notepad.md:\n{}\n\nUnregister them from that copy.", p));
    }
    delete_tree(&root, PROG_ID)?;
    for ext in exts.iter().map(|e| e.trim_start_matches('.').to_ascii_lowercase()) {
        if !valid_ext(&ext) {
            continue;
        }
        if let Ok(k) = root.open_subkey_with_flags(format!(".{}\\OpenWithProgids", ext), KEY_ALL_ACCESS) {
            match k.delete_value(PROG_ID) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Could not update .{}: {}", ext, e)),
            }
        }
    }
    notify_assoc_changed();
    Ok(())
}

#[derive(serde::Serialize)]
pub struct FileTypeStatus {
    registered: bool,
    /// Registered, but for a different copy of the exe (e.g. it was moved).
    other_exe: Option<String>,
}

#[tauri::command]
pub fn cmd_file_types_status() -> Result<FileTypeStatus, String> {
    let exe = exe_path()?.to_string_lossy().to_string();
    let root = classes_root()?;
    let current: Option<String> = root
        .open_subkey(format!("{}\\shell\\open\\command", PROG_ID))
        .ok()
        .and_then(|k| k.get_value("").ok());
    Ok(match current {
        Some(c) if c.eq_ignore_ascii_case(&open_command(&exe)) => FileTypeStatus { registered: true, other_exe: None },
        Some(c) => FileTypeStatus { registered: false, other_exe: Some(c) },
        None => FileTypeStatus { registered: false, other_exe: None },
    })
}

/* ---------------- one extension at a time (Settings > File Types) ---------------- */

/// Whether `.ext` lists notepad.md in its "Open with" programs (HKCU only; defaults are never read or changed).
fn ext_registered(root: &RegKey, ext: &str) -> bool {
    root.open_subkey(format!(".{}\\OpenWithProgids", ext))
        .ok()
        .map(|k| k.get_raw_value(PROG_ID).is_ok())
        .unwrap_or(false)
}

#[derive(serde::Serialize)]
pub struct FileTypeStates {
    /// The extensions (from the list asked about) whose "Open with" lists notepad.md.
    registered: Vec<String>,
    /// Which copy the shared "Open with" entry opens: "us", "other" (another copy that exists),
    /// "stale" (a copy that was moved or deleted) or "none".
    owner: String,
    other_exe: Option<String>,
}

/// The real registration state of each extension, read from the registry every time.
#[tauri::command]
pub fn cmd_file_type_states(exts: Vec<String>) -> Result<FileTypeStates, String> {
    let exe = exe_path()?.to_string_lossy().to_string();
    let root = classes_root()?;
    let cmd = read_command(&root, &format!("{}\\shell\\open", PROG_ID));
    let (owner, other_exe) = match (&cmd, owner_of(cmd.clone(), &exe)) {
        (None, _) => ("none", None),
        (Some(_), Owner::Us) => ("us", None),
        (Some(_), Owner::Other(p)) => ("other", Some(p)),
        (Some(c), Owner::Stale) => ("stale", command_exe(c)),
    };
    let registered = exts
        .iter()
        .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| valid_ext(e) && ext_registered(&root, e))
        .collect();
    Ok(FileTypeStates { registered, owner: owner.into(), other_exe })
}

#[derive(serde::Serialize)]
pub struct FileTypeChange {
    changed: usize,
    /// (extension, reason) for each one that could not be changed.
    failed: Vec<(String, String)>,
}

/// Adds (`enabled`) or removes notepad.md from the "Open with" list of the given extensions.
/// Only notepad.md's own value under `.ext\OpenWithProgids` changes, so the extension's default
/// program (for .bat, .cmd, .ps1, .py, .js: running the script) is never touched. Adding points the
/// shared "Open with" entry at this copy; removing the last extension (of `all`) removes that entry
/// too, unless it belongs to another copy that still exists. Explorer is told once per call.
#[tauri::command]
pub fn cmd_set_file_types(exts: Vec<String>, enabled: bool, all: Vec<String>) -> Result<FileTypeChange, String> {
    let exe = exe_path()?;
    let exe_s = exe.to_string_lossy().to_string();
    let root = classes_root()?;
    let app_key = format!("Applications\\{}", exe_file_name(&exe));
    let norm = |v: &Vec<String>| -> Vec<String> { v.iter().map(|e| e.trim_start_matches('.').to_ascii_lowercase()).filter(|e| valid_ext(e)).collect() };
    let exts = norm(&exts);
    let mut failed = Vec::new();
    let mut changed = 0;
    if enabled {
        let cmd = open_command(&exe_s);
        let (prog, _) = err(root.create_subkey(PROG_ID))?;
        err(prog.set_value("", &"notepad.md document"))?;
        err(err(prog.create_subkey("DefaultIcon"))?.0.set_value("", &format!("\"{}\",0", exe_s)))?;
        err(err(prog.create_subkey("shell\\open\\command"))?.0.set_value("", &cmd))?;
        let (app, _) = err(root.create_subkey(&app_key))?;
        err(app.set_value("FriendlyAppName", &"notepad.md"))?;
        err(err(app.create_subkey("shell\\open\\command"))?.0.set_value("", &cmd))?;
        let (types, _) = err(app.create_subkey("SupportedTypes"))?;
        for ext in &exts {
            let dot = format!(".{}", ext);
            let r = types
                .set_value(&dot, &"")
                .and_then(|_| root.create_subkey(format!("{}\\OpenWithProgids", dot)))
                .and_then(|(k, _)| k.set_value(PROG_ID, &""));
            match r {
                Ok(()) => changed += 1,
                Err(e) => failed.push((ext.clone(), e.to_string())),
            }
        }
    } else {
        if let Owner::Other(p) = owner_of(read_command(&root, &format!("{}\\shell\\open", PROG_ID)), &exe_s) {
            return Err(format!("These file types are registered to another copy of notepad.md:\n{}\n\nChange them from that copy.", p));
        }
        let types = root.open_subkey_with_flags(format!("{}\\SupportedTypes", app_key), KEY_ALL_ACCESS).ok();
        for ext in &exts {
            let mut r: Result<(), String> = Ok(());
            if let Ok(k) = root.open_subkey_with_flags(format!(".{}\\OpenWithProgids", ext), KEY_ALL_ACCESS) {
                match k.delete_value(PROG_ID) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => r = Err(e.to_string()),
                }
            }
            if let Some(t) = &types {
                let _ = t.delete_value(format!(".{}", ext));
            }
            match r {
                Ok(()) => changed += 1,
                Err(e) => failed.push((ext.clone(), e)),
            }
        }
        // Nothing left: remove the shared entry as well (it only ever pointed at this copy here).
        if !norm(&all).iter().any(|e| ext_registered(&root, e)) {
            if !matches!(owner_of(read_command(&root, &format!("{}\\shell\\open", app_key)), &exe_s), Owner::Other(_)) {
                delete_tree(&root, &app_key)?;
            }
            delete_tree(&root, PROG_ID)?;
        }
    }
    remove_stale_app_keys(&root, &exe_s);
    notify_assoc_changed();
    Ok(FileTypeChange { changed, failed })
}

/* ---------------- copies that were renamed, moved or deleted ---------------- */

/// The FriendlyAppName values this app has written under `Applications\<exe file name>`
/// (including its earlier names): how its own keys are recognised there.
const OUR_APP_NAMES: [&str; 3] = ["notepad.md", "NotePad-MD", "Notepad MD"];

/// Removes `Applications\<exe>` keys left by copies of this app whose exe no longer exists
/// (renamed from notepad-md.exe, moved or deleted). A key is only removed when it carries one
/// of this app's names AND its command points at a missing exe: keys of other programs, and of
/// copies that still exist, are never touched. Returns the names of the keys removed.
fn remove_stale_app_keys(root: &RegKey, exe: &str) -> Vec<String> {
    let mut removed = Vec::new();
    let Ok(apps) = root.open_subkey("Applications") else { return removed };
    let names: Vec<String> = apps.enum_keys().filter_map(|k| k.ok()).collect();
    for name in names {
        let key = format!("Applications\\{}", name);
        let friendly: Option<String> = root.open_subkey(&key).ok().and_then(|k| k.get_value("FriendlyAppName").ok());
        if !friendly.map(|f| OUR_APP_NAMES.contains(&f.as_str())).unwrap_or(false) {
            continue;
        }
        let cmd = read_command(root, &format!("{}\\shell\\open", key));
        if cmd.is_some() && owner_of(cmd, exe) == Owner::Stale && delete_tree(root, &key).is_ok() {
            removed.push(name);
        }
    }
    removed
}

#[derive(serde::Serialize)]
pub struct RepairResult {
    /// File types now pointing at this copy.
    repointed: usize,
    /// The Explorer menu item was on and now opens this copy.
    context_menu: bool,
    /// `Applications\...` keys removed because their exe no longer exists.
    removed: Vec<String>,
}

/// Settings > File Types > "Use this copy": after replacing or moving the exe, points the existing
/// registrations (the ticked file types, and the Explorer menu item if it is on) at this exe and
/// removes entries left by copies that no longer exist. It takes the registrations over from
/// another copy, so it only ever runs when the user clicks it. Default apps are never changed.
#[tauri::command]
pub fn cmd_repair_registrations(exts: Vec<String>) -> Result<RepairResult, String> {
    let root = classes_root()?;
    let exe = exe_path()?.to_string_lossy().to_string();
    let registered: Vec<String> = exts
        .iter()
        .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| valid_ext(e) && ext_registered(&root, e))
        .collect();
    let repointed = if registered.is_empty() { 0 } else { cmd_set_file_types(registered, true, exts)?.changed };
    let context_menu = read_command(&root, CONTEXT_VERB).is_some();
    if context_menu {
        cmd_set_context_menu(true)?;
    }
    let removed = remove_stale_app_keys(&root, &exe);
    notify_assoc_changed();
    Ok(RepairResult { repointed, context_menu, removed })
}

/* ---------------- Explorer right-click "Edit in notepad.md" ---------------- */

/// A classic shell verb on every file type (`*`), per user. On Windows 11 classic verbs appear
/// under "Show more options" (Shift+F10); the compact menu only lists packaged apps.
const CONTEXT_VERB: &str = "*\\shell\\NotepadMD.Edit";

#[tauri::command]
pub fn cmd_set_context_menu(enabled: bool) -> Result<(), String> {
    let root = classes_root()?;
    if enabled {
        let exe = exe_path()?.to_string_lossy().to_string();
        let (verb, _) = err(root.create_subkey(CONTEXT_VERB))?;
        err(verb.set_value("", &"Edit in notepad.md"))?;
        err(verb.set_value("Icon", &format!("\"{}\",0", exe)))?;
        err(err(verb.create_subkey("command"))?.0.set_value("", &open_command(&exe)))?;
    } else {
        let exe = exe_path()?.to_string_lossy().to_string();
        if let Owner::Other(p) = owner_of(read_command(&root, CONTEXT_VERB), &exe) {
            return Err(format!("The Explorer menu item belongs to another copy of notepad.md:\n{}\n\nTurn it off from that copy.", p));
        }
        delete_tree(&root, CONTEXT_VERB)?;
    }
    notify_assoc_changed();
    Ok(())
}

/// "on" (points at this exe), "other" (points at another copy) or "off".
#[tauri::command]
pub fn cmd_context_menu_status() -> Result<String, String> {
    let exe = exe_path()?.to_string_lossy().to_string();
    let current: Option<String> = classes_root()?
        .open_subkey(format!("{}\\command", CONTEXT_VERB))
        .ok()
        .and_then(|k| k.get_value("").ok());
    Ok(match current {
        Some(c) if c.eq_ignore_ascii_case(&open_command(&exe)) => "on",
        Some(_) => "other",
        None => "off",
    }
    .into())
}

#[derive(serde::Serialize)]
pub struct AccentColors {
    /// For light mode (Windows' darker accent shade, readable on white).
    light: String,
    /// For dark mode (Windows' lighter accent shade, readable on dark grey).
    dark: String,
}

fn rgb_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

/// The Windows accent colour, as the shades Windows itself uses for text and controls in light
/// and dark mode (from the accent palette), or None if it can't be read.
#[tauri::command]
pub fn cmd_system_accent() -> Option<AccentColors> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(k) = hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent") {
        if let Ok(v) = k.get_raw_value("AccentPalette") {
            // 8 colours of 4 bytes (R, G, B, A): light 3, light 2, light 1, base, dark 1, dark 2, dark 3, -
            let b = &v.bytes;
            if b.len() >= 32 {
                let c = |i: usize| rgb_hex(b[i * 4], b[i * 4 + 1], b[i * 4 + 2]);
                return Some(AccentColors { light: c(4), dark: c(1) });
            }
        }
    }
    // Older Windows: the single accent colour (stored as 0xAABBGGRR).
    let dwm = hkcu.open_subkey("Software\\Microsoft\\Windows\\DWM").ok()?;
    let v: u32 = dwm.get_value("AccentColor").ok()?;
    let c = rgb_hex((v & 0xff) as u8, ((v >> 8) & 0xff) as u8, ((v >> 16) & 0xff) as u8);
    Some(AccentColors { light: c.clone(), dark: c })
}

#[tauri::command]
pub fn cmd_open_default_apps() -> Result<(), String> {
    open::that("ms-settings:defaultapps").map_err(|e| e.to_string())
}

/* ---------------- updates ---------------- */

/// Windows 10/11 ship curl.exe, so no HTTP library is needed.
fn curl(args: &[&str]) -> Result<Vec<u8>, String> {
    let out = err(Command::new("curl.exe").args(args).creation_flags(CREATE_NO_WINDOW).output())
        .map_err(|e| format!("Could not run curl.exe: {}", e))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if msg.contains("404") {
            return Err("No release has been published on GitHub yet.".into());
        }
        return Err(if msg.is_empty() { format!("Download failed (curl exit {:?}).", out.status.code()) } else { msg });
    }
    Ok(out.stdout)
}

/// "Save Link As" for a link in the editor: downloads http(s) `url` to `path` (chosen by the user).
#[tauri::command]
pub async fn cmd_download_url(url: String, path: String) -> Result<u64, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http/https links can be saved.".into());
    }
    let tmp = format!("{}.part", path);
    let out = err(Command::new("curl.exe")
        .args(["-sSL", "--fail", "--max-time", "600", "-H", USER_AGENT, "-o", &tmp, &url])
        .creation_flags(CREATE_NO_WINDOW)
        .output())
    .map_err(|e| format!("Could not run curl.exe: {}", e))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() { format!("Download failed (curl exit {:?}).", out.status.code()) } else { msg });
    }
    let _ = std::fs::remove_file(&path);
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

/// SHA-256 via Windows' built-in certutil (avoids adding a hashing library).
fn sha256_file(path: &str) -> Result<String, String> {
    let out = err(Command::new("certutil.exe").args(["-hashfile", path, "SHA256"]).creation_flags(CREATE_NO_WINDOW).output())?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .map(|l| l.trim().replace(' ', ""))
        .find(|l| l.len() == 64 && l.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| "Could not check the download's checksum.".to_string())
}

/// Only release files from this repository are ever downloaded as an update.
const TRUSTED_ASSET_PREFIX: &str = "https://github.com/mccabedd/notepad.md/releases/download/";

/// Tests point the updater at a local release file (file:///...) with NOTEPADMD_UPDATE_URL.
/// Only local file: addresses are accepted there, so the variable can't redirect updates to the
/// internet; in test mode the asset may also be a local file.
fn test_release_url() -> Option<String> {
    std::env::var("NOTEPADMD_UPDATE_URL").ok().filter(|u| u.starts_with("file:///"))
}

fn parse_version(s: &str) -> Vec<u64> {
    s.trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0))
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (parse_version(latest), parse_version(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (*a.get(i).unwrap_or(&0), *b.get(i).unwrap_or(&0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// The latest release as GitHub describes it.
struct Release {
    tag: String,
    page_url: String,
    notes: String,
    asset_name: Option<String>,
    asset_url: Option<String>,
    asset_size: Option<u64>,
    digest: Option<String>,
}

fn fetch_release() -> Result<Release, String> {
    let url = test_release_url().unwrap_or_else(|| UPDATE_API.into());
    let body = curl(&["-sSL", "--fail", "--proto", "=https,file", "--max-time", "20", "-H", USER_AGENT, "-H", "Accept: application/vnd.github+json", &url])?;
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|_| "GitHub sent an unexpected reply.".to_string())?;
    let tag = v["tag_name"].as_str().unwrap_or("").to_string();
    if tag.is_empty() {
        return Err("No release has been published on GitHub yet.".into());
    }
    let assets = v["assets"].as_array().cloned().unwrap_or_default();
    let exe_asset = assets.iter().find(|a| a["name"].as_str().map(|n| n.to_ascii_lowercase().ends_with(".exe")).unwrap_or(false));
    Ok(Release {
        tag,
        page_url: v["html_url"].as_str().unwrap_or("").to_string(),
        notes: v["body"].as_str().unwrap_or("").chars().take(1500).collect(),
        asset_name: exe_asset.and_then(|a| a["name"].as_str().map(String::from)),
        asset_url: exe_asset.and_then(|a| a["browser_download_url"].as_str().map(String::from)),
        asset_size: exe_asset.and_then(|a| a["size"].as_u64()),
        digest: exe_asset.and_then(|a| a["digest"].as_str().map(String::from)),
    })
}

/// The SHA-256 GitHub computed for the uploaded file ("sha256:<64 hex>"), or None if missing or malformed.
fn sha256_of_digest(digest: Option<&str>) -> Option<String> {
    let hex = digest?.trim().strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| hex.to_ascii_lowercase())
}

fn asset_url_trusted(url: &str, test_mode: bool) -> bool {
    url.starts_with(TRUSTED_ASSET_PREFIX) && !url.contains("..") || (test_mode && url.starts_with("file:///"))
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    current: String,
    latest: String,
    newer: bool,
    page_url: String,
    notes: String,
    asset_name: Option<String>,
    asset_url: Option<String>,
    asset_size: Option<u64>,
    digest: Option<String>,
}

#[tauri::command]
pub async fn cmd_check_update() -> Result<UpdateInfo, String> {
    let r = fetch_release()?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    Ok(UpdateInfo {
        newer: is_newer(&r.tag, &current),
        latest: r.tag.trim_start_matches(['v', 'V']).to_string(),
        current,
        page_url: r.page_url,
        notes: r.notes,
        asset_name: r.asset_name,
        asset_url: r.asset_url,
        asset_size: r.asset_size,
        digest: r.digest,
    })
}

/// Removes a file, ignoring "not found".
fn remove_quietly(p: &std::path::Path) {
    let _ = std::fs::remove_file(p);
}

/// Downloads the new exe, verifies it, swaps it in for the running one (a running exe can be
/// renamed on Windows, just not overwritten), starts it and exits. The page saves the session
/// first, so the new version reopens every tab.
///
/// Safety rules:
/// - The release is looked up again here; nothing the page passes is trusted as a download address.
/// - Only files from this repository's GitHub releases are accepted.
/// - The release must carry GitHub's SHA-256 for the file, and the download must match it and its
///   size; a missing or malformed checksum stops the update.
/// - The download is staged and verified next to the exe before anything is replaced, and every
///   failure puts the previous version back, so the app is never left without a working exe.
#[tauri::command]
pub async fn cmd_install_update(app: tauri::AppHandle, version: Option<String>) -> Result<(), String> {
    let test_mode = test_release_url().is_some();
    let r = fetch_release()?;
    let current = env!("CARGO_PKG_VERSION");
    if !is_newer(&r.tag, current) {
        return Err("There is no newer version to install.".into());
    }
    if let Some(v) = &version {
        if parse_version(v) != parse_version(&r.tag) {
            return Err("The release changed while you were deciding. Check for updates again.".into());
        }
    }
    let asset_url = r.asset_url.ok_or("This release has no Windows download attached.")?;
    if !asset_url_trusted(&asset_url, test_mode) {
        return Err("Refusing to download an update from outside the notepad.md releases on GitHub.".into());
    }
    let expected_hash = sha256_of_digest(r.digest.as_deref())
        .ok_or("This release has no checksum to verify the download against, so it was not installed. Download it from the releases page instead.")?;
    let expected_size = r.asset_size.ok_or("This release does not state the download's size, so it was not installed.")?;

    let exe = exe_path()?;
    let staged = exe.with_extension("exe.download");
    let old = exe.with_extension("old");
    remove_quietly(&staged);
    let staged_s = staged.to_string_lossy().to_string();
    let protos = if test_mode { "=https,file" } else { "=https" };
    if let Err(e) = curl(&["-sSL", "--fail", "--proto", protos, "--proto-redir", "=https", "--max-time", "600", "-H", USER_AGENT, "-o", &staged_s, &asset_url]) {
        remove_quietly(&staged);
        if !exe.parent().map(|d| d.exists()).unwrap_or(false) || std::fs::metadata(exe.parent().unwrap()).map(|m| m.permissions().readonly()).unwrap_or(false) {
            return Err(format!("Could not write to {}. Move notepad.md to a folder you can change, or download the update from the releases page.", exe.parent().unwrap().display()));
        }
        return Err(e);
    }
    let verify = || -> Result<(), String> {
        let bytes = err(std::fs::read(&staged))?;
        if bytes.len() < 500_000 || !bytes.starts_with(b"MZ") {
            return Err("The download is not a valid Windows program.".into());
        }
        if bytes.len() as u64 != expected_size {
            return Err("The download is incomplete (size does not match the release).".into());
        }
        if !sha256_file(&staged_s)?.eq_ignore_ascii_case(&expected_hash) {
            return Err("The download failed its checksum test, so it was not installed.".into());
        }
        Ok(())
    };
    if let Err(e) = verify() {
        remove_quietly(&staged);
        return Err(e);
    }

    // Swap: running exe -> .old, verified download -> exe. Undo on any failure.
    remove_quietly(&old);
    if let Err(e) = std::fs::rename(&exe, &old) {
        remove_quietly(&staged);
        return Err(format!("Could not replace {} ({}). Nothing was changed.", exe.display(), e));
    }
    if let Err(e) = std::fs::rename(&staged, &exe) {
        let _ = std::fs::rename(&old, &exe);
        remove_quietly(&staged);
        return Err(format!("Could not install the update ({}). Your current version was kept.", e));
    }
    if let Err(e) = Command::new(&exe).arg("--after-update").spawn() {
        // The new exe won't start: put the previous version back.
        remove_quietly(&exe);
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("The new version could not start ({}). Your current version was kept.", e));
    }
    // Give the reply a moment to reach the page, then quit; the new version takes over.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        app.exit(0);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions() {
        assert!(is_newer("v1.0.1", "1.0.0"));
        assert!(is_newer("1.10.0", "1.9.9"));
        assert!(!is_newer("v1.0.0", "1.0.0"));
        assert!(!is_newer("0.9", "1.0.0"));
        assert!(is_newer("2", "1.9.9"));
    }

    #[test]
    fn owner_of_commands() {
        let me = "C:\\Apps\\notepad-md.exe";
        assert_eq!(owner_of(None, me), Owner::Us);
        assert_eq!(owner_of(Some(open_command(me)), me), Owner::Us);
        assert_eq!(owner_of(Some(open_command("c:\\apps\\NOTEPAD-MD.EXE")), me), Owner::Us);
        assert_eq!(owner_of(Some(open_command("C:\\Gone\\notepad-md.exe")), me), Owner::Stale);
        let other = std::env::current_exe().unwrap().to_string_lossy().to_string();
        assert_eq!(owner_of(Some(open_command(&other)), me), Owner::Other(other.clone()));
        assert_eq!(command_exe("\"C:\\a b\\x.exe\" \"%1\""), Some("C:\\a b\\x.exe".into()));
    }

    /// Register/unregister against a throwaway registry key (never the real file associations).
    #[test]
    fn register_and_unregister_are_safe_and_idempotent() {
        let test_root = format!("Software\\NotepadMD-UnitTest-{}", std::process::id());
        std::env::set_var("NOTEPADMD_REG_ROOT", format!("{}\\Classes", test_root));
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let root = classes_root().unwrap();
        // .bat already runs with Windows' own handler: that default must survive.
        root.create_subkey(".bat").unwrap().0.set_value("", &"batfile").unwrap();
        let exts = vec!["md".to_string(), "bat".to_string(), "bad ext".to_string()];

        assert_eq!(cmd_register_file_types(exts.clone()).unwrap(), 2);
        assert_eq!(cmd_register_file_types(exts.clone()).unwrap(), 2, "registering twice");
        let bat = root.open_subkey(".bat").unwrap();
        assert_eq!(bat.get_value::<String, _>("").unwrap(), "batfile");
        assert!(root.open_subkey(".bat\\OpenWithProgids").unwrap().get_raw_value(PROG_ID).is_ok());

        cmd_unregister_file_types(exts.clone()).unwrap();
        cmd_unregister_file_types(exts.clone()).unwrap(); // twice: no error
        assert_eq!(root.open_subkey(".bat").unwrap().get_value::<String, _>("").unwrap(), "batfile");
        assert!(root.open_subkey(PROG_ID).is_err());
        assert!(root.open_subkey(".md\\OpenWithProgids").unwrap().get_raw_value(PROG_ID).is_err());

        // Another copy that still exists owns the registration: left alone, error explains why.
        let other = format!("{}\\System32\\notepad.exe", std::env::var("SystemRoot").unwrap());
        cmd_register_file_types(exts.clone()).unwrap();
        root.open_subkey_with_flags(format!("{}\\shell\\open\\command", PROG_ID), KEY_ALL_ACCESS).unwrap().set_value("", &open_command(&other)).unwrap();
        let e = cmd_unregister_file_types(exts.clone()).unwrap_err();
        assert!(e.contains("another copy"), "{}", e);
        assert!(root.open_subkey(PROG_ID).is_ok());
        assert!(root.open_subkey(".md\\OpenWithProgids").unwrap().get_raw_value(PROG_ID).is_ok());

        // ...but a copy that was moved or deleted is cleaned up.
        root.open_subkey_with_flags(format!("{}\\shell\\open\\command", PROG_ID), KEY_ALL_ACCESS).unwrap().set_value("", &open_command("C:\\Nowhere\\notepad-md.exe")).unwrap();
        cmd_unregister_file_types(exts).unwrap();
        assert!(root.open_subkey(PROG_ID).is_err());

        // One extension at a time (Settings > File Types), in the same throwaway key.
        let all = vec!["md".to_string(), "bat".to_string(), "json".to_string()];
        let s = cmd_file_type_states(all.clone()).unwrap();
        assert!(s.registered.is_empty() && s.owner == "none");
        let r = cmd_set_file_types(vec!["bat".into()], true, all.clone()).unwrap();
        assert_eq!((r.changed, r.failed.len()), (1, 0));
        let s = cmd_file_type_states(all.clone()).unwrap();
        assert_eq!((s.registered.clone(), s.owner.as_str()), (vec!["bat".to_string()], "us"));
        assert_eq!(root.open_subkey(".bat").unwrap().get_value::<String, _>("").unwrap(), "batfile", ".bat still runs as before");
        cmd_set_file_types(vec!["md".into(), "json".into()], true, all.clone()).unwrap();
        assert_eq!(cmd_file_type_states(all.clone()).unwrap().registered.len(), 3);
        cmd_set_file_types(vec!["bat".into()], false, all.clone()).unwrap();
        let s = cmd_file_type_states(all.clone()).unwrap();
        assert_eq!(s.registered, vec!["md".to_string(), "json".to_string()]);
        assert!(root.open_subkey(PROG_ID).is_ok(), "shared entry kept while others are registered");
        assert_eq!(root.open_subkey(".bat").unwrap().get_value::<String, _>("").unwrap(), "batfile");
        cmd_set_file_types(all.clone(), false, all.clone()).unwrap();
        assert!(cmd_file_type_states(all.clone()).unwrap().registered.is_empty());
        assert!(root.open_subkey(PROG_ID).is_err(), "last one removed: shared entry removed too");

        // Renamed from notepad-md.exe (v1.2.0) to notepad.md.exe: the old registrations point at an
        // exe that is gone. "Use this copy" points them here and removes only the app's own stale key.
        let me = exe_path().unwrap().to_string_lossy().to_string();
        let gone = "C:\\Nowhere\\notepad-md.exe";
        let existing = format!("{}\\System32\\notepad.exe", std::env::var("SystemRoot").unwrap());
        let app_key = |name: &str, friendly: &str, exe: &str| {
            let (k, _) = root.create_subkey(format!("Applications\\{}", name)).unwrap();
            k.set_value("FriendlyAppName", &friendly).unwrap();
            k.create_subkey("shell\\open\\command").unwrap().0.set_value("", &open_command(exe)).unwrap();
        };
        app_key("notepad-md.exe", "NotePad-MD", gone); // the old copy: stale, ours -> removed
        app_key("NotepadMD-v1.0.2-win-x64.exe", "Notepad MD", gone); // an even older name -> removed
        app_key("NotePad-MD-v1.2.0-win-x64.exe", "NotePad-MD", &existing); // a copy that still exists -> kept
        app_key("someone-else.exe", "Other App", gone); // not ours -> kept
        let (prog, _) = root.create_subkey(format!("{}\\shell\\open\\command", PROG_ID)).unwrap();
        prog.set_value("", &open_command(gone)).unwrap();
        root.create_subkey(".md\\OpenWithProgids").unwrap().0.set_value(PROG_ID, &"").unwrap();
        root.create_subkey(".bat\\OpenWithProgids").unwrap().0.set_value(PROG_ID, &"").unwrap();
        root.create_subkey(format!("{}\\command", CONTEXT_VERB)).unwrap().0.set_value("", &open_command(gone)).unwrap();
        assert_eq!(cmd_file_type_states(all.clone()).unwrap().owner, "stale");

        let r = cmd_repair_registrations(all.clone()).unwrap();
        assert_eq!(r.repointed, 2);
        assert!(r.context_menu);
        let mut removed = r.removed.clone();
        removed.sort();
        // (set_file_types already removed them; repair reports what was still left)
        let keys: Vec<String> = root.open_subkey("Applications").unwrap().enum_keys().filter_map(|k| k.ok()).collect();
        assert!(!keys.iter().any(|k| k == "notepad-md.exe" || k == "NotepadMD-v1.0.2-win-x64.exe"), "stale keys of this app removed: {:?}", keys);
        assert!(keys.iter().any(|k| k == "NotePad-MD-v1.2.0-win-x64.exe"), "a copy that still exists is left alone");
        assert!(keys.iter().any(|k| k == "someone-else.exe"), "another program's key is left alone");
        let s = cmd_file_type_states(all.clone()).unwrap();
        assert_eq!((s.owner.as_str(), s.registered.len()), ("us", 2));
        assert_eq!(read_command(&root, &format!("{}\\shell\\open", PROG_ID)), Some(open_command(&me)));
        assert_eq!(read_command(&root, CONTEXT_VERB), Some(open_command(&me)));
        assert_eq!(root.open_subkey(".bat").unwrap().get_value::<String, _>("").unwrap(), "batfile", ".bat still runs as before");
        let friendly: String = root.open_subkey(format!("Applications\\{}", exe_file_name(&exe_path().unwrap()))).unwrap().get_value("FriendlyAppName").unwrap();
        assert_eq!(friendly, "notepad.md");
        let shown: String = root.open_subkey(CONTEXT_VERB).unwrap().get_value("").unwrap();
        assert_eq!(shown, "Edit in notepad.md");

        drop(root);
        hkcu.delete_subkey_all(&test_root).unwrap();
    }

    #[test]
    fn checksum_must_be_present_and_well_formed() {
        let good = format!("sha256:{}", "A".repeat(64));
        assert_eq!(sha256_of_digest(Some(&good)), Some("a".repeat(64)));
        assert_eq!(sha256_of_digest(None), None);
        assert_eq!(sha256_of_digest(Some("")), None);
        assert_eq!(sha256_of_digest(Some(&"a".repeat(64))), None, "no sha256: prefix");
        assert_eq!(sha256_of_digest(Some(&format!("sha256:{}", "a".repeat(63)))), None, "too short");
        assert_eq!(sha256_of_digest(Some(&format!("sha256:{}", "g".repeat(64)))), None, "not hex");
        assert_eq!(sha256_of_digest(Some(&format!("md5:{}", "a".repeat(64)))), None);
    }

    #[test]
    fn only_this_repositorys_releases_are_trusted() {
        assert!(asset_url_trusted("https://github.com/mccabedd/notepad.md/releases/download/v1.3.0/notepad.md-v1.3.0-win-x64.exe", false));
        assert!(!asset_url_trusted("https://github.com/someone-else/notepad-md/releases/download/v1/x.exe", false));
        assert!(!asset_url_trusted("https://evil.example/NotepadMD.exe", false));
        assert!(!asset_url_trusted("http://github.com/mccabedd/notepad.md/releases/download/v1/x.exe", false));
        assert!(!asset_url_trusted("https://github.com/mccabedd/notepad.md/releases/download/../../x/x.exe", false));
        assert!(!asset_url_trusted("https://github.com/mccabedd/notepad.md.evil.example/releases/download/v1/x.exe", false));
        assert!(!asset_url_trusted("https://github.com/mccabedd/notepad-md/releases/download/v1.2.0/NotePad-MD-v1.2.0-win-x64.exe", false), "the old repository name is no longer trusted");
        assert!(!asset_url_trusted("file:///C:/x.exe", false), "local files only in test mode");
        assert!(asset_url_trusted("file:///C:/x.exe", true));
    }
}
