import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = join(import.meta.dirname, "pagedrop.js");

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("creates, updates, lists, gets, and deletes pages", async (context) => {
  const objects = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const key = decodeURIComponent(url.pathname.replace(/^\/page-drop\/?/, ""));

    if (request.method === "GET" && url.searchParams.has("list-type")) {
      const contents = [...objects.entries()]
        .map(
          ([objectKey, body]) =>
            `<Contents><Key>${xmlEscape(objectKey)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;test&quot;</ETag><Size>${body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
        )
        .join("");
      response.writeHead(200, { "Content-Type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>page-drop</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
      return;
    }

    if (request.method === "HEAD") {
      if (!objects.has(key)) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Length": objects.get(key).length,
        ETag: '"test"',
      });
      response.end();
      return;
    }

    if (request.method === "PUT") {
      objects.set(key, await requestBody(request));
      response.writeHead(200, { ETag: '"test"' });
      response.end();
      return;
    }

    if (request.method === "GET" && objects.has(key)) {
      const body = objects.get(key);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
      });
      response.end(body);
      return;
    }

    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());

  const directory = await mkdtemp(join(tmpdir(), "page-drop-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = join(directory, "credentials.json");
  const firstPage = join(directory, "first.html");
  const secondPage = join(directory, "second.html");
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  await writeFile(
    credentials,
    JSON.stringify({
      accountId: "test-account",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      bucket: "page-drop",
      publicBaseUrl: "https://pages.example.com",
      endpoint,
    }),
  );
  await writeFile(firstPage, "<h1>First</h1>");
  await writeFile(secondPage, "<h1>Second</h1>");

  const env = { ...process.env, PAGE_DROP_CREDENTIALS: credentials };
  const run = (...args) => execute(process.execPath, [cli, ...args], { env });

  const created = await run(firstPage, "example");
  assert.match(created.stdout, /Created: example/);
  assert.match(created.stdout, /https:\/\/pages\.example\.com\/example/);
  assert.equal(objects.get("example").toString(), "<h1>First</h1>");

  const updated = await run(secondPage, "--key", "example");
  assert.match(updated.stdout, /Updated: example/);
  assert.equal(objects.get("example").toString(), "<h1>Second</h1>");

  const generated = await run(firstPage);
  const generatedKey = generated.stdout.match(/Created: ([a-f0-9]{32})/)?.[1];
  assert.ok(generatedKey);
  assert.ok(objects.has(generatedKey));

  const listed = await run("list");
  assert.match(listed.stdout, /example\t15\thttps:\/\/pages\.example\.com\/example/);
  assert.match(listed.stdout, new RegExp(generatedKey));

  const downloaded = await run("get", "example");
  assert.equal(downloaded.stdout, "<h1>Second</h1>");

  const deleted = await run("delete", "example");
  assert.match(deleted.stdout, /Deleted: example/);
  assert.equal(objects.has("example"), false);
});
