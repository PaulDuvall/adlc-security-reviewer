// Find what a program reaches: URLs in its code, the environment variables it reads, and
// whether it starts other processes (SR-08, SR-09, SR-17). Comments are blanked first, with
// their line breaks kept, so every finding keeps its line and no comment counts.

const LANGUAGES = { ".mjs": "javascript", ".js": "javascript", ".cjs": "javascript", ".ts": "javascript", ".py": "python" };
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
  "default",
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
    if (readings.length === JS_READINGS) return [{ code: text, hollowed: text, literals: [[0, text.length]] }];
    const prefix = pending.pop();
    const reading = readJavaScript(text, prefix, goal);
    readings.push(reading);
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
        lastWord = word[0];
        lastWasName = afterDot;
        lastToken = !afterDot && (word[0] === "else" || word[0] === "do") ? word[0] : "value";
        afterDot = false;
        dots = 0;
        lineStart = false;
        continue;
      }
      // `a++ / 2` divides: a `++` or `--` after a value leaves a value.
      if ((c === "+" || c === "-") && d === c && !expectValue) {
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
function pythonTokens(text) {
  const tokens = [];
  const n = text.length;
  const lineEnd = (i) => { PY_LINE_END.lastIndex = i; const m = PY_LINE_END.exec(text); return m ? m.index : n; };
  const breakLength = (i) => (text.startsWith("\r\n", i) ? 2 : 1);

  // Code from i, up to the `}` that closes a replacement field when inField, else to the end.
  function code(i, inField) {
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
      if (inField && !depth && c === ":") return formatSpec(i + 1);
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if ((c === ")" || c === "]" || c === "}") && depth) depth -= 1;
      tokens.push({ type: "op", start: i, end: i + 1, text: c, field: inField });
      i += 1;
    }
    return n;
  }

  // A format spec is text with fields of its own, up to the `}` that closes its field.
  function formatSpec(i) {
    while (i < n) {
      // `{{` is a literal brace there (Python 3.13 and later; 3.12 rejects it).
      if (text.startsWith("{{", i)) { i += 2; continue; }
      if (text[i] === "{") { i = code(i + 1, true); continue; }
      if (text[i] === "}") return i + 1;
      i += 1;
    }
    return n;
  }

  function string(start, at, inField) {
    const prefix = text.slice(start, at);
    const q = text[at];
    const close = text.startsWith(q.repeat(3), at) ? q.repeat(3) : q;
    const formatted = /[fFtT]/.test(prefix);
    const token = { type: "string", start, end: n, prefix, body: [at + close.length, n], field: inField };
    tokens.push(token);
    let j = at + close.length;
    while (j < n) {
      const c = text[j];
      if (c === "\\") {
        // In an f-string a backslash does not escape a brace: `{` still opens a field.
        if (formatted && (text[j + 1] === "{" || text[j + 1] === "}")) { j += 1; continue; }
        j += 1 + (text.startsWith("\r\n", j + 1) ? 2 : 1);
        continue;
      }
      if (text.startsWith(close, j)) { token.body[1] = j; token.end = j + close.length; return token.end; }
      if (close.length === 1 && (c === "\n" || c === "\r")) { token.body[1] = j; token.end = j; return j; }
      if (formatted && c === "{") {
        if (text[j + 1] === "{") { j += 2; continue; }
        j = code(j + 1, true);
        continue;
      }
      j += 1;
    }
    return n;
  }

  code(0, false);
  return tokens;
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

function urlsIn(code, lineAt) {
  const urls = [];
  for (const m of code.matchAll(URL_IN_CODE)) {
    const host = hostOf(m[1], m[2]);
    if (host) urls.push({ host, line: lineAt(m.index), at: m.index });
  }
  return urls;
}

// Space may sit around each `.`, as in `process\n  .env.X`; a blanked comment leaves space too.
// A name is read as it decodes, so an escape in an identifier or a string does not hide it.
const JS_NAME = String.raw`(?:[\p{ID_Start}_$]|${JS_ESCAPED_CHAR})(?:[\p{ID_Continue}$]|${JS_ESCAPED_CHAR})*`;
const JS_KEY = String.raw`"((?:[^"\\\n]|\\[\s\S])+)"|'((?:[^'\\\n]|\\[\s\S])+)'|${"`"}((?:[^${"`"}\\$]|\\[\s\S])+)${"`"}`;
const JS_ENV_READS = [
  new RegExp(String.raw`\bprocess\s*(?:\?\.|\.)\s*env\s*(?:\?\.|\.)\s*(${JS_NAME})`, "gu"),
  new RegExp(String.raw`\bprocess\s*(?:\?\.|\.)\s*env\s*(?:\?\.)?\s*\[\s*(?:${JS_KEY})\s*\]`, "gu"),
];
const JS_ENV_DESTRUCTURING = /\{([^{}]*)\}\s*=\s*process\s*(?:\?\.|\.)\s*env\b/g;
// Python's string forms, as a read names them: an optional prefix, then one quoted string.
const PY_KEY = String.raw`([rRuU]?)(?:"((?:[^"\\\n]|\\[\s\S])+)"|'((?:[^'\\\n]|\\[\s\S])+)')`;
const PY_ENV_READS = [
  new RegExp(String.raw`\bos\.environ\s*\[\s*${PY_KEY}\s*\]`, "g"),
  new RegExp(String.raw`\bos\.environ\.get\(\s*${PY_KEY}`, "g"),
  new RegExp(String.raw`\bos\.getenv\(\s*${PY_KEY}`, "g"),
];

const DESTRUCTURED_KEY = new RegExp(String.raw`^\s*(?:"(?<dq>(?:[^"\\]|\\[\s\S])+)"|'(?<sq>(?:[^'\\]|\\[\s\S])+)'|(?<plain>${JS_NAME}))`, "du");

/** The names a destructuring pattern takes from the environment. A rest element takes no
 *  one name and is not counted. */
function destructured(code, lineAt) {
  const found = [];
  for (const m of code.matchAll(JS_ENV_DESTRUCTURING)) {
    let offset = m.index + 1;
    for (const item of m[1].split(",")) {
      const key = DESTRUCTURED_KEY.exec(item);
      const name = key && jsValue(key.groups.dq ?? key.groups.sq ?? key.groups.plain);
      if (name) {
        const at = offset + (key.indices.groups.dq ?? key.indices.groups.sq ?? key.indices.groups.plain)[0];
        found.push({ name, line: lineAt(at), at });
      }
      offset += item.length + 1;
    }
  }
  return found;
}

function envIn(code, language, lineAt) {
  const env = [];
  const python = language === "python";
  for (const pattern of python ? PY_ENV_READS : JS_ENV_READS) {
    for (const m of code.matchAll(pattern)) {
      const raw = python ? m[2] ?? m[3] : m[1] ?? m[2] ?? m[3];
      const name = python ? (/[rR]/.test(m[1]) ? raw : pythonDecode(raw)) : jsValue(raw);
      if (!name) continue;
      // A name this review cannot decode is named as written.
      env.push(name.includes(UNREADABLE)
        ? { name: raw, undecodable: true, line: lineAt(m.index), at: m.index }
        : { name, line: lineAt(m.index), at: m.index });
    }
  }
  if (!python) env.push(...destructured(code, lineAt));
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
const JS_ESCAPE = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\n\r\u2028\u2029])|([0-7]{1,3})|([\s\S]))/g;
const JS_SINGLE_ESCAPES = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/** A JavaScript string literal's value, its escapes decoded. Null when one is malformed. */
function jsValue(body) {
  try {
    return body.replace(JS_ESCAPE, (_, point, unit, hex, _continued, octal, other) => {
      if (point) return String.fromCodePoint(parseInt(point, 16));
      if (unit || hex) return String.fromCharCode(parseInt(unit ?? hex, 16));
      if (octal) return String.fromCharCode(parseInt(octal, 8));
      if (other) return JS_SINGLE_ESCAPES[other] ?? other;
      return ""; // a line continuation
    });
  } catch { return null; }
}

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
      if (value !== null) imports.push({ specifier: found[1], value, esm, line: lineAt(at), at });
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

/** A Python string body's value, its escapes decoded. A \N{…} naming anything but printable
 *  ASCII becomes U+FFFD, which no URL or environment name holds. */
function pythonDecode(body) {
  return body.replace(PY_ESCAPE, (_, hex, unit, wide, octal, continued, named, single) => {
    if (hex || unit || wide) return String.fromCodePoint(parseInt(hex ?? unit ?? wide, 16));
    if (octal) return String.fromCharCode(parseInt(octal, 8));
    if (named !== undefined) return PY_ASCII_NAMES.get(named.toUpperCase()) ?? UNREADABLE;
    return continued ? "" : PY_SINGLE_ESCAPES[single];
  });
}
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
      if (/\{/.test(body.replace(/\{\{|\}\}/g, ""))) return undefined;
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
    const written = parts.map((p) => text.slice(p.start, p.end)).join(" ");
    imports.push({ specifier: value ?? written, names: [], ...(value === null ? { undecodable: true } : {}), line: lineAt(at), at });
  }
  return imports;
}

/** A Python program's PEP 263 source encoding, as declared, or null. */
function pythonCoding(text) {
  const [first = "", second = ""] = text.split(/\r\n|\r|\n/, 2);
  const m = PY_CODING.exec(first) ?? (/^[ \t\f]*(?:#.*)?$/.test(first) ? PY_CODING.exec(second) : null);
  return m ? { name: m[1], line: PY_CODING.test(first) ? 1 : 2 } : null;
}

const inOrder = (found) => found.sort((a, b) => a.at - b.at).map(({ at: _at, ...rest }) => rest);

// A URL written with escapes in a string still names its host (SR-08): each literal whose text
// holds a backslash is read again as it decodes.
function literalUrls(text, spans, decode, lineAt) {
  const urls = [];
  for (const [start, end] of spans) {
    const body = text.slice(start, end);
    if (!body.includes("\\")) continue;
    for (const m of (decode(body) ?? "").matchAll(URL_IN_CODE)) {
      const host = hostOf(m[1], m[2]);
      if (host) urls.push({ host, line: lineAt(start), at: start });
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
 *  `from` imports from it, with `undecodable` when its literal cannot be read. An environment
 *  read whose name cannot be read is `undecodable` too. `coding` is a Python program's PEP 263
 *  declaration, {name, line}, or null. `path`, when given, says whether a JavaScript program is
 *  a script (.cjs) or a module (.mjs). */
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
    const tokens = pythonTokens(text);
    const code = blankPythonComments(text, tokens);
    const strings = tokens.filter((t) => t.type === "string" && !/[rR]/.test(t.prefix)).map((t) => t.body);
    gather(urls, [...urlsIn(code, lineAt), ...literalUrls(text, strings, pythonDecode, lineAt)], urlKey);
    gather(env, envIn(code, language, lineAt), (e) => `${e.at}\0${e.name}`);
    imports = pythonImports(text, tokens, lineAt);
    spawns = spawnsIn(language, imports, tokens, lineAt);
    coding = pythonCoding(text);
  } else {
    // Node reads a .cjs file as a script and a .mjs file as a module; a .js or .ts file may be either.
    const goal = /\.cjs$/i.test(path) ? "script" : /\.mjs$/i.test(path) ? "module" : "either";
    // Every reading is read on its own and what any of them finds counts (SR-08), so no
    // reading's misreading hides code and no mix of two readings makes up code.
    const found = new Map();
    for (const r of javaScriptReadings(text, goal)) {
      gather(urls, [...urlsIn(r.code, lineAt), ...literalUrls(text, r.literals, jsValue, lineAt)], urlKey);
      gather(env, envIn(r.code, language, lineAt), (e) => `${e.at}\0${e.name}`);
      gather(found, jsImports(r.code, r.hollowed, lineAt), (i) => `${i.at}\0${i.specifier}`);
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
