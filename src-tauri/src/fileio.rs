//! Reading and writing documents: encoding detection, Windows-1252 ("ANSI") support and
//! crash-safe saving (write a temporary file next to the document, then swap it in).

use std::fs;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

/// Windows-1252 bytes 0x80..=0x9F. The five bytes Windows leaves undefined (0x81, 0x8D, 0x8F,
/// 0x90, 0x9D) map to the matching control characters, like Windows itself does, so every byte
/// still reads and writes back unchanged.
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

fn cp1252_decode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| if (0x80..0xA0).contains(&b) { CP1252_HIGH[(b - 0x80) as usize] } else { b as char })
        .collect()
}

fn cp1252_byte(c: char) -> Option<u8> {
    let u = c as u32;
    if u < 0x80 || (0xA0..0x100).contains(&u) {
        return Some(u as u8);
    }
    CP1252_HIGH.iter().position(|&h| h == c).map(|i| 0x80 + i as u8)
}

/// Encoded bytes, or None when some character cannot be stored in ANSI.
fn cp1252_encode(content: &str) -> Option<Vec<u8>> {
    content.chars().map(cp1252_byte).collect()
}

/// Returns the text and the encoding name the page keeps for saving it back
/// (utf8, utf8bom, utf16le, utf16be, or latin1 = Windows ANSI / Windows-1252).
pub fn decode(bytes: &[u8]) -> Result<(String, &'static str), String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(bytes[3..].to_vec())
            .map(|s| (s, "utf8bom"))
            .map_err(|_| "File has a UTF-8 marker but is not valid UTF-8".into());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        let le = bytes[0] == 0xFF;
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        return String::from_utf16(&units)
            .map(|s| (s, if le { "utf16le" } else { "utf16be" }))
            .map_err(|_| "File is not valid UTF-16".into());
    }
    if bytes.contains(&0) {
        return Err("This looks like a binary file, not text".into());
    }
    match String::from_utf8(bytes.to_vec()) {
        Ok(s) => Ok((s, "utf8")),
        // Not UTF-8: Windows ANSI (Windows-1252). The name stays "latin1" so saved sessions still match.
        Err(_) => Ok((cp1252_decode(bytes), "latin1")),
    }
}

/// Bytes to write, and the encoding actually used. ANSI text containing a character ANSI cannot
/// hold is saved as UTF-8 instead (nothing is lost); the caller tells the user.
pub fn encode(content: &str, encoding: &str) -> (Vec<u8>, &'static str) {
    match encoding {
        "utf8bom" => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(content.as_bytes());
            (v, "utf8bom")
        }
        "utf16le" | "utf16be" => {
            let le = encoding == "utf16le";
            let mut v = if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
            for u in content.encode_utf16() {
                v.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
            }
            (v, if le { "utf16le" } else { "utf16be" })
        }
        "latin1" => match cp1252_encode(content) {
            Some(v) => (v, "latin1"),
            None => (content.as_bytes().to_vec(), "utf8"),
        },
        _ => (content.as_bytes().to_vec(), "utf8"),
    }
}

#[link(name = "kernel32")]
extern "system" {
    fn ReplaceFileW(
        replaced: *const u16,
        replacement: *const u16,
        backup: *const u16,
        flags: u32,
        exclude: *const core::ffi::c_void,
        reserved: *const core::ffi::c_void,
    ) -> i32;
}

fn wide(p: &Path) -> Vec<u16> {
    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// Turns a Windows error into something a person can act on.
pub fn friendly_error(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        Some(5) => "Windows refused access. The file may be read-only, or you may not have permission to change it.".into(),
        Some(32) | Some(33) => "The file is in use by another program. Close it there and try again.".into(),
        Some(39) | Some(112) => "There is not enough free disk space.".into(),
        Some(3) => "The folder no longer exists.".into(),
        Some(19) => "The disk is write-protected.".into(),
        _ => e.to_string(),
    }
}

fn temp_path_for(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    // Unique per save, so two saves of the same file at once never share a temporary file.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    path.with_file_name(format!(".{}.{}-{}.notepadmd-tmp", name, std::process::id(), n))
}

/// Where ReplaceFileW moves the original while it swaps the files in (same folder, so same volume).
fn backup_path_for(tmp: &Path) -> PathBuf {
    tmp.with_extension("notepadmd-bak")
}

/// After ReplaceFileW failed: make sure a document is back at `path`.
///
/// Some failures happen after Windows has already moved the original out of the way (error 1176
/// "the replaced file no longer exists", 1177 "still exists with a different name"). Deleting the
/// temporary file then, as a plain cleanup would, leaves no file at all. So: if the document is
/// missing, the new contents (what the user asked to save) are moved into place; if that fails too,
/// the original is put back from the backup. Only when the document is safely at `path` are the
/// leftovers removed. Returns true when the new contents ended up saved.
fn recover_after_failed_replace(path: &Path, tmp: &Path, backup: &Path) -> bool {
    let mut saved = false;
    if !path.exists() {
        if tmp.exists() && fs::rename(tmp, path).is_ok() {
            saved = true;
        } else if backup.exists() {
            let _ = fs::rename(backup, path);
        }
    }
    if path.exists() {
        let _ = fs::remove_file(tmp);
        let _ = fs::remove_file(backup);
    }
    saved
}

/// Saves `bytes` to `path` without ever leaving a half-written document behind:
/// the new contents go to a temporary file in the same folder, are flushed to disk, and then
/// replace the original in one step (ReplaceFileW keeps its attributes, permissions and creation
/// time). If writing the temporary file fails, the original is untouched. If the swap itself fails
/// part-way (Windows had already moved the original aside), the document is put back in place,
/// with the new contents when possible, otherwise the original.
pub fn save_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // A symbolic link: save into the file it points to and keep the link itself.
    let resolved;
    let path = match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => {
            resolved = fs::canonicalize(path).map_err(|e| friendly_error(&e))?;
            resolved.as_path()
        }
        _ => path,
    };
    if let Ok(meta) = fs::metadata(path) {
        if meta.is_dir() {
            return Err("That is a folder, not a file.".into());
        }
        if meta.permissions().readonly() {
            return Err("The file is read-only. Use Save As to save a copy somewhere else.".into());
        }
    }
    let tmp = temp_path_for(path);
    let write_tmp = || -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    };
    if let Err(e) = write_tmp() {
        let _ = fs::remove_file(&tmp);
        // Some folders let you change a file but not create new ones. Writing over the original
        // there could leave it half-written if anything failed part-way, so the save is refused
        // instead (the original stays exactly as it was) and Save As is suggested.
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            return Err("This folder doesn't allow new files to be created, which a safe save needs (the document is first written to a temporary file next to it). Your file has not been changed. Use Save As to save it somewhere else.".into());
        }
        return Err(friendly_error(&e));
    }
    if !path.exists() {
        return fs::rename(&tmp, path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            friendly_error(&e)
        });
    }
    // The original is moved to a backup name during the swap, so a failure part-way through can
    // always be undone (see recover_after_failed_replace).
    let backup = backup_path_for(&tmp);
    // 0x2 = REPLACEFILE_IGNORE_MERGE_ERRORS
    let ok = unsafe { ReplaceFileW(wide(path).as_ptr(), wide(&tmp).as_ptr(), wide(&backup).as_ptr(), 0x2, std::ptr::null(), std::ptr::null()) };
    if ok != 0 {
        let _ = fs::remove_file(&backup);
        return Ok(());
    }
    let e = std::io::Error::last_os_error();
    if recover_after_failed_replace(path, &tmp, &backup) {
        return Ok(());
    }
    if !path.exists() {
        // Nothing could be put back (very unlikely): say exactly where the copies are.
        return Err(format!(
            "{} The file could not be put back in place. Your text is still open here (use Save As), and copies may be next to it: {} (new) or {} (previous).",
            friendly_error(&e),
            tmp.display(),
            backup.display()
        ));
    }
    Err(friendly_error(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi_smart_quotes_euro_and_accents() {
        let bytes = b"\x93Caf\xe9\x94 costs \x8010 \x96 na\xefve\x85";
        let (s, enc) = decode(bytes).unwrap();
        assert_eq!(enc, "latin1");
        assert_eq!(s, "\u{201C}Caf\u{e9}\u{201D} costs \u{20AC}10 \u{2013} na\u{ef}ve\u{2026}");
        let (back, used) = encode(&s, enc);
        assert_eq!(used, "latin1");
        assert_eq!(back, bytes.to_vec());
    }

    #[test]
    fn every_ansi_byte_round_trips() {
        let bytes: Vec<u8> = (1u8..=255).collect();
        let (s, enc) = decode(&[&bytes[..], b"\xff"].concat()).unwrap();
        assert_eq!(enc, "latin1");
        assert_eq!(encode(&s, enc).0, [&bytes[..], b"\xff"].concat());
    }

    #[test]
    fn ansi_with_unrepresentable_text_becomes_utf8() {
        let (bytes, used) = encode("caf\u{e9} \u{65E5}\u{672C}", "latin1");
        assert_eq!(used, "utf8");
        assert_eq!(String::from_utf8(bytes).unwrap(), "caf\u{e9} \u{65E5}\u{672C}");
    }

    #[test]
    fn utf_encodings_round_trip() {
        let text = "h\u{e9}llo \u{20AC} \u{1F600}\r\nline2";
        for enc in ["utf8", "utf8bom", "utf16le", "utf16be"] {
            let (bytes, used) = encode(text, enc);
            assert_eq!(used, enc);
            let (back, got) = decode(&bytes).unwrap();
            assert_eq!(back, text, "{}", enc);
            assert_eq!(got, enc);
        }
    }

    #[test]
    fn binary_is_refused() {
        assert!(decode(b"abc\0def").is_err());
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("notepadmd-fileio-test-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn save_creates_and_replaces_without_leftovers() {
        let d = scratch("save");
        let p = d.join("doc.txt");
        save_file(&p, b"first").unwrap();
        save_file(&p, b"second, longer").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"second, longer");
        save_file(&p, b"3").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"3");
        let names: Vec<_> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "temporary files left behind: {:?}", names);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn read_only_file_is_left_alone() {
        let d = scratch("ro");
        let p = d.join("ro.txt");
        fs::write(&p, b"original").unwrap();
        let mut perm = fs::metadata(&p).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&p, perm.clone()).unwrap();
        let e = save_file(&p, b"new").unwrap_err();
        assert!(e.contains("read-only"), "{}", e);
        assert_eq!(fs::read(&p).unwrap(), b"original");
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(&p, perm).unwrap();
        let _ = fs::remove_dir_all(&d);
    }

    /// A folder where the file may be changed but no new file may be created: the save is refused
    /// (no writing over the original in place) and the original is left exactly as it was.
    #[test]
    fn folder_without_create_rights_never_overwrites_in_place() {
        let d = scratch("nocreate");
        let p = d.join("doc.txt");
        fs::write(&p, b"original").unwrap();
        let user = std::env::var("USERNAME").unwrap();
        let ds = d.to_string_lossy().to_string();
        // Deny "create files" (WD on a folder) for this folder only; the file keeps its own rights.
        let icacls = |args: &[&str]| std::process::Command::new("icacls").args(args).output().unwrap();
        let out = icacls(&[&ds, "/deny", &format!("{}:(WD)", user)]);
        assert!(out.status.success(), "icacls: {}", String::from_utf8_lossy(&out.stdout));
        assert!(fs::File::create(d.join("probe.txt")).is_err(), "the folder should refuse new files");
        let e = save_file(&p, b"new contents");
        icacls(&[&ds, "/remove:d", &user]);
        let e = e.unwrap_err();
        assert!(e.contains("Save As") && e.contains("has not been changed"), "{}", e);
        assert_eq!(fs::read(&p).unwrap(), b"original");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1, "no temporary file left behind");
        let _ = fs::remove_dir_all(&d);
    }

    /// The states ReplaceFileW can leave behind when it fails part-way (Microsoft's documentation,
    /// errors 1176 / 1177): each one ends with a document at the path and no leftovers.
    #[test]
    fn failed_swap_always_leaves_a_document() {
        let d = scratch("swap");
        let p = d.join("doc.txt");
        let tmp = d.join(".doc.txt.1-0.notepadmd-tmp");
        let bak = backup_path_for(&tmp);
        // 1176 without a backup name: the original is gone, the new text is still in the temporary file.
        fs::write(&tmp, b"new").unwrap();
        assert!(recover_after_failed_replace(&p, &tmp, &bak));
        assert_eq!(fs::read(&p).unwrap(), b"new");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
        // 1177: the original was moved to the backup name and the temporary file can't be moved
        // either (here: it's gone): the original comes back.
        fs::rename(&p, &bak).unwrap();
        assert!(!recover_after_failed_replace(&p, &tmp, &bak));
        assert_eq!(fs::read(&p).unwrap(), b"new");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
        // 1175 and other early failures: nothing moved, the document is untouched, leftovers go.
        fs::write(&tmp, b"newer").unwrap();
        fs::write(&bak, b"stale").unwrap();
        assert!(!recover_after_failed_replace(&p, &tmp, &bak));
        assert_eq!(fs::read(&p).unwrap(), b"new");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn locked_file_keeps_its_contents() {
        use std::os::windows::fs::OpenOptionsExt;
        let d = scratch("locked");
        let p = d.join("locked.txt");
        fs::write(&p, b"original").unwrap();
        // Open with no sharing at all, like an editor holding the file exclusively.
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(&p).unwrap();
        let e = save_file(&p, b"new").unwrap_err();
        assert!(e.contains("in use"), "{}", e);
        drop(held);
        assert_eq!(fs::read(&p).unwrap(), b"original");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1, "temporary file left behind");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn saving_through_a_symlink_keeps_the_link() {
        let d = scratch("link");
        let target = d.join("real.txt");
        let link = d.join("link.txt");
        fs::write(&target, b"old").unwrap();
        // Creating symlinks needs Developer Mode or admin rights; skip quietly without them.
        if std::os::windows::fs::symlink_file(&target, &link).is_err() {
            let _ = fs::remove_dir_all(&d);
            return;
        }
        save_file(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"new");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_folder_gives_a_clear_error() {
        let d = scratch("missing");
        let e = save_file(&d.join("no-such-folder").join("x.txt"), b"x").unwrap_err();
        assert!(e.contains("folder"), "{}", e);
        let _ = fs::remove_dir_all(&d);
    }
}
