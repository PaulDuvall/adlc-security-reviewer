// Loaded with --import before the reviewer runs. Any attempt to open a connection ends the
// process with status 3 and says so on stderr, so a test can tell it apart from a crash.
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";

const refuse = (what) => () => {
  process.stderr.write(`NETWORK: the reviewer tried to ${what}\n`);
  process.exit(3);
};

net.Socket.prototype.connect = refuse("open a socket");
net.connect = refuse("open a socket");
net.createConnection = refuse("open a socket");
tls.connect = refuse("open a TLS connection");
dns.lookup = refuse("look up a host");
dns.resolve = refuse("look up a host");
globalThis.fetch = refuse("fetch");
globalThis.WebSocket = refuse("open a WebSocket");
