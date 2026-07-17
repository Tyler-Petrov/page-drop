#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const VERSION = "0.1.0";
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));

function usage() {
  return `Page Drop ${VERSION}

Publish standalone HTML pages to Cloudflare R2.

Usage:
  pagedrop <file> [key]
  pagedrop put <file> [key]
  pagedrop list
  pagedrop get <key> [--output <file>]
  pagedrop delete <key>

Options:
  -k, --key <key>       Choose the public key when uploading
  -o, --output <file>   Write a downloaded page to a file
  -h, --help            Show this help
  -v, --version         Show the version

Use "-" as the upload file to read HTML from stdin.
`;
}

function fail(message) {
  throw new Error(message);
}

function takeOption(args, shortName, longName) {
  let value;
  const remaining = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === shortName || argument === longName) {
      if (value !== undefined) fail(`${longName} may only be specified once`);
      value = args[index + 1];
      if (!value || value.startsWith("-")) fail(`${longName} requires a value`);
      index += 1;
    } else {
      remaining.push(argument);
    }
  }

  return { value, remaining };
}

function validateKey(key) {
  if (!KEY_PATTERN.test(key)) {
    fail("Keys must start with a lowercase letter or number and contain at most 64 lowercase letters, numbers, underscores, or hyphens");
  }
  return key;
}

function publicUrl(baseUrl, key) {
  return `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(key)}`;
}

async function loadConfig() {
  const credentialsPath = resolve(
    process.env.PAGE_DROP_CREDENTIALS || join(PROJECT_DIR, "credentials.json"),
  );
  let stored = {};

  try {
    stored = JSON.parse(await readFile(credentialsPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      fail(`Could not read ${credentialsPath}: ${error.message}`);
    }
  }

  const config = {
    accountId: process.env.R2_ACCOUNT_ID || stored.accountId,
    accessKeyId: process.env.R2_ACCESS_KEY_ID || stored.accessKeyId,
    secretAccessKey:
      process.env.R2_SECRET_ACCESS_KEY || stored.secretAccessKey,
    bucket: process.env.R2_BUCKET || stored.bucket,
    publicBaseUrl: process.env.PAGE_DROP_BASE_URL || stored.publicBaseUrl,
    endpoint: process.env.R2_ENDPOINT || stored.endpoint,
  };
  const missing = [
    "accountId",
    "accessKeyId",
    "secretAccessKey",
    "bucket",
    "publicBaseUrl",
  ].filter((name) => !config[name]);

  if (missing.length > 0) {
    fail(
      `Missing credentials: ${missing.join(", ")}. Update ${credentialsPath} or set the corresponding environment variables`,
    );
  }

  return config;
}

function createClient(config) {
  return new S3Client({
    region: "auto",
    endpoint:
      config.endpoint ||
      `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

async function objectExists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404 || error.name === "NotFound") {
      return false;
    }
    throw error;
  }
}

async function generatedKey(client, bucket) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const key = randomBytes(16).toString("hex");
    if (!(await objectExists(client, bucket, key))) return key;
  }
  fail("Could not generate an unused key; try again");
}

async function readInput(file) {
  if (file === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  try {
    return await readFile(resolve(file));
  } catch (error) {
    fail(`Could not read ${file}: ${error.message}`);
  }
}

async function put(client, config, args) {
  const parsed = takeOption(args, "-k", "--key");
  const positional = parsed.remaining;
  if (positional.length < 1 || positional.length > 2) {
    fail("Usage: pagedrop put <file> [key]");
  }
  if (parsed.value && positional[1]) {
    fail("Specify the key either positionally or with --key, not both");
  }

  const body = await readInput(positional[0]);
  const requestedKey = parsed.value || positional[1];
  const key = requestedKey
    ? validateKey(requestedKey)
    : await generatedKey(client, config.bucket);
  const existed = await objectExists(client, config.bucket, key);

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: "text/html; charset=utf-8",
      CacheControl: "no-cache",
    }),
  );

  console.log(`${existed ? "Updated" : "Created"}: ${key}`);
  console.log(`URL: ${publicUrl(config.publicBaseUrl, key)}`);
}

async function list(client, config, args) {
  if (args.length > 0) fail("Usage: pagedrop list");
  let continuationToken;
  let count = 0;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of response.Contents || []) {
      console.log(
        `${object.Key}\t${object.Size ?? 0}\t${publicUrl(config.publicBaseUrl, object.Key)}`,
      );
      count += 1;
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  if (count === 0) console.log("No pages found.");
}

async function get(client, config, args) {
  const parsed = takeOption(args, "-o", "--output");
  if (parsed.remaining.length !== 1) {
    fail("Usage: pagedrop get <key> [--output <file>]");
  }

  const key = validateKey(parsed.remaining[0]);
  const response = await client.send(
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
  );
  const body = Buffer.from(await response.Body.transformToByteArray());

  if (parsed.value) {
    await writeFile(resolve(parsed.value), body);
    console.log(`Wrote ${parsed.value}`);
  } else {
    process.stdout.write(body);
  }
}

async function remove(client, config, args) {
  if (args.length !== 1) fail("Usage: pagedrop delete <key>");
  const key = validateKey(args[0]);

  if (!(await objectExists(client, config.bucket, key))) {
    fail(`No page exists with key: ${key}`);
  }

  await client.send(
    new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
  );
  console.log(`Deleted: ${key}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }

  const commands = new Set(["put", "list", "get", "delete"]);
  const command = commands.has(args[0]) ? args.shift() : "put";
  const config = await loadConfig();
  const client = createClient(config);

  try {
    if (command === "put") await put(client, config, args);
    if (command === "list") await list(client, config, args);
    if (command === "get") await get(client, config, args);
    if (command === "delete") await remove(client, config, args);
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exitCode = 1;
});
