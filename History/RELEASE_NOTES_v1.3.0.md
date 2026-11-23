# GitHub Release — v1.3.0

| Field | Value |
|---|---|
| **Tag** | `v1.3.0` |
| **Target** | `main` |
| **Release title** | `notepad.md v1.3.0` |
| **Binary to attach** | `src-tauri\target\release\notepad.md-v1.3.0-win-x64.exe` (4.32 MB) |
| **Set as the latest release** | ✔ |

Everything below the line is the release description.

---

## notepad.md v1.3.0

**NotePad-MD is now called notepad.md.** The app, its exe (`notepad.md.exe`) and this repository (now [mccabedd/notepad.md](https://github.com/mccabedd/notepad.md)) have a new name, so that it can't be confused with another project of the same name. Nothing else about the app changes.

### Moving from NotePad-MD v1.2.0 or earlier
The update check in NotePad-MD can't install the renamed app, so replace the exe once by hand:
1. Close NotePad-MD (**File → Exit**) and make sure it has stopped (no `notepad-md` in Task Manager).
2. Back up the folder `%APPDATA%\com.notepadmd.app`, which holds your tabs, unsaved text and settings. notepad.md keeps using this same folder.
3. Download `notepad.md-v1.3.0-win-x64.exe` and save it as `notepad.md.exe` where you keep the app. Keep the old exe for now (for example renamed to `notepad-md.exe.bak`). Don't run the old and new apps at the same time.
4. Start `notepad.md.exe`. Your tabs, unsaved text, bookmarks and settings are all there.
5. Open **Settings → File Types**. If it says the file types open another copy, click **Use this copy**. *Open with* and the *Edit in notepad.md* Explorer item then open the new exe, and entries left by copies that no longer exist are removed. Your default apps are not changed.
6. When everything works, delete the old exe, and click **Use this copy** again if it is offered.

**To go back:** close notepad.md, start the old exe, and click **Use this copy** in its Settings. Your tabs and settings are shared, so nothing else needs restoring.

### Changed
- The new name appears everywhere:
  - the window and the About box;
  - Settings, menus and messages;
  - Explorer's *Open with* list and the **Edit in notepad.md** right-click item;
  - the program's file details.
- **Settings → File Types** has a **Use this copy** button for after you move or replace the exe.
- Updates now come from [github.com/mccabedd/notepad.md](https://github.com/mccabedd/notepad.md/releases), with the same checks as before: SHA-256 checksum, size and automatic rollback. Future updates keep the name `notepad.md.exe`.
- Settings exported from NotePad-MD still import.

The notes for each version are in the [History folder](https://github.com/mccabedd/notepad.md/tree/main/History).

### Download
**[notepad.md-v1.3.0-win-x64.exe](https://github.com/mccabedd/notepad.md/releases/download/v1.3.0/notepad.md-v1.3.0-win-x64.exe)** is portable: download it, save it as `notepad.md.exe` and run it. It needs Windows 10 or 11 (64-bit).

- **SHA-256:** `18C4684017B59A16D19AF6296D27AA1DDB2B09C482378BC440051D3F37F060F4`

### Licence
notepad.md is open source under the [MIT licence](https://github.com/mccabedd/notepad.md/blob/main/LICENSE). Bundled components keep their own licences: see [THIRD_PARTY_NOTICES.md](https://github.com/mccabedd/notepad.md/blob/main/THIRD_PARTY_NOTICES.md).
