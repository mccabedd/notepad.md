# GitHub Release — v2.0.0

| Field | Value |
|---|---|
| **Tag** | `v2.0.0` |
| **Target** | `main` |
| **Release title** | `notepad.md v2.0.0` |
| **Binary to attach** | `src-tauri\target\release\notepad.md-v2.0.0-win-x64.exe` (4.6 MB) |
| **Set as the latest release** | ✔ |

Everything below the line is the release description.

---

## notepad.md v2.0.0

If you have v1.3.0 or later, open **About → About notepad.md → Check for Updates** to install this one. It reopens with all your tabs.

### A new editor: big files are now fast
The text editor is now built on [CodeMirror 6](https://codemirror.net), which only lays out and draws the lines you can see. Everything you used before is still there and works the same way: colours, find highlights, bookmarks, line numbers, spelling, links, syntax problems, hidden characters, the synchronised preview.

What changes is the speed with big files. Measured on one PC with a 10 MB log:

| | v1.4.5 | v2.0.0 |
|---|---|---|
| A typed key appears after | about 0.3 s | **about 0.02 s** |
| Scrolling | 18 frames a second | **60 frames a second** |
| Go to Line | 0.14 s | **0.015 s** |
| Switching back to its tab | 1.1–1.5 s | **0.02 s** |
| Word wrap on / off | 1.1 s | **0.02 s** |
| Opening it | 1.3 s | **0.4 s** |

With a 25 MB log, typing went from about 0.8 s per key to about 0.02 s, and memory use from about 5 GB to under 1 GB. Find in a 1 MB log went from about 0.7 s to under 0.01 s.

### Also new
- **Bigger files get colours, find highlights and spell checking.** Colours now cover files up to 16 MB; find matches and bookmarked lines are highlighted at any size; Plain Text and Markdown are spell-checked at any size (only the lines on screen are checked).
- **Settings > Spelling > Spell-check log files** (off by default: log files are mostly written by programs).

### Fixed
- **A very large document no longer freezes the window when its preview is shown.** Turning a 25 MB log into Markdown with the preview open took about half a minute and could crash the Markdown converter. The preview of a document over 4 MB now shows its first 4 MB, read-only, with a note saying so; the editor always has the whole file.
- A BBCode tag right before a word no longer hides that word from the spell checker.

### If something doesn't feel right
The previous editor is still built in. To use it, start notepad.md with the environment variable `NOTEPADMD_EDITOR` set to `textarea` (for example from a shortcut: `cmd /c "set NOTEPADMD_EDITOR=textarea&& start notepad.md.exe"`). Please report anything that behaves differently from v1.4.5.

The notes for each version are in the [History folder](https://github.com/mccabedd/notepad.md/tree/main/History).

### Download
**[notepad.md-v2.0.0-win-x64.exe](https://github.com/mccabedd/notepad.md/releases/download/v2.0.0/notepad.md-v2.0.0-win-x64.exe)** is portable: download it, save it as `notepad.md.exe` and run it. It needs Windows 10 or 11 (64-bit).

- **SHA-256:** `B6600EB00CFE015ECB9767B05E054136CA01BC8756F3B9EE1BE32C78D892E38A`

### Licence
notepad.md is open source under the [MIT licence](https://github.com/mccabedd/notepad.md/blob/main/LICENSE). Bundled components keep their own licences: see [THIRD_PARTY_NOTICES.md](https://github.com/mccabedd/notepad.md/blob/main/THIRD_PARTY_NOTICES.md).
