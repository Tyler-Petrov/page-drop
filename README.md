# Page Drop

Page Drop publishes standalone HTML files to Cloudflare R2 and returns a public URL. Supplying an existing key updates that page; supplying a new key creates it; omitting the key generates a random one.

Page contents live in R2. Page Drop keeps no local page index or working copy.

## Requirements

- Node.js 20 or newer
- A Cloudflare account with R2 enabled
- An R2 API token scoped to Object Read & Write for the Page Drop bucket

Cloudflare requires a one-time R2 subscription checkout before R2 can be used. The included free usage still applies.

## Install

From this directory:

```bash
npm install
npm link
```

This installs the `pagedrop` command.

## Cloudflare Setup

Authenticate Wrangler and create the bucket entirely from the terminal:

```bash
npx wrangler login
npx wrangler r2 bucket create page-drop
```

For initial testing, enable the Cloudflare-managed public development URL:

```bash
npx wrangler r2 bucket dev-url enable page-drop
npx wrangler r2 bucket dev-url get page-drop
```

The `r2.dev` URL is intended for development and is rate-limited. For regular use, connect a domain already managed by Cloudflare:

```bash
npx wrangler r2 bucket domain add page-drop \
  --domain html.example.com \
  --zone-id YOUR_ZONE_ID
```

Create an R2 S3 API token with Object Read & Write permission limited to this bucket. Put its values in `credentials.json`:

```json
{
  "accountId": "your-cloudflare-account-id",
  "accessKeyId": "your-r2-access-key-id",
  "secretAccessKey": "your-r2-secret-access-key",
  "bucket": "page-drop",
  "publicBaseUrl": "https://your-public-bucket-url.r2.dev",
  "endpoint": ""
}
```

`credentials.json` is excluded by `.gitignore`. Keep its permissions restricted:

```bash
chmod 600 credentials.json
```

For an EU or other jurisdiction-specific bucket, set `endpoint` to its full S3 endpoint. Otherwise leave it empty.

Configuration may instead be supplied with environment variables:

```text
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
R2_ENDPOINT
PAGE_DROP_BASE_URL
PAGE_DROP_CREDENTIALS
```

`PAGE_DROP_CREDENTIALS` selects a different credentials JSON file.

## Upload

Generate a random 128-bit key:

```bash
pagedrop page.html
```

Create or update a chosen key:

```bash
pagedrop page.html about-me
pagedrop page.html --key about-me
pagedrop put page.html --key about-me
```

Upload from stdin without creating a file:

```bash
generate-html | pagedrop - --key generated-page
```

Valid keys are 1 to 64 characters, start with a lowercase letter or number, and contain only lowercase letters, numbers, underscores, and hyphens.

Every upload is stored with `Content-Type: text/html; charset=utf-8` and `Cache-Control: no-cache`.

## Manage Pages

List pages:

```bash
pagedrop list
```

Download to stdout or a file:

```bash
pagedrop get about-me
pagedrop get about-me --output about.html
```

Delete a page:

```bash
pagedrop delete about-me
```

Interactive editing is intentionally not included yet.

## Help

```bash
pagedrop --help
pagedrop --version
```
