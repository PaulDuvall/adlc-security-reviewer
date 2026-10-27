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

// An identifier's characters: ID_Continue, `$`, and the two joiners, U+200C and U+200D.
const JS_WORD = new RegExp(`[\\p{ID_Continue}$${String.fromCharCode(0x200c, 0x200d)}]+`, "uy");
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
// (keywords, or plain names), and `<!--` and `-->` (comments in a script, not in a module). It
// tries at most this many readings of one program, and blanks nothing in one that has more.
const JS_READINGS = 32;
const JS_CONTEXTUAL_KEYWORDS = new Set(["of", "yield", "await"]);
const endsLine = (s) => { JS_LINE_END.lastIndex = 0; return JS_LINE_END.test(s); };

/** JavaScript with its comments blanked. Strings, templates and regular expression literals
 *  are kept as they are, so a comment marker inside one is not taken for a comment. With
 *  `literals`, what lies inside each of them is blanked too, so that text a literal only
 *  contains is not taken for code. Where readings differ, a character is blanked only where
 *  every reading blanks it, so that no misreading hides code. */
function blankJavaScriptComments(text, literals = false, goal = "either") {
  const readings = [];
  const pending = [[]];
  while (pending.length) {
    if (readings.length === JS_READINGS) return text;
    const prefix = pending.pop();
    const { out, choices } = readJavaScript(text, literals, prefix, goal);
    readings.push(out);
    for (let j = choices.length - 1; j >= prefix.length; j -= 1) pending.push([...choices.slice(0, j), !choices[j]]);
  }
  if (readings.length === 1) return readings[0];
  const merged = [];
  for (let k = 0; k < text.length; k += 1) merged.push(readings.some((r) => r[k] !== " ") ? text[k] : " ");
  return merged.join("");
}

/** One reading of a JavaScript program: the text with its comments (and, with `literals`, the
 *  inside of its literals) blanked, and the choice made at each uncertain point, the first
 *  ones as `prefix` gives them and the rest by default. */
function readJavaScript(text, literals, prefix, goal) {
  const out = [];
  const choices = [];
  const decide = (byDefault) => {
    const choice = choices.length < prefix.length ? prefix[choices.length] : byDefault;
    choices.push(choice);
    return choice;
  };
  const n = text.length;
  let expectValue = true; // whether a `/` here would begin a regular expression
  let unsure = false; // whether that is a guess, which another reading makes the other way
  let lastWord = null; // the word just before, when nothing but space or comments followed it
  let lastWasName = false; // whether that word followed a member `.` or a `#`, so is a name
  let afterDot = false; // whether a member `.` or a `#` came just before, so that a word is a name
  let afterNumber = false; // whether the last word was a number, whose `.` is a decimal point
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
  const after = (literal) => {
    expectValue = false;
    unsure = false;
    lastWord = null;
    lastToken = "value";
    afterDot = false;
    afterNumber = false;
    lineStart = false;
    return literal;
  };

  // Copies code from i to the `}` that closes a template substitution (when nested) or the end.
  const code = (i, nested) => {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      const d = text[i + 1];
      let end;
      if ((c === "/" && d === "/") || (c === "#" && d === "!" && i === 0)
        // In a script, `<!--` begins a line comment, and so does `-->` at a line's start.
        || ((text.startsWith("<!--", i) || (lineStart && text.startsWith("-->", i)))
          && (goal === "either" ? decide(true) : goal === "script"))) {
        end = lineComment(i);
        out.push(blank(text.slice(i, end)));
        i = end;
        continue;
      }
      if (c === "/" && d === "*") {
        end = blockComment(i);
        out.push(blank(text.slice(i, end)));
        if (endsLine(text.slice(i, end))) lineStart = true;
        i = end;
        continue;
      }
      if (c === "'" || c === '"') {
        end = quoted(i);
        out.push(after(literals ? hollow(text.slice(i, end), c, c) : text.slice(i, end)));
        i = end;
        continue;
      }
      if (c === "`") { i = template(i); after(); continue; }
      if (c === "/" && (unsure ? decide(expectValue) : expectValue)) {
        end = regex(i);
        out.push(after(literals ? blank(text.slice(i, end)) : text.slice(i, end)));
        i = end;
        continue;
      }

      JS_WORD.lastIndex = i;
      const word = JS_WORD.exec(text);
      if (word) {
        out.push(word[0]);
        i += word[0].length;
        // `x.default / 2` and `this.#default / 2` divide: there a keyword is only a name.
        expectValue = !afterDot && JS_KEYWORDS_BEFORE_EXPRESSION.has(word[0]);
        // In a module `await` and `yield` are always keywords; `of` is one only in a for-of.
        unsure = expectValue && JS_CONTEXTUAL_KEYWORDS.has(word[0]) && (goal !== "module" || word[0] === "of");
        lastWord = word[0];
        lastWasName = afterDot;
        lastToken = !afterDot && (word[0] === "else" || word[0] === "do") ? word[0] : "value";
        afterDot = false;
        afterNumber = /^[0-9]/.test(word[0]);
        lineStart = false;
        continue;
      }
      // `a++ / 2` divides: a `++` or `--` after a value leaves a value.
      if ((c === "+" || c === "-") && d === c && !expectValue) {
        out.push(c, d);
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
        if (nested && depth === 0) { out.push(c); return i + 1; }
        depth -= 1;
        closed = braces.pop() ?? "unsure";
      }
      out.push(c);
      i += 1;
      if (endsLine(c)) { lineStart = true; continue; }
      if (/\s/.test(c)) continue;
      lineStart = false;
      lastWord = null;
      // Not a `.` of a spread (`...typeof /re/`) or a number's decimal point (`1. in /re/`).
      afterDot = c === "#" || (c === "." && text[i - 2] !== "." && text[i] !== "." && !afterNumber);
      afterNumber = false;
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
    out.push("`");
    const kept = (s) => (literals ? blank(s) : s);
    for (i += 1; i < n; i += 1) {
      const c = text[i];
      if (c === "\\") { out.push(kept(text.slice(i, i + 2))); i += 1; continue; }
      if (c === "`") { out.push(c); return i + 1; }
      if (c === "$" && text[i + 1] === "{") {
        out.push("${");
        expectValue = true;
        unsure = false;
        i = code(i + 2, true) - 1;
        continue;
      }
      out.push(kept(c));
    }
    return n;
  };

  code(0, false);
  return { out: out.join(""), choices };
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
const JS_ENV_READS = [
  /\bprocess\s*(?:\?\.|\.)\s*env\s*(?:\?\.|\.)\s*([\p{L}_$][\p{L}\p{N}_$]*)/gu,
  /\bprocess\s*(?:\?\.|\.)\s*env\s*(?:\?\.)?\s*\[\s*(["'`])([^"'`\\$]+)\1\s*\]/g,
];
const JS_ENV_DESTRUCTURING = /\{([^{}]*)\}\s*=\s*process\s*(?:\?\.|\.)\s*env\b/g;
const PY_ENV_READS = [
  /\bos\.environ\s*\[\s*(["'])([^"'\\]+)\1\s*\]/g,
  /\bos\.environ\.get\(\s*(["'])([^"'\\]+)\1/g,
  /\bos\.getenv\(\s*(["'])([^"'\\]+)\1/g,
];

const DESTRUCTURED_KEY = /^\s*(?:(["'])(?<quoted>[^"']+)\1|(?<plain>[\p{L}_$][\p{L}\p{N}_$]*))/du;

/** The names a destructuring pattern takes from the environment. A rest element takes no
 *  one name and is not counted. */
function destructured(code, lineAt) {
  const found = [];
  for (const m of code.matchAll(JS_ENV_DESTRUCTURING)) {
    let offset = m.index + 1;
    for (const item of m[1].split(",")) {
      const key = DESTRUCTURED_KEY.exec(item);
      if (key) {
        const name = key.groups.quoted ?? key.groups.plain;
        const at = offset + (key.indices.groups.quoted ?? key.indices.groups.plain)[0];
        found.push({ name, line: lineAt(at), at });
      }
      offset += item.length + 1;
    }
  }
  return found;
}

function envIn(code, language, lineAt) {
  const env = [];
  const patterns = language === "python" ? PY_ENV_READS : JS_ENV_READS;
  for (const pattern of patterns) {
    for (const m of code.matchAll(pattern)) {
      const name = m[2] ?? m[1];
      env.push({ name, line: lineAt(m.index), at: m.index });
    }
  }
  if (language === "javascript") env.push(...destructured(code, lineAt));
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
  const t = tokens.filter((x) => x.type !== "comment" && x.type !== "newline");
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
const PY_ESCAPE = /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([0-7]{1,3})|(\r\n|\r|\n)|([\\'"abfnrtv]))/g;
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
      body = body.replace(PY_ESCAPE, (_, hex, unit, wide, octal, continued, single) => {
        if (hex || unit || wide) return String.fromCodePoint(parseInt(hex ?? unit ?? wide, 16));
        if (octal) return String.fromCharCode(parseInt(octal, 8));
        return continued ? "" : PY_SINGLE_ESCAPES[single];
      });
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
  const all = tokens.filter((x) => x.type !== "comment" && x.type !== "newline");
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

/** What a program reaches: { urls: [{host, line}], env: [{name, line}], spawns: [{what, line}],
 *  imports, coding }, each in the order it appears. A JavaScript import is {specifier, value,
 *  esm, line}: the string as written, its value, and whether it is an ES module import. A
 *  Python one is {specifier, names, line}: the module path without its spaces and the names a
 *  `from` imports from it, with `undecodable` when its literal cannot be read. `coding` is a
 *  Python program's PEP 263 declaration, {name, line}, or null. `path`, when given, says
 *  whether a JavaScript program is a script (.cjs) or a module (.mjs). */
export function findReach(source, language, path = "") {
  // A byte order mark is not code: Python skips it, and JavaScript reads it as space.
  const text = source.charCodeAt(0) === 0xfeff ? ` ${source.slice(1)}` : source;
  const python = language === "python";
  const tokens = python ? pythonTokens(text) : null;
  // Node reads a .cjs file as a script and a .mjs file as a module; a .js or .ts file may be either.
  const goal = /\.cjs$/i.test(path) ? "script" : /\.mjs$/i.test(path) ? "module" : "either";
  const code = python ? blankPythonComments(text, tokens) : blankJavaScriptComments(text, false, goal);
  const lineAt = lineFinder(code);
  const imports = python ? pythonImports(text, tokens, lineAt) : jsImports(code, blankJavaScriptComments(text, true, goal), lineAt);
  return {
    urls: inOrder(urlsIn(code, lineAt)),
    env: inOrder(envIn(code, language, lineAt)),
    spawns: inOrder(spawnsIn(language, imports, tokens, lineAt)),
    imports: inOrder(imports),
    coding: python ? pythonCoding(text) : null,
  };
}
