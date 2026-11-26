/* The CodeMirror 6 editor behind window.npEditor (see ui/editor-facade.js). Only the lines in view
 * are laid out and drawn, so typing, scrolling and jumping stay quick in big files. */
import { EditorState, Compartment, Annotation, Transaction, StateEffect, ChangeSet, RangeSet } from './vendor/codemirror/codemirror-state.js';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, highlightSpecialChars, placeholder,
  ViewPlugin, Decoration, gutter, GutterMarker, WidgetType,
} from './vendor/codemirror/codemirror-view.js';
import { standardKeymap, history, historyKeymap, undo, redo, insertNewline } from './vendor/codemirror/codemirror-commands.js';

const facade = window.npEditor;
if (facade && facade.isCodeMirror) {
  // Changes the app makes itself (loading, value =, selections) are not typing: no 'input' event.
  const appChange = Annotation.define();
  const wrapC = new Compartment();
  const gutterC = new Compartment();
  const placeholderC = new Compartment();
  const tabC = new Compartment();
  let wrapOn = true;
  let numbersOn = false;
  let placeholderText = '';
  let api = null;

  // Colours and fonts come from the same CSS variables as the old editor (Settings > Editor).
  const theme = EditorView.theme({
    '&': { height: '100%', backgroundColor: 'var(--edit-bg, var(--bg))', color: 'var(--edit-fg, var(--fg))' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--edit-font-family, Consolas, "Cascadia Code", Menlo, monospace)',
      fontSize: 'var(--content-font-size)',
      fontWeight: 'var(--edit-font-weight, 400)',
      fontStyle: 'var(--edit-font-style, normal)',
      lineHeight: '1.5',
      overflow: 'auto',
    },
    '.cm-content': { padding: '14px 0', caretColor: 'var(--caret, var(--accent))', tabSize: 'var(--tab-size, 4)' },
    '.cm-line': { padding: '0 16px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--caret, var(--accent))', borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--selection) !important',
    },
    '.cm-gutters': { backgroundColor: 'var(--bg-alt)', color: 'var(--fg-muted)', borderRight: '1px solid var(--border)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 8px' },
    '.cm-activeLineGutter': { color: 'var(--fg)', backgroundColor: 'transparent' },
    '.cm-placeholder': { color: 'var(--fg-muted)' },
  });

  // `settings` is the app's global (a top-level `let` in settings.js, visible to modules too).
  const tabSize = () => (typeof settings !== 'undefined' && settings.tabSize) || 4;

  /* ---------- colours: the app's highlight.js grammars, as ranges (hl-spans.js) ----------
   * Worked out in the worker for the whole text after a pause in typing; until the new result
   * arrives the previous one is kept in step with the edits. Only ranges in view become marks. */
  const COLOUR_MAX_CHARS = 16 * 1024 * 1024;
  const SMALL = 300000; // coloured at once on the main thread; bigger files in the worker
  const refreshColours = StateEffect.define();
  let colourLang = null; // highlight.js language of this tab, or null
  const markCache = new Map();
  const markFor = (name) => {
    let m = markCache.get(name);
    if (!m) markCache.set(name, (m = Decoration.mark({ class: name })));
    return m;
  };
  const colourPlugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.spans = null; // { starts, ends, cls, names, pmax }
        this.since = ChangeSet.empty(view.state.doc.length).desc; // edits since those ranges were made
        this.pending = null; // { id, since }
        this.seq = 0;
        this.timer = 0;
        this.decorations = Decoration.none;
        this.request(view, true);
        this.decorations = this.build(view);
      }
      update(u) {
        if (u.docChanged) {
          if (this.spans) this.since = this.since.composeDesc(u.changes.desc);
          if (this.pending) this.pending.since = this.pending.since.composeDesc(u.changes.desc);
          this.schedule(u.view);
        }
        const asked = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshColours)));
        if (asked && !this.pending && this.spansLang !== colourLang) this.request(u.view, true);
        if (u.docChanged || u.viewportChanged || asked) this.decorations = this.build(u.view);
      }
      schedule(view) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.request(view, false), view.state.doc.length < SMALL ? 60 : 700);
      }
      /** Works out the colours again. Small files right here (as the old editor did, so a file
       *  never appears uncoloured); bigger ones in the worker. `inUpdate`: called while the view is
       *  updating (no dispatch allowed then; the caller rebuilds the marks). */
      request(view, inUpdate) {
        clearTimeout(this.timer);
        const lang = colourLang;
        if (!lang || view.state.doc.length > COLOUR_MAX_CHARS || typeof npHighlightSpans !== 'function') {
          this.spans = null;
          this.spansLang = lang;
          this.pending = null;
          return;
        }
        if (view.state.doc.length < SMALL && typeof npHighlightSpansNow === 'function') {
          const s = npHighlightSpansNow(api ? api.text() : view.state.doc.toString(), lang);
          if (s !== undefined) {
            this.setSpans(s, lang, ChangeSet.empty(view.state.doc.length).desc);
            this.pending = null;
            if (!inUpdate) view.dispatch({ effects: refreshColours.of(null) });
            return;
          }
        }
        const id = ++this.seq;
        this.pending = { id, since: ChangeSet.empty(view.state.doc.length).desc };
        npHighlightSpans(api ? api.text() : view.state.doc.toString(), lang).then((s) => {
          if (!this.pending || this.pending.id !== id) return; // a newer request is on its way
          this.setSpans(s, lang, this.pending.since);
          this.pending = null;
          view.dispatch({ effects: refreshColours.of(null) });
        });
      }
      setSpans(s, lang, since) {
        if (s) {
          const pmax = new Int32Array(s.ends.length);
          let mx = 0;
          for (let i = 0; i < s.ends.length; i++) pmax[i] = mx = Math.max(mx, s.ends[i]);
          s.pmax = pmax;
        }
        this.spans = s;
        this.spansLang = lang;
        this.since = since;
      }
      build(view) {
        const s = this.spans;
        if (!s || !s.starts.length) return Decoration.none;
        const back = this.since.invertedDesc;
        const out = [];
        for (const { from, to } of view.visibleRanges) {
          const oFrom = back.mapPos(from, -1);
          const oTo = back.mapPos(to, 1);
          // First range that may reach oFrom (pmax: the furthest end so far).
          let lo = 0;
          let hi = s.pmax.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (s.pmax[mid] > oFrom) hi = mid;
            else lo = mid + 1;
          }
          for (let i = lo; i < s.starts.length && s.starts[i] < oTo; i++) {
            if (s.ends[i] <= oFrom) continue;
            const a = Math.max(from, this.since.mapPos(s.starts[i], 1));
            const b = Math.min(to, this.since.mapPos(s.ends[i], -1));
            if (b > a) out.push(markFor(s.names[s.cls[i]]).range(a, b));
          }
        }
        return Decoration.set(out, true);
      }
      destroy() {
        clearTimeout(this.timer);
        this.pending = null;
      }
    },
    { decorations: (p) => p.decorations }
  );

  /* ---------- the app's marks: find hits, bookmarked lines, Go to Line, syntax problems ----------
   * The app lists them for the whole text (editorDecorations in find.js); only those in view are
   * drawn. Rebuilt when the app asks (it does whenever they change); in between they move with edits. */
  const refreshMarks = StateEffect.define();
  const LINE_CLASS = /^(bm-line|nav-line)\b/;
  const lineDecoCache = new Map();
  const lineDeco = (cls) => {
    let d = lineDecoCache.get(cls);
    if (!d) lineDecoCache.set(cls, (d = Decoration.line({ class: cls })));
    return d;
  };
  const marksPlugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view) || Decoration.none;
      }
      update(u) {
        const asked = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshMarks)));
        if (asked || (u.viewportChanged && !u.docChanged)) {
          const d = this.build(u.view);
          if (d) {
            this.decorations = d;
            return;
          }
        }
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
      }
      build(view) {
        const lists = typeof npAppDecorations === 'function' ? npAppDecorations() : [];
        if (!lists) return null; // the app's text isn't this text yet: keep the old ones, moved
        const doc = view.state.doc;
        const len = doc.length;
        const ranges = view.visibleRanges;
        const visible = (a, b) => ranges.some((r) => a <= r.to && b >= r.from);
        const out = [];
        for (const list of lists) {
          for (const d of list) {
            const s = Math.min(d.s, len);
            const e = Math.min(d.e, len);
            if (!visible(s, e)) continue;
            if (LINE_CLASS.test(d.cls)) out.push(lineDeco(d.cls).range(doc.lineAt(s).from));
            else if (e > s) out.push(markFor(d.cls).range(s, e));
          }
        }
        return Decoration.set(out, true);
      }
    },
    { decorations: (p) => p.decorations }
  );

  /* ---------- per-line marks: links, indent guides, hidden characters, spelling ----------
   * Worked out for the lines in view only, with the app's own rules (urlRanges, HC_RE, forEachWord,
   * isMisspelled...), whenever the text, the view or the app's marks change. */
  class EolWidget extends WidgetType {
    constructor(kind, text) {
      super();
      this.kind = kind;
      this.text = text;
    }
    eq(o) {
      return o.kind === this.kind && o.text === this.text;
    }
    toDOM() {
      const el = document.createElement('span');
      el.className = this.kind;
      if (this.kind === 'hc-eol') el.dataset.e = this.text;
      return el;
    }
    ignoreEvent() {
      return false;
    }
  }
  const eolWidgets = {};
  const eolWidget = (kind, text) => eolWidgets[kind + text] || (eolWidgets[kind + text] = new EolWidget(kind, text));
  const textPlugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }
      update(u) {
        const asked = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshMarks) || e.is(refreshColours)));
        if (u.docChanged || u.viewportChanged || asked) this.decorations = this.build(u.view);
      }
      build(view) {
        const want = typeof npTextMarks === 'function' ? npTextMarks() : null;
        if (!want) return Decoration.none;
        const doc = view.state.doc;
        const colours = view.plugin(colourPlugin);
        const isCode = (a, b) => {
          let code = false;
          if (colours)
            colours.decorations.between(a, b, (f, t, d) => {
              // (between() also reports ranges that only touch the word, e.g. a tag ending right before it)
              if (f < b && t > a && SPELL_SKIP_EDITOR.test(d.spec.class)) {
                code = true;
                return false;
              }
            });
          return code;
        };
        const tw = tabSize();
        const out = [];
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const line = doc.lineAt(pos);
            const t = line.text;
            const base = line.from;
            if (want.links && t.length < 20000) {
              for (const r of urlRanges(t)) out.push(Decoration.mark({ class: 'ov-url', attributes: { 'data-url': r.url } }).range(base + r.s, base + r.e));
            }
            if (want.indent) {
              // A faint guide at each indent step of the leading spaces/tabs (as the old layer).
              const lead = /^[ \t]+/.exec(t);
              if (lead) {
                let col = 0;
                let unitStart = 0;
                for (let i = 0; i < lead[0].length; i++) {
                  col = lead[0][i] === '\t' ? (Math.floor(col / tw) + 1) * tw : col + 1;
                  if (col % tw === 0) {
                    out.push(markFor('ig').range(base + unitStart, base + i + 1));
                    unitStart = i + 1;
                  }
                }
              }
            }
            if (want.hidden) {
              if (base === 0 && want.hidden.bom) out.push(Decoration.widget({ widget: eolWidget('hc-bom', ''), side: -1 }).range(0));
              HC_RE.lastIndex = 0;
              let m;
              while ((m = HC_RE.exec(t))) {
                const a = base + m.index;
                const b = a + m[0].length;
                if (m[1]) out.push(markFor('hc-sp').range(a, b));
                else if (m[2]) out.push(markFor('hc-tab').range(a, b));
                else out.push(Decoration.mark({ class: m[3] ? 'hc-nb' : 'hc-zw', attributes: { 'data-c': hcCode(m[0]) } }).range(a, b));
              }
              const trail = /[ \t]+$/.exec(t);
              if (trail) out.push(markFor('hc-trail').range(base + trail.index, line.to));
              if (line.to < doc.length) out.push(Decoration.widget({ widget: eolWidget('hc-eol', want.hidden.eol === 'crlf' ? 'CRLF' : 'LF'), side: 1 }).range(line.to));
            }
            if (want.spell && t.length < 20000) {
              forEachWord(t, (w) => {
                const a = base + w.index;
                const b = a + w[0].length;
                if (!isCode(a, b) && isMisspelled(w[0])) out.push(Decoration.mark({ class: 'spell-err', attributes: { 'data-w': w[0] } }).range(a, b));
              });
            }
            pos = line.to + 1;
          }
        }
        return Decoration.set(out, true);
      }
    },
    { decorations: (p) => p.decorations }
  );

  /* ---------- the syntax-problem margin, left of the line numbers ---------- */
  class DiagMarker extends GutterMarker {
    constructor(level) {
      super();
      this.level = level;
    }
    eq(o) {
      return o.level === this.level;
    }
    toDOM() {
      const el = document.createElement('span');
      el.className = 'np-d ' + this.level;
      el.setAttribute('aria-label', this.level);
      return el;
    }
  }
  const diagMarkers = {};
  const diagGutter = gutter({
    class: 'cm-np-diag',
    markers(view) {
      const lines = typeof npDiagLines === 'function' ? npDiagLines() : null;
      if (!lines || !lines.size) return RangeSet.empty;
      const doc = view.state.doc;
      const out = [];
      for (const [line, level] of lines) {
        if (line >= doc.lines) continue;
        out.push((diagMarkers[level] || (diagMarkers[level] = new DiagMarker(level))).range(doc.line(line + 1).from));
      }
      return RangeSet.of(out, true);
    },
    lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshMarks))),
  });

  /* ---------- the bookmark margin, right of the line numbers ---------- */
  class BookmarkMarker extends GutterMarker {
    constructor(colour) {
      super();
      this.colour = colour;
    }
    eq(o) {
      return o.colour === this.colour;
    }
    toDOM() {
      const el = document.createElement('span');
      el.className = 'cm-np-bm bm-' + this.colour.toLowerCase();
      return el;
    }
  }
  const bmMarkers = new Map();
  const bookmarkGutter = gutter({
    class: 'cm-np-bookmarks',
    renderEmptyElements: true, // every line has a spot to click (and the hover hint)
    markers(view) {
      const lines = typeof npBookmarkLines === 'function' ? npBookmarkLines() : null;
      if (!lines || !lines.length) return RangeSet.empty;
      const doc = view.state.doc;
      const out = [];
      for (const [line, colour] of lines) {
        if (line >= doc.lines) continue;
        let m = bmMarkers.get(colour);
        if (!m) bmMarkers.set(colour, (m = new BookmarkMarker(colour)));
        out.push(m.range(doc.line(line + 1).from));
      }
      return RangeSet.of(out, true);
    },
    lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshMarks))),
    initialSpacer: () => new BookmarkMarker('Green'),
    domEventHandlers: {
      mousedown(view, block, e) {
        if (e.button !== 0) return false;
        e.preventDefault();
        if (typeof npGutterBookmarkClick === 'function') npGutterBookmarkClick(view.state.doc.lineAt(block.from).number - 1, e.shiftKey);
        return true;
      },
      contextmenu(view, block, e) {
        e.preventDefault();
        if (typeof npGutterMenu === 'function') npGutterMenu(view.state.doc.lineAt(block.from).number - 1, e.clientX, e.clientY);
        return true;
      },
    },
  });
  const numberHandlers = {
    mousedown(view, block, e) {
      if (e.button !== 0) return false;
      e.preventDefault();
      if (typeof npGutterNumberClick === 'function') npGutterNumberClick(view.state.doc.lineAt(block.from).number - 1);
      return true;
    },
    contextmenu(view, block, e) {
      e.preventDefault();
      if (typeof npGutterMenu === 'function') npGutterMenu(view.state.doc.lineAt(block.from).number - 1, e.clientX, e.clientY);
      return true;
    },
  };
  const gutterExt = () => [diagGutter, lineNumbers({ domEventHandlers: numberHandlers }), bookmarkGutter, highlightActiveLineGutter()];

  function extensions() {
    return [
      // (No highlightSpecialChars: View > Show Hidden Characters shows invisible characters, as before.)
      history(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(false),
      // Enter inserts a plain line break, as in the old editor; Tab is handled by the app.
      keymap.of([{ key: 'Enter', run: insertNewline }, ...standardKeymap, ...historyKeymap]),
      wrapC.of(wrapOn ? EditorView.lineWrapping : []),
      gutterC.of(numbersOn ? gutterExt() : []),
      colourPlugin,
      marksPlugin,
      textPlugin,
      placeholderC.of(placeholderText ? placeholder(placeholderText) : []),
      tabC.of(EditorState.tabSize.of(tabSize())),
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', 'aria-label': 'Editor' }),
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && u.transactions.some((tr) => tr.docChanged && !tr.annotation(appChange)) && api && api.onUserInput) {
          api.onUserInput();
        }
      }),
    ];
  }

  const view = new EditorView({ state: EditorState.create({ doc: '', extensions: extensions() }), parent: facade.host });

  // The whole text as one string, made once per version of the document.
  let textCache = { doc: null, text: '' };
  const clamp = (n) => Math.max(0, Math.min(Number(n) || 0, view.state.doc.length));

  api = {
    view,
    onUserInput: null,
    text() {
      const d = view.state.doc;
      if (textCache.doc !== d) textCache = { doc: d, text: d.toString() };
      return textCache.text;
    },
    selection() {
      const m = view.state.selection.main;
      return [m.from, m.to];
    },
    selectionDirection() {
      const m = view.state.selection.main;
      return m.empty ? 'none' : m.head < m.anchor ? 'backward' : 'forward';
    },
    setSelection(start, end, direction) {
      const s = clamp(start);
      const e = clamp(end);
      const back = direction === 'backward';
      view.dispatch({ selection: { anchor: back ? Math.max(s, e) : Math.min(s, e), head: back ? Math.min(s, e) : Math.max(s, e) }, annotations: appChange.of(true) });
    },
    /** A different document: new state, fresh undo history. */
    loadText(text) {
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
      textCache = { doc: view.state.doc, text };
    },
    /** value = text: only the part that differs is replaced, as one undoable change. */
    setText(text) {
      const old = api.text();
      if (old === text) return;
      let p = 0;
      const max = Math.min(old.length, text.length);
      while (p < max && old.charCodeAt(p) === text.charCodeAt(p)) p++;
      let s = 0;
      while (s < max - p && old.charCodeAt(old.length - 1 - s) === text.charCodeAt(text.length - 1 - s)) s++;
      view.dispatch({
        changes: { from: p, to: old.length - s, insert: text.slice(p, text.length - s) },
        selection: { anchor: Math.min(view.state.selection.main.head, text.length) },
        annotations: [appChange.of(true), Transaction.addToHistory.of(true)],
      });
      textCache = { doc: view.state.doc, text };
    },
    insertText(text) {
      view.dispatch(view.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    },
    undo() {
      return undo(view);
    },
    redo() {
      return redo(view);
    },
    setWrap(on) {
      wrapOn = !!on;
      view.dispatch({ effects: wrapC.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
    },
    setLineNumbers(on) {
      numbersOn = !!on;
      view.dispatch({ effects: gutterC.reconfigure(numbersOn ? gutterExt() : []) });
    },
    /** The highlight.js language for this tab's colours (null: none). */
    setLanguage(lang, quiet) {
      if ((lang || null) === colourLang) return;
      colourLang = lang || null;
      if (!quiet) view.dispatch({ effects: refreshColours.of(null) }); // quiet: a new text is about to load
    },
    /** The app's marks (find hits, bookmarks...) changed: draw them again. */
    refreshMarks() {
      view.dispatch({ effects: refreshMarks.of(null) });
    },
    setPlaceholder(text) {
      placeholderText = text || '';
      view.dispatch({ effects: placeholderC.reconfigure(placeholderText ? placeholder(placeholderText) : []) });
    },
    setTabSize() {
      view.dispatch({ effects: tabC.reconfigure(EditorState.tabSize.of(tabSize())) });
    },
    /** Sets the scroll position; right after loading a document CodeMirror hasn't measured it yet,
     *  so the position is applied again once it has. */
    setScrollTop(v) {
      const s = view.scrollDOM;
      const before = s.scrollTop;
      s.scrollTop = v;
      // An update still waiting to be drawn (the text was just changed or loaded) makes CodeMirror
      // put back the position it had: apply ours again then. Any other position is the user's.
      // (Right after a big change the content may not be tall enough yet: keep trying for a few frames.)
      const reset = () => Math.abs(s.scrollTop - v) > 1 && Math.abs(s.scrollTop - before) <= 1;
      const again = () => {
        if (reset()) s.scrollTop = v;
      };
      view.requestMeasure({ read: () => null, write: again });
      let frames = 0;
      const tick = () => {
        again();
        if (reset() && ++frames < 10) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    /** Text offset of a DOM node inside the editor (e.g. a spelling mark). */
    posAtDOM(node) {
      return view.posAtDOM(node);
    },
    /** Line (0-based) shown at screen height `clientY`. */
    lineAtClientY(clientY) {
      return view.state.doc.lineAt(view.lineBlockAtHeight(clientY - view.documentTop).from).number - 1;
    },
    /** Screen rectangle of the character at `pos` (or null when it isn't drawn). */
    rectAt(pos) {
      const c = view.coordsAtPos(clamp(pos));
      return c ? new DOMRect(c.left, c.top, Math.max(1, c.right - c.left), c.bottom - c.top) : null;
    },
    /** Top of the line holding `pos`, in the scrolled content's coordinates (like the old editor). */
    yForOffset(pos) {
      return view.lineBlockAt(clamp(pos)).top + view.documentPadding.top;
    },
    /** Start offset of the line shown at `y` in the scrolled content. */
    offsetForY(y) {
      return view.lineBlockAtHeight(Math.max(0, y - view.documentPadding.top)).from;
    },
    /** Scrolls so `pos` is in view (a third of the way down when it was out of view). */
    scrollToOffset(pos) {
      const p = clamp(pos);
      const block = view.lineBlockAt(p);
      const top = block.top + view.documentPadding.top;
      const st = view.scrollDOM.scrollTop;
      const h = view.scrollDOM.clientHeight;
      // Like the old editor: the line a third of the way down.
      if (top < st + 20 || top + block.height > st + h - 40) api.setScrollTop(Math.max(0, top - h / 3));
    },
  };
  facade._attach(api);
}
