# Security

## Reporting a problem

If you find a security problem in notepad.md, please report it privately with GitHub's
**Report a vulnerability** button on the repository's **Security** tab, rather than in a public
issue. If that button isn't there, open an issue that only says you have a security report
(no details), and a private way to send it will be arranged.

Only the latest release is updated. As the README says, issues aren't actively monitored, so a
reply can take a while.

## What protects you

- **Documents can't run code.** HTML inside Markdown is cleaned by
  [DOMPurify](https://github.com/cure53/DOMPurify) before the preview shows it, and the app's
  Content Security Policy blocks every inline script as a second barrier. A document's CSS is kept
  inside the preview. HTML exports carry their own policy that blocks all scripts.
- **Links open only in your browser, and only `http`/`https` ones.** A link can't start a program.
- **Saving can't leave a half-written file.** The new text is written to a temporary file next to
  the original, flushed to disk, and then swapped in; if the swap fails part-way, the document is put
  back.
- **Updates come only from this repository's GitHub releases** and are installed only when the
  download matches the SHA-256 GitHub publishes for it. (This checks that the file wasn't damaged or
  swapped on the way; it doesn't prove who published it.)
- **Your settings, sessions and file associations stay on your PC** in `%APPDATA%\com.notepadmd.app`
  and your own registry keys. notepad.md sends nothing anywhere except when you check for updates,
  open a link, or preview a document that contains pictures from the web.

## Known limitations

- The release `.exe` isn't code-signed. Check its SHA-256 against the release notes (see the README).
- Pictures from the web in a previewed document are loaded, so their host can see the document was
  opened.
