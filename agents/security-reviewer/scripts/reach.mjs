// Find what a program reaches: URLs in its code, the environment variables it reads, and
// whether it starts other processes (SR-08, SR-09, SR-17). Comments are blanked first, with
// their line breaks kept, so every finding keeps its line and no comment counts.

const LANGUAGES = {
  ".mjs": "javascript", ".js": "javascript", ".cjs": "javascript", ".ts": "javascript", ".mts": "javascript", ".cts": "javascript",
  ".py": "python", ".pyw": "python",
};
const CREDENTIAL_PARTS = new Set(["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "CREDENTIALS", "AUTH", "PAT"]);

/** "javascript", "python", or null for a file that is not a program. */
export function languageOf(path) {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? LANGUAGES[path.slice(dot).toLowerCase()] ?? null : null;
}

/** True when at least one `_`-separated part of the name is a credential word. */
export function isCredentialName(name) {
  return name.split("_").some((part) => CREDENTIAL_PARTS.has(part.toUpperCase()));
}

// Blanking comments

const blank = (s) => s.replace(/[^\r\n]/g, " ");

/** A literal with what lies between its delimiters blanked. An unterminated one keeps only
 *  its opening delimiter. */
const hollow = (s, open, close) => (s.length >= open.length + close.length && s.endsWith(close)
  ? open + blank(s.slice(open.length, s.length - close.length)) + close
  : open + blank(s.slice(open.length)));

// An identifier's characters: ID_Continue, `$`, the two joiners, U+200C and U+200D, and a
// `\u` escape, which an identifier may hold.
const JS_ESCAPED_CHAR = String.raw`\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\}`;
const JS_WORD = new RegExp(`(?:[\\p{ID_Continue}$${String.fromCharCode(0x200c, 0x200d)}]|${JS_ESCAPED_CHAR})+`, "uy");
const JS_KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
  "default", "extends",
]);
// A `)` closing the condition of one of these is followed by a statement, so a `/` there
// begins a regular expression rather than a division.
const JS_KEYWORDS_BEFORE_CONDITION = new Set(["if", "while", "for", "with"]);
// Line terminators. A JavaScript comment ends at any of them, so code after a U+2028 runs;
// a Python line ends at \n or a lone \r.
const JS_LINE_END = /[\n\r\u2028\u2029]/g;
const PY_LINE_END = /[\n\r]/g;

// Where this review cannot tell how JavaScript reads, it tries every reading: a `/` after the
// `}` of a function's or a class's body (a declaration's end, or an expression's) or of a block
// after a `:` (a label's or a case's, or an object literal's), or after `of`, `yield` or `await`
// (keywords, or plain names), and whether a `.js` or `.ts` program is a script, where `<!--`
// and `-->` begin comments, or a module, where they do not. It tries at most this many readings
// of one program; one that has more is read with nothing blanked.
const JS_READINGS = 32;
const JS_CONTEXTUAL_KEYWORDS = new Set(["of", "yield", "await"]);
const JS_NUMBER = /(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;
const endsLine = (s) => { JS_LINE_END.lastIndex = 0; return JS_LINE_END.test(s); };

/** Every reading of a JavaScript program: for each, `code` (its comments blanked), `hollowed`
 *  (the inside of its literals blanked too, so that text a literal only contains is not taken
 *  for code) and `literals`, the spans of its string and template text. A program with more
 *  readings than JS_READINGS gives one reading in which nothing is blanked and all of it may
 *  be a literal. */
function javaScriptReadings(text, goal = "either") {
  const readings = [];
  const pending = [[]];
  while (pending.length) {
    const prefix = pending.pop();
    const reading = readJavaScript(text, prefix, goal);
    readings.push(reading);
    // Each prefix still pending, and each about to be, leads to a reading not yet made: once
    // they pass the budget, stop before copying them, so the work stays linear in the text.
    if (readings.length + pending.length + reading.choices.length - prefix.length > JS_READINGS) {
      return [{ code: text, hollowed: text, literals: [[0, text.length]], whole: true }];
    }
    for (let j = reading.choices.length - 1; j >= prefix.length; j -= 1) {
      pending.push([...reading.choices.slice(0, j), !reading.choices[j]]);
    }
  }
  return readings;
}


/** One reading of a JavaScript program, with the choice made at each uncertain point: the
 *  first ones as `prefix` gives them, and the rest by default. */
function readJavaScript(text, prefix, goal) {
  const code = [];
  const hollowed = [];
  const literals = [];
  const emit = (s, h = s) => { code.push(s); hollowed.push(h); };
  const choices = [];
  const decide = (byDefault) => {
    const choice = choices.length < prefix.length ? prefix[choices.length] : byDefault;
    choices.push(choice);
    return choice;
  };
  const n = text.length;
  let script = goal === "script" ? true : goal === "module" ? false : null; // decided once, at the first `<!--` or `-->`
  let expectValue = true; // whether a `/` here would begin a regular expression
  let unsure = false; // whether that is a guess, which another reading makes the other way
  let lastWord = null; // the word just before, when nothing but space or comments followed it
  let lastWasName = false; // whether that word followed a member `.` or a `#`, so is a name
  let afterDot = false; // whether a member `.` or a `#` came just before, so that a word is a name
  let dots = 0; // how many `.` came just before, so that `...` is told from a member `.`
  let lineStart = true; // whether only space and comments came since the line began
  let lastToken = null; // the last token, as braceKind reads it: null at the start
  const parens = []; // for each open `(`: "cond" after if, while, for or with; "block" after catch or switch
  const braces = []; // for each open `{`: "block", "object" or "unsure", as braceKind decides

  // What a `{` opens, which decides what a `/` after its `}` begins.
  const braceKind = () => {
    if (!expectValue) {
      if (lastToken === ")block" || (!lastWasName && (lastWord === "try" || lastWord === "finally"))) return "block";
      return "unsure"; // a function's or a class's body
    }
    if (lastToken === null || [";", "{", "}", ")cond", "=>", "else", "do"].includes(lastToken)) return "block";
    if (lastToken === ":") return "unsure";
    return "object";
  };

  const lineComment = (i) => { JS_LINE_END.lastIndex = i; const m = JS_LINE_END.exec(text); return m ? m.index : n; };
  const blockComment = (i) => { const end = text.indexOf("*/", i + 2); return end === -1 ? n : end + 2; };
  const quoted = (i) => {
    const q = text[i];
    for (i += 1; i < n; i += 1) {
      if (text[i] === "\\") i += text.startsWith("\r\n", i + 1) ? 2 : 1; // a line continuation, CRLF included
      else if (text[i] === q || text[i] === "\n" || text[i] === "\r") return i + 1;
    }
    return n;
  };
  const regex = (i) => {
    let inClass = false;
    for (i += 1; i < n; i += 1) {
      const c = text[i];
      if (c === "\\") i += 1;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (endsLine(c)) return i;
      else if (c === "/" && !inClass) { i += 1; break; }
    }
    while (i < n && /[a-z]/i.test(text[i])) i += 1;
    return i;
  };
  // After a value. An unterminated string ends at its line's end, so a line starts after it.
  const after = (slice = "") => {
    expectValue = false;
    unsure = false;
    lastWord = null;
    lastToken = "value";
    afterDot = false;
    dots = 0;
    lineStart = slice !== "" && endsLine(slice.at(-1));
  };

  // Copies code from i to the `}` that closes a template substitution (when nested) or the end.
  const read = (i, nested) => {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      const d = text[i + 1];
      let end;
      const html = text.startsWith("<!--", i) || (lineStart && text.startsWith("-->", i));
      if (html && script === null) script = decide(true);
      // A hashbang may follow a byte order mark, which findReach turns into a space.
      if ((c === "/" && d === "/") || (c === "#" && d === "!" && (i === 0 || (i === 1 && text[0] === " "))) || (html && script)) {
        end = lineComment(i);
        emit(blank(text.slice(i, end)));
        i = end;
        continue;
      }
      if (c === "/" && d === "*") {
        end = blockComment(i);
        emit(blank(text.slice(i, end)));
        if (endsLine(text.slice(i, end))) lineStart = true;
        i = end;
        continue;
      }
      if (c === "'" || c === '"') {
        end = quoted(i);
        const s = text.slice(i, end);
        emit(s, hollow(s, c, c));
        literals.push([i + 1, s.length > 1 && s.endsWith(c) ? end - 1 : end]);
        after(s);
        i = end;
        continue;
      }
      if (c === "`") { i = template(i); after(); continue; }
      if (c === "/" && (unsure ? decide(expectValue) : expectValue)) {
        end = regex(i);
        emit(text.slice(i, end), blank(text.slice(i, end)));
        after();
        i = end;
        continue;
      }

      JS_NUMBER.lastIndex = i;
      const number = /[0-9]/.test(c) || (c === "." && /[0-9]/.test(d ?? "")) ? JS_NUMBER.exec(text) : null;
      if (number) { emit(number[0]); i += number[0].length; after(); continue; }
      JS_WORD.lastIndex = i;
      const word = JS_WORD.exec(text);
      if (word) {
        emit(word[0]);
        i += word[0].length;
        // `x.default / 2` and `this.#default / 2` divide: there a keyword is only a name.
        expectValue = !afterDot && JS_KEYWORDS_BEFORE_EXPRESSION.has(word[0]);
        // In a module `await` and `yield` are always keywords; `of` is one only in a for-of.
        unsure = expectValue && JS_CONTEXTUAL_KEYWORDS.has(word[0]) && (goal !== "module" || word[0] === "of");
        // In `for await (…)` the `(` opens the for's condition, as after `for`, but not after
        // a property named `for`.
        lastWord = !afterDot && word[0] === "await" && lastWord === "for" && !lastWasName ? "for" : word[0];
        lastWasName = afterDot;
        lastToken = !afterDot && (word[0] === "else" || word[0] === "do") ? word[0] : "value";
        afterDot = false;
        dots = 0;
        lineStart = false;
        continue;
      }
      // `a++ / 2` divides: a `++` or `--` after a value leaves a value. No line end may come
      // before a postfix one, so after a line end it is a prefix and a value follows.
      if ((c === "+" || c === "-") && d === c && !expectValue && !lineStart) {
        emit(c + d);
        i += 2;
        after();
        continue;
      }
      if (c === "(") {
        const keyword = !lastWasName && lastWord;
        parens.push(JS_KEYWORDS_BEFORE_CONDITION.has(keyword) ? "cond" : keyword === "catch" || keyword === "switch" ? "block" : "call");
      }
      let closed = null;
      if (c === "{") { depth += 1; braces.push(braceKind()); }
      if (c === "}") {
        if (nested && depth === 0) { emit(c); return i + 1; }
        depth -= 1;
        closed = braces.pop() ?? "unsure";
      }
      emit(c);
      i += 1;
      if (endsLine(c)) { lineStart = true; continue; }
      if (/\s/.test(c)) continue;
      lineStart = false;
      lastWord = null;
      // A member `.`, not one of a spread's three (`...typeof /re/`), or a `#` of a private name.
      afterDot = c === "#" || (c === "." && dots === 0 && text[i] !== ".");
      dots = c === "." ? dots + 1 : 0;
      // After a value (`x)`, `a]`, an object literal's `}`) a `/` divides; after a condition's
      // `)` or a block's `}` a statement starts, where it begins a regular expression.
      unsure = closed === "unsure";
      lastToken = c === ">" && text[i - 2] === "=" ? "=>" : c;
      if (c === ")") {
        const kind = parens.pop();
        expectValue = kind === "cond";
        lastToken = kind === "cond" ? ")cond" : kind === "block" ? ")block" : ")";
      } else if (closed) {
        expectValue = closed !== "object";
        if (closed === "object") lastToken = "value";
      } else expectValue = c !== "]";
    }
    return i;
  };

  const template = (i) => {
    emit("`");
    let start = i + 1;
    for (i += 1; i < n; i += 1) {
      const c = text[i];
      if (c === "\\") { const s = text.slice(i, i + 2); emit(s, blank(s)); i += 1; continue; }
      if (c === "`") { literals.push([start, i]); emit(c); return i + 1; }
      if (c === "$" && text[i + 1] === "{") {
        literals.push([start, i]);
        emit("${");
        // A substitution holds an expression, so a `{` there opens an object literal.
        expectValue = true;
        unsure = false;
        lastToken = "(";
        i = read(i + 2, true) - 1;
        start = i + 1;
        continue;
      }
      emit(c, blank(c));
    }
    literals.push([start, n]);
    return n;
  };

  read(0, false);
  return { code: code.join(""), hollowed: hollowed.join(""), literals, choices };
}

// Python's lexical structure, as much of it as finding comments and imports needs: every line
// ending (\n, \r\n, a lone \r), backslash continuations, string prefixes, triple quotes, and
// f-strings and t-strings (PEP 701, PEP 750), whose replacement fields hold code, with quotes
// and comments of their own.
const PY_NAME = /[\p{XID_Start}_]\p{XID_Continue}*/uy;
const PY_STRING_PREFIX = /^(?:[uU]|[rR]|[bBfFtT]|[rR][bBfFtT]|[bBfFtT][rR])$/;

/** Python's tokens, in order: names and operators as {type, start, end, text}, strings as
 *  {type: "string", start, end, prefix, body: [start, end]}, comments, and the end of each
 *  logical line. Tokens inside an f-string's replacement field carry `field: true`. */
function pythonTokens(text, legacy = false) {
  const tokens = [];
  let ambiguous = false; // whether a format spec has a `{{` that 3.12 reads otherwise
  const n = text.length;
  const lineEnd = (i) => { PY_LINE_END.lastIndex = i; const m = PY_LINE_END.exec(text); return m ? m.index : n; };
  const breakLength = (i) => (text.startsWith("\r\n", i) ? 2 : 1);

  // Code from i, up to the `}` that closes a replacement field when inField, else to the end.
  // `close` is the quote of the f-string whose field this is, `raw` whether it is raw, and
  // `owner` its token.
  function code(i, inField, close, raw, owner) {
    const field = i;
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === "\\" && (text[i + 1] === "\n" || text[i + 1] === "\r")) { i += 1 + breakLength(i + 1); continue; }
      if (c === "#") { const end = lineEnd(i); tokens.push({ type: "comment", start: i, end, field: inField }); i = end; continue; }
      if (c === "\n" || c === "\r") {
        const end = i + breakLength(i);
        if (!depth && !inField) tokens.push({ type: "newline", start: i, end });
        i = end;
        continue;
      }
      if (c === " " || c === "\t" || c === "\f") { i += 1; continue; }
      PY_NAME.lastIndex = i;
      const name = PY_NAME.exec(text);
      if (name) {
        const end = i + name[0].length;
        if ((text[end] === "'" || text[end] === '"') && PY_STRING_PREFIX.test(name[0])) i = string(i, end, inField);
        else { tokens.push({ type: "name", start: i, end, text: name[0], field: inField }); i = end; }
        continue;
      }
      if (c === "'" || c === '"') { i = string(i, i, inField); continue; }
      if (inField && !depth && c === "}") return i + 1;
      if (inField && !depth && c === ":") return formatSpec(i + 1, close, raw, owner);
      // CPython 3.12 decodes the escapes of a non-raw f-string's `=` debug text, the field's
      // text through its `=`, as part of the string; 3.13 keeps it as written.
      if (inField && !depth && c === "=" && !raw && !/[=!<>]/.test(text[i - 1]) && text[i + 1] !== "=") {
        PY_DEBUG_END.lastIndex = i + 1;
        if (PY_DEBUG_END.test(text)) owner.debug.push([field, i + 1]);
      }
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if ((c === ")" || c === "]" || c === "}") && depth) depth -= 1;
      tokens.push({ type: "op", start: i, end: i + 1, text: c, field: inField });
      i += 1;
    }
    return n;
  }

  // A format spec is text with fields of its own, up to the `}` that closes its field. As
  // CPython's tokenizer reads it, a backslash takes the character after it, a line end whole,
  // and a non-raw `\N{…}` is one escape, its braces included; a `{` opens a field, `{{` too,
  // until one of the spec's fields has closed, after which 3.13 and later read `{{` as a
  // literal brace and 3.12 as a field (the `legacy` reading); and the f-string's own quote
  // ends the f-string even before that `}`. A line end does not end it: 3.12 reads on.
  //
  // Its text is a string in every version, a raw f-string's too for 3.12, which decodes its
  // escapes: each run of it is recorded on the f-string's token. After a line end in a
  // one-quote f-string, 3.12 reads the rest of the field as code; 3.13 rejects it.
  function formatSpec(i, close, raw, owner) {
    let afterField = false;
    let from = i;
    const text_ = (end) => { if (end > from) owner.specs.push([from, end]); };
    while (i < n) {
      if (text[i] === "\\") { i = escapeEnd(i, true, raw); continue; }
      if (text.startsWith(close, i)) { text_(i); return i; }
      if (close.length === 1 && (text[i] === "\n" || text[i] === "\r")) { text_(i); return code(i, true, close, raw, owner); }
      if (afterField && text.startsWith("{{", i)) {
        ambiguous = true;
        if (!legacy) { i += 2; continue; }
      }
      if (text[i] === "{") { text_(i); i = code(i + 1, true, close, raw, owner); from = i; afterField = true; continue; }
      if (text[i] === "}") { text_(i); return i + 1; }
      i += 1;
    }
    text_(n);
    return n;
  }

  // Where the escape at i ends, in an f-string when formatted. A backslash does not escape a
  // brace there, so `{` still opens a field; a non-raw `\N{…}` is one escape.
  function escapeEnd(i, formatted, raw) {
    if (formatted && !raw) { PY_NAMED.lastIndex = i; if (PY_NAMED.test(text)) return PY_NAMED.lastIndex; }
    if (formatted && (text[i + 1] === "{" || text[i + 1] === "}")) return i + 1;
    return i + 1 + (text.startsWith("\r\n", i + 1) ? 2 : 1);
  }

  function string(start, at, inField) {
    const prefix = text.slice(start, at);
    const q = text[at];
    const close = text.startsWith(q.repeat(3), at) ? q.repeat(3) : q;
    const formatted = /[fFtT]/.test(prefix);
    const raw = /[rR]/.test(prefix);
    const token = { type: "string", start, end: n, prefix, body: [at + close.length, n], fields: [], specs: [], debug: [], field: inField };
    tokens.push(token);
    let j = at + close.length;
    while (j < n) {
      const c = text[j];
      if (c === "\\") { j = escapeEnd(j, formatted, raw); continue; }
      if (text.startsWith(close, j)) { token.body[1] = j; token.end = j + close.length; return token.end; }
      if (close.length === 1 && (c === "\n" || c === "\r")) { token.body[1] = j; token.end = j; return j; }
      if (formatted && c === "{") {
        if (text[j + 1] === "{") { j += 2; continue; }
        const field = j;
        j = code(j + 1, true, close, raw, token);
        token.fields.push([field, j]);
        continue;
      }
      j += 1;
    }
    return n;
  }

  code(0, false);
  return Object.assign(tokens, { ambiguous });
}

/** The parts of Python's strings read as text with escapes, str or bytes: each body, less an
 *  f-string's fields, whose code is read as code, but with the text of their format specs and,
 *  as 3.12 decodes it, of their `=` debug text. A raw string's body holds no escapes. */
function pythonLiterals(tokens, bytes) {
  const spans = [];
  for (const t of tokens) {
    if (t.type !== "string" || /[bB]/.test(t.prefix) !== bytes) continue;
    if (!/[rR]/.test(t.prefix)) {
      let at = t.body[0];
      for (const [start, end] of t.fields) { if (start > at) spans.push([at, start]); at = Math.max(at, end); }
      if (t.body[1] > at) spans.push([at, t.body[1]]);
    }
    spans.push(...t.specs, ...t.debug);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/** Python with its `#` comments blanked, those inside f-string fields too. */
function blankPythonComments(text, tokens = pythonTokens(text)) {
  let out = "";
  let at = 0;
  for (const t of tokens) {
    if (t.type !== "comment") continue;
    out += text.slice(at, t.start) + blank(text.slice(t.start, t.end));
    at = t.end;
  }
  return out + text.slice(at);
}

// Finding reach

/** A function from an offset in text to its 1-based line. */
function lineFinder(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

// The scheme, then an authority that stops at anything computed (`$`, `{`) or quoted. No word
// boundary before the scheme: in a string such as "see:\nhttps://x" the escape touches it.
const URL_IN_CODE = /(https?|wss?):\/\/([\p{L}\p{N}_.~%!&*+=:@[\]-]*)/giu;

/** The hostname of a URL written in code, as a URL parser gives it, or null when it is
 *  computed or the parser rejects it. */
function hostOf(scheme, authority) {
  if (!authority) return null;
  let host;
  try { host = new URL(`${scheme.toLowerCase()}://${authority}/`).hostname; } catch { return null; }
  return host.replace(/\.+$/, "") || null;
}

// SR-08 gives the parser the text after `//` up to the first character that cannot be part of
// an authority. Read as prose, an authority also ends at a bracket, a quotation mark or `,` or
// `;`, so "(see https://x.example)." names x.example. URL_IN_CODE's narrower authority, of the
// characters a host is usually written with, is tried when that text gives no host, and then
// the text up to the characters SR-08 names, which may hold those marks: the parser takes
// "https://«.x.example" to xn--iba.x.example. There a host needs a letter or a digit, so the
// "https://" of “https://” is no URL.
const URL_AUTHORITY = /(?:[[\]]|[^\s\p{Cc}/?#\\"'`$\{\}<>|^(),;\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Quotation_Mark}])*/uy;
const SR08_AUTHORITY = /[^\s\p{Cc}/?#\\"'`$\{\}]*/uy;

/** The host of a URL_IN_CODE match in text, and the authority it was read from. */
function hostAt(text, m) {
  const from = m.index + m[1].length + 3;
  URL_AUTHORITY.lastIndex = from;
  const wide = URL_AUTHORITY.exec(text)[0];
  const host = (wide !== m[2] ? hostOf(m[1], wide) : null) ?? hostOf(m[1], m[2]);
  if (host) return { host, authority: wide };
  SR08_AUTHORITY.lastIndex = from;
  const full = SR08_AUTHORITY.exec(text)[0];
  const named = /[\p{L}\p{N}]/u.test(HOST_PART.exec(full).groups.host) ? hostOf(m[1], full) : null;
  return named ? { host: named, authority: full } : { host: null, authority: wide };
}

const URL_AT_START = new RegExp(`^${URL_IN_CODE.source}`, "iu");

function urlsIn(code, lineAt, decoded = []) {
  const urls = [];
  let k = 0;
  for (const m of code.matchAll(URL_IN_CODE)) {
    const { host, authority } = hostAt(code, m);
    // Where an escape cuts the authority, inside a literal read again as it decodes, the
    // decoded literal names the host, and the text before the escape is no host of its own.
    const end = m.index + m[1].length + 3 + authority.length;
    while (k < decoded.length && decoded[k][1] < end) k += 1;
    if (code[end] === "\\" && k < decoded.length && decoded[k][0] <= m.index) continue;
    if (host) urls.push({ host, line: lineAt(m.index), at: m.index });
  }
  return urls;
}

// Space may sit around each `.`, as in `process\n  .env.X`; a blanked comment leaves space too.
// A name is read as it decodes, so an escape in an identifier or a string does not hide it.
const JS_NAME = String.raw`(?:[\p{ID_Start}_$]|${JS_ESCAPED_CHAR})(?:[\p{ID_Continue}$]|${JS_ESCAPED_CHAR})*`;
const JS_KEY = String.raw`"((?:[^"\\\n]|\\(?:\r\n|[\s\S]))+)"|'((?:[^'\\\n]|\\(?:\r\n|[\s\S]))+)'|${"`"}((?:[^${"`"}\\$]|\\(?:\r\n|[\s\S])|\$(?!\{))+)${"`"}`;
// `process.env`, or `process["env"]` in any quotes, with `?.` for any `.` and either part in
// parentheses or not (SR-09). Each part
// is matched as any name or key and kept only where it decodes to `process` and `env`, so an
// escape such as `\u0070rocess` or `["e\x6ev"]` does not hide a read. Only one `\s*` may claim a run of space, so a long run costs
// linear time, not quadratic. A name that decodes to `process` is seven characters, each
// written as itself or as an escape, with no identifier character after them, so each place a
// name may begin costs a few characters, however long the identifier there is.
const JS_PROCESS = String.raw`(?:[\p{ID_Start}_$]|${JS_ESCAPED_CHAR})(?:[\p{ID_Continue}$]|${JS_ESCAPED_CHAR}){6}(?![\p{ID_Continue}$]|\\u)`;
const JS_ENV = String.raw`(?:\b|(?<![\w\\])(?=\\u))(${JS_PROCESS})(?:\s*\))*\s*(?:(?:\?\.|\.)\s*(${JS_NAME})|(?:\?\.\s*)?\[\s*(?:${JS_KEY})\s*\])(?:\s*\))*`;
const JS_ENV_READS = [
  new RegExp(String.raw`${JS_ENV}\s*(?:\?\.|\.)\s*(${JS_NAME})`, "gud"),
  new RegExp(String.raw`${JS_ENV}\s*(?:\?\.\s*)?\[\s*(?:${JS_KEY})\s*\]`, "gud"),
];
// The groups of each pattern that hold a literal: the bracketed env part, and a bracketed key.
const JS_ENV_LITERALS = [[3, 4, 5], [3, 4, 5, 6, 7, 8]];
// The closing `}` of a destructuring pattern taken from the environment; its `{` is the brace
// that pairs with it.
const JS_ENV_DESTRUCTURING = new RegExp(String.raw`\}\s*=\s*${JS_ENV}`, "gud");

/** The matches of a JavaScript environment pattern whose parts, from group `k`, decode to
 *  `process` and `env`, and that `keep` keeps. The search resumes one character on after every
 *  match, so a read inside a longer chain, such as `globalThis.process.env.KEY`, or inside another
 *  read's key, is still found. One character is a whole code point: a `u` pattern set inside a
 *  surrogate pair starts again at the pair, and would match the same text forever. */
function envMatches(code, pattern, k, keep = () => true) {
  const found = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(code); m; m = pattern.exec(code)) {
    if (jsValue(m[k]) === "process" && jsValue(m[k + 1] ?? m[k + 2] ?? m[k + 3] ?? m[k + 4]) === "env" && keep(m)) found.push(m);
    pattern.lastIndex = m.index + (code.codePointAt(m.index) > 0xffff ? 2 : 1);
  }
  return found;
}

/** Whether a match's literal groups are literals of the program, or lie inside one: a key that
 *  runs from one literal's closing quote to the next one's opening quote is code, not a key.
 *  With no literals known, every match is kept. */
function literalKeys(literals) {
  if (!literals) return () => true;
  const ends = new Map(literals);
  const starts = literals.map(([start]) => start);
  const inside = (from, to) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= from) lo = mid; else hi = mid - 1; }
    return starts.length > 0 && starts[lo] <= from && literals[lo][1] >= to;
  };
  return (m, groups) => groups.every((g) => {
    const span = m.indices[g];
    return !span || ends.get(span[0]) === span[1] || inside(span[0] - 1, span[1] + 1);
  });
}

/** Each `}` outside the program's literals, mapped to the `{` it closes. */
function bracePairs(code, literals) {
  const outside = new Uint8Array(code.length).fill(1);
  for (const [start, end] of literals ?? []) outside.fill(0, start, end);
  const pairs = new Map();
  const open = [];
  for (let i = 0; i < code.length; i += 1) {
    if (!outside[i]) continue;
    if (code[i] === "{") open.push(i);
    else if (code[i] === "}" && open.length) pairs.set(i, open.pop());
  }
  return { pairs, outside };
}

// Python's string forms, as a read names them: an optional prefix, then one string, in one
// quote or three.
const PY_KEY = String.raw`((?:[rR][fF]?|[fF][rR]?|[uU])?)(?:"""((?:[^\\]|\\[\s\S])*?)"""|'''((?:[^\\]|\\[\s\S])*?)'''|"((?:[^"\\\n]|\\(?:\r\n|[\s\S]))+)"|'((?:[^'\\\n]|\\(?:\r\n|[\s\S]))+)')`;
// Space, or a backslash that continues the line, may sit around each `.`, `[` and `(`.
const PY_SP = String.raw`(?:\s|\\(?=[\r\n]))*`;
// `os.environ[KEY]`, `os.environ.get(KEY` and `os.getenv(KEY`. Python compares names after NFKC, so
// each name is matched as any name and compared so; `os` is two characters, so each place it may
// begin costs a few.
const PY_ENV_READ = new RegExp(String.raw`(?<![A-Za-z0-9_])([\p{XID_Start}_][\p{XID_Continue}])(?![\p{XID_Continue}])${PY_SP}\.${PY_SP}([\p{XID_Start}_]\p{XID_Continue}*)(?:${PY_SP}\.${PY_SP}([\p{XID_Start}_]\p{XID_Continue}*))?${PY_SP}([[(])${PY_SP}${PY_KEY}(${PY_SP}\])?`, "gu");

/** Whether a PY_ENV_READ match is one of the three reads, its names compared after NFKC. */
function pythonRead(m) {
  const [os, first, second] = [m[1], m[2], m[3]].map((x) => x?.normalize("NFKC"));
  if (os !== "os") return false;
  if (m[4] === "[") return first === "environ" && second === undefined && m[10] !== undefined;
  return (first === "getenv" && second === undefined) || (first === "environ" && second === "get");
}

const JS_KEY_BODY = (q) => String.raw`(?:[^${q}\\]|\\(?:\r\n|[\s\S]))+`;
const DESTRUCTURED_KEY = new RegExp(String.raw`^\s*(?:"(?<dq>${JS_KEY_BODY('"')})"|'(?<sq>${JS_KEY_BODY("'")})'|\[\s*(?:"(?<cdq>${JS_KEY_BODY('"')})"|'(?<csq>${JS_KEY_BODY("'")})'|${"`"}(?<ctpl>(?:[^${"`"}\\$]|\\(?:\r\n|[\s\S])|\$(?!\{))+)${"`"})\s*\](?=\s*:)|(?<plain>${JS_NAME}))`, "du");

/** The names a destructuring pattern takes from the environment: its keys, quoted, plain or
 *  computed from one literal, in the braces that pair outside the program's literals. A rest
 *  element, or a key computed from anything else, takes no one name and is not counted. */
function destructured(code, lineAt, literals) {
  const found = [];
  let braces = null;
  for (const m of envMatches(code, JS_ENV_DESTRUCTURING, 1, (x) => literalKeys(literals)(x, [3, 4, 5]))) {
    braces ??= bracePairs(code, literals);
    const open = braces.pairs.get(m.index);
    if (open === undefined) continue;
    // The pattern's items, split at its own commas.
    let from = open + 1;
    let depth = 0;
    for (let i = open + 1; i <= m.index; i += 1) {
      if (!braces.outside[i]) continue;
      const c = code[i];
      if (i < m.index && c !== ",") {
        if ("{[(".includes(c)) depth += 1;
        else if ("}])".includes(c)) depth -= 1;
        continue;
      }
      if (i < m.index && depth) continue;
      const key = DESTRUCTURED_KEY.exec(code.slice(from, i));
      if (key) {
        const group = ["dq", "sq", "cdq", "csq", "ctpl", "plain"].find((g) => key.groups[g] !== undefined);
        const raw = key.groups[group];
        // A template's line ends read as \n, as JavaScript reads them.
        const name = jsValue(group === "ctpl" ? raw.replace(/\r\n?/g, "\n") : raw);
        const at = from + key.indices.groups[group][0];
        // A name this review cannot decode is named as written (SR-09).
        if (name === null) found.push({ name: raw, undecodable: true, line: lineAt(at), at });
        else if (name) found.push({ name, line: lineAt(at), at });
      }
      from = i + 1;
    }
  }
  return found;
}

/** The environment reads in a program's code (SR-09). `literals`, for JavaScript, are the spans of
 *  its literals in this reading, or null when none are known. */
function envIn(code, language, lineAt, literals = null) {
  const env = [];
  const push = (name, raw, undecodable, at) => env.push(undecodable
    ? { name: raw, undecodable: true, line: lineAt(at), at }
    : { name, line: lineAt(at), at });
  if (language === "python") {
    PY_ENV_READ.lastIndex = 0;
    for (let m = PY_ENV_READ.exec(code); m; m = PY_ENV_READ.exec(code)) {
      // A read inside this one's key, in an f-string's field or in its text, is read too.
      PY_ENV_READ.lastIndex = m.index + 1;
      if (!pythonRead(m)) continue;
      const raw = m[6] ?? m[7] ?? m[8] ?? m[9];
      const rawString = /[rR]/.test(m[5]);
      // Python reads its source with universal newlines: each line end is \n.
      let body = raw.replace(/\r\n?/g, "\n");
      if (/[fF]/.test(m[5])) {
        // An f-string name with a field is computed (SR-18); with none it is its text.
        if (pythonHasField(body, rawString)) continue;
        body = body.replace(/\{\{/g, "{").replace(/\}\}/g, "}");
      }
      const name = rawString ? body : pythonDecode(body);
      // A name this review cannot decode is named as written (SR-09): a \N{…} naming anything
      // but printable ASCII or a character PY_NAMES names, or a \U above U+10FFFF. A name that
      // holds U+FFFD itself decodes like any other.
      const undecodable = !rawString && pythonUndecodable(body);
      if (undecodable || name) push(name, raw, undecodable, m.index);
    }
    return env;
  }
  const keep = literalKeys(literals);
  JS_ENV_READS.forEach((pattern, k) => {
    for (const m of envMatches(code, pattern, 1, (x) => keep(x, JS_ENV_LITERALS[k]))) {
      const raw = m[6] ?? m[7] ?? m[8];
      // A template's line ends read as \n, as JavaScript reads them.
      const name = jsValue(m[8] === undefined ? raw : raw.replace(/\r\n?/g, "\n"));
      // A name this review cannot decode, with a malformed escape, is named as written (SR-09).
      if (name === null || name) push(name, raw, name === null, m.index);
    }
  });
  env.push(...destructured(code, lineAt, literals));
  return env;
}

// A program starts processes when it loads child_process (JavaScript), or imports subprocess or
// calls os.system (Python). Both are read from its imports and tokens, so a string that only
// names them does not count, and an escape in a specifier does not hide one.
const JS_PROCESS_MODULE = /^(?:node:)?child_process$/;

function spawnsIn(language, imports, tokens, lineAt) {
  if (language !== "python") {
    return imports.filter((i) => JS_PROCESS_MODULE.test(i.value)).map((i) => ({ what: i.specifier, line: i.line, at: i.at }));
  }
  const spawns = imports.filter((i) => i.specifier.normalize("NFKC").split(".")[0] === "subprocess")
    .map((i) => ({ what: `import ${i.specifier}`, line: i.line, at: i.at }));
  // A line's end lies between `os.system` and a `(` on the next line, which is no call.
  const t = tokens.filter((x) => x.type !== "comment");
  const name = (k, s) => t[k]?.type === "name" && t[k].text.normalize("NFKC") === s;
  for (let k = 0; k < t.length; k += 1) {
    if (name(k, "os") && t[k + 1]?.text === "." && name(k + 2, "system") && t[k + 3]?.text === "(") {
      spawns.push({ what: "os.system(", line: lineAt(t[k].start), at: t[k].start });
    }
  }
  return spawns;
}

// What a program loads (SR-22). Each pattern ends just before the string that names a module
// and runs over the code with every literal hollowed, so a string, template or regular
// expression that only contains import text is not taken for an import.
const JS_IMPORTS = [
  { pattern: /(?<![\p{L}\p{N}_$.])from\s*(?=["'])/gu, esm: true }, // import … from, export … from
  { pattern: /(?<![\p{L}\p{N}_$.])import\s*(?=["'])/gu, esm: true }, // import "…"
  { pattern: /(?<![\p{L}\p{N}_$.])import\s*\(\s*(?=["'`])/gu, esm: true, call: true },
  { pattern: /(?<![\p{L}\p{N}_$])require\s*(?:\?\.\s*)?\(\s*(?=["'`])/gu, esm: false, call: true }, // module.require too
];
const JS_STRINGS = {
  '"': /"((?:[^"\\\n\r]|\\(?:\r\n|[\s\S]))*)"/y,
  "'": /'((?:[^'\\\n\r]|\\(?:\r\n|[\s\S]))*)'/y,
  "`": /`((?:[^`\\$]|\\[\s\S]|\$(?!\{))*)`/y,
};
// A call whose argument is more than one literal names a module computed at runtime.
const CALL_ENDS = /\s*[,)]/y;
// A legacy octal escape takes a third digit only after 0 to 3, as Annex B reads it: `\571` is `/1`.
const JS_ESCAPE = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\n\r\u2028\u2029])|([0-3][0-7]{0,2}|[4-7][0-7]?)|([\s\S]))/g;
const JS_SINGLE_ESCAPES = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/** A JavaScript string literal's value, its escapes decoded. Null when one is malformed: a
 *  code point above U+10FFFF, or a `\u` or `\x` without its digits, such as `\u{}`, which V8
 *  rejects, so the literal has no value. `lenient` keeps a malformed escape as written
 *  instead, for finding URLs: one bad escape, perhaps in a comment or a String.raw that a
 *  program read with nothing blanked holds, must not hide every URL in the text. */
function jsValue(body, lenient = false) {
  try {
    return body.replace(JS_ESCAPE, (escape, point, unit, hex, _continued, octal, other) => {
      if (point) {
        if (lenient && parseInt(point, 16) > 0x10ffff) return escape;
        return String.fromCodePoint(parseInt(point, 16));
      }
      if (unit || hex) return String.fromCharCode(parseInt(unit ?? hex, 16));
      if (octal) return String.fromCharCode(parseInt(octal, 8));
      if (other === "u" || other === "x") {
        if (lenient) return escape;
        throw new SyntaxError(`a malformed \\${other} escape`);
      }
      if (other) return JS_SINGLE_ESCAPES[other] ?? other;
      return ""; // a line continuation
    });
  } catch { return null; }
}

const jsLenient = (body) => jsValue(body, true);

function jsImports(code, hollowed, lineAt) {
  const imports = [];
  for (const { pattern, esm, call } of JS_IMPORTS) {
    for (const m of hollowed.matchAll(pattern)) {
      const at = m.index + m[0].length;
      const literal = JS_STRINGS[code[at]];
      literal.lastIndex = at;
      const found = literal.exec(code);
      if (!found) continue;
      CALL_ENDS.lastIndex = at + found[0].length;
      if (call && !CALL_ENDS.test(hollowed)) continue;
      const value = jsValue(found[1]);
      // The host SR-08 reads from a URL specifier, so SR-22 knows when SR-08 refuses it.
      const url = value === null ? null : URL_AT_START.exec(value);
      const host = url ? hostAt(value, url).host : null;
      imports.push({ specifier: found[1], value, ...(value === null ? { undecodable: true } : {}), ...(host ? { host } : {}), esm, line: lineAt(at), at });
    }
  }
  return imports;
}

// Python's imports, read from its tokens (SR-22). A statement starts the file, a logical line,
// or follows `;` or `:`. Keywords are ASCII, as Python reads them; names are compared after
// NFKC, as Python compares them.
const PY_ESCAPE = /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([0-7]{1,3})|(\r\n|\r|\n)|N\{([^}]*)\}|([\\'"abfnrtv]))/g;
// The names of printable ASCII, U+0020 to U+007E in order, as Python's \N{…} reads them in any
// case: all that a URL's scheme, a host or an environment name needs.
const PY_ASCII_NAMES = new Map("SPACE|EXCLAMATION MARK|QUOTATION MARK|NUMBER SIGN|DOLLAR SIGN|PERCENT SIGN|AMPERSAND|APOSTROPHE|LEFT PARENTHESIS|RIGHT PARENTHESIS|ASTERISK|PLUS SIGN|COMMA|HYPHEN-MINUS|FULL STOP|SOLIDUS|DIGIT ZERO|DIGIT ONE|DIGIT TWO|DIGIT THREE|DIGIT FOUR|DIGIT FIVE|DIGIT SIX|DIGIT SEVEN|DIGIT EIGHT|DIGIT NINE|COLON|SEMICOLON|LESS-THAN SIGN|EQUALS SIGN|GREATER-THAN SIGN|QUESTION MARK|COMMERCIAL AT|LATIN CAPITAL LETTER A|LATIN CAPITAL LETTER B|LATIN CAPITAL LETTER C|LATIN CAPITAL LETTER D|LATIN CAPITAL LETTER E|LATIN CAPITAL LETTER F|LATIN CAPITAL LETTER G|LATIN CAPITAL LETTER H|LATIN CAPITAL LETTER I|LATIN CAPITAL LETTER J|LATIN CAPITAL LETTER K|LATIN CAPITAL LETTER L|LATIN CAPITAL LETTER M|LATIN CAPITAL LETTER N|LATIN CAPITAL LETTER O|LATIN CAPITAL LETTER P|LATIN CAPITAL LETTER Q|LATIN CAPITAL LETTER R|LATIN CAPITAL LETTER S|LATIN CAPITAL LETTER T|LATIN CAPITAL LETTER U|LATIN CAPITAL LETTER V|LATIN CAPITAL LETTER W|LATIN CAPITAL LETTER X|LATIN CAPITAL LETTER Y|LATIN CAPITAL LETTER Z|LEFT SQUARE BRACKET|REVERSE SOLIDUS|RIGHT SQUARE BRACKET|CIRCUMFLEX ACCENT|LOW LINE|GRAVE ACCENT|LATIN SMALL LETTER A|LATIN SMALL LETTER B|LATIN SMALL LETTER C|LATIN SMALL LETTER D|LATIN SMALL LETTER E|LATIN SMALL LETTER F|LATIN SMALL LETTER G|LATIN SMALL LETTER H|LATIN SMALL LETTER I|LATIN SMALL LETTER J|LATIN SMALL LETTER K|LATIN SMALL LETTER L|LATIN SMALL LETTER M|LATIN SMALL LETTER N|LATIN SMALL LETTER O|LATIN SMALL LETTER P|LATIN SMALL LETTER Q|LATIN SMALL LETTER R|LATIN SMALL LETTER S|LATIN SMALL LETTER T|LATIN SMALL LETTER U|LATIN SMALL LETTER V|LATIN SMALL LETTER W|LATIN SMALL LETTER X|LATIN SMALL LETTER Y|LATIN SMALL LETTER Z|LEFT CURLY BRACKET|VERTICAL LINE|RIGHT CURLY BRACKET|TILDE".split("|").map((name, k) => [name, String.fromCharCode(32 + k)]));
const UNREADABLE = String.fromCharCode(0xfffd);
// The names, and aliases, that Python's \N{…} reads in any case for each character but printable
// ASCII that ends a URL's authority (a space, a control, a bracket or a quotation mark, as of
// Unicode 16), for the three full stops a host reads as "." and for the zero width space: a code
// point in hex, then its names. Decoded, each ends or splits a host as the character itself does.
const PY_NAMES = new Map([
  "0:NULL/NUL|1:START OF HEADING/SOH|2:START OF TEXT/STX|3:END OF TEXT/ETX|4:END OF TRANSMISSION/EOT|",
  "5:ENQUIRY/ENQ|6:ACKNOWLEDGE/ACK|7:ALERT/BEL|8:BACKSPACE/BS|",
  "9:CHARACTER TABULATION/HORIZONTAL TABULATION/HT/TAB|a:LINE FEED/NEW LINE/END OF LINE/LF/NL/EOL|",
  "b:LINE TABULATION/VERTICAL TABULATION/VT|c:FORM FEED/FF|d:CARRIAGE RETURN/CR|",
  "e:SHIFT OUT/LOCKING-SHIFT ONE/SO|f:SHIFT IN/LOCKING-SHIFT ZERO/SI|10:DATA LINK ESCAPE/DLE|",
  "11:DEVICE CONTROL ONE/DC1|12:DEVICE CONTROL TWO/DC2|13:DEVICE CONTROL THREE/DC3|14:DEVICE CONTROL FOUR/DC4|",
  "15:NEGATIVE ACKNOWLEDGE/NAK|16:SYNCHRONOUS IDLE/SYN|17:END OF TRANSMISSION BLOCK/ETB|18:CANCEL/CAN|",
  "19:END OF MEDIUM/EOM/EM|1a:SUBSTITUTE/SUB|1b:ESCAPE/ESC|1c:INFORMATION SEPARATOR FOUR/FILE SEPARATOR/FS|",
  "1d:INFORMATION SEPARATOR THREE/GROUP SEPARATOR/GS|1e:INFORMATION SEPARATOR TWO/RECORD SEPARATOR/RS|",
  "1f:INFORMATION SEPARATOR ONE/UNIT SEPARATOR/US|7f:DELETE/DEL|80:PADDING CHARACTER/PAD|",
  "81:HIGH OCTET PRESET/HOP|82:BREAK PERMITTED HERE/BPH|83:NO BREAK HERE/NBH|84:INDEX/IND|85:NEXT LINE/NEL|",
  "86:START OF SELECTED AREA/SSA|87:END OF SELECTED AREA/ESA|",
  "88:CHARACTER TABULATION SET/HORIZONTAL TABULATION SET/HTS|",
  "89:CHARACTER TABULATION WITH JUSTIFICATION/HORIZONTAL TABULATION WITH JUSTIFICATION/HTJ|",
  "8a:LINE TABULATION SET/VERTICAL TABULATION SET/VTS|8b:PARTIAL LINE FORWARD/PARTIAL LINE DOWN/PLD|",
  "8c:PARTIAL LINE BACKWARD/PARTIAL LINE UP/PLU|8d:REVERSE LINE FEED/REVERSE INDEX/RI|",
  "8e:SINGLE SHIFT TWO/SINGLE-SHIFT-2/SS2|8f:SINGLE SHIFT THREE/SINGLE-SHIFT-3/SS3|90:DEVICE CONTROL STRING/DCS|",
  "91:PRIVATE USE ONE/PRIVATE USE-1/PU1|92:PRIVATE USE TWO/PRIVATE USE-2/PU2|93:SET TRANSMIT STATE/STS|",
  "94:CANCEL CHARACTER/CCH|95:MESSAGE WAITING/MW|96:START OF GUARDED AREA/START OF PROTECTED AREA/SPA|",
  "97:END OF GUARDED AREA/END OF PROTECTED AREA/EPA|98:START OF STRING/SOS|",
  "99:SINGLE GRAPHIC CHARACTER INTRODUCER/SGC|9a:SINGLE CHARACTER INTRODUCER/SCI|",
  "9b:CONTROL SEQUENCE INTRODUCER/CSI|9c:STRING TERMINATOR/ST|9d:OPERATING SYSTEM COMMAND/OSC|",
  "9e:PRIVACY MESSAGE/PM|9f:APPLICATION PROGRAM COMMAND/APC|a0:NO-BREAK SPACE/NBSP|",
  "ab:LEFT-POINTING DOUBLE ANGLE QUOTATION MARK|bb:RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK|",
  "f3a:TIBETAN MARK GUG RTAGS GYON|f3b:TIBETAN MARK GUG RTAGS GYAS|f3c:TIBETAN MARK ANG KHANG GYON|",
  "f3d:TIBETAN MARK ANG KHANG GYAS|1680:OGHAM SPACE MARK|169b:OGHAM FEATHER MARK|",
  "169c:OGHAM REVERSED FEATHER MARK|2000:EN QUAD|2001:EM QUAD|2002:EN SPACE|2003:EM SPACE|",
  "2004:THREE-PER-EM SPACE|2005:FOUR-PER-EM SPACE|2006:SIX-PER-EM SPACE|2007:FIGURE SPACE|",
  "2008:PUNCTUATION SPACE|2009:THIN SPACE|200a:HAIR SPACE|200b:ZERO WIDTH SPACE/ZWSP|",
  "2018:LEFT SINGLE QUOTATION MARK|2019:RIGHT SINGLE QUOTATION MARK|201a:SINGLE LOW-9 QUOTATION MARK|",
  "201b:SINGLE HIGH-REVERSED-9 QUOTATION MARK|201c:LEFT DOUBLE QUOTATION MARK|201d:RIGHT DOUBLE QUOTATION MARK|",
  "201e:DOUBLE LOW-9 QUOTATION MARK|201f:DOUBLE HIGH-REVERSED-9 QUOTATION MARK|2028:LINE SEPARATOR|",
  "2029:PARAGRAPH SEPARATOR|202f:NARROW NO-BREAK SPACE/NNBSP|2039:SINGLE LEFT-POINTING ANGLE QUOTATION MARK|",
  "203a:SINGLE RIGHT-POINTING ANGLE QUOTATION MARK|2045:LEFT SQUARE BRACKET WITH QUILL|",
  "2046:RIGHT SQUARE BRACKET WITH QUILL|205f:MEDIUM MATHEMATICAL SPACE/MMSP|207d:SUPERSCRIPT LEFT PARENTHESIS|",
  "207e:SUPERSCRIPT RIGHT PARENTHESIS|208d:SUBSCRIPT LEFT PARENTHESIS|208e:SUBSCRIPT RIGHT PARENTHESIS|",
  "2308:LEFT CEILING|2309:RIGHT CEILING|230a:LEFT FLOOR|230b:RIGHT FLOOR|2329:LEFT-POINTING ANGLE BRACKET|",
  "232a:RIGHT-POINTING ANGLE BRACKET|2768:MEDIUM LEFT PARENTHESIS ORNAMENT|",
  "2769:MEDIUM RIGHT PARENTHESIS ORNAMENT|276a:MEDIUM FLATTENED LEFT PARENTHESIS ORNAMENT|",
  "276b:MEDIUM FLATTENED RIGHT PARENTHESIS ORNAMENT|276c:MEDIUM LEFT-POINTING ANGLE BRACKET ORNAMENT|",
  "276d:MEDIUM RIGHT-POINTING ANGLE BRACKET ORNAMENT|276e:HEAVY LEFT-POINTING ANGLE QUOTATION MARK ORNAMENT|",
  "276f:HEAVY RIGHT-POINTING ANGLE QUOTATION MARK ORNAMENT|2770:HEAVY LEFT-POINTING ANGLE BRACKET ORNAMENT|",
  "2771:HEAVY RIGHT-POINTING ANGLE BRACKET ORNAMENT|2772:LIGHT LEFT TORTOISE SHELL BRACKET ORNAMENT|",
  "2773:LIGHT RIGHT TORTOISE SHELL BRACKET ORNAMENT|2774:MEDIUM LEFT CURLY BRACKET ORNAMENT|",
  "2775:MEDIUM RIGHT CURLY BRACKET ORNAMENT|27c5:LEFT S-SHAPED BAG DELIMITER|27c6:RIGHT S-SHAPED BAG DELIMITER|",
  "27e6:MATHEMATICAL LEFT WHITE SQUARE BRACKET|27e7:MATHEMATICAL RIGHT WHITE SQUARE BRACKET|",
  "27e8:MATHEMATICAL LEFT ANGLE BRACKET|27e9:MATHEMATICAL RIGHT ANGLE BRACKET|",
  "27ea:MATHEMATICAL LEFT DOUBLE ANGLE BRACKET|27eb:MATHEMATICAL RIGHT DOUBLE ANGLE BRACKET|",
  "27ec:MATHEMATICAL LEFT WHITE TORTOISE SHELL BRACKET|27ed:MATHEMATICAL RIGHT WHITE TORTOISE SHELL BRACKET|",
  "27ee:MATHEMATICAL LEFT FLATTENED PARENTHESIS|27ef:MATHEMATICAL RIGHT FLATTENED PARENTHESIS|",
  "2983:LEFT WHITE CURLY BRACKET|2984:RIGHT WHITE CURLY BRACKET|2985:LEFT WHITE PARENTHESIS|",
  "2986:RIGHT WHITE PARENTHESIS|2987:Z NOTATION LEFT IMAGE BRACKET|2988:Z NOTATION RIGHT IMAGE BRACKET|",
  "2989:Z NOTATION LEFT BINDING BRACKET|298a:Z NOTATION RIGHT BINDING BRACKET|",
  "298b:LEFT SQUARE BRACKET WITH UNDERBAR|298c:RIGHT SQUARE BRACKET WITH UNDERBAR|",
  "298d:LEFT SQUARE BRACKET WITH TICK IN TOP CORNER|298e:RIGHT SQUARE BRACKET WITH TICK IN BOTTOM CORNER|",
  "298f:LEFT SQUARE BRACKET WITH TICK IN BOTTOM CORNER|2990:RIGHT SQUARE BRACKET WITH TICK IN TOP CORNER|",
  "2991:LEFT ANGLE BRACKET WITH DOT|2992:RIGHT ANGLE BRACKET WITH DOT|2993:LEFT ARC LESS-THAN BRACKET|",
  "2994:RIGHT ARC GREATER-THAN BRACKET|2995:DOUBLE LEFT ARC GREATER-THAN BRACKET|",
  "2996:DOUBLE RIGHT ARC LESS-THAN BRACKET|2997:LEFT BLACK TORTOISE SHELL BRACKET|",
  "2998:RIGHT BLACK TORTOISE SHELL BRACKET|29d8:LEFT WIGGLY FENCE|29d9:RIGHT WIGGLY FENCE|",
  "29da:LEFT DOUBLE WIGGLY FENCE|29db:RIGHT DOUBLE WIGGLY FENCE|29fc:LEFT-POINTING CURVED ANGLE BRACKET|",
  "29fd:RIGHT-POINTING CURVED ANGLE BRACKET|2e02:LEFT SUBSTITUTION BRACKET|2e03:RIGHT SUBSTITUTION BRACKET|",
  "2e04:LEFT DOTTED SUBSTITUTION BRACKET|2e05:RIGHT DOTTED SUBSTITUTION BRACKET|2e09:LEFT TRANSPOSITION BRACKET|",
  "2e0a:RIGHT TRANSPOSITION BRACKET|2e0c:LEFT RAISED OMISSION BRACKET|2e0d:RIGHT RAISED OMISSION BRACKET|",
  "2e1c:LEFT LOW PARAPHRASE BRACKET|2e1d:RIGHT LOW PARAPHRASE BRACKET|2e20:LEFT VERTICAL BAR WITH QUILL|",
  "2e21:RIGHT VERTICAL BAR WITH QUILL|2e22:TOP LEFT HALF BRACKET|2e23:TOP RIGHT HALF BRACKET|",
  "2e24:BOTTOM LEFT HALF BRACKET|2e25:BOTTOM RIGHT HALF BRACKET|2e26:LEFT SIDEWAYS U BRACKET|",
  "2e27:RIGHT SIDEWAYS U BRACKET|2e28:LEFT DOUBLE PARENTHESIS|2e29:RIGHT DOUBLE PARENTHESIS|",
  "2e42:DOUBLE LOW-REVERSED-9 QUOTATION MARK|2e55:LEFT SQUARE BRACKET WITH STROKE|",
  "2e56:RIGHT SQUARE BRACKET WITH STROKE|2e57:LEFT SQUARE BRACKET WITH DOUBLE STROKE|",
  "2e58:RIGHT SQUARE BRACKET WITH DOUBLE STROKE|2e59:TOP HALF LEFT PARENTHESIS|2e5a:TOP HALF RIGHT PARENTHESIS|",
  "2e5b:BOTTOM HALF LEFT PARENTHESIS|2e5c:BOTTOM HALF RIGHT PARENTHESIS|3000:IDEOGRAPHIC SPACE|",
  "3002:IDEOGRAPHIC FULL STOP|3008:LEFT ANGLE BRACKET|3009:RIGHT ANGLE BRACKET|300a:LEFT DOUBLE ANGLE BRACKET|",
  "300b:RIGHT DOUBLE ANGLE BRACKET|300c:LEFT CORNER BRACKET|300d:RIGHT CORNER BRACKET|",
  "300e:LEFT WHITE CORNER BRACKET|300f:RIGHT WHITE CORNER BRACKET|3010:LEFT BLACK LENTICULAR BRACKET|",
  "3011:RIGHT BLACK LENTICULAR BRACKET|3014:LEFT TORTOISE SHELL BRACKET|3015:RIGHT TORTOISE SHELL BRACKET|",
  "3016:LEFT WHITE LENTICULAR BRACKET|3017:RIGHT WHITE LENTICULAR BRACKET|",
  "3018:LEFT WHITE TORTOISE SHELL BRACKET|3019:RIGHT WHITE TORTOISE SHELL BRACKET|",
  "301a:LEFT WHITE SQUARE BRACKET|301b:RIGHT WHITE SQUARE BRACKET|301d:REVERSED DOUBLE PRIME QUOTATION MARK|",
  "301e:DOUBLE PRIME QUOTATION MARK|301f:LOW DOUBLE PRIME QUOTATION MARK|fd3e:ORNATE LEFT PARENTHESIS|",
  "fd3f:ORNATE RIGHT PARENTHESIS|fe17:PRESENTATION FORM FOR VERTICAL LEFT WHITE LENTICULAR BRACKET|",
  "fe18:PRESENTATION FORM FOR VERTICAL RIGHT WHITE LENTICULAR BRAKCET/PRESENTATION FORM FOR VERTICAL RIGHT WHITE LENTICULAR BRACKET|",
  "fe35:PRESENTATION FORM FOR VERTICAL LEFT PARENTHESIS|fe36:PRESENTATION FORM FOR VERTICAL RIGHT PARENTHESIS|",
  "fe37:PRESENTATION FORM FOR VERTICAL LEFT CURLY BRACKET|",
  "fe38:PRESENTATION FORM FOR VERTICAL RIGHT CURLY BRACKET|",
  "fe39:PRESENTATION FORM FOR VERTICAL LEFT TORTOISE SHELL BRACKET|",
  "fe3a:PRESENTATION FORM FOR VERTICAL RIGHT TORTOISE SHELL BRACKET|",
  "fe3b:PRESENTATION FORM FOR VERTICAL LEFT BLACK LENTICULAR BRACKET|",
  "fe3c:PRESENTATION FORM FOR VERTICAL RIGHT BLACK LENTICULAR BRACKET|",
  "fe3d:PRESENTATION FORM FOR VERTICAL LEFT DOUBLE ANGLE BRACKET|",
  "fe3e:PRESENTATION FORM FOR VERTICAL RIGHT DOUBLE ANGLE BRACKET|",
  "fe3f:PRESENTATION FORM FOR VERTICAL LEFT ANGLE BRACKET|",
  "fe40:PRESENTATION FORM FOR VERTICAL RIGHT ANGLE BRACKET|",
  "fe41:PRESENTATION FORM FOR VERTICAL LEFT CORNER BRACKET|",
  "fe42:PRESENTATION FORM FOR VERTICAL RIGHT CORNER BRACKET|",
  "fe43:PRESENTATION FORM FOR VERTICAL LEFT WHITE CORNER BRACKET|",
  "fe44:PRESENTATION FORM FOR VERTICAL RIGHT WHITE CORNER BRACKET|",
  "fe47:PRESENTATION FORM FOR VERTICAL LEFT SQUARE BRACKET|",
  "fe48:PRESENTATION FORM FOR VERTICAL RIGHT SQUARE BRACKET|fe59:SMALL LEFT PARENTHESIS|",
  "fe5a:SMALL RIGHT PARENTHESIS|fe5b:SMALL LEFT CURLY BRACKET|fe5c:SMALL RIGHT CURLY BRACKET|",
  "fe5d:SMALL LEFT TORTOISE SHELL BRACKET|fe5e:SMALL RIGHT TORTOISE SHELL BRACKET|",
  "feff:ZERO WIDTH NO-BREAK SPACE/BYTE ORDER MARK/BOM/ZWNBSP|ff02:FULLWIDTH QUOTATION MARK|",
  "ff07:FULLWIDTH APOSTROPHE|ff08:FULLWIDTH LEFT PARENTHESIS|ff09:FULLWIDTH RIGHT PARENTHESIS|",
  "ff0e:FULLWIDTH FULL STOP|ff3b:FULLWIDTH LEFT SQUARE BRACKET|ff3d:FULLWIDTH RIGHT SQUARE BRACKET|",
  "ff5b:FULLWIDTH LEFT CURLY BRACKET|ff5d:FULLWIDTH RIGHT CURLY BRACKET|ff5f:FULLWIDTH LEFT WHITE PARENTHESIS|",
  "ff60:FULLWIDTH RIGHT WHITE PARENTHESIS|ff61:HALFWIDTH IDEOGRAPHIC FULL STOP|",
  "ff62:HALFWIDTH LEFT CORNER BRACKET|ff63:HALFWIDTH RIGHT CORNER BRACKET",
].join("").split("|").flatMap((entry) => {
  const [hex, names] = entry.split(":");
  return names.split("/").map((name) => [name, String.fromCodePoint(parseInt(hex, 16))]);
}));

/** A Python string body's value, its escapes decoded. A \N{…} naming anything but printable
 *  ASCII or a character PY_NAMES names, or a \U above U+10FFFF, becomes U+FFFD, which no URL
 *  or environment name holds. In bytes, \u, \U and \N are no escapes and stay as written. */
function pythonDecode(body, bytes = false) {
  return body.replace(PY_ESCAPE, (escape, hex, unit, wide, octal, continued, named, single) => {
    if (bytes && (unit || wide || named !== undefined)) return escape;
    if (bytes && octal) return String.fromCharCode(parseInt(octal, 8) & 0xff);
    if (hex || unit || wide) {
      const point = parseInt(hex ?? unit ?? wide, 16);
      return point > 0x10ffff ? UNREADABLE : String.fromCodePoint(point);
    }
    if (octal) return String.fromCharCode(parseInt(octal, 8));
    if (named !== undefined) return PY_ASCII_NAMES.get(named.toUpperCase()) ?? PY_NAMES.get(named.toUpperCase()) ?? UNREADABLE;
    return continued ? "" : PY_SINGLE_ESCAPES[single];
  });
}

const pythonBytes = (body) => pythonDecode(body, true);

/** Whether a Python string body has an escape this review cannot decode: a \N{…} naming
 *  anything but printable ASCII or a character PY_NAMES names, or a \U above U+10FFFF. */
function pythonUndecodable(body) {
  for (const m of body.matchAll(PY_ESCAPE)) {
    if (m[6] !== undefined && !PY_ASCII_NAMES.has(m[6].toUpperCase()) && !PY_NAMES.has(m[6].toUpperCase())) return true;
    if (m[3] && parseInt(m[3], 16) > 0x10ffff) return true;
  }
  return false;
}

// What may follow a field's `=` for its text to be debug text.
const PY_DEBUG_END = /\s*[!:}]/y;
// A named escape, \N{…}, as Python's tokenizer takes it: one escape, its braces included.
const PY_NAMED = /\\N\{[A-Za-z0-9 -]*\}/y;

/** Whether an f-string body has a replacement field. A backslash does not escape a brace, but
 *  a non-raw named escape's braces are no field. */
const pythonHasField = (body, raw) =>
  /\{/.test((raw ? body : body.replace(/\\(?:N\{[A-Za-z0-9 -]*\}|[^{}])/g, "")).replace(/\{\{|\}\}/g, ""));
const PY_SINGLE_ESCAPES = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
// A PEP 263 declaration, on the first line or the second.
const PY_CODING = /^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)/;

/** The value of adjacent string tokens, as Python joins them. Undefined when it is computed
 *  (an f-string with a field) or not a str (bytes); null when it names a character by
 *  \N{…}, which this review cannot decode. */
function pythonValue(text, parts) {
  let value = "";
  for (const t of parts) {
    if (/[bB]/.test(t.prefix)) return undefined;
    let body = text.slice(...t.body);
    if (/[fFtT]/.test(t.prefix)) {
      if (pythonHasField(body, /[rR]/.test(t.prefix))) return undefined;
      body = body.replace(/\{\{/g, "{").replace(/\}\}/g, "}");
    }
    if (!/[rR]/.test(t.prefix)) {
      if (/\\N\{/.test(body)) return null;
      body = pythonDecode(body);
    }
    value += body;
  }
  return value;
}

function pythonImports(text, tokens, lineAt) {
  const imports = [];
  const t = tokens.filter((x) => !x.field && x.type !== "comment");
  const word = (k, w) => t[k]?.type === "name" && t[k].text === w;
  const op = (k, c) => t[k]?.type === "op" && t[k].text === c;
  const dotted = (k) => {
    if (t[k]?.type !== "name") return null;
    let name = t[k].text;
    let next = k + 1;
    while (op(next, ".") && t[next + 1]?.type === "name") { name += `.${t[next + 1].text}`; next += 2; }
    return { name, next };
  };
  for (let k = 0; k < t.length; k += 1) {
    const prev = t[k - 1];
    if (prev && prev.type !== "newline" && !op(k - 1, ";") && !op(k - 1, ":")) continue;
    const at = t[k].start;
    if (word(k, "import")) {
      for (let j = k + 1; ;) {
        const d = dotted(j);
        if (!d) break;
        imports.push({ specifier: d.name, names: [], line: lineAt(at), at });
        j = d.next;
        if (word(j, "as") && t[j + 1]?.type === "name") j += 2;
        if (!op(j, ",")) break;
        j += 1;
      }
    } else if (word(k, "from")) {
      let j = k + 1;
      let module = "";
      while (op(j, ".") || (t[j]?.type === "name" && t[j].text !== "import")) { module += t[j].text; j += 1; }
      if (!module || !word(j, "import")) continue;
      j += 1;
      if (op(j, "(")) j += 1;
      const names = [];
      while (t[j]?.type === "name") {
        names.push(t[j].text);
        j += 1;
        if (word(j, "as") && t[j + 1]?.type === "name") j += 2;
        if (!op(j, ",")) break;
        j += 1;
      }
      imports.push({ specifier: module, names, line: lineAt(at), at });
    }
  }
  // importlib.import_module with a literal name, anywhere code runs, f-string fields included.
  // Line ends are kept: a name at one line's end and a `(` on the next are no call.
  const all = tokens.filter((x) => x.type !== "comment");
  const is = (k, type, s) => all[k]?.type === type && (s === undefined || all[k].text.normalize("NFKC") === s);
  for (let k = 0; k < all.length; k += 1) {
    if (!is(k, "name", "import_module") || !is(k + 1, "op", "(")) continue;
    // The call's arguments, split at its own commas; the module is the first positional one,
    // or the one named `name`, wherever it stands.
    const args = [[]];
    for (let j = k + 2, depth = 0; j < all.length; j += 1) {
      const x = all[j];
      if (x.type === "op" && "([{".includes(x.text)) depth += 1;
      else if (x.type === "op" && ")]}".includes(x.text) && !depth--) break;
      else if (!depth && x.type === "op" && x.text === ",") { args.push([]); continue; }
      args.at(-1).push(x);
    }
    const keyword = (a) => a[0]?.type === "name" && a[1]?.type === "op" && a[1].text === "=";
    const named = args.find((a) => keyword(a) && a[0].text.normalize("NFKC") === "name");
    let arg = named ? named.slice(2) : keyword(args[0]) ? [] : args[0];
    while (arg.length > 2 && arg[0].text === "(" && arg.at(-1).text === ")") arg = arg.slice(1, -1);
    const parts = arg;
    if (!parts.length || parts.some((p) => p.type !== "string")) continue;
    const value = pythonValue(text, parts);
    if (value === undefined) continue;
    const at = parts[0].start;
    // The literal as written: adjacent parts with what stands between them, and nothing added.
    const written = text.slice(parts[0].start, parts.at(-1).end);
    imports.push({ specifier: value ?? written, names: [], ...(value === null ? { undecodable: true } : {}), line: lineAt(at), at });
  }
  return imports;
}

/** A Python program's PEP 263 source encoding, as declared, or null. */
function pythonCoding(text) {
  const [first = "", second = ""] = text.split(/\r\n|\r|\n/, 2);
  const m = PY_CODING.exec(first) ?? (/^[ \t\f]*(?:#.*)?$/.test(first) ? PY_CODING.exec(second) : null);
  // Python's second line follows any line ending, but a line is counted by `\n` alone.
  const line = PY_CODING.test(first) || /^\r(?!\n)/.test(text.slice(first.length)) ? 1 : 2;
  return m ? { name: m[1], line } : null;
}

const inOrder = (found) => found.sort((a, b) => a.at - b.at).map(({ at: _at, ...rest }) => rest);

// An authority's host: after any userinfo, before any port, without trailing dots.
const HOST_PART = /^(?:.*@)?(?<host>\[[^\]]*\]|.*?)\.*(?::\d*)?$/sd;

/** Like placer, for indexes in any order: where in `body` the character at an index of its
 *  decoded value was written, found by a binary search over the body's escapes. */
function escapeMap(body, escapes, decode) {
  const at = [0];
  const written = [0];
  let last = 0;
  for (const m of body.matchAll(escapes)) {
    const before = at.at(-1) + m.index - last;
    at.push(before, before + (decode(m[0]) ?? "").length);
    written.push(m.index, m.index + m[0].length);
    last = m.index + m[0].length;
  }
  return (index) => {
    let lo = 0;
    let hi = at.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (at[mid] <= index) lo = mid; else hi = mid - 1; }
    // An even entry starts plain text; an odd one starts an escape's piece, placed at the escape.
    return lo % 2 === 0 ? written[lo] + index - at[lo] : written[lo];
  };
}

/** A function from an index of a body's decoded value to where in the body that character was
 *  written, for indexes given in increasing order. An escape decodes the same wherever it
 *  stands, so the body is walked once, an escape at a time; a character an escape gives is
 *  placed at that escape. */
function placer(body, escapes, decode) {
  const found = body.matchAll(escapes);
  let next = found.next().value;
  let length = 0; // the decoded length of the body before `last`
  let last = 0;
  return (index) => {
    while (next && length + next.index - last <= index) {
      const piece = decode(next[0]) ?? "";
      if (length + next.index - last + piece.length > index) return next.index;
      length += next.index - last + piece.length;
      last = next.index + next[0].length;
      next = found.next().value;
    }
    return last + index - length;
  };
}

// A URL written with escapes in a string still names its host (SR-08): each literal whose text
// holds a backslash is read again as it decodes, and the URL is placed where it begins.
function literalUrls(text, spans, escapes, decode, lineAt) {
  const urls = [];
  for (const [start, end] of spans) {
    const body = text.slice(start, end);
    if (!body.includes("\\")) continue;
    const writtenAt = placer(body, escapes, decode);
    let anywhere = null;
    const value = decode(body) ?? "";
    for (const m of value.matchAll(URL_IN_CODE)) {
      const found = hostAt(value, m);
      const at = start + writtenAt(m.index);
      let { host } = found;
      const part = HOST_PART.exec(found.authority);
      if (part.groups.host.includes(UNREADABLE)) {
        // A host with a character this review cannot decode, by a Python \N{…}, is named as
        // written, its ASCII letters in lowercase: it is a host all the same.
        anywhere ??= escapeMap(body, escapes, decode);
        const from = m.index + m[1].length + 3 + part.indices.groups.host[0];
        const written = body.slice(anywhere(from), anywhere(from + part.groups.host.length));
        if (/\\N\{/.test(written)) host = written.replace(/\\N\{[^}]*\}|[A-Z]+/g, (w) => (w[0] === "\\" ? w : w.toLowerCase()));
      }
      if (host) urls.push({ host, line: lineAt(at), at });
    }
  }
  return urls;
}

/** Adds found items to a map, once each by key, keeping the first. */
const gather = (into, items, key) => { for (const x of items) if (!into.has(key(x))) into.set(key(x), x); };
const urlKey = (u) => `${u.line}\0${u.host}`;

/** What a program reaches: { urls: [{host, line}], env: [{name, line}], spawns: [{what, line}],
 *  imports, coding }, each in the order it appears. A JavaScript import is {specifier, value,
 *  esm, line}: the string as written, its value, and whether it is an ES module import. A
 *  Python one is {specifier, names, line}: the module path without its spaces and the names a
 *  `from` imports from it. Either has `undecodable` when its literal cannot be read. An environment
 *  read whose name cannot be read is `undecodable` too. `coding` is a Python program's PEP 263
 *  declaration, {name, line}, or null. `path`, when given, says whether a JavaScript program is
 *  a script (.cjs, .cts) or a module (.mjs, .mts). */
export function findReach(source, language, path = "") {
  // A byte order mark is not code: Python skips it, and JavaScript reads it as space.
  const text = source.charCodeAt(0) === 0xfeff ? ` ${source.slice(1)}` : source;
  const lineAt = lineFinder(text);
  const urls = new Map();
  const env = new Map();
  let imports;
  let spawns;
  let coding = null;
  if (language === "python") {
    // Where CPython 3.12 reads a format spec's `{{` as a field and 3.13 as a brace, each
    // reading is read on its own and what either finds counts, as for JavaScript (SR-08).
    const first = pythonTokens(text);
    const found = new Map();
    const started = new Map();
    for (const tokens of first.ambiguous ? [first, pythonTokens(text, true)] : [first]) {
      const code = blankPythonComments(text, tokens);
      const strings = pythonLiterals(tokens, false);
      const bytes = pythonLiterals(tokens, true);
      gather(urls, [
        ...urlsIn(code, lineAt, [...strings, ...bytes].sort((a, b) => a[0] - b[0])),
        ...literalUrls(text, strings, PY_ESCAPE, pythonDecode, lineAt),
        ...literalUrls(text, bytes, PY_ESCAPE, pythonBytes, lineAt),
      ], urlKey);
      gather(env, envIn(code, language, lineAt), (e) => `${e.at}\0${e.name}`);
      const read = pythonImports(text, tokens, lineAt);
      gather(found, read, (i) => `${i.at}\0${i.specifier}`);
      gather(started, spawnsIn(language, read, tokens, lineAt), (x) => `${x.at}\0${x.what}`);
    }
    imports = [...found.values()];
    spawns = [...started.values()];
    coding = pythonCoding(text);
  } else {
    // Node reads a .cjs or .cts file as a script and a .mjs or .mts file as a module; a .js or
    // .ts file may be either.
    const goal = /\.c[jt]s$/i.test(path) ? "script" : /\.m[jt]s$/i.test(path) ? "module" : "either";
    // Every reading is read on its own and what any of them finds counts (SR-08), so no
    // reading's misreading hides code and no mix of two readings makes up code.
    const found = new Map();
    for (const r of javaScriptReadings(text, goal)) {
      // A real literal with a malformed escape has no value, so it holds no URL; only in the
      // reading with nothing blanked, where the whole text is one literal, is it kept as written.
      gather(urls, [...urlsIn(r.code, lineAt, r.whole ? [] : r.literals), ...literalUrls(text, r.literals, JS_ESCAPE, r.whole ? jsLenient : jsValue, lineAt)], urlKey);
      gather(env, envIn(r.code, language, lineAt, r.whole ? null : r.literals), (e) => `${e.at}\0${e.name}`);
      // The same text read as an ES import by one reading and a require by another is two
      // imports: Node resolves the two differently.
      gather(found, jsImports(r.code, r.hollowed, lineAt), (i) => `${i.at}\0${i.specifier}\0${i.esm}`);
    }
    imports = [...found.values()];
    spawns = spawnsIn(language, imports, null, lineAt);
  }
  return {
    urls: inOrder([...urls.values()]),
    env: inOrder([...env.values()]),
    spawns: inOrder(spawns),
    imports: inOrder(imports),
    coding,
  };
}
