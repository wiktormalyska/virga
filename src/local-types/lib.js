'use strict';

// Pure logic of Virga's local types. No dependency on the vscode module, so plain
// Node can test it (npm test). Everything works on strings and offsets.

const CH_TAB = 9;
const CH_LF = 10;
const CH_VT = 11;
const CH_FF = 12;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_QUOTE = 39; // '
const CH_LPAREN = 40;
const CH_RPAREN = 41;
const CH_STAR = 42;
const CH_DOT = 46;
const CH_SLASH = 47;
const CH_COLON = 58;
const CH_SEMI = 59;
const CH_EQ = 61;
const CH_AT = 64;
const CH_LBRACKET = 91;
const CH_BACKSLASH = 92;
const CH_RBRACKET = 93;
const CH_UNDERSCORE = 95;
const CH_LBRACE = 123;
const CH_RBRACE = 125;
const CH_NBSP = 0xa0;
const CH_BOM = 0xfeff;

function isWhitespace(c) {
  return c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR ||
    c === CH_VT || c === CH_FF || c === CH_NBSP || c === CH_BOM;
}

function isIdentStart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
}

function isIdentPart(c) {
  return isIdentStart(c) || (c >= 48 && c <= 57);
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

// Apex keywords are case-insensitive: "Class", "ENUM" are keywords too.
// A switch instead of an object lookup, so names like "__proto__" cannot match.
function typeKeyword(src, start, end) {
  const len = end - start;
  if (len !== 4 && len !== 5 && len !== 9) return null;
  switch (src.slice(start, end).toLowerCase()) {
    case 'class': return 'class';
    case 'interface': return 'interface';
    case 'enum': return 'enum';
    default: return null;
  }
}

// "extends" / "implements": the only words that can follow a type name in its
// header (Apex has no user-defined generic types).
function isHeaderWord(src, start, end) {
  const len = end - start;
  if (len !== 7 && len !== 10) return false;
  const word = src.slice(start, end).toLowerCase();
  return word === 'extends' || word === 'implements';
}

// First word of inline SOQL ("[SELECT ...]") or SOSL ("[FIND ...]").
function isQueryKeyword(src, start, end) {
  const len = end - start;
  if (len !== 4 && len !== 6) return false;
  const word = src.slice(start, end).toLowerCase();
  return word === 'select' || word === 'find';
}

// Keywords and modifiers that can never name a type. While a new declaration
// is still being typed ("public class" with the name missing), the next word
// in the file is often one of them. Most such cases are already rejected
// because the word is not followed by "{", "extends" or "implements"
// ("public void run()"); this list covers the rest ("static { ... }",
// "else {", a keyword at the end of the text).
// Deliberately limited to words that are keywords in today's Apex syntax: the
// "reserved for future use" words (outer, inner, number, ...) are common
// enough as names in example code that dropping them would hide real types.
const RESERVED = new Set([
  'public', 'private', 'protected', 'global', 'static', 'final', 'abstract',
  'virtual', 'override', 'transient', 'webservice', 'testmethod',
  'with', 'without', 'inherited', 'sharing',
  'class', 'interface', 'enum', 'extends', 'implements', 'void', 'trigger',
  'if', 'else', 'for', 'while', 'do', 'try', 'catch', 'finally', 'return',
  'throw', 'break', 'continue', 'switch', 'when', 'new',
  'insert', 'update', 'upsert', 'delete', 'undelete', 'merge',
  'null', 'true', 'false', 'this', 'super', 'instanceof',
]);

function isReservedName(name) {
  return RESERVED.has(name.toLowerCase());
}

function describe(kind, parent) {
  return parent ? `inner ${kind} of ${parent}` : `${kind} in this file`;
}

// One linear pass over the source.
//
// Returns:
//   types:      every declared class / interface / enum, in source order:
//               { name, kind, parent (dotted path or null), start, end }
//   regions:    comments and string literals, sorted, non-overlapping:
//               { kind: 'comment' | 'string', start, end, closed }
//               "closed" is false for line comments and for anything left
//               unterminated: a cursor sitting exactly at "end" is still inside.
//   soql:       inline SOQL / SOSL queries ("[SELECT ...]", "[FIND ...]"),
//               outermost only, sorted, same shape: { kind: 'soql', ... }.
//               Strings and comments inside them are also in "regions".
//   candidates: completion candidates, deduplicated case-insensitively
//               (Apex names are case-insensitive), first declaration wins:
//               { name, kind, detail, sortText, topLevel }
//   blocks:     brace blocks opened at member level that are not type bodies
//               (method and constructor bodies, initializers, property
//               accessors, collection literals), outermost only, sorted:
//               { start, end, closed }, start at the "{", end after the "}".
//
// A name after class / interface / enum only counts once the header goes on
// like a type header: "{", "extends", "implements" or the end of the text.
// "public class\n  public void run()" (a declaration whose name has not been
// typed yet) therefore declares nothing.
function analyze(text) {
  const src = typeof text === 'string' ? text : '';
  const n = src.length;
  const types = [];
  const regions = [];
  const soql = [];
  const blocks = [];
  let blockDepth = 0; // brace depth inside the current member-level block
  let blockStart = -1;

  // Type path (array of enclosing type names) for every open brace. Braces
  // that do not open a type body reuse the enclosing array, so only type
  // declarations allocate.
  const root = [];
  const stack = [root];
  let path = root;
  let pendingPath = null; // path of a declared type still waiting for its "{"
  let expectKind = null; // saw class/interface/enum, the next identifier is the name
  let declared = null; // that name, until the next token shows it is a real header
  let afterDot = false; // previous significant token was "." (Foo.class is not a declaration)

  // Inline queries: a "[" whose first token is SELECT or FIND, up to its "]".
  // A query cannot contain ";" or an unbalanced "}", so an unterminated one
  // (still being typed) ends there instead of running to the end of the file.
  let bracketAt = -1; // "[" outside a query whose first token is not seen yet
  let queryStart = -1; // start of the open query, -1 when none
  let queryBrackets = 0; // "[" depth inside it (binds can index: ":ids[0]")
  let queryBraces = 0; // "{" depth inside it (binds can build sets: ":new Set<Id>{a}")

  function acceptDeclared() {
    const d = declared;
    declared = null;
    types.push({ name: d.name, kind: d.kind, parent: d.parent, start: d.start, end: d.end });
    return d.outer.concat(d.name);
  }

  function closeQuery(end, closed) {
    soql.push({ kind: 'soql', start: queryStart, end, closed });
    queryStart = -1;
    queryBrackets = 0;
    queryBraces = 0;
  }

  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);

    if (isWhitespace(c)) {
      i++;
      continue;
    }

    if (c === CH_SLASH) {
      const d = i + 1 < n ? src.charCodeAt(i + 1) : 0;
      if (d === CH_SLASH) {
        let j = i + 2;
        while (j < n) {
          const e = src.charCodeAt(j);
          if (e === CH_LF || e === CH_CR) break;
          j++;
        }
        regions.push({ kind: 'comment', start: i, end: j, closed: false });
        i = j;
        continue;
      }
      if (d === CH_STAR) {
        const k = src.indexOf('*/', i + 2);
        const closed = k !== -1;
        const end = closed ? k + 2 : n;
        regions.push({ kind: 'comment', start: i, end, closed });
        i = end;
        continue;
      }
    }

    if (c === CH_QUOTE) {
      let end;
      let closed = false;
      if (i + 2 < n && src.charCodeAt(i + 1) === CH_QUOTE && src.charCodeAt(i + 2) === CH_QUOTE) {
        // ''' multiline string ''' : runs until the next unescaped '''.
        let j = i + 3;
        while (j < n) {
          const e = src.charCodeAt(j);
          if (e === CH_BACKSLASH) {
            j += 2;
            continue;
          }
          if (e === CH_QUOTE && j + 2 < n && src.charCodeAt(j + 1) === CH_QUOTE &&
              src.charCodeAt(j + 2) === CH_QUOTE) {
            j += 3;
            closed = true;
            break;
          }
          j++;
        }
        end = j > n ? n : j;
      } else {
        // 'single line', backslash escapes, cannot cross a line break.
        let j = i + 1;
        while (j < n) {
          const e = src.charCodeAt(j);
          if (e === CH_BACKSLASH) {
            const f = j + 1 < n ? src.charCodeAt(j + 1) : 0;
            if (f === CH_LF || f === CH_CR) {
              j++;
              break;
            }
            j += 2;
            continue;
          }
          if (e === CH_QUOTE) {
            j++;
            closed = true;
            break;
          }
          if (e === CH_LF || e === CH_CR) break;
          j++;
        }
        end = j > n ? n : j;
      }
      regions.push({ kind: 'string', start: i, end, closed });
      expectKind = null;
      declared = null;
      afterDot = false;
      bracketAt = -1;
      i = end;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src.charCodeAt(j))) j++;
      if (bracketAt >= 0) {
        if (isQueryKeyword(src, i, j)) {
          queryStart = bracketAt;
          queryBrackets = 1;
          queryBraces = 0;
        }
        bracketAt = -1;
      }
      if (declared !== null) {
        if (isHeaderWord(src, i, j)) {
          pendingPath = acceptDeclared();
          afterDot = false;
          i = j;
          continue;
        }
        declared = null; // the "name" was the start of the next member
      }
      if (expectKind !== null) {
        if (isReservedName(src.slice(i, j))) {
          // "class class Foo": a keyword again starts a new declaration.
          expectKind = typeKeyword(src, i, j);
        } else {
          declared = {
            name: src.slice(i, j),
            kind: expectKind,
            parent: path.length > 0 ? path.join('.') : null,
            outer: path,
            start: i,
            end: j,
          };
          expectKind = null;
        }
      } else if (!afterDot && queryStart < 0) {
        expectKind = typeKeyword(src, i, j);
      }
      afterDot = false;
      i = j;
      continue;
    }

    if (isDigit(c)) {
      // Number literal: 42, 3.14, 100L, 1.5d
      let j = i + 1;
      while (j < n) {
        const e = src.charCodeAt(j);
        if (isIdentPart(e) || (e === CH_DOT && j + 1 < n && isDigit(src.charCodeAt(j + 1)))) j++;
        else break;
      }
      expectKind = null;
      declared = null;
      afterDot = false;
      bracketAt = -1;
      i = j;
      continue;
    }

    // Punctuation.
    bracketAt = -1;
    if (c === CH_LBRACE) {
      let next = path;
      if (blockDepth > 0) {
        blockDepth++;
      } else if (declared === null && pendingPath === null) {
        blockDepth = 1;
        blockStart = i;
      }
      if (declared !== null) next = acceptDeclared();
      else if (pendingPath !== null) next = pendingPath;
      pendingPath = null;
      stack.push(next);
      path = next;
      if (queryStart >= 0) queryBraces++;
    } else if (c === CH_RBRACE) {
      if (blockDepth > 0 && --blockDepth === 0) blocks.push({ start: blockStart, end: i + 1, closed: true });
      if (stack.length > 1) {
        stack.pop();
        path = stack[stack.length - 1];
      }
      pendingPath = null;
      if (queryStart >= 0) {
        if (queryBraces === 0) closeQuery(i, false);
        else queryBraces--;
      }
    } else if (c === CH_LBRACKET) {
      if (queryStart >= 0) queryBrackets++;
      else bracketAt = i;
    } else if (c === CH_RBRACKET) {
      if (queryStart >= 0 && --queryBrackets === 0) closeQuery(i + 1, true);
    } else if (c === CH_SEMI || c === CH_LPAREN || c === CH_RPAREN || c === CH_EQ) {
      // A type header never contains these, so a declaration without a body
      // (still being typed) must not adopt the next "{" (a method body).
      pendingPath = null;
      if (c === CH_SEMI && queryStart >= 0) closeQuery(i, false);
    }
    declared = null;
    expectKind = null;
    afterDot = c === CH_DOT;
    i++;
  }

  if (declared !== null) acceptDeclared(); // "public class Foo" at the very end
  if (queryStart >= 0) closeQuery(n, false);
  if (blockDepth > 0) blocks.push({ start: blockStart, end: n, closed: false });

  const seen = new Set();
  const candidates = [];
  for (const t of types) {
    const key = t.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      name: t.name,
      kind: t.kind,
      detail: describe(t.kind, t.parent),
      // Same as the label: VS Code then orders these exactly like any other
      // identifier with the same match score (no artificial boost).
      sortText: t.name,
      topLevel: t.parent === null,
    });
  }

  return { types, regions, soql, candidates, blocks };
}

// Index of the last region whose start is < limit, or -1. Binary search.
function lastRegionBefore(regions, limit) {
  let lo = 0;
  let hi = regions.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (regions[mid].start < limit) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// Region a cursor at "pos" (between characters) is inside of, or null.
function regionAtCursor(regions, pos) {
  const k = lastRegionBefore(regions, pos);
  if (k < 0) return null;
  const r = regions[k];
  if (pos < r.end || (!r.closed && pos === r.end)) return r;
  return null;
}

// Region that contains the character at index "idx", or null.
function regionOfChar(regions, idx) {
  const k = lastRegionBefore(regions, idx + 1);
  if (k < 0) return null;
  const r = regions[k];
  return idx < r.end ? r : null;
}

function clampOffset(src, offset) {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return src.length;
  return Math.max(0, Math.min(src.length, Math.floor(offset)));
}

// Start of the identifier being typed just before "offset".
function currentWordStart(text, offset) {
  const src = typeof text === 'string' ? text : '';
  let s = clampOffset(src, offset);
  while (s > 0 && isIdentPart(src.charCodeAt(s - 1))) s--;
  return s;
}

// Walks back from "p" over whitespace and whole comments, so a comment ending
// with a period ("// build the response.") is not a dot. Returns the index
// just after the previous significant character, 0 when there is none.
function skipBackTrivia(src, regions, p) {
  for (;;) {
    while (p > 0 && isWhitespace(src.charCodeAt(p - 1))) p--;
    if (p === 0) return 0;
    const owner = regionOfChar(regions, p - 1);
    if (owner === null || owner.kind !== 'comment') return p;
    p = owner.start;
  }
}

// What kind of position the cursor is in:
//   'comment'     inside a line or block comment
//   'string'      inside a string literal
//   'member'      after a dot (foo.bar, foo?.bar, Outer.Inner): the language server owns it
//   'soql'        inside inline SOQL / SOSL, outside a bind expression (":name")
//   'annotation'  right after "@"
//   'declaration' naming a new type (class Foo, enum Bar)
//   'code'        anywhere a type name can be typed
function contextAt(text, offset, analysis) {
  const src = typeof text === 'string' ? text : '';
  const a = analysis || analyze(src);
  const pos = clampOffset(src, offset);

  const inside = regionAtCursor(a.regions, pos);
  if (inside) return inside.kind;
  const inQuery = regionAtCursor(a.soql || [], pos) !== null;
  const plain = inQuery ? 'soql' : 'code';

  const p = skipBackTrivia(src, a.regions, currentWordStart(src, pos));
  if (p === 0) return plain;
  if (regionOfChar(a.regions, p - 1) !== null) return plain; // right after a string literal

  const prev = src.charCodeAt(p - 1);
  if (prev === CH_DOT) return 'member';
  if (inQuery) return prev === CH_COLON ? 'code' : 'soql';
  if (prev === CH_AT) return 'annotation';
  if (isIdentPart(prev)) {
    let s = p - 1;
    while (s > 0 && isIdentPart(src.charCodeAt(s - 1))) s--;
    if (typeKeyword(src, s, p)) return 'declaration';
  }
  return 'code';
}

function isUpper(name, i) {
  return name[i] !== name[i].toLowerCase();
}

// Can VS Code's fuzzy filter show "name" once the typed word starts with
// "first" (one lowercase character)? Its suggest filter only matches when the
// first typed character lands on a strong position of the label: the start, a
// camelCase hump, or an "_" boundary, unless editor.suggest.matchOnWordStartOnly
// is off, in which case any position will do. Typo-tolerant matching
// (filterGraceful) never moves the first character, so this is a safe
// superset of what the editor can show.
function canMatchFirstChar(name, first, wordStartOnly) {
  const low = name.toLowerCase();
  for (let i = 0; i < low.length; i++) {
    if (low[i] !== first) continue;
    if (!wordStartOnly || i === 0) return true;
    if (isUpper(name, i) && !isUpper(name, i - 1)) return true;
    const before = name.charCodeAt(i - 1);
    if (before === CH_UNDERSCORE) return true;
    if (name.charCodeAt(i) === CH_UNDERSCORE) return true;
  }
  return false;
}

// Base name of a file without its extension ("…/classes/Foo.cls" -> "Foo"),
// or null. Works with "/" and "\" separators.
function typeNameFromPath(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return null;
  const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  const name = dot > 0 ? base.slice(0, dot) : base;
  return name === '' ? null : name;
}

// Completion candidates for a cursor at "offset", or [] when this position
// belongs to the language server alone (member access, comment, string,
// SOQL, ...) or when nothing could match the word being typed.
//
// options:
//   ownTypeName    name of the file's own top-level type. For saved files the
//                  language server already offers it from its workspace index,
//                  so a top-level candidate with this name (case-insensitive)
//                  is left out instead of being listed twice.
//   wordStartOnly  editor.suggest.matchOnWordStartOnly (default true).
//
// Candidates the editor would filter out anyway are dropped here, so an empty
// result lets VS Code fall back to its word-based suggestions (it only asks
// lower-ranked providers when no provider of the higher rank returned items).
function completionCandidates(text, offset, analysis, options) {
  const src = typeof text === 'string' ? text : '';
  const a = analysis || analyze(src);
  const pos = clampOffset(src, offset);
  if (contextAt(src, pos, a) !== 'code') return [];

  const opts = options || {};
  const own = typeof opts.ownTypeName === 'string' && opts.ownTypeName !== ''
    ? opts.ownTypeName.toLowerCase()
    : null;
  const wordStartOnly = opts.wordStartOnly !== false;
  const start = currentWordStart(src, pos);
  const first = start < pos ? src[start].toLowerCase() : '';

  return a.candidates.filter((c) => {
    if (own !== null && c.topLevel && c.name.toLowerCase() === own) return false;
    return first === '' || canMatchFirstChar(c.name, first, wordStartOnly);
  });
}

// --------------------------- signatures that break the Apex language server's completion
//
// Two mechanisms, both measured with a headless jorje (see below):
//   - its semantic checks crash on some parameter types: member completion is
//     gone in the whole file ('jorje-crash');
//   - its parser cannot read some return types and parameter lists and drops
//     the method or its body: no member completion inside that method
//     ('jorje-parse', see returnTypeHit and swallowHit).
//
// The Apex language server (jorje, salesforcedx-vscode-apex 67.26) runs extra
// checks on methods marked @InvocableMethod, static @AuraEnabled, @HttpGet /
// @HttpPost / @HttpPut / @HttpPatch / @HttpDelete, webservice and global. Those
// checks unwrap the element type of the List, Set and Map types in the
// parameters. A collection with no usable type argument (a raw "List",
// "List<>", "List<Req" while the name is still being typed) or with the wrong
// number of them makes that unwrap throw inside the server
// ("IllegalArgumentException: Expected list of size 1 but was: []",
// ArrayIndexOutOfBoundsException). The server logs it and goes on, but the file
// is left without resolved types: completion after "." returns nothing anywhere
// in the file until the signature is fixed. The server itself only reports the
// syntax error, never the cause.
//
// Every rule below was measured with a headless jorje (didChange, then
// completion after "r." on a local of an inner class type): a shape is flagged
// only when it crashed there or emptied that completion, and the shapes that
// measured clean stay quiet even when they are syntax errors (Set or Map in an
// @InvocableMethod, "(List requests)" or "(List<Req)" in a plain method,
// "List<Res check(", fields, locals). README.md lists the measured shapes.

// Cheap pre-checks, run on codeView() (the text the rules see: comments and
// strings blanked, bodies emptied), so they are a superset of the rules and
// never depend on unrelated text elsewhere in the file. Without one of these
// words or an empty argument slot no parameter can be affected, without a raw
// collection before a method name ("List check(", "List[] check(", "<List>",
// "<>") no return type, and without "<)" / ",)" or a "(" running into "{" past
// a collection name (swallowHint) no parameter list swallows a body. All of
// them run in linear time: each repetition stops at a fixed character, nothing
// rescans the rest of the file.
const CRASH_HINT = /invocablemethod|auraenabled|@\s*http|webservice|global|<\s+>|<\s*,|,\s*[>,]/i;
const RAW_RETURN_HINT = /\b(?:list|set|map)\b\s*(?:\[\s*\]\s*)*[A-Za-z_]\w*\s*\(|[<,]\s*(?:list|set|map)\b\s*(?:\[\s*\]\s*)*[>,]|<>/i;
const CUT_HINT = /[<,]\s*\)/;
const COLLECTION_WORD = /\b(?:list|set|map)\b/i;
const PAREN_OR_BRACE = /[(){]/g;

const MEMBER_MODIFIERS = new Set([
  'public', 'private', 'protected', 'global', 'static', 'final', 'abstract',
  'virtual', 'override', 'transient', 'webservice', 'testmethod',
  'with', 'without', 'inherited', 'sharing',
]);

const HTTP_ANNOTATIONS = new Set(['httpget', 'httppost', 'httpput', 'httppatch', 'httpdelete']);

const CH_COMMA = 44;
const CH_LT = 60;
const CH_GT = 62;

// Same character classes as isWhitespace / isIdentPart.
const WHITESPACE_RUN = /[ \t\n\v\f\r\u00a0\ufeff]*/y;
const IDENT_RUN = /[A-Za-z0-9_]*/y;

const K_ID = 1;
const K_NUM = 2;
const K_STR = 3;
const K_PUNCT = 4;

// Tokens outside comments, as parallel typed arrays: kind (K_*), code (the
// character of a punctuation token, else 0), start, end. A string literal is
// one K_STR token, punctuation is one character each (so ">>" closes two
// generic levels). The inside of each member-level block (method bodies, the
// bulk of a file) is skipped: only its "{" and "}" are kept, so the
// declaration scanner still sees where it ends.
function tokenize(src, regions, blocks) {
  let cap = 256;
  let kind = new Uint8Array(cap);
  let code = new Uint16Array(cap);
  let start = new Int32Array(cap);
  let end = new Int32Array(cap);
  let count = 0;
  function push(k, ch, s, e) {
    if (count === cap) {
      cap *= 2;
      const k2 = new Uint8Array(cap);
      const c2 = new Uint16Array(cap);
      const s2 = new Int32Array(cap);
      const e2 = new Int32Array(cap);
      k2.set(kind);
      c2.set(code);
      s2.set(start);
      e2.set(end);
      kind = k2;
      code = c2;
      start = s2;
      end = e2;
    }
    kind[count] = k;
    code[count] = ch;
    start[count] = s;
    end[count] = e;
    count++;
  }

  const n = src.length;
  let r = 0;
  let b = 0;
  let i = 0;
  while (i < n) {
    while (b < blocks.length && blocks[b].start < i) b++;
    if (b < blocks.length && blocks[b].start === i) {
      const block = blocks[b++];
      push(K_PUNCT, CH_LBRACE, i, i + 1);
      if (block.closed) push(K_PUNCT, CH_RBRACE, block.end - 1, block.end);
      i = block.end > i ? block.end : i + 1;
      continue;
    }
    while (r < regions.length && regions[r].start < i) r++;
    if (r < regions.length && regions[r].start === i) {
      const reg = regions[r++];
      if (reg.kind === 'string') push(K_STR, 0, reg.start, reg.end);
      i = reg.end > i ? reg.end : i + 1;
      continue;
    }
    const c = src.charCodeAt(i);
    if (isWhitespace(c)) {
      // Runs of whitespace and identifier characters are matched by sticky
      // regexes: native scanning, much cheaper than a JavaScript loop per
      // character before the JIT has warmed up (the first check of a file).
      WHITESPACE_RUN.lastIndex = i + 1;
      WHITESPACE_RUN.test(src);
      i = WHITESPACE_RUN.lastIndex;
      continue;
    }
    if (isIdentStart(c)) {
      IDENT_RUN.lastIndex = i + 1;
      IDENT_RUN.test(src);
      const j = IDENT_RUN.lastIndex;
      push(K_ID, 0, i, j);
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n) {
        const e = src.charCodeAt(j);
        if (isIdentPart(e) || (e === CH_DOT && j + 1 < n && isDigit(src.charCodeAt(j + 1)))) j++;
        else break;
      }
      push(K_NUM, 0, i, j);
      i = j;
      continue;
    }
    push(K_PUNCT, c, i, i + 1);
    i++;
  }
  return { src, n: count, kind, code, start, end };
}

// The source as the declaration scanner sees it: every comment and string
// literal becomes one space, the inside of each member-level block is dropped
// ("{ }" stays, like in tokenize). Linear, and short for real classes since
// method bodies are most of the text.
function codeView(src, regions, blocks) {
  const parts = [];
  const n = src.length;
  let r = 0;
  let b = 0;
  let i = 0;
  while (i < n) {
    while (b < blocks.length && blocks[b].start < i) b++;
    while (r < regions.length && regions[r].start < i) r++;
    const nextBlock = b < blocks.length ? blocks[b].start : n;
    const nextRegion = r < regions.length ? regions[r].start : n;
    const next = Math.min(nextBlock, nextRegion);
    if (next > i) {
      parts.push(src.slice(i, next));
      i = next;
      continue;
    }
    if (nextBlock === i) {
      const block = blocks[b++];
      parts.push(block.closed ? '{ }' : '{ ');
      i = block.end > i ? block.end : i + 1;
      continue;
    }
    const reg = regions[r++];
    parts.push(' ');
    i = reg.end > i ? reg.end : i + 1;
  }
  return parts.join('');
}

// Is there a "(" whose next "(", ")" or "{" is a "{", with a collection name
// in between ("(List {", "(String a, List<Req {")? One pass over the
// parentheses and braces, so an unclosed "(" above thousands of lines costs
// one scan of them, not one per line.
function swallowHint(view) {
  let open = -1;
  PAREN_OR_BRACE.lastIndex = 0;
  for (let m = PAREN_OR_BRACE.exec(view); m !== null; m = PAREN_OR_BRACE.exec(view)) {
    const c = view.charCodeAt(m.index);
    if (c === CH_LPAREN) {
      open = m.index;
      continue;
    }
    if (c === CH_LBRACE && open >= 0 && COLLECTION_WORD.test(view.slice(open + 1, m.index))) return true;
    open = -1;
  }
  return false;
}

// Pre-check: can anything in this file be flagged? A superset of the rules
// (see CRASH_HINT), cheaper than tokenizing.
function mayBreakCompletion(view) {
  return CRASH_HINT.test(view) || RAW_RETURN_HINT.test(view) || CUT_HINT.test(view) || swallowHint(view);
}

// Character of the punctuation token at i, 0 for anything else or past the end.
function punctAt(t, i) {
  return i < t.n ? t.code[i] : 0;
}

function isIdAt(t, i) {
  return i < t.n && t.kind[i] === K_ID;
}

function textAt(t, i) {
  return t.src.slice(t.start[i], t.end[i]);
}

// "list" / "set" / "map" for the bare collection names (case-insensitive, like
// Apex), null otherwise. "System.List" is not unwrapped by those checks.
function collectionKind(node) {
  if (!node) return null;
  switch (node.lower) {
    case 'list': return 'list';
    case 'set': return 'set';
    case 'map': return 'map';
    default: return null;
  }
}

// Parses a type reference at the identifier t[i] the way jorje's parser
// recovers from typing errors.
// Node: { name, lower, s, e, nameEnd, state, args, slots, hole, ltEnd }
//   state 'plain'    no "<" at all (a raw List when the name is a collection)
//         'empty'    "<>" or "< >"
//         'closed'   "<...>"
//         'missing'  "<...", then an identifier where "," or ">" was expected:
//                    jorje inserts the ">" ("Missing '>' at 'requests'") and
//                    keeps the arguments
//         'unclosed' "<..." cut by ")", "{", ";", ... : jorje drops the
//                    arguments ("No type arguments provided")
//   args  the type arguments that were typed
//   slots the same with null at each empty slot, so "Map<,Account>" is
//         [null, Account]: the quick fix keeps Account as the value type
//   hole  an empty argument slot: "< >" (not the "<>" token), "<,", ", >"
//   cutEmpty  'unclosed' and cut by ")" right after "<" or "," ("List<)",
//         "Map<String,)"): jorje then reads the method body "{" as the type
function parseTypeRef(t, i) {
  let j = i + 1;
  let name = textAt(t, i);
  while (punctAt(t, j) === CH_DOT && isIdAt(t, j + 1)) {
    name += `.${textAt(t, j + 1)}`;
    j += 2;
  }
  const node = {
    name,
    lower: name.toLowerCase(),
    s: t.start[i],
    e: t.end[j - 1],
    nameEnd: t.end[j - 1],
    state: 'plain',
    args: [],
    slots: [],
    hole: false,
    cutEmpty: false,
    ltEnd: -1,
  };
  if (punctAt(t, j) === CH_LT) {
    node.ltEnd = t.end[j];
    node.e = t.end[j];
    node.state = 'unclosed';
    j++;
    let expectArg = true;
    while (j < t.n) {
      const p = punctAt(t, j);
      if (p === CH_GT) {
        // "<>" written together is one operator token for jorje (a raw
        // List); "< >" and ", >" leave an empty argument slot.
        if (expectArg && (node.args.length > 0 || t.start[j] > node.ltEnd)) {
          node.hole = true;
          node.slots.push(null);
        }
        node.e = t.end[j];
        node.state = node.args.length > 0 ? 'closed' : 'empty';
        j++;
        break;
      }
      if (p === CH_COMMA) {
        if (expectArg) {
          node.hole = true;
          node.slots.push(null);
        }
        node.e = t.end[j];
        expectArg = true;
        j++;
        continue;
      }
      if (t.kind[j] !== K_ID) {
        // ")", "{", ";", ...: unclosed
        node.cutEmpty = expectArg && t.code[j] === CH_RPAREN;
        break;
      }
      if (!expectArg) {
        node.state = 'missing';
        break;
      }
      const r = parseTypeRef(t, j);
      node.args.push(r.node);
      node.slots.push(r.node);
      node.e = r.node.e;
      j = r.next;
      expectArg = false;
      if (r.node.state === 'unclosed') break;
    }
  }
  while (punctAt(t, j) === CH_LBRACKET && punctAt(t, j + 1) === CH_RBRACKET) {
    node.e = t.end[j + 1];
    j += 2;
  }
  return { node, next: j };
}

function arity(kind) {
  return kind === 'map' ? 2 : 1;
}

// A collection the server cannot unwrap: no usable type argument, or the
// wrong number of them.
function isBad(node) {
  const kind = collectionKind(node);
  if (kind === null) return false;
  if (node.state === 'closed' || node.state === 'missing') return node.args.length !== arity(kind);
  return true;
}

// Anything repairType has to rewrite.
function needsRepair(node) {
  if (isBad(node) || node.hole) return true;
  if (node.state !== 'closed' && node.state !== 'missing') return false;
  return node.args.some(needsRepair);
}

// What each check unwraps, as measured. Each returns the first node the check
// throws on, or null.
//
// @InvocableMethod (exactly one parameter, the check stops before that
// otherwise): a List, then its element type if that is a List again. Set, Map
// and a third List level are rejected without unwrapping.
function invocableHit(type) {
  if (collectionKind(type) !== 'list') return null;
  if (isBad(type)) return type;
  const element = type.args[0];
  return collectionKind(element) === 'list' && isBad(element) ? element : null;
}

// static @AuraEnabled and @Http*: List and Map are unwrapped at every level,
// a Set is rejected first (List<Set>, Set<List> and a raw Set stay quiet).
function listMapHit(type) {
  const kind = collectionKind(type);
  if (kind === null || kind === 'set') return null;
  if (isBad(type)) return type;
  for (const arg of type.args) {
    const hit = listMapHit(arg);
    if (hit) return hit;
  }
  return null;
}

// global: List, Set and Map at every level.
function anyCollectionHit(type) {
  if (collectionKind(type) === null) return null;
  if (isBad(type)) return type;
  for (const arg of type.args) {
    const hit = anyCollectionHit(arg);
    if (hit) return hit;
  }
  return null;
}

// webservice: List only (Set and Map are rejected first).
function listOnlyHit(type) {
  if (collectionKind(type) !== 'list') return null;
  if (isBad(type)) return type;
  return listOnlyHit(type.args[0]);
}

// Any method or constructor, annotated or not: an empty argument slot in a
// List, Set or Map ("List< >", "List<String, >", "Map<,String>") makes
// jorje's type resolution throw a NullPointerException. "Iterable< >" and the
// "<>" token do not.
function holeHit(type) {
  if (collectionKind(type) === null) return null;
  if (type.hole) return type;
  if (type.state !== 'closed' && type.state !== 'missing') return null;
  for (const arg of type.args) {
    const hit = holeHit(arg);
    if (hit) return hit;
  }
  return null;
}

// Return types jorje's parser cannot read. It drops the whole method
// ("Unexpected token 'check'", then "Invalid constructor name: check"), so
// nothing inside it gets member completion; no crash, other methods keep
// theirs. Measured in plain, instance, @InvocableMethod, @AuraEnabled and
// global methods: a raw List / Set / Map, "List<>", "List< >", and a raw
// collection inside a closed one ("List<List>", "Map<String, List>").
// "List<Res check(" is recovered by jorje ("Missing '>'") and stays quiet, so
// do return types with the wrong number of type arguments.
function returnTypeHit(node) {
  if (collectionKind(node) === null) return null;
  if (node.state === 'plain' || node.state === 'empty') return node;
  if (node.state !== 'closed') return null;
  for (const arg of node.args) {
    const hit = returnTypeHit(arg);
    if (hit) return hit;
  }
  return null;
}

// Parameter lists jorje's parser reads the method body into, in any method
// ("Invalid character in identifier: {", then "Method must have a body"): the
// body is lost, so nothing inside it gets member completion. Measured:
//   - a List / Set / Map cut by ")" right after "<" or "," at any depth:
//     "(List<)", "(List< )", "(Map<String,)", "(String a, List<)", "(List<List<)"
//   - a raw or unclosed collection right before the body when the list has no
//     ")" yet: "(List {", "(List requests {", "(List<Req {"
// "(List<R)", "(List)", "(List<Request> requests {" keep the body.
function swallowHit(param, method) {
  const cut = cutEmptyHit(param.type);
  if (cut) return cut;
  const last = method.params[method.params.length - 1] === param;
  if (last && !method.closed && param.afterCode === CH_LBRACE && collectionKind(param.type) !== null &&
      (param.type.state === 'plain' || param.type.state === 'unclosed')) {
    return param.type;
  }
  return null;
}

function cutEmptyHit(node) {
  if (collectionKind(node) !== null && node.cutEmpty) return node;
  for (const arg of node.args) {
    const hit = cutEmptyHit(arg);
    if (hit) return hit;
  }
  return null;
}

// A global member: the "global" modifier, or a method of a global interface
// (interface methods carry no modifiers, they take the interface's).
function isGlobal(method) {
  return method.modifiers.includes('global') || method.inGlobalInterface;
}

// Members that mark a wrapper class for the method's annotations / modifiers.
function methodFeature(method) {
  const has = (a) => method.annotations.some((x) => x.lower === a);
  if (has('invocablemethod')) return 'invocable';
  if (has('auraenabled')) return 'aura';
  if (method.modifiers.includes('webservice')) return 'webservice';
  if (isGlobal(method) || method.annotations.some((x) => HTTP_ANNOTATIONS.has(x.lower))) return 'global';
  return null;
}

// Rules that apply to a method, in reporting order. "feature" names the
// members that mark a wrapper class for that rule (quick fix candidates).
// None of them runs when jorje cannot parse the return type: it drops the
// method first.
//
// Constructors get the global check only: a global constructor crashes on
// the same shapes as a global method, an @InvocableMethod constructor
// measured clean. Methods of a global interface are checked as global; those
// of a public interface (even inside a global class) measured clean, and so
// did public constructors of a global class.
function methodRules(method) {
  const rules = [];
  const has = (a) => method.annotations.some((x) => x.lower === a);
  if (method.ctor) {
    if (method.modifiers.includes('global')) {
      rules.push({ where: 'a global constructor parameter', hit: anyCollectionHit, feature: 'global' });
    }
    return rules;
  }
  if (parsableReturnType(method.returnType)) {
    if (has('invocablemethod') && method.params.length === 1) {
      rules.push({ where: 'an @InvocableMethod parameter', hit: invocableHit, feature: 'invocable' });
    }
    if (has('auraenabled') && method.modifiers.includes('static')) {
      rules.push({ where: 'an @AuraEnabled parameter', hit: listMapHit, feature: 'aura' });
    }
    const http = method.annotations.find((x) => HTTP_ANNOTATIONS.has(x.lower));
    if (http) rules.push({ where: `an @${http.name} parameter`, hit: listMapHit, feature: 'global' });
    if (method.modifiers.includes('webservice')) {
      rules.push({ where: 'a webservice method parameter', hit: listOnlyHit, feature: 'webservice' });
    }
    if (method.modifiers.includes('global')) {
      rules.push({ where: 'a global method parameter', hit: anyCollectionHit, feature: 'global' });
    } else if (method.inGlobalInterface) {
      rules.push({ where: 'a global interface method parameter', hit: anyCollectionHit, feature: 'global' });
    }
  }
  return rules;
}

// Can jorje's parser build this return type? A collection return type with a
// missing, empty, cut or raw argument list makes it drop the whole method
// ("Unexpected token 'check'"), and then no check runs on the parameters.
function parsableReturnType(node) {
  if (node.state === 'plain') return collectionKind(node) === null;
  if (node.state !== 'closed') return false;
  return node.args.every(parsableReturnType);
}

function skipParens(t, i) {
  let depth = 0;
  for (let j = i; j < t.n; j++) {
    const p = t.code[j];
    if (p === CH_LPAREN) depth++;
    else if (p === CH_RPAREN) {
      if (--depth === 0) return j + 1;
    } else if (p === CH_LBRACE || p === CH_RBRACE || p === CH_SEMI) {
      return j; // unbalanced while typing: never swallow the class body
    }
  }
  return t.n;
}

// Skips a method body, initializer, property accessors or enum body: from
// just after its "{" to just after the matching "}".
function skipBlock(t, i) {
  const code = t.code;
  let depth = 1;
  for (; i < t.n; i++) {
    const p = code[i];
    if (p === CH_LBRACE) depth++;
    else if (p === CH_RBRACE && --depth === 0) return i + 1;
  }
  return t.n;
}

function isListEnd(p) {
  return p === CH_RPAREN || p === CH_LBRACE || p === CH_RBRACE || p === CH_SEMI;
}

// Parameter list from "(" at t[i]. Stops at ")" or, when the list is not
// closed yet, at "{", "}" or ";". Each parameter:
//   { type, name, nameEnd, afterCode, afterStart }
// afterCode / afterStart describe the token right after the type and name.
function parseParams(t, i) {
  const params = [];
  let j = i + 1;
  while (j < t.n) {
    const p = punctAt(t, j);
    if (p === CH_RPAREN) return { params, closed: true, next: j + 1 };
    if (isListEnd(p)) break;
    if (t.kind[j] !== K_ID) {
      j++;
      continue;
    }
    if (textAt(t, j).toLowerCase() === 'final') {
      j++;
      continue;
    }
    const r = parseTypeRef(t, j);
    const param = { type: r.node, name: null, nameEnd: -1, afterCode: 0, afterStart: -1 };
    j = r.next;
    if (isIdAt(t, j)) {
      param.name = textAt(t, j);
      param.nameEnd = t.end[j];
      j++;
    }
    if (j < t.n) {
      param.afterCode = t.code[j];
      param.afterStart = t.start[j];
    }
    params.push(param);
    while (j < t.n && t.code[j] !== CH_COMMA && !isListEnd(t.code[j])) j++;
  }
  return { params, closed: false, next: j };
}

// After a method header: the body "{" is skipped, ";" ends an abstract or
// interface method, "}" belongs to the enclosing type.
function skipBody(t, j) {
  for (; j < t.n; j++) {
    const p = t.code[j];
    if (p === CH_LBRACE) return skipBlock(t, j + 1);
    if (p === CH_SEMI) return j + 1;
    if (p === CH_RBRACE) return j;
  }
  return j;
}

// Rest of a field declaration: up to ";" outside braces and parentheses
// ("= new List<X>{ a, b };"), or up to the "}" that closes the type.
function skipStatement(t, j) {
  let depth = 0;
  for (; j < t.n; j++) {
    const p = t.code[j];
    if (p === CH_LBRACE || p === CH_LPAREN) depth++;
    else if (p === CH_RBRACE || p === CH_RPAREN) {
      if (depth === 0) return j;
      depth--;
    } else if (p === CH_SEMI && depth === 0) {
      return j + 1;
    }
  }
  return j;
}

function recordFeatures(type, annotations, modifiers) {
  for (const a of annotations) {
    if (a.lower === 'invocablevariable') type.features.add('invocable');
    else if (a.lower === 'auraenabled') type.features.add('aura');
  }
  if (modifiers.includes('global')) type.features.add('global');
  if (modifiers.includes('webservice')) type.features.add('webservice');
}

// One member of a type body starting at t[i]. Returns the next index (always
// past i unless t[i] is the "}" that the caller handles). A type declaration
// pushes its frame; bodies of everything else are skipped.
function parseMember(t, i, frame, frames, types, methods) {
  const annotations = [];
  const modifiers = [];
  while (i < t.n) {
    if (punctAt(t, i) === CH_AT && isIdAt(t, i + 1)) {
      const name = textAt(t, i + 1);
      annotations.push({ name, lower: name.toLowerCase() });
      i += 2;
      if (punctAt(t, i) === CH_LPAREN) i = skipParens(t, i);
      continue;
    }
    if (t.kind[i] === K_ID) {
      const word = textAt(t, i).toLowerCase();
      if (MEMBER_MODIFIERS.has(word)) {
        modifiers.push(word);
        i++;
        continue;
      }
    }
    break;
  }
  if (i >= t.n) return t.n;
  if (t.kind[i] === K_PUNCT) {
    const p = t.code[i];
    if (p === CH_LBRACE) return skipBlock(t, i + 1); // initializer block
    if (p === CH_RBRACE) return i;
    return i + 1;
  }
  if (t.kind[i] !== K_ID) return i + 1;

  const keyword = textAt(t, i).toLowerCase();
  if (keyword === 'class' || keyword === 'interface' || keyword === 'enum') {
    let j = i + 1;
    const name = isIdAt(t, j) ? textAt(t, j) : null;
    while (j < t.n) {
      const p = t.code[j];
      if (p === CH_LBRACE || p === CH_SEMI || p === CH_RBRACE) break;
      j++;
    }
    if (punctAt(t, j) !== CH_LBRACE) return j;
    const type = { name, start: t.start[i], features: new Set() };
    if (modifiers.includes('global')) type.features.add('global');
    if (name !== null) types.push(type);
    if (keyword === 'enum') return skipBlock(t, j + 1); // constants, no members
    const globalInterface = keyword === 'interface' && modifiers.includes('global');
    frames.push({ type, chain: frame.chain.concat(type), globalInterface });
    return j + 1;
  }

  const r = parseTypeRef(t, i);
  const j = r.next;
  if (punctAt(t, j) === CH_LPAREN) {
    // Constructor: "Name(...)".
    const list = parseParams(t, j);
    if (frame.type) {
      methods.push({ ctor: true, annotations, modifiers, returnType: null, params: list.params,
        closed: list.closed, chain: frame.chain, inGlobalInterface: false });
    }
    return skipBody(t, list.next);
  }
  if (isIdAt(t, j)) {
    if (punctAt(t, j + 1) === CH_LPAREN) {
      const list = parseParams(t, j + 1);
      if (frame.type) {
        methods.push({ ctor: false, annotations, modifiers, returnType: r.node, params: list.params,
          closed: list.closed, chain: frame.chain, inGlobalInterface: frame.globalInterface === true });
      }
      return skipBody(t, list.next);
    }
    if (frame.type) recordFeatures(frame.type, annotations, modifiers);
    if (punctAt(t, j + 1) === CH_LBRACE) return skipBlock(t, j + 2); // property accessors
    return skipStatement(t, j + 1);
  }
  return skipStatement(t, j > i ? j : i + 1);
}

// Types, methods and constructors declared in type bodies (top level and
// inner). Method, initializer and accessor bodies are skipped.
function scanDeclarations(t) {
  const types = [];
  const methods = [];
  const frames = [{ type: null, chain: [] }];
  let i = 0;
  while (i < t.n) {
    if (t.code[i] === CH_RBRACE) {
      if (frames.length > 1) frames.pop();
      i++;
      continue;
    }
    i = parseMember(t, i, frames[frames.length - 1], frames, types, methods);
  }
  return { types, methods };
}

// Class names that read as the input or the output of an action.
function isInputName(name) {
  return /request|input|param|argument|criteria|query|command/i.test(name) || /^(?:In|Req)[A-Z_]|(?:In|Req|Args?)$/.test(name);
}

function isOutputName(name) {
  return /response|result|output|outcome|reply/i.test(name) || /^(?:Out|Res)[A-Z_]|(?:Out|Res)$/.test(name);
}

// Quick fix element types for a parameter: wrapper classes of this file marked
// for the rule (fields with @InvocableVariable for @InvocableMethod, ...),
// input-like names first, output-like names last.
function rankedWrappers(types, feature, chain) {
  const own = new Set(chain);
  const found = [];
  types.forEach((t, index) => {
    if (own.has(t) || !t.features.has(feature)) return;
    let score = 1;
    if (isInputName(t.name)) score = 2;
    else if (isOutputName(t.name)) score = 0;
    found.push({ name: t.name, score, index });
  });
  found.sort((a, b) => b.score - a.score || a.index - b.index);
  return found;
}

// Element types for a return type: output-like names first (fields or not:
// the Response class is often still empty), then the rule's wrapper classes.
function rankedReturnTypes(types, feature, chain) {
  const own = new Set(chain);
  const found = [];
  types.forEach((t, index) => {
    if (own.has(t)) return;
    const wrapper = feature !== null && t.features.has(feature);
    const output = isOutputName(t.name);
    if (!wrapper && !output) return;
    let score = 1;
    if (output) score = wrapper ? 3 : 2;
    else if (isInputName(t.name)) score = 0;
    found.push({ name: t.name, score, index });
  });
  found.sort((a, b) => b.score - a.score || a.index - b.index);
  return found;
}

// Stand-in element type: tells whether a repair uses the element type at all
// (a raw Map becomes Map<String, Object> whatever the candidates are).
const ELEMENT_PROBE = '\u0000';

// Why the quick fix falls back to String.
const FEATURE_NOTE = {
  invocable: 'no class with @InvocableVariable fields in this file',
  aura: 'no class with @AuraEnabled fields in this file',
  global: 'no other global class in this file',
  webservice: 'no class with webservice fields in this file',
};

function canonicalCollection(kind) {
  return kind === 'map' ? 'Map' : kind === 'set' ? 'Set' : 'List';
}

function oneLine(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function hitLabel(src, node) {
  const kind = collectionKind(node);
  const text = oneLine(src.slice(node.s, node.e), 30);
  if (node.state === 'plain') return `Raw ${node.name}`;
  if (node.state === 'empty') return `${text} without a type argument`;
  if (node.state === 'unclosed') return `Unclosed ${text}`;
  if (node.hole) return `Empty type argument in ${text}`;
  const count = node.args.length;
  return `${node.name} with ${count} type argument${count === 1 ? '' : 's'} (${canonicalCollection(kind)} takes ${arity(kind)})`;
}

function remedy(node) {
  const kind = collectionKind(node);
  return kind === 'map' ? 'Map<Key, Value>' : `${canonicalCollection(kind)}<Type>`;
}

const CONSEQUENCE = "The Apex language server crashes on it and stops suggesting members after '.' in this file.";
const RETURN_CONSEQUENCE = "The Apex language server cannot parse this method and suggests no members after '.' inside it.";

// Text of "node" with every collection the server cannot unwrap given usable
// type arguments. "element" fills a missing List / Set element type;
// "complete" turns the identifier cut off at the end of an unclosed list
// ("List<Req") into a full name. A "[]" suffix on a rebuilt collection is
// dropped: jorje's parser rejects array notation on a generic type
// ("List<Response>[] check(" loses the method like a raw List does).
function repairType(src, node, element, complete, tail) {
  const kind = collectionKind(node);
  if (kind === null) {
    if (tail && node.state === 'plain') return complete(node.name);
    return src.slice(node.s, node.e);
  }
  if (node.state === 'closed' && !needsRepair(node)) return src.slice(node.s, node.e);
  const head = src.slice(node.s, node.nameEnd);
  const args = node.state === 'empty' ? [] : node.args;
  const last = args[args.length - 1];
  const fix = (arg) => repairType(src, arg, element, complete, node.state === 'unclosed' && arg === last);
  if (kind === 'map') {
    // A typed argument keeps its slot: "Map<,Account>" is missing its key,
    // so Account stays the value. With more than two slots the intent is
    // unclear and the first two typed arguments are kept.
    const slots = node.state === 'empty' ? [] : node.slots.length <= 2 ? node.slots : args;
    const key = slots[0] ? fix(slots[0]) : 'String';
    const value = slots[1] ? fix(slots[1]) : 'Object';
    return `${head}<${key}, ${value}>`;
  }
  return `${head}<${args[0] ? fix(args[0]) : element}>`;
}

// Identifier cut off at the end of an unclosed type ("Req" in "List<Req",
// also inside "List<List<Req"), or null.
function cutOffName(node) {
  if (node.state !== 'unclosed' || node.cutEmpty || node.args.length === 0) return null;
  const last = node.args[node.args.length - 1];
  if (collectionKind(last) !== null) return cutOffName(last);
  return last.state === 'plain' && last.name.indexOf('.') < 0 ? last.name : null;
}

function plural(word) {
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

// Parameter name for a repaired type when none was typed: "List<Request>" and
// "List<List<Request>>" -> "requests", anything else -> "values". Never one of
// the other parameters' names.
function parameterName(repaired, params, own) {
  let inner = repaired.trim();
  for (let m = /^(?:list|set)\s*<([\s\S]*)>$/i.exec(inner); m; m = /^(?:list|set)\s*<([\s\S]*)>$/i.exec(inner)) {
    inner = m[1].trim();
  }
  let base = 'values';
  if (inner !== repaired.trim() && /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
    base = plural(inner.charAt(0).toLowerCase() + inner.slice(1));
  }
  if (isReservedName(base)) base = 'values';
  const taken = new Set(params.filter((p) => p !== own && p.name !== null).map((p) => p.name.toLowerCase()));
  let name = base;
  for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base}${k}`;
  return name;
}

// Comments (and a typed name) between a parameter type and the next token,
// kept by the quick fix. Trailing whitespace goes, unless the text ends in a
// line comment: "// typing" must keep its line break, or the ")" that follows
// would end up commented out. The text holds no string literals (a string
// would be the next token).
function keptTrivia(text) {
  const trimmed = text.replace(/\s+$/, '');
  let line = false;
  let i = 0;
  while (i < trimmed.length) {
    if (trimmed.startsWith('/*', i)) {
      const k = trimmed.indexOf('*/', i + 2);
      i = k < 0 ? trimmed.length : k + 2;
      line = false;
    } else if (trimmed.startsWith('//', i)) {
      const k = trimmed.slice(i).search(/[\r\n]/);
      line = k < 0;
      i = k < 0 ? trimmed.length : i + k;
    } else {
      i++;
    }
  }
  return line ? text : trimmed;
}

// Quick fixes for one parameter: [{ title, preferred, edit: { start, end, newText } }]
function parameterFixes(src, method, param, rule, types) {
  const type = param.type;
  const lastParam = method.params[method.params.length - 1] === param;
  const typed = param.name !== null;
  // The edit covers the type only, so whatever sits between the type and a
  // typed name (comments, line breaks) stays. A missing name is added after
  // the type; the edit then runs up to the ")" so "(List< )" loses the stray
  // space, keeping any comment there. A list still open at the body
  // ("(List {") gets its ")" with the fix, after the name.
  let end = type.e;
  let after = '';
  if (param.afterCode === CH_LBRACE && lastParam && !method.closed) {
    end = param.afterStart;
    after = `${keptTrivia(src.slice(type.e, end))}) `;
  } else if (!typed && param.afterCode === CH_RPAREN) {
    end = param.afterStart;
    after = keptTrivia(src.slice(type.e, end));
  }

  const wrappers = rule.feature ? rankedWrappers(types, rule.feature, method.chain) : [];
  const cut = cutOffName(type);
  let options = [];
  if (cut !== null) {
    // "List<Req": finish the name the user was typing. The exact name first,
    // then wrapper classes of the rule, then any other type of this file.
    const lower = cut.toLowerCase();
    const seen = new Set();
    const add = (name, score) => {
      const key = name.toLowerCase();
      if (seen.has(key) || !key.startsWith(lower)) return;
      seen.add(key);
      options.push({ element: name, complete: () => name, note: '', score: key === lower ? 20 : score });
    };
    for (const w of wrappers) add(w.name, 10 + w.score);
    types.forEach((t) => add(t.name, 0));
    options.sort((x, y) => y.score - x.score);
    if (options.length === 0) options.push({ element: cut, complete: (x) => x, note: '' });
  } else if (wrappers.length > 0) {
    options = wrappers.map((w) => ({ element: w.name, complete: (x) => x, note: '', score: w.score }));
  } else {
    const why = rule.feature ? ` (${FEATURE_NOTE[rule.feature]})` : '';
    options.push({ element: 'String', complete: (x) => x, note: why });
  }

  const fixes = [];
  const texts = new Set();
  const usesElement = repairType(src, type, ELEMENT_PROBE, (x) => x, false).includes(ELEMENT_PROBE);
  for (const option of options.slice(0, 4)) {
    const repaired = repairType(src, type, option.element, option.complete, false);
    const name = typed ? param.name : parameterName(repaired, method.params, param);
    const shown = `${repaired} ${name}`;
    if (texts.has(shown)) continue;
    texts.add(shown);
    fixes.push({
      title: `Change to ${shown}${usesElement ? option.note : ''}`,
      preferred: false,
      score: option.score,
      edit: { start: type.s, end, newText: `${typed ? repaired : shown}${after}` },
    });
  }
  return markPreferred(fixes);
}

// Preferred (applied by Auto Fix) only when the choice is clear: a single
// option, or a ranked candidate that beats the rest.
function markPreferred(fixes) {
  if (fixes.length === 1) fixes[0].preferred = true;
  else if (fixes.length > 1 && fixes[0].score !== undefined && fixes[0].score > fixes[1].score) fixes[0].preferred = true;
  for (const f of fixes) delete f.score;
  return fixes;
}

// Quick fixes for a return type jorje cannot parse.
function returnTypeFixes(src, method, types) {
  const type = method.returnType;
  const candidates = rankedReturnTypes(types, methodFeature(method), method.chain);
  const options = candidates.length > 0
    ? candidates.map((c) => ({ element: c.name, note: '', score: c.score }))
    : [{ element: 'String', note: ' (no output class in this file)' }];
  const fixes = [];
  const texts = new Set();
  const usesElement = repairType(src, type, ELEMENT_PROBE, (x) => x, false).includes(ELEMENT_PROBE);
  for (const option of options.slice(0, 4)) {
    const repaired = repairType(src, type, option.element, (x) => x, false);
    if (texts.has(repaired)) continue;
    texts.add(repaired);
    fixes.push({
      title: `Change the return type to ${repaired}${usesElement ? option.note : ''}`,
      preferred: false,
      score: option.score,
      edit: { start: type.s, end: type.e, newText: repaired },
    });
  }
  return markPreferred(fixes);
}

// Shapes in "text" that break the Apex language server's member completion.
// Each: { start, end, message, code, fixes }
//   code 'jorje-crash'   a parameter type its checks crash on (file-wide)
//   code 'jorje-parse'   a return type its parser cannot read (that method)
// start / end are offsets of the offending type (the raw "List", "List<Req",
// ...), fixes are quick fixes for the whole parameter or return type.
// options.precheck === false skips the pre-check (tests compare both ways).
function findCompletionBreakers(text, analysis, options) {
  const src = typeof text === 'string' ? text : '';
  const a = analysis || analyze(src);
  const blocks = a.blocks || [];
  if (!(options && options.precheck === false) && !mayBreakCompletion(codeView(src, a.regions, blocks))) return [];
  const { types, methods } = scanDeclarations(tokenize(src, a.regions, blocks));
  const found = [];
  for (const method of methods) {
    const returnHit = method.ctor ? null : returnTypeHit(method.returnType);
    if (returnHit) {
      found.push({
        start: returnHit.s,
        end: returnHit.state === 'plain' ? returnHit.nameEnd : returnHit.e,
        code: 'jorje-parse',
        message: `${hitLabel(src, returnHit)} in the return type. ${RETURN_CONSEQUENCE} Use ${remedy(returnHit)}.`,
        fixes: returnTypeFixes(src, method, types),
      });
    }
    const rules = methodRules(method);
    for (const param of method.params) {
      let rule = null;
      let hit = null;
      for (const candidate of rules) {
        hit = candidate.hit(param.type);
        if (hit) {
          rule = candidate;
          break;
        }
      }
      let code = 'jorje-crash';
      let consequence = CONSEQUENCE;
      if (!hit) {
        hit = holeHit(param.type);
        rule = {
          where: method.ctor ? 'a constructor parameter' : 'a method parameter',
          feature: methodFeature(method),
        };
      }
      if (!hit && !method.ctor && returnHit === null) {
        hit = swallowHit(param, method);
        code = 'jorje-parse';
        consequence = RETURN_CONSEQUENCE;
      }
      if (!hit) continue;
      found.push({
        start: hit.s,
        end: hit.state === 'plain' ? hit.nameEnd : hit.e,
        code,
        message: `${hitLabel(src, hit)} in ${rule.where}. ${consequence} Use ${remedy(hit)}.`,
        fixes: parameterFixes(src, method, param, rule, types),
      });
    }
  }
  return found;
}

module.exports = {
  analyze,
  contextAt,
  completionCandidates,
  currentWordStart,
  typeNameFromPath,
  describe,
  findCompletionBreakers,
};
