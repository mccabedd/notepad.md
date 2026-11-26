/* Turns highlight.js output (HTML with <span class="hljs-...">) into coloured ranges of the plain
 * text, for the CodeMirror editor: { starts, ends, cls (Int32Arrays / Uint16Array), names }.
 * Ranges are listed in the order they open, so they are sorted by start (outer before inner).
 * Used by highlight-worker.js (big files, off the UI thread) and by the page (BBCode). */
function hlHtmlToSpans(html) {
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", nbsp: ' ' };
  const names = [];
  const nameIdx = new Map();
  let cap = 1024;
  let starts = new Int32Array(cap);
  let ends = new Int32Array(cap);
  let cls = new Uint16Array(cap);
  let n = 0;
  const open = []; // indexes of spans still open
  let pos = 0; // offset in the plain text
  const re = /<span class="([^"]*)">|<\/span>|&(#?\w+);|[^<&]+|[<&]/g;
  let m;
  while ((m = re.exec(html))) {
    const t = m[0];
    if (m[1] !== undefined) {
      if (n === cap) {
        cap *= 2;
        const s2 = new Int32Array(cap); s2.set(starts); starts = s2;
        const e2 = new Int32Array(cap); e2.set(ends); ends = e2;
        const c2 = new Uint16Array(cap); c2.set(cls); cls = c2;
      }
      let k = nameIdx.get(m[1]);
      if (k === undefined) {
        k = names.length;
        names.push(m[1]);
        nameIdx.set(m[1], k);
      }
      starts[n] = pos;
      ends[n] = pos;
      cls[n] = k;
      open.push(n++);
    } else if (t === '</span>') {
      const i = open.pop();
      if (i !== undefined) ends[i] = pos;
    } else if (m[2] !== undefined) {
      pos += ENT[m[2]] !== undefined ? 1 : m[2][0] === '#' ? 1 : t.length;
    } else {
      pos += t.length;
    }
  }
  for (const i of open) ends[i] = pos;
  return { starts: starts.slice(0, n), ends: ends.slice(0, n), cls: cls.slice(0, n), names, length: pos };
}
