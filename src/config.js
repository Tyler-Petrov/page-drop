import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

export function configPath(env = process.env) {
  if (env.PAGE_DROP_CONFIG) return resolve(env.PAGE_DROP_CONFIG);
  if (env.XDG_CONFIG_HOME) return join(resolve(env.XDG_CONFIG_HOME), "pagedrop", "config.json");
  if (platform() === "win32" && env.APPDATA) return join(env.APPDATA, "pagedrop", "config.json");
  return join(homedir(), ".config", "pagedrop", "config.json");
}

export async function readConfig(env = process.env, { required = true } = {}) {
  const path = configPath(env);
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (required) validateConfig(value, path);
    return value;
  } catch (error) {
    if (error.code === "ENOENT" && !required) return {};
    if (error.code === "ENOENT") {
      throw new Error(`Page Drop is not configured. Run \`pagedrop setup\` (expected ${path})`);
    }
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${path}`);
    throw error;
  }
}

export async function writeConfig(config, env = process.env) {
  validateConfig(config, configPath(env));
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return path;
}

export function validateConfig(config, path = "config") {
  const missing = ["accountId", "bucket", "publicBaseUrl"].filter((key) => !config?.[key]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")} in ${path}; run \`pagedrop setup\``);
  let publicUrl;
  try { publicUrl = new URL(config.publicBaseUrl); }
  catch { throw new Error(`publicBaseUrl in ${path} must be an absolute HTTPS URL`); }
  if (publicUrl.protocol !== "https:" || !publicUrl.hostname) {
    throw new Error(`publicBaseUrl in ${path} must be an absolute HTTPS URL`);
  }
  if (config.jurisdiction && !["default", "eu", "fedramp"].includes(config.jurisdiction)) {
    throw new Error(`jurisdiction in ${path} must be default, eu, or fedramp`);
  }
}
