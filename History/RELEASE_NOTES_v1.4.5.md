# GitHub Release — v1.4.5

| Field | Value |
|---|---|
| **Tag** | `v1.4.5` |
| **Target** | `main` |
| **Release title** | `notepad.md v1.4.5` |
| **Binary to attach** | `src-tauri\target\release\notepad.md-v1.4.5-win-x64.exe` (4.35 MB) |
| **Set as the latest release** | ✔ |

Everything below the line is the release description.

---

## notepad.md v1.4.5

If you have v1.3.0 or later, open **About → About notepad.md → Check for Updates** to install this one. It reopens with all your tabs.

This release is about safety and reliability rather than new features.

### Safer
- **Saving can no longer lose the file on disk.** In rare cases (for example antivirus holding the file at the wrong moment) Windows can fail half-way through swapping in the saved file. notepad.md now always puts the document back in place: with your new text when possible, otherwise as it was.
- **HTML in documents is cleaned by [DOMPurify](https://github.com/cure53/DOMPurify)**, a widely used, maintained sanitiser, instead of notepad.md's own filter. Editing the preview still keeps any HTML it had to hide (styles, scripts) in your Markdown unchanged.
- **A document's styles stay inside the preview**: they can't draw over the rest of the window.
- **Export as HTML** now includes a security policy that stops any script running when the page is opened in a browser.
- Two libraries used by the Tauri framework (`cookie` and `url`) are updated for published security advisories.

### Faster
- **With line numbers on, files of about 1 MB** type about twice as fast and scroll about twice as smoothly.

### Also
- A new [SECURITY.md](https://github.com/mccabedd/notepad.md/blob/main/SECURITY.md) explains how notepad.md protects you and how to report a problem, and the README now lists known limitations (including very large files) and how to check a download.

The notes for each version are in the [History folder](https://github.com/mccabedd/notepad.md/tree/main/History).

### Download
**[notepad.md-v1.4.5-win-x64.exe](https://github.com/mccabedd/notepad.md/releases/download/v1.4.5/notepad.md-v1.4.5-win-x64.exe)** is portable: download it, save it as `notepad.md.exe` and run it. It needs Windows 10 or 11 (64-bit).

- **SHA-256:** `7B7EB08DA78943514E848E82E8380E54F76B2AC7D1D085312AA67F34689733BD`

### Licence
notepad.md is open source under the [MIT licence](https://github.com/mccabedd/notepad.md/blob/main/LICENSE). Bundled components keep their own licences: see [THIRD_PARTY_NOTICES.md](https://github.com/mccabedd/notepad.md/blob/main/THIRD_PARTY_NOTICES.md).
