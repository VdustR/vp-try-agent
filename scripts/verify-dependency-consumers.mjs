import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { z } from "zod";

const rootRequire = createRequire(import.meta.url);
const aiRequire = createRequire(rootRequire.resolve("ai"));
const utilsEntry = aiRequire.resolve("@ai-sdk/provider-utils");
const utilsRequire = createRequire(utilsEntry);
const { getFromApi } = await import(utilsEntry);
const undici = utilsRequire("undici");
assert.equal(utilsRequire("undici/package.json").version, "7.30.1");
const eveRequire = createRequire(rootRequire.resolve("eve"));
assert.equal(eveRequire("undici/package.json").version, "8.12.2");

const connectRequire = createRequire(rootRequire.resolve("@vercel/connect"));
const oidcRequire = createRequire(connectRequire.resolve("@vercel/oidc"));
const cliEntry = oidcRequire.resolve("@vercel/cli-config");
const cliRequire = createRequire(cliEntry);
assert.equal(cliRequire("zod/package.json").version, "4.6.6");
const { globalConfigSchema, authConfigSchema } = oidcRequire("@vercel/cli-config");
assert.deepEqual(globalConfigSchema.parse({ telemetry: { enabled: false }, futureKey: true }), {
  telemetry: { enabled: false }, futureKey: true,
});
assert.equal(globalConfigSchema.safeParse({ credStorage: "invalid-storage" }).success, false);
assert.equal(authConfigSchema.safeParse({ expiresAt: "invalid-timestamp" }).success, false);

const collection = z.array(z.object({ text: z.string().min(1) })).min(1).max(2);
assert.deepEqual(collection.parse([{ text: "hello" }]), [{ text: "hello" }]);
assert.equal(collection.safeParse([]).success, false);
assert.equal(collection.safeParse([{ text: "" }]).success, false);
assert.equal(collection.safeParse([{ text: "1" }, { text: "2" }, { text: "3" }]).success, false);
assert.equal(z.set(z.string()).max(1).safeParse(new Set(["a", "b"])).success, false);
assert.equal(z.map(z.string(), z.number()).max(1).safeParse(new Map([["a", 1], ["b", 2]])).success, false);

const handlers = {
  successfulResponseHandler: async ({ response }) => ({ value: await response.json() }),
  failedResponseHandler: async ({ response }) => ({ value: new Error(`HTTP ${response.status}`) }),
};
// The real provider-utils validated-download path owns the upgraded Undici 7.x.
const remote = await getFromApi({
  url: "https://registry.npmjs.org/zod/4.6.6",
  validateUrl: true,
  abortSignal: AbortSignal.timeout(15000),
  ...handlers,
});
assert.equal(remote.value.version, "4.6.6");
await assert.rejects(getFromApi({ url: "http://127.0.0.1/", validateUrl: true, ...handlers }));

const server = createServer((request, response) => {
  if (request.url === "/events") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"text":"hello"}\n\n');
  } else if (request.url === "/missing") {
    response.writeHead(404);
    response.end("missing");
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const dispatcher = new undici.Agent();
try {
  const json = await undici.fetch(origin, { dispatcher });
  assert.deepEqual(await json.json(), { ok: true });
  const missing = await undici.fetch(origin + "/missing", { dispatcher });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "missing");
  await assert.rejects(getFromApi({ url: origin + "/missing", validateUrl: false, ...handlers }), /HTTP 404/);
  await new Promise((resolve, reject) => {
    const events = new undici.EventSource(origin + "/events");
    const timer = setTimeout(() => { events.close(); reject(new Error("SSE timeout")); }, 5000);
    events.onmessage = (event) => {
      clearTimeout(timer);
      events.close();
      try { assert.deepEqual(JSON.parse(event.data), { text: "hello" }); resolve(); }
      catch (error) { reject(error); }
    };
    events.onerror = () => { clearTimeout(timer); events.close(); reject(new Error("SSE failed")); };
  });
  await assert.rejects(undici.fetch("http://127.0.0.1:1/", { dispatcher }));
} finally {
  await dispatcher.close();
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}
console.log("PASS: Zod constraints, AI provider-utils HTTPS, private-target rejection, parent Undici JSON/SSE/404/network errors; eve override preserved");
