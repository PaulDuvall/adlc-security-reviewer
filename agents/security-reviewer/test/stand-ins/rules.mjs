// Empty stand-in. The Code stage replaces the copy in scripts/; this one stays.
const notWritten = (what) => { throw new Error(`not written: ${what}`); };
export function findRefusals(_pkg, _owner) { return notWritten("findRefusals"); }
export function acceptedKnowingly(_pkg) { return notWritten("acceptedKnowingly"); }
export function notChecked(_pkg) { return notWritten("notChecked"); }
