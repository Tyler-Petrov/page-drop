# Page Drop

Page Drop is a small CLI for publishing public files to your own Cloudflare R2 bucket. It includes one optional agent skill for Codex, Claude Code, Cursor, OpenCode, and other harnesses that read the shared `~/.agents/skills` directory.

The CLI is the product. The skill teaches an agent how to use it.

Page Drop keeps no local copy of uploaded files and stores no Cloudflare API key. It uses Wrangler's browser login and asks Wrangler for the current auto-refreshed token only when making a request. Its config contains only the Cloudflare account ID, bucket name, public URL, and jurisdiction.

## Requirements

- Node.js 22 or newer
- A Cloudflare account
- R2 enabled on that account

Cloudflare may require a one-time R2 subscription checkout. The agent can perform the rest of setup, but it cannot accept that checkout or complete browser authentication for you.

## Install

Until the package is published to npm, install the public GitHub repository:

```bash
npm install --global github:Tyler-Petrov/page-drop
```

After an npm release, the shorter form will be:

```bash
npm install --global page-drop
```

Install the optional skill for all harnesses that use the shared agent skill store:

```bash
pagedrop skill install
```

That command copies only the packaged skill to `~/.agents/skills/page-drop`. It does not copy the CLI, dependencies, config, or credentials. Override the shared directory with `--target <skills-dir>` or `PAGE_DROP_SKILLS_DIR`.

## First-Time Setup

Start Cloudflare's browser login:

```bash
pagedrop login
```

For a remote shell, use `pagedrop login --device`. Page Drop proxies its pinned Wrangler dependency with keyring storage enabled.

Create or reuse the `page-drop` bucket, enable its public `r2.dev` address, and save non-secret config:

```bash
pagedrop setup
```

If the Cloudflare login has more than one account, choose one explicitly:

```bash
pagedrop setup --account ACCOUNT_ID
```

You can also choose a bucket, jurisdiction, or an already-connected custom public URL:

```bash
pagedrop setup \
  --bucket my-public-files \
  --jurisdiction eu \
  --public-base-url https://files.example.com
```

Config is written to `$XDG_CONFIG_HOME/pagedrop/config.json`, `%APPDATA%/pagedrop/config.json` on Windows, or `~/.config/pagedrop/config.json`. Set `PAGE_DROP_CONFIG` to override it.

Check both authentication and config without printing a token:

```bash
pagedrop status
pagedrop status --json
```

## Commands

| Command | What it does |
| --- | --- |
| `pagedrop login [--device]` | Opens Cloudflare OAuth through the packaged Wrangler and stores its refreshable session in the OS keyring. |
| `pagedrop setup` | Selects an account, creates or reuses a bucket, enables its `r2.dev` public address, and writes non-secret config. |
| `pagedrop status [--json]` | Reports whether Wrangler is authenticated and Page Drop is configured. |
| `pagedrop publish <html\|-> [key] [--key <key>]` | Uploads HTML from a file or stdin with an HTML content type. |
| `pagedrop put <file\|-> [key] [--key <key>]` | Uploads any single file and infers its MIME type. Use `--content-type` for stdin or an override. |
| `pagedrop list [--json]` | Lists remote object keys, sizes, and public URLs. |
| `pagedrop get <key> [--output <file>]` | Downloads a remote object to stdout or writes the requested output file. |
| `pagedrop inspect <key> [--match <text>]` | Reads remote text and optionally prints only matching lines with context. |
| `pagedrop update <key> --edits <file\|->` | Applies checked structured edits in memory and uploads only if every edit succeeds. |
| `pagedrop delete <key> --yes` | Permanently deletes one exact key. |
| `pagedrop skill install` | Installs or updates the packaged skill in the shared cross-agent skill directory. |
| `pagedrop logout --yes` | Logs out the shared Wrangler session; other Wrangler-based tools are affected too. |

`pagedrop page.html pages/example.html` remains a shorthand for `pagedrop publish page.html --key pages/example.html`.

Keys may contain path-like slashes. When no key is supplied, Page Drop creates a random 128-bit name and preserves the source extension.

## Updating Without A Local Checkout

Inspect a relevant section:

```bash
pagedrop inspect pages/example.html --match "Pricing" --context 3
```

Apply exact text operations from stdin:

```bash
printf '%s' '[
  {"op":"replace","old":"Starter — $10","value":"Starter — $12"},
  {"op":"insert_after","old":"</main>","value":"<footer>Updated today</footer>"}
]' | pagedrop update pages/example.html --edits -
```

Supported operations:

- `replace`: replace one exact match
- `delete`: remove one exact match
- `insert_before` and `insert_after`: insert next to one exact match
- `replace_all`: replace every match

The single-target operations expect exactly one match. Add `expectedMatches` to any operation when another exact count is intentional. If a count is wrong, JSON is invalid, the remote ETag does not match `--if-etag`, or any operation fails, Page Drop uploads nothing.

`--if-etag` is a best-effort stale-version check. Page Drop compares it with the downloaded object before uploading, but Cloudflare's R2 management upload API does not provide an atomic conditional-write header. Another writer can still change the object between that check and the upload.

Preview the resulting patch:

```bash
pagedrop update pages/example.html --edits edits.json --dry-run
```

Structured updates work only for text content. Replace a binary file with `pagedrop put`.

## Safety

Every uploaded object is public through the configured base URL. Page Drop refuses common secret filenames such as `.env`, `credentials.json`, private keys, and certificate bundles. `--allow-sensitive` bypasses the check and should be used only when public exposure is intentional.

`r2.dev` is a rate-limited development URL. Use a custom domain for regular traffic.

## Development

```bash
npm install
npm test
npm run check
npm pack
```

Tests use a local fake Cloudflare API and fake Wrangler output. They do not read your Wrangler session or modify R2.
