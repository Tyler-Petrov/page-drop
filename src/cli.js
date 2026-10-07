import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { apiToken, configuredAccountId, removeToken, saveToken, TOKEN_KEY, tokenFile } from "./auth.js";
import { CloudflareR2 } from "./cloudflare.js";
import { configPath, readConfig, validateConfig, writeConfig } from "./config.js";
import { applyEdits, matchingLines } from "./edits.js";
import { assertSafeFile, contentType, isTextContentType, publicUrl, randomKey, readInput, validateKey, validateUploadKey } from "./files.js";
import { readSecret } from "./prompt.js";
import { installSkill } from "./skill.js";

const VERSION = "0.3.0";
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

function usage() {
  return `Page Drop ${VERSION}

Publish and update public files in your own Cloudflare R2 bucket.

Setup:
  pagedrop login [--token <token>]
  pagedrop setup [--account <id>] [--bucket <name>] [--public-base-url <url>]
  pagedrop status [--json]
  pagedrop logout --yes
  pagedrop skill install [--target <skills-dir>] [--force]

Files:
  pagedrop publish <file|-> <key|--random> [--content-type <type>] [--replace]
  pagedrop put <file|-> <key|--random> [--content-type <type>] [--replace]
  pagedrop list [--json]
  pagedrop get <key> [--output <file>]
  pagedrop inspect <key> [--match <text>] [--context <lines>]
  pagedrop update <key> --edits <file|-> [--if-etag <etag>] [--dry-run]
  pagedrop delete <key> --yes

Page Drop reads a Cloudflare API token from ${TOKEN_KEY} (or CLOUDFLARE_API_TOKEN)
in the environment, then ~/.env, then ~/.env.local. Create a token with the
"Workers R2 Storage: Edit" permission at ${TOKEN_URL}.

Keys are required and have no file extension: page.html uploaded to "pricing" is
served at <public-url>/pricing with its content type inferred from page.html.
--random picks an unguessable key instead. Uploading to an existing key fails
unless --replace is given. publish treats stdin as HTML; put requires
--content-type for stdin.
The shorthand \`pagedrop <file> <key>\` runs publish. Use --allow-sensitive only
when intentionally making a file such as .env, credentials.json, or a key public.
--if-etag checks the downloaded version before upload, but it cannot make the
Cloudflare management API upload atomic with that check.
`;
}

function takeOption(args, names, { boolean = false, defaultValue } = {}) {
  let value = defaultValue;
  const remaining = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!names.includes(argument)) { remaining.push(argument); continue; }
    if (boolean) { value = true; continue; }
    if (value !== defaultValue && value !== undefined) throw new Error(`${names.at(-1)} may only be specified once`);
    const next = args[++index];
    if (next === undefined || next === "" || next.startsWith("--")) throw new Error(`${names.at(-1)} requires a value`);
    value = next;
  }
  return { value, args: remaining };
}

function output(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
}

function parseCommon(args) {
  const json = takeOption(args, ["--json"], { boolean: true });
  return { json: json.value, args: json.args };
}

async function login(args) {
  const parsed = takeOption(args, ["--token"]);
  if (parsed.args.length) throw new Error("Usage: pagedrop login [--token <token>]");
  let token = parsed.value;
  if (!token) {
    if (process.stdin.isTTY) {
      console.error(`Create a Cloudflare API token with the "Workers R2 Storage: Edit" permission:`);
      console.error(`  ${TOKEN_URL}`);
    }
    token = await readSecret("Cloudflare API token (hidden): ");
  }
  if (!token) throw new Error("No token was provided");
  const saved = await saveToken(token);
  console.log(`${saved.replaced ? "Updated" : "Saved"} ${TOKEN_KEY} in ${saved.path}`);
  if (saved.insecure) {
    console.error(`Warning: ${saved.path} is readable by other users (mode ${saved.mode.toString(8).padStart(3, "0")}); run \`chmod 600 ${saved.path}\``);
  }
  console.log("Next: pagedrop setup");
}

function selectAccount(found, requested) {
  if (requested) {
    const match = found.find((account) => account.id === requested || account.name === requested);
    if (!match) throw new Error(`Cloudflare account not found: ${requested}`);
    return match;
  }
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Error("No Cloudflare accounts found; check the API token from `pagedrop login`");
  throw new Error(`More than one Cloudflare account is available. Re-run with --account <id>: ${found.map((item) => `${item.name || "unnamed"} (${item.id})`).join(", ")}`);
}

// A token scoped to one account may be denied the account list, so an explicit
// account ID is accepted without it.
async function resolveAccount(requested) {
  try {
    return selectAccount(await new CloudflareR2({}).accounts(), requested);
  } catch (error) {
    if (error.status && /^[0-9a-f]{32}$/i.test(requested || "")) return { id: requested };
    if (error.status) throw new Error(`${error.message}. Re-run with --account <id> if the API token cannot list accounts`);
    throw error;
  }
}

async function setup(args) {
  let parsed = takeOption(args, ["--account"]);
  const account = parsed.value;
  parsed = takeOption(parsed.args, ["--bucket"], { defaultValue: "page-drop" });
  const bucket = parsed.value;
  parsed = takeOption(parsed.args, ["--public-base-url"]);
  const requestedBaseUrl = parsed.value;
  parsed = takeOption(parsed.args, ["--jurisdiction"], { defaultValue: "default" });
  const jurisdiction = parsed.value;
  if (parsed.args.length) throw new Error("Usage: pagedrop setup [--account <id>] [--bucket <name>] [--public-base-url <url>] [--jurisdiction <value>]");

  const chosen = await resolveAccount(account || await configuredAccountId());
  const draft = { accountId: chosen.id, bucket, publicBaseUrl: requestedBaseUrl || "https://pending.invalid", jurisdiction };
  validateConfig(draft, "setup options");
  const client = new CloudflareR2(draft);
  if (!(await client.bucketExists())) {
    await client.createBucket();
    console.log(`Created bucket: ${bucket}`);
  } else {
    console.log(`Using existing bucket: ${bucket}`);
  }

  if (!requestedBaseUrl) {
    const enabled = await client.enableManagedDomain();
    const domain = enabled.result?.domain;
    if (!domain) throw new Error("Cloudflare enabled public access but did not return the r2.dev domain");
    draft.publicBaseUrl = `https://${domain}`;
  }
  const path = await writeConfig(draft);
  console.log(`Configured: ${path}`);
  console.log(`Bucket: ${bucket}`);
  console.log(`Public base URL: ${draft.publicBaseUrl}`);
}

async function status(args) {
  const common = parseCommon(args);
  if (common.args.length) throw new Error("Usage: pagedrop status [--json]");
  const config = await readConfig(process.env, { required: false });
  let token = null;
  let authenticated = false;
  let problem;
  try {
    const found = await apiToken();
    token = { key: found.key, source: found.source, insecure: found.insecure };
    authenticated = await new CloudflareR2(config).verifyToken();
    if (!authenticated) problem = "Cloudflare reports the API token is not active";
  } catch (error) {
    problem = error.message;
  }
  const result = { authenticated, token, tokenFile: tokenFile(), configured: Boolean(config.accountId && config.bucket && config.publicBaseUrl), configPath: configPath(), ...config };
  if (problem) result.error = problem;
  if (common.json) return output(result, true);
  console.log(`Authenticated: ${authenticated ? "yes" : "no"}`);
  console.log(`Token: ${token ? `${token.key} from ${token.source}` : `none; run \`pagedrop login\` or set ${TOKEN_KEY} in ${tokenFile()}`}`);
  if (token?.insecure) console.log(`Warning: ${token.source} is readable by other users; run \`chmod 600 ${token.source}\``);
  if (problem && token) console.log(`Problem: ${problem}`);
  console.log(`Configured: ${result.configured ? "yes" : "no"}`);
  console.log(`Config: ${result.configPath}`);
  if (result.configured) {
    console.log(`Account: ${config.accountId}`);
    console.log(`Bucket: ${config.bucket}`);
    console.log(`Public base URL: ${config.publicBaseUrl}`);
  }
}

async function upload(command, args) {
  let parsed = takeOption(args, ["-k", "--key"]);
  const explicitKey = parsed.value;
  parsed = takeOption(parsed.args, ["--content-type"]);
  const explicitType = parsed.value;
  parsed = takeOption(parsed.args, ["--allow-sensitive"], { boolean: true });
  const allowSensitive = parsed.value;
  parsed = takeOption(parsed.args, ["--random"], { boolean: true });
  const random = parsed.value;
  parsed = takeOption(parsed.args, ["--replace"], { boolean: true });
  const replace = parsed.value;
  parsed = takeOption(parsed.args, ["--json"], { boolean: true });
  const json = parsed.value;
  const positional = parsed.args;
  if (explicitKey && positional[1]) throw new Error("Specify the key positionally or with --key, not both");
  const namedKey = explicitKey || positional[1];
  if (random && namedKey) throw new Error("Specify a key or --random, not both");
  if (positional.length < 1 || positional.length > 2 || !(namedKey || random)) throw new Error(`Usage: pagedrop ${command} <file|-> <key|--random> [--content-type <type>] [--replace]`);

  const file = positional[0];
  if (file === "-" && command === "put" && !explicitType) throw new Error("Pass --content-type when uploading from stdin with put");
  assertSafeFile(file, allowSensitive);
  const key = random ? randomKey() : validateUploadKey(namedKey);
  const body = await readInput(file);
  const type = contentType(file, explicitType, command === "publish" ? "text/html; charset=utf-8" : undefined);
  const config = await readConfig();
  const client = new CloudflareR2(config);
  const existed = await client.exists(key);
  if (existed && !replace) throw new Error(`${key} already exists; pass --replace to overwrite it`);
  const response = await client.put(key, body, { contentType: type });
  const result = { action: existed ? "updated" : "created", key, url: publicUrl(config.publicBaseUrl, key), size: body.length, contentType: type, etag: response.result?.etag };
  if (json) return output(result, true);
  console.log(`${existed ? "Updated" : "Created"}: ${key}`);
  console.log(`URL: ${result.url}`);
}

async function list(args) {
  const common = parseCommon(args);
  if (common.args.length) throw new Error("Usage: pagedrop list [--json]");
  const config = await readConfig();
  const objects = await new CloudflareR2(config).list();
  const rows = objects.map((item) => ({ ...item, url: publicUrl(config.publicBaseUrl, item.key) }));
  if (common.json) return output(rows, true);
  if (!rows.length) return console.log("No objects found.");
  for (const item of rows) console.log(`${item.key}\t${item.size ?? 0}\t${item.url}`);
}

async function get(args) {
  let parsed = takeOption(args, ["-o", "--output"]);
  const destination = parsed.value;
  if (parsed.args.length !== 1) throw new Error("Usage: pagedrop get <key> [--output <file>]");
  const key = validateKey(parsed.args[0]);
  const object = await new CloudflareR2(await readConfig()).get(key);
  if (!destination) return process.stdout.write(object.body);
  await writeFile(resolve(destination), object.body);
  console.log(`Wrote: ${destination}`);
}

async function inspect(args) {
  let parsed = takeOption(args, ["--match"]);
  const match = parsed.value;
  parsed = takeOption(parsed.args, ["--context"], { defaultValue: "2" });
  const context = Number(parsed.value);
  parsed = takeOption(parsed.args, ["--json"], { boolean: true });
  const json = parsed.value;
  if (parsed.args.length !== 1 || !Number.isInteger(context) || context < 0) throw new Error("Usage: pagedrop inspect <key> [--match <text>] [--context <lines>] [--json]");
  const key = validateKey(parsed.args[0]);
  const object = await new CloudflareR2(await readConfig()).get(key);
  if (!isTextContentType(object.contentType)) throw new Error(`Cannot inspect binary content type ${object.contentType}`);
  const body = object.body.toString("utf8");
  if (json) return output({ key, etag: object.etag, contentType: object.contentType, body: match ? matchingLines(body, match, context) : body }, true);
  console.error(`ETag: ${object.etag || "unknown"}`);
  console.log(match ? matchingLines(body, match, context) : body);
}

async function update(args) {
  let parsed = takeOption(args, ["--edits"]);
  const editSource = parsed.value;
  parsed = takeOption(parsed.args, ["--if-etag"]);
  const expectedEtag = parsed.value;
  parsed = takeOption(parsed.args, ["--dry-run"], { boolean: true });
  const dryRun = parsed.value;
  parsed = takeOption(parsed.args, ["--json"], { boolean: true });
  const json = parsed.value;
  if (parsed.args.length !== 1 || !editSource) throw new Error("Usage: pagedrop update <key> --edits <file|-> [--if-etag <etag>] [--dry-run]");
  const key = validateKey(parsed.args[0]);
  const config = await readConfig();
  const client = new CloudflareR2(config);
  const current = await client.get(key);
  if (!isTextContentType(current.contentType)) throw new Error(`Cannot structurally update binary content type ${current.contentType}; use pagedrop put to replace it`);
  if (expectedEtag && expectedEtag !== current.etag && expectedEtag !== current.etag?.replace(/^"|"$/g, "")) throw new Error(`ETag mismatch: remote object is ${current.etag}; nothing was uploaded`);
  const editsText = editSource === "-" ? (await readInput("-")).toString("utf8") : await readFile(resolve(editSource), "utf8");
  let edits;
  try { edits = JSON.parse(editsText); } catch { throw new Error("--edits must contain valid JSON"); }
  const before = current.body.toString("utf8");
  const after = applyEdits(before, edits);
  if (before === after) throw new Error("Edits made no changes; nothing was uploaded");
  if (dryRun) return console.log(createTwoFilesPatch(`${key} (remote)`, `${key} (updated)`, before, after, "", ""));
  const response = await client.put(key, Buffer.from(after), { contentType: current.contentType });
  const result = { action: "updated", key, url: publicUrl(config.publicBaseUrl, key), etag: response.result?.etag };
  if (json) return output(result, true);
  console.log(`Updated: ${key}`);
  console.log(`URL: ${result.url}`);
}

async function remove(args) {
  const yes = takeOption(args, ["--yes"], { boolean: true });
  if (yes.args.length !== 1 || !yes.value) throw new Error("Usage: pagedrop delete <key> --yes");
  const key = validateKey(yes.args[0]);
  await new CloudflareR2(await readConfig()).delete(key);
  console.log(`Deleted: ${key}`);
}

async function skill(args) {
  if (args.shift() !== "install") throw new Error("Usage: pagedrop skill install [--target <skills-dir>] [--force]");
  let parsed = takeOption(args, ["--target"]);
  const target = parsed.value;
  parsed = takeOption(parsed.args, ["--force"], { boolean: true });
  if (parsed.args.length) throw new Error("Usage: pagedrop skill install [--target <skills-dir>] [--force]");
  console.log(`Installed Page Drop skill: ${await installSkill({ target, force: parsed.value })}`);
}

async function logout(args) {
  const yes = takeOption(args, ["--yes"], { boolean: true });
  if (yes.args.length || !yes.value) throw new Error(`This removes ${TOKEN_KEY} from ${tokenFile()}. Re-run as \`pagedrop logout --yes\``);
  const cleared = await removeToken();
  console.log(cleared.length ? `Removed ${TOKEN_KEY} from ${cleared.join(", ")}` : `No ${TOKEN_KEY} entry was found in ${tokenFile()}`);
  let remaining;
  try { remaining = await apiToken(); } catch {}
  if (remaining) console.log(`Still authenticated by ${remaining.key} from ${remaining.source}; Cloudflare was not asked to revoke any token.`);
  else console.log(`Revoke the token itself at ${TOKEN_URL}`);
}

export async function run(rawArgs) {
  const args = [...rawArgs];
  if (!args.length || args.includes("--help") || args.includes("-h")) return console.log(usage());
  if (args.includes("--version") || args.includes("-v")) return console.log(VERSION);
  const known = new Set(["login", "setup", "status", "logout", "skill", "publish", "put", "list", "get", "inspect", "update", "delete"]);
  const command = known.has(args[0]) ? args.shift() : "publish";
  if (command === "login") return login(args);
  if (command === "setup") return setup(args);
  if (command === "status") return status(args);
  if (command === "logout") return logout(args);
  if (command === "skill") return skill(args);
  if (command === "publish" || command === "put") return upload(command, args);
  if (command === "list") return list(args);
  if (command === "get") return get(args);
  if (command === "inspect") return inspect(args);
  if (command === "update") return update(args);
  if (command === "delete") return remove(args);
}
