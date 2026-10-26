// Empty stand-in. The Code stage replaces the copy in scripts/; this one stays.
const notWritten = (what) => { throw new Error(`not written: ${what}`); };
export function languageOf(_path) { return notWritten("languageOf"); }
export function findReach(_text, _language) { return notWritten("findReach"); }
export function isCredentialName(_name) { return notWritten("isCredentialName"); }
