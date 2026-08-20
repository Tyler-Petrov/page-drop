import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";
import { applyEdits } from "./src/edits.js";
import { validateConfig } from "./src/config.js";
import { installSkill } from "./src/skill.js";
import { accounts, authHeaders } from "./src/wrangler.js";

const execute = promisify(execFile);
const cli = join(import.meta.dirname, "bin", "pagedrop.js");

function isolatedEnv(overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PAGE_DROP_")));
  return { ...env, ...overrides };
}

async function executeWithInput(args, { env, input, timeout = 30_000 }) {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeout);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  if (timedOut) return Promise.reject(Object.assign(new Error(`CLI timed out after ${timeout}ms`), { stdout, stderr, code }));
  if (code !== 0) return Promise.reject(Object.assign(new Error(stderr), { stdout, stderr, code }));
  return { stdout, stderr };
}

function ok(response, result, extra = {}) {
  response.writeHead(200, { "Content-Type": "application/json", ...extra });
  response.end(JSON.stringify({ success: true, errors: [], messages: [], result }));
}

async function uploadedFile(request, url) {
  const webRequest = new Request(url, {
    method: request.method,
    headers: request.headers,
    body: Readable.toWeb(request),
    duplex: "half",
  });
  const form = await webRequest.formData();
  const file = form.get("body");
  return { body: Buffer.from(await file.arrayBuffer()), type: file.type || "application/octet-stream" };
}

test("sets up, publishes arbitrary files, edits text, lists, gets, and deletes", async (context) => {
  const objects = new Map();
  let bucketExists = false;
  let bucketCreates = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const objectPrefix = "/client/v4/accounts/test-account/r2/buckets/page-drop/objects/";

    if (request.method === "GET" && url.pathname.endsWith("/r2/buckets/page-drop")) {
      if (bucketExists) return ok(response, { name: "page-drop" });
      response.writeHead(404);
      return response.end(JSON.stringify({ success: false, errors: [{ message: "not found" }] }));
    }
    if (request.method === "POST" && url.pathname.endsWith("/r2/buckets")) {
      bucketExists = true;
      bucketCreates += 1;
      return ok(response, { name: "page-drop" });
    }
    if (request.method === "PUT" && url.pathname.endsWith("/domains/managed")) return ok(response, { domain: "pub-test.r2.dev", enabled: true });
    if (request.method === "GET" && url.pathname.endsWith("/objects")) {
      return ok(response, [...objects].map(([key, value]) => ({ key, size: value.body.length, etag: value.etag, http_metadata: { contentType: value.type } })), {
        "X-Test-Result-Info": "unused",
      });
    }
    if (url.pathname.startsWith(objectPrefix)) {
      const key = url.pathname.slice(objectPrefix.length).split("/").map(decodeURIComponent).join("/");
      if (request.method === "GET") {
        const value = objects.get(key);
        if (!value) { response.writeHead(404); return response.end(JSON.stringify({ success: false, errors: [{ message: "not found" }] })); }
        response.writeHead(200, { "Content-Type": value.type, ETag: `"${value.etag}"`, "Cache-Control": "no-cache" });
        return response.end(value.body);
      }
      if (request.method === "PUT") {
        const file = await uploadedFile(request, url);
        const etag = `etag-${objects.size + file.body.length}`;
        objects.set(key, { ...file, etag });
        return ok(response, { key, size: String(file.body.length), etag });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return ok(response, { key });
      }
    }
    response.writeHead(404);
    response.end(JSON.stringify({ success: false, errors: [{ message: "unknown test route" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());

  const directory = await mkdtemp(join(tmpdir(), "page-drop-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const wrangler = join(directory, "fake-wrangler.mjs");
  const firstPage = join(directory, "first.html");
  const report = join(directory, "report.pdf");
  const downloaded = join(directory, "downloaded.pdf");
  await writeFile(wrangler, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "token") console.log(JSON.stringify({type:"oauth",token:"test-token"}));
else if (args[0] === "whoami") console.log(JSON.stringify({accounts:[{id:"test-account",name:"Test"}]}));
else process.exit(0);
`);
  await chmod(wrangler, 0o755);
  await writeFile(firstPage, "<main><h1>First</h1></main>");
  await writeFile(report, Buffer.from([0x25, 0x50, 0x44, 0x46]));

  const env = isolatedEnv({
    PAGE_DROP_CONFIG: config,
    PAGE_DROP_WRANGLER_BIN: wrangler,
    PAGE_DROP_API_BASE: `http://127.0.0.1:${server.address().port}/client/v4`,
  });
  const run = (...args) => execute(process.execPath, [cli, ...args], { env, timeout: 30_000 });

  const setup = await run("setup");
  assert.match(setup.stdout, /Created bucket: page-drop/);
  assert.match(setup.stdout, /https:\/\/pub-test\.r2\.dev/);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), {
    accountId: "test-account", bucket: "page-drop", publicBaseUrl: "https://pub-test.r2.dev", jurisdiction: "default",
  });
  const repeatedSetup = await run("setup");
  assert.match(repeatedSetup.stdout, /Using existing bucket: page-drop/);
  assert.equal(bucketCreates, 1);

  const status = JSON.parse((await run("status", "--json")).stdout);
  assert.equal(status.authenticated, true);
  assert.equal(status.configured, true);

  const created = await run("publish", firstPage, "pages/example.html");
  assert.match(created.stdout, /Created: pages\/example\.html/);
  assert.equal(objects.get("pages/example.html").body.toString(), "<main><h1>First</h1></main>");
  assert.equal(objects.get("pages/example.html").type, "text/html; charset=utf-8");

  const generated = await run("publish", firstPage, "--json");
  const generatedResult = JSON.parse(generated.stdout);
  assert.match(generatedResult.key, /^[a-f0-9]{32}\.html$/);
  assert.equal(objects.has(generatedResult.key), true);

  const binary = await run("put", report, "reports/report.pdf");
  assert.match(binary.stdout, /Created: reports\/report\.pdf/);
  assert.deepEqual(objects.get("reports/report.pdf").body, Buffer.from([0x25, 0x50, 0x44, 0x46]));
  assert.equal(objects.get("reports/report.pdf").type, "application/pdf");

  const inspected = await run("inspect", "pages/example.html", "--match", "First", "--context", "0");
  assert.match(inspected.stdout, /<main><h1>First<\/h1><\/main>/);
  assert.match(inspected.stderr, /ETag:/);

  const edits = JSON.stringify([{ op: "replace", old: "First", value: "Updated" }]);
  const updated = await executeWithInput(["update", "pages/example.html", "--edits", "-"], { env, input: edits });
  assert.match(updated.stdout, /Updated: pages\/example\.html/);
  assert.equal(objects.get("pages/example.html").body.toString(), "<main><h1>Updated</h1></main>");

  const failed = await executeWithInput(["update", "pages/example.html", "--edits", "-"], {
    env, input: JSON.stringify([{ op: "replace", old: "missing", value: "bad" }]),
  }).then(() => null, (error) => error);
  assert.match(failed.stderr, /expected 1 match but found 0/);
  assert.equal(objects.get("pages/example.html").body.toString(), "<main><h1>Updated</h1></main>");

  const etagFailure = await executeWithInput(["update", "pages/example.html", "--edits", "-", "--if-etag", "stale"], {
    env, input: JSON.stringify([{ op: "replace", old: "Updated", value: "Bad" }]),
  }).then(() => null, (error) => error);
  assert.match(etagFailure.stderr, /ETag mismatch/);
  assert.equal(objects.get("pages/example.html").body.toString(), "<main><h1>Updated</h1></main>");

  const dryRun = await executeWithInput(["update", "pages/example.html", "--edits", "-", "--dry-run"], {
    env, input: JSON.stringify([{ op: "replace", old: "Updated", value: "Preview" }]),
  });
  assert.match(dryRun.stdout, /\+<main><h1>Preview<\/h1><\/main>/);
  assert.equal(objects.get("pages/example.html").body.toString(), "<main><h1>Updated</h1></main>");

  const listed = JSON.parse((await run("list", "--json")).stdout);
  assert.deepEqual(listed.map((item) => item.key).sort(), [generatedResult.key, "pages/example.html", "reports/report.pdf"].sort());

  await run("get", "reports/report.pdf", "--output", downloaded);
  assert.deepEqual(await readFile(downloaded), Buffer.from([0x25, 0x50, 0x44, 0x46]));

  const unconfirmedDelete = await run("delete", "pages/example.html").then(() => null, (error) => error);
  assert.match(unconfirmedDelete.stderr, /Usage: pagedrop delete/);
  assert.equal(objects.has("pages/example.html"), true);

  await run("delete", "pages/example.html", "--yes");
  assert.equal(objects.has("pages/example.html"), false);
});

test("refuses likely secret files", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "page-drop-secret-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secret = join(directory, ".env");
  await writeFile(secret, "TOKEN=public-if-uploaded");
  const result = await execute(process.execPath, [cli, "put", secret], {
    env: isolatedEnv({ PAGE_DROP_CONFIG: join(directory, "missing.json") }),
    timeout: 30_000,
  }).then(() => null, (error) => error);
  assert.match(result.stderr, /Refusing to upload likely secret file/);
});

test("login and logout proxy the pinned Wrangler with explicit safeguards", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "page-drop-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const wrangler = join(directory, "fake-wrangler.mjs");
  const log = join(directory, "wrangler.log");
  await writeFile(wrangler, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.PAGE_DROP_WRANGLER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
  await chmod(wrangler, 0o755);
  const env = isolatedEnv({ PAGE_DROP_WRANGLER_BIN: wrangler, PAGE_DROP_WRANGLER_LOG: log });
  const run = (...args) => execute(process.execPath, [cli, ...args], { env, timeout: 30_000 });

  await run("login", "--device");
  const refused = await run("logout").then(() => null, (error) => error);
  assert.match(refused.stderr, /logs Wrangler out for every tool/);
  await run("logout", "--yes");

  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, [
    ["login", "--use-keyring", "--scopes", "account:read", "user:read", "workers:write", "--device"],
    ["logout"],
  ]);
});

test("edit operations are sequential and enforce match counts", () => {
  assert.equal(applyEdits("a b b", [
    { op: "replace_all", old: "b", value: "c", expectedMatches: 2 },
    { op: "insert_after", old: "a", value: "!" },
  ]), "a! c c");
  assert.throws(() => applyEdits("twice twice", [{ op: "delete", old: "twice" }]), /expected 1 match but found 2/);
  assert.throws(() => applyEdits("nothing", [{ op: "replace_all", old: "missing", value: "bad" }]), /expected 1 match but found 0/);
});

test("configuration requires a complete HTTPS public URL", () => {
  const base = { accountId: "account", bucket: "bucket", jurisdiction: "default" };
  assert.doesNotThrow(() => validateConfig({ ...base, publicBaseUrl: "https://files.example.com/path" }));
  assert.throws(() => validateConfig({ ...base, publicBaseUrl: "https://" }), /absolute HTTPS URL/);
  assert.throws(() => validateConfig({ ...base, publicBaseUrl: "http://files.example.com" }), /absolute HTTPS URL/);
});

test("Wrangler response parsing rejects incomplete auth and uses membership fallback", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "page-drop-wrangler-response-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const wrangler = join(directory, "fake-wrangler.mjs");
  await writeFile(wrangler, `#!/usr/bin/env node
console.log(process.env.FAKE_WRANGLER_OUTPUT);
`);
  await chmod(wrangler, 0o755);

  const baseEnv = isolatedEnv({ PAGE_DROP_WRANGLER_BIN: wrangler });
  await assert.rejects(authHeaders({ env: { ...baseEnv, FAKE_WRANGLER_OUTPUT: JSON.stringify({ type: "oauth", token: "" }) } }), /unsupported authentication method/);
  assert.deepEqual(await accounts({
    env: {
      ...baseEnv,
      FAKE_WRANGLER_OUTPUT: JSON.stringify({
        accounts: [],
        memberships: [null, "invalid", {}, { account: { id: "fallback", name: "Fallback" } }],
      }),
    },
  }), [{ id: "fallback", name: "Fallback" }]);
  await assert.rejects(accounts({ env: { ...baseEnv, FAKE_WRANGLER_OUTPUT: JSON.stringify({ loggedIn: true }) } }), /no accounts or memberships array/);
});

test("skill installer copies only the portable skill bundle", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "page-drop-skill-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = await installSkill({ target: directory });
  assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /^---\nname: page-drop/m);
  assert.match(await readFile(join(target, "agents", "openai.yaml"), "utf8"), /display_name: "Page Drop"/);
  await writeFile(join(target, "obsolete-secret-copy.txt"), "must be removed on update");
  await installSkill({ target: directory });
  await assert.rejects(readFile(join(target, "obsolete-secret-copy.txt")), { code: "ENOENT" });

  await writeFile(join(target, "SKILL.md"), "---\nname: foreign\n---\n");
  await assert.rejects(installSkill({ target: directory }), /not a recognized Page Drop skill/);

  const unrecognizedRoot = join(directory, "unrecognized");
  const unrecognizedTarget = join(unrecognizedRoot, "page-drop");
  await mkdir(unrecognizedTarget, { recursive: true });
  await writeFile(join(unrecognizedTarget, "keep.txt"), "unrelated data");
  await assert.rejects(installSkill({ target: unrecognizedRoot }), /not a recognized Page Drop skill/);
  assert.equal(await readFile(join(unrecognizedTarget, "keep.txt"), "utf8"), "unrelated data");
});
