# Page Drop

Page Drop is a small CLI for publishing public files to your own Cloudflare R2 bucket. It includes one optional agent skill for Codex, Claude Code, Cursor, OpenCode, and other harnesses that read the shared `~/.agents/skills` directory.

The CLI is the product. The skill teaches an agent how to use it.

Page Drop keeps no local copy of uploaded files. It authenticates with one Cloudflare API token read from your home directory `.env` or `.env.local`, and its config file contains only the Cloudflare account ID, bucket name, public URL, and jurisdiction.

## Requirements

- Node.js 22 or newer
- A Cloudflare account
- R2 enabled on that account
- A Cloudflare API token with the **Workers R2 Storage: Edit** permission

Cloudflare may require a one-time R2 subscription checkout. The agent can perform the rest of setup, but it cannot accept that checkout or create the API token for you.

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

Create an API token at <https://dash.cloudflare.com/profile/api-tokens> with the **Workers R2 Storage: Edit** permission, then store it:

```bash
pagedrop login
```

That prompts for the token without echoing it and writes `PAGE_DROP_API_TOKEN=...` to `~/.env.local`, creating the file with `600` permissions. It rewrites only that one assignment and leaves every other line alone. Non-interactive alternatives:

```bash
pagedrop login --token "$CLOUDFLARE_API_TOKEN"   # visible to other processes and shell history
cat token.txt | pagedrop login
```

You can skip `pagedrop login` entirely and manage the file yourself.

Create or reuse the `page-drop` bucket, enable its public `r2.dev` address, and save non-secret config:

```bash
pagedrop setup
```

If the token can reach more than one account, choose one explicitly:

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

## Where The Token Comes From

Page Drop looks for `PAGE_DROP_API_TOKEN`, then `CLOUDFLARE_API_TOKEN`, in this order:

1. The process environment
2. `~/.env`
3. `~/.env.local`

Later sources win, so `~/.env.local` overrides `~/.env`, and an exported shell variable overrides both. Set `PAGE_DROP_ENV_FILE` to read one specific file instead of the two home-directory defaults. Page Drop reads only the keys it needs and never loads the rest of the file into its environment.

`PAGE_DROP_ACCOUNT_ID` or `CLOUDFLARE_ACCOUNT_ID` from the same sources supplies the default `--account` for `pagedrop setup`. A token scoped to a single account may not be allowed to list accounts; pass `--account <id>` in that case.

Keep the file private: `chmod 600 ~/.env.local`. `pagedrop status` warns when the file granting the token is readable by other users.

## Commands

| Command | What it does |
| --- | --- |
| `pagedrop login [--token <token>]` | Stores a Cloudflare API token as `PAGE_DROP_API_TOKEN` in `~/.env.local`. Prompts without echo, or reads the token from stdin. |
| `pagedrop setup` | Selects an account, creates or reuses a bucket, enables its `r2.dev` public address, and writes non-secret config. |
| `pagedrop status [--json]` | Reports which variable and file supplied the token, whether Cloudflare still accepts it, and whether Page Drop is configured. It never prints the token. |
| `pagedrop publish <file\|-> <key\|--random> [--replace]` | Uploads one file and infers its content type from the file's extension. Stdin is treated as HTML. |
| `pagedrop put <file\|-> <key\|--random> [--replace]` | Same as `publish`, except stdin requires `--content-type`. |
| `pagedrop list [--json]` | Lists remote object keys, sizes, and public URLs. |
| `pagedrop get <key> [--output <file>]` | Downloads a remote object to stdout or writes the requested output file. |
| `pagedrop inspect <key> [--match <text>]` | Reads remote text and optionally prints only matching lines with context. |
| `pagedrop update <key> --edits <file\|->` | Applies checked structured edits in memory and uploads only if every edit succeeds. |
| `pagedrop delete <key> --yes` | Permanently deletes one exact key. |
| `pagedrop skill install` | Installs or updates the packaged skill in the shared cross-agent skill directory. |
| `pagedrop logout --yes` | Removes the `PAGE_DROP_API_TOKEN` line from `~/.env` and `~/.env.local`. It does not revoke the token at Cloudflare. |

`pagedrop page.html pages/example` remains a shorthand for `pagedrop publish page.html --key pages/example`.

Every upload needs a key, and keys have no file extension. `pagedrop publish pricing.html pricing` is served at `https://<public-url>/pricing`; the stored Content-Type tells the browser it is HTML. A key ending in a recognized extension such as `.html` or `.pdf` is rejected with the extension-free name to use instead. Keys may contain path-like slashes.

Pass `--random` instead of a key for an unguessable 128-bit name when the link should stay unlisted. Uploading to a key that already exists fails unless you pass `--replace`.

## Updating Without A Local Checkout

Inspect a relevant section:

```bash
pagedrop inspect pages/example --match "Pricing" --context 3
```

Apply exact text operations from stdin:

```bash
printf '%s' '[
  {"op":"replace","old":"Starter — $10","value":"Starter — $12"},
  {"op":"insert_after","old":"</main>","value":"<footer>Updated today</footer>"}
]' | pagedrop update pages/example --edits -
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
pagedrop update pages/example --edits edits.json --dry-run
```

Structured updates work only for text content. Replace a binary file with `pagedrop put`.

## Safety

Every uploaded object is public through the configured base URL. Page Drop refuses common secret filenames such as `.env`, `credentials.json`, private keys, and certificate bundles, which includes the very file that holds your API token. `--allow-sensitive` bypasses the check and should be used only when public exposure is intentional.

`r2.dev` is a rate-limited development URL. Use a custom domain for regular traffic.

## Development

```bash
npm install
npm test
npm run check
npm pack
```

Tests use a local fake Cloudflare API and a temporary home directory. They never read your real token or modify R2.
