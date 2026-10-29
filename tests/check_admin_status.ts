// Checks for telling a local build from the deployed one (web/src/lib/build.ts).
// Run from the repository root (web/ must have node_modules):
//   JITI_ALIAS="{\"@\":\"$(pwd)/web/src\"}" web/node_modules/.bin/jiti tests/check_admin_status.ts
import assert from "node:assert/strict";
import { isLocalHost } from "../web/src/lib/build.ts";

// Host names as window.location.hostname gives them: never with a port.
for (const local of ["localhost", "127.0.0.1", "::1", "[::1]", "saylo-pc.local", "192.168.1.20", "10.0.0.5", "172.16.4.2"]) {
  assert.equal(isLocalHost(local), true, local);
}
for (const deployed of ["saylo-rose.vercel.app", "ddd5.tail9b3d3b.ts.net", "172.32.0.1", "8.8.8.8"]) {
  assert.equal(isLocalHost(deployed), false, deployed);
}
// The bug this guards against: "localhost:3000" (location.host) is not a host name.
assert.equal(isLocalHost(new URL("http://localhost:3000/admin").hostname), true);

console.log("admin status checks passed");
