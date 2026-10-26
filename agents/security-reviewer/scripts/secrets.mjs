// Empty stand-in. The Code stage replaces the copy in scripts/; this one stays.
const notWritten = (what) => { throw new Error(`not written: ${what}`); };
export const SECRETS = [];
export function carriesASecret(_bytes) { return notWritten("carriesASecret"); }
