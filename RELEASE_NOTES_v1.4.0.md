# GitHub Release — v1.4.0

| Field | Value |
|---|---|
| **Tag** | `v1.4.0` |
| **Target** | `main` |
| **Release title** | `notepad.md v1.4.0` |
| **Binary to attach** | `src-tauri\target\release\notepad.md-v1.4.0-win-x64.exe` (4.33 MB) |
| **Set as the latest release** | ✔ |

Everything below the line is the release description.

---

## notepad.md v1.4.0

If you have v1.3.0, open **About → About notepad.md → Check for Updates** to install this one. It reopens with all your tabs. (From NotePad-MD v1.2.0 or earlier, follow the steps in the [v1.3.0 notes](https://github.com/mccabedd/notepad.md/releases/tag/v1.3.0) once.)

### New
- **Synchronised scrolling** in split view (Settings → General, on by default). Scrolling either side, or moving the caret, brings the other side to the same paragraph, heading, list or table. Markdown is matched block by block, not by percentage.
- **Keeping your place when switching view.** Going between Edit, Preview and split view shows the same part of the document, and the caret moves to the matching words. If you'd just scrolled rather than moved the caret, the part you were looking at stays in view. This works with synchronised scrolling switched off too.
- **Default new tab format** (Settings → General): **Markdown (.md)** or **Plain Text (.txt)**.
  - It applies to the **+** tab, Ctrl+N, File → New and double-clicking the tab bar.
  - Each tab keeps its own format, also after a restart.
  - Save suggests `.md` or `.txt` to match.
- **Links in the preview:** hovering a link shows its full address, with **Open** and **Copy** buttons right beside it.

### Changed
- **Plain Text** tabs (and `.txt` files) show their text exactly as written in Preview, instead of as Markdown, and you can still type there. The formatting buttons are greyed out for Plain Text.

### Fixed
- A URL pasted into the preview now becomes a link straight away. Before, it only became one after a switch to Edit and back.
- Edits made in the preview of a document containing MathML weren't saved to the source. They are now.
- Editing in the preview could quietly rewrite HTML that the preview had to clean (for example an `<img>` with an `onerror`) in your Markdown source. It now stays exactly as you wrote it.

### Safer
- A save never writes straight over the original file. In a folder that doesn't allow new files (a safe save needs a temporary file next to the document), the save is refused, your file stays as it was, and you can use **Save As** instead.
- Text pasted into the preview goes through the same filter as the rest of the preview: no scripts or handlers.
- Updates are only downloaded from a plain release address of this repository (no escaped characters, query strings or extra path parts), still with checksum, size check and automatic rollback.
- **Settings → File Types** asks before taking over file types that are registered to another copy of the app that still exists.

The notes for each version are in the [History folder](https://github.com/mccabedd/notepad.md/tree/main/History).

### Download
**[notepad.md-v1.4.0-win-x64.exe](https://github.com/mccabedd/notepad.md/releases/download/v1.4.0/notepad.md-v1.4.0-win-x64.exe)** is portable: download it, save it as `notepad.md.exe` and run it. It needs Windows 10 or 11 (64-bit).

- **SHA-256:** `3BF5A0D5C198F44A7E6A654A52DE03E1CC3587EEE952DA7EE0971C84AEDA99B6`

### Licence
notepad.md is open source under the [MIT licence](https://github.com/mccabedd/notepad.md/blob/main/LICENSE). Bundled components keep their own licences: see [THIRD_PARTY_NOTICES.md](https://github.com/mccabedd/notepad.md/blob/main/THIRD_PARTY_NOTICES.md).
