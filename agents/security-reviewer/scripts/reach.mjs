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

const JS_WORD = /[\p{L}\p{N}_$]+/uy;
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

/** JavaScript with its comments blanked. Strings, templates and regular expression literals
 *  are kept as they are, so a comment marker inside one is not taken for a comment. With
 *  `literals`, what lies inside each of them is blanked too, so that text a literal only
 *  contains is not taken for code. */
function blankJavaScriptComments(text, literals = false) {
  const out = [];
  const n = text.length;
  let expectValue = true; // whether a `/` here would begin a regular expression
  let lastWord = null; // the word just before, when nothing but space or comments followed it
  let afterDot = false; // whether a `.` came just before, so that a word is a property name
  const parens = []; // for each open `(`, whether it opens a condition (JS_KEYWORDS_BEFORE_CONDITION)

  const lineComment = (i) => { JS_LINE_END.lastIndex = i; const m = JS_LINE_END.exec(text); return m ? m.index : n; };
  const blockComment = (i) => { const end = text.indexOf("*/", i + 2); return end === -1 ? n : end + 2; };
  const quoted = (i) => {
    const q = text[i];
    for (i += 1; i < n; i += 1) {
      if (text[i] === "\\") i += 1;
      else if (text[i] === q || text[i] === "\n") return i + 1;
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
      else if (c === "\n") return i;
      else if (c === "/" && !inClass) { i += 1; break; }
    }
    while (i < n && /[a-z]/i.test(text[i])) i += 1;
    return i;
  };

  // Copies code from i to the `}` that closes a template substitution (when nested) or the end.
  const code = (i, nested) => {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      const d = text[i + 1];
      let end;
      if (c === "/" && d === "/") { end = lineComment(i); out.push(blank(text.slice(i, end))); i = end; continue; }
      if (c === "/" && d === "*") { end = blockComment(i); out.push(blank(text.slice(i, end))); i = end; continue; }
      if (c === "#" && d === "!" && i === 0) { end = lineComment(i); out.push(blank(text.slice(i, end))); i = end; continue; }
      let literal;
      if (c === "'" || c === '"') { end = quoted(i); literal = literals ? hollow(text.slice(i, end), c, c) : text.slice(i, end); }
      else if (c === "`") { i = template(i); expectValue = false; lastWord = null; afterDot = false; continue; }
      else if (c === "/" && expectValue) { end = regex(i); literal = literals ? blank(text.slice(i, end)) : text.slice(i, end); }
      if (end !== undefined) { out.push(literal); i = end; expectValue = false; lastWord = null; afterDot = false; continue; }

      JS_WORD.lastIndex = i;
      const word = JS_WORD.exec(text);
      if (word) {
        out.push(word[0]);
        i += word[0].length;
        // `x.default / 2` divides: after a `.` a keyword is only a property's name.
        expectValue = !afterDot && JS_KEYWORDS_BEFORE_EXPRESSION.has(word[0]);
        lastWord = word[0];
        afterDot = false;
        continue;
      }
      if (c === "(") parens.push(JS_KEYWORDS_BEFORE_CONDITION.has(lastWord));
      if (c === "{") depth += 1;
      if (c === "}") {
        if (nested && depth === 0) { out.push(c); return i + 1; }
        depth -= 1;
      }
      out.push(c);
      i += 1;
      if (/\s/.test(c)) continue;
      lastWord = null;
      afterDot = c === ".";
      // After a value (`x)`, `a]`) a `/` divides. After a condition's `)` or a block's `}` a
      // statement starts, where it begins a regular expression; an object literal followed
      // by a division is the rare case this gets wrong.
      if (c === ")") expectValue = parens.pop() === true;
      else expectValue = c !== "]";
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
        i = code(i + 2, true) - 1;
        continue;
      }
      out.push(kept(c));
    }
    return n;
  };

  code(0, false);
  return out.join("");
}

/** Python with its `#` comments blanked. Strings, triple-quoted ones included, are kept, or
 *  with `literals` kept with what lies between their quotes blanked. */
function blankPythonComments(text, literals = false) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "#") {
      PY_LINE_END.lastIndex = i;
      const end = PY_LINE_END.exec(text);
      const stop = end ? end.index : n;
      out.push(blank(text.slice(i, stop)));
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      const triple = text.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      let j = i + close.length;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text.startsWith(close, j)) { j += close.length; break; }
        if (!triple && text[j] === "\n") break;
        j += 1;
      }
      out.push(literals ? hollow(text.slice(i, j), close, close) : text.slice(i, j));
      i = j;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
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

const JS_SPAWNS = [/\b(?:from|import|require)\s*\(?\s*(["'`])(?:node:)?child_process\1/g];
// An import starts a line or follows `:` (`if x: import subprocess`) or `;` (`a = 1; import …`).
const PY_SPAWNS = [
  /(?:^|[;:])[ \t]*(?:import[ \t]+[^\n#;]*\bsubprocess\b|from[ \t]+subprocess[ \t]+import\b)/gm,
  /\bos\.system\s*\(/g,
];

function spawnsIn(code, language, lineAt) {
  const patterns = language === "python" ? PY_SPAWNS : JS_SPAWNS;
  const spawns = [];
  for (const pattern of patterns) {
    for (const m of code.matchAll(pattern)) {
      spawns.push({ what: m[0].replace(/^[;:]/, "").trim(), line: lineAt(m.index), at: m.index });
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

// Python's imports. A statement starts a line or follows `:` or `;`, as in PY_SPAWNS; space,
// a form feed or a line continuation may sit between its words and its dots.
const PY_GAP = String.raw`(?:[ \t\f]|\\\r?\n)`;
const PY_NAME = String.raw`[\p{L}\p{N}_]`;
// A line that a `\` continues is not a statement's start.
const PY_START = String.raw`(?:^(?<!\\\r?\n)|[;:])`;
const PY_FROM = new RegExp(String.raw`${PY_START}${PY_GAP}*from(?=[ \t\f.\\])((?:${PY_GAP}|[.]|${PY_NAME})*?)(?<!${PY_NAME})import(?!${PY_NAME})`, "gmu");
const PY_IMPORT = new RegExp(String.raw`${PY_START}${PY_GAP}*import(?=[ \t\f\\])`, "gmu");
const PY_DOTTED = new RegExp(String.raw`^(?:\s|\\)*(${PY_NAME}+(?:(?:\s|\\)*\.(?:\s|\\)*${PY_NAME}+)*)`, "u");
const PY_IMPORT_MODULE = new RegExp(String.raw`(?<!${PY_NAME})import_module\s*\(\s*(?=[rRuU]?["'])`, "gu");
const PY_STRINGS = { '"': /"((?:[^"\\\n]|\\[\s\S])*)"/y, "'": /'((?:[^'\\\n]|\\[\s\S])*)'/y };
const PY_ESCAPE = /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([0-7]{1,3})|(\r?\n)|([\\'"abfnrtv]))/g;
const PY_SINGLE_ESCAPES = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
const squeezed = (s) => s.replace(/\\\r?\n|[ \t\f]/g, "");

/** The rest of a logical line from i, or what a `(` there holds, up to its `)`. */
function pythonRest(hollowed, i) {
  const open = /(?:[ \t\f]|\\\r?\n)*\(/y;
  open.lastIndex = i;
  if (open.test(hollowed)) {
    const close = hollowed.indexOf(")", open.lastIndex);
    return hollowed.slice(open.lastIndex, close === -1 ? undefined : close);
  }
  const line = /(?:[^\n\r;\\]|\\\r?\n|\\)*/y;
  line.lastIndex = i;
  return line.exec(hollowed)[0];
}

/** The first name of each comma-separated item: `a as b, c` gives a and c. */
const pythonNames = (list) => list.split(",").map((item) => PY_DOTTED.exec(item)?.[1]).filter(Boolean)
  .map((name) => name.replace(/\s|\\/g, ""));

function pythonImports(code, hollowed, lineAt) {
  const imports = [];
  for (const m of hollowed.matchAll(PY_FROM)) {
    const at = m.index + m[0].indexOf("from") + 4;
    imports.push({ specifier: squeezed(m[1]), names: pythonNames(pythonRest(hollowed, m.index + m[0].length)), line: lineAt(at), at });
  }
  for (const m of hollowed.matchAll(PY_IMPORT)) {
    const at = m.index + m[0].length;
    for (const module of pythonNames(pythonRest(hollowed, at))) imports.push({ specifier: module, names: [], line: lineAt(at), at });
  }
  for (const m of hollowed.matchAll(PY_IMPORT_MODULE)) {
    let at = m.index + m[0].length;
    const raw = /[rR]/.test(code[at]);
    if (/[rRuU]/.test(code[at])) at += 1;
    const literal = PY_STRINGS[code[at]];
    literal.lastIndex = at;
    const found = literal.exec(code);
    if (!found) continue;
    CALL_ENDS.lastIndex = at + found[0].length;
    if (!CALL_ENDS.test(hollowed)) continue;
    const value = raw ? found[1] : found[1].replace(PY_ESCAPE, (all, hex, unit, wide, octal, continued, single) => {
      if (hex || unit || wide) return String.fromCodePoint(parseInt(hex ?? unit ?? wide, 16));
      if (octal) return String.fromCharCode(parseInt(octal, 8));
      return continued ? "" : PY_SINGLE_ESCAPES[single];
    });
    imports.push({ specifier: value, names: [], line: lineAt(at), at });
  }
  return imports;
}

const inOrder = (found) => found.sort((a, b) => a.at - b.at).map(({ at: _at, ...rest }) => rest);

/** What a program reaches: { urls: [{host, line}], env: [{name, line}], spawns: [{what, line}],
 *  imports }, each in the order it appears. A JavaScript import is {specifier, value, esm,
 *  line}: the string as written, its value, and whether it is an ES module import. A Python
 *  one is {specifier, names, line}: the module path without its spaces, and the names a
 *  `from` imports from it. */
export function findReach(text, language) {
  const python = language === "python";
  const code = python ? blankPythonComments(text) : blankJavaScriptComments(text);
  const hollowed = python ? blankPythonComments(text, true) : blankJavaScriptComments(text, true);
  const lineAt = lineFinder(code);
  return {
    urls: inOrder(urlsIn(code, lineAt)),
    env: inOrder(envIn(code, language, lineAt)),
    spawns: inOrder(spawnsIn(code, language, lineAt)),
    imports: inOrder(python ? pythonImports(code, hollowed, lineAt) : jsImports(code, hollowed, lineAt)),
  };
}
