import test from "node:test";
import assert from "node:assert/strict";
import handler from "../deploy/vercel/api/proxy.mjs";

const operator = "o".repeat(48), hub = "h".repeat(48);
const env = { STRATA_OPERATOR_TOKEN: operator, STRATA_HUB_TOKEN: hub,
  STRATA_BACKEND_URL: "https://api.strata.example", CF_ACCESS_CLIENT_ID: "client-id",
  CF_ACCESS_CLIENT_SECRET: "server-only-secret" };
function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
async function invoke(query = { route: "incidents" }, changes = {}, fetcher = async () => {
  throw new Error("Unexpected upstream request");
}) {
  const saved = { ...process.env }, oldFetch = globalThis.fetch;
  Object.assign(process.env, env);
  globalThis.fetch = fetcher;
  const res = response();
  try {
    await handler({ query, method: "GET", headers: { authorization: `Bearer ${operator}` }, ...changes }, res);
    return res;
  } finally { process.env = saved; globalThis.fetch = oldFetch; }
}

test("rejects unauthenticated requests before accessing the backend", async () => {
  const result = await invoke(undefined, { headers: {} });
  assert.equal(result.statusCode, 401);
  assert.equal(result.headers["Cache-Control"], "no-store, private");
});
test("only known routes and methods can be proxied", async () => {
  for (const route of ["metrics", "ingest", "https://evil.example", "__proto__"])
    assert.equal((await invoke({ route })).statusCode, 404);
  assert.equal((await invoke(undefined, { method: "POST" })).statusCode, 405);
  assert.equal((await invoke({ route: "history", id: "../../metrics" })).statusCode, 400);
});
test("operator credentials are replaced by server-only Hub and Access credentials", async () => {
  const result = await invoke({ route: "history", id: "record-01" }, {}, async (url, options) => {
    assert.equal(url.href, "https://api.strata.example/incidents/record-01/history");
    assert.equal(options.headers.Authorization, `Bearer ${hub}`);
    assert.equal(options.headers["CF-Access-Client-Secret"], env.CF_ACCESS_CLIENT_SECRET);
    assert.equal(options.redirect, "manual");
    assert.ok(!JSON.stringify(options).includes(operator));
    return new Response(JSON.stringify([{ state: "open" }]), { headers: { "Content-Type": "application/json" } });
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, [{ state: "open" }]);
});
test("redirects and non-JSON origin responses never reach the browser", async () => {
  assert.equal((await invoke(undefined, {}, async () => new Response(null, { status: 302 }))).statusCode, 502);
  assert.equal((await invoke(undefined, {}, async () => new Response("Login page"))).statusCode, 502);
});
test("timeout and network errors are sanitized", async () => {
  const result = await invoke();
  assert.equal(result.statusCode, 502);
  assert.ok(!JSON.stringify(result.body).includes("Unexpected"));
});
test("AI mutation uses the fixed path and accepts no arbitrary payload", async () => {
  const result = await invoke({ route: "analyze", id: "incident-01" }, { method: "POST" }, async (url, options) => {
    assert.equal(url.pathname, "/incidents/incident-01/analyze");
    assert.equal(options.method, "POST");
    return new Response('{"id":"run-01"}', { headers: { "Content-Type": "application/json" } });
  });
  assert.equal(result.statusCode, 200);
  assert.equal((await invoke({ route: "analyze", id: "incident-01" },
    { method: "POST", body: { arbitrary: "payload" } })).statusCode, 400);
});
test("missing settings, reused tokens and unsafe origins fail closed", async () => {
  for (const changes of [{ STRATA_OPERATOR_TOKEN: "" }, { STRATA_HUB_TOKEN: operator },
    { CF_ACCESS_CLIENT_SECRET: "" }, { STRATA_BACKEND_URL: "http://127.0.0.1:8082" },
    { STRATA_BACKEND_URL: "https://temporary.trycloudflare.com" },
    { STRATA_BACKEND_URL: "https://api.strata.example/path" }]) {
    const saved = { ...process.env }, oldFetch = globalThis.fetch;
    Object.assign(process.env, env, changes);
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error("Must not forward"); };
    try {
      const res = response();
      await handler({ query: { route: "incidents" }, method: "GET", headers: { authorization: `Bearer ${operator}` } }, res);
      assert.equal(res.statusCode, 503);
      assert.equal(called, false);
    } finally { process.env = saved; globalThis.fetch = oldFetch; }
  }
});
