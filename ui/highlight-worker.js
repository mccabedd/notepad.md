/* Colours big files off the main thread, so the window never freezes while a multi-megabyte log is
 * coloured. Replies with html = null for a language it doesn't know (the page then colours it itself).
 * With `spans: true` (the CodeMirror editor) it replies with coloured ranges instead of HTML.
 * Every job gets exactly one reply (null when anything went wrong), so the page never waits forever. */
importScripts('vendor/highlight/highlight.min.js', 'vendor/highlight/powershell.min.js', 'vendor/highlight/dos.min.js', 'log-grammar.js', 'config-grammars.js', 'hl-spans.js');
registerLogLanguage();
registerConfigLanguages();

self.onmessage = (e) => {
  const { id, text, lang, spans } = e.data;
  try {
    let html = null;
    try {
      if (hljs.getLanguage(lang)) html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch (err) {
      html = null;
    }
    if (spans) {
      let s = null;
      try {
        s = html === null ? null : hlHtmlToSpans(html);
      } catch (err) {
        s = null;
      }
      html = null;
      self.postMessage({ id, spans: s }, s ? [s.starts.buffer, s.ends.buffer, s.cls.buffer] : []);
    } else {
      self.postMessage({ id, html });
    }
  } catch (err) {
    self.postMessage(spans ? { id, spans: null } : { id, html: null }); // never leave the page waiting
  } finally {
    // V8 remembers the input of the last successful regular-expression match (for RegExp.lastMatch
    // and friends): after a job that is the whole file or its coloured HTML, tens of MB kept until
    // the next job. A match on an empty string replaces it. Once per job, after all matching is done.
    /^/.exec('');
  }
};
