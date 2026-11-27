//! Additions to WebView2's own right-click menu in the editor.
//!
//! - Links: links in the editor are plain text to WebView2, so its menu has no link items there.
//!   The page tells us which link the mouse is over, and we put "Open link in new window", "Save
//!   link as" and "Copy link" at the top, exactly like the menu on a link in the preview.
//! - Translate: when the page says the right-click was in the editor, a "Translate" submenu goes at
//!   the end ("Translate to <default language>", "Choose Language..."); the page does the rest.
//!
//! Everything else in the menu stays as is.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2ContextMenuItem, ICoreWebView2ContextMenuItemCollection, ICoreWebView2Environment9, ICoreWebView2_11,
    COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU,
};
use webview2_com::{ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler};
use windows::Win32::System::Com::IStream;
use windows_core::{Interface, BOOL, HSTRING};

/// The link under the mouse in the editor (None when the mouse isn't over one).
pub struct HoverLink(pub Mutex<Option<String>>);

/// The default language's name for "Translate to ...", while the right-click is in the editor
/// (None elsewhere, e.g. in the preview).
pub struct TranslateMenu(pub Mutex<Option<String>>);

#[tauri::command]
pub fn cmd_set_hover_link(state: State<HoverLink>, url: Option<String>) {
    if let Ok(mut l) = state.0.lock() {
        *l = url.filter(|u| u.starts_with("http://") || u.starts_with("https://"));
    }
}

#[tauri::command]
pub fn cmd_set_translate_menu(state: State<TranslateMenu>, label: Option<String>) {
    if let Ok(mut l) = state.0.lock() {
        // A language name for the menu: letters, spaces and a few marks, kept short.
        *l = label.map(|s| s.chars().filter(|c| c.is_alphanumeric() || " ()-'.,".contains(*c)).take(40).collect::<String>()).filter(|s| !s.is_empty());
    }
}

const LINK_ITEMS: [(&str, &str); 3] = [("Open link in new window", "open"), ("Save link as", "save"), ("Copy link", "copy")];

unsafe fn new_item(env: &ICoreWebView2Environment9, label: &str, kind: COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND) -> windows_core::Result<ICoreWebView2ContextMenuItem> {
    unsafe { env.CreateContextMenuItem(&HSTRING::from(label), None::<&IStream>, kind) }
}

/// A command item that sends `event` with `payload` to the page when chosen.
unsafe fn command_item<P: serde::Serialize + Clone + Send + 'static>(
    env: &ICoreWebView2Environment9,
    app: &AppHandle,
    label: &str,
    event: &'static str,
    payload: P,
) -> windows_core::Result<ICoreWebView2ContextMenuItem> {
    let item = unsafe { new_item(env, label, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND)? };
    let app2 = app.clone();
    let mut token = 0i64;
    unsafe {
        item.add_CustomItemSelected(
            &CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                let _ = app2.emit(event, payload.clone());
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(item)
}

unsafe fn append(items: &ICoreWebView2ContextMenuItemCollection, item: &ICoreWebView2ContextMenuItem) -> windows_core::Result<()> {
    let mut n = 0u32;
    unsafe {
        items.Count(&mut n)?;
        items.InsertValueAtIndex(n, item)
    }
}

pub fn install(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let _ = window.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let Ok(core11) = core.cast::<ICoreWebView2_11>() else { return };
        let Ok(env) = wv.environment().cast::<ICoreWebView2Environment9>() else { return };
        let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            let target = args.ContextMenuTarget()?;
            let mut editable = BOOL::default();
            target.IsEditable(&mut editable)?;
            let mut has_link = BOOL::default();
            target.HasLinkUri(&mut has_link)?;
            if !editable.as_bool() {
                return Ok(());
            }
            let items = args.MenuItems()?;

            // Only the editor gets link items: real links (the preview) already have WebView2's own.
            let url = app.state::<HoverLink>().0.lock().ok().and_then(|l| l.clone());
            if let (Some(url), false) = (url, has_link.as_bool()) {
                for (i, (label, action)) in LINK_ITEMS.iter().enumerate() {
                    let item = command_item(&env, &app, label, "link-menu", (action.to_string(), url.clone()))?;
                    items.InsertValueAtIndex(i as u32, &item)?;
                }
                items.InsertValueAtIndex(LINK_ITEMS.len() as u32, &new_item(&env, "", COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR)?)?;
            }

            let lang = app.state::<TranslateMenu>().0.lock().ok().and_then(|l| l.clone());
            if let Some(lang) = lang {
                let sub = new_item(&env, "Translate", COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU)?;
                let children = sub.Children()?;
                append(&children, &command_item(&env, &app, &format!("Translate to {}", lang), "translate-menu", "default")?)?;
                append(&children, &command_item(&env, &app, "Choose Language...", "translate-menu", "choose")?)?;
                append(&items, &new_item(&env, "", COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR)?)?;
                append(&items, &sub)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core11.add_ContextMenuRequested(&handler, &mut token);
    });
}
