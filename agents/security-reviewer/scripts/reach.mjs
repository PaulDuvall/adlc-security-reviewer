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

const JS_WORD = /[\p{L}\p{N}_$]+/uy;
const JS_KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);
// A `)` closing the condition of one of these is followed by a statement, so a `/` there
// begins a regular expression rather than a division.
const JS_KEYWORDS_BEFORE_CONDITION = new Set(["if", "while", "for", "with"]);
// Line terminators. A JavaScript comment ends at any of them, so code after a U+2028 runs;
// a Python line ends at \n or a lone \r.
const JS_LINE_END = /[\n\r\u2028\u2029]/g;
const PY_LINE_END = /[\n\r]/g;

/** JavaScript with its comments blanked. Strings, templates and regular expression literals
 *  are kept as they are, so a comment marker inside one is not taken for a comment. */
function blankJavaScriptComments(text) {
  const out = [];
  const n = text.length;
  let expectValue = true; // whether a `/` here would begin a regular expression
  let lastWord = null; // the word just before, when nothing but space or comments followed it
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
      if (c === "'" || c === '"') end = quoted(i);
      else if (c === "`") { i = template(i); expectValue = false; lastWord = null; continue; }
      else if (c === "/" && expectValue) end = regex(i);
      if (end !== undefined) { out.push(text.slice(i, end)); i = end; expectValue = false; lastWord = null; continue; }

      JS_WORD.lastIndex = i;
      const word = JS_WORD.exec(text);
      if (word) {
        out.push(word[0]);
        i += word[0].length;
        expectValue = JS_KEYWORDS_BEFORE_EXPRESSION.has(word[0]);
        lastWord = word[0];
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
    for (i += 1; i < n; i += 1) {
      const c = text[i];
      if (c === "\\") { out.push(text.slice(i, i + 2)); i += 1; continue; }
      if (c === "`") { out.push(c); return i + 1; }
      if (c === "$" && text[i + 1] === "{") {
        out.push("${");
        expectValue = true;
        i = code(i + 2, true) - 1;
        continue;
      }
      out.push(c);
    }
    return n;
  };

  code(0, false);
  return out.join("");
}

/** Python with its `#` comments blanked. Strings, triple-quoted ones included, are kept. */
function blankPythonComments(text) {
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
      out.push(text.slice(i, j));
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

const inOrder = (found) => found.sort((a, b) => a.at - b.at).map(({ at: _at, ...rest }) => rest);

/** What a program reaches: { urls: [{host, line}], env: [{name, line}], spawns: [{what, line}] },
 *  each in the order it appears. */
export function findReach(text, language) {
  const code = language === "python" ? blankPythonComments(text) : blankJavaScriptComments(text);
  const lineAt = lineFinder(code);
  return {
    urls: inOrder(urlsIn(code, lineAt)),
    env: inOrder(envIn(code, language, lineAt)),
    spawns: inOrder(spawnsIn(code, language, lineAt)),
  };
}
