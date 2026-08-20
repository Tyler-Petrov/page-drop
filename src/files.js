import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { charset, lookup } from "mime-types";

const SENSITIVE_NAMES = [
  /^\.env(?:\..+)?$/i,
  /^\.(?:npmrc|pypirc|netrc)$/i,
  /^(?:credentials|secrets?)(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /\.(?:pem|key|p12|pfx|jks|kdbx|ovpn)$/i,
];

export function validateKey(key) {
  if (typeof key !== "string" || !key || Buffer.byteLength(key) > 1024) throw new Error("Object keys must be 1 to 1024 bytes");
  if (key.startsWith("/") || key.includes("\\") || /[\u0000-\u001f\u007f]/.test(key)) throw new Error("Object keys cannot start with / or contain backslashes or control characters");
  if (key.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Object keys cannot contain empty, . or .. path segments");
  return key;
}

export function publicUrl(baseUrl, key) {
  return `${baseUrl.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function generatedKey(file = "") {
  const extension = file === "-" ? "" : extname(file).toLowerCase();
  return `${randomBytes(16).toString("hex")}${extension}`;
}

export function contentType(file, explicit, html = false) {
  if (explicit) return explicit;
  if (html) return "text/html; charset=utf-8";
  const type = file !== "-" && lookup(file);
  if (!type) return "application/octet-stream";
  const encoding = charset(type);
  return encoding ? `${type}; charset=${String(encoding).toLowerCase()}` : type;
}

export function assertSafeFile(file, allowSensitive = false) {
  if (file === "-" || allowSensitive) return;
  const name = basename(file);
  if (SENSITIVE_NAMES.some((pattern) => pattern.test(name))) {
    throw new Error(`Refusing to upload likely secret file ${name}; pass --allow-sensitive only if making it public is intentional`);
  }
}

export async function readInput(file, input = process.stdin) {
  if (file !== "-") {
    try { return await readFile(resolve(file)); }
    catch (error) { throw new Error(`Could not read ${file}: ${error.message}`); }
  }
  const chunks = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function isTextContentType(type) {
  return /^(?:text\/|application\/(?:json|javascript|xml|xhtml\+xml|svg\+xml))/.test(type);
}
