/* Small highlight.js grammars for configuration formats the bundled highlight.js doesn't cover:
 * Dockerfile, NGINX, Apache (.htaccess), HCL / Terraform, .env files, ignore files and PEM
 * certificates/keys. Loaded by the page and by highlight-worker.js, so it only uses the global hljs.
 * Colouring only: nothing here reads, runs or imports the files. */

/**
 * highlight.js colours any _text_ in Markdown as italic (and __text__ as bold), even inside a word:
 * "test_test1_test2" showed "test1" in italics. Markdown itself (and the preview) only treats an
 * underscore as emphasis at the edge of a word, so here underscore emphasis must start after a
 * non-word character and end before one. Asterisks are left as they are (they do work inside words).
 */
function fixMarkdownUnderscores() {
  const md = typeof hljs !== 'undefined' && hljs.getLanguage('markdown');
  if (!md || !md.rawDefinition || md.npUnderscoresFixed) return;
  const raw = md.rawDefinition;
  hljs.registerLanguage('markdown', () => {
    const def = raw();
    const seen = new Set();
    const walk = (m) => {
      if (!m || typeof m !== 'object' || seen.has(m)) return;
      seen.add(m);
      if ((m.className === 'emphasis' || m.className === 'strong') && Array.isArray(m.variants)) {
        for (const v of m.variants) {
          const b = v.begin instanceof RegExp ? v.begin.source : v.begin;
          // (Letters: \w plus everything from U+00C0 up, so accented and non-Latin words count too.
          // No /u flag: highlight.js joins these into its own regex with its own flags.)
          if (b === '_(?![_\\s])') {
            v.begin = /(?<![\wÀ-￿])_(?![_\s])/;
            v.end = /_(?![\wÀ-￿])/;
          } else if (b === '_{2}(?!\\s)') {
            v.begin = /(?<![\wÀ-￿])__(?!\s)/;
            v.end = /__(?![\wÀ-￿])/;
          }
        }
      }
      for (const k of ['contains', 'variants']) if (Array.isArray(m[k])) m[k].forEach(walk);
    };
    walk(def);
    return def;
  });
  hljs.getLanguage('markdown').npUnderscoresFixed = true;
}

function registerConfigLanguages() {
  fixMarkdownUnderscores();
  if (typeof hljs === 'undefined' || hljs.getLanguage('dockerfile')) return;
  const HASH_COMMENT = { className: 'comment', begin: '#', end: '$', relevance: 0 };
  const LINE_HASH_COMMENT = { className: 'comment', begin: '^\\s*#', end: '$', relevance: 0 };
  const DQ = { className: 'string', begin: '"', end: '"', contains: [{ begin: '\\\\.' }], relevance: 0 };
  const SQ = { className: 'string', begin: "'", end: "'", relevance: 0 };
  const VAR = { className: 'variable', variants: [{ begin: '\\$\\{', end: '\\}' }, { begin: '\\$[A-Za-z_][\\w]*' }], relevance: 0 };
  const NUMBER = { className: 'number', begin: '\\b\\d+(?:\\.\\d+)*[kmgsKMGhd]?\\b', relevance: 0 };

  hljs.registerLanguage('dockerfile', () => ({
    name: 'Dockerfile',
    case_insensitive: true,
    contains: [
      LINE_HASH_COMMENT,
      {
        className: 'keyword',
        begin: '^\\s*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\\b',
        relevance: 10,
      },
      { className: 'meta', begin: '\\s(?:AS)\\s', relevance: 0 },
      { className: 'attr', begin: '--[a-z-]+(?==)', relevance: 0 },
      DQ,
      SQ,
      VAR,
    ],
  }));

  hljs.registerLanguage('nginx', () => ({
    name: 'NGINX',
    contains: [
      HASH_COMMENT,
      DQ,
      SQ,
      VAR,
      { className: 'section', begin: '\\b[a-z_]+(?=\\s*[^;{#]*\\{)', relevance: 0 },
      { className: 'attribute', begin: '^\\s*[a-z_][a-z0-9_]*\\b', relevance: 0 },
      { className: 'regexp', begin: '\\s\\^', end: '\\s', relevance: 0 },
      { className: 'literal', begin: '\\b(?:on|off|any|all|none)\\b', relevance: 0 },
      NUMBER,
    ],
  }));

  hljs.registerLanguage('apache', () => ({
    name: 'Apache',
    case_insensitive: true,
    contains: [
      LINE_HASH_COMMENT,
      { className: 'section', begin: '</?[A-Za-z]+', end: '>', contains: [DQ], relevance: 0 },
      { className: 'attribute', begin: '^\\s*[A-Za-z][A-Za-z0-9]*\\b', relevance: 0 },
      { className: 'literal', begin: '\\b(?:on|off|all|none|granted|denied)\\b', relevance: 0 },
      { className: 'variable', begin: '%\\{', end: '\\}', relevance: 0 },
      { className: 'meta', begin: '\\[[A-Z,=0-9]+\\]', relevance: 0 },
      DQ,
      NUMBER,
    ],
  }));

  hljs.registerLanguage('hcl', () => ({
    name: 'HCL / Terraform',
    contains: [
      HASH_COMMENT,
      { className: 'comment', begin: '//', end: '$', relevance: 0 },
      hljs.C_BLOCK_COMMENT_MODE,
      {
        className: 'string',
        begin: '"',
        end: '"',
        contains: [{ begin: '\\\\.' }, { className: 'subst', begin: '\\$\\{', end: '\\}' }],
        relevance: 0,
      },
      { className: 'string', begin: '<<-?\\s*([A-Z_]+)\\s*$', end: '^\\s*[A-Z_]+\\s*$', relevance: 0 },
      { className: 'keyword', begin: '^\\s*(?:resource|data|variable|output|module|provider|terraform|locals|backend|required_providers|moved|import|check)\\b', relevance: 5 },
      { className: 'literal', begin: '\\b(?:true|false|null)\\b', relevance: 0 },
      { className: 'attr', begin: '\\b[A-Za-z_][\\w-]*(?=\\s*=)', relevance: 0 },
      NUMBER,
    ],
  }));

  hljs.registerLanguage('dotenv', () => ({
    name: 'Environment file',
    contains: [
      LINE_HASH_COMMENT,
      { className: 'keyword', begin: '^\\s*export\\b', relevance: 0 },
      { className: 'attr', begin: '^\\s*(?:export\\s+)?[A-Za-z_][\\w.-]*(?=\\s*=)', relevance: 0 },
      DQ,
      SQ,
      VAR,
    ],
  }));

  hljs.registerLanguage('ignorefile', () => ({
    name: 'Ignore file',
    contains: [
      LINE_HASH_COMMENT,
      { className: 'keyword', begin: '^\\s*!', relevance: 0 },
      { className: 'meta', begin: '\\*\\*?|\\?', relevance: 0 },
    ],
  }));

  hljs.registerLanguage('pem', () => ({
    name: 'PEM',
    contains: [
      { className: 'section', begin: '^-----(?:BEGIN|END) [^-]+-----$', relevance: 10 },
      { className: 'attr', begin: '^[A-Za-z][\\w-]*(?=: )', relevance: 0 },
      { className: 'keyword', begin: '^(?:ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+)\\b', relevance: 5 },
      { className: 'comment', begin: '^=[A-Za-z0-9+/]{4}$', relevance: 0 },
    ],
  }));
}
