// A fast, dependency-free drop-in for marked 18.1.3 (default options: gfm on,
// breaks off, pedantic off, async off). Written from scratch to match marked's
// HTML byte for byte; the rules it implements are marked's own (see the kit's
// RULES.txt), expressed here in original code.
//
// Architecture mirrors a classic two-phase markdown engine: a block lexer
// turns the source into block tokens (link reference definitions are collected
// as it goes), then each block's inline text is lexed and rendered. Inline
// parsing is deferred until all blocks are lexed because a reference link may
// point at a definition that appears later in the document.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_NO_ENCODE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_TEST = /[&<>"']/;
const ESC_NO_ENCODE_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape text for HTML output. When `encode` is set, every & < > " ' is
// escaped; otherwise an & that already forms a valid character reference
// (&name; &#123; &#x1F;) is left alone (marked never decodes named entities).
function esc(s, encode) {
  if (encode) {
    return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC[c]) : s;
  }
  return ESC_NO_ENCODE_TEST.test(s) ? s.replace(ESC_NO_ENCODE_RE, (c) => ESC[c]) : s;
}

// Decode numeric character references only; a bare & becomes &amp;.
// Named references (&copy; &nbsp; ...) pass through untouched, exactly as
// marked leaves them.
function unescape(s) {
  if (!NUM_REF_RE.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
    return n === 38 ? '&amp;' : String.fromCodePoint(n);
  });
}

// Sanitize a link destination: encode it, un-escaping %25 back to %.
// Returns null when it cannot be encoded.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, honouring `\|` and code spans.
// `count` pads/truncates the row to the header's cell count.
function splitCells(row, count) {
  const t = row.replace(/\|/g, (m, off, str) => {
    let back = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) back = !back;
    return back ? '|' : ' |';
  });
  const cells = t.split(' |');
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Strip trailing characters: with `invert` unset, strips trailing `ch`;
// with it set, strips trailing characters that are NOT `ch`.
function trimEnd(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Drop trailing blank lines, but only when there are two or more of them.
function trimBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Normalize a link reference label: trim, collapse inner whitespace, and
// case-fold (the double conversion normalizes characters like K/ſ).
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing character of a balanced pair, skipping
// backslash escapes. Returns -2 when the pair never closes, -1 when the
// opening character never appears.
function findClose(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (--depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces on 4-column tab stops, starting at column `col`.
function expandTabs(s, col = 0) {
  let n = col;
  let out = '';
  for (const c of s) {
    if (c === '\t') {
      const r = 4 - (n % 4);
      out += ' '.repeat(r);
      n += r;
    } else {
      out += c;
      n++;
    }
  }
  return out;
}

// Remove the opening fence's indentation from a fenced code block's text.
function fenceIndent(raw, text, rules) {
  const m = raw.match(rules.other.indentCodeCompensation);
  if (m === null) return text;
  const s = m[1];
  return text.split('\n').map((r) => {
    const o = r.match(rules.other.beginningSpace);
    if (o === null) return r;
    const i = o[0];
    return r.slice(Math.min(i.length, s.length));
  }).join('\n');
}
// Block and inline grammar: the matching rules marked 18.1.3 applies.
// These regular expressions are the rules of the language; the tokenizers
// and renderer below are an original implementation built on them.
const BLOCK = {
  blockquote: /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/i,
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  newline: /^(?:[ \t]*(?:\n|$))+/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/,
  text: /^[^\n]+/,
};
const INLINE = {
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  escape: /^\\([!"#$%&'()*+,\-.\/:;<=>?@\[\]\\^_`{|}~])/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
};
const RX = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

// --- Regex factories ---
// listItemRegex takes its width raw; the others go through the same cache
// marked uses, which clamps the width to (t-1) capped at 3 (floored at 0),
// with one 4-slot cache per factory.
const BLOCK_TYPE = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
function _dFactory(make) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    return cache[n] || (cache[n] = make(n));
  };
}
const _listItemCache = new Map();
function listItemRegex(n) {
  let re = _listItemCache.get(n);
  if (!re) { re = new RegExp(`^( {0,3}${n})((?:[\\t ][^\\n]*)?(?:\\n|$))`); _listItemCache.set(n, re); }
  return re;
}
const nextBulletRegex = _dFactory((w) => new RegExp(`^ {0,${w}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrRegex = _dFactory((w) => new RegExp(`^ {0,${w}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = _dFactory((w) => new RegExp(`^ {0,${w}}(?:\`\`\`|~~~)`));
const headingBeginRegex = _dFactory((w) => new RegExp(`^ {0,${w}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = _dFactory((w) => new RegExp(`^ {0,${w}}(?:</?(?:${BLOCK_TYPE})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = _dFactory((w) => new RegExp(`^ {0,${w}}>`));

// --- Tokenizer ---
// Turns source text into token objects. `options` selects the grammar
// (here: gfm on, breaks off, pedantic off). `lexer` is the owning Lexer,
// used for recursive tokenization of nested content.
class Tokenizer {
  constructor(options, lexer) {
    this.options = options;
    this.lexer = lexer;
    this.rules = { block: BLOCK, inline: INLINE, other: RX };
  }

  // ---- Block tokenizers ----

  space(src) {
    const cap = BLOCK.newline.exec(src);
    if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
  }

  code(src) {
    const cap = BLOCK.code.exec(src);
    if (cap) {
      const raw = trimBlankLines(cap[0]);
      const text = raw.replace(RX.codeRemoveIndent, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
  }

  fences(src) {
    const cap = BLOCK.fences.exec(src);
    if (cap) {
      const raw = cap[0];
      const text = fenceIndent(raw, cap[3] || '', this.rules);
      return {
        type: 'code', raw,
        lang: cap[2] ? cap[2].trim().replace(INLINE.anyPunctuation, '$1') : cap[2],
        text,
      };
    }
  }

  heading(src) {
    const cap = BLOCK.heading.exec(src);
    if (cap) {
      let text = cap[2].trim();
      if (RX.endingHash.test(text)) {
        const stripped = trimEnd(text, '#');
        if (!stripped || RX.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      return {
        type: 'heading', raw: trimEnd(cap[0], '\n'),
        depth: cap[1].length, text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  hr(src) {
    const cap = BLOCK.hr.exec(src);
    if (cap) return { type: 'hr', raw: trimEnd(cap[0], '\n') };
  }

  blockquote(src) {
    const cap = BLOCK.blockquote.exec(src);
    if (cap) {
      let lines = trimEnd(cap[0], '\n').split('\n');
      let raw = '', text = '';
      const tokens = [];
      for (; lines.length > 0;) {
        let seenMarker = false, chunk = [], i;
        for (i = 0; i < lines.length; i++) {
          if (RX.blockquoteStart.test(lines[i])) { chunk.push(lines[i]); seenMarker = true; }
          else if (!seenMarker) chunk.push(lines[i]);
          else break;
        }
        lines = lines.slice(i);
        const joined = chunk.join('\n');
        const stripped = joined
          .replace(RX.blockquoteMarkerWhitespace, (m, a, b) => a + expandTabs(b, a.length))
          .replace(RX.blockquoteSetextReplace, '\n    $1')
          .replace(RX.blockquoteSetextReplace2, '');
        raw = raw ? `${raw}\n${joined}` : joined;
        text = text ? `${text}\n${stripped}` : stripped;
        const top = this.lexer.state.top;
        this.lexer.state.top = true;
        this.lexer.blockTokens(stripped, tokens, true);
        this.lexer.state.top = top;
        if (lines.length === 0) break;
        const last = tokens.at(-1);
        if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
        if (last?.type === 'blockquote') {
          const inner = last;
          const rest = lines.join('\n');
          const merged = inner.raw + '\n' + rest.replace(RX.blockquoteSetextReplace2, '');
          const retok = this.blockquote(merged);
          tokens[tokens.length - 1] = retok;
          const tail = merged.substring(retok.raw.length).replace(/^\n/, '');
          const tailLines = tail ? tail.split('\n').length : 0;
          const kept = tailLines ? lines.slice(0, -tailLines) : lines;
          if (kept.length > 0) raw = `${raw}\n${kept.join('\n')}`;
          text = text.substring(0, text.length - inner.text.length) + retok.text;
          lines = lines.slice(kept.length);
          if (lines.length > 0 && RX.blockquoteStart.test(lines[0])) continue;
          break;
        } else if (last?.type === 'list') {
          const listTok = last;
          const merged = listTok.raw + '\n' + lines.join('\n');
          const retok = this.list(merged);
          tokens[tokens.length - 1] = retok;
          const extra = retok.raw.length > listTok.raw.length
            ? merged.slice(listTok.raw.length + 1, retok.raw.length).split('\n').length : 0;
          if (extra > 0) {
            const kept = lines.slice(0, extra).join('\n');
            raw = `${raw}\n${kept}`;
            text = `${text}\n${kept}`;
          }
          lines = lines.slice(extra);
          continue;
        }
      }
      return { type: 'blockquote', raw, tokens, text };
    }
  }

  list(src) {
    const cap = BLOCK.list.exec(src);
    if (cap) {
      const orig = src;
      let rest = src;
      const consumed = () => orig.length - rest.length;
      const bullet = cap[1].trim();
      const ordered = bullet.length > 1;
      const list = {
        type: 'list', raw: '', ordered,
        start: ordered ? +bullet.slice(0, -1) : '',
        loose: false, items: [],
      };
      const bulletRe = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
      const itemRe = listItemRegex(bulletRe);
      let prevDoubleBlank = false;
      for (; rest;) {
        let emptyItem = false, itemText = '';
        const m = itemRe.exec(rest);
        if (!m || BLOCK.hr.test(rest)) break;
        const itemStart = consumed();
        rest = rest.substring(m[0].length);
        const m2nl = m[2].indexOf('\n');
        const firstLine = m2nl === -1 ? m[2] : m[2].slice(0, m2nl);
        const bulletLen = m[1].length;
        let line = firstLine.replace(RX.leadingSpaceTab, (v) => expandTabs(v, bulletLen));
        const restNl = rest.indexOf('\n');
        const nextLine = restNl === -1 ? rest : rest.slice(0, restNl);
        let isEmpty = !line.trim();
        let contentIndent = 0;
        const parts = [];
        if (isEmpty) contentIndent = bulletLen + 1;
        else {
          contentIndent = line.search(RX.nonSpaceChar);
          contentIndent = contentIndent > 4 ? 1 : contentIndent;
          parts.push(line.slice(contentIndent));
          contentIndent += bulletLen;
        }
        if (isEmpty && RX.blankLine.test(nextLine)) {
          rest = rest.substring(nextLine.length + 1);
          emptyItem = true;
        }
        if (!emptyItem) {
          const nextBullet = nextBulletRegex(contentIndent);
          const hr = hrRegex(contentIndent);
          const fence = fencesBeginRegex(contentIndent);
          const heading = headingBeginRegex(contentIndent);
          const html = htmlBeginRegex(contentIndent);
          const bq = blockquoteBeginRegex(contentIndent);
          for (; rest;) {
            const nl = rest.indexOf('\n');
            const cur = nl === -1 ? rest : rest.slice(0, nl);
            const c0 = cur.charCodeAt(0);
            const deindented = (c0 === 32 || c0 === 9)
              ? cur.replace(RX.leadingSpaceTab, (v) => expandTabs(v)) : cur;
            if (fence.test(cur) || heading.test(cur) || html.test(cur) || bq.test(cur) || nextBullet.test(cur) || hr.test(cur)) break;
            let firstNonSpace = 0;
            while (firstNonSpace < deindented.length && deindented.charCodeAt(firstNonSpace) === 32) firstNonSpace++;
            const curIsBlank = firstNonSpace === deindented.length;
            if (firstNonSpace >= contentIndent || curIsBlank) {
              parts.push(deindented.slice(contentIndent));
            } else {
              const lineFirstNonSpace = line.includes('\t')
                ? line.replace(RX.tabCharGlobal, '    ').search(RX.nonSpaceChar)
                : line.search(RX.nonSpaceChar);
              if (isEmpty || lineFirstNonSpace >= 4 || fence.test(line) || heading.test(line) || html.test(line) || hr.test(line)) break;
              const setextLine = /^ {0,3}(?:=+|-+) *$/.test(cur) && BLOCK.lheading.test(line + '\n' + cur)
                ? '    ' + deindented.replace(/^ {0,3}/, '') : cur;
              parts.push(setextLine);
            }
            isEmpty = curIsBlank;
            rest = rest.substring(cur.length + 1);
            line = deindented.slice(contentIndent);
          }
        }
        itemText = parts.join('\n');
        const itemRaw = orig.slice(itemStart, consumed());
        if (!list.loose) {
          if (prevDoubleBlank) list.loose = true;
          else if (endsWithDoubleBlankLine(itemRaw)) prevDoubleBlank = true;
        }
        list.items.push({
          type: 'list_item', raw: itemRaw, task: false, loose: false,
          text: itemText, tokens: [],
        });
      }
      const lastItem = list.items.at(-1);
      if (!lastItem) return;
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
      list.raw = orig.slice(0, consumed()).trimEnd();
      for (const item of list.items) {
        this.lexer.state.top = false;
        item.tokens = this.lexer.blockTokens(item.text, []);
        if (!list.loose) {
          const spaces = item.tokens.filter((g) => g.type === 'space');
          if (spaces.length > 0 && spaces.some((g) => RX.anyLine.test(g.raw))) list.loose = true;
        }
      }
      // Task list items: a [ ] / [x] checkbox at the start.
      for (const item of list.items) {
        item.task = RX.listIsTask.test(item.text);
        const first = item.tokens[0];
        if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
          item.text = item.text.replace(RX.listReplaceTask, '');
          first.raw = first.raw.replace(RX.listReplaceTask, '');
          first.text = first.text.replace(RX.listReplaceTask, '');
          for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
            if (RX.listIsTask.test(this.lexer.inlineQueue[g].src)) {
              this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(RX.listReplaceTask, '');
              break;
            }
          }
          const cb = RX.listTaskCheckbox.exec(item.raw);
          if (cb) {
            const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
            item.checked = checkbox.checked;
            if (list.loose) {
              if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
                item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
                item.tokens[0].text = checkbox.raw + item.tokens[0].text;
                item.tokens[0].tokens.unshift(checkbox);
              } else {
                item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
              }
            } else {
              item.tokens.unshift(checkbox);
            }
          }
        } else if (item.task) item.task = false;
      }
      if (list.loose) {
        for (const item of list.items) {
          item.loose = true;
          for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
        }
      }
      return list;
    }
  }

  html(src) {
    const cap = BLOCK.html.exec(src);
    if (cap) {
      const raw = trimBlankLines(cap[0]);
      return {
        type: 'html', block: true, raw,
        pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
        text: raw,
      };
    }
  }

  def(src) {
    const cap = BLOCK.def.exec(src);
    if (cap) {
      if (!RX.startAngleBracket.test(cap[2]) && findClose(cap[2], '()') !== -1) return;
      const tag = normalizeLabel(cap[1]);
      const href = cap[2] ? cap[2].replace(RX.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
      const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INLINE.anyPunctuation, '$1') : cap[3];
      return { type: 'def', tag, raw: trimEnd(cap[0], '\n'), href, title };
    }
  }

  table(src) {
    const cap = BLOCK.table.exec(src);
    if (cap) {
      if (!RX.tableDelimiter.test(cap[2])) return;
      const header = splitCells(cap[1]);
      const aligns = cap[2].replace(RX.tableAlignChars, '').split('|');
      const body = cap[3]?.trim() ? cap[3].replace(RX.tableRowBlankLine, '').split('\n') : [];
      const out = { type: 'table', raw: trimEnd(cap[0], '\n'), header: [], align: [], rows: [] };
      if (header.length === aligns.length) {
        for (const a of aligns) {
          if (RX.tableAlignRight.test(a)) out.align.push('right');
          else if (RX.tableAlignCenter.test(a)) out.align.push('center');
          else if (RX.tableAlignLeft.test(a)) out.align.push('left');
          else out.align.push(null);
        }
        for (let i = 0; i < header.length; i++) {
          out.header.push({ text: header[i], tokens: this.lexer.inline(header[i]), header: true, align: out.align[i] });
        }
        for (const row of body) {
          out.rows.push(splitCells(row, out.header.length).map((cell, p) =>
            ({ text: cell, tokens: this.lexer.inline(cell), header: false, align: out.align[p] })));
        }
        return out;
      }
    }
  }

  lheading(src) {
    const cap = BLOCK.lheading.exec(src);
    if (cap) {
      const text = cap[1].trim();
      return {
        type: 'heading', raw: trimEnd(cap[0], '\n'),
        depth: cap[2].charAt(0) === '=' ? 1 : 2,
        text, tokens: this.lexer.inline(text),
      };
    }
  }

  paragraph(src) {
    const cap = BLOCK.paragraph.exec(src);
    if (cap) {
      const text = cap[1].endsWith('\n') ? cap[1].slice(0, -1) : cap[1];
      return { type: 'paragraph', raw: cap[0], text, tokens: this.lexer.inline(text) };
    }
  }

  text(src) {
    const cap = BLOCK.text.exec(src);
    if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: this.lexer.inline(cap[0]) };
  }


  // ---- Inline tokenizers ----

  escape(src) {
    const cap = INLINE.escape.exec(src);
    if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
  }

  tag(src) {
    const cap = INLINE.tag.exec(src);
    if (cap) {
      if (!this.lexer.state.inLink && RX.startATag.test(cap[0])) this.lexer.state.inLink = true;
      else if (this.lexer.state.inLink && RX.endATag.test(cap[0])) this.lexer.state.inLink = false;
      if (!this.lexer.state.inRawBlock && RX.startPreScriptTag.test(cap[0])) this.lexer.state.inRawBlock = true;
      else if (this.lexer.state.inRawBlock && RX.endPreScriptTag.test(cap[0])) this.lexer.state.inRawBlock = false;
      return {
        type: 'html', raw: cap[0],
        inLink: this.lexer.state.inLink,
        inRawBlock: this.lexer.state.inRawBlock,
        block: false, text: cap[0],
      };
    }
  }

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return;
    const cap = INLINE.link.exec(src);
    if (cap) {
      const off = cap[0].charAt(0) === '!' ? 2 : 1;
      if (labelContainsTag(src, cap[1], off)) return;
      const s = cap[2].trim();
      if (!RX.startAngleBracket.test(s)) {
        const l = findClose(cap[2], '()');
        if (l === -2) return;
        if (l > -1) {
          const h = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + l;
          cap[2] = cap[2].substring(0, l);
          cap[0] = cap[0].substring(0, h).trim();
          cap[3] = '';
        }
      } else {
        if (!RX.endAngleBracket.test(s)) return;
        const stripped = trimEnd(s.slice(0, -1), '\\');
        if ((s.length - stripped.length) % 2 === 0) return;
      }
      const r = trimEnd(cap[0].slice(0, -1), '\\');
      if ((cap[0].length - r.length) % 2 === 0) return;
      let href = cap[2], title = '';
      title = cap[3] ? cap[3].slice(1, -1) : '';
      href = href.trim();
      if (RX.startAngleBracket.test(href)) href = href.slice(1, -1);
      return makeLinkToken(cap, {
        href: href && href.replace(INLINE.anyPunctuation, '$1'),
        title: title && title.replace(INLINE.anyPunctuation, '$1'),
      }, cap[0], this.lexer);
    }
  }

  reflink(src) {
    const cap = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (cap) {
      const off = cap[0].charAt(0) === '!' ? 2 : 1;
      if (labelContainsTag(src, cap[1], off)) return;
      const ref = this.lexer.tokens.links[normalizeLabel(cap[2] || cap[1])];
      if (!ref) {
        const ch = cap[0].charAt(0);
        return { type: 'text', raw: ch, text: ch };
      }
      return makeLinkToken(cap, ref, cap[0], this.lexer);
    }
  }

  emStrong(src, masked, prevChar = '') {
    const cap = INLINE.emStrongLDelim.exec(src);
    if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return;
    const delim = cap[0][0];
    const sameAsPrev = prevChar === delim;
    const fullLen = masked.length;
    const srcLen = src.length;
    const openerEnd = fullLen - srcLen; // index just after the opening run in `masked`
    let runStart = openerEnd;
    for (; runStart > 0 && masked[runStart - 1] === delim;) runStart--;
    const charBefore = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsPunct = charBefore === '*' || charBefore === '_' || !!INLINE.punctuation.exec(charBefore);
    if (runStart < openerEnd) prevChar = charBefore;
    const openerPunct = runStart < openerEnd ? beforeIsPunct : !!INLINE.punctuation.exec(prevChar);
    if (cap[4] && prevChar.match(RX.unicodeAlphaNumeric)) return;
    const punctAfter = cap[1] || cap[3] || '';
    if (!punctAfter || !prevChar || openerPunct) {
      const runLen = [...cap[0]].length - 1;
      let closer, closerLen, closerIdx;
      let left = runLen, extra = 0;
      const dist = openerEnd - runStart + runLen;
      const canClose = !!charBefore.trim() && (!!punctAfter || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return;
      const rDelim = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = lastPossibleEmStrongCloserIndex(this.lexer, masked, delim);
      const searchStart = fullLen - srcLen + runLen;
      if (lastCloser < searchStart) return;
      const tail = masked.slice(-1 * srcLen + runLen);
      const limit = lastCloser - searchStart;
      rDelim.lastIndex = 0;
      let m;
      for (; (m = rDelim.exec(tail)) !== null && !(m.index > limit);) {
        closer = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!closer) continue;
        closerLen = [...closer].length;
        if (m[3] || m[4]) { left += closerLen; continue; }
        if (m[5] || m[6] || canClose) {
          if (sameAsPrev && (m[5] || m[6])) break;
          if (dist % 3 && !((dist + closerLen) % 3)) { extra += closerLen; continue; }
        }
        if ((left -= closerLen) > 0) continue;
        closerLen = Math.min(closerLen, closerLen + left + extra);
        const firstLen = [...m[0]][0].length;
        const raw = src.slice(0, runLen + m.index + firstLen + closerLen);
        if (Math.min(runLen, closerLen) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }

  codespan(src) {
    const cap = INLINE.code.exec(src);
    if (cap) {
      let text = cap[2].replace(RX.newLineCharGlobal, ' ');
      const hasNonSpace = RX.nonSpaceChar.test(text);
      const padded = RX.startingSpaceChar.test(text) && RX.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: cap[0], text };
    }
  }

  br(src) {
    const cap = INLINE.br.exec(src);
    if (cap) return { type: 'br', raw: cap[0] };
  }

  del(src, masked, prevChar = '') {
    const cap = INLINE.delLDelim.exec(src);
    if (!cap) return;
    if (!(cap[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
      const runLen = [...cap[0]].length - 1;
      let left = runLen;
      const lastCloser = lastPossibleDelCloserIndex(this.lexer, masked);
      const searchStart = masked.length - src.length + runLen;
      if (lastCloser < searchStart) return;
      const tail = masked.slice(-1 * src.length + runLen);
      const limit = lastCloser - searchStart;
      const rDelim = INLINE.delRDelim;
      rDelim.lastIndex = 0;
      let m;
      for (; (m = rDelim.exec(tail)) !== null && !(m.index > limit);) {
        const closer = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!closer) continue;
        const closerLen = [...closer].length;
        if (closerLen !== runLen) continue;
        if (m[3] || m[4]) { left += closerLen; continue; }
        if ((left -= closerLen) > 0) continue;
        const useLen = Math.min(closerLen, closerLen + left);
        const firstLen = [...m[0]][0].length;
        const raw = src.slice(0, runLen + m.index + firstLen + useLen);
        const inner = raw.slice(runLen, -runLen);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }

  autolink(src) {
    const cap = INLINE.autolink.exec(src);
    if (cap) {
      let text, href;
      if (cap[2] === '@') { text = cap[1]; href = 'mailto:' + text; }
      else { text = cap[1]; href = text; }
      return {
        type: 'link', raw: cap[0], text, href, autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  }

  url(src) {
    if (this.lexer.state.inLink) return;
    const cap = INLINE.url.exec(src);
    if (cap) {
      let text, href;
      if (cap[2] === '@') { text = cap[0]; href = 'mailto:' + text; }
      else {
        let prev;
        do {
          prev = cap[0];
          cap[0] = INLINE._backpedal.exec(cap[0])?.[0] ?? '';
        } while (prev !== cap[0]);
        text = cap[0];
        href = cap[1] === 'www.' ? 'http://' + text : text;
      }
      return {
        type: 'link', raw: cap[0], text, href, autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  }

  inlineText(src) {
    const cap = INLINE.text.exec(src);
    if (cap) {
      const raw = cap[0];
      return {
        type: 'text', raw,
        text: this.lexer.state.inRawBlock ? raw : unescape(raw),
        escaped: this.lexer.state.inRawBlock,
      };
    }
  }
}

// --- Link helpers ---

// Does the label contain an HTML tag or autolink that extends past the
// label's end? If so the link is not a link.
function labelContainsTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link or image token, parsing the link text inline. A link whose
// text itself contains a link is dropped (no nested links).
function makeLinkToken(cap, ref, raw, lexer) {
  const href = ref.href;
  const title = ref.title || null;
  const text = cap[1].replace(RX.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const prevInLink = lexer.state.inLink;
  const prevEmitted = lexer.state.linkEmitted;
  const prevRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const nested = lexer.state.linkEmitted;
  lexer.state.linkEmitted = prevEmitted;
  lexer.state.inLink = prevInLink;
  if (!isImage) {
    if (nested) { lexer.state.inRawBlock = prevRawBlock; return; }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

// Last-possible-closer indexes for a masked inline source. The Lexer keeps
// a stack of one entry per inlineTokens level (the masked string and its
// lazily computed indexes); emStrong/del always run at the top level, so
// this avoids hashing the (possibly very long) masked string per lookup.
function lastPossibleCloserCompute(masked) {
  const idx = { '*': -1, '_': -1 };
  let del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const ch = masked[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === ch) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = s;
      else idx[ch] = s;
    }
    s = i - 1;
  }
  return { em: idx, del };
}
function lastPossibleEmStrongCloserIndex(lexer, masked, delim) {
  const top = lexer._feStack.at(-1);
  if (top && top.masked === masked) {
    if (!top.fe) top.fe = lastPossibleCloserCompute(masked);
    return top.fe.em[delim];
  }
  return lastPossibleCloserCompute(masked).em[delim];
}
function lastPossibleDelCloserIndex(lexer, masked) {
  const top = lexer._feStack.at(-1);
  if (top && top.masked === masked) {
    if (!top.fe) top.fe = lastPossibleCloserCompute(masked);
    return top.fe.del;
  }
  return lastPossibleCloserCompute(masked).del;
}

// Does the string end with a blank line (two newlines with only spaces/tabs
// between, and only spaces/tabs after)? Same as /\n[ \t]*\n[ \t]*$/.
function endsWithDoubleBlankLine(s) {
  let i = s.length - 1;
  while (i >= 0 && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i--;
  if (i < 0 || s.charCodeAt(i) !== 10) return false;
  i--;
  while (i >= 0 && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i--;
  return i >= 0 && s.charCodeAt(i) === 10;
}

// --- Lexer ---
// Turns a document into a token tree. Block tokenization runs first and
// queues inline sources; inline tokenization runs after, once all link
// reference definitions are known.
class Lexer {
  constructor(options) {
    this.options = options;
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer(options, this);
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this._feStack = [];
  }

  lex(src) {
    src = src.replace(RX.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const item = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens, top = false) {
    let longest = Infinity;
    for (; src;) {
      if (src.length < longest) longest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = this.tokenizer.space(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.code(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.fences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.heading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.hr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.blockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.list(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.html(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.def(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.tokens.links[tok.tag]) this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.table(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.lheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (this.state.top && (tok = this.tokenizer.paragraph(src))) {
        const prev = tokens.at(-1);
        if (top && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokenizer.text(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      break;
    }
    this.state.top = true;
    return tokens;
  }

  // Queue an inline source for later processing (after all block tokens
  // exist, so reference definitions are known). Returns the tokens array.
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  inlineTokens(src, tokens = []) {
    const prev = this.state.linkParenPossible;
    this.state.linkParenPossible = prev && src.includes(')');
    const masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? this._mask(src) : src;
    this._feStack.push({ masked, fe: null });
    try { return this._inline(src, masked, tokens); }
    finally { this._feStack.pop(); this.state.linkParenPossible = prev; }
  }

  // The inline loop.
  _inline(src, masked, tokens) {
    let prevText = false, prevChar = '', longest = Infinity;
    for (; src;) {
      if (src.length < longest) longest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!prevText) prevChar = '';
      prevText = false;
      let tok;
      if ((tok = this.tokenizer.escape(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.tag(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.link(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.reflink(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.type === 'text' && prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.emStrong(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.codespan(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.br(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.del(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.autolink(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (!this.state.inLink && (tok = this.tokenizer.url(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.inlineText(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        prevText = true;
        const prev = tokens.at(-1);
        if (prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      break;
    }
    return tokens;
  }

  // Mask link-like and code-like spans so emphasis closer search cannot see
  // delimiters inside them. Length-preserving.
  _mask(src) {
    let out = src;
    if (this.tokens.links && src.includes('[')) {
      const search = INLINE.reflinkSearch;
      const replace = (match) => {
        const open = match.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match.slice(open + 1, -1)))) return match;
        if (open > 1 && match.charAt(0) !== '!') {
          const inner = match.slice(1, open - 1);
          if (this.linkInText(inner)) return '[' + inner.replace(search, replace) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
        return '[' + 'a'.repeat(match.length - 2) + ']';
      };
      out = out.replace(search, replace);
    }
    if (out.includes('`') || out.includes('\\')) {
      out = out.replace(INLINE.anyPunctuationOutsideCode, (m, backtickRun, escChar) =>
        escChar ? '+'.repeat(m.length)
          : backtickRun ? backtickRun + m.slice(backtickRun.length, -backtickRun.length).replace(/`/g, '+') + backtickRun
          : m);
    }
    if (out.includes('[') || out.includes('`') || out.includes('<')) {
      out = out.replace(INLINE.blockSkip, (m, codeRun, backtickRun) => {
        const o = backtickRun ? backtickRun.length : 0;
        return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
      });
    }
    return out;
  }

  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0], open = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(s.slice(open + 1, -1))))
        && !(open > 1 && this.linkInText(s.slice(1, open - 1)))) return true;
    }
    return false;
  }
}

// --- Renderer ---
class Renderer {
  constructor() { this.parser = null; }
  space() { return ''; }
  code({ text, lang, escaped }) {
    const first = (lang || '').match(RX.notSpaceStart)?.[0];
    const body = text ? text.replace(RX.endingNewline, '') + '\n' : '';
    const content = escaped ? body : esc(body, true);
    return first
      ? '<pre><code class="language-' + esc(first) + '">' + content + '</code></pre>\n'
      : '<pre><code>' + content + '</code></pre>\n';
  }
  blockquote({ tokens }) { return '<blockquote>\n' + this.parser.parse(tokens) + '</blockquote>\n'; }
  html({ text }) { return text; }
  def() { return ''; }
  heading({ tokens, depth }) { return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`; }
  hr() { return '<hr>\n'; }
  list({ ordered, start, items }) {
    let body = '';
    for (const item of items) body += this.listitem(item);
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && start !== 1 ? ' start="' + start + '"' : '';
    return '<' + tag + startAttr + '>\n' + body + '</' + tag + '>\n';
  }
  listitem(token) { return `<li>${this.parser.parse(token.tokens)}</li>\n`; }
  checkbox({ checked }) { return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; }
  paragraph({ tokens }) { return `<p>${this.parser.parseInline(tokens)}</p>\n`; }
  table({ header, rows }) {
    let head = '';
    for (const cell of header) head += this.tablecell(cell);
    head = this.tablerow({ text: head });
    let body = '';
    for (const row of rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n` + head + `</thead>\n` + body + `</table>\n`;
  }
  tablerow({ text }) { return `<tr>\n${text}</tr>\n`; }
  tablecell(cell) {
    const content = this.parser.parseInline(cell.tokens);
    const tag = cell.header ? 'th' : 'td';
    return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + content + `</${tag}>\n`;
  }
  strong({ tokens }) { return `<strong>${this.parser.parseInline(tokens)}</strong>`; }
  em({ tokens }) { return `<em>${this.parser.parseInline(tokens)}</em>`; }
  codespan({ text }) { return `<code>${esc(text, true)}</code>`; }
  br() { return '<br>'; }
  del({ tokens }) { return `<del>${this.parser.parseInline(tokens)}</del>`; }
  link({ href, title, text, tokens, autolink }) {
    const inner = autolink ? esc(text, true) : this.parser.parseInline(tokens);
    const url = cleanUrl(href);
    if (url === null) return inner;
    const safe = esc(url, autolink);
    let out = '<a href="' + safe + '"';
    if (title) out += ' title="' + esc(title) + '"';
    return out + '>' + inner + '</a>';
  }
  image({ href, title, text, tokens }) {
    if (tokens) text = this.parser.parseInline(tokens, this.parser.textRenderer);
    const url = cleanUrl(href);
    if (url === null) return esc(text);
    let out = `<img src="${esc(url)}" alt="${esc(text)}"`;
    if (title) out += ` title="${esc(title)}"`;
    return out + '>';
  }
  text(token) {
    if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
    if ('escaped' in token && token.escaped) return token.text;
    return esc(token.text);
  }
}

// Plain-text renderer (used for image alt text).
class TextRenderer {
  constructor() { this.parser = null; }
  strong({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  em({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  codespan({ text }) { return text; }
  del({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  html({ text }) { return text; }
  text({ text }) { return text; }
  link({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  image({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  br() { return ''; }
  checkbox({ raw }) { return raw; }
}

// --- Parser ---
class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }
  parse(tokens) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'space': out += this.renderer.space(token); break;
        case 'hr': out += this.renderer.hr(token); break;
        case 'heading': out += this.renderer.heading(token); break;
        case 'code': out += this.renderer.code(token); break;
        case 'table': out += this.renderer.table(token); break;
        case 'blockquote': out += this.renderer.blockquote(token); break;
        case 'list': out += this.renderer.list(token); break;
        case 'checkbox': out += this.renderer.checkbox(token); break;
        case 'html': out += this.renderer.html(token); break;
        case 'def': out += this.renderer.def(token); break;
        case 'paragraph': out += this.renderer.paragraph(token); break;
        case 'text': out += this.renderer.text(token); break;
        default: throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
    return out;
  }
  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'escape': out += renderer.text(token); break;
        case 'html': out += renderer.html(token); break;
        case 'link': out += renderer.link(token); break;
        case 'image': out += renderer.image(token); break;
        case 'checkbox': out += renderer.checkbox(token); break;
        case 'strong': out += renderer.strong(token); break;
        case 'em': out += renderer.em(token); break;
        case 'codespan': out += renderer.codespan(token); break;
        case 'br': out += renderer.br(token); break;
        case 'del': out += renderer.del(token); break;
        case 'text': out += renderer.text(token); break;
        default: throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
    return out;
  }
}

// --- Entry point ---
export function parse(markdown) {
  const lexer = new Lexer({ gfm: true, breaks: false, pedantic: false });
  const tokens = lexer.lex(String(markdown));
  return new Parser().parse(tokens);
}
