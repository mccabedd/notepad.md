# GitHub Release — v2.0.1

| Field | Value |
|---|---|
| **Tag** | `v2.0.1` |
| **Target** | `main` |
| **Release title** | `notepad.md v2.0.1` |
| **Binary to attach** | `src-tauri\target\release\notepad.md-v2.0.1-win-x64.exe` (4.6 MB) |
| **Set as the latest release** | ✔ |

Everything below the line is the release description.

---

## notepad.md v2.0.1

If you have v1.3.0 or later, open **About → About notepad.md → Check for Updates** to install this one. It reopens with all your tabs.

### Less memory with big files
This release is about memory. Nothing looks different, and typing, scrolling and switching tabs are as fast as in v2.0.0.

Measured on one PC with 10 MB logs (memory as Task Manager shows it):

| | v2.0.0 | v2.0.1 |
|---|---|---|
| A 10 MB log, once it has settled | 236 MB | **195 MB** |
| Switching quickly between big tabs | up to 1.3 GB | **under 0.4 GB** |
| After closing big tabs | 345 MB | **222 MB** |
| Opening and closing a saved 10 MB file ten times | 903 MB | **446 MB** |

- **Switching back to a big tab no longer colours the whole file again** when it hasn't changed: its colours are kept (for up to three big tabs) and appear straight away.
- **Colouring no longer piles up.** If you type or switch tabs faster than a big file can be coloured, only the newest version is coloured; requests that are already out of date are skipped.
- **A closed file no longer stays in memory.** The first big file coloured in a session used to stay in memory until the window was closed; that is fixed, and the background colouring keeps less of its last file.

### Reopen Closed Tab (Ctrl+Shift+T)
- A closed tab of a **saved file with no unsaved changes** is now reopened from the disk rather than from a copy kept in memory. If the file has changed since you closed it, it opens as it is now and the status bar says so; if it has been moved or deleted, a message says it can't be reopened.
- Tabs with **unsaved text** (untitled tabs, or files you closed without saving their changes) come back with their text, as before.

Typing in a very big log still uses a lot of memory for a moment each time the file is coloured again after a pause; that is the next thing to improve.

The notes for each version are in the [History folder](https://github.com/mccabedd/notepad.md/tree/main/History).

### Download
**[notepad.md-v2.0.1-win-x64.exe](https://github.com/mccabedd/notepad.md/releases/download/v2.0.1/notepad.md-v2.0.1-win-x64.exe)** is portable: download it, save it as `notepad.md.exe` and run it. It needs Windows 10 or 11 (64-bit).

- **SHA-256:** `F4375F1588E4711F2D0EC55E6108B978EBF7A3D7312930E440D70A5BF0662F22`

### Licence
notepad.md is open source under the [MIT licence](https://github.com/mccabedd/notepad.md/blob/main/LICENSE). Bundled components keep their own licences: see [THIRD_PARTY_NOTICES.md](https://github.com/mccabedd/notepad.md/blob/main/THIRD_PARTY_NOTICES.md).
