# GitHub Release — v1.4.2

| Field | Value |
|---|---|
| **Tag** | `v1.4.2` |
| **Target** | `main` |
| **Release title** | `notepad.md v1.4.2` |
| **Binary to attach** | `src-tauri\target\release\notepad.md-v1.4.2-win-x64.exe` (4.33 MB) |
| **Set as the latest release** | ✔ |

Everything below the line is the release description.

---

## notepad.md v1.4.2

If you have v1.3.0 or later, open **About → About notepad.md → Check for Updates** to install this one. It reopens with all your tabs.

### New on the find bar
- **Clear** empties the Find box.
- **Aa / ab / .\*** (Match case, Whole word, Regular expression) now work on the find bar itself, not only in the Advanced pane. They're the same settings as the Advanced checkboxes.
- **In selection:** select some text in the editor, then click the In selection button. Find and Replace All then work only inside that text, until you click it again.
- **Recent searches:** the **▾** in the Find and Replace boxes lists your last 20 searches and replacements. They're remembered between sessions.
- **Bookmark All** bookmarks every line with a match, in the current bookmark colour.

### Changed
- **Every question and message box** now uses notepad.md's own dialog, which follows the light / dark theme. That includes Reload, Overwrite, Delete File, Clear Bookmarks, File Types, Update available and every error message. Enter picks the highlighted button and Esc cancels. The Open and Save As file pickers are still the Windows ones.
- **The link box in the preview** (the address with Open and Copy) only appears when a link's text hides its address, such as [Microsoft WPF overview](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/overview/). A link that already shows its full address doesn't need it.

The notes for each version are in the [History folder](https://github.com/mccabedd/notepad.md/tree/main/History).

### Download
**[notepad.md-v1.4.2-win-x64.exe](https://github.com/mccabedd/notepad.md/releases/download/v1.4.2/notepad.md-v1.4.2-win-x64.exe)** is portable: download it, save it as `notepad.md.exe` and run it. It needs Windows 10 or 11 (64-bit).

- **SHA-256:** `C9DB38776EE400E5DF3B1F75F7145CC1DC611F225297B5BBDE6F0C09CBED35F4`

### Licence
notepad.md is open source under the [MIT licence](https://github.com/mccabedd/notepad.md/blob/main/LICENSE). Bundled components keep their own licences: see [THIRD_PARTY_NOTICES.md](https://github.com/mccabedd/notepad.md/blob/main/THIRD_PARTY_NOTICES.md).
