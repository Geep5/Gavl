/**
 * Esplora endpoint failover — the custody bridge must survive a block-explorer outage (a dead
 * mempool.space testnet API blocked deposit verification fleet-wide). Dead/5xx endpoints fail over;
 * 4xx (a real answer) does not; the endpoint that worked is remembered so steady-state calls don't
 * re-pay a dead endpoint's timeout.
 *
 *   node --test test/esplora-failover.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Esplora } from "../src/custody/esplora.ts";

const TX = { txid: "ab".repeat(32), vout: [{ value: 1234 }], status: { confirmed: true, block_height: 5 } };

/** A tiny Esplora mock: counts hits, answers /tx/* with `status` (+ the canned tx on 200). */
function mock(status = 200): Promise<{ url: string; hits: () => number; close: () => void }> {
	let n = 0;
	const srv = createServer((req, res) => {
		n++;
		res.writeHead(status, { "content-type": "application/json" });
		res.end(status === 200 ? JSON.stringify(TX) : "{}");
	});
	return new Promise((resolve) => {
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as AddressInfo;
			resolve({ url: `http://127.0.0.1:${port}`, hits: () => n, close: () => srv.close() });
		});
	});
}

test("a dead endpoint fails over to the next, which is then remembered", async () => {
	const live = await mock();
	// port 1 refuses instantly (nothing listens) — the dead endpoint costs a connection error, not a timeout
	const es = new Esplora({ net: "testnet", bases: ["http://127.0.0.1:1", live.url], timeoutMs: 3_000 });
	const tx = await es.getTx(TX.txid);
	assert.equal(tx?.txid, TX.txid, "answer came from the live endpoint");
	await es.getTx(TX.txid);
	assert.equal(live.hits(), 2, "second call went straight to the remembered endpoint");
	live.close();
});

test("a 5xx endpoint fails over; the fallback answers", async () => {
	const sick = await mock(500);
	const live = await mock();
	const es = new Esplora({ net: "testnet", bases: [sick.url, live.url], timeoutMs: 3_000 });
	const tx = await es.getTx(TX.txid);
	assert.equal(tx?.txid, TX.txid);
	assert.equal(sick.hits(), 1, "sick endpoint was tried once");
	assert.equal(live.hits(), 1, "then the fallback answered");
	sick.close();
	live.close();
});

test("a 404 is a real answer from a healthy endpoint — no failover", async () => {
	const notFound = await mock(404);
	const other = await mock();
	const es = new Esplora({ net: "testnet", bases: [notFound.url, other.url], timeoutMs: 3_000 });
	assert.equal(await es.getTx(TX.txid), null, "404 → null (tx unknown), per the API contract");
	assert.equal(other.hits(), 0, "no failover on a semantic answer");
	notFound.close();
	other.close();
});

test("all endpoints dead → one descriptive error naming them", async () => {
	const es = new Esplora({ net: "testnet", bases: ["http://127.0.0.1:1", "http://127.0.0.1:2"], timeoutMs: 2_000 });
	await assert.rejects(() => es.getTx(TX.txid), /all endpoints failed/);
});
