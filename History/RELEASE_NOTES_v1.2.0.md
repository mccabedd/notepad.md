# GitHub Release — v1.2.0

| Field | Value |
|---|---|
| **Tag** | `v1.2.0` |
| **Target** | `main` |
| **Release title** | `NotePad-MD v1.2.0` |
| **Binary to attach** | `src-tauri\target\release\NotePad-MD-v1.2.0-win-x64.exe` (4.31 MB) |
| **Set as the latest release** | ✔ |

Everything below the line is the release description.

---

## NotePad-MD v1.2.0

If you have an earlier version, open **About → About NotePad-MD → Check for Updates** to install this one. It reopens with all your tabs.

### Syntax validation (new)
NotePad-MD now spots malformed files before you save or deploy them. Files are only read, never run.
- **Full syntax check:** JSON (also JSON with Comments, JSON5, JSON Lines), YAML, TOML, XML and JavaScript.
- **File format check:**
  - **Docker Compose:** unknown settings, ports, volumes, `restart`, and services, networks or volumes that aren't defined;
  - **Dockerfile:** unknown instructions, FROM first, the exec form;
  - **.env:** trailing spaces in a value, invisible characters, CRLF line endings, spaces around `=`;
  - **systemd units, INI and desktop entries.**
- **Structure check** (brackets, quotes and blocks; not a full syntax check): Python (also indentation), shell scripts, PowerShell, CSS, NGINX (including the missing `;`), HCL / Terraform and Apache `.htaccess`.
- **How problems are shown:**
  - a red or amber marker beside the line number, next to any bookmark;
  - a wavy underline, and a count in the status bar;
  - point at a problem for an explanation, e.g. *Line 6, Column 6 — YAML syntax error*;
  - **F8 / Shift+F8** go to the next / previous problem, and **Search → Check Syntax Now** checks the file straight away.
- **Suggested fixes** for clear-cut cases, such as a missing comma, a misspelt Dockerfile instruction or a trailing space in a `.env` value. Nothing changes until you click **Apply fix**, and Undo takes it back.
- Choose what is checked in **Settings → Syntax Validation**. Languages without a check say *No syntax check* in the status bar.

### More file types
- New file types:
  - shell scripts (`.sh`, `.bash`, `.zsh`, `.ksh`, `.fish`), Perl, Ruby, AWK, sed and SQL;
  - JSON Lines, diff / patch, `.env`, systemd units, `.desktop`, `.editorconfig`;
  - HCL / Terraform;
  - certificates and keys (`.pem`, `.crt`, `.cer`, `.csr`, `.pub`, `.asc`, shown as text and never imported).
- Files recognised by name:
  - `Dockerfile` (and `Dockerfile.*`), `Makefile`, `Jenkinsfile`, `Vagrantfile`, `Gemfile`, `Pipfile`;
  - `.env` (and `.env.*`), `.bashrc`, `.gitignore`, `.htaccess`;
  - `requirements.txt`, `CMakeLists.txt`;
  - `compose.yaml` / `docker-compose.yml` (and their `.*.yaml` variants), and NGINX configs.
- **View → Language** is grouped: Web and Data, Scripts, Configuration, Programming, Certificates and Keys.
- `.log` files now open as Log File.

### Settings
- Settings has three pages: **General**, **File Types** and **Syntax Validation**.
- **File Types:**
  - one box per extension, in three columns that fill down each column, with **All / None** at the top;
  - ticking a box adds NotePad-MD to that type's **Open with** list straight away;
  - the boxes always show what Windows really has;
  - your default apps never change: `.bat`, `.cmd` and `.ps1` still run as before.

### BBCode
- The BBCode preview can now be typed into; what you type is written back as BBCode. Switching to Preview puts the caret there, ready to type.
- On BBCode tabs the toolbar writes BBCode tags (`[b]`, `[i]`, `[u]`, `[s]`, `[h1]`–`[h3]`, `[list]`, `[table]`, `[code]`, `[img]`, `[indent]`), and its tooltips show them.

### Also in v1.1.2
If you're updating from v1.1.1 or earlier, this version also includes:
- the bookmark margin;
- the **Search → Bookmark** menu;
- **View → Show Hidden Characters** (`Ctrl+Shift+H`);
- Advanced Find's Wildcard option and double-click copy;
- the menu bar shown with Alt.

The notes for each version are in the [History folder](https://github.com/mccabedd/notepad-md/tree/main/History).

### Download
**[NotePad-MD-v1.2.0-win-x64.exe](https://github.com/mccabedd/notepad-md/releases/download/v1.2.0/NotePad-MD-v1.2.0-win-x64.exe)** is portable, so just download it and run it. It needs Windows 10 or 11 (64-bit).

- **SHA-256:** `A51F2BA1CE893B9DE260B2DD26856AC1668C2289FB7616F4C1558C0CD4642B53`

### Licence
NotePad-MD is open source under the [MIT licence](https://github.com/mccabedd/notepad-md/blob/main/LICENSE). Bundled components keep their own licences (now including js-yaml, smol-toml and acorn): see [THIRD_PARTY_NOTICES.md](https://github.com/mccabedd/notepad-md/blob/main/THIRD_PARTY_NOTICES.md).
