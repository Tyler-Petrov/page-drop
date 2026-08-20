import { authHeaders } from "./wrangler.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

function pathPart(value) {
  return encodeURIComponent(value);
}

function objectPart(key) {
  return key.split("/").map(pathPart).join("/");
}

function jurisdictionHeaders(config) {
  return config.jurisdiction && config.jurisdiction !== "default"
    ? { "cf-r2-jurisdiction": config.jurisdiction }
    : {};
}

export class CloudflareR2 {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
    this.getAuthHeaders = options.authHeaders || authHeaders;
    this.apiBase = options.apiBase || process.env.PAGE_DROP_API_BASE || API_BASE;
  }

  bucketUrl(suffix = "") {
    const { accountId, bucket } = this.config;
    return `${this.apiBase}/accounts/${pathPart(accountId)}/r2/buckets/${pathPart(bucket)}${suffix}`;
  }

  async request(url, init = {}, { binary = false } = {}) {
    const response = await this.fetch(url, {
      ...init,
      headers: {
        ...(await this.getAuthHeaders()),
        ...jurisdictionHeaders(this.config),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        const data = JSON.parse(text);
        message = data.errors?.map((error) => error.message).filter(Boolean).join("; ") || text;
      } catch {}
      const error = new Error(`Cloudflare API ${response.status}: ${message || response.statusText}`);
      error.status = response.status;
      throw error;
    }
    if (binary) return response;
    if (response.status === 204) return null;
    const data = await response.json();
    if (data.success === false) throw new Error(data.errors?.map((error) => error.message).join("; ") || "Cloudflare API request failed");
    return data;
  }

  async createBucket() {
    const headers = { "Content-Type": "application/json" };
    const body = { name: this.config.bucket };
    if (this.config.jurisdiction && this.config.jurisdiction !== "default") body.jurisdiction = this.config.jurisdiction;
    return this.request(`${this.apiBase}/accounts/${pathPart(this.config.accountId)}/r2/buckets`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
  }

  async enableManagedDomain() {
    return this.request(this.bucketUrl("/domains/managed"), {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
  }

  async managedDomain() {
    return this.request(this.bucketUrl("/domains/managed"));
  }

  async bucketExists() {
    try {
      await this.request(this.bucketUrl());
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  async list() {
    const objects = [];
    let cursor;
    do {
      const url = new URL(this.bucketUrl("/objects"));
      if (cursor) url.searchParams.set("cursor", cursor);
      const page = await this.request(url);
      objects.push(...(page.result || []));
      cursor = page.result_info?.is_truncated ? page.result_info.cursor : undefined;
    } while (cursor);
    return objects;
  }

  async get(key) {
    const response = await this.request(this.bucketUrl(`/objects/${objectPart(key)}`), {}, { binary: true });
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "application/octet-stream",
      etag: response.headers.get("etag"),
      cacheControl: response.headers.get("cache-control"),
    };
  }

  async exists(key) {
    const url = new URL(this.bucketUrl("/objects"));
    url.searchParams.set("prefix", key);
    url.searchParams.set("per_page", "1");
    const page = await this.request(url);
    return (page.result || []).some((object) => object.key === key);
  }

  async put(key, body, { contentType = "application/octet-stream" } = {}) {
    // Cloudflare's R2 management API expects the object in a multipart field
    // named "body". This differs from the S3-compatible API's raw PUT body.
    const form = new FormData();
    form.append("body", new Blob([body], { type: contentType }), key.split("/").at(-1));
    return this.request(this.bucketUrl(`/objects/${objectPart(key)}`), { method: "PUT", body: form });
  }

  async delete(key) {
    return this.request(this.bucketUrl(`/objects/${objectPart(key)}`), { method: "DELETE" });
  }
}
