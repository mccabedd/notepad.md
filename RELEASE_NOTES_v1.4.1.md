# GitHub Release — v1.4.1

| Field | Value |
|---|---|
| **Tag** | `v1.4.1` |
| **Target** | `main` |
| **Release title** | `notepad.md v1.4.1` |
| **Binary to attach** | `src-tauri\target\release\notepad.md-v1.4.1-win-x64.exe` (4.33 MB) |
| **Set as the latest release** | ✔ |

Everything below the line is the release description.

---

## notepad.md v1.4.1

If you have v1.3.0 or later, open **About → About notepad.md → Check for Updates** to install this one. It reopens with all your tabs.

### Fixed
- **Line numbers in very large files with word wrap on.** In files too big to be coloured (over 4 MB, such as a 10 MB log), each wrapped screen row got its own number, so the numbers ran ahead of the real lines (for example 4179 for line 3514). Each line now gets exactly one number, beside it. Find, bookmarks and Go to Line also land on the right line in those files.

### Changed
- **Links in the preview** are a brighter blue (`#4ea1ff`) in dark mode, so they stand out against the background.
- **Visited links** (opened from notepad.md) turn purple: `#a78ae1` in dark mode, a darker purple in light mode. They're remembered between sessions; **File → Recent Files → Clear Recent Files** forgets them too.
- **Bookmark colours** are lighter, so the text on a bookmarked line is easier to read.
- **Save prompt:** closing a tab with unsaved changes (or closing the app with *reopen my tabs* turned off) now asks **Yes / No / Cancel**. Yes saves, No closes without saving, and Cancel (or Esc) keeps it open. Enter means Yes.

### New
- **Shift+click in the bookmark margin:** click beside one line, then Shift+click beside another, and every line in between gets the same thing. They're all bookmarked in the current colour, or all have their bookmarks removed if the first click removed one.

The notes for each version are in the [History folder](https://github.com/mccabedd/notepad.md/tree/main/History).

### Download
**[notepad.md-v1.4.1-win-x64.exe](https://github.com/mccabedd/notepad.md/releases/download/v1.4.1/notepad.md-v1.4.1-win-x64.exe)** is portable: download it, save it as `notepad.md.exe` and run it. It needs Windows 10 or 11 (64-bit).

- **SHA-256:** `2C2662EF8EC5DE07E67D4A2088B5E166A2A6FC98FA5BF56414795FD695863500`

### Licence
notepad.md is open source under the [MIT licence](https://github.com/mccabedd/notepad.md/blob/main/LICENSE). Bundled components keep their own licences: see [THIRD_PARTY_NOTICES.md](https://github.com/mccabedd/notepad.md/blob/main/THIRD_PARTY_NOTICES.md).
