// Which build a page runs from: a local one (this computer or the local network) or the deployed site.

/** True for a local build: localhost, a LAN address or a .local name. Takes a host name, without the port. */
export function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(hostname)
  );
}
