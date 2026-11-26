/* PROTOTYPE (codemirror-prototype branch): a bare CodeMirror 6 editor in the app's own WebView2,
 * used to measure large-file editing before integrating it into notepad.md. Opened only by the
 * benchmark (cm-proto.html), never by the app. */
import { EditorState, Compartment } from './vendor/codemirror/codemirror-state.js';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars } from './vendor/codemirror/codemirror-view.js';
import { defaultKeymap, history, historyKeymap } from './vendor/codemirror/codemirror-commands.js';
import { search, searchKeymap, highlightSelectionMatches, SearchCursor } from './vendor/codemirror/codemirror-search.js';

const wrap = new Compartment();
const gutter = new Compartment();

const theme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '14px', backgroundColor: '#1e1e1e', color: '#e0e0e0' },
    '.cm-scroller': { fontFamily: 'Consolas, "Cascadia Code", monospace', lineHeight: '1.5' },
    '.cm-content': { caretColor: '#6db1ff' },
    '.cm-cursor': { borderLeftColor: '#6db1ff' },
    '.cm-gutters': { backgroundColor: '#252526', color: '#9a9a9a', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-searchMatch': { backgroundColor: 'rgba(255, 200, 0, 0.35)' },
  },
  { dark: true }
);

function makeState(text, { wrapOn = true, numbers = false } = {}) {
  return EditorState.create({
    doc: text,
    extensions: [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: false }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      wrap.of(wrapOn ? EditorView.lineWrapping : []),
      gutter.of(numbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && window.cmProto.onChange) window.cmProto.onChange(u);
      }),
    ],
  });
}

const view = new EditorView({ state: makeState(''), parent: document.getElementById('cm-host') });

window.cmProto = {
  view,
  onChange: null,
  /** Reads a file through the app's own command (same as notepad.md), with Windows line ends made \n. */
  async open(path, opts = {}) {
    const data = await window.__TAURI__.core.invoke('cmd_read_file', { path });
    const text = data.content.replace(/\r\n?/g, '\n');
    view.setState(makeState(text, opts));
    return text.length;
  },
  setWrap(on) {
    view.dispatch({ effects: wrap.reconfigure(on ? EditorView.lineWrapping : []) });
  },
  setNumbers(on) {
    view.dispatch({ effects: gutter.reconfigure(on ? [lineNumbers(), highlightActiveLineGutter()] : []) });
  },
  goToLine(n) {
    const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    view.focus();
  },
  countMatches(term) {
    let n = 0;
    const c = new SearchCursor(view.state.doc, term);
    while (!c.next().done) n++;
    return n;
  },
  text() {
    return view.state.doc.toString();
  },
};
document.title = 'CodeMirror prototype';
window.cmProtoReady = true;
