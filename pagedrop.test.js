import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { apiToken, authHeaders, removeToken, saveToken } from "./src/auth.js";
import { validateConfig } from "./src/config.js";
import { applyEdits } from "./src/edits.js";
import { installSkill } from "./src/skill.js";

const execute = promisify(execFile);
const cli = join(import.meta.dirname, "bin", "pagedrop.js");
const EMPTY_HOME = join(tmpdir(), "page-drop-empty-home");
await mkdir(EMPTY_HOME, { recursive: true });

// Never let the developer's real token or home ~/.env leak into a test run.
function isolatedEnv(overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("PAGE_DROP_") && !key.startsWith("CLOUDFLARE_")));
  return { ...env, HOME: EMPTY_HOME, USERPROFILE: EMPTY_HOME, ...overrides };
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

// Mirrors the real R2 management API: the raw request body is the object and
// Content-Type carries its type. It rejects multipart/form-data, so accepting
// a form here would let a broken upload path pass the suite.
async function uploadedFile(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return { body: Buffer.concat(chunks), type: request.headers["content-type"] || "application/octet-stream" };
}

test("sets up, publishes arbitrary files, edits text, lists, gets, and deletes", async (context) => {
  const objects = new Map();
  const seenAuthorization = new Set();
  let bucketExists = false;
  let bucketCreates = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const objectPrefix = "/client/v4/accounts/test-account/r2/buckets/page-drop/objects/";
    seenAuthorization.add(request.headers.authorization);

    if (request.method === "GET" && url.pathname.endsWith("/user/tokens/verify")) {
      return ok(response, { id: "token-id", status: "active" });
    }
    if (request.method === "GET" && url.pathname.endsWith("/client/v4/accounts")) {
      return ok(response, [{ id: "test-account", name: "Test" }]);
    }
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
        const file = await uploadedFile(request);
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
  const home = join(directory, "home");
  const firstPage = join(directory, "first.html");
  const report = join(directory, "report.pdf");
  const downloaded = join(directory, "downloaded.pdf");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ".env"), "UNRELATED=value\nPAGE_DROP_API_TOKEN=from-dot-env\n");
  await writeFile(join(home, ".env.local"), "PAGE_DROP_API_TOKEN=test-token\n");
  await writeFile(firstPage, "<main><h1>First</h1></main>");
  await writeFile(report, Buffer.from([0x25, 0x50, 0x44, 0x46]));

  const env = isolatedEnv({
    HOME: home,
    USERPROFILE: home,
    PAGE_DROP_CONFIG: config,
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
  assert.deepEqual(status.token, { key: "PAGE_DROP_API_TOKEN", source: join(home, ".env.local"), insecure: true });
  assert.equal(JSON.stringify(status).includes("test-token"), false);
  // ~/.env.local wins over ~/.env, and the token reaches Cloudflare as a bearer token.
  assert.deepEqual([...seenAuthorization], ["Bearer test-token"]);

  const created = await run("publish", firstPage, "pages/example");
  assert.match(created.stdout, /Created: pages\/example/);
  assert.equal(objects.get("pages/example").body.toString(), "<main><h1>First</h1></main>");
  assert.equal(objects.get("pages/example").type, "text/html; charset=utf-8");

  const fails = (promise) => promise.then(() => assert.fail("expected the CLI to fail"), (error) => error.stderr);
  assert.match(await fails(run("publish", firstPage)), /Usage: pagedrop publish <file\|-> <key\|--random>/);
  assert.match(await fails(run("publish", firstPage, "pages/other.html")), /use pages\/other instead of pages\/other\.html/);
  assert.match(await fails(run("publish", firstPage, "pages/other", "--random")), /Specify a key or --random, not both/);
  assert.match(await fails(run("publish", firstPage, "pages/example")), /pages\/example already exists; pass --replace/);
  assert.equal(objects.get("pages/example").body.toString(), "<main><h1>First</h1></main>");
  assert.match(await fails(executeWithInput(["put", "-", "notes"], { env, input: "hi" })), /Pass --content-type/);
  assert.equal(objects.has("notes"), false);

  const replaced = await run("publish", firstPage, "--key", "pages/example", "--replace");
  assert.match(replaced.stdout, /Updated: pages\/example/);

  const piped = await executeWithInput(["publish", "-", "pages/piped"], { env, input: "<p>piped</p>" });
  assert.match(piped.stdout, /URL: https:\/\/pub-test\.r2\.dev\/pages\/piped\n/);
  assert.equal(objects.get("pages/piped").type, "text/html; charset=utf-8");
  await run("delete", "pages/piped", "--yes");

  // A version-like suffix is not a file extension, so it stays part of the key.
  await run("put", report, "reports/v1.2");
  assert.equal(objects.get("reports/v1.2").type, "application/pdf");
  await run("delete", "reports/v1.2", "--yes");

  const generated = await run("publish", firstPage, "--random", "--json");
  const generatedResult = JSON.parse(generated.stdout);
  assert.match(generatedResult.key, /^[a-f0-9]{32}$/);
  assert.equal(objects.get(generatedResult.key).type, "text/html; charset=utf-8");

  // publish infers the type from the source file rather than assuming HTML.
  const binary = await run("publish", report, "reports/report");
  assert.match(binary.stdout, /Created: reports\/report/);
  assert.deepEqual(objects.get("reports/report").body, Buffer.from([0x25, 0x50, 0x44, 0x46]));
  assert.equal(objects.get("reports/report").type, "application/pdf");

  const inspected = await run("inspect", "pages/example", "--match", "First", "--context", "0");
  assert.match(inspected.stdout, /<main><h1>First<\/h1><\/main>/);
  assert.match(inspected.stderr, /ETag:/);

  const edits = JSON.stringify([{ op: "replace", old: "First", value: "Updated" }]);
  const updated = await executeWithInput(["update", "pages/example", "--edits", "-"], { env, input: edits });
  assert.match(updated.stdout, /Updated: pages\/example/);
  assert.equal(objects.get("pages/example").body.toString(), "<main><h1>Updated</h1></main>");

  const failed = await executeWithInput(["update", "pages/example", "--edits", "-"], {
    env, input: JSON.stringify([{ op: "replace", old: "missing", value: "bad" }]),
  }).then(() => null, (error) => error);
  assert.match(failed.stderr, /expected 1 match but found 0/);
  assert.equal(objects.get("pages/example").body.toString(), "<main><h1>Updated</h1></main>");

  const etagFailure = await executeWithInput(["update", "pages/example", "--edits", "-", "--if-etag", "stale"], {
    env, input: JSON.stringify([{ op: "replace", old: "Updated", value: "Bad" }]),
  }).then(() => null, (error) => error);
  assert.match(etagFailure.stderr, /ETag mismatch/);
  assert.equal(objects.get("pages/example").body.toString(), "<main><h1>Updated</h1></main>");

  const dryRun = await executeWithInput(["update", "pages/example", "--edits", "-", "--dry-run"], {
    env, input: JSON.stringify([{ op: "replace", old: "Updated", value: "Preview" }]),
  });
  assert.match(dryRun.stdout, /\+<main><h1>Preview<\/h1><\/main>/);
  assert.equal(objects.get("pages/example").body.toString(), "<main><h1>Updated</h1></main>");

  const listed = JSON.parse((await run("list", "--json")).stdout);
  assert.deepEqual(listed.map((item) => item.key).sort(), [generatedResult.key, "pages/example", "reports/report"].sort());

  await run("get", "reports/report", "--output", downloaded);
  assert.deepEqual(await readFile(downloaded), Buffer.from([0x25, 0x50, 0x44, 0x46]));

  const unconfirmedDelete = await run("delete", "pages/example").then(() => null, (error) => error);
  assert.match(unconfirmedDelete.stderr, /Usage: pagedrop delete/);
  assert.equal(objects.has("pages/example"), true);

  await run("delete", "pages/example", "--yes");
  assert.equal(objects.has("pages/example"), false);
});

test("refuses likely secret files", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "page-drop-secret-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secret = join(directory, ".env");
  await writeFile(secret, "TOKEN=public-if-uploaded");
  const result = await execute(process.execPath, [cli, "put", secret, "env"], {
    env: isolatedEnv({ PAGE_DROP_CONFIG: join(directory, "missing.json") }),
    timeout: 30_000,
  }).then(() => null, (error) => error);
  assert.match(result.stderr, /Refusing to upload likely secret file/);
});

test("login stores the token in the home env file and logout removes it", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "page-drop-auth-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const local = join(home, ".env.local");
  await writeFile(local, "EDITOR=vi\nPAGE_DROP_API_TOKEN=stale-token\nOTHER=keep\n");
  await chmod(local, 0o644);
  const env = isolatedEnv({ HOME: home, USERPROFILE: home });
  const run = (...args) => execute(process.execPath, [cli, ...args], { env, timeout: 30_000 });

  const saved = await run("login", "--token", "fresh-token");
  assert.match(saved.stdout, /Updated PAGE_DROP_API_TOKEN/);
  // Unrelated assignments survive and the token is replaced in place, not appended.
  assert.equal(await readFile(local, "utf8"), "EDITOR=vi\nPAGE_DROP_API_TOKEN=fresh-token\nOTHER=keep\n");
  // An already world-readable file is tightened rather than left exposed.
  assert.equal((await stat(local)).mode & 0o777, 0o600);

  const piped = await executeWithInput(["login"], { env, input: "piped-token\n" });
  assert.match(piped.stdout, /Updated PAGE_DROP_API_TOKEN/);
  assert.match(await readFile(local, "utf8"), /^PAGE_DROP_API_TOKEN=piped-token$/m);

  const refused = await run("logout").then(() => null, (error) => error);
  assert.match(refused.stderr, /removes PAGE_DROP_API_TOKEN/);
  assert.match(await readFile(local, "utf8"), /piped-token/);

  const out = await run("logout", "--yes");
  assert.match(out.stdout, /Removed PAGE_DROP_API_TOKEN/);
  assert.equal(await readFile(local, "utf8"), "EDITOR=vi\nOTHER=keep\n");
  assert.match((await run("logout", "--yes")).stdout, /No PAGE_DROP_API_TOKEN entry/);
  assert.match((await run("status")).stdout, /Authenticated: no/);
});

test("login creates a private env file and refuses an implausible token", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "page-drop-auth-new-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const env = isolatedEnv({ HOME: home, USERPROFILE: home });
  const run = (...args) => execute(process.execPath, [cli, ...args], { env, timeout: 30_000 });

  const rejected = await run("login", "--token", "not a token").then(() => null, (error) => error);
  assert.match(rejected.stderr, /does not look like a Cloudflare API token/);
  await assert.rejects(readFile(join(home, ".env.local")), { code: "ENOENT" });

  const saved = await run("login", "--token", "brand-new-token");
  assert.match(saved.stdout, /Saved PAGE_DROP_API_TOKEN/);
  const created = await stat(join(home, ".env.local"));
  assert.equal(created.mode & 0o777, 0o600);
});

test("tokens resolve from the environment, then ~/.env, then ~/.env.local", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "page-drop-token-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const base = isolatedEnv({ HOME: home, USERPROFILE: home });

  await assert.rejects(apiToken(base), /No Cloudflare API token found/);

  await writeFile(join(home, ".env"), "PAGE_DROP_API_TOKEN=dot-env-token\n");
  assert.equal((await apiToken(base)).value, "dot-env-token");
  assert.equal((await apiToken(base)).source, join(home, ".env"));

  await writeFile(join(home, ".env.local"), "PAGE_DROP_API_TOKEN=dot-env-local\n");
  assert.equal((await apiToken(base)).value, "dot-env-local");

  assert.deepEqual(await authHeaders({ env: { ...base, PAGE_DROP_API_TOKEN: "from-shell" } }), {
    Authorization: "Bearer from-shell",
  });

  // The Cloudflare-wide name is a fallback for both files and the environment.
  await rm(join(home, ".env"));
  await writeFile(join(home, ".env.local"), 'CLOUDFLARE_API_TOKEN="quoted-token"\n');
  await chmod(join(home, ".env.local"), 0o600);
  assert.deepEqual(await apiToken(base), {
    key: "CLOUDFLARE_API_TOKEN", value: "quoted-token", source: join(home, ".env.local"), insecure: false,
  });
  await chmod(join(home, ".env.local"), 0o644);
  assert.equal((await apiToken(base)).insecure, true);

  await writeFile(join(home, ".env.local"), "PAGE_DROP_API_TOKEN=has spaces\n");
  await assert.rejects(apiToken(base), /not a valid Cloudflare API token/);

  // logout only clears the Page Drop key, leaving other tools' tokens alone.
  await writeFile(join(home, ".env.local"), "CLOUDFLARE_API_TOKEN=shared-token\nexport PAGE_DROP_API_TOKEN=mine\n");
  assert.deepEqual(await removeToken(base), [join(home, ".env.local")]);
  assert.equal(await readFile(join(home, ".env.local"), "utf8"), "CLOUDFLARE_API_TOKEN=shared-token\n");

  await saveToken("written-token", base);
  assert.equal(await readFile(join(home, ".env.local"), "utf8"), "CLOUDFLARE_API_TOKEN=shared-token\nPAGE_DROP_API_TOKEN=written-token\n");
});

test("setup accepts an explicit account when the token cannot list accounts", async (context) => {
  const account = "0123456789abcdef0123456789abcdef";
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.endsWith("/client/v4/accounts")) {
      response.writeHead(403, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ success: false, errors: [{ message: "Unauthorized to access requested resource" }] }));
    }
    if (request.method === "GET" && url.pathname.endsWith(`/accounts/${account}/r2/buckets/page-drop`)) return ok(response, { name: "page-drop" });
    if (request.method === "PUT" && url.pathname.endsWith("/domains/managed")) return ok(response, { domain: "pub-scoped.r2.dev", enabled: true });
    response.writeHead(404);
    response.end(JSON.stringify({ success: false, errors: [{ message: "unknown test route" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());

  const directory = await mkdtemp(join(tmpdir(), "page-drop-scoped-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const env = isolatedEnv({
    PAGE_DROP_CONFIG: join(directory, "config.json"),
    PAGE_DROP_API_TOKEN: "scoped-token",
    PAGE_DROP_API_BASE: `http://127.0.0.1:${server.address().port}/client/v4`,
  });
  const run = (...args) => execute(process.execPath, [cli, ...args], { env, timeout: 30_000 });

  const failed = await run("setup").then(() => null, (error) => error);
  assert.match(failed.stderr, /Re-run with --account <id>/);

  const setup = await run("setup", "--account", account);
  assert.match(setup.stdout, /Using existing bucket: page-drop/);
  assert.equal(JSON.parse(await readFile(join(directory, "config.json"), "utf8")).accountId, account);
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
