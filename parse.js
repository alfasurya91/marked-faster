// parse.js — a dependency-free, fast Markdown-to-HTML renderer producing exactly
// the HTML that marked 18.1.3 renders with its default options (GFM on, breaks
// off, pedantic off, synchronous). Written from the CommonMark 0.31.2 and GFM 0.29
// specifications, with marked's observed behaviour as the oracle for edge cases.
//
// Structure:
//   1. helpers: character classes, escaping, entity decoding, URL handling
//   2. block parser: lines -> block tree (containers + leaves)
//   3. inline parser: text -> nodes (delimiter stack for emphasis/links)
//   4. renderer: block tree -> HTML string

// ---------------------------------------------------------------- helpers ---

// ASCII punctuation characters (CommonMark definition).
const PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const PUNCT_CODES = new Set();
for (let i = 0; i < PUNCT.length; i++) PUNCT_CODES.add(PUNCT.charCodeAt(i));

function isSpace(c) { // space, tab, newline, CR, FF, VT
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isPunctCode(c) { return PUNCT_CODES.has(c); }
function isWhitespaceCode(c) { return isSpaceCode(c); }
// CommonMark punctuation for emphasis flanking: ASCII punctuation or any
// Unicode character in general categories P (punctuation) or S (symbol)
// — so currency symbols like £ and € count as punctuation.
const FLANK_PUNCT_CACHE = new Map();
function isFlankPunctCode(c) {
  if (c < 128) return PUNCT_CODES.has(c);
  let r = FLANK_PUNCT_CACHE.get(c);
  if (r === undefined) {
    r = /[\p{P}\p{S}]/u.test(String.fromCodePoint(c));
    FLANK_PUNCT_CACHE.set(c, r);
  }
  return r;
}

// Escape &, <, >, ", ' for HTML text and attribute values. A bare & is left
// alone only when it starts a valid entity reference: &word; , &#digits; (1-7
// digits) or &#x hex; (1-6 hex digits). This matches marked's observed output.
const ENTITY_TAIL = /^(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z0-9_]+);/;
function escapeHtml(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      if (ENTITY_TAIL.test(s.slice(i + 1))) continue;
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (start < i) out += s.slice(start, i);
    out += rep;
    start = i + 1;
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}
// Escape for raw code content (code spans, fenced/indented code): entities
// are NOT recognized in code, so '&' is always escaped (no ENTITY_TAIL
// exception like escapeHtml).
function escapeCode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (start < i) out += s.slice(start, i);
    out += rep;
    start = i + 1;
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Escape for URLs (href / src): percent-encode the characters marked encodes,
// then HTML-escape what is left (& unless an entity, ' -> &#39;).
const HREF_ENCODE = {
  32: '%20', 34: '%22', 60: '%3C', 62: '%3E', 91: '%5B', 92: '%5C', 93: '%5D',
  94: '%5E', 96: '%60', 123: '%7B', 124: '%7C', 125: '%7D',
};
function escapeHref(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = HREF_ENCODE[c];
    if (rep === undefined) {
      if (c === 38) { // &
        if (ENTITY_TAIL.test(s.slice(i + 1))) continue;
        rep = '&amp;';
      } else if (c === 39) rep = '&#39;';
      else if (c < 32 || c === 127) rep = '%' + c.toString(16).toUpperCase().padStart(2, '0');
      else if (c >= 128) {
        // percent-encode non-ASCII as UTF-8 (surrogate pairs together)
        const ch = (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length &&
          s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF)
          ? s.slice(i, i + 2) : s[i];
        rep = encodeURIComponent(ch);
        if (ch.length === 2) {
          if (start < i) out += s.slice(start, i);
          out += rep;
          start = i + 2;
          i++;
          continue;
        }
      }
      else continue;
    }
    if (start < i) out += s.slice(start, i);
    out += rep;
    start = i + 1;
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Decode a numeric character reference at position i of s (s[i] === '&').
// Returns [decodedString, nextIndex] or null when it is not a valid numeric
// entity. Valid: &#1-7 decimal digits; or &#x 1-6 hex digits. Code point 0,
// surrogates, and values above 0x10FFFF become U+FFFD.
function decodeNumericEntity(s, i) {
  const n = s.length;
  if (i + 2 >= n || s.charCodeAt(i + 1) !== 35) return null; // not &#
  let j = i + 2;
  let hex = false;
  if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
  const digitsStart = j;
  if (hex) {
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) j++;
      else break;
    }
    if (j - digitsStart < 1 || j - digitsStart > 6) return null;
  } else {
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    if (j - digitsStart < 1 || j - digitsStart > 7) return null;
  }
  if (j >= n || s.charCodeAt(j) !== 59) return null; // needs ';'
  const cp = parseInt(s.slice(digitsStart, j), hex ? 16 : 10);
  let ch;
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) ch = '\uFFFD';
  else ch = String.fromCodePoint(cp);
  return [ch, j + 1];
}

// Named entity: &word; passes through unchanged (whether or not the name is
// a defined entity). Returns the length of the entity (including & and ;)
// starting at i, or 0 when there is none.
function namedEntityLength(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) j++;
    else break;
  }
  if (j > i + 1 && j < n && s.charCodeAt(j) === 59) return j - i + 1;
  return 0;
}

// Backslash-escapable punctuation: \ + ASCII punctuation yields the char.
function isEscapable(c) { return PUNCT_CODES.has(c); }

// Normalize a link reference label: collapse all whitespace runs (including
// newlines) to a single space, trim, and case-fold (Unicode lowercase).
// Unicode case folding maps ß/ẞ to "ss" (unlike toLowerCase, which gives ß).
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}

 // Is this source line only container markers (quote '>' and/or a list
 // marker) with whitespace — i.e. an "empty marker line", not a real blank
 // line? A genuinely blank line (only spaces/tabs) returns false.
 function isEmptyMarkerLine(s) {
   let i = 0;
   while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
   if (i >= s.length) return false; // genuinely blank
   let sawMarker = false;
   while (i < s.length && s[i] === '>') {
     sawMarker = true;
     i++;
     while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
   }
   if (i >= s.length) return sawMarker; // only '>' markers
   const rest = s.slice(i);
   if (/^([*+-]|[0-9]{1,9}[.)])[ \t]*$/.test(rest)) return true;
   return false;
 }

 // ------------------------------------------------------------------- lines ---
 // A line being processed: s is the raw line (no trailing newline), pos the
 // byte offset of the next unconsumed char, col its column, pt/pr track a
 // partially-consumed tab (pos still points at the tab, pr spaces remain).
 function makeLine(s) { return { s, pos: 0, col: 0, pt: false, pr: 0 }; }
 function peek(l) {
   if (l.pt) return 32;
   return l.pos < l.s.length ? l.s.charCodeAt(l.pos) : -1;
 }
 function peekAt(l, off) {
   if (l.pt) return off === 0 ? 32 : (l.pos + off - 1 < l.s.length ? l.s.charCodeAt(l.pos + off - 1) : -1);
   const p = l.pos + off;
   return p < l.s.length ? l.s.charCodeAt(p) : -1;
 }
 // Advance n columns, honouring tab stops (tab advances to next multiple of 4).
 function advance(l, n) {
   while (n > 0) {
     if (l.pt) {
       const take = Math.min(n, l.pr);
       l.pr -= take; l.col += take; n -= take;
       if (l.pr === 0) { l.pt = false; l.pos++; }
     } else if (l.pos < l.s.length) {
       const c = l.s.charCodeAt(l.pos);
       if (c === 9) {
         const w = 4 - (l.col % 4);
         if (n >= w) { l.pos++; l.col += w; n -= w; }
         else { l.pt = true; l.pr = w - n; l.col += n; n = 0; }
       } else { l.pos++; l.col++; n--; }
     } else break;
   }
 }
 // Columns of whitespace (spaces/tabs) starting at the current position.
 function indentOf(l) {
   let col = l.col, i = l.pos, pr = l.pt ? l.pr : 0;
   if (l.pt) { col += pr; i++; }
   while (i < l.s.length) {
     const c = l.s.charCodeAt(i);
     if (c === 32) { col++; i++; }
     else if (c === 9) { col += 4 - (col % 4); i++; }
     else break;
   }
   return col - l.col;
 }
 // Skip spaces/tabs; return columns skipped.
 function skipSpaces(l) {
   const start = l.col;
   while (true) {
     const c = peek(l);
     if (c === 32 || c === 9) advance(l, 1);
     else break;
   }
   return l.col - start;
 }
 // Is the rest of the line blank (only spaces/tabs)?
 function isBlankLine(l) {
   let i = l.pos;
   if (l.pt) i++;
   while (i < l.s.length) {
     const c = l.s.charCodeAt(i);
     if (c !== 32 && c !== 9) return false;
     i++;
   }
   return true;
 }
 // The unconsumed remainder of the line, with a partially-consumed tab
 // rendered as its remaining spaces.
 function restOf(l) {
   if (l.pt) return ' '.repeat(l.pr) + l.s.slice(l.pos + 1);
   return l.s.slice(l.pos);
 }
 
 // ------------------------------------------------- link reference definitions ---
 // Parse a link reference definition starting at offset i in string s.
 // Returns {label, dest, title, end} (end = index just past the definition,
 // at a newline or end of string) or null.
 function parseRefDef(s, i) {
   const n = s.length;
   let j = i;
   // up to 3 spaces of indentation
   let ind = 0;
   while (j < n && s.charCodeAt(j) === 32 && ind < 3) { j++; ind++; }
   if (j >= n || s.charCodeAt(j) !== 91) return null; // '['
   const label = parseLinkLabel(s, j, false);
   if (!label || label.text.length === 0) return null; // empty label invalid
   const normLabel = normalizeLabel(label.text);
   if (normLabel.length === 0) return null; // whitespace-only label invalid
   j = label.end;
   if (j >= n || s.charCodeAt(j) !== 58) return null; // ':'
   j++;
   // skip spaces/tabs/newlines
   j = skipWsNl(s, j);
   if (j >= n) return null;
   const dest = parseLinkDest(s, j);
   if (!dest) return null;
   const afterDest = dest.end;
   // Optional title: it may sit on the same line or a following line, but
   // it must be separated from the destination by whitespace (a title
   // glued to the destination, e.g. '<bar>(baz)', is not a title, and the
   // trailing text then invalidates the definition). When a title is
   // attempted but fails (unparseable, or followed by junk on its line),
   // the definition falls back to destination-only.
   const k = skipWsNl(s, afterDest);
   if (k < n && k > afterDest) {
     const c = s.charCodeAt(k);
     if (c === 34 || c === 39 || c === 40) {
       const t = parseLinkTitle(s, k);
       if (t) {
         let m = t.end;
         while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
         if (m >= n || s.charCodeAt(m) === 10) {
           return { label: normLabel, dest: dest.dest, title: t.title, end: m };
         }
       }
       // title failed: fall through to destination-only below
     }
   }
   // no title: only spaces/tabs may follow the destination on its line
   let m = afterDest;
   while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
   if (m >= n || s.charCodeAt(m) === 10) {
     return { label: normLabel, dest: dest.dest, title: null, end: m };
   }
   return null;
 }
 function skipWsNl(s, j) {
   const n = s.length;
   while (j < n) {
     const c = s.charCodeAt(j);
     if (c === 32 || c === 9 || c === 10) j++;
     else break;
   }
   return j;
 }
 // Parse a link label starting at s[i] === '['. Returns {text, end} or null.
 // Label may contain balanced brackets and backslash escapes, max 999 chars.
 // A `]` inside a code span or HTML tag does not close the label. Empty labels
 // are allowed here (inline links accept them); reference definitions reject
 // them in parseRefDef. When allowNested is false, a label containing an
 // unescaped '[' is rejected (ref-def labels, full-reference second labels,
 // and shortcut labels do not allow nested brackets in marked).
 function parseLinkLabel(s, i, allowNested) {
   const n = s.length;
   let j = i + 1;
   let depth = 0;
   let priorTick = false;
   let start = j;
   while (j < n) {
     const c = s.charCodeAt(j);
     if (c === 92) { j += 2; continue; } // backslash escape
     if (c === 96) { // backtick: skip a code span if it closes
       let run = 0;
       while (j + run < n && s.charCodeAt(j + run) === 96) run++;
       // find a closing run of the same length, but never past the
       // `]` that would end the label at the current depth — a span
       // that does not close before the label ends is unclosed.
       // However, a `]` with no backtick run seen since the opener
       // is span content (`` ``b]c`` ``), so keep scanning past it;
       // only a `]` after a backtick run ends the label. The scan
       // also never crosses a newline: a closer on a later line does
       // not close a span inside a label.
       let k = j + run;
       let closed = -1;
       let sd = depth;
       let sawTick = false;
       let sawContent = false;
       while (k < n) {
         const cc = s.charCodeAt(k);
         if (cc === 10) break;
         if (cc === 96) {
           let r2 = 0;
           while (k + r2 < n && s.charCodeAt(k + r2) === 96) r2++;
           sawTick = true;
           if (r2 === run) { closed = k + r2; break; }
           k += r2;
         } else if (cc === 91) { sd++; k++; }
         else if (cc === 93) { if (sd === 0 && (sawTick || priorTick)) break; if (sd === 0) { sawContent = true; k++; continue; } sd--; k++; }
         else { sawContent = true; k++; }
       }
       if (closed !== -1) {
         // A closed code span delimited by 2+ backticks whose content
         // itself contains a backtick poisons the whole label — but only
         // when more label content follows it. When the span is the last
         // thing in the label (immediately before `]`), the link forms.
         if (run >= 2 && s.slice(j + run, closed - run).indexOf('`') !== -1 &&
             !(depth === 0 && closed < n && s.charCodeAt(closed) === 93)) return null;
         priorTick = true;
         j = closed; continue;
       }
       priorTick = true;
       j += run; continue;
     }
     if (c === 60) { // '<': skip a raw HTML construct or standard autolink
       const al = tryStdAutolink(s, j);
       if (al) { j = al.end; continue; }
       const rh = tryRawHtml(s, j);
       if (rh) { j = rh.end; continue; }
       j++; continue;
     }
     if (c === 91) {
       if (!allowNested && depth === 0) return null; // nested '[' not allowed
       depth++; j++; continue;
     } // '['
     if (c === 93) { // ']'
       if (depth === 0) {
         const text = s.slice(start, j);
         if (text.length > 999) return null;
         return { text, end: j + 1 };
       }
       depth--; j++; continue;
     }
     j++;
   }
   return null;
 }
 // Lenient label scan (no poison rule): find the `]` ending a label,
 // accounting for nested brackets and code spans. Used only to render a
 // failed link's label with emphasis disabled.
 function parseLabelLenient(s, i) {
   const n = s.length;
   let j = i + 1;
   let depth = 0;
   let priorTick = false;
   let start = j;
   while (j < n) {
     const c = s.charCodeAt(j);
     if (c === 92) { j += 2; continue; }
     if (c === 96) {
       let run = 0;
       while (j + run < n && s.charCodeAt(j + run) === 96) run++;
       let k = j + run;
       let closed = -1;
       let sd = depth;
       let sawTick = false;
       let sawContent = false;
       while (k < n) {
         const cc = s.charCodeAt(k);
         if (cc === 10) break;
         if (cc === 96) {
           let r2 = 0;
           while (k + r2 < n && s.charCodeAt(k + r2) === 96) r2++;
           sawTick = true;
           if (r2 === run) { closed = k + r2; break; }
           k += r2;
         } else if (cc === 91) { sd++; k++; }
         else if (cc === 93) { if (sd === 0 && (sawTick || priorTick)) break; if (sd === 0) { sawContent = true; k++; continue; } sd--; k++; }
         else { sawContent = true; k++; }
       }
       if (closed !== -1) { priorTick = true; j = closed; continue; }
       priorTick = true;
       j += run; continue;
     }
     if (c === 60) {
       const al = tryStdAutolink(s, j);
       if (al) { j = al.end; continue; }
       const rh = tryRawHtml(s, j);
       if (rh) { j = rh.end; continue; }
       j++; continue;
     }
     if (c === 91) { depth++; j++; continue; }
     if (c === 93) {
       if (depth === 0) {
         const text = s.slice(start, j);
         if (text.length > 999) return null;
         return { text, end: j + 1 };
       }
       depth--; j++; continue;
     }
     j++;
   }
   return null;
 }
 // Parse a link destination starting at j. Returns {dest, end} or null.
 // <...> form or bare form (no spaces/control, balanced parens, escapes).
 function parseLinkDest(s, j) {
   const n = s.length;
   if (j >= n) return null;
   if (s.charCodeAt(j) === 60) { // '<'
     let k = j + 1;
     let out = '';
     while (k < n) {
       const c = s.charCodeAt(k);
       if (c === 10) return null;
       if (c === 62) return { dest: out, end: k + 1 }; // '>'
       if (c === 60) return null;
       if (c === 92 && k + 1 < n && isEscapable(s.charCodeAt(k + 1))) { out += s[k + 1]; k += 2; continue; }
       out += s[k]; k++;
     }
     return null;
   }
   // bare destination
   let k = j;
   let depth = 0;
   let out = '';
   while (k < n) {
     const c = s.charCodeAt(k);
     if (c === 32 || c === 9 || c === 10 || c < 32) break;
     if (c === 92 && k + 1 < n && isEscapable(s.charCodeAt(k + 1))) { out += s[k + 1]; k += 2; continue; }
     if (c === 40) { depth++; out += s[k]; k++; continue; } // '('
     if (c === 41) { // ')'
       if (depth === 0) break;
       depth--; out += s[k]; k++; continue;
     }
     out += s[k]; k++;
   }
   if (k === j) return null;
   return { dest: out, end: k };
 }
 // Parse a link title starting at j ('"', '\'', or '('). Returns {title, end}
 // or null. Titles may span lines.
 function parseLinkTitle(s, j) {
   const n = s.length;
   if (j >= n) return null;
   const c = s.charCodeAt(j);
   let close;
   if (c === 34) close = 34;
   else if (c === 39) close = 39;
   else if (c === 40) close = 41;
   else return null;
   let k = j + 1;
   let out = '';
   while (k < n) {
     const ch = s.charCodeAt(k);
     if (ch === close) return { title: out, end: k + 1 };
     if (ch === 92 && k + 1 < n && isEscapable(s.charCodeAt(k + 1))) { out += s[k + 1]; k += 2; continue; }
     if (close === 41 && ch === 40) return null; // no '(' inside (...) title
     out += s[k]; k++;
   }
   return null;
 }

 // ------------------------------------------------------------------- blocks ---
 // Block node types:
 //  doc, para{lines}, heading{level,src}, code{fenced,info,lines,flen,fchar},
 //  html{lines,htype}, quote{children}, list{ordered,start,delim,tight,children},
 //  item{children,contentIndent}, table{header,aligns,rows}, hr
 // Every block has parent, children (containers), lastBlank.

 const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

 function newBlock(t, parent) {
   const b = { t, parent, children: [], lastBlank: false, blankBetween: false };
   if (parent) {
     // A blank line between two block-level children of a list item makes
     // the item's list loose.
     if (parent.t === 'item' && parent.lastBlank && parent.children.length > 0) {
       if (parent.parent && parent.parent.t === 'list') parent.parent.tight = false;
     }
     parent.children.push(b);
     parent.lastBlank = false;
     // Content added inside an item consumes a pending "blank between
     // items" for every list ABOVE the item's own list: the blank line
     // was inside this item, not between the outer list's items.
     if (parent.t === 'item' && parent.parent && parent.parent.t === 'list') {
       let anc = parent.parent.parent;
       while (anc) {
         if (anc.t === 'list') anc.blankBetween = false;
         anc = anc.parent;
       }
     }
   }
   return b;
 }

 // Match a blockquote marker at the current position: up to 3 spaces, '>',
 // then one optional space/tab. Returns true and consumes, or false.
 function matchQuote(l) {
   const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
   const ind = indentOf(l);
   if (ind > 3) return false;
   advance(l, ind);
   if (peek(l) !== 62) { restore(l, save); return false; } // '>'
   advance(l, 1);
   const c = peek(l);
   if (c === 32 || c === 9) advance(l, 1);
   return true;
 }
 function restore(l, s) { l.pos = s.pos; l.col = s.col; l.pt = s.pt; l.pr = s.pr; }

 // Match a list item's content indent: blank line matches; otherwise the line
 // must be indented at least contentIndent columns. Consumes the indent.
 function matchItem(l, item) {
   if (isBlankLine(l)) return true;
   // An empty item that a genuine blank line has passed cannot take
   // more content (spec example 280).
   if (item.children.length === 0 && item.blankAfter) return false;
   if (indentOf(l) >= item.contentIndent) { advance(l, item.contentIndent); return true; }
   return false;
 }

 // Try to start a blockquote: consumes the '>' marker. Returns true/false.
 function tryQuote(l) {
   return matchQuote(l);
 }
 // Try an ATX heading. Returns {level, src} or null. Consumes the line.
 function tryATX(l) {
   const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
   const ind = indentOf(l);
   if (ind > 3) return null;
   advance(l, ind);
   let level = 0;
   while (peek(l) === 35 && level < 7) { advance(l, 1); level++; }
   if (level === 0 || level === 7) { restore(l, save); return null; }
   const c = peek(l);
   if (c !== -1 && c !== 32 && c !== 9) { restore(l, save); return null; }
   // content: rest of line; a closing sequence of #'s preceded by a space
   // is stripped (the space may be the one after the opening hashes, so
   // strip before trimming leading spaces: '### ###' -> empty heading).
   let src = restOf(l).replace(/[ \t]+#+[ \t]*$/, '');
   src = src.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
   return { level, src };
 }
 // Try a fenced code block. Returns {fchar, flen, info} or null.
 function tryFenced(l) {
   const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
   const ind = indentOf(l);
   if (ind > 3) return null;
   advance(l, ind);
   const c = peek(l);
   if (c !== 96 && c !== 126) { restore(l, save); return null; } // ` or ~
   let len = 0;
   while (peek(l) === c) { advance(l, 1); len++; }
   if (len < 3) { restore(l, save); return null; }
   let info = restOf(l);
   if (c === 96 && info.indexOf('`') !== -1) { restore(l, save); return null; }
   info = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
   // backslash escapes in the info string resolve (foo\+bar -> foo+bar)
   info = info.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
   return { fchar: c, flen: len, info, indent: ind };
 }
 // Is this line a closing fence for the given fenced block?
 function isClosingFence(l, code) {
   const ind = indentOf(l);
   if (ind > 3) return false;
   // scan: skip indent, then a run of the fence char, then only spaces
   let i = l.pos, col = l.col;
   if (l.pt) { i++; col += l.pr; }
   while (i < l.s.length && (l.s.charCodeAt(i) === 32 || l.s.charCodeAt(i) === 9)) {
     if (l.s.charCodeAt(i) === 9) col += 4 - (col % 4); else col++;
     i++;
   }
   if (col - l.col > 3) return false;
   let len = 0;
   while (i < l.s.length && l.s.charCodeAt(i) === code.fchar) { len++; i++; }
   if (len < code.flen) return false;
   while (i < l.s.length) {
     const ch = l.s.charCodeAt(i);
     if (ch !== 32 && ch !== 9) return false;
     i++;
   }
   return true;
 }
 // Try a thematic break. Returns true or false (does not consume on false).
 function tryHr(l) {
   const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
   const ind = indentOf(l);
   if (ind > 3) return null;
   advance(l, ind);
   const c = peek(l);
   if (c !== 42 && c !== 45 && c !== 95) { restore(l, save); return null; } // * - _
   let count = 0;
   while (true) {
     const ch = peek(l);
     if (ch === c) { count++; advance(l, 1); }
     else if (ch === 32 || ch === 9) advance(l, 1);
     else if (ch === -1) break;
     else { restore(l, save); return null; }
   }
   if (count < 3) { restore(l, save); return null; }
   return true;
 }
 // Match an open/close HTML tag starting at position i of string s.
 // Returns {name, end, closing} or null. Handles attributes per the spec.
 function matchHtmlTag(s, i) {
   const n = s.length;
   let j = i;
   if (j >= n || s.charCodeAt(j) !== 60) return null; // '<'
   j++;
   let closing = false;
   if (j < n && s.charCodeAt(j) === 47) { closing = true; j++; } // '/'
   if (j >= n || !isAlpha(s.charCodeAt(j))) return null;
   const nameStart = j;
   while (j < n) {
     const c = s.charCodeAt(j);
     if (isAlnum(c) || c === 45) j++;
     else break;
   }
   const name = s.slice(nameStart, j).toLowerCase();
   if (closing) {
     // optional spaces, then '>'
     while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
     if (j < n && s.charCodeAt(j) === 62) return { name, end: j + 1, closing };
     return null;
   }
   // attributes: each attribute must be preceded by whitespace
   let hadWs = false; // whitespace seen since the tag name / last attribute
   while (true) {
     // skip whitespace (incl. newlines); count it
     let ws = 0;
     while (j < n && isSpaceCode(s.charCodeAt(j))) { j++; ws++; }
     if (ws > 0) hadWs = true;
     if (j >= n) return null;
     const c = s.charCodeAt(j);
     if (c === 62) return { name, end: j + 1, closing }; // '>'
     if (c === 47 && j + 1 < n && s.charCodeAt(j + 1) === 62) return { name, end: j + 2, closing }; // '/>'
     if (!hadWs) return null; // no whitespace before an attribute
     hadWs = false;
     // attribute name
     if (!isAlpha(c) && c !== 95 && c !== 58) return null;
     while (j < n) {
       const d = s.charCodeAt(j);
       if (isAlnum(d) || d === 95 || d === 58 || d === 46 || d === 45) j++;
       else break;
     }
     while (j < n && isSpaceCode(s.charCodeAt(j))) { j++; hadWs = true; }
     if (j < n && s.charCodeAt(j) === 61) { // '='
       j++;
       while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
       if (j >= n) return null;
       const q = s.charCodeAt(j);
       if (q === 34 || q === 39) {
         j++;
         while (j < n && s.charCodeAt(j) !== q) j++;
         if (j >= n) return null;
         j++;
       } else {
         while (j < n) {
           const d = s.charCodeAt(j);
           if (isSpaceCode(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
           j++;
         }
         if (j >= n) return null;
       }
     }
   }
 }
 // HTML block start conditions. Returns the type (1-7) or 0.
 // s is the line's remaining text (from current position), already stripped
 // of up to 3 leading spaces by the caller via restOf after advance.
 function htmlBlockType(s) {
   // work on the raw remainder; case-insensitive checks
   const t = s;
   if (/^<(script|pre|style|textarea)([ \t\n>]|$)/i.test(t)) return 1;
   if (t.startsWith('<!--')) return 2;
   if (t.startsWith('<?')) return 3;
   if (/^<![A-Za-z]/.test(t)) return 4;
   if (t.startsWith('<![CDATA[')) return 5;
   const tag = matchHtmlTag(t, 0);
   if (tag) {
     if (BLOCK_TAGS.has(tag.name)) return 6;
     // type 7: tag alone on the line (only spaces after it)
     let j = tag.end;
     while (j < t.length && (t.charCodeAt(j) === 32 || t.charCodeAt(j) === 9)) j++;
     if (j === t.length) return 7;
     return 0;
   }
   // Incomplete tag: '<' + tag name with no '>' yet (the tag continues on
   // the next line). A block-level tag name starts an HTML block (type 6).
   if (t.charCodeAt(0) === 60) {
     let k = 1;
     if (t.charCodeAt(1) === 47) k = 2;
     let e = k;
     while (e < t.length) {
       const ch = t.charCodeAt(e);
       if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 45) e++;
       else break;
     }
     if (e > k) {
       const ac = e === t.length ? -1 : t.charCodeAt(e);
       if (ac === -1 || ac === 32 || ac === 9 || ac === 62 || ac === 47) {
         if (BLOCK_TAGS.has(t.slice(k, e).toLowerCase())) return 6;
       }
     }
   }
   return 0;
 }
 // Does this line end an HTML block of the given type? (line's raw text)
 function htmlBlockEnds(s, htype) {
   const low = s.toLowerCase();
   switch (htype) {
     case 1: return /<\/(script|pre|style|textarea)/.test(low);
     case 2: return s.indexOf('-->') !== -1;
     case 3: return s.indexOf('?>') !== -1;
     case 4: return s.indexOf('>') !== -1;
     case 5: return s.indexOf(']]>') !== -1;
     default: return false; // types 6-7 end at a blank line
   }
 }
 // Try a list item marker. Returns {ordered, delim, marker, start, markerLen}
 // or null. marker is the bullet char ('-','+','*') or the ordered delimiter
 // ('.' or ')'). The caller checks interruption rules against an open paragraph.
 function tryListMarker(l) {
   const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
   const ind = indentOf(l);
   if (ind > 3) return null;
   advance(l, ind);
   const c = peek(l);
   let ordered = false, delim = '', marker = '', start = 0, markerLen = 0;
   if (c === 45 || c === 43 || c === 42) { // - + *
     markerLen = 1;
     marker = String.fromCharCode(c);
   } else if (c >= 48 && c <= 57) {
     let num = 0, digits = 0;
     while (digits < 9) {
       const d = peek(l);
       if (d >= 48 && d <= 57) { num = num * 10 + (d - 48); digits++; advance(l, 1); }
       else break;
     }
     if (digits === 0) { restore(l, save); return null; }
     const d = peek(l);
     if (d !== 46 && d !== 41) { restore(l, save); return null; } // '.' or ')'
     delim = d === 46 ? '.' : ')';
     marker = delim;
     start = num;
     ordered = true;
     markerLen = digits + 1;
   } else { restore(l, save); return null; }
   advance(l, 1); // past the bullet, or past the '.' / ')' delimiter
   // marker must be followed by space/tab or end of line
   const after = peek(l);
   if (after !== -1 && after !== 32 && after !== 9) { restore(l, save); return null; }
   return { ordered, delim, marker, start, markerLen, indent: ind };
 }
 // Compute a list item's content indent from the marker info and the spaces
 // following the marker. Consumes the spaces; returns contentIndent.
 function listContentIndent(l, marker) {
   const base = marker.indent + marker.markerLen;
   // Count the whitespace columns after the marker (up to 5: only the
   // 1-4 vs 5+ distinction matters). The line is left positioned at the
   // content indent: for 1-4 columns that is just past the whitespace;
   // for 5+ columns it is one column past the marker, so the excess
   // whitespace stays part of the content (it can become indented code).
   const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
   let spaces = 0;
   while (spaces < 5) {
     const c = peek(l);
     if (c === 32 || c === 9) { advance(l, 1); spaces++; }
     else break;
   }
   if (peek(l) === -1) { restore(l, save); return base + 1; } // empty item
   if (spaces >= 1 && spaces <= 4) return base + spaces;
   restore(l, save);
   advance(l, 1);
   return base + 1; // 5+ columns of whitespace
 }
 // Is this line a setext heading underline? Returns 1 or 2 or 0.
 function setextLevel(l) {
   const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
   const ind = indentOf(l);
   if (ind > 3) return 0;
   advance(l, ind);
   const c = peek(l);
   if (c !== 61 && c !== 45) { restore(l, save); return 0; } // '=' or '-'
   while (peek(l) === c) advance(l, 1);
   while (peek(l) === 32 || peek(l) === 9) advance(l, 1);
   if (peek(l) !== -1) { restore(l, save); return 0; }
   return c === 61 ? 1 : 2;
 }
 // Split a table row line into cells on unescaped '|', honouring backslash
 // escapes and code spans (a '|' inside backticks is not a separator).
 function splitTableRow(s) {
   const cells = [];
   let cur = '';
   let i = 0, n = s.length;
   let inCode = 0; // backtick run length of open code span, 0 when outside
   let poisoned = false; // an unclosed opener: no more code spans in this row
   while (i < n) {
     const c = s.charCodeAt(i);
     if (c === 92 && i + 1 < n && isEscapable(s.charCodeAt(i + 1))) { cur += s[i + 1]; i += 2; continue; }
     if (c === 96) {
       let run = 0;
       while (i + run < n && s.charCodeAt(i + run) === 96) run++;
       if (!poisoned && inCode === 0) {
         // only open a code span if a matching closing run exists later;
         // otherwise the backticks are literal and '|' still splits, and
         // no later backtick run in this row opens a span either
         let j = i + run, closed = false;
         while (j < n) {
           if (s.charCodeAt(j) === 96) {
             let r2 = 0;
             while (j + r2 < n && s.charCodeAt(j + r2) === 96) r2++;
             if (r2 === run) { closed = true; break; }
             j += r2;
           } else j++;
         }
         if (closed) inCode = run;
         else poisoned = true;
       } else if (run === inCode) inCode = 0;
       cur += s.slice(i, i + run); i += run; continue;
     }
     if (c === 124 && inCode === 0) { cells.push(cur); cur = ''; i++; continue; }
     cur += s[i]; i++;
   }
   cells.push(cur);
   return cells;
 }
 // Trim outer empty cells when the line starts/ends with '|', and trim spaces.
 function tableCells(s) {
   let cells = splitTableRow(s);
   // leading/trailing pipe produces empty first/last cell
   const trimmed = s.replace(/^[ \t]+/, '');
   if (trimmed.charCodeAt(0) === 124) cells = cells.slice(1);
   const rtrimmed = s.replace(/[ \t]+$/, '');
   if (rtrimmed.charCodeAt(rtrimmed.length - 1) === 124) cells = cells.slice(0, -1);
   return cells.map(c => c.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));
 }
 // Is this line a table delimiter row? Returns aligns array or null.
 // The check runs on the RAW line: backslash escapes are not resolved
 // here, so '\---' (an escaped dash) is not a delimiter row.
 function tableDelimiter(s) {
   // split on unescaped '|' without unescaping anything else
   const cells = [];
   let cur = '';
   for (let i = 0; i < s.length; i++) {
     const c = s.charCodeAt(i);
     if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) { cur += '|'; i++; continue; }
     if (c === 124) { cells.push(cur); cur = ''; continue; }
     cur += s[i];
   }
   cells.push(cur);
   let list = cells;
   const trimmed = s.replace(/^[ \t]+/, '');
   if (trimmed.charCodeAt(0) === 124) list = list.slice(1);
   const rtrimmed = s.replace(/[ \t]+$/, '');
   if (rtrimmed.charCodeAt(rtrimmed.length - 1) === 124) list = list.slice(0, -1);
   list = list.map(c => c.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));
   if (list.length === 0) return null;
   const aligns = [];
   for (const cell of list) {
     const m = /^(:?)-+(:?)$/.test(cell);
     if (!m) return null;
     const left = cell.charCodeAt(0) === 58;
     const right = cell.charCodeAt(cell.length - 1) === 58;
     aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
   }
   return aligns;
 }

 // Is the unconsumed remainder of the line only spaces/tabs?
 function restIsBlank(l) {
   let i = l.pos;
   if (l.pt) i++; // a partially-consumed tab counts as spaces
   while (i < l.s.length) {
     const c = l.s.charCodeAt(i);
     if (c !== 32 && c !== 9) return false;
     i++;
   }
   return true;
 }

 // ------------------------------------------------------- block parsing ---
 function parseBlocks(src, refs) {
   const root = newBlock('doc', null);
   const stack = [root];
   const lines = src.split('\n');
   let curLi = 0; // index of the line currently being processed

   function tip() { return stack[stack.length - 1]; }

   function finalize(b) {
     if (b.t === 'para') {
       const text = b.lines.join('\n');
       let pos = 0;
       let content = null;
       // strip leading link reference definitions
       while (true) {
         const d = parseRefDef(text, pos);
         if (!d) break;
         if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
         pos = d.end;
         if (pos < text.length && text.charCodeAt(pos) === 10) pos++;
         else if (pos >= text.length) { pos = text.length; break; }
       }
       content = text.slice(pos);
       if (content === '') {
         // paragraph was only reference definitions: drop it
         const sibs = b.parent.children;
         sibs.splice(sibs.indexOf(b), 1);
         return;
       }
       b.src = content;
     } else if (b.t === 'code') {
       // Strip trailing blank lines. A fenced block closed by its fence
       // loses just one (the newline before the closing fence); an
       // unterminated fenced block and indented code lose them all.
       if (b.fenced && b.closedByFence) {
         if (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
       } else {
         while (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
       }
     }
   }
   function popBlock() { const b = stack.pop(); finalize(b); return b; }

   // A blank line counts as "between list items" for the lists it
   // passes through. A genuinely blank line marks every list on the
   // stack; an empty marker line (only '>' / list markers) marks only
   // the list the tip belongs to, if any — a blank line deeper inside
   // an item (e.g. an empty quote line) does not loosen the outer list.
   function markListBlank(l) {
     if (/^[ \t]*$/.test(l.s)) {
       for (let k = 1; k < stack.length; k++) {
         if (stack[k].t === 'list') stack[k].blankBetween = true;
       }
       return;
     }
     const t = tip();
     if (t.t === 'list') t.blankBetween = true;
     else if (t.t === 'item' && t.parent && t.parent.t === 'list') t.parent.blankBetween = true;
   }

   // Add a lazy continuation line to a paragraph. A lazy setext '=' underline
   // inside a blockquote cannot form a heading, so marked renders it indented
   // by 4; any other lazy line loses up to 4 columns of leading indent when
   // it has 4 or more, and keeps its indent otherwise.
   function addLazyLine(para, l) {
     const s = restOf(l);
     const m = /^[ \t]*(=+)[ \t]*$/.exec(s);
     if (m) {
       let inQuote = false;
       for (let q = 1; q < stack.length; q++) if (stack[q].t === 'quote') { inQuote = true; break; }
       if (inQuote) { para.lines.push('    ' + m[1]); para.lastLazy = true; return; }
     }
     if (indentOf(l) >= 4) {
       const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
       advance(l, 4);
       // A leading tab after the 4-column advance expands from the
       // new column when inside a container (l.col > 0).
       const t = restOf(l);
       para.lines.push(l.col > 0 ? expandLeadingTabs(t, l.col) : t);
       restore(l, save);
     } else para.lines.push(l.col > 0 ? expandLeadingTabs(s, l.col) : s);
     para.lastLazy = true;
   }

   // Add a line to the current leaf block (para / code / html / table row).
   // `lazy` marks a paragraph line added as a lazy continuation.
   function addLineToLeaf(b, l, lazy) {
     if (b.t === 'para') {
       // A leading tab on the FIRST line of a paragraph inside a
       // container (blockquote / list item) expands to the next tab
       // stop from the column after the container prefix (e.g.
       // `> \\tindented` -> `  indented`). Continuation lines keep
       // a literal tab (e.g. `foo\\n\\tindented`), and a top-level
       // paragraph never starts with a tab (it would be indented
       // code), so this only fires when lines.length === 0.
       let text = restOf(l);
       // Expand a leading tab when the line sits inside a container
       // (l.col > 0 after the container prefix was stripped): the tab
       // expands to the next tab stop from that column. At the top
       // level (l.col === 0) a tab in paragraph content stays literal
       // (e.g. `foo\n\tindented`). This covers both the first line
       // and continuation lines inside a blockquote / list item.
       if (l.col > 0 && (text.charCodeAt(0) === 9 || (text.charCodeAt(0) === 32 && text.indexOf('\t') !== -1 && /^[^\S\n]*\t/.test(text)))) {
         let col = l.col;
         let k = 0, out = '', expanded = false;
         while (k < text.length && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) {
           if (text.charCodeAt(k) === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; expanded = true; }
           else { out += ' '; col++; }
           k++;
         }
         if (expanded) text = out + text.slice(k);
       }
       b.lines.push(text); b.lastLazy = !!lazy;
     }
     // indented code: a blank line keeps its spaces minus the 4-column
     // code indent (a 6-space blank line stays as 2 spaces); fenced code
     // keeps blank-line spaces as-is.
     else if (b.t === 'code') {
       if (!b.fenced && isBlankLine(l)) {
         const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
         advance(l, Math.min(indentOf(l), 4));
         b.lines.push(restOf(l));
         restore(l, save);
       } else {
         let text = restOf(l);
         // Expand tabs in the leading whitespace of fenced code lines.
         // The tab-stop column is measured from the fence content start:
         // the absolute column minus the fence indent (backtick fences
         // strip it; tilde fences do not) and minus 2 for each '>'
         // marker beyond the first (only the first '>' advances tab
         // stops). A tab at relative column 0 is preserved as-is.
         // Expand tabs in the leading whitespace of fenced code
         // lines — but ONLY when the fence sits inside a container
         // (a blockquote `>` on the line, or an ancestor list item).
         // At the top level there is no container prefix to strip,
         // so a tab is literal content (marked keeps `   \tindented`
         // as 3 spaces + a tab). Inside a container the tab is
         // expanded relative to the container's content column.
         if (b.fenced) {
           let nq = 0;
           for (let q = 0; q < l.pos; q++) if (l.s.charCodeAt(q) === 62) nq++;
           let inItem = false;
           { let anc = b.parent; while (anc) { if (anc.t === 'item') { inItem = true; break; } anc = anc.parent; } }
           if (nq >= 1 || inItem) {
           // Tab-stop column from the fence content start. A backtick
           // fence's indent counts only at the top level (no `>`): in a
           // blockquote it is part of the quote's content column. A list
           // item's content indent counts only when the item sits
           // OUTSIDE the blockquote (list > quote); when the quote is
           // outside the item it does not. A tab at relative col 0 is
           // preserved as-is.
           let col = l.col;
           if (b.fchar === 96 && nq === 0) col -= (b.fenceIndent || 0);
           col -= 2 * Math.max(0, nq - 1);
           if (nq >= 1) {
             let anc = b.parent, sawQuote = false, itemInd = 0;
             while (anc) {
               if (anc.t === 'quote') sawQuote = true;
               else if (anc.t === 'item' && sawQuote) { itemInd = anc.contentIndent || 0; break; }
               anc = anc.parent;
             }
             col -= itemInd;
           }
           if (col < 0) col = 0;
           if (!(text.charCodeAt(0) === 9 && col <= 0)) {
           let k = 0;
           let out = '';
           let expanded = false;
           while (k < text.length && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) {
             if (text.charCodeAt(k) === 9) {
               const w = 4 - (col % 4);
               out += ' '.repeat(w); col += w; expanded = true;
             } else { out += ' '; col++; }
             k++;
           }
           if (expanded) text = out + text.slice(k);
           }
           }
         }
         b.lines.push(text);
       }
     }
     else if (b.t === 'html') b.lines.push(restOf(l));
   }

   // Expand leading tabs in `text` (spaces + tabs at the start) to
   // spaces, using tab stops from column `col`. Used for paragraph
   // lines (first and continuation) and lazy lines inside a container,
   // where a tab expands to the next tab stop; at the top level
   // (col === 0) tabs stay literal, so callers gate on col > 0.
   function expandLeadingTabs(text, col) {
     let k = 0, out = '', expanded = false;
     while (k < text.length && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) {
       if (text.charCodeAt(k) === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; expanded = true; }
       else { out += ' '; col++; }
       k++;
     }
     return expanded ? out + text.slice(k) : text;
   }

   // Append a row to table t from the current line.
   function addTableRow(t, l) {
     const cells = tableCells(restOf(l));
     while (cells.length < t.header.length) cells.push('');
     if (cells.length > t.header.length) cells.length = t.header.length;
     t.rows.push(cells);
   }

   // Try to form a table from a delimiter-row line when the tip is a paragraph.
   // `lazy` is true when the line failed container matching: the table then
   // forms only if the paragraph's last line was a lazy continuation, or the
   // paragraph's parent is a list item. Returns true if a table was formed
   // (the line is consumed). The paragraph's last line becomes the header;
   // any earlier lines remain as a paragraph.
   function tryTable(l, para, lazy) {
     // a delimiter row indented 4+ is indented code, not a table
     if (indentOf(l) >= 4) return false;
     const aligns = tableDelimiter(restOf(l).replace(/^[ \t]+/, ''));
     if (!aligns) return false;
     if (para.lines.length === 0) return false;
     const header = tableCells(para.lines[para.lines.length - 1]);
     if (header.length !== aligns.length) return false;
     if (lazy && !para.lastLazy && !(para.parent && para.parent.t === 'item')) return false;
     const parent = para.parent;
     const idx = parent.children.indexOf(para);
     para.lines.pop();
     popBlock(); // finalizes the remaining paragraph (or drops it)
     const tb = { t: 'table', parent, children: [], lastBlank: false, header, aligns, rows: [] };
     const at = parent.children.indexOf(para);
     if (at !== -1) parent.children.splice(at + 1, 0, tb);
     else parent.children.splice(idx, 0, tb);
     parent.lastBlank = false;
     stack.push(tb);
     return true;
   }

   // Does the line, at its current position, start a block that can interrupt
   // a paragraph? (Used for the lazy-continuation decision.)
   function startsInterruptBlock(l) {
     const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
     // blockquote
     if (matchQuote(l)) { restore(l, save); return true; }
     restore(l, save);
     // ATX heading
     if (tryATX(l)) { restore(l, save); return true; }
     // fenced code
     if (tryFenced(l)) { restore(l, save); return true; }
     // HTML block types 1-6
     const ind = indentOf(l);
     if (ind <= 3) {
       const save2 = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
       advance(l, ind);
       const ht = htmlBlockType(restOf(l));
       restore(l, save2);
       if (ht >= 1 && ht <= 6) { restore(l, save); return true; }
     }
     // thematic break
     if (tryHr(l)) { restore(l, save); return true; }
     // list item: ANY marker is a block start here (the interruption
     // rules — empty items, ordered not starting at 1 — only apply when
     // the containers matched and the paragraph is open)
     const m = tryListMarker(l);
     if (m) { restore(l, save); return true; }
     restore(l, save);
     return false;
   }

   // Try to open new blocks at the current position, in the standard order.
   // Returns true if the line was fully consumed by a block start (heading,
   // fence opener, html opener, hr, setext, table), false if the line still
   // needs to go to a leaf/paragraph. Blockquote/list openers consume a
   // prefix and the loop continues (handled by the caller).
   function processLine(l) {
     // ---- Phase 1: match open containers ----
     let i = 1;
     let allMatched = true;
     while (i < stack.length) {
       const b = stack[i];
       if (b.t === 'quote') {
         if (!matchQuote(l)) { allMatched = false; break; }
       } else if (b.t === 'item') {
         if (!matchItem(l, b)) { allMatched = false; break; }
       } else if (b.t === 'list') {
         // nothing to match
       } else break; // leaf block
       i++;
     }
     if (!allMatched) {
       const t = tip();
       // A fenced code block inside a LIST ITEM takes content lines
       // literally: a line that fails to match the item (e.g. indent 0)
       // is still code content, not a reason to close the block. Only
       // the closing fence (handled in phase 2) ends it. This exemption
       // does NOT apply to blockquotes: a line without the `>` marker
       // still closes the quote (and the code block inside it). It also
       // does not apply while the fence is still empty: a first content
       // line that fails to match the item leaves the block empty and
       // closes the containers instead (e.g. an indent-0 line right
       // after the fence).
       const fb = stack[i];
       const inListItem = fb && fb.t === 'item';
       if (t.t === 'code' && t.fenced && inListItem && t.lines.length > 0) {
         // fall through to phase 2 with containers intact
       } else if (!isBlankLine(l)) {
         // A delimiter row can still form a table on a lazy line when the
         // paragraph's last line was lazy or its parent is a list item.
         // (But not when the line starts a block, e.g. a list item '-'.)
         if (t.t === 'para' && !startsInterruptBlock(l) && tryTable(l, t, true)) return;
         // A lazy table row: the tip is a table and the line starts no block.
         if (t.t === 'table' && !startsInterruptBlock(l)) {
           addTableRow(t, l);
           return;
         }
         // Lazy paragraph continuation: the tip is a paragraph and the line
         // starts no block at this position.
         if (t.t === 'para' && !startsInterruptBlock(l)) {
           addLazyLine(t, l);
           return;
         }
       }
       // Close unmatched containers. When the failing container is a list
       // item, the line may be a new item of the same list (then only the
       // item closes); otherwise the item's list closes too.
       // (Skipped for a fenced-code tip inside a list item with content:
       // the line is code content.)
       if (!(t.t === 'code' && t.fenced && inListItem && t.lines.length > 0)) {
         let closeTo = i;
         const fb = stack[i];
         if (fb.t === 'item') {
           const list = fb.parent;
           const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
           const m = tryListMarker(l);
           restore(l, save);
           if (!(m && m.ordered === list.ordered && m.marker === list.marker)) {
             closeTo = i - 1; // close the list as well
           }
         }
         while (stack.length > closeTo) popBlock();
       }
     }

     // ---- Phase 2: handle the line against the current tip ----
     let t = tip();
     // Leaf tips consume the line directly.
     if (t.t === 'code') {
       if (t.fenced) {
         if (isClosingFence(l, t)) { t.closedByFence = true; popBlock(); return; }
         // strip up to the opening fence's indent from content lines,
         // but only for BACKTICK fences: a tilde fence never strips its
         // indent (marked keeps the content's leading spaces as-is).
         let rem = (t.fchar === 96) ? (t.fenceIndent || 0) : 0;
         while (rem > 0) {
           const cc = peek(l);
           if (cc === 32 || cc === 9) { advance(l, 1); rem--; }
           else break;
         }
         addLineToLeaf(t, l);
         return;
       }
       // indented code: blank lines are content; a non-blank line with
       // indent < 4 ends the block.
       if (isBlankLine(l)) { addLineToLeaf(t, l); return; }
       if (indentOf(l) < 4) { popBlock(); /* fall through to fresh parse */ }
       else { advance(l, 4); addLineToLeaf(t, l); return; }
       t = tip();
     }
     if (t.t === 'html') {
       if (isBlankLine(l) && (t.htype === 6 || t.htype === 7)) {
         popBlock();
         for (const b of stack) b.lastBlank = true;
         markListBlank(l);
         return;
       }
       const raw = restOf(l);
       addLineToLeaf(t, l);
       if (t.htype >= 1 && t.htype <= 5 && htmlBlockEnds(raw, t.htype)) {
         // ends here; a trailing newline when a further line follows
         if (curLi < lines.length - 1) t.lines.push('');
         popBlock();
       }
       return;
     }
     if (t.t === 'table') {
       // A line of only spaces ends the table, but a line containing a
       // tab is a (possibly empty) row, not a blank line.
       if (isBlankLine(l) && !restOf(l).includes('\t')) { popBlock(); for (const b of stack) b.lastBlank = true; markListBlank(l); return; }
       if (!tableRowLine(l, t)) { popBlock(); /* fall through */ }
       else return;
       t = tip();
     }
     if (t.t === 'para') {
       if (isBlankLine(l)) {
         // A line that is only spaces after a '>' marker was consumed still
         // contributes those spaces as paragraph content (spec ex. 241);
         // a truly empty remainder is a blank line.
         const rest = restOf(l);
         if (rest.length > 0) {
           let inQuote = false;
           for (let q = 1; q < stack.length; q++) if (stack[q].t === 'quote') { inQuote = true; break; }
           if (inQuote) { addLineToLeaf(t, l); return; }
         }
         popBlock();
        for (const b of stack) b.lastBlank = true;
        markListBlank(l);
        return;
       }
       // setext heading? (replaces the paragraph in place; a paragraph that
       // was only reference definitions produces no heading — the underline
       // line then starts a fresh paragraph instead)
       const slSave = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
       const sl = setextLevel(l);
       if (sl) {
         const para = tip();
         const parent = para.parent;
         popBlock(); // finalizes the paragraph (ref defs stripped, or dropped)
         if (para.src === undefined) {
           restore(l, slSave); // the underline line is paragraph content
           const p = newBlock('para', parent);
           p.lines = [];
           p.lastLazy = false;
           stack.push(p);
           // fall through: the underline line joins the fresh paragraph
         } else {
           const h = { t: 'heading', parent, children: [], lastBlank: false, level: sl, src: para.src.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') };
           parent.children[parent.children.indexOf(para)] = h;
           parent.lastBlank = false;
           return;
         }
       }
       // table? (containers matched: the last line becomes the header,
       // any earlier lines remain as a paragraph)
       if (tryTable(l, t, false)) return;
       // fall through to the new-block-start loop (interrupting blocks)
     }

     // ---- Phase 3: try to start new blocks (loop for quote/list prefixes) ----
     while (true) {
       t = tip();
       if (isBlankLine(l)) {
         if (t.t === 'para' || t.t === 'heading' || t.t === 'hr') popBlock();
         // A blank line after an HTML block drops its tentative trailing
         // newline (the block is not followed by content on the next
         // line) — but only a truly empty line does this; a line with
         // only spaces/tabs keeps the trailing newline.
         const par = tip();
         if (par.children.length > 0 && restOf(l) === '') {
           const last = par.children[par.children.length - 1];
           if (last.t === 'html' && last.lines.length > 0 && last.lines[last.lines.length - 1] === '') last.lines.pop();
         }
         // A genuinely blank source line marks open items as having seen
         // a blank (an empty item's own marker line does not count).
         if (/^[ \t]*$/.test(l.s)) {
           for (const b of stack) if (b.t === 'item') b.blankAfter = true;
         }
         for (const b of stack) b.lastBlank = true;
         markListBlank(l);
         return;
       }
       // blockquote (interrupts a paragraph: close it first; a list
       // between items is closed too — only items live in a list)
       if (tryQuote(l)) {
         if (t.t === 'para' || t.t === 'list') popBlock();
         const q = newBlock('quote', tip());
         stack.push(q);
         continue;
       }
       // ATX heading
       const atx = tryATX(l);
       if (atx) {
         if (t.t === 'para' || t.t === 'list') popBlock();
         const h = newBlock('heading', tip());
         h.level = atx.level; h.src = atx.src;
         return;
       }
       // fenced code
       const fen = tryFenced(l);
       if (fen) {
         if (t.t === 'para' || t.t === 'list') popBlock();
         const c = newBlock('code', tip());
         c.fenced = true; c.fchar = fen.fchar; c.flen = fen.flen; c.info = fen.info; c.lines = [];
         c.fenceIndent = fen.indent;
         stack.push(c);
         return;
       }
       // HTML block
       const ind = indentOf(l);
       if (ind <= 3) {
         const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
         advance(l, ind);
         const ht = htmlBlockType(restOf(l));
         restore(l, save);
         if (ht !== 0 && !(ht === 7 && t.t === 'para')) {
           if (t.t === 'para' || t.t === 'list') popBlock();
           const h = newBlock('html', tip());
           h.htype = ht; h.lines = [restOf(l)];
           // Types 1-5: the end condition is checked on the opening line
           // too (e.g. '<!-- -->' ends at once). A block that ends here
           // carries a trailing newline when a further line follows.
           if (ht >= 1 && ht <= 5 && htmlBlockEnds(restOf(l), ht)) {
             if (curLi < lines.length - 1) h.lines.push('');
           } else {
             stack.push(h);
           }
           return;
         }
       }
       // thematic break
       if (tryHr(l)) {
         if (t.t === 'para' || t.t === 'list') popBlock();
         newBlock('hr', tip());
         return;
       }
       // list item
       const listSave = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
       const m = tryListMarker(l);
       if (m) {
         if (t.t === 'para') {
           // Interruption rules: an empty item never interrupts a paragraph,
           // and an ordered list must start at 1 to interrupt one — except
           // when the paragraph is inside a list item, where a nested list
           // may start at any number.
           if (restIsBlank(l) || (m.ordered && m.start !== 1 && t.parent.t !== 'item')) {
             restore(l, listSave);
             addLineToLeaf(t, l);
             return;
           }
           popBlock();
           t = tip();
         }
         // Join the open list only when the tip IS a list of the same kind
         // (same ordered-ness and marker); a closed list never resumes.
         let list = null;
         if (t.t === 'list' && t.ordered === m.ordered && t.marker === m.marker) {
           list = t;
         } else {
           list = newBlock('list', t);
           list.ordered = m.ordered;
           list.delim = m.delim;
           list.marker = m.marker;
           list.start = m.start;
           list.tight = true;
           stack.push(list);
         }
         // A blank line between items (at the list's own level)
         // loosens the list.
         if (list.blankBetween) { list.tight = false; list.blankBetween = false; }
         const item = newBlock('item', list);
         item.contentIndent = listContentIndent(l, m);
         stack.push(item);
         // An empty item consumes its line outright; it is not a blank line
         // (so it must not loosen the list via lastBlank).
         if (restIsBlank(l)) return;
         continue;
       }
       // indented code (never interrupts a paragraph)
       if (t.t !== 'para' && indentOf(l) >= 4) {
         if (t.t === 'list') { popBlock(); t = tip(); }
         advance(l, 4);
         const c = newBlock('code', tip());
         c.fenced = false; c.lines = [restOf(l)];
         stack.push(c);
         return;
       }
       // otherwise: paragraph (create if needed) and add the line
       if (t.t === 'list') { popBlock(); t = tip(); }
       if (t.t !== 'para') {
         const p = newBlock('para', tip());
         p.lines = [];
         p.lastLazy = false;
         stack.push(p);
         t = p;
       }
       for (const b of stack) b.lastBlank = false;
       addLineToLeaf(t, l);
       return;
     }
   }

   // Is this line a table row for table t? If yes, append the row and return
   // true. A row line must be non-blank and not start a new block construct.
   function tableRowLine(l, t) {
     // a row line cannot start a blockquote, heading, fence, html block,
     // thematic break, or list item
     const save = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
     if (matchQuote(l)) { restore(l, save); return false; }
     if (tryATX(l)) { restore(l, save); return false; }
     if (tryFenced(l)) { restore(l, save); return false; }
     const ind = indentOf(l);
     if (ind <= 3) {
       const s2 = { pos: l.pos, col: l.col, pt: l.pt, pr: l.pr };
       advance(l, ind);
       if (htmlBlockType(restOf(l)) !== 0) { restore(l, save); return false; }
       restore(l, s2);
     }
     if (tryHr(l)) { restore(l, save); return false; }
     if (tryListMarker(l)) { restore(l, save); return false; }
     restore(l, save);
     addTableRow(t, l);
     return true;
   }

   for (let li = 0; li < lines.length; li++) { curLi = li; processLine(makeLine(lines[li])); }
   while (stack.length > 1) popBlock();
   // An HTML block that is the last block in the document gets a trailing
   // newline when the input ends with one (its lines are joined by '\n').
   if (src.charCodeAt(src.length - 1) === 10) {
     let lb = root;
     while (lb.children.length > 0) lb = lb.children[lb.children.length - 1];
     if (lb.t === 'html' && lb.lines[lb.lines.length - 1] !== '') lb.lines.push('');
   }
   return root;
 }

 // ---------------- inline parsing ----------------
 // Inline node types: 0 text(raw) 1 code(raw) 2 html(raw) 3 br 4 softbr
 // 5 delim 6 em 7 strong 8 del 9 link 10 image 11 entity(raw, pass-through)

 // Flanking for a delimiter run in src[start..end).
 function delimFlanking(src, start, end) {
   const before = start > 0 ? src.charCodeAt(start - 1) : -1;
   const after = end < src.length ? src.charCodeAt(end) : -1;
   // At the start/end of the inline string the (absent) neighbour counts as
   // whitespace: the paragraph's line ending is a newline, and the start is
   // preceded by the block boundary. NBSP (U+00A0) is Unicode whitespace
   // for flanking purposes.
   const beforeIsSpace = before === -1 || isSpaceCode(before) || before === 160;
   const afterIsSpace = after === -1 || isSpaceCode(after) || after === 160;
   const beforeIsPunct = before !== -1 && isFlankPunctCode(before);
   const afterIsPunct = after !== -1 && isFlankPunctCode(after);
   const leftFlanking = !afterIsSpace && (!afterIsPunct || beforeIsSpace || beforeIsPunct);
   const rightFlanking = !beforeIsSpace && (!beforeIsPunct || afterIsSpace || afterIsPunct);
   return { leftFlanking, rightFlanking, beforeIsPunct, afterIsPunct };
 }

 // Is this char valid inside an email local part?
 function isEmailLocalChar(c) {
   return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
     c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
     c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 ||
     c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
 }
 // Is this char valid inside an email domain label?
 function isEmailDomainChar(c) {
   return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
 }

 // Validate an email candidate (local@domain). The domain must contain a dot
 // and its last label must be all letters.
 function isValidEmail(s) {
   const at = s.indexOf('@');
   if (at <= 0) return false;
   const local = s.slice(0, at);
   const domain = s.slice(at + 1);
   if (local.length === 0 || domain.length === 0) return false;
   for (let k = 0; k < local.length; k++) if (!isEmailLocalChar(s.charCodeAt(k))) return false;
   // local part may not start/end with a dot or have consecutive dots
   if (local.charCodeAt(0) === 46 || local.charCodeAt(local.length - 1) === 46) return false;
   if (local.indexOf('..') !== -1) return false;
   const dot = domain.lastIndexOf('.');
   if (dot <= 0 || dot === domain.length - 1) return false;
   const tld = domain.slice(dot + 1);
   for (let k = 0; k < tld.length; k++) {
     const c = tld.charCodeAt(k);
     if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
   }
   // domain labels: letters/digits/'-'/'_', separated by dots, non-empty
   const labels = domain.split('.');
   for (const lab of labels) {
     if (lab.length === 0) return false;
     for (let k = 0; k < lab.length; k++) if (!isEmailDomainChar(lab.charCodeAt(k))) return false;
   }
   return true;
 }

 // Trailing-punctuation set for autolink trimming.
 function isAutolinkTrailPunct(c) {
   return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
     c === 42 || c === 95 || c === 126 || c === 39 || c === 34;
 }
 // Is the ')' at position j (the last char of s) part of a \(...\) group
 // whose content has no parens? (scan back for the nearest '(' with only
 // non-paren chars between it and j)
 function isGroupedCloseParen(s, j) {
   let k = j - 1;
   while (k >= 0) {
     const c = s.charCodeAt(k);
     if (c === 40) return true; // '('
     if (c === 41) return false; // ')'
     k--;
   }
   return false;
 }
 // Trim a URL/email autolink candidate: truncate at the first '(' that has no
 // ')' after it, then strip trailing punctuation and ungrouped trailing ')'.
 // A trailing entity-like "&word;" is also excluded from the link.
 function trimAutolink(s) {
   // truncate at first '(' with no ')' after it
   let cut = -1;
   for (let k = 0; k < s.length; k++) {
     if (s.charCodeAt(k) === 40) { // '('
       if (s.indexOf(')', k) === -1) { cut = k; break; }
     }
   }
   if (cut !== -1) s = s.slice(0, cut);
   // strip trailing punctuation / ungrouped ')'
   let end = s.length;
   let strippedSemi = false;
   while (end > 0) {
     const c = s.charCodeAt(end - 1);
     if (isAutolinkTrailPunct(c)) { if (c === 59) strippedSemi = true; end--; continue; }
     if (c === 41 && !isGroupedCloseParen(s, end - 1)) { end--; continue; }
     break;
   }
   s = s.slice(0, end);
   // strip a trailing entity-like "&word" (only when its ';' was stripped above)
   if (strippedSemi) {
     const amp = s.lastIndexOf('&');
     if (amp !== -1) {
       let ok = amp < s.length - 1;
       for (let k = amp + 1; k < s.length && ok; k++) {
         const c = s.charCodeAt(k);
         if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) ok = false;
       }
       if (ok) s = s.slice(0, amp);
     }
   }
   return s;
 }

 // Try a standard <...> autolink at src[i]. Returns {href, text, end} or null.
 // text is the display text (raw), href is the href value.
 function tryStdAutolink(src, i) {
   const n = src.length;
   let j = i + 1;
   // scheme: letter, then letters/digits/+/./-, 2-32 chars, then ':'
   if (j < n && isAlpha(src.charCodeAt(j))) {
     let k = j;
     while (k < n) {
       const c = src.charCodeAt(k);
       if (isAlnum(c) || c === 43 || c === 46 || c === 45) k++;
       else break;
     }
     const schemeLen = k - j;
     if (schemeLen >= 2 && schemeLen <= 32 && k < n && src.charCodeAt(k) === 58) {
       // rest: no spaces/control/'<', ends with '>'
       let m = k + 1;
       while (m < n) {
         const c = src.charCodeAt(m);
         if (c === 62) {
           const inner = src.slice(i + 1, m);
           return { href: inner, text: inner, end: m + 1 };
         }
         if (c === 32 || c === 10 || c < 32 || c === 60) return null;
         m++;
       }
       return null;
     }
   }
   // email: local@domain, ends with '>'
   let m = j;
   while (m < n && src.charCodeAt(m) !== 62) {
     const c = src.charCodeAt(m);
     if (c === 32 || c === 10 || c < 32 || c === 60) return null;
     m++;
   }
   if (m < n && m > j) {
     const inner = src.slice(j, m);
     if (inner.indexOf('@') !== -1 && isValidEmail(inner)) {
       return { href: 'mailto:' + inner, text: inner, end: m + 1 };
     }
   }
   return null;
 }

 // Try a raw HTML construct at src[i] ('<'). Returns {end} or null.
 function tryRawHtml(src, i) {
   const n = src.length;
   if (src.startsWith('<!--', i)) {
     // <!--> and <!---> are complete (empty) comments
     if (i + 4 < n && src.charCodeAt(i + 4) === 62) return { end: i + 5 };
     if (i + 5 < n && src.charCodeAt(i + 4) === 45 && src.charCodeAt(i + 5) === 62) return { end: i + 6 };
     const e = src.indexOf('-->', i + 4);
     if (e !== -1) return { end: e + 3 };
     return null;
   }
   if (src.startsWith('<?', i)) {
     const e = src.indexOf('?>', i + 2);
     if (e !== -1) return { end: e + 2 };
     return null;
   }
   if (src.startsWith('<![CDATA[', i)) {
     const e = src.indexOf(']]>', i + 9);
     if (e !== -1) return { end: e + 3 };
     return null;
   }
   if (src.startsWith('<!', i) && i + 2 < n && isAlpha(src.charCodeAt(i + 2))) {
     const e = src.indexOf('>', i + 2);
     if (e !== -1) return { end: e + 1 };
     return null;
   }
   const tag = matchHtmlTag(src, i);
   if (tag) return { end: tag.end };
   return null;
 }

 // Try to parse a link/image starting at src[i] ('[' or '![').
 // Returns {node, end} or null. The label text is parsed inline for children.
 // Does a well-formed inline link `(dest "title")` start at j?
 function inlineLinkParses(src, j) {
   const n = src.length;
   let k = j + 1;
   while (k < n && isSpaceCode(src.charCodeAt(k))) k++;
   let d;
   if (k < n && src.charCodeAt(k) === 41) d = { dest: '', end: k };
   else d = parseLinkDest(src, k);
   if (!d) return false;
   let m = d.end;
   while (m < n && isSpaceCode(src.charCodeAt(m))) m++;
   if (m < n && (src.charCodeAt(m) === 34 || src.charCodeAt(m) === 39 || src.charCodeAt(m) === 40)) {
     const tt = parseLinkTitle(src, m);
     if (tt) { m = tt.end; while (m < n && isSpaceCode(src.charCodeAt(m))) m++; }
   }
   return m < n && src.charCodeAt(m) === 41;
 }
 function tryParseLink(src, i, refs, isImage) {
   const bracketPos = isImage ? i + 1 : i;
   const lab = parseLinkLabel(src, bracketPos, true);
   if (!lab) return null;
   const labelText = lab.text;
   let j = lab.end;
   let dest = null, title = null;
   // inline link: (dest "title")
   if (j < src.length && src.charCodeAt(j) === 40) {
     let k = j + 1;
     while (k < src.length && isSpaceCode(src.charCodeAt(k))) k++;
     let d;
     if (k < src.length && src.charCodeAt(k) === 41) {
       d = { dest: '', end: k }; // empty destination: [link]()
     } else {
       d = parseLinkDest(src, k);
     }
     if (d) {
       let m = d.end;
       while (m < src.length && isSpaceCode(src.charCodeAt(m))) m++;
       let t = null;
       if (m < src.length && (src.charCodeAt(m) === 34 || src.charCodeAt(m) === 39 || src.charCodeAt(m) === 40)) {
         const tt = parseLinkTitle(src, m);
         if (tt) { t = tt.title; m = tt.end; while (m < src.length && isSpaceCode(src.charCodeAt(m))) m++; }
       }
       if (m < src.length && src.charCodeAt(m) === 41) {
         dest = d.dest; title = t;
         return finishLink(src, i, labelText, dest, title, m + 1, refs, isImage);
       }
     }
     // inline link failed: fall back to the shortcut reference, leaving
     // the "(...)" as literal text
     const ref = refs.get(normalizeLabel(labelText));
     if (ref) return finishLink(src, i, labelText, ref.dest, ref.title, j, refs, isImage);
     return null;
   }
   // collapsed reference: [] (must come before full reference, since
   // an empty second label parses as a label)
   if (j + 1 < src.length && src.charCodeAt(j) === 91 && src.charCodeAt(j + 1) === 93) {
     const ref = refs.get(normalizeLabel(labelText));
     if (ref) return finishLink(src, i, labelText, ref.dest, ref.title, j + 2, refs, isImage);
     return null;
   }
   // full reference: [label2]
   if (j < src.length && src.charCodeAt(j) === 91) {
     const lab2 = parseLinkLabel(src, j, false);
     if (lab2) {
       const ref = refs.get(normalizeLabel(lab2.text));
       if (ref) return finishLink(src, i, labelText, ref.dest, ref.title, lab2.end, refs, isImage);
     }
     return null;
   }
   // shortcut reference
   const ref = refs.get(normalizeLabel(labelText));
   if (ref) return finishLink(src, i, labelText, ref.dest, ref.title, j, refs, isImage);
   return null;
 }

 // Build the link/image node from a parsed label + destination.
 // A link whose label contains a link is not a link (links cannot nest).
 function finishLink(src, i, labelText, dest, title, end, refs, isImage) {
   // GFM bare-URL/email autolinks do not form inside a link label;
   // only <...> autolinks may nest.
   const children = parseInline(labelText, refs, true);
   if (!isImage) {
     if (containsLink(children)) return null;
     return { node: { t: 9, href: dest, title, children }, end };
   }
   const alt = altText(children);
   return { node: { t: 10, src: dest, alt, title }, end };
 }
 function containsLink(nodes) {
   for (const nd of nodes) {
     // autolinks (GFM extension) do not count: a link may contain one
     if (nd.t === 9 && !nd.auto) return true;
     if (nd.children && containsLink(nd.children)) return true;
   }
   return false;
 }
 // Plain-text content of inline nodes (for image alt text).
 function altText(nodes) {
   let s = '';
   for (const nd of nodes) {
     if (nd.t === 0) s += nd.s.replace(/&(amp|lt|gt|quot|#39);/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m]));
     else if (nd.t === 1 || nd.t === 11) s += nd.s;
     else if (nd.t === 3 || nd.t === 4) s += ' ';
     else if (nd.t === 10) s += nd.alt;
     else if (nd.children) s += altText(nd.children);
   }
   return s;
 }

 // Process emphasis delimiters in `nodes` using the delimiter entries in
 // `delims` (each {ch, len, canOpen, canClose, node}). Wraps matched ranges
 // in em/strong/del nodes. Mutates `nodes` in place.
 function processEmphasis(nodes, delims) {
   for (let ci = 0; ci < delims.length; ci++) {
     const closer = delims[ci];
     if (!closer.canClose || closer.len === 0) continue;
     // find the nearest matching opener before ci
     let oi = ci - 1;
     let opener = null;
     while (oi >= 0) {
       const cand = delims[oi];
       if (cand.ch === closer.ch && cand.canOpen && cand.len > 0) {
         // an opener already wrapped inside an emphasis node is not
         // available at this level: keep searching further back
         if (nodes.indexOf(cand.node) === -1) { oi--; continue; }
         if (cand.ch === '~') {
           // tilde: opener and closer must have equal lengths (1 or 2)
           if (cand.len === closer.len && cand.len <= 2) { opener = cand; break; }
           oi--; continue;
         }
         // rule of 3
         if ((cand.canClose || closer.canOpen) &&
             ((cand.len + closer.len) % 3 === 0) &&
             !(cand.len % 3 === 0 && closer.len % 3 === 0)) {
           oi--; continue;
         }
         // A single closer must not steal one delimiter from a longer
         // opener when the sum is a multiple of 3 and a later closer
         // could pair with that opener to form strong emphasis instead
         // (e.g. `**a *b*c* d**`: the `*` after `c` stays literal so
         // the trailing `**` can close the `**` opener as strong).
         if (cand.len >= 2 && closer.len === 1 &&
             ((cand.len + closer.len) % 3 === 0) &&
             !(cand.len % 3 === 0 && closer.len % 3 === 0)) {
           let laterStrong = false;
           for (let li = ci + 1; li < delims.length; li++) {
             const ld = delims[li];
             if (ld.ch === closer.ch && ld.len >= 2 && ld.canClose) { laterStrong = true; break; }
           }
           if (laterStrong) { oi--; continue; }
         }
         // A strong inner emphasis whose closing delimiter can both
         // open and close, while its opening delimiter cannot, blocks
         // an outer EM pairing when it lies between the opener and
         // this closer but is NOT immediately adjacent to the closer:
         // e.g. `*a **b**c*` and `**x *y **z**w* v**` leave the single
         // `*` literal. It does NOT block when the strong wrapper is
         // immediately before the closer (`*then is **x***` forms the
         // outer em), when the inner closer cannot both open and close
         // (`*a **b** c*` forms), when the kinds match, or when the
         // inner opener can both open and close (`*foo**bar**baz*`).
         // An em inner blocks a strong outer only when it sits exactly
         // one text node before the closer (`**a *b*one**` leaves the
         // outer `**` literal); further back it does not
         // (`**a *b*c* d**` forms the strong).
         {
           const oIdx0 = nodes.indexOf(cand.node);
           const cIdx0 = nodes.indexOf(closer.node);
           if (oIdx0 !== -1 && cIdx0 !== -1 && cIdx0 > oIdx0 + 1) {
             const outerUse = (cand.len >= 2 && closer.len >= 2) ? 2 : 1;
             if (outerUse === 1) {
               let blocked = false;
               for (let wi = oIdx0 + 1; wi < cIdx0 - 1 && !blocked; wi++) {
                 const w = nodes[wi];
                 if (w && w.t === 7 && w.ch === closer.ch &&
                     w.closerCanBoth && !w.openerCanBoth) blocked = true;
               }
               if (blocked) { oi--; continue; }
             } else if (closer.len === 2) {
               // only when the closer is fully consumed (no leftover):
               // `**a *b*one**` leaves the outer `**` literal, but
               // `**a *b*one***` (leftover `*`) forms the strong.
               const before = nodes[cIdx0 - 1];
               if (before && before.t === 0 && cIdx0 - 2 > oIdx0) {
                 const b2 = nodes[cIdx0 - 2];
                 if (b2 && b2.t === 6 && b2.ch === closer.ch &&
                     b2.closerCanBoth && !b2.openerCanBoth) { oi--; continue; }
               }
             }
           }
         }
         opener = cand; break;
       }
       oi--;
     }
     if (!opener) continue;
     let use;
     if (opener.ch === '~') use = opener.len;
     else use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
     const oIdx = nodes.indexOf(opener.node);
     const cIdx = nodes.indexOf(closer.node);
     if (oIdx === -1 || cIdx === -1 || cIdx <= oIdx) continue;
     const inner = nodes.slice(oIdx + 1, cIdx);
     const tag = opener.ch === '~' ? 8 : (use === 2 ? 7 : 6);
     const wrapper = { t: tag, children: inner, ch: opener.ch, closerCanBoth: closer.canOpen && closer.canClose, openerCanBoth: opener.canOpen && opener.canClose };
     opener.len -= use;
     closer.len -= use;
     opener.node.len = opener.len;
     closer.node.len = closer.len;
     // A leftover closer delimiter normally renders after the wrapper,
     // but when the wrapper holds a same-char em and the final inner
     // node is text attached directly to it (no leading space), the
     // leftover renders inside, just before the closing tag
     // (`**a *b*one***` -> `<strong>a <em>b</em>one*</strong>`).
     let closerInside = false;
     if (tag === 7 && closer.len > 0 && inner.length > 0) {
       const lastInner = inner[inner.length - 1];
       if (lastInner.t === 0 && lastInner.s.charCodeAt(0) !== 32) {
         for (const nd of inner) {
           if (nd.t === 6 && nd.ch === closer.ch) { closerInside = true; break; }
         }
       }
     }
     const repl = [];
     if (opener.len > 0) repl.push(opener.node);
     if (closerInside) wrapper.children.push(closer.node);
     repl.push(wrapper);
     if (closer.len > 0 && !closerInside) repl.push(closer.node);
     nodes.splice(oIdx, cIdx - oIdx + 1, ...repl);
     if (closer.len > 0 && !closerInside) ci--; // reprocess this closer
   }
 }

 // Parse inline content into a node list. `refs` maps normalized labels to
 // {dest, title} for reference links.
 // Document-level flag: an unclosed INLINE <a> opening tag suppresses
 // GFM bare-URL/email autolinks in later inline parsing (marked quirk:
 // only an inline </a> clears it; a block-level <a> never sets it).
 let inAnchor = false;
 function parseInline(src, refs, inLabel, noEmphasis) {
   const out = [];
   const delims = [];
   const n = src.length;
   let i = 0;
   let textStart = 0;
   function flushText(upto) {
     if (upto > textStart) {
       const s = escapeHtml(src.slice(textStart, upto));
       const last = out[out.length - 1];
       if (last && last.t === 0) last.s += s;
       else out.push({ t: 0, s });
     }
     textStart = upto;
   }
   function pushRaw(s) {
     s = escapeHtml(s);
     const last = out[out.length - 1];
     if (last && last.t === 0) last.s += s;
     else out.push({ t: 0, s });
   }
   // Find a code span starting at i (backtick run). Returns {content, end} or null.
   function codeSpanAt(pos) {
     let j = pos;
     while (j < n && src.charCodeAt(j) === 96) j++;
     const len = j - pos;
     let k = j;
     while (k < n) {
       if (src.charCodeAt(k) === 96) {
         let m = k;
         while (m < n && src.charCodeAt(m) === 96) m++;
         if (m - k === len) {
           let content = src.slice(j, k).replace(/\n/g, ' ');
           if (content.length >= 2 && content.charCodeAt(0) === 32 &&
               content.charCodeAt(content.length - 1) === 32) {
             let allSpace = true;
             for (let q = 0; q < content.length; q++) {
               if (content.charCodeAt(q) !== 32) { allSpace = false; break; }
             }
             if (!allSpace) content = content.slice(1, -1);
           }
           return { content, end: m };
         }
         k = m;
       } else k++;
     }
     return null;
   }
   // Try a GFM extended autolink starting at pos (www. / scheme / email is
   // checked by the caller at the right trigger). Returns {href, text, end} or null.
   function extAutolinkAt(pos) {
     // www.
     if (src.startsWith('www.', pos)) {
       let k = pos + 4;
       // domain: at least one domain char; then the maximal run
       let m = k;
       while (m < n) {
         const c = src.charCodeAt(m);
         if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
         m++;
       }
       if (m === k) return null;
       const raw = src.slice(pos, m);
       const trimmed = trimAutolink(raw);
       if (trimmed.length === 0) return null;
       // the domain part (up to '/', '?', '#', ':') must be non-empty labels
       let dEnd = trimmed.length;
       for (let q = 0; q < trimmed.length; q++) {
         const c = trimmed.charCodeAt(q);
         if (c === 47 || c === 63 || c === 35 || c === 58) { dEnd = q; break; }
       }
       const domain = trimmed.slice(0, dEnd);
       if (domain.length === 0) return null;
       const labels = domain.split('.');
       for (const lab of labels) {
         if (lab.length === 0) return null;
         for (let q = 0; q < lab.length; q++) {
           const c = lab.charCodeAt(q);
           // a backslash is a valid URL char here (percent-encoded in
           // the href, e.g. www.flux.com\ -> http://www.flux.com%5C)
           if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95 || c === 92)) return null;
         }
       }
       return { href: 'http://' + trimmed, text: trimmed, end: pos + trimmed.length };
     }
     // scheme:// (http, https, ftp — case-insensitive)
     const rest = src.slice(pos, pos + 8).toLowerCase();
     let scheme = null;
     if (rest.startsWith('https://')) scheme = 'https://';
     else if (rest.startsWith('http://')) scheme = 'http://';
     else if (rest.startsWith('ftp://')) scheme = 'ftp://';
     if (scheme) {
       const after = pos + scheme.length;
       let m = after;
       while (m < n) {
         const c = src.charCodeAt(m);
         if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
         m++;
       }
       if (m === after) return null;
       const raw = src.slice(pos, m);
       const trimmed = trimAutolink(raw);
       if (trimmed.length <= scheme.length) return null;
       return { href: trimmed, text: trimmed, end: pos + trimmed.length };
     }
     // mailto: (lowercase only) + email; a trailing "/..." is not part
     // of the address (only the email itself links)
     if (src.startsWith('mailto:', pos)) {
       const after = pos + 7;
       let m = after;
       while (m < n) {
         const c = src.charCodeAt(m);
         if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
         m++;
       }
       if (m === after) return null;
       const raw = src.slice(pos, m);
       // a trailing '-' or '_' makes the address invalid (not stripped)
       const lastCh = raw.charCodeAt(raw.length - 1);
       if (lastCh === 45 || lastCh === 95) return null;
       const trimmed = trimAutolink(raw);
       // cut at the first '/' — only the email links
       const slash = trimmed.indexOf('/', 7);
       const addr = slash === -1 ? trimmed : trimmed.slice(0, slash);
       const email = addr.slice(7);
       if (isValidEmail(email)) return { href: addr, text: addr, end: pos + addr.length };
       return null;
     }
     // generic scheme: + email (e.g. xmpp:foo@bar.baz), optionally
     // followed by a single path segment (xmpp:foo@bar.baz/txt)
     {
       let k = pos;
       if (k < n && isAlpha(src.charCodeAt(k))) {
         k++;
         while (k < n) {
           const c = src.charCodeAt(k);
           if (isAlnum(c) || c === 43 || c === 46 || c === 45) k++;
           else break;
         }
         const schemeLen = k - pos;
         if (schemeLen >= 2 && schemeLen <= 32 && k < n && src.charCodeAt(k) === 58) {
           const after = k + 1;
           let m = after;
           while (m < n) {
             const c = src.charCodeAt(m);
             if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
             m++;
           }
           if (m > after) {
             const raw = src.slice(pos, m);
             // a trailing '-' or '_' makes the address invalid (not stripped)
             const lastCh = raw.charCodeAt(raw.length - 1);
             if (lastCh === 45 || lastCh === 95) return null;
             const trimmed = trimAutolink(raw);
             const rest = trimmed.slice(schemeLen + 1);
             // the part up to the first '/' must be a valid email
             const slash = rest.indexOf('/');
             const email = slash === -1 ? rest : rest.slice(0, slash);
             if (email.indexOf('@') !== -1 && isValidEmail(email)) {
               // at most one path segment after the email
               let linkEnd = trimmed.length;
               if (slash !== -1) {
                 const secondSlash = rest.indexOf('/', slash + 1);
                 if (secondSlash !== -1) linkEnd = schemeLen + 1 + secondSlash;
               }
               const link = trimmed.slice(0, linkEnd);
               return { href: link, text: link, end: pos + link.length };
             }
           }
         }
       }
     }
     return null;
   }
   // Try an email autolink whose '@' is at pos. The local part is in the
   // pending text just before pos. Returns {href, text, start, end} or null.
   function emailAt(pos) {
     // scan the local part backward from pos-1
     let start = pos;
     while (start > textStart) {
       if (isEmailLocalChar(src.charCodeAt(start - 1))) start--;
       else break;
     }
     if (start === pos) return null;
     // the char before the local part must not be an email-local char
     // (it isn't, by construction) and the local part must be valid
     let m = pos + 1;
     while (m < n) {
       const c = src.charCodeAt(m);
       // a backslash starts an escape: it is not part of the address
       if (c === 32 || c === 9 || c === 10 || c === 60 || c === 92 || c < 32) break;
       m++;
     }
     if (m === pos + 1) return null;
     let raw = src.slice(start, m);
     // A trailing run of 2+ '_' (or '-') is a delimiter, not part of the
     // address: strip it and validate what remains. A SINGLE trailing '-'
     // makes the address invalid (not stripped). A single trailing '_'
     // is stripped only when it is an emphasis closer — i.e. an unmatched
     // '_' opener is available earlier in this inline run (otherwise the
     // address is invalid, e.g. `a.b-c_d@a.b_` or `_foo_ bar@baz.com_`).
     let trail = 0;
     while (trail < raw.length && (raw.charCodeAt(raw.length - 1 - trail) === 95 || raw.charCodeAt(raw.length - 1 - trail) === 45)) trail++;
     if (trail >= 2) raw = raw.slice(0, raw.length - trail);
     else if (trail === 1) {
       if (raw.charCodeAt(raw.length - 1) !== 95) return null;
       let open = 0;
       for (let di = 0; di < delims.length; di++) {
         const d = delims[di];
         if (d.ch !== '_') continue;
         if (d.canClose && open > 0) open--;
         else if (d.canOpen) open++;
       }
       if (open === 0) return null;
       raw = raw.slice(0, raw.length - 1);
     }
     const trimmed = trimAutolink(raw);
     if (trimmed.length === 0 || trimmed.indexOf('@') === -1) return null;
     if (!isValidEmail(trimmed)) return null;
     return { href: 'mailto:' + trimmed, text: trimmed, start, end: start + trimmed.length };
   }

   while (i < n) {
     const c = src.charCodeAt(i);
     if (c === 92) { // backslash
       if (i + 1 < n) {
         const d = src.charCodeAt(i + 1);
         if (d === 10) {
           flushText(i); out.push({ t: 3 }); i += 2;
           // a hard break swallows leading spaces/tabs on the next line
           while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
           textStart = i; continue;
         }
         if (isPunctCode(d)) { flushText(i); pushRaw(src[i + 1]); i += 2; textStart = i; continue; }
       }
       i++; continue;
     }
     if (c === 96) { // backtick: code span
       const cs = codeSpanAt(i);
       if (cs) { flushText(i); out.push({ t: 1, s: cs.content }); i = cs.end; textStart = i; continue; }
       // No code span here: skip the whole backtick run as literal text
       // (a shorter run inside it must not start a span).
       while (i < n && src.charCodeAt(i) === 96) i++;
       continue;
     }
     if (c === 38) { // & entity
       const nl = namedEntityLength(src, i);
       if (nl > 0) { flushText(i); out.push({ t: 11, s: src.slice(i, i + nl) }); i += nl; textStart = i; continue; }
       const nd = decodeNumericEntity(src, i);
       if (nd) { flushText(i); pushRaw(nd[0]); i = nd[1]; textStart = i; continue; }
       i++; continue;
     }
     if (c === 60) { // < autolink or raw HTML
       const al = tryStdAutolink(src, i);
       if (al) {
         flushText(i);
         // autolinks do not count as links for the nesting rule
         out.push({ t: 9, href: al.href, title: null, auto: true, children: [{ t: 0, s: escapeHtml(al.text) }] });
         i = al.end; textStart = i; continue;
       }
       const rh = tryRawHtml(src, i);
       if (rh) {
         flushText(i);
         const tag = src.slice(i, rh.end);
         const lc = tag.toLowerCase();
         if (lc.startsWith('<a>') || lc.startsWith('<a ') || lc.startsWith('<a\n') || lc.startsWith('<a\t')) inAnchor = true;
         else if (lc.startsWith('</a>') || lc.startsWith('</a ') || lc.startsWith('</a\n') || lc.startsWith('</a\t')) inAnchor = false;
         out.push({ t: 2, s: tag }); i = rh.end; textStart = i; continue;
       }
       i++; continue;
     }
     if (c === 91 || (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91)) { // [ or ![
       const isImage = c === 33;
       const lk = tryParseLink(src, i, refs, isImage);
       if (lk) { flushText(i); out.push(lk.node); i = lk.end; textStart = i; continue; }
       // Not a link. When the label is poisoned (a multi-backtick code
       // span whose content holds a backtick) or an inline `(...)` follows
       // but fails, marked renders the label with emphasis disabled
       // (code spans and entities still form); a plain unresolved
       // reference keeps normal emphasis. Find the label leniently.
       const bracketPos = isImage ? i + 1 : i;
       const lab = parseLinkLabel(src, bracketPos, true);
       const afterLab = lab ? lab.end : -1;
       // An inline `(...)` follows but is malformed (bad dest/title):
       // the label renders with emphasis disabled. If the inline link
       // parses fine and only the nesting rule blocks it, emphasis
       // still forms (cm-519).
       let inlineMalformed = false;
       if (afterLab !== -1 && afterLab < n && src.charCodeAt(afterLab) === 40) {
         inlineMalformed = !inlineLinkParses(src, afterLab);
       }
       let labLenient = lab;
       if (!labLenient) labLenient = parseLabelLenient(src, bracketPos);
       if (labLenient && (inlineMalformed || !lab)) {
         flushText(i);
         pushRaw(isImage ? '![' : '[');
         const innerNodes = parseInline(labLenient.text, refs, true, true);
         for (const nd of innerNodes) out.push(nd);
         pushRaw(']');
         i = labLenient.end; textStart = i; continue;
       }
       // not a link: the '[' (and '!') stay literal; advance past '[' only
       i++; continue;
     }
     if ((c === 42 || c === 95 || c === 126) && !noEmphasis) { // * _ ~ delimiter run
       let j = i;
       while (j < n && src.charCodeAt(j) === c) j++;
       const len = j - i;
       const fl = delimFlanking(src, i, j);
       let canOpen, canClose;
       if (c === 95) {
         canOpen = fl.leftFlanking && (!fl.rightFlanking || fl.beforeIsPunct);
         canClose = fl.rightFlanking && (!fl.leftFlanking || fl.afterIsPunct);
       } else {
         canOpen = fl.leftFlanking;
         canClose = fl.rightFlanking;
       }
       // A delimiter that can neither open nor close is plain text: leave
       // it in the pending text (do not flush) so constructs like email
       // addresses that span it (a.b-c_d@a.b) still scan correctly.
       if (!canOpen && !canClose) { i = j; continue; }
       flushText(i);
       const node = { t: 5, ch: c === 42 ? '*' : (c === 95 ? '_' : '~'), len, canOpen, canClose };
       out.push(node);
       delims.push({ ch: node.ch, len, canOpen, canClose, node });
       i = j; textStart = i; continue;
     }
     if (c === 10) { // newline: hard break (2+ trailing spaces) or soft break
       let k = i - 1;
       let spaces = 0;
       while (k >= textStart && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) { spaces++; k--; }
       if (spaces >= 2) {
         flushText(i - spaces); out.push({ t: 3 });
         i++;
         // a hard break swallows leading spaces/tabs on the next line
         while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
         textStart = i; continue;
       }
       flushText(i); out.push({ t: 4 });
       i++; textStart = i; continue;
     }
     if (!inLabel && !inAnchor && c === 119 && src.startsWith('www.', i)) { // www.
       const al = extAutolinkAt(i);
       if (al) { flushText(i); out.push({ t: 9, href: al.href, title: null, auto: true, children: [{ t: 0, s: escapeHtml(al.text) }] }); i = al.end; textStart = i; continue; }
       i++; continue;
     }
     if (!inLabel && !inAnchor && ((c >= 97 && c <= 122) || (c >= 65 && c <= 90))) { // letter: scheme?
       const al = extAutolinkAt(i);
       if (al) { flushText(i); out.push({ t: 9, href: al.href, title: null, auto: true, children: [{ t: 0, s: escapeHtml(al.text) }] }); i = al.end; textStart = i; continue; }
       i++; continue;
     }
     if (!inLabel && !inAnchor && c === 64) { // @ email
       const em = emailAt(i);
       if (em) { flushText(em.start); out.push({ t: 9, href: em.href, title: null, auto: true, children: [{ t: 0, s: escapeHtml(em.text) }] }); i = em.end; textStart = i; continue; }
       i++; continue;
     }
     i++;
   }
   flushText(n);
   processEmphasis(out, delims);
   // remaining delimiter nodes (at any depth) become literal text
   (function convertDelims(nodes) {
     for (const nd of nodes) {
       if (nd.t === 5) { nd.t = 0; nd.s = nd.ch.repeat(nd.len); }
       else if (nd.children) convertDelims(nd.children);
     }
   })(out);
   return out;
 }

 // ---------------- rendering ----------------
 function renderInline(nodes) {
   let out = '';
   for (const nd of nodes) {
     switch (nd.t) {
       case 0: out += nd.s; break; // text nodes are escaped at creation
       case 1: out += '<code>' + escapeCode(nd.s) + '</code>'; break;
       case 2: out += nd.s; break;
       case 3: out += '<br>'; break;
       case 4: out += '\n'; break;
       case 6: out += '<em>' + renderInline(nd.children) + '</em>'; break;
       case 7: out += '<strong>' + renderInline(nd.children) + '</strong>'; break;
       case 8: out += '<del>' + renderInline(nd.children) + '</del>'; break;
       case 9: {
         out += '<a href="' + escapeHref(nd.href) + '"';
         if (nd.title != null) out += ' title="' + escapeHtml(nd.title) + '"';
         out += '>' + renderInline(nd.children) + '</a>';
         break;
       }
       case 10: {
         out += '<img src="' + escapeHref(nd.src) + '" alt="' + escapeHtml(nd.alt) + '"';
         if (nd.title != null) out += ' title="' + escapeHtml(nd.title) + '"';
         out += '>';
         break;
       }
       case 11: out += nd.s; break;
     }
   }
   return out;
 }

 function renderBlock(b, refs) {
   switch (b.t) {
     case 'para': {
       const parent = b.parent;
       const isTightItemPara = parent && parent.t === 'item' &&
         parent.parent && parent.parent.t === 'list' && parent.parent.tight;
       let src = b.src;
       let prefix = '';
       // task list item: first paragraph of an item starting with [ ]/[x]/[X]
       if (parent && parent.t === 'item' && parent.children[0] === b) {
         const m = src.match(/^\[( |x|X)\][ \t]+/);
         const m2 = !m && src.match(/^\[( |x|X)\]$/);
         const mm = m || m2;
         if (mm) {
           const checked = mm[1] === 'x' || mm[1] === 'X';
           prefix = checked
             ? '<input checked="" disabled="" type="checkbox"> '
             : '<input disabled="" type="checkbox"> ';
           src = src.slice(mm[0].length);
         }
       }
       const inner = prefix + renderInline(parseInline(src, refs));
       if (isTightItemPara) return inner;
       return '<p>' + inner + '</p>\n';
     }
     case 'heading':
       return '<h' + b.level + '>' + renderInline(parseInline(b.src, refs)) + '</h' + b.level + '>\n';
     case 'code': {
       const content = escapeCode(b.lines.join('\n') + (b.lines.length ? '\n' : ''));
       if (b.fenced && b.info) {
         // the language is the first word of the info string only
         const lang = b.info.split(/[ \t]+/, 1)[0];
         return '<pre><code class="language-' + escapeHtml(lang) + '">' + content + '</code></pre>\n';
       }
       return '<pre><code>' + content + '</code></pre>\n';
     }
     case 'html':
       return b.lines.join('\n');
     case 'hr':
       return '<hr>\n';
     case 'quote': {
       let inner = '';
       for (const child of b.children) inner += renderBlock(child, refs);
       return '<blockquote>\n' + inner + '</blockquote>\n';
     }
     case 'list': {
       const tag = b.ordered ? 'ol' : 'ul';
       let open = '<' + tag;
       if (b.ordered && b.start !== 1) open += ' start="' + b.start + '"';
       open += '>\n';
       let inner = '';
       for (const item of b.children) inner += renderBlock(item, refs);
       return open + inner + '</' + tag + '>\n';
     }
     case 'item': {
       let inner = '';
       for (const child of b.children) inner += renderBlock(child, refs);
       return '<li>' + inner + '</li>\n';
     }
     case 'table': {
       let out = '<table>\n<thead>\n<tr>\n';
       for (let k = 0; k < b.header.length; k++) {
         const align = b.aligns[k];
         out += '<th' + (align ? ' align="' + align + '"' : '') + '>' +
           renderInline(parseInline(b.header[k], refs)) + '</th>\n';
       }
       out += '</tr>\n</thead>\n';
       if (b.rows.length > 0) {
         out += '<tbody>';
         for (const row of b.rows) {
           out += '<tr>\n';
           for (let k = 0; k < row.length; k++) {
             const align = b.aligns[k];
             out += '<td' + (align ? ' align="' + align + '"' : '') + '>' +
               renderInline(parseInline(row[k], refs)) + '</td>\n';
           }
           out += '</tr>\n';
         }
         out += '</tbody>';
       }
       out += '</table>\n';
       return out;
     }
   }
   return '';
 }

 /** Render Markdown to the HTML marked 18.1.3 produces with default options. */
 export function parse(markdown) {
   const src = markdown.replace(/\r\n?/g, '\n');
   inAnchor = false;
   const refs = new Map();
   const root = parseBlocks(src, refs);
   let out = '';
   for (const b of root.children) out += renderBlock(b, refs);
   return out;
 }
