#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fileio;
mod instance;
mod linkmenu;
mod printpdf;
mod savedialog;
mod system;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use std::collections::HashMap;
use tauri::{Emitter, Manager, State, WindowEvent};

/// Files larger than this are refused. Big files (logs) open in a lighter "large file" mode in the page.
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// View-menu items that show a tick; the page tells us when their state changes.
struct MenuChecks(Mutex<HashMap<String, CheckMenuItem<tauri::Wry>>>);

/// File > Recent Files (rebuilt by the page whenever the list changes).
struct RecentMenu(Mutex<Option<Submenu<tauri::Wry>>>);

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, PartialEq, Debug)]
struct FileStat {
    mtime: u64,
    size: u64,
}

/// Last-modified time (ms since 1970) and size, used to notice changes made by other programs.
fn stat_of(path: &str) -> Option<FileStat> {
    let m = fs::metadata(path).ok()?;
    if !m.is_file() {
        return None;
    }
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(FileStat { mtime, size: m.len() })
}

struct AppState {
    initial_files: Mutex<Vec<PathBuf>>,
    /// Set once the window has started closing, so a second close request goes straight through.
    closing: AtomicBool,
    /// The page confirmed it is handling the close (it may be showing a save prompt), so the
    /// safety-net timer must not destroy the window.
    close_acked: AtomicBool,
    /// The menu bar was shown by pressing Alt while it is switched off: the next menu command hides it again.
    menu_peek: AtomicBool,
}

#[derive(serde::Serialize)]
struct FileData {
    path: String,
    content: String,
    /// One of: utf8, utf8bom, utf16le, utf16be, latin1. Used to write the file back the same way.
    encoding: String,
    mtime: u64,
    size: u64,
}

fn read_file_data(path: &str) -> Result<FileData, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("That is a folder, not a file".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("File is too large to open (over 100 MB)".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let (content, encoding) = fileio::decode(&bytes)?;
    let st = stat_of(path).unwrap_or(FileStat { mtime: 0, size: bytes.len() as u64 });
    Ok(FileData {
        path: path.to_string(),
        content,
        encoding: encoding.to_string(),
        mtime: st.mtime,
        size: st.size,
    })
}

#[tauri::command]
async fn cmd_read_file(path: String) -> Result<FileData, String> {
    read_file_data(&path)
}

/// Returned when the file changed on disk between the page's check and the write.
const CHANGED_ON_DISK: &str = "CHANGED_ON_DISK";

#[derive(serde::Serialize)]
struct SavedFile {
    mtime: Option<u64>,
    size: Option<u64>,
    /// Encoding actually written (ANSI text that no longer fits in ANSI is saved as UTF-8).
    encoding: &'static str,
}

/// Saves a document crash-safely. `expect` is the file's state when the page last checked it:
/// if another program changed it since, nothing is written and the page asks the user again.
#[tauri::command]
async fn cmd_write_file(path: String, content: String, encoding: Option<String>, expect: Option<FileStat>) -> Result<SavedFile, String> {
    if let Some(e) = expect {
        if stat_of(&path) != Some(e) {
            return Err(CHANGED_ON_DISK.into());
        }
    }
    let (bytes, used) = fileio::encode(&content, encoding.as_deref().unwrap_or("utf8"));
    fileio::save_file(std::path::Path::new(&path), &bytes)?;
    let st = stat_of(&path);
    Ok(SavedFile { mtime: st.map(|s| s.mtime), size: st.map(|s| s.size), encoding: used })
}

/// Last-modified time and size of each file (None when it no longer exists).
#[tauri::command]
async fn cmd_file_stat(paths: Vec<String>) -> Vec<Option<FileStat>> {
    paths.iter().map(|p| stat_of(p)).collect()
}

/// Rebuilds File > Recent Files (ids recent_0, recent_1, ...).
#[tauri::command]
async fn cmd_set_recent(app: tauri::AppHandle, state: State<'_, RecentMenu>, paths: Vec<String>) -> Result<(), String> {
    let menu = state.0.lock().map_err(|e| e.to_string())?.clone();
    let Some(menu) = menu else { return Ok(()) };
    let e = |e: tauri::Error| e.to_string();
    for item in menu.items().map_err(e)? {
        menu.remove(&item).map_err(e)?;
    }
    if paths.is_empty() {
        menu.append(&MenuItem::with_id(&app, "recent_none", "(No recent files)", false, None::<&str>).map_err(e)?).map_err(e)?;
    }
    for (i, p) in paths.iter().take(10).enumerate() {
        // "&1 C:\path\file.md": the number is the keyboard shortcut; a real "&" must be doubled.
        let label = format!("&{} {}", (i + 1) % 10, p.replace('&', "&&"));
        menu.append(&MenuItem::with_id(&app, format!("recent_{i}"), label, true, None::<&str>).map_err(e)?).map_err(e)?;
    }
    menu.append(&PredefinedMenuItem::separator(&app).map_err(e)?).map_err(e)?;
    menu.append(&MenuItem::with_id(&app, "recent_clear", "Clear Recent Files", !paths.is_empty(), None::<&str>).map_err(e)?).map_err(e)?;
    Ok(())
}

#[tauri::command]
fn cmd_get_initial_files(state: State<AppState>) -> Vec<String> {
    let mut guard = state.initial_files.lock().unwrap();
    guard.drain(..).filter_map(|p| p.to_str().map(String::from)).collect()
}

#[tauri::command]
fn cmd_force_close(window: tauri::Window) {
    let _ = window.destroy();
}

#[tauri::command]
fn cmd_close_ack(state: State<AppState>) {
    state.close_acked.store(true, Ordering::SeqCst);
}

/// The user cancelled closing (e.g. in a save prompt): the next close request starts afresh.
#[tauri::command]
fn cmd_close_cancelled(state: State<AppState>) {
    state.close_acked.store(false, Ordering::SeqCst);
    state.closing.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn cmd_set_menu_visible(window: tauri::Window, state: State<AppState>, visible: bool, peek: Option<bool>) -> Result<(), String> {
    state.menu_peek.store(visible && peek.unwrap_or(false), Ordering::SeqCst);
    let r = if visible { window.show_menu() } else { window.hide_menu() };
    r.map_err(|e| e.to_string())
}

/// Sets the ticks in the View menu (async so it doesn't run on, and wait for, the main thread).
#[tauri::command]
async fn cmd_set_menu_checks(state: State<'_, MenuChecks>, checks: HashMap<String, bool>) -> Result<(), String> {
    let items: Vec<(CheckMenuItem<tauri::Wry>, bool)> = {
        let map = state.0.lock().map_err(|e| e.to_string())?;
        checks.iter().filter_map(|(id, on)| map.get(id).map(|i| (i.clone(), *on))).collect()
    };
    for (item, on) in items {
        item.set_checked(on).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Renames a file in place (double-clicking a tab's name). Refuses to overwrite another file.
#[tauri::command]
fn cmd_rename_file(from: String, to: String) -> Result<(), String> {
    let src = PathBuf::from(&from);
    let dst = PathBuf::from(&to);
    if !src.is_file() {
        return Err("The file no longer exists.".into());
    }
    if src.parent() != dst.parent() {
        return Err("Only the name can change, not the folder.".into());
    }
    // A change of case only ("notes.md" -> "Notes.md") is the same file on Windows.
    if dst.exists() && !from.eq_ignore_ascii_case(&to) {
        return Err(format!("A file named \"{}\" already exists there.", dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_delete_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http/https URLs can be opened".into());
    }
    open::that(url).map_err(|e| e.to_string())
}

fn session_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // NOTEPADMD_DATA_DIR lets automated tests use a throwaway folder instead of the real session.
    let dir = match std::env::var_os("NOTEPADMD_DATA_DIR") {
        Some(d) => PathBuf::from(d),
        None => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
fn cmd_session_load(app: tauri::AppHandle) -> Option<String> {
    let path = session_path(&app).ok()?;
    fs::read_to_string(path).ok()
}

#[tauri::command]
async fn cmd_session_save(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = session_path(&app)?;
    fileio::save_file(&path, json.as_bytes())
}

fn main() {
    system::cleanup_after_update();
    let initial_files: Vec<PathBuf> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .map(|p| if p.is_absolute() { p } else { std::env::current_dir().map(|d| d.join(&p)).unwrap_or(p) })
        .collect();
    let after_update = std::env::args().any(|a| a == "--after-update");
    if !instance::acquire(&initial_files, after_update) {
        return; // handed to the running window
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_uri_scheme_protocol("localimg", |_ctx, req| instance::serve_local_image(&req))
        .manage(linkmenu::HoverLink(Mutex::new(None)))
        .manage(AppState {
            initial_files: Mutex::new(initial_files),
            closing: AtomicBool::new(false),
            close_acked: AtomicBool::new(false),
            menu_peek: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            cmd_read_file,
            cmd_write_file,
            cmd_get_initial_files,
            cmd_force_close,
            cmd_delete_file,
            cmd_open_url,
            cmd_session_load,
            cmd_session_save,
            cmd_close_ack,
            cmd_close_cancelled,
            cmd_set_menu_visible,
            cmd_set_menu_checks,
            cmd_rename_file,
            cmd_file_stat,
            cmd_set_recent,
            printpdf::cmd_print_to_pdf,
            linkmenu::cmd_set_hover_link,
            system::cmd_app_info,
            system::cmd_register_file_types,
            system::cmd_unregister_file_types,
            system::cmd_file_types_status,
            system::cmd_file_type_states,
            system::cmd_set_file_types,
            system::cmd_repair_registrations,
            system::cmd_open_default_apps,
            system::cmd_system_accent,
            system::cmd_set_context_menu,
            system::cmd_context_menu_status,
            system::cmd_download_url,
            savedialog::cmd_save_dialog,
            system::cmd_check_update,
            system::cmd_install_update,
        ])
        .setup(|app| {
            instance::listen(app.handle().clone());
            if let Some(w) = app.get_webview_window("main") {
                linkmenu::install(&w);
            }
            // Accelerator strings below are display-only hint text: every shortcut is actually
            // handled by the JS keydown handler in ui/renderer.js.
            let recent_submenu = Submenu::with_items(
                app,
                "Recent Files",
                true,
                &[&MenuItem::with_id(app, "recent_none", "(No recent files)", false, None::<&str>)?],
            )?;
            app.manage(RecentMenu(Mutex::new(Some(recent_submenu.clone()))));
            let file_submenu = Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &MenuItem::with_id(app, "new", "New", true, Some("CmdOrCtrl+N"))?,
                    &MenuItem::with_id(app, "open", "Open...", true, Some("CmdOrCtrl+O"))?,
                    &recent_submenu,
                    &MenuItem::with_id(app, "reopen_closed", "Reopen Closed Tab", true, Some("CmdOrCtrl+Shift+T"))?,
                    &MenuItem::with_id(app, "reload_file", "Reload from Disk", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?,
                    &MenuItem::with_id(
                        app,
                        "save_as",
                        "Save As...",
                        true,
                        Some("CmdOrCtrl+Shift+S"),
                    )?,
                    &MenuItem::with_id(app, "save_all", "Save All", true, Some("CmdOrCtrl+Alt+S"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "print", "Print...", true, Some("CmdOrCtrl+P"))?,
                    &MenuItem::with_id(app, "export_pdf", "Export as PDF...", true, None::<&str>)?,
                    &MenuItem::with_id(app, "export_html", "Export as HTML...", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "close_tab", "Close Tab", true, Some("CmdOrCtrl+W"))?,
                    &MenuItem::with_id(app, "delete_file", "Delete File", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "settings", "Settings...\tCtrl+,", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "exit", "Exit", true, Some("Alt+F4"))?,
                ],
            )?;

            let edit_submenu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "goto_line", "Go to Line...", true, Some("CmdOrCtrl+G"))?,
                    &MenuItem::with_id(app, "fmt_bold", "Bold", true, Some("CmdOrCtrl+B"))?,
                    &MenuItem::with_id(app, "fmt_italic", "Italic", true, Some("CmdOrCtrl+I"))?,
                ],
            )?;

            // Items with a tick. The page keeps the ticks in step with its state
            // (cmd_set_menu_checks), whichever way a setting was changed.
            let mut checks: HashMap<String, CheckMenuItem<tauri::Wry>> = HashMap::new();
            let mut check = |id: &str, text: &str, accel: Option<&str>| -> tauri::Result<CheckMenuItem<tauri::Wry>> {
                let item = CheckMenuItem::with_id(app, id, text, true, false, accel)?;
                checks.insert(id.to_string(), item.clone());
                Ok(item)
            };

            let spelling_submenu = Submenu::with_items(
                app,
                "Spelling",
                true,
                &[
                    &check("spell_toggle", "Spell Check", Some("F7"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &check("spell_en_gb", "English (UK)", None)?,
                    &check("spell_en_us", "English (US)", None)?,
                ],
            )?;

            // Search > Bookmark. The colour is the one a click in the bookmark margin (and Ctrl+F2) uses.
            let bookmark_colour_submenu = Submenu::with_items(
                app,
                "Bookmark Colour",
                true,
                &[
                    &check("bookmark_colour_green", "Green", None)?,
                    &check("bookmark_colour_orange", "Orange", None)?,
                    &check("bookmark_colour_red", "Red", None)?,
                ],
            )?;
            let bookmark_submenu = Submenu::with_items(
                app,
                "Bookmark",
                true,
                &[
                    &MenuItem::with_id(app, "bookmark_toggle", "Toggle Bookmark", true, Some("CmdOrCtrl+F2"))?,
                    &MenuItem::with_id(app, "bookmark_next", "Next Bookmark", true, Some("F2"))?,
                    &MenuItem::with_id(app, "bookmark_prev", "Previous Bookmark", true, Some("Shift+F2"))?,
                    &MenuItem::with_id(app, "bookmark_clear", "Clear All Bookmarks...", true, None::<&str>)?,
                    &bookmark_colour_submenu,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "bookmark_cut", "Cut Bookmarked Lines", true, None::<&str>)?,
                    &MenuItem::with_id(app, "bookmark_copy", "Copy Bookmarked Lines", true, None::<&str>)?,
                    &MenuItem::with_id(app, "bookmark_paste", "Paste to (Replace) Bookmarked Lines", true, None::<&str>)?,
                    &MenuItem::with_id(app, "bookmark_remove", "Remove Bookmarked Lines", true, None::<&str>)?,
                    &MenuItem::with_id(app, "bookmark_remove_others", "Remove Non-Bookmarked Lines", true, None::<&str>)?,
                    &MenuItem::with_id(app, "bookmark_inverse", "Inverse Bookmarks", true, None::<&str>)?,
                ],
            )?;

            let search_submenu = Submenu::with_items(
                app,
                "Search",
                true,
                &[
                    &MenuItem::with_id(
                        app,
                        "find_replace",
                        "Find && Replace...",
                        true,
                        Some("CmdOrCtrl+F"),
                    )?,
                    &MenuItem::with_id(
                        app,
                        "find_advanced",
                        "Advanced Find...",
                        true,
                        Some("CmdOrCtrl+Shift+F"),
                    )?,
                    &MenuItem::with_id(app, "find_next", "Find Next", true, Some("F3"))?,
                    &MenuItem::with_id(app, "find_prev", "Find Previous", true, Some("Shift+F3"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "diag_next", "Next Problem", true, Some("F8"))?,
                    &MenuItem::with_id(app, "diag_prev", "Previous Problem", true, Some("Shift+F8"))?,
                    &MenuItem::with_id(app, "diag_check", "Check Syntax Now", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &bookmark_submenu,
                ],
            )?;

            // View > Language: every language a tab can be shown as (ids match LANGS in ui/renderer.js).
            // Text formats at the top, the rest grouped (same groups as the status-bar language menu).
            const TEXT_LANGUAGES: [(&str, &str); 4] = [
                ("markdown", "Markdown"),
                ("plaintext", "Plain Text"),
                ("bbcode", "BBCode"),
                ("log", "Log File"),
            ];
            const LANGUAGE_GROUPS: [(&str, &[(&str, &str)]); 5] = [
                (
                    "Web and Data",
                    &[
                        ("xml", "XML"),
                        ("html", "HTML"),
                        ("css", "CSS"),
                        ("json", "JSON"),
                        ("jsonc", "JSON with Comments"),
                        ("json5", "JSON5"),
                        ("jsonl", "JSON Lines"),
                        ("yaml", "YAML"),
                        ("toml", "TOML"),
                        ("sql", "SQL"),
                        ("diff", "Diff / Patch"),
                    ],
                ),
                (
                    "Scripts",
                    &[
                        ("bash", "Shell / Bash"),
                        ("powershell", "PowerShell"),
                        ("dos", "MS-DOS Batch"),
                        ("python", "Python"),
                        ("javascript", "JavaScript"),
                        ("php", "PHP"),
                        ("perl", "Perl"),
                        ("ruby", "Ruby"),
                        ("awk", "AWK (no colouring)"),
                        ("sed", "sed (no colouring)"),
                    ],
                ),
                (
                    "Configuration",
                    &[
                        ("ini", "INI"),
                        ("env", "Environment (.env)"),
                        ("systemd", "systemd Unit"),
                        ("desktop", "Desktop Entry"),
                        ("compose", "Docker Compose"),
                        ("dockerfile", "Dockerfile"),
                        ("makefile", "Makefile"),
                        ("nginx", "NGINX"),
                        ("apache", "Apache (.htaccess)"),
                        ("hcl", "HCL / Terraform"),
                        ("ignore", "Ignore File (.gitignore)"),
                        ("requirements", "pip Requirements"),
                        ("cmake", "CMake (no colouring)"),
                        ("htpasswd", "Password File (.htpasswd)"),
                    ],
                ),
                (
                    "Programming",
                    &[
                        ("java", "Java"),
                        ("groovy", "Groovy / Jenkinsfile"),
                        ("c", "C"),
                        ("cpp", "C++"),
                        ("csharp", "C#"),
                    ],
                ),
                ("Certificates and Keys", &[("pem", "Certificate / Key (PEM)")]),
            ];
            let language_submenu = Submenu::with_id(app, "language_submenu", "Language", true)?;
            language_submenu.append(&check("lang_auto", "Auto-detect from File Name", None)?)?;
            language_submenu.append(&PredefinedMenuItem::separator(app)?)?;
            for (id, label) in TEXT_LANGUAGES {
                language_submenu.append(&check(&format!("lang_{id}"), label, None)?)?;
            }
            for (title, langs) in LANGUAGE_GROUPS {
                let group = Submenu::with_items(app, title, true, &[])?;
                for (id, label) in langs {
                    group.append(&check(&format!("lang_{id}"), label, None)?)?;
                }
                language_submenu.append(&group)?;
            }

            let view_submenu = Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &check("toolbar", "Toolbar", Some("CmdOrCtrl+T"))?,
                    &check("sidebar", "Sidebar", Some("CmdOrCtrl+Shift+E"))?,
                    // While it is switched off, Alt shows it until a command is picked.
                    &check("menu_bar", "Menu Bar", None)?,
                    &check("status_bar", "Status Bar", None)?,
                    &check("outline", "Outline", Some("CmdOrCtrl+Shift+O"))?,
                    &check("word_wrap", "Word Wrap", Some("Alt+Z"))?,
                    &check("toggle_line_numbers", "Line Numbers", Some("CmdOrCtrl+Shift+L"))?,
                    &check("show_hidden", "Show Hidden Characters", Some("CmdOrCtrl+Shift+H"))?,
                    &check("follow_file", "Follow File (Tail)", None)?,
                    &PredefinedMenuItem::separator(app)?,
                    // Order (and Ctrl+Alt+1..4): Edit, Preview, Edit/Preview, Preview/Edit.
                    &check("layout_edit_only", "Edit Only", Some("CmdOrCtrl+Alt+1"))?,
                    &check("layout_preview_only", "Preview Only", Some("CmdOrCtrl+Alt+2"))?,
                    &check("layout_edit_left", "Edit Left / Preview Right", Some("CmdOrCtrl+Alt+3"))?,
                    &check("layout_preview_left", "Preview Left / Edit Right", Some("CmdOrCtrl+Alt+4"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &check("preview_markdown", "Preview as Markdown", Some("CmdOrCtrl+Alt+M"))?,
                    &check("preview_bbcode", "Preview as BBCode", Some("CmdOrCtrl+Alt+B"))?,
                    &language_submenu,
                    &PredefinedMenuItem::separator(app)?,
                    &spelling_submenu,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(
                        app,
                        "font_increase",
                        "Increase Font Size\tCtrl++",
                        true,
                        None::<&str>,
                    )?,
                    &MenuItem::with_id(
                        app,
                        "font_decrease",
                        "Decrease Font Size",
                        true,
                        Some("CmdOrCtrl+-"),
                    )?,
                    &MenuItem::with_id(app, "font_reset", "Reset Font Size", true, Some("CmdOrCtrl+0"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &check("toggle_theme", "Dark Theme", Some("CmdOrCtrl+Shift+D"))?,
                ],
            )?;

            let about_submenu = Submenu::with_items(
                app,
                "About",
                true,
                &[&MenuItem::with_id(app, "about", "About notepad.md...", true, None::<&str>)?],
            )?;

            app.manage(MenuChecks(Mutex::new(checks)));
            // File > Edit > View > Search > About
            let menu = Menu::with_items(app, &[&file_submenu, &edit_submenu, &view_submenu, &search_submenu, &about_submenu])?;
            app.set_menu(menu)?;

            // The window starts hidden so the page can restore its saved size/position first and then
            // show it. Safety net: show it anyway after a few seconds if the page never does.
            if let Some(w) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                });
            }

            app.on_menu_event(move |app_handle, event| {
                let id = event.id().0.as_str();
                match id {
                    "exit" => {
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.close();
                        }
                    }
                    _ => {
                        // A menu bar shown with Alt (while switched off) goes away again once used.
                        if app_handle.state::<AppState>().menu_peek.swap(false, Ordering::SeqCst) {
                            if let Some(w) = app_handle.get_webview_window("main") {
                                let _ = w.hide_menu();
                            }
                            let _ = app_handle.emit("menu-peek-ended", ());
                        }
                        let _ = app_handle.emit(&format!("menu-{}", id.replace('_', "-")), ());
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                // First close request: let the page snapshot the session (all tabs, including
                // unsaved edits) and then call cmd_force_close. A watchdog closes the window
                // anyway after a few seconds so a broken page can never block quitting.
                if !state.closing.swap(true, Ordering::SeqCst) {
                    api.prevent_close();
                    state.close_acked.store(false, Ordering::SeqCst);
                    let _ = window.emit("close-requested", ());
                    let w = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(4));
                        let acked = w.state::<AppState>().close_acked.load(Ordering::SeqCst);
                        if !acked {
                            let _ = w.destroy();
                        }
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
