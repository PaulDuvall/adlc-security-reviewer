// Empty stand-in. The Code stage replaces the copy in scripts/; this one stays.
const notWritten = (what) => { throw new Error(`not written: ${what}`); };
export function statementOf(_pkg, _owner) { return notWritten("statementOf"); }
