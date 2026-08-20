import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export function wranglerCommand(env = process.env) {
  if (env.PAGE_DROP_WRANGLER_BIN) return { command: env.PAGE_DROP_WRANGLER_BIN, prefix: [] };
  const packageDir = dirname(require.resolve("wrangler/package.json"));
  return { command: process.execPath, prefix: [join(packageDir, "bin", "wrangler.js")] };
}

export async function runWrangler(args, options = {}) {
  const { command, prefix } = wranglerCommand(options.env);
  const child = spawn(command, [...prefix, ...args], {
    env: options.env || process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (!options.capture) {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (code === null) throw new Error(`Wrangler terminated by signal ${signal || "unknown"}`);
    if (code !== 0) throw new Error(`Wrangler exited with status ${code}`);
    return "";
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (code === null) throw new Error(`Wrangler terminated by signal ${signal || "unknown"}`);
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `Wrangler exited with status ${code}`);
  return stdout.trim();
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Could not parse ${label} response from Wrangler`);
  }
}

export async function authHeaders(options = {}) {
  const auth = parseJson(await runWrangler(["auth", "token", "--json"], { ...options, capture: true }), "authentication");
  if (auth && typeof auth === "object" && auth.type === "api_key"
    && typeof auth.key === "string" && auth.key.length > 0
    && typeof auth.email === "string" && auth.email.length > 0) {
    return { "X-Auth-Key": auth.key, "X-Auth-Email": auth.email };
  }
  if (auth && typeof auth === "object"
    && (auth.type === "oauth" || auth.type === "api_token")
    && typeof auth.token === "string" && auth.token.length > 0) {
    return { Authorization: `Bearer ${auth.token}` };
  }
  throw new Error("Wrangler returned an unsupported authentication method; run `pagedrop login`");
}

export async function accounts(options = {}) {
  const identity = parseJson(await runWrangler(["whoami", "--json"], { ...options, capture: true }), "account");
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("Wrangler returned an invalid account response");
  }
  let list;
  if (Array.isArray(identity.accounts) && identity.accounts.length > 0) list = identity.accounts;
  else if (Array.isArray(identity.memberships)) list = identity.memberships;
  else if (Array.isArray(identity.accounts)) list = identity.accounts;
  else throw new Error("Wrangler account response contains no accounts or memberships array");
  return list
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({ id: entry.id || entry.accountId || entry.account?.id, name: entry.name || entry.account?.name }))
    .filter((entry) => typeof entry.id === "string" && entry.id.length > 0);
}
