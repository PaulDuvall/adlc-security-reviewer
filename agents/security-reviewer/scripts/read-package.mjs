// Read the package: the descriptor, the runtime requirements and every shipped file, and
// the package digest that binds an answer to those bytes (docs/spec.md, Terms; SR-05, SR-19).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

const UNSHIPPED_SEGMENTS = new Set(["test", "tests", "node_modules", ".git"]);
const DESCRIPTOR = ["agent-descriptor.json", "descriptor.json"];
const REQUIREMENTS = ["agent-runtime-requirements.json", "install.json"];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Paths compared as bytes, the order the package digest is defined in. */
export const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** True when a POSIX relative path is a shipped file. */
export function ships(path) {
  const segments = path.split("/");
  if (segments.some((s) => UNSHIPPED_SEGMENTS.has(s))) return false;
  return !/\.test\./.test(segments[segments.length - 1]);
}

/** sha256: over one line per file, `path NUL hex-sha256 LF`, in byte-wise path order. */
export function packageDigest(files) {
  const lines = [...files]
    .sort((a, b) => byteOrder(a.path, b.path))
    .map((f) => `${f.path}\0${f.sha256}\n`)
    .join("");
  return `sha256:${sha256(lines)}`;
}

/** True when target, a real path, is root or lies under it. */
const within = (root, target) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

/** An error that refuses the package as unreadable, with a fixed reason (SR-05, SR-01). */
export function unreadable(why) {
  const e = new Error(why);
  e.code = "unreadable";
  return e;
}

/** Every shipped file under dir. Unshipped folders are not entered, so their files are never
 *  read. A symbolic link to a folder is not followed, so a loop cannot hold the walk. A link to
 *  a file outside the package makes the package unreadable: the review would read the
 *  reviewer's own file, and an install the installer's, so what it passed is not what runs. */
function shippedFiles(dir) {
  const out = [];
  const root = realpathSync(dir);
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (!UNSHIPPED_SEGMENTS.has(entry.name)) walk(full, path);
        continue;
      }
      const isFile = entry.isSymbolicLink() ? statSync(full).isFile() : entry.isFile();
      if (!isFile || !ships(path)) continue;
      // The path is not named: this comes before the credential search, which keeps a
      // credential out of every name an answer repeats (SR-13).
      if (entry.isSymbolicLink() && !within(root, realpathSync(full))) {
        throw unreadable("a shipped file is a link to a file outside the package");
      }
      const bytes = readFileSync(full);
      out.push({ path, bytes, sha256: sha256(bytes) });
    }
  };
  walk(dir, "");
  return out.sort((a, b) => byteOrder(a.path, b.path));
}

/** The first of the names present is the one read: the current name over the former. */
function readDeclaration(files, names, what) {
  const name = names.find((n) => files.some((f) => f.path === n));
  if (!name) throw unreadable(`the package has no ${what} (${names.join(" or ")})`);
  let value;
  try { value = JSON.parse(files.find((f) => f.path === name).bytes.toString("utf8")); } catch {
    throw unreadable(`${name} is not JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unreadable(`${name} is not a JSON object`);
  return { name, value };
}

function readPlugin(files) {
  const file = files.find((f) => f.path === "plugin.json");
  if (!file) return {};
  try {
    const value = JSON.parse(file.bytes.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

const text = (v) => (typeof v === "string" && v.trim() ? v : null);

/** Read a package directory. Throws an error with code "unreadable" when it cannot. */
export function readPackage(dir) {
  let files;
  try {
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
    files = shippedFiles(dir);
  } catch (e) {
    if (e.code === "unreadable") throw e;
    throw unreadable("the package directory is missing or cannot be read");
  }
  const descriptor = readDeclaration(files, DESCRIPTOR, "descriptor");
  const requirements = readDeclaration(files, REQUIREMENTS, "runtime requirements");
  const plugin = readPlugin(files);
  return {
    dir,
    name: text(plugin.name) ?? basename(dir),
    version: text(plugin.version) ?? text(descriptor.value.agent_version),
    names: { descriptor: descriptor.name, requirements: requirements.name },
    descriptor: descriptor.value,
    requirements: requirements.value,
    files,
    digest: packageDigest(files),
  };
}
