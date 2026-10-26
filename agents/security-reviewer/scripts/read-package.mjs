// Empty stand-in. The Code stage replaces the copy in scripts/; this one stays.
const notWritten = (what) => { throw new Error(`not written: ${what}`); };
export function readPackage(_dir) { return notWritten("readPackage"); }
export function packageDigest(_files) { return notWritten("packageDigest"); }
export function ships(_path) { return notWritten("ships"); }
