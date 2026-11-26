/* Colours big files off the main thread, so the window never freezes while a multi-megabyte log is
 * coloured. Replies with html = null for a language it doesn't know (the page then colours it itself).
 * With `spans: true` (the CodeMirror editor) it replies with coloured ranges instead of HTML. */
importScripts('vendor/highlight/highlight.min.js', 'vendor/highlight/powershell.min.js', 'vendor/highlight/dos.min.js', 'log-grammar.js', 'config-grammars.js', 'hl-spans.js');
registerLogLanguage();
registerConfigLanguages();

self.onmessage = (e) => {
  const { id, text, lang, spans } = e.data;
  let html = null;
  try {
    if (hljs.getLanguage(lang)) html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch (err) {
    html = null;
  }
  if (spans) {
    const s = html === null ? null : hlHtmlToSpans(html);
    self.postMessage({ id, spans: s }, s ? [s.starts.buffer, s.ends.buffer, s.cls.buffer] : []);
  } else {
    self.postMessage({ id, html });
  }
};
