# GitHub Release — v2.0.2

| Field | Value |
|---|---|
| **Tag** | `v2.0.2` |
| **Target** | `main` |
| **Release title** | `notepad.md v2.0.2` |
| **Binary to attach** | `src-tauri\target\release\notepad.md-v2.0.2-win-x64.exe` (4.6 MB) |
| **Set as the latest release** | ✔ |

Everything below the line is the release description.

---

## notepad.md v2.0.2

If you have v1.3.0 or later, open **About → About notepad.md → Check for Updates** to install this one. It reopens with all your tabs.

### New: Translate
Right-click in the editor → **Translate**:
- **Translate to English** translates the selected text, or the whole document when nothing is selected.
- **Choose Language...** does the same into any of 133 languages (type a few letters to find one).

The translation replaces the text in place, keeping line breaks, blank lines and indentation, and **Ctrl+Z** undoes it. The default language ("Translate to ...") can be changed in **Settings → Translate**.

Translate uses **Google Cloud Translation with your own API key**: paste it into Settings → Translate (there is a link there to Google's instructions for getting one). The key is stored encrypted for your Windows account. The text you translate is sent to Google, which charges per character after the first 500,000 each month; notepad.md asks first before sending more than 20,000 characters.

### New: text cursor and selection colours
In **Settings → Editor**:
- **Text cursor**: Line (as before), Block or Underscore.
- **Text cursor colour** and **Selection colour**: pick your own, or **Use theme** to go back to the light/dark theme's colours.

### Fixed
- **An underscore inside a word no longer turns text italic in Markdown.** Typing `test_test1_test2` showed `test1` in italics in the editor; underscores now only mean italic (`_like this_`) or bold (`__like this__`) at the edges of words, as in the preview. Asterisks work as before.
- **The line number margin is narrow again** for Markdown, plain text and logs. An empty space meant for syntax-problem markers was shown even for file types that are never checked.
- **The window no longer grows each time notepad.md starts** when it was last closed on a monitor with a different display scaling (for example 125% on a laptop screen next to a 100% monitor).

The notes for each version are in the [History folder](https://github.com/mccabedd/notepad.md/tree/main/History).

### Download
**[notepad.md-v2.0.2-win-x64.exe](https://github.com/mccabedd/notepad.md/releases/download/v2.0.2/notepad.md-v2.0.2-win-x64.exe)** is portable: download it, save it as `notepad.md.exe` and run it. It needs Windows 10 or 11 (64-bit).

- **SHA-256:** `7E16876C3C22F5D58D525312E55C404208BD27EB420FA3DDA40E60E7D403E220`

### Licence
notepad.md is open source under the [MIT licence](https://github.com/mccabedd/notepad.md/blob/main/LICENSE). Bundled components keep their own licences: see [THIRD_PARTY_NOTICES.md](https://github.com/mccabedd/notepad.md/blob/main/THIRD_PARTY_NOTICES.md).
