import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

export const TOKEN_KEY = "PAGE_DROP_API_TOKEN";
export const TOKEN_KEYS = [TOKEN_KEY, "CLOUDFLARE_API_TOKEN"];
export const ACCOUNT_KEYS = ["PAGE_DROP_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"];

// Cloudflare API tokens are URL-safe base64-ish. Reject anything else before it
// reaches an HTTP header, where an invalid byte would surface as an opaque error.
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{8,256}$/;

export function envFiles(env = process.env) {
  if (env.PAGE_DROP_ENV_FILE) return [resolve(env.PAGE_DROP_ENV_FILE)];
  const home = env.HOME || env.USERPROFILE || homedir();
  return [join(home, ".env"), join(home, ".env.local")];
}

// Later files win, so `.env.local` overrides `.env`; that is also where writes go.
export function tokenFile(env = process.env) {
  return envFiles(env).at(-1);
}

function assignmentPattern(key) {
  return new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
}

async function readEnvFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return null;
    throw new Error(`Could not read ${path}: ${error.message}`);
  }
}

async function fileSettings(env) {
  const settings = new Map();
  for (const path of envFiles(env)) {
    const text = await readEnvFile(path);
    if (text === null) continue;
    let parsed;
    try { parsed = parseEnv(text); }
    catch (error) { throw new Error(`Could not parse ${path}: ${error.message}`); }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") settings.set(key, { value, source: path });
    }
  }
  return settings;
}

// Only the keys Page Drop needs are read; nothing from the file enters process.env.
export async function findSetting(keys, env = process.env) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return { key, value: value.trim(), source: "environment" };
  }
  const settings = await fileSettings(env);
  for (const key of keys) {
    const found = settings.get(key);
    if (found?.value.trim()) return { key, value: found.value.trim(), source: found.source };
  }
  return null;
}

export async function apiToken(env = process.env) {
  const found = await findSetting(TOKEN_KEYS, env);
  if (!found) {
    throw new Error(`No Cloudflare API token found. Run \`pagedrop login\`, or add ${TOKEN_KEY}=... to ${tokenFile(env)}`);
  }
  if (!TOKEN_PATTERN.test(found.value)) {
    throw new Error(`${found.key} in ${found.source} is not a valid Cloudflare API token`);
  }
  const { insecure } = found.source === "environment" ? { insecure: false } : await permissions(found.source);
  return { ...found, insecure };
}

export async function authHeaders(options = {}) {
  const { value } = await apiToken(options.env || process.env);
  return { Authorization: `Bearer ${value}` };
}

export async function configuredAccountId(env = process.env) {
  return (await findSetting(ACCOUNT_KEYS, env))?.value;
}

async function fileMode(path) {
  try { return (await stat(path)).mode & 0o777; }
  catch { return null; }
}

// Windows does not carry POSIX mode bits, so the group/other check is skipped there.
async function permissions(path) {
  const mode = platform() === "win32" ? null : await fileMode(path);
  return { mode, insecure: mode !== null && (mode & 0o077) !== 0 };
}

export async function saveToken(token, env = process.env) {
  const value = String(token).trim();
  if (!TOKEN_PATTERN.test(value)) throw new Error("That does not look like a Cloudflare API token");
  const path = tokenFile(env);
  const existing = await readEnvFile(path);
  const pattern = assignmentPattern(TOKEN_KEY);
  const line = `${TOKEN_KEY}=${value}`;

  const lines = [];
  let replaced = false;
  for (const current of existing === null ? [] : existing.split("\n")) {
    if (!pattern.test(current)) { lines.push(current); continue; }
    if (replaced) continue;
    replaced = true;
    lines.push(line);
  }
  if (!replaced) {
    while (lines.length && lines.at(-1).trim() === "") lines.pop();
    lines.push(line);
  }

  await writeFile(path, `${lines.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  if (existing === null) await chmod(path, 0o600).catch(() => {});
  return { path, replaced, ...(await permissions(path)) };
}

export async function removeToken(env = process.env, key = TOKEN_KEY) {
  const pattern = assignmentPattern(key);
  const cleared = [];
  for (const path of envFiles(env)) {
    const existing = await readEnvFile(path);
    if (existing === null) continue;
    const lines = existing.split("\n");
    const kept = lines.filter((line) => !pattern.test(line));
    if (kept.length === lines.length) continue;
    const text = kept.join("\n").replace(/\n+$/, "");
    await writeFile(path, text ? `${text}\n` : "");
    cleared.push(path);
  }
  return cleared;
}
