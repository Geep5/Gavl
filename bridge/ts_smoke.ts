/** Integration smoke: the TS ReticulumTransport spawns the sidecar, signs its binding, gets address. */
import { GavlNode } from "../src/sync/node.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { ReticulumTransport } from "../src/sync/reticulum.ts";
import { generateKeyPair, sign } from "../src/det/ed25519.ts";
import { PARAMS } from "../test/helpers.ts";

const kp = generateKeyPair();
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const node = new GavlNode(new Ledger(PARAMS));
const t = new ReticulumTransport(node, {
	network: "tssmoke",
	storageDir: "bridge/_smoke/ts",
	bindingSigner: (msg) => ({ producer: hex(kp.publicKey), sig: hex(sign(kp.privateKey, msg)) }),
});
await t.join("tssmoke");
console.log("nodeKeyHex:", t.nodeKeyHex, "(len", t.nodeKeyHex.length + ")");
console.log("topicHex:", t.topicHexValue);
await t.destroy();
process.exit(/^[0-9a-f]{32}$/.test(t.nodeKeyHex) ? 0 : 1);
