// Reads tickets from the store the host binds.
const token = process.env.TICKETS_TOKEN;
const base = process.env.TICKETS_URL;

export async function read(id) {
  const r = await fetch(`${base}/tickets/${id}`, { headers: { authorization: `Bearer ${token}` } });
  return r.json();
}
