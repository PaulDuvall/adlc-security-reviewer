// Find what a program reaches: URLs in its code, the environment variables it reads, and
// whether it starts other processes (SR-08, SR-09, SR-17). Comments are blanked first, with
// their line breaks kept, so every finding keeps its line and no comment counts.
import { stripTypeScriptTypes } from "node:module";

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
// Words that no declared name may be, so that `let` before one is a plain name.
const JS_RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
]);
// Words that a name on the next line may follow in the same statement, TypeScript's included.
const JS_TAKES_NEXT = new Set([
  "function", "class", "async", "get", "set", "static", "var", "let", "const", "import", "export", "try", "finally",
  "catch", "if", "for", "while", "with", "switch", "enum", "interface", "implements", "package", "private", "public",
  "protected", "as", "satisfies", "is", "keyof", "infer", "readonly", "unique", "asserts", "declare", "abstract",
  "type", "namespace", "module", "global", "override", "accessor", "out",
]);
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
 *  for code), `literals`, the spans of its string and template text, and `regexes`, those of
 *  its regular expressions. A program with more readings than JS_READINGS gives the first,
 *  with every choice made by default, and one reading in which nothing is blanked and all of
 *  it may be a literal. */
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
      return [readings[0], { code: text, hollowed: text, literals: [[0, text.length]], tagged: [], regexes: [], whole: true }];
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
  const tagged = []; // the spans of tagged templates' text
  const regexes = [];
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
  let endsAtLine = false; // whether a line end here ends the statement, as after `break`
  // In a declaration: "name" where a name is due, "after" just after one; "maybe" and "maybe
  // after" where a line end in an initializer may have ended the declaration before its `,`.
  let binding = null;
  // The declarations that may go on, the innermost last: for each, the depth of brackets it
  // began at, whether a line end came at that depth in one of its initializers, and whether
  // a TypeScript type follows the name just declared.
  const declarations = [];
  // Whether a line end just followed one of its names, so that a `,`, `=` or `:` next goes on
  // with it; "typed" after its type, which `|`, `&`, `.` or `<` may go on with too, but not
  // `[`: no line end may come before an array type's.
  let resumes = false;
  let brackets = 0; // how many `[` are open
  let substitutions = 0; // how many template substitutions are open
  const level = () => parens.length + braces.length + brackets + substitutions;
  // The depth an `import` or `export` began at, while a `from` there may begin its from clause;
  // whether no token has followed it yet; and whether its `{…}` has closed, so that only `from` may follow.
  let clause = null;
  let clauseFirst = false;
  let clauseClosed = false;
  let exporting = false;
  const parens = []; // for each open `(`: "for"; "cond" after if, while or with; "block" after catch or switch
  const braces = []; // for each open `{`: "block", "object" or "unsure", as braceKind decides
  const braceParens = []; // for each open `{`, how many `(` were open around it

  // What a `{` opens, which decides what a `/` after its `}` begins.
  const braceKind = () => {
    if (!expectValue) {
      if (lastToken === ")block" || (!lastWasName && (lastWord === "try" || lastWord === "finally"))) return "block";
      return "unsure"; // a function's or a class's body
    }
    // `of` or `await` may be a name, and then a line end ends the statement: a block or an
    // object literal.
    if (unsure && lineStart && !lastWasName && (lastWord === "of" || lastWord === "await")) return "unsure";
    // In a for's header, `;` separates expressions, so a `{` after it opens an object literal.
    if (lastToken === ";" && parens.at(-1) === "for" && parens.length > (braceParens.at(-1) ?? 0)) return "object";
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
    endsAtLine = false;
    binding = null;
    if (clause !== null && level() <= clause) clause = null;
  };
  // A name, number or string that begins a line after a value cannot go on with its
  // statement, so ASI ended that statement at the line end, and a declaration at this depth.
  // After a word such as `function` or TypeScript's `as`, a name on the next line goes on.
  const valueStarts = () => {
    if (lineStart && !expectValue && !unsure && binding === null && declarations.at(-1)?.at === level()
      && (lastWord === null || lastWasName || !JS_TAKES_NEXT.has(lastWord))) declarations.pop();
  };
  // Where a statement list may go on, so that `let` there may begin a declaration: not as the
  // one statement after `if (…)`, `while (…)`, `for (…)`, `with (…)`, `else` or `do`, where no
  // declaration may stand. After a `:` it may be a case's (yes) or a label's (no), or part of
  // an expression: "choice".
  const startsStatement = () => {
    if (lastToken === ":") return "choice";
    return lastToken === null || [";", "{", "}"].includes(lastToken)
      || (lastToken === "(" && parens.at(-1) === "for") || (lineStart && !expectValue && !unsure)
      || (!lastWasName && (lastWord === "export" || lastWord === "declare"));
  };
  // Whether a name follows a `type` that ends at i on its line, as in `type A = B`.
  const aliasFollows = (i) => {
    while (i < n && (text[i] === " " || text[i] === "\t")) i += 1;
    JS_WORD.lastIndex = i;
    const next = JS_WORD.exec(text);
    return next !== null && !/^\d/.test(next[0]) && !JS_RESERVED.has(next[0]);
  };
  // Where the next token after i begins, past space and comments, a script's `<!--` and a
  // line's leading `-->` too where the reading may be a script's.
  const nextToken = (i) => {
    let atLine = false;
    while (i < n) {
      const c = text[i];
      if (JS_SPACE.test(c)) { if (endsLine(c)) atLine = true; i += 1; continue; }
      let end = -1;
      if (text.startsWith("//", i) || (script !== false && (text.startsWith("<!--", i) || (atLine && text.startsWith("-->", i))))) end = lineComment(i);
      else if (text.startsWith("/*", i)) { end = blockComment(i); if (endsLine(text.slice(i, end))) atLine = true; }
      if (end === -1) break;
      i = end;
    }
    return i;
  };
  // Whether a `let` that ends at i declares: a name, `[` or `{` follows it. Elsewhere, in a
  // script, it is a plain name, and so it is before a word no name may be, such as `this`.
  const letDeclares = (i) => {
    i = nextToken(i);
    if (text[i] === "[" || text[i] === "{") return true;
    JS_WORD.lastIndex = i;
    const next = JS_WORD.exec(text);
    return next !== null && !/^\d/.test(next[0]) && !JS_RESERVED.has(next[0]);
  };
  // A line end, or a comment holding one. After `return` or `yield` it ends the statement, as
  // no line end may come between either and its operand, so a `{` there opens a block. After
  // `break`, `continue` and its label, `debugger`, a declared name with no initializer, or an
  // import's string, nothing that follows may continue the statement, so it ends there too,
  // and a `/` on the next line begins a regular expression.
  const lineEnded = () => {
    lineStart = true;
    if (!lastWasName && (lastWord === "return" || lastWord === "yield")) lastToken = ";";
    const top = declarations.at(-1);
    // No type has a `/`: after a declared name's type, a line end ends the declaration, so a
    // `/` next begins a regular expression, unless the next line goes on with it.
    const typedEnd = top?.typed && top.at === level() && binding === null && !unsure
      && (!expectValue || (!lastWasName && lastWord === "void"));
    if (top?.at === level() && binding === null && !typedEnd) top.wrapped = true;
    if (typedEnd) {
      expectValue = true;
      lastToken = ";";
      resumes = "typed";
    }
    if (binding === "maybe after") {
      unsure = true; // a `/` next divides, or begins a regular expression
      binding = null;
    }
    if (endsAtLine) {
      expectValue = true;
      unsure = false;
      lastToken = ";";
      endsAtLine = false;
      // A declaration goes on where the next line starts with a `,`, `=` or `:`, and ends otherwise.
      resumes = binding === "after";
      if (!resumes && top?.at === level()) declarations.pop();
      binding = null;
    }
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
      if (resumes && !/\s/.test(c) && !(c === "/" && (d === "/" || d === "*")) && !(html && script)) {
        // A `=` or `:` goes on with the same name, with its initializer or its type.
        if (c !== "," && c !== "=" && c !== ":" && !(resumes === "typed" && "|&.<".includes(c))) declarations.pop();
        resumes = false;
      }
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
        if (endsLine(text.slice(i, end))) lineEnded();
        i = end;
        continue;
      }
      if (c === "'" || c === '"') {
        valueStarts();
        end = quoted(i);
        const s = text.slice(i, end);
        emit(s, hollow(s, c, c));
        literals.push([i + 1, s.length > 1 && s.endsWith(c) ? end - 1 : end]);
        // The module an import or export names ends its declaration: the string after `import`,
        // or after the `from` of its from clause. Elsewhere `from` is a plain name.
        const named = !lastWasName && (lastWord === "import" || (lastWord === "from" && clause === level()));
        after(s);
        endsAtLine = named;
        i = end;
        continue;
      }
      // A template after a value is tagged: its tag may take its text as written, as String.raw does.
      if (c === "`") { i = template(i, !expectValue); after(); continue; }
      if (c === "/" && (unsure ? decide(expectValue) : expectValue)) {
        end = regex(i);
        regexes.push([i, end]);
        emit(text.slice(i, end), blank(text.slice(i, end)));
        after();
        i = end;
        continue;
      }

      JS_NUMBER.lastIndex = i;
      const number = /[0-9]/.test(c) || (c === "." && /[0-9]/.test(d ?? "")) ? JS_NUMBER.exec(text) : null;
      if (number) { valueStarts(); emit(number[0]); i += number[0].length; after(); continue; }
      JS_WORD.lastIndex = i;
      const word = JS_WORD.exec(text);
      if (word) {
        const keyword = !afterDot ? word[0] : null;
        if (keyword !== "in" && keyword !== "instanceof") valueStarts();
        emit(word[0]);
        i += word[0].length;
        const label = keyword !== null && !lineStart && !lastWasName && (lastWord === "break" || lastWord === "continue");
        // Where a name is due, `let` is that name, as in a script's `var let`.
        const starts = keyword === "let" && binding !== "name" && binding !== "maybe" ? startsStatement() : false;
        // `var` and `const` declare, but where a `:`, `(`, `=`, `,` or `}` follows them, as in
        // `{ var: 1 }`, they are keys.
        const declares = ((keyword === "var" || keyword === "const") && !":(=,}".includes(text[nextToken(i)] ?? "\0"))
          || (starts !== false && letDeclares(i) && (starts === true || decide(true)));
        // TypeScript's `type A = …` declares a type, which a line end may end as it ends one after a name.
        const alias = keyword === "type" && !declares && binding === null && startsStatement() === true && aliasFollows(i);
        if (declares || alias) {
          while (declarations.length && declarations.at(-1).at >= level()) declarations.pop();
          declarations.push({ at: level(), wrapped: false, alias });
          binding = "name";
        } else binding = keyword !== null && binding === "name" ? "after" : keyword !== null && binding === "maybe" ? "maybe after" : null;
        if (keyword === "import" || keyword === "export") {
          clause = level();
          clauseFirst = true;
          clauseClosed = false;
          exporting = keyword === "export";
        } else if (clause === level()) {
          // An export's clause begins with `{`, `*` or `type`, and after its `{…}` only `from` may come.
          if (keyword !== "from" && (clauseClosed || (clauseFirst && exporting && keyword !== "type"))) clause = null;
          clauseFirst = false;
        }
        endsAtLine = label || keyword === "break" || keyword === "continue" || keyword === "debugger" || binding === "after";
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
      // before a postfix one, so after a line end it is a prefix and a value follows. After
      // `of` or `await`, which may be names, it may be either.
      if ((c === "+" || c === "-") && d === c && !lineStart && (!expectValue || (unsure && !decide(true)))) {
        emit(c + d);
        i += 2;
        after();
        continue;
      }
      // `<<` is one token, so a `<!--` that starts on its second `<` begins no comment.
      if (c === "<" && d === "<") {
        emit("<<");
        i += 2;
        lineStart = false;
        lastWord = null;
        endsAtLine = false;
        binding = null;
        afterDot = false;
        dots = 0;
        unsure = false;
        lastToken = "<";
        expectValue = true;
        continue;
      }
      if (c === "(") {
        const keyword = !lastWasName && lastWord;
        parens.push(keyword === "for" ? "for" : JS_KEYWORDS_BEFORE_CONDITION.has(keyword) ? "cond"
          : keyword === "catch" || keyword === "switch" ? "block" : "call");
      }
      let closed = null;
      if (c === "{") { depth += 1; braces.push(braceKind()); braceParens.push(parens.length); }
      if (c === "}") {
        if (nested && depth === 0) { emit(c); return i + 1; }
        depth -= 1;
        closed = braces.pop() ?? "unsure";
        braceParens.pop();
      }
      emit(c);
      i += 1;
      if (endsLine(c)) { lineEnded(); continue; }
      if (/\s/.test(c)) continue;
      const startedLine = lineStart;
      lineStart = false;
      lastWord = null;
      endsAtLine = false;
      if (c === "[") brackets += 1;
      else if (c === "]" && brackets) brackets -= 1;
      const kind = c === ")" ? parens.pop() : null;
      // A `,` at a declaration's own depth begins another of its names; a `;` there ends it, and
      // so does any token at a lower depth.
      while (declarations.length && (level() < declarations.at(-1).at || (c === ";" && level() === declarations.at(-1).at))) {
        declarations.pop();
      }
      const top = declarations.at(-1);
      if (top?.at === level()) {
        // A `:` after a declared name begins its TypeScript type, which an initializer or the
        // next name ends.
        if (c === ":" && (binding === "after" || binding === "maybe after")) top.typed = true;
        else if (c === "=" && top.alias && text[i] !== ">" && text[i] !== "=") top.typed = true;
        else if (c === "," || (c === "=" && text[i] !== ">" && text[i] !== "=")) top.typed = false;
      }
      binding = c === "," && top?.at === level() ? (top.wrapped ? "maybe" : "name") : null;
      // In an import's or export's clause, `*` and `,` may come before its `{…}` closes, and
      // after that only `from`; any other token ends the clause.
      if (clause !== null && level() <= clause) {
        if (level() === clause && c === "}" && !clauseClosed) clauseClosed = true;
        else if (level() < clause || clauseClosed || (c !== "*" && c !== ",")) clause = null;
        clauseFirst = false;
      }
      // A member `.`, not one of a spread's three (`...typeof /re/`), or a `#` of a private name.
      afterDot = c === "#" || (c === "." && dots === 0 && text[i] !== ".");
      dots = c === "." ? dots + 1 : 0;
      // After a value (`x)`, `a]`, an object literal's `}`) a `/` divides; after a condition's
      // `)` or a block's `}` a statement starts, where it begins a regular expression.
      unsure = closed === "unsure";
      lastToken = c === ">" && text[i - 2] === "=" ? "=>" : c;
      if (c === ")") {
        expectValue = kind === "cond" || kind === "for";
        lastToken = expectValue ? ")cond" : kind === "block" ? ")block" : ")";
      } else if (closed) {
        expectValue = closed !== "object";
        if (closed === "object") lastToken = "value";
      } else if (c === "!" && !expectValue && !startedLine && text[i] !== "=") {
        lastToken = "value"; // TypeScript's `x!`, still a value: in JavaScript a `!` there is no operator
      } else expectValue = c !== "]";
    }
    return i;
  };

  const template = (i, tag) => {
    emit("`");
    let start = i + 1;
    const piece = (end) => { literals.push([start, end]); if (tag) tagged.push([start, end]); };
    for (i += 1; i < n; i += 1) {
      const c = text[i];
      if (c === "\\") { const s = text.slice(i, i + 2); emit(s, blank(s)); i += 1; continue; }
      if (c === "`") { piece(i); emit(c); return i + 1; }
      if (c === "$" && text[i + 1] === "{") {
        piece(i);
        emit("${");
        // A substitution holds an expression, so a `{` there opens an object literal.
        expectValue = true;
        unsure = false;
        lastToken = "(";
        endsAtLine = false;
        binding = null;
        substitutions += 1;
        i = read(i + 2, true) - 1;
        substitutions -= 1;
        while (declarations.length && declarations.at(-1).at > level()) declarations.pop();
        if (clause !== null && clause > level()) clause = null;
        start = i + 1;
        continue;
      }
      emit(c, blank(c));
    }
    piece(n);
    return n;
  };

  read(0, false);
  return { code: code.join(""), hollowed: hollowed.join(""), literals, tagged, regexes, choices };
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
function pythonTokens(text, legacy = false, templates = true) {
  const tokens = [];
  let ambiguous = false; // whether a format spec has a `{{` that 3.12 reads otherwise
  const debugFields = []; // the expression text of each non-raw f-string field with an `=`
  const writtenFields = []; // that of each field with an `=`, and of each t-string field
  const n = text.length;
  const lineEnd = (i) => { PY_LINE_END.lastIndex = i; const m = PY_LINE_END.exec(text); return m ? m.index : n; };
  const breakLength = (i) => (text.startsWith("\r\n", i) ? 2 : 1);

  // Code from i, up to the `}` that closes a replacement field when inField, else to the end.
  // `close` is the quote of the f-string whose field this is, `raw` whether it is raw, and
  // `owner` its token.
  function code(i, inField, close, raw, owner, run = i) {
    const field = i;
    const site = inField ? field : -1; // where the code a string stands in begins
    let depth = 0;
    let debug = false; // whether an `=` ends the field's expression
    let conversion = -1; // where a conversion's `!` ends it
    let bang = -1; // where the first `!` stands, that of `!=` too
    // A field's expression is its text up to its conversion, its format spec or its end. With
    // an `=` it is debug text, part of the string; a 3.14 t-string keeps it in each
    // interpolation. 3.12 ends it at its first `!`, `!=` too, and 3.14.6 does so where a
    // format spec follows and no conversion; 3.12 has no t-strings.
    const expression = (end, spec) => {
      const to = conversion !== -1 ? conversion : end;
      const to146 = spec && conversion === -1 && bang !== -1 ? bang : to;
      const template = /[tT]/.test(owner.prefix);
      if (debug && !raw && !template) debugFields.push([field, bang !== -1 ? bang : to]);
      if (debug) owner.debugs.push({ from: field, to, run, to12: bang !== -1 ? bang : to, to146, template });
      if (debug || template) writtenFields.push([field, to, run, to146]);
    };
    while (i < n) {
      const c = text[i];
      if (c === "\\" && (text[i + 1] === "\n" || text[i + 1] === "\r")) { i += 1 + breakLength(i + 1); continue; }
      if (c === "#") {
        const end = lineEnd(i);
        tokens.push({ type: "comment", start: i, end, field: inField });
        i = end;
        continue;
      }
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
        if ((text[end] === "'" || text[end] === '"') && PY_STRING_PREFIX.test(name[0]) && (templates || !/[tT]/.test(name[0]))) i = string(i, end, inField, site);
        else { tokens.push({ type: "name", start: i, end, text: name[0], field: inField, site }); i = end; }
        continue;
      }
      if (c === "'" || c === '"') { i = string(i, i, inField, site); continue; }
      if (inField && !depth && c === "}") { expression(i, false); return i + 1; }
      if (inField && !depth && c === ":") { expression(i, true); return formatSpec(i + 1, close, raw, owner); }
      if (inField && !depth && c === "!" && bang === -1) bang = i;
      if (inField && !depth && c === "!" && text[i + 1] !== "=" && conversion === -1) conversion = i;
      if (inField && !depth && !debug && c === "=" && !/[=!<>]/.test(text[i - 1]) && text[i + 1] !== "=" && debugEnds(i + 1)) debug = true;
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if ((c === ")" || c === "]" || c === "}") && depth) depth -= 1;
      tokens.push({ type: "op", start: i, end: i + 1, text: c, field: inField, site });
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
  // escapes: each run of it is recorded on the f-string's token, and a raw one also as text
  // 3.13 keeps as written. After a line end in a one-quote f-string, 3.12 reads the rest of
  // the field as code; 3.13 rejects it.
  function formatSpec(i, close, raw, owner) {
    let afterField = false;
    let from = i;
    // CPython 3.14.6 reads a spec field that starts right where the one before it closed as
    // going on with that one's text: `run` is where the first of such a run began.
    let closed = -1;
    let run = -1;
    const parts = []; // the spec's text pieces and fields, in order, which CPython joins
    owner.specRuns.push(parts);
    const text_ = (end) => {
      if (end <= from) return;
      owner.specs.push([from, end]);
      parts.push([from, end]);
      if (raw) owner.kept.push([from, end]);
    };
    while (i < n) {
      if (text[i] === "\\") { i = escapeEnd(i, true, raw, close); continue; }
      if (text.startsWith(close, i)) { text_(i); return i; }
      if (close.length === 1 && (text[i] === "\n" || text[i] === "\r")) { text_(i); return code(i, true, close, raw, owner); }
      if (afterField && text.startsWith("{{", i)) {
        ambiguous = true;
        if (!legacy) { i += 2; continue; }
      }
      if (text[i] === "{") {
        text_(i);
        if (i !== closed) run = i + 1;
        const debugs = owner.debugs.length;
        parts.push({ field: i });
        i = code(i + 1, true, close, raw, owner, run);
        parts.at(-1).debug = owner.debugs.slice(debugs).find((d) => d.from === parts.at(-1).field + 1);
        closed = i;
        from = i;
        afterField = true;
        continue;
      }
      if (text[i] === "}") { text_(i); return i + 1; }
      i += 1;
    }
    text_(n);
    return n;
  }

  // Whether only space, line ends, comments and line continuations stand between i and a `!`,
  // `:` or `}`, so that the `=` just before i ends a field's expression.
  function debugEnds(i) {
    while (i < n) {
      if (text[i] === "#") i = lineEnd(i);
      else if (text[i] === "\\" && (text[i + 1] === "\n" || text[i + 1] === "\r")) i += 1 + breakLength(i + 1);
      else if (/\s/.test(text[i])) i += 1;
      else return text[i] === "!" || text[i] === ":" || text[i] === "}";
    }
    return false;
  }

  // Where the escape at i ends, in an f-string when formatted. A backslash does not escape a
  // brace there, so `{` still opens a field; a non-raw `\N{…}` is one escape, which CPython's
  // tokenizer reads to the next `}`, whatever the name holds, stopping before a `{`, the
  // f-string's quote or, in a one-quote f-string, a line end.
  function escapeEnd(i, formatted, raw, close) {
    if (formatted && !raw && text.startsWith("\\N{", i)) {
      for (let j = i + 3; j < n; j += 1) {
        if (text[j] === "}") return j + 1;
        if (text[j] === "{" || text.startsWith(close, j) || (close.length === 1 && (text[j] === "\n" || text[j] === "\r"))) return j;
      }
      return n;
    }
    if (formatted && (text[i + 1] === "{" || text[i + 1] === "}")) return i + 1;
    return i + 1 + (text.startsWith("\r\n", i + 1) ? 2 : 1);
  }

  function string(start, at, inField, site) {
    const prefix = text.slice(start, at);
    const q = text[at];
    const close = text.startsWith(q.repeat(3), at) ? q.repeat(3) : q;
    const formatted = /[fFtT]/.test(prefix);
    const raw = /[rR]/.test(prefix);
    const token = { type: "string", start, end: n, prefix, body: [at + close.length, n], fields: [], specs: [], kept: [], debugs: [], specRuns: [], field: inField, site };
    tokens.push(token);
    let j = at + close.length;
    while (j < n) {
      const c = text[j];
      if (c === "\\") { j = escapeEnd(j, formatted, raw, close); continue; }
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
  // CPython 3.12 cuts each `#` of debug text to its line's end, in a string too, and decodes
  // the escapes of what is left. 3.13 and later keep it as written, less the comments their
  // own scan finds.
  return Object.assign(tokens, { ambiguous, debug: debugTexts(text, debugFields), written: pythonWritten(text, writtenFields) });
}

/** The text that some field's 3.12 debug text keeps, each field less every `#` in it to its
 *  line's end, the line end kept: for each region of fields nested in one another, its kept
 *  pieces in order, read as one text, so that a backslash before a cut line end goes on
 *  with the next line as 3.12 decodes it. A field nested in another keeps what follows its
 *  own start, though a `#` before it on its line cuts the field around it there. So a
 *  character is kept where no `#` stands between it and the later of its line's start and
 *  the start of the innermost field around it; fields nest, so one sweep finds each. */
function cutAtHashes(text, fields) {
  const sorted = [...fields].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const groups = [];
  let out = [];
  const around = []; // the fields around the position, the innermost last
  let k = 0;
  let hash = -1; // the last `#` so far
  let line = -1; // the last line end so far
  let start = -1; // where the text kept now began
  for (let p = 0; k < sorted.length || around.length; p += 1) {
    while (around.length && around.at(-1)[1] <= p) around.pop();
    if (!around.length) {
      if (start !== -1) { out.push([start, p]); start = -1; }
      if (out.length) { groups.push(out); out = []; }
      if (k === sorted.length) break;
      p = Math.max(p, sorted[k][0]);
    }
    while (k < sorted.length && sorted[k][0] <= p) { if (sorted[k][1] > p) around.push(sorted[k]); k += 1; }
    if (!around.length) { p -= 1; continue; }
    if (text[p] === "#") hash = p;
    else if (text[p] === "\n" || text[p] === "\r") line = p;
    const kept = hash < Math.max(around.at(-1)[0], line + 1);
    if (kept && start === -1) start = p;
    else if (!kept && start !== -1) { out.push([start, p]); start = -1; }
  }
  return groups;
}

/** 3.12's debug text of each field, as pieces of the text read as one: each `=` field's own
 *  string, so that a backslash before a cut line end goes on with the next line as 3.12
 *  decodes it. Nested fields are read again within each field around them: past a budget,
 *  what the fields keep is read in pieces, each on its own. */
function debugTexts(text, fields) {
  let budget = 16 * text.length + 4000000;
  for (const [from, to] of fields) budget -= to - from;
  if (budget < 0) return cutAtHashes(text, fields).flat().map((piece) => [piece]);
  return fields.map((field) => cutAtHashes(text, [field])[0] ?? []).filter((pieces) => pieces.length);
}

/** CPython 3.13's and 3.14's scan of a field's expression text, from `from` to `to`, which
 *  follows quotes one character at a time: whether it finds a `#` outside them or, given
 *  `out`, the pieces it keeps, each such `#` cut to its line's end; given `marks`, a
 *  difference array, each range it cuts counted there instead. 3.13 skips the character after
 *  a backslash; where 3.14.6 strips, it does not, so an escaped quote turns its state. */
function quoteScan(text, from, to, escapes, out = null, marks = null) {
  let quote = "";
  let start = from;
  for (let i = from; i < to; i += 1) {
    const c = text[i];
    if (c === "\\" && escapes) { i += 1; continue; }
    if (c === '"' || c === "'") { if (!quote) quote = c; else if (c === quote) quote = ""; continue; }
    if (c !== "#" || quote) continue;
    if (!out && !marks) return true;
    if (out && i > start) out.push([start, i]);
    const hash = i;
    while (i < to && text[i] !== "\n" && text[i] !== "\r") i += 1;
    if (marks) { marks[hash] += 1; marks[i] -= 1; }
    start = i;
    i -= 1;
  }
  if (out && to > start) out.push([start, to]);
  return false;
}

/** 3.13's and 3.14.6's pieces of a field's expression text, the latter from the start of its run. */
function keptPieces(text, from, to, escapes) {
  const out = [];
  if (quoteScan(text, from, to, true)) quoteScan(text, from, to, escapes, out);
  else out.push([from, to]);
  return out;
}

/** The text CPython 3.13 and later keep of some field's expression, as either of their scans
 *  keeps it: in order and apart. Each field is two readings, 3.13's of its text and 3.14.6's
 *  from the start of its run; a character is kept where some reading around it does not cut
 *  it, so each reading's span and each range it cuts are counted. Nested fields are scanned
 *  again within each field around them, which CPython allows 150 levels deep: past a budget
 *  for that, a field's text is kept whole, its comments too, which fails closed. */
function pythonWritten(text, fields) {
  if (!fields.length) return [];
  let budget = PY_SCAN_BUDGET(text);
  const n = text.length;
  const cuts = new Int32Array(n + 1);
  const cover = new Int32Array(n + 1);
  // One reading of text[start, to), its cuts counted where its scan finds a `#` outside quotes.
  const reading = (start, to, escapes) => {
    if (to <= start) return;
    cover[start] += 1;
    cover[to] -= 1;
    budget -= 2 * (to - start);
    if (budget >= 0 && quoteScan(text, start, to, true)) quoteScan(text, start, to, escapes, null, cuts);
  };
  // 3.14.6's readings of a run of touching fields go on from the run's start, each a longer
  // prefix: the prefixes before its first `#` outside quotes keep their text whole, and the
  // rest cut as the longest does, so two readings stand for them all.
  const runs = new Map();
  for (const [from, to, run = from, to146 = to] of fields) {
    reading(from, to, true);
    if (run === from && !runs.has(run)) { reading(from, to146, false); continue; }
    const r = runs.get(run) ?? { ends: [] };
    r.ends.push(to146);
    runs.set(run, r);
  }
  for (const [run, { ends }] of runs) {
    let longest = run;
    for (const e of ends) longest = Math.max(longest, e);
    let hash = longest; // the first `#` the scan finds outside quotes
    for (let quote = "", i = run; i < longest; i += 1) {
      const c = text[i];
      if (c === "\\") { i += 1; continue; }
      if (c === '"' || c === "'") { if (!quote) quote = c; else if (c === quote) quote = ""; continue; }
      if (c === "#" && !quote) { hash = i; break; }
    }
    budget -= longest - run;
    let whole = run;
    for (const e of ends) if (e <= hash) whole = Math.max(whole, e);
    if (whole > run) { cover[run] += 1; cover[whole] -= 1; }
    if (longest > hash) reading(run, longest, false);
  }
  const out = [];
  let covered = 0; // how many readings span the character
  let cutting = 0; // how many of them cut it
  let begin = -1; // where the kept text now began
  for (let p = 0; p <= n; p += 1) {
    covered += cover[p];
    cutting += cuts[p];
    const kept = covered > 0 && cutting < covered && p < n;
    if (kept && begin === -1) begin = p;
    else if (!kept && begin !== -1) { out.push([begin, p]); begin = -1; }
  }
  return out;
}
const PY_SCAN_BUDGET = (text) => 460 * text.length + 10000000;

/** The parts of Python's strings read as text with escapes, str or bytes: each body, less an
 *  f-string's fields, whose code is read as code, but with the text of their format specs and,
 *  as 3.12 decodes it, of their `=` debug text. A raw string's body holds no escapes; with
 *  `raw`, its text is given too, for where a string only contains text. */
function pythonLiterals(tokens, bytes, raw = false) {
  const spans = [];
  for (const t of tokens) {
    if (t.type !== "string" || /[bB]/.test(t.prefix) !== bytes) continue;
    if (raw || !/[rR]/.test(t.prefix)) {
      let at = t.body[0];
      for (const [start, end] of t.fields) { if (start > at) spans.push([at, start]); at = Math.max(at, end); }
      if (t.body[1] > at) spans.push([at, t.body[1]]);
    }
    append(spans, t.specs);
  }
  if (!bytes) for (const pieces of tokens.debug) spans.push({ pieces });
  return spans.sort((a, b) => spanStart(a) - spanStart(b));
}

const spanStart = (span) => (Array.isArray(span) ? span[0] : span.pieces[0][0]);

/** Spans with each group of pieces spread out, in order. */
function flat(spans) {
  const out = [];
  for (const span of spans) if (Array.isArray(span)) out.push(span); else append(out, span.pieces);
  return out.sort((a, b) => a[0] - b[0]);
}

/** A literal's text, and where each of its characters was written: a span, or pieces of the
 *  text read as one. */
function bodyOf(text, span) {
  if (Array.isArray(span)) {
    const [start, end] = span;
    return { body: text.slice(start, end), place: (k) => start + k, end };
  }
  const { pieces } = span;
  const begins = [];
  let body = "";
  for (const [from, to] of pieces) { begins.push(body.length); body += text.slice(from, to); }
  const place = (k) => {
    let j = 0;
    let hi = begins.length - 1;
    while (j < hi) { const mid = (j + hi + 1) >> 1; if (begins[mid] <= k) j = mid; else hi = mid - 1; }
    return pieces[j][0] + k - begins[j];
  };
  return { body, place, end: pieces.at(-1)[1] };
}

/** Adds items to an array one at a time: a spread call fails past about 125,000 of them. */
function append(into, items) {
  for (const x of items) into.push(x);
  return into;
}

/** The text some CPython version keeps as written, though another decodes it: a raw
 *  f-string's specs. In order, and merged where they overlap. Debug text as written is read
 *  as pythonWritten keeps it. */
function pythonKept(tokens) {
  return merged(tokens.flatMap((t) => (t.type === "string" ? t.kept : [])));
}

/** Spans sorted, with those that overlap or touch merged. */
function merged(spans) {
  const out = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Text with all but the given spans, in order and apart, blanked. */
function only(text, spans) {
  let out = "";
  let at = 0;
  for (const [start, end] of spans) { out += blank(text.slice(at, start)) + text.slice(start, end); at = end; }
  return out + blank(text.slice(at));
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
  return withoutTrailingDots(host) || null;
}

/** Text without its trailing dots, in time linear in its length, as `/\.+$/` is not. */
function withoutTrailingDots(s) {
  let end = s.length;
  while (end > 0 && s[end - 1] === ".") end -= 1;
  return s.slice(0, end);
}

// SR-08 gives the parser the text after `//` up to the first character that cannot be part of
// an authority. Read as prose, an authority also ends at a bracket, a quotation mark or `,` or
// `;`, so "(see https://x.example)." names x.example; but where an `@` follows such a mark, it
// sat in a userinfo, and the host is the one the parser finds after the `@`. URL_IN_CODE's
// narrower authority, of the characters a host is usually written with, is tried when the
// prose text gives no host, and then the text up to the characters SR-08 names, which may hold
// those marks: the parser takes "https://«.x.example" to xn--iba.x.example. There a host needs
// a letter or a digit, as NFKC maps it, or brackets, so the "https://" of “https://” is no URL.
const URL_AUTHORITY = /(?:[[\]]|[^\s\p{Cc}/?#\\"'`$\{\}<>|^(),;\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Quotation_Mark}])*/uy;
const SR08_AUTHORITY = /[^\s\p{Cc}/?#\\"'`$\{\}]*/uy;

/** Whether an authority's host holds a character this review cannot decode, by a Python
 *  \N{…}, and is a host all the same: the parser accepts it with a letter in that place. */
const unreadHost = (scheme, authority) => hostPart(authority).host.includes(UNREADABLE)
  && hostOf(scheme, authority.replaceAll(UNREADABLE, "x")) !== null;

/** The host of a URL_IN_CODE match in text, the authority it was read from, and the text up to
 *  the characters SR-08 names. A host this review cannot decode is null, with the authority
 *  literalUrls names it from as written. */
function hostAt(text, m) {
  const from = m.index + m[1].length + 3;
  URL_AUTHORITY.lastIndex = from;
  const wide = URL_AUTHORITY.exec(text)[0];
  SR08_AUTHORITY.lastIndex = from;
  const full = SR08_AUTHORITY.exec(text)[0];
  if (full.lastIndexOf("@") >= wide.length) {
    const host = hostOf(m[1], full);
    if (host || unreadHost(m[1], full)) return { host, authority: full, full };
  }
  const host = (wide !== m[2] ? hostOf(m[1], wide) : null) ?? hostOf(m[1], m[2]);
  if (host) return { host, authority: wide, full };
  const part = hostPart(full).host;
  if (part.startsWith("[") || /[\p{L}\p{N}]/u.test(part.normalize("NFKC")) || part.includes(UNREADABLE)) {
    const named = hostOf(m[1], full);
    if (named || (!hostPart(wide).host.includes(UNREADABLE) && unreadHost(m[1], full))) return { host: named, authority: full, full };
  }
  return { host: null, authority: wide, full };
}

const URL_AT_START = new RegExp(`^${URL_IN_CODE.source}`, "iu");

/** The URLs in code. `decoded` are the spans of the literals read again as they decode,
 *  `kept`, in order and apart, those of text a program also uses as written, and `joined` the
 *  ends of Python literals that the next one continues, where a host is no host of its own. */
function urlsIn(code, lineAt, decoded = [], kept = [], joined = new Set()) {
  const urls = [];
  let k = 0;
  let w = 0;
  for (const m of code.matchAll(URL_IN_CODE)) {
    const { host, authority, full } = hostAt(code, m);
    // Where an escape cuts the authority, or the text SR-08 gives the parser, inside a literal
    // read again as it decodes, the decoded literal names the host, and the text before the
    // escape is no host of its own: unless the text is also used as written.
    const from = m.index + m[1].length + 3;
    const end = from + authority.length;
    while (k < decoded.length && decoded[k][1] < end) k += 1;
    while (w < kept.length && kept[w][1] <= m.index) w += 1;
    const asWritten = w < kept.length && kept[w][0] <= m.index;
    const cut = code[end] === "\\" || code[from + full.length] === "\\";
    if (cut && k < decoded.length && decoded[k][0] <= m.index && !asWritten) continue;
    if (joined.has(end)) continue;
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
// Where `process` may begin: not inside a longer name, but at an escape that begins one.
const JS_LEAD = String.raw`(?:\b|(?<![\w\\])(?=\\u))`;
const JS_ENV = String.raw`${JS_LEAD}(${JS_PROCESS})(?:\s*\))*\s*(?:(?:\?\.|\.)\s*(${JS_NAME})|(?:\?\.\s*)?\[\s*(?:${JS_KEY})\s*\])(?:\s*\))*`;
const JS_ENV_READS = [
  new RegExp(String.raw`${JS_ENV}\s*(?:\?\.|\.)\s*(${JS_NAME})`, "gud"),
  new RegExp(String.raw`${JS_ENV}\s*(?:\?\.\s*)?\[\s*(?:${JS_KEY})\s*\]`, "gud"),
];
// The groups of each pattern that hold a literal: the bracketed env part, and a bracketed key.
const JS_ENV_LITERALS = [[3, 4, 5], [3, 4, 5, 6, 7, 8]];
// The closing `}` of a destructuring pattern taken from the environment, which may sit in
// parentheses; its `{` is the brace that pairs with it.
const JS_ENV_FROM = String.raw`=\s*(?:\(\s*)*${JS_ENV}`;
const JS_ENV_DESTRUCTURING = new RegExp(String.raw`\}\s*${JS_ENV_FROM}`, "gud");
// TypeScript may annotate the pattern, as in `const { X }: Env = process.env`: a type written
// without braces, parentheses, `=` or `;`.
const TS_ENV_DESTRUCTURING = new RegExp(String.raw`\}\s*(?::[^=;{}()]*)?${JS_ENV_FROM}`, "gud");

// A comment may sit between a read's parts (SR-09) where no reading blanked it: in the text a
// literal only contains, or in a program read with nothing blanked. Each read is walked from
// its `process`, and each destructuring from its `}`, and the space and comments between its
// parts are blanked, those and no others, so that text elsewhere that only looks like a
// comment hides nothing.
const JS_PROCESS_AT = new RegExp(String.raw`${JS_LEAD}(${JS_PROCESS})`, "gu");
const JS_PROCESS_HERE = new RegExp(JS_PROCESS, "uy");
const JS_NAME_HERE = new RegExp(JS_NAME, "uy");
const JS_KEY_HERE = new RegExp(JS_KEY, "uy");
const JS_SPACE = /\s/;

/** For each index of code, where the space and comments that begin there end, within the
 *  part of the code that holds it (`span`, as brackets() gives it, with `opaque` its spans): a
 *  comment-like text in one literal does not close in another. One pass from the end, so that
 *  each read's walk costs no more than its own parts. */
function spaceEnds(code, span, opaque) {
  const n = code.length;
  const ends = new Int32Array(n + 1);
  const closes = new Int32Array(n + 2).fill(-1); // the first `*/` at or after each index
  ends[n] = n;
  let lineEnd = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    const c = code[i];
    closes[i] = c === "*" && code[i + 1] === "/" ? i : closes[i + 1];
    if (endsLine(c)) lineEnd = i;
    const close = closes[i + 2];
    if (JS_SPACE.test(c)) ends[i] = span[i + 1] === span[i] ? ends[i + 1] : i + 1;
    else if (c === "/" && code[i + 1] === "*") ends[i] = close !== -1 && span[close] === span[i] && span[close + 1] === span[i] ? ends[close + 2] : i;
    else if (c === "/" && code[i + 1] === "/") ends[i] = span[i] ? Math.min(lineEnd, opaque[span[i] - 1][1]) : lineEnd;
    else ends[i] = i;
  }
  return ends;
}

/** The code with the space and comments inside each environment read blanked; the code
 *  itself when there are none. `opaque` are the spans of its literals and regular
 *  expressions, or empty when they are not known. */
function readsUncommented(code, opaque) {
  if (!code.includes("/*") && !code.includes("//")) return code;
  const span = new Int32Array(code.length + 1);
  opaque.forEach(([start, end], k) => span.fill(k + 1, start, end));
  const ends = spaceEnds(code, span, opaque);
  const n = code.length;
  const spans = [];
  let found = [];
  const sep = (i) => { if (ends[i] > i) found.push([i, ends[i]]); return ends[i]; };
  // Where a run of space, comments and one bracket that begins at i ends. Each index joins a
  // run once, so walks that share a run cost no more than the run.
  const runs = { "(": new Int32Array(n + 2).fill(-1), ")": new Int32Array(n + 2).fill(-1) };
  const run = (c, i) => {
    const memo = runs[c];
    const path = [];
    let k = i;
    let end;
    for (;;) {
      if (memo[k] !== -1) { end = memo[k]; break; }
      path.push(k);
      const e = ends[k];
      if (code[e] !== c) { end = e; break; }
      k = e + 1;
    }
    for (const at of path) memo[at] = end;
    if (end > i) found.push([i, end]);
    return end;
  };
  const sticky = (pattern, i) => { pattern.lastIndex = i; const m = pattern.exec(code); return m ? i + m[0].length : -1; };
  // A member: `.name`, `?.name`, `[key]` or `?.[key]`. Where it ends, or -1.
  const member = (i) => {
    let k = i;
    if (code.startsWith("?.", k)) { k = sep(k + 2); if (code[k] !== "[") return sticky(JS_NAME_HERE, k); }
    else if (code[k] === ".") return sticky(JS_NAME_HERE, sep(k + 1));
    if (code[k] !== "[") return -1;
    k = sticky(JS_KEY_HERE, sep(k + 1));
    if (k === -1) return -1;
    k = sep(k);
    return code[k] === "]" ? k + 1 : -1;
  };
  JS_PROCESS_AT.lastIndex = 0;
  for (let m = JS_PROCESS_AT.exec(code); m; m = JS_PROCESS_AT.exec(code)) {
    JS_PROCESS_AT.lastIndex = m.index + (code.codePointAt(m.index) > 0xffff ? 2 : 1);
    if (jsValue(m[1]) !== "process") continue;
    found = [];
    const env = member(run(")", m.index + m[0].length));
    if (env === -1) continue;
    let kept = found.length;
    if (member(run(")", env)) !== -1) kept = found.length;
    append(spans, found.slice(0, kept));
  }
  for (let i = code.indexOf("}"); i !== -1; i = code.indexOf("}", i + 1)) {
    found = [];
    const k = sep(i + 1);
    if (code[k] !== "=" || code[k + 1] === "=" || code[k + 1] === ">") continue;
    const at = run("(", k + 1);
    JS_PROCESS_HERE.lastIndex = at;
    const name = JS_PROCESS_HERE.exec(code);
    if (name && jsValue(name[0]) === "process") append(spans, found);
  }
  if (!spans.length) return code;
  // A run's brackets are blanked with its comments: the read patterns take space for them.
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    if (end <= at) continue;
    const from = Math.max(at, start);
    out += code.slice(at, from) + blank(code.slice(from, end));
    at = end;
  }
  out += code.slice(at);
  return out === code ? code : out;
}

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

// A character that continues a JavaScript name, or an escape of one, ending just before:
// `$process`, `éprocess` and `\u{61}process` are other names.
const JS_NAME_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
const JS_ESCAPE_BEFORE = /(?<=\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\}))/y;

/** Whether a match's `process` (group 1) is a name of its own: in code, no identifier
 *  character may come just before it. In a literal, or where the literals are not known, any
 *  may, since text a string only contains counts as a read (SR-09). */
function ownName(code, literals) {
  if (!literals) return () => true;
  const starts = literals.map(([start]) => start);
  const inLiteral = (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; }
    return starts.length > 0 && starts[lo] <= at && at < literals[lo][1];
  };
  return (m) => {
    const at = m.indices[1][0];
    if (at === 0 || inLiteral(at)) return true;
    const before = code.codePointAt(at - (at > 1 && /[\udc00-\udfff]/.test(code[at - 1]) ? 2 : 1));
    JS_ESCAPE_BEFORE.lastIndex = at;
    return !JS_NAME_PART.test(String.fromCodePoint(before)) && !JS_ESCAPE_BEFORE.test(code);
  };
}

const CLOSES = { "}": "{", "]": "[", ")": "(" };

/** The program's brackets, each paired with others of its kind in its own part of the code:
 *  outside the `opaque` spans (its literals and regular expressions), or inside one of them,
 *  where a string or template may only contain a pattern. `open` maps each `}` to the `{` it
 *  closes, `close` each `{`, `[` and `(` to what closes it, and `span` gives, for each index,
 *  the opaque span that holds it: 0 for none, else its place in `opaque` plus one. */
function brackets(code, opaque) {
  const span = new Int32Array(code.length);
  opaque.forEach(([start, end], k) => span.fill(k + 1, start, end));
  const stacks = () => ({ "{": [], "[": [], "(": [] });
  const outside = stacks();
  let inside = outside;
  let current = 0;
  const open = new Map();
  const close = new Map();
  for (let i = 0; i < code.length; i += 1) {
    if (span[i] !== current) { current = span[i]; inside = current ? stacks() : outside; }
    const c = code[i];
    if (c === "{" || c === "[" || c === "(") inside[c].push(i);
    else if (CLOSES[c] && inside[CLOSES[c]].length) {
      const at = inside[CLOSES[c]].pop();
      close.set(at, i);
      if (c === "}") open.set(i, at);
    }
  }
  return { open, close, span };
}

// Python's string forms, as a read names them: an optional prefix, then one string, in one
// quote or three.
const PY_KEY = String.raw`((?:[rR][fF]?|[fF][rR]?|[uU])?)(?:"""((?:[^\\]|\\[\s\S])*?)"""|'''((?:[^\\]|\\[\s\S])*?)'''|"((?:[^"\\\n]|\\(?:\r\n|[\s\S]))+)"|'((?:[^'\\\n]|\\(?:\r\n|[\s\S]))+)')`;
// Space, or a backslash that continues the line, may sit around each `.`, `[` and `(`.
const PY_SP = String.raw`(?:\s|\\(?=[\r\n]))*`;
// `os.environ[KEY]`, `os.environ.get(KEY` and `os.getenv(KEY`. Python compares names after NFKC, so
// each name is matched as any name and compared so; `os` is two characters, so each place it may
// begin costs a few.
const PY_ENV_READ = new RegExp(String.raw`([\p{XID_Start}_][\p{XID_Continue}])(?![\p{XID_Continue}])${PY_SP}\.${PY_SP}([\p{XID_Start}_]\p{XID_Continue}*)(?:${PY_SP}\.${PY_SP}([\p{XID_Start}_]\p{XID_Continue}*))?${PY_SP}([[(])${PY_SP}${PY_KEY}(${PY_SP}\])?`, "gu");

const PY_NAME_END = /\p{XID_Continue}$/u;

/** Whether a PY_ENV_READ match is one of the three reads, its names compared after NFKC. */
function pythonRead(m) {
  const [os, first, second] = [m[1], m[2], m[3]].map((x) => x?.normalize("NFKC"));
  if (os !== "os") return false;
  if (m[4] === "[") return first === "environ" && second === undefined && m[10] !== undefined;
  return (first === "getenv" && second === undefined) || (first === "environ" && second === "get");
}

const JS_KEY_BODY = (q) => String.raw`(?:[^${q}\\]|\\(?:\r\n|[\s\S]))+`;
// Space or comments, which a key may sit among where no reading blanked them. It is matched
// only on one item's text, so a comment's search for its end stays inside the item.
const KEY_SP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*)*`;
const DESTRUCTURED_KEY = new RegExp(String.raw`^${KEY_SP}(?:"(?<dq>${JS_KEY_BODY('"')})"|'(?<sq>${JS_KEY_BODY("'")})'|\[${KEY_SP}(?:"(?<cdq>${JS_KEY_BODY('"')})"|'(?<csq>${JS_KEY_BODY("'")})'|${"`"}(?<ctpl>(?:[^${"`"}\\$]|\\(?:\r\n|[\s\S])|\$(?!\{))+)${"`"})${KEY_SP}\](?=${KEY_SP}:)|(?<plain>${JS_NAME}))`, "du");

/** The names a destructuring pattern takes from the environment: its keys, quoted, plain or
 *  computed from one literal, in the braces that pair in the same part of the code, outside
 *  the program's literals and regular expressions or inside one. A rest element, or a key
 *  computed from anything else, takes no one name and is not counted. With no literals known,
 *  in a program read with nothing blanked, a string's brackets pair as code do, and so do the
 *  brackets of quotes a literal holds, so there, and for a pattern a literal holds, each name
 *  or literal after a `{` or a `,` from the nearest `{` before a pattern's `}` counts too. */
function destructured(code, lineAt, literals, regexes, named = () => true, typescript = false) {
  const found = [];
  const keyed = literalKeys(literals && [...literals, ...(regexes ?? [])].sort((a, b) => a[0] - b[0]));
  const keep = (m, groups) => keyed(m, groups) && named(m) && fromEnv(code, m);
  const opaque = [...(literals ?? []), ...(regexes ?? [])];
  let b = null;
  let nearest = null;
  const spans = [];
  for (const m of envMatches(code, typescript ? TS_ENV_DESTRUCTURING : JS_ENV_DESTRUCTURING, 1, (x) => keep(x, [3, 4, 5]))) {
    b ??= brackets(code, opaque);
    const open = b.open.get(m.index);
    if (open !== undefined) append(found, items(code, lineAt, b, opaque, open, m.index));
    // Text a literal only contains may hold its own quotes, whose brackets pair as text does.
    if (literals !== null && !b.span[m.index]) continue;
    if (!nearest) {
      // For each index, the last `{` before it, or -1.
      nearest = new Int32Array(code.length + 1);
      for (let i = 0, last = -1; i <= code.length; i += 1) { nearest[i] = last; if (code[i] === "{") last = i; }
    }
    const from = Math.min(open ?? m.index, nearest[m.index]);
    if (from !== -1) spans.push([from, m.index]);
  }
  if (spans.length) append(found, unsureItems(code, lineAt, spans));
  return found;
}

// What, after process.env, makes the source something else: a member, a call, a template or
// `&&`. A condition on it may yield process.env itself, so its pattern still counts.
const JS_ENV_GOES_ON = /\s*(?:\?\.(?!\d)|\.|\[|\(|`|&&)/y;

/** Whether a destructuring match takes its pattern from process.env itself: where the `)`
 *  after it close more than the `(` before it, the source ended there; otherwise nothing that
 *  makes it another value may follow. Counted, not matched, so that a long run of `)` costs
 *  linear time. */
function fromEnv(code, m) {
  const count = (from, to, c) => { let k = 0; for (let i = from; i < to; i += 1) if (code[i] === c) k += 1; return k; };
  const end = m.index + m[0].length;
  if (count(m.indices[1][0], end, ")") > count(m.index, m.indices[1][0], "(")) return true;
  JS_ENV_GOES_ON.lastIndex = end;
  return !JS_ENV_GOES_ON.test(code);
}

/** Each key after a `{` or `,` inside the spans, read up to the next `,`, `:`, `=`, `}`, `{`
 *  or `(`: one pass, however the spans nest or overlap. */
function unsureItems(code, lineAt, spans) {
  const found = [];
  const covered = new Int32Array(code.length + 1);
  for (const [start, end] of spans) { covered[start] += 1; covered[end + 1] -= 1; }
  const stops = new Int32Array(code.length + 1);
  stops[code.length] = code.length;
  // A key holds none of these, so an item's text is cut at the first, and the items' texts
  // never overlap.
  for (let i = code.length - 1; i >= 0; i -= 1) stops[i] = ",:=}{(".includes(code[i]) ? i : stops[i + 1];
  for (let i = 0, depth = 0; i < code.length; i += 1) {
    depth += covered[i];
    if (!depth || (code[i] !== "{" && code[i] !== ",")) continue;
    const stop = stops[i + 1];
    const item = DESTRUCTURED_KEY.exec(code.slice(i + 1, code[stop] === ":" || code[stop] === "=" ? stop + 1 : stop));
    if (item) found.push(...keyOf(item, i + 1, lineAt));
  }
  return found;
}

/** The name an item's key gives, as a found read: none, one, or one named as written. */
function keyOf(item, from, lineAt) {
  const group = ["dq", "sq", "cdq", "csq", "ctpl", "plain"].find((g) => item.groups[g] !== undefined);
  const raw = item.groups[group];
  // A template's line ends read as \n, as JavaScript reads them.
  const name = jsValue(group === "ctpl" ? raw.replace(/\r\n?/g, "\n") : raw);
  const at = from + item.indices.groups[group][0];
  // A name this review cannot decode is named as written (SR-09).
  if (name === null) return [{ name: raw, undecodable: true, line: lineAt(at), at }];
  return name ? [{ name, line: lineAt(at), at }] : [];
}

/** The keys of a destructuring pattern from its `{` to its `}`, split at its own commas. A
 *  nested bracket, and a literal or regular expression in code, is passed over whole, so each
 *  part of the program is walked by the one pattern it lies in. An item's key ends at its
 *  first `:` or `=`. */
function items(code, lineAt, b, opaque, open, close) {
  const found = [];
  const own = b.span[close];
  let from = open + 1;
  let key = -1;
  let nested = -1;
  for (let i = open + 1; i <= close; i += 1) {
    if (b.span[i] !== own) {
      if (nested === -1) nested = i;
      i = opaque[b.span[i] - 1][1] - 1;
      continue;
    }
    const c = code[i];
    if (i < close && c !== ",") {
      const end = b.close.get(i);
      if (key === -1 && (c === ":" || c === "=")) key = i;
      else if (end !== undefined && end < close) {
        if (nested === -1) nested = i;
        i = end;
      }
      continue;
    }
    const item = DESTRUCTURED_KEY.exec(code.slice(from, key !== -1 ? key + 1 : nested !== -1 ? nested : i));
    if (item) found.push(...keyOf(item, from, lineAt));
    from = i + 1;
    key = -1;
    nested = -1;
  }
  return found;
}

/** The environment reads in a program's code (SR-09). `literals` and `regexes`, for
 *  JavaScript, are the spans of its literals and regular expressions in this reading, or null
 *  when none are known; `typescript`, whether it is TypeScript. */
function envIn(code, language, lineAt, literals = null, regexes = null, typescript = false) {
  const env = [];
  const push = (name, raw, undecodable, at) => env.push(undecodable
    ? { name: raw, undecodable: true, line: lineAt(at), at }
    : { name, line: lineAt(at), at });
  if (language === "python") {
    // In code, `os` right after a name's character is part of another name, as in `cléos`; in
    // a string it is still text of a read (SR-09). `literals` are the strings' spans.
    const strings = merged(literals ?? []);
    let s = 0;
    const inString = (at) => {
      while (s < strings.length && strings[s][1] <= at) s += 1;
      return s < strings.length && strings[s][0] <= at;
    };
    PY_ENV_READ.lastIndex = 0;
    for (let m = PY_ENV_READ.exec(code); m; m = PY_ENV_READ.exec(code)) {
      // A read inside this one's key, in an f-string's field or in its text, is read too. The
      // search steps a whole code point, as envMatches does.
      PY_ENV_READ.lastIndex = m.index + (code.codePointAt(m.index) > 0xffff ? 2 : 1);
      if (!pythonRead(m)) continue;
      if (PY_NAME_END.test(code.slice(Math.max(0, m.index - 2), m.index)) && !inString(m.index)) continue;
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
  // A key a regular expression holds is text of a read too, as one a string holds is.
  const opaque = literals ? [...literals, ...(regexes ?? [])].sort((a, b) => a[0] - b[0]) : null;
  const keyed = literalKeys(opaque);
  const named = ownName(code, opaque);
  const keep = (m, groups) => keyed(m, groups) && named(m);
  const uncommented = readsUncommented(code, opaque ?? []);
  for (const view of uncommented === code ? [code] : [code, uncommented]) {
    JS_ENV_READS.forEach((pattern, k) => {
      for (const m of envMatches(view, pattern, 1, (x) => keep(x, JS_ENV_LITERALS[k]))) {
        const raw = m[6] ?? m[7] ?? m[8];
        // A template's line ends read as \n, as JavaScript reads them.
        const name = jsValue(m[8] === undefined ? raw : raw.replace(/\r\n?/g, "\n"));
        // A name this review cannot decode, with a malformed escape, is named as written (SR-09).
        if (name === null || name) push(name, raw, name === null, m.index);
      }
    });
    append(env, destructured(view, lineAt, literals, regexes, named, typescript));
  }
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
  // The callee may sit in parentheses, as `(os.system)("ls")` does.
  const t = tokens.filter((x) => x.type !== "comment");
  const name = (k, s) => t[k]?.type === "name" && t[k].text.normalize("NFKC") === s;
  for (let k = 0; k < t.length; k += 1) {
    if (name(k, "os") && t[k + 1]?.type === "op" && t[k + 1].text === "." && name(k + 2, "system") && pythonCall(t, k, k + 2) !== -1) {
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
  // module.require too. `require` is read as it decodes, a seven-character name as
  // JS_PROCESS reads one: `\u0072equire` is the same name.
  { pattern: new RegExp(String.raw`(?<![\p{L}\p{N}_$\\])(${JS_PROCESS})\s*(?:\?\.\s*)?\(\s*(?=["'${"`"}])`, "gu"), esm: false, call: true, name: "require" },
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
  for (const { pattern, esm, call, name } of JS_IMPORTS) {
    for (const m of hollowed.matchAll(pattern)) {
      if (name && jsValue(m[1]) !== name) continue;
      const at = m.index + m[0].length;
      const literal = JS_STRINGS[code[at]];
      literal.lastIndex = at;
      const found = literal.exec(code);
      if (!found) continue;
      CALL_ENDS.lastIndex = at + found[0].length;
      if (call && !CALL_ENDS.test(hollowed)) continue;
      const value = jsValue(found[1]);
      // The host SR-08 reads from a URL specifier, so SR-22 knows when SR-08 refuses it: after
      // the spaces and controls the parser drops before it, which SR-08 finds the URL after.
      const trimmed = value === null ? null : value.replace(/^[\0- ]+/, "");
      const url = trimmed === null ? null : URL_AT_START.exec(trimmed);
      const host = url ? hostAt(trimmed, url).host : null;
      imports.push({ specifier: found[1], value, ...(value === null ? { undecodable: true } : {}), ...(host ? { host } : {}), esm, line: lineAt(at), at });
    }
  }
  return imports;
}

// Python's imports, read from its tokens (SR-22). A statement starts the file, a logical line,
// or follows `;` or `:`. Keywords are ASCII, as Python reads them; names are compared after
// NFKC, as Python compares them.
// A \N{…} name holds no backslash, so an unclosed `\N{` is read no further than the next
// escape: read to the text's end, many of them took time quadratic in it.
const PY_ESCAPE = /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([0-7]{1,3})|(\r\n|\r|\n)|N\{([^}\\]*)\}|([\\'"abfnrtv]))/g;
// The names of printable ASCII, U+0020 to U+007E in order, as Python's \N{…} reads them in any
// case: all that a URL's scheme, a host or an environment name needs.
const PY_ASCII_NAMES = new Map("SPACE|EXCLAMATION MARK|QUOTATION MARK|NUMBER SIGN|DOLLAR SIGN|PERCENT SIGN|AMPERSAND|APOSTROPHE|LEFT PARENTHESIS|RIGHT PARENTHESIS|ASTERISK|PLUS SIGN|COMMA|HYPHEN-MINUS|FULL STOP|SOLIDUS|DIGIT ZERO|DIGIT ONE|DIGIT TWO|DIGIT THREE|DIGIT FOUR|DIGIT FIVE|DIGIT SIX|DIGIT SEVEN|DIGIT EIGHT|DIGIT NINE|COLON|SEMICOLON|LESS-THAN SIGN|EQUALS SIGN|GREATER-THAN SIGN|QUESTION MARK|COMMERCIAL AT|LATIN CAPITAL LETTER A|LATIN CAPITAL LETTER B|LATIN CAPITAL LETTER C|LATIN CAPITAL LETTER D|LATIN CAPITAL LETTER E|LATIN CAPITAL LETTER F|LATIN CAPITAL LETTER G|LATIN CAPITAL LETTER H|LATIN CAPITAL LETTER I|LATIN CAPITAL LETTER J|LATIN CAPITAL LETTER K|LATIN CAPITAL LETTER L|LATIN CAPITAL LETTER M|LATIN CAPITAL LETTER N|LATIN CAPITAL LETTER O|LATIN CAPITAL LETTER P|LATIN CAPITAL LETTER Q|LATIN CAPITAL LETTER R|LATIN CAPITAL LETTER S|LATIN CAPITAL LETTER T|LATIN CAPITAL LETTER U|LATIN CAPITAL LETTER V|LATIN CAPITAL LETTER W|LATIN CAPITAL LETTER X|LATIN CAPITAL LETTER Y|LATIN CAPITAL LETTER Z|LEFT SQUARE BRACKET|REVERSE SOLIDUS|RIGHT SQUARE BRACKET|CIRCUMFLEX ACCENT|LOW LINE|GRAVE ACCENT|LATIN SMALL LETTER A|LATIN SMALL LETTER B|LATIN SMALL LETTER C|LATIN SMALL LETTER D|LATIN SMALL LETTER E|LATIN SMALL LETTER F|LATIN SMALL LETTER G|LATIN SMALL LETTER H|LATIN SMALL LETTER I|LATIN SMALL LETTER J|LATIN SMALL LETTER K|LATIN SMALL LETTER L|LATIN SMALL LETTER M|LATIN SMALL LETTER N|LATIN SMALL LETTER O|LATIN SMALL LETTER P|LATIN SMALL LETTER Q|LATIN SMALL LETTER R|LATIN SMALL LETTER S|LATIN SMALL LETTER T|LATIN SMALL LETTER U|LATIN SMALL LETTER V|LATIN SMALL LETTER W|LATIN SMALL LETTER X|LATIN SMALL LETTER Y|LATIN SMALL LETTER Z|LEFT CURLY BRACKET|VERTICAL LINE|RIGHT CURLY BRACKET|TILDE".split("|").map((name, k) => [name, String.fromCharCode(32 + k)]));
// The one alias Python reads for printable ASCII, from Unicode's NameAliases.
PY_ASCII_NAMES.set("SP", " ");
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
    if (named !== undefined) return PY_ASCII_NAMES.get(asciiUpper(named)) ?? PY_NAMES.get(asciiUpper(named)) ?? UNREADABLE;
    return continued ? "" : PY_SINGLE_ESCAPES[single];
  });
}

const pythonBytes = (body) => pythonDecode(body, true);

// CPython reads a \N{…} name's ASCII letters in any case, and no other letter: `ſ` is no `S`.
const asciiUpper = (name) => name.replace(/[a-z]+/g, (w) => w.toUpperCase());

/** Whether a Python string body has an escape this review cannot decode: a \N{…} naming
 *  anything but printable ASCII or a character PY_NAMES names, or a \U above U+10FFFF. */
function pythonUndecodable(body) {
  for (const m of body.matchAll(PY_ESCAPE)) {
    if (m[6] !== undefined && !PY_ASCII_NAMES.has(asciiUpper(m[6])) && !PY_NAMES.has(asciiUpper(m[6]))) return true;
    if (m[3] && parseInt(m[3], 16) > 0x10ffff) return true;
  }
  return false;
}

/** Whether an f-string body has a replacement field. A backslash does not escape a brace, but
 *  a non-raw named escape's braces are no field: it runs to the next `}`, unless a `{` comes
 *  first. */
const pythonHasField = (body, raw) =>
  /\{/.test((raw ? body : body.replace(/\\(?:N\{[^{}]*\}|[^{}])/g, "")).replace(/\{\{|\}\}/g, ""));
const PY_SINGLE_ESCAPES = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
// A PEP 263 declaration, on the first line or the second.
const PY_CODING = /^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)/;

/** The value of adjacent string tokens, as Python joins them. Undefined when it is computed
 *  (an f-string with a field) or not a str (bytes, or a t-string's Template); null when it
 *  names a character by \N{…}, which this review cannot decode. */
function pythonValue(text, parts) {
  let value = "";
  for (const t of parts) {
    // Bytes, and a t-string, which makes a Template: neither names a module.
    if (/[bBtT]/.test(t.prefix)) return undefined;
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
  const t = tokens.filter((x) => x.type !== "comment");
  // Whether only space comes before an offset on its physical line, and no backslash continues
  // the line before into it.
  const beginsLine = (at) => {
    let i = at - 1;
    while (i >= 0 && (text[i] === " " || text[i] === "\t" || text[i] === "\f")) i -= 1;
    if (i < 0) return true;
    if (text[i] !== "\n" && text[i] !== "\r") return false;
    return text[text[i] === "\n" && text[i - 1] === "\r" ? i - 2 : i - 1] !== "\\";
  };
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
    // A statement starts the file, a logical line, or follows `;` or `:`. `import` and `from`
    // are keywords no expression holds, so one that begins a physical line starts a statement
    // too, though an unclosed bracket or field before it would make it part of a longer line:
    // CPython rejects such a program, and SR-22 still reads it.
    const prev = t[k - 1];
    const statement = !t[k].field && (!prev || prev.type === "newline" || op(k - 1, ";") || op(k - 1, ":"));
    if (!statement && !((word(k, "import") || word(k, "from")) && beginsLine(t[k].start))) continue;
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
  const partner = pythonPartners(all);
  for (let k = 0; k < all.length; k += 1) {
    if (!is(k, "name", "import_module")) continue;
    let next = k + 1;
    while (is(next, "op", ")")) next += 1;
    if (!is(next, "op", "(")) continue;
    let first = k;
    while (is(first - 1, "op", ".") && is(first - 2, "name")) first -= 2;
    const call = pythonCall(all, first, k);
    if (call === -1) continue;
    // The call's arguments, split at its own commas, each a range of tokens; the module is the
    // first positional one, or the one named `name`, wherever it stands.
    const args = [[call + 1, call + 1]];
    for (let j = call + 1; j < all.length; j += 1) {
      const x = all[j];
      if (x.type === "op" && ")]}".includes(x.text)) break;
      if (x.type === "op" && x.text === ",") { args.push([j + 1, j + 1]); continue; }
      if (x.type === "op" && "([{".includes(x.text)) j = partner[j];
      args.at(-1)[1] = Math.min(j, all.length - 1) + 1;
    }
    const keyword = ([from, to]) => to - from > 1 && all[from].type === "name" && is(from + 1, "op", "=");
    const named = args.find((a) => keyword(a) && all[a[0]].text.normalize("NFKC") === "name");
    let [from, to] = named ? [named[0] + 2, named[1]] : keyword(args[0]) ? [0, 0] : args[0];
    while (to - from > 2 && is(from, "op", "(") && partner[from] === to - 1) { from += 1; to -= 1; }
    let strings = from < to;
    for (let j = from; strings && j < to; j += 1) strings = all[j].type === "string";
    if (!strings) continue;
    const parts = all.slice(from, to);
    const value = pythonValue(text, parts);
    if (value === undefined) continue;
    const at = parts[0].start;
    // The literal as written: adjacent parts with what stands between them, and nothing added.
    const written = text.slice(parts[0].start, parts.at(-1).end);
    imports.push({ specifier: value ?? written, names: [], ...(value === null ? { undecodable: true } : {}), line: lineAt(at), at });
  }
  return imports;
}

/** For each opening bracket among Python tokens, the index of the one that closes it, or the
 *  end; found once, so that a walk can jump over a nested group. */
function pythonPartners(all) {
  const partner = new Int32Array(all.length).fill(all.length);
  const open = [];
  for (let k = 0; k < all.length; k += 1) {
    if (all[k].type !== "op") continue;
    if ("([{".includes(all[k].text)) open.push(k);
    else if (")]}".includes(all[k].text) && open.length) partner[open.pop()] = k;
  }
  return partner;
}

/** Whether the logical line on which token k stands ends with a `:`, as a match statement's does. */
function endsWithColon(all, k) {
  while (k + 1 < all.length && all[k + 1].type !== "newline") k += 1;
  return all[k]?.type === "op" && all[k].text === ":";
}

// Keywords before which a `(` opens a group, not a call or a subscript.
const PY_KEYWORDS = new Set(["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
  "pass", "raise", "return", "try", "while", "with", "yield"]);

/** The index of the `(` that calls the dotted name from token `first` to `last`, or -1. The
 *  name may sit in parentheses, as in `(importlib.import_module)("tests")`: as many `)` may
 *  follow it as `(` open a group just before it. A `(` after a name, a value or a closing
 *  bracket calls or subscripts what stands before it instead. */
function pythonCall(all, first, last) {
  let call = last + 1;
  while (all[call]?.type === "op" && all[call].text === ")") call += 1;
  if (all[call]?.type !== "op" || all[call].text !== "(") return -1;
  let opens = 0;
  for (let j = first - 1; all[j]?.type === "op" && all[j].text === "("; j -= 1) {
    // A field's code starts after its `{`, which is no token: what stands before it is no
    // operand. Nor is `match` or `case` where it begins a statement, as a soft keyword.
    const before = all[j - 1];
    const soft = before?.type === "name" && before.site === -1 && before.text.normalize("NFKC") === "match"
      && (j < 2 || all[j - 2].type === "newline") && endsWithColon(all, j);
    const ends = !soft && before?.site === all[j].site && (before.type === "string" || (before.type === "name" && !PY_KEYWORDS.has(before.text.normalize("NFKC")))
      || (before.type === "op" && /^[)\]}\p{N}]$/u.test(before.text)));
    if (ends) break;
    opens += 1;
  }
  return call - last - 1 <= opens ? call : -1;
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

/** An authority's host, after any userinfo and before any port, without trailing dots, and
 *  where in the authority it starts. Read by hand, in one pass: a regular expression for it
 *  backtracked over a long run of dots. */
function hostPart(authority) {
  const start = authority.lastIndexOf("@") + 1;
  const rest = authority.slice(start);
  const close = rest.startsWith("[") ? rest.indexOf("]") : -1;
  if (close !== -1 && /^\.*(?::\d*)?$/.test(rest.slice(close + 1))) return { host: rest.slice(0, close + 1), start };
  let end = rest.length;
  let digits = end;
  while (digits > 0 && rest[digits - 1] >= "0" && rest[digits - 1] <= "9") digits -= 1;
  if (digits > 0 && rest[digits - 1] === ":") end = digits - 1;
  return { host: withoutTrailingDots(rest.slice(0, end)), start };
}

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
function literalUrls(text, spans, escapes, decode, lineAt, joined = new Set()) {
  const urls = [];
  for (const span of spans) {
    const { body, place, end } = bodyOf(text, span);
    if (!body.includes("\\")) continue;
    const writtenAt = placer(body, escapes, decode);
    let anywhere = null;
    const value = decode(body) ?? "";
    for (const m of value.matchAll(URL_IN_CODE)) {
      const found = hostAt(value, m);
      if (joined.has(end) && m.index + m[1].length + 3 + found.authority.length === value.length) continue;
      const at = place(writtenAt(m.index));
      let { host } = found;
      const part = hostPart(found.authority);
      if (part.host.includes(UNREADABLE)) {
        // A host with a character this review cannot decode, by a Python \N{…}, is named as
        // written, its ASCII letters in lowercase: it is a host all the same.
        anywhere ??= escapeMap(body, escapes, decode);
        const from = m.index + m[1].length + 3 + part.start;
        host = namedAsWritten(body.slice(anywhere(from), anywhere(from + part.host.length))) ?? host;
      }
      if (host) urls.push({ host, line: lineAt(at), at });
    }
  }
  return urls;
}

/** A host written with a \N{…} this review cannot decode, named as written, its ASCII letters
 *  in lowercase; or null where it holds none. */
const namedAsWritten = (written) => (/\\N\{/.test(written)
  ? written.replace(/\\N\{[^}]*\}|[A-Z]+/g, (w) => (w[0] === "\\" ? w : w.toLowerCase())) : null);

/** The environment reads a literal's text holds as it decodes (SR-09), as a URL counts as its
 *  literal decodes: each literal with a backslash is read again as its value, and each read is
 *  placed where it was written. */
function literalEnv(text, spans, escapes, decode, language, lineAt, typescript = false) {
  const env = [];
  for (const span of spans) {
    const { body, place } = bodyOf(text, span);
    if (!body.includes("\\")) continue;
    const value = decode(body);
    if (!value) continue;
    let where = null;
    // A decoded Python string is a string throughout.
    for (const e of envIn(value, language, () => 0, language === "python" ? [[0, value.length]] : null, null, typescript)) {
      where ??= escapeMap(body, escapes, decode);
      const at = place(where(e.at));
      env.push({ ...e, line: lineAt(at), at });
    }
  }
  return env;
}

/** The URLs and environment reads that Python strings make together, as Python joins them
 *  into one value (SR-08, SR-09). Adjacent strings are one literal; and an f-string's text
 *  before an `=` field is one string with that field's debug text, as each CPython version
 *  builds it. Each run of two or more strings, or of one with an `=` field, is read as one
 *  value: each piece decoded as its own prefix says, a field's value as `{}`, which ends a
 *  host as a computed part does, and before it any debug text, once as each version keeps it.
 *  Two strings are adjacent where nothing but space, comments, line continuations and, inside
 *  brackets, line ends stands between them, in the same code: a string that ends a field is
 *  not joined to one after the field. */
function adjacentReads(text, tokens, lineAt, joined) {
  const all = tokens.filter((t) => t.type !== "comment").sort((a, b) => a.start - b.start);
  // The token that follows one, past the fields inside it.
  const after = (t) => {
    let lo = 0;
    let hi = all.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid].start < t.end) lo = mid + 1; else hi = mid; }
    return all[lo];
  };
  const urls = [];
  const env = [];
  const continued = new Set();
  // Debug text nested in debug text is joined again within each field around it: past a
  // budget, a field's debug text is left out of the value, and read on its own only.
  let budget = 16 * text.length + 4000000;
  // Reads one value as a version builds it from `segments`: text pieces, [from, to] with
  // whether they are raw, and fields, {debug}, each a `{}` after any debug text.
  const read = (version, bytes, segments) => {
    // Each piece: its value, and where in the text each of its characters was written.
    const pieces = [];
    const add = (from, to, raw) => {
      const body = text.slice(from, to);
      const decode = raw ? (x) => x : bytes ? pythonBytes : pythonDecode;
      const where = raw || !body.includes("\\") ? (i) => i : escapeMap(body, PY_ESCAPE, decode);
      pieces.push({ value: decode(body), place: (i) => from + where(i) });
    };
    // A field's debug text: 3.12 cuts each `#` to its line's end and decodes the rest, in a
    // raw f-string keeps it, and has no t-strings; 3.13 and 3.14.6 keep what their scans
    // keep, as written.
    const addDebug = (d, raw) => {
      if (version === "3.12" && d.template) return;
      budget -= d.to - d.run;
      if (budget < 0) return;
      const group = version === "3.12" ? (cutAtHashes(text, [[d.from, d.to12]])[0] ?? [])
        : version === "3.13" ? keptPieces(text, d.from, d.to, true) : keptPieces(text, d.run, d.to146, false);
      if (!group.length) return;
      const { body, place } = bodyOf(text, { pieces: group });
      const decoding = version === "3.12" && !raw;
      const where = decoding && body.includes("\\") ? escapeMap(body, PY_ESCAPE, pythonDecode) : (i) => i;
      pieces.push({ value: decoding ? pythonDecode(body) : body, place: (i) => place(where(i)) });
    };
    for (const x of segments) {
      if (x.text) add(x.text[0], x.text[1], x.raw);
      else {
        if (x.debug && version) addDebug(x.debug, x.raw);
        pieces.push({ value: "{}", place: () => x.at });
      }
    }
    readJoined(text, pieces, lineAt, urls, env);
  };
  for (const t of all) {
    if (t.type !== "string") continue;
    const raw = /[rR]/.test(t.prefix);
    // A format spec's text and its fields are one string too.
    for (const parts of t.specRuns) {
      if (!parts.some((x) => x.debug)) continue;
      const segments = parts.map((x) => (Array.isArray(x) ? { text: x, raw } : { at: x.field, debug: x.debug, raw }));
      for (const x of parts) if (x.debug) joined.add(x.field);
      for (const version of ["3.12", "3.13", "3.14.6"]) read(version, false, segments);
    }
    if (continued.has(t)) continue;
    const bytes = /[bB]/.test(t.prefix);
    const run = [t];
    for (let u = after(t); u?.type === "string" && u.site === t.site && /[bB]/.test(u.prefix) === bytes; u = after(u)) {
      run.push(u);
      continued.add(u);
    }
    const debugged = run.some((u) => u.debugs.length);
    if (run.length < 2 && !debugged) continue;
    for (const u of run.slice(0, -1)) joined.add(u.body[1]);
    const segments = [];
    for (const u of run) {
      const raw = /[rR]/.test(u.prefix);
      const debugAt = new Map(u.debugs.map((x) => [x.from, x]));
      let at = u.body[0];
      for (const [start, end] of u.fields) {
        if (start > at) segments.push({ text: [at, start], raw });
        const debug = debugAt.get(start + 1);
        if (debug) joined.add(start);
        segments.push({ at: start, debug, raw });
        at = Math.max(at, end);
      }
      if (u.body[1] > at) segments.push({ text: [at, u.body[1]], raw });
    }
    for (const version of debugged ? ["3.12", "3.13", "3.14.6"] : [null]) read(version, bytes, segments);
  }
  return { urls, env };
}

/** The URLs and environment reads in the value pieces make together, each placed where it was
 *  written. */
function readJoined(text, pieces, lineAt, urls, env) {
  const value = pieces.map((x) => x.value).join("");
  const begins = [];
  let length = 0;
  for (const x of pieces) { begins.push(length); length += x.value.length; }
  // The piece the value's character at an index comes from, and where it was written.
  const pieceAt = (index) => {
    let k = 0;
    let hi = begins.length - 1;
    while (k < hi) { const mid = (k + hi + 1) >> 1; if (begins[mid] <= index) k = mid; else hi = mid - 1; }
    return k;
  };
  const writtenAt = (k, index) => pieces[k].place(index - begins[k]);
  for (const m of value.matchAll(URL_IN_CODE)) {
    const found = hostAt(value, m);
    let { host } = found;
    const part = hostPart(found.authority);
    if (part.host.includes(UNREADABLE)) {
      // As for one literal, a host this review cannot decode is named as written, each
      // piece's part of it as that piece was written.
      const from = m.index + m[1].length + 3 + part.start;
      const to = from + part.host.length;
      let written = "";
      for (let j = pieceAt(from); j < pieces.length && begins[j] < to; j += 1) {
        written += text.slice(writtenAt(j, Math.max(from, begins[j])), writtenAt(j, Math.min(to, begins[j] + pieces[j].value.length)));
      }
      host = namedAsWritten(written) ?? host;
    }
    if (!host) continue;
    const at = writtenAt(pieceAt(m.index), m.index);
    urls.push({ host, line: lineAt(at), at });
  }
  // The value is a string throughout.
  for (const e of envIn(value, "python", () => 0, [[0, value.length]])) {
    const at = writtenAt(pieceAt(e.at), e.at);
    env.push({ ...e, line: lineAt(at), at });
  }
}

/** Adds found items to a map, once each by key, keeping the first. */
const gather = (into, items, key) => { for (const x of items) if (!into.has(key(x))) into.set(key(x), x); };
const urlKey = (u) => `${u.line}\0${u.host}`;

/** How Node runs TypeScript: with its types replaced by space, so that every offset stays
 *  where it was ({ code }); where that cannot be done, as for an `enum`, transformed, with a
 *  map from each offset of the code to where in the text it came from ({ code, place }); or
 *  null where Node cannot read it at all. Any other failure of Node's stripper may leave it
 *  failing for every file after, so the review stops, and the package is refused unreadable.
 *  Node 26 removed the transform mode, so there a file that needs it cannot be read as Node 22
 *  to 25 run it; read as written, its types could hide code, so the package is refused
 *  unreadable, with that reason. */
function typeScriptRun(text) {
  const readable = (e) => e?.code === "ERR_INVALID_TYPESCRIPT_SYNTAX" || e?.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX";
  try {
    const code = stripTypeScriptTypes(text, { mode: "strip" });
    return code.length === text.length ? { code } : null;
  } catch (e) {
    if (!readable(e)) throw e;
    if (e.code === "ERR_INVALID_TYPESCRIPT_SYNTAX") return null;
  }
  let out;
  try {
    out = stripTypeScriptTypes(text, { mode: "transform", sourceMap: true });
  } catch (e) {
    if (e?.code === "ERR_INVALID_ARG_VALUE") {
      const gone = new Error("a TypeScript program needs Node to transform it, as for an enum, and this Node cannot: review it on Node 22.13 to 25");
      gone.code = "unreadable";
      throw gone;
    }
    if (!readable(e)) throw e;
    return null;
  }
  const m = /\n\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(out);
  if (!m) return null;
  const code = out.slice(0, m.index);
  const lines = sourceMap(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")).mappings);
  const starts = lineStarts(code);
  const textStarts = lineStarts(text);
  // The offset in the text that the code at an offset came from, by the map's segment at or
  // before it on its line, or the last on a line before.
  const place = (offset) => {
    let line = 0;
    let hi = starts.length - 1;
    while (line < hi) { const mid = (line + hi + 1) >> 1; if (starts[mid] <= offset) line = mid; else hi = mid - 1; }
    const column = offset - starts[line];
    for (let l = line; l >= 0; l -= 1) {
      const segments = lines[l] ?? [];
      let k = segments.length - 1;
      while (k >= 0 && l === line && segments[k][0] > column) k -= 1;
      if (k < 0) continue;
      const [generated, sourceLine, sourceColumn] = segments[k];
      const from = textStarts[Math.min(sourceLine, textStarts.length - 1)];
      const to = sourceLine + 1 < textStarts.length ? textStarts[sourceLine + 1] - 1 : text.length;
      return Math.min(from + sourceColumn + (l === line ? column - generated : 0), Math.max(from, to));
    }
    return 0;
  };
  return { code, place };
}

/** Where each line of a text begins. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

const VLQ = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A source map's mappings: for each line of the code, its segments, [column, source line,
 *  source column], in order. */
function sourceMap(mappings) {
  const lines = [];
  let sourceLine = 0;
  let sourceColumn = 0;
  for (const line of mappings.split(";")) {
    const segments = [];
    let column = 0;
    for (const segment of line ? line.split(",") : []) {
      const values = [];
      let value = 0;
      let shift = 0;
      for (const ch of segment) {
        const digit = VLQ.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) { shift += 5; continue; }
        values.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
      column += values[0] ?? 0;
      if (values.length >= 4) {
        sourceLine += values[2];
        sourceColumn += values[3];
        segments.push([column, sourceLine, sourceColumn]);
      }
    }
    lines.push(segments);
  }
  return lines;
}

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
    // Where CPython versions read a program differently, each reading is read on its own and
    // what any finds counts, as for JavaScript (SR-08). 3.12 and 3.13 have no t-strings: there
    // `t"…"` is a name and a string. Where 3.12 reads a format spec's `{{` as a field and 3.13
    // as a brace, 3.12's reading is one more, with no t-strings.
    const first = pythonTokens(text);
    const templates = first.some((t) => t.type === "string" && /[tT]/.test(t.prefix));
    const plain = templates ? pythonTokens(text, false, false) : first;
    const readings = templates ? [first, plain] : [first];
    if (plain.ambiguous) readings.push(pythonTokens(text, true, false));
    const found = new Map();
    const started = new Map();
    for (const tokens of readings) {
      const code = blankPythonComments(text, tokens);
      const strings = pythonLiterals(tokens, false);
      const bytes = pythonLiterals(tokens, true);
      // Where 3.13 keeps text as written that 3.12 decodes, the text as written names its host
      // too. Debug text is read with its field's own comments blanked: CPython leaves them out
      // of it. A literal the next one continues names the host they make together.
      const joined = new Set();
      const adjacent = adjacentReads(text, tokens, lineAt, joined);
      const literals = flat([...strings, ...bytes]);
      // Debug text, and a t-string's interpolations, as 3.13 and later keep them as written.
      const written = tokens.written.length ? only(text, tokens.written) : null;
      gather(urls, [
        ...urlsIn(code, lineAt, literals, pythonKept(tokens), joined),
        ...(written ? urlsIn(written, lineAt) : []),
        ...literalUrls(code, strings, PY_ESCAPE, pythonDecode, lineAt, joined),
        ...literalUrls(code, bytes, PY_ESCAPE, pythonBytes, lineAt, joined),
        ...adjacent.urls,
      ], urlKey);
      gather(env, [
        ...envIn(code, language, lineAt, flat([...pythonLiterals(tokens, false, true), ...pythonLiterals(tokens, true, true)])),
        ...adjacent.env,
        ...(written ? envIn(written, language, lineAt, tokens.written) : []),
        ...literalEnv(code, strings, PY_ESCAPE, pythonDecode, language, lineAt),
        ...literalEnv(code, bytes, PY_ESCAPE, pythonBytes, language, lineAt),
      ], (e) => `${e.at}\0${e.name}`);
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
    const typescript = /\.[cm]?ts$/i.test(path);
    // Every reading is read on its own and what any of them finds counts (SR-08), so no
    // reading's misreading hides code and no mix of two readings makes up code. TypeScript is
    // also read as Node runs it, its types stripped to space or, where Node cannot strip them,
    // transformed, and each finding placed back where it was written.
    const found = new Map();
    const run = typescript ? typeScriptRun(text) : null;
    // Transformed code's findings, placed back in the text; a read or an import counts once
    // on its line, beside what the text's own readings find there.
    const moved = { env: new Map(), imports: new Map() };
    if (run?.place) {
      const { code: js, place } = run;
      const back = (x) => ({ ...x, at: place(x.at), line: lineAt(place(x.at)) });
      const lineOf = (o) => lineAt(place(o));
      for (const r of javaScriptReadings(js, goal)) {
        const decoded = r.whole ? [] : r.literals.filter(([s, e]) => jsValue(js.slice(s, e)) !== null);
        gather(urls, [...urlsIn(r.code, lineOf, decoded, merged(r.tagged)), ...literalUrls(js, r.literals, JS_ESCAPE, r.whole ? jsLenient : jsValue, lineOf)].map(back), urlKey);
        gather(moved.env, [...envIn(r.code, language, lineOf, r.whole ? null : r.literals, r.whole ? null : r.regexes, typescript),
          ...literalEnv(js, r.literals, JS_ESCAPE, r.whole ? jsLenient : jsValue, language, lineOf, typescript)].map(back), (e) => `${e.line}\0${e.name}`);
        gather(moved.imports, jsImports(r.code, r.hollowed, lineOf).map(back), (i) => `${i.line}\0${i.specifier}\0${i.esm}`);
      }
    }
    // Where Node strips the types, its text is the code that runs, so it is what is read; the
    // text itself is read once more, as it reads by default, only for the imports a type-only
    // `import` names, which stripping removes.
    const stripped = run && !run.place ? run.code : null;
    if (stripped !== null && stripped !== text) {
      const own = readJavaScript(text, [], goal);
      gather(found, jsImports(own.code, own.hollowed, lineAt), (i) => `${i.at}\0${i.specifier}\0${i.esm}`);
    }
    for (const r of javaScriptReadings(stripped ?? text, goal)) {
      // A real literal with a malformed escape has no value, so it holds no URL as it decodes;
      // only in the reading with nothing blanked, where the whole text is one literal, is it
      // decoded leniently. A match cut by an escape names its host where the literal does not
      // decode, and in a tagged template, whose tag may take its text as written.
      const decoded = r.whole ? [] : r.literals.filter(([s, e]) => jsValue(text.slice(s, e)) !== null);
      gather(urls, [...urlsIn(r.code, lineAt, decoded, merged(r.tagged)), ...literalUrls(text, r.literals, JS_ESCAPE, r.whole ? jsLenient : jsValue, lineAt)], urlKey);
      gather(env, [
        ...envIn(r.code, language, lineAt, r.whole ? null : r.literals, r.whole ? null : r.regexes, typescript),
        ...literalEnv(text, r.literals, JS_ESCAPE, r.whole ? jsLenient : jsValue, language, lineAt, typescript),
      ], (e) => `${e.at}\0${e.name}`);
      // The same text read as an ES import by one reading and a require by another is two
      // imports: Node resolves the two differently.
      gather(found, jsImports(r.code, r.hollowed, lineAt), (i) => `${i.at}\0${i.specifier}\0${i.esm}`);
    }
    const has = (map, key) => new Set([...map.values()].map(key));
    const envLines = has(env, (e) => `${e.line}\0${e.name}`);
    for (const [k, e] of moved.env) if (!envLines.has(k)) env.set(`${e.at}\0${e.name}`, e);
    const importLines = has(found, (i) => `${i.line}\0${i.specifier}\0${i.esm}`);
    for (const [k, i] of moved.imports) if (!importLines.has(k)) found.set(`${i.at}\0${i.specifier}\0${i.esm}`, i);
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
