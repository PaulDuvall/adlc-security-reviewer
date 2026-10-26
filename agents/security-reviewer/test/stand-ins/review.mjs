// Empty stand-in. The Code stage replaces the copy in scripts/; this one stays.
// As a command it reads nothing and writes nothing, so every behavioral test fails.
const notWritten = (what) => { throw new Error(`not written: ${what}`); };
export function answer(_request, _options) { return notWritten("answer"); }
if (import.meta.url === `file://${process.argv[1]}`) notWritten("review.mjs as a command");
