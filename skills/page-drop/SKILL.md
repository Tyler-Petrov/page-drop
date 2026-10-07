---
name: page-drop
description: Publish and manage standalone public files in the user's Cloudflare R2 bucket with the pagedrop CLI. Use when a user asks to publish, host, share, retrieve, list, update, or delete a standalone HTML page or other public file with Page Drop.
---

# Page Drop

Use `pagedrop` for standalone public objects. Do not use it for a directory, application deployment, build pipeline, or routed website.

## Check Setup

Run:

```bash
pagedrop status --json
```

If authentication is missing, ask the user to create a Cloudflare API token with the **Workers R2 Storage: Edit** permission at <https://dash.cloudflare.com/profile/api-tokens>, then have them store it themselves:

```bash
pagedrop login
```

That prompts without echoing and saves `PAGE_DROP_API_TOKEN` to the user's `~/.env.local`. Never ask the user to paste the token into the chat, and never pass one with `pagedrop login --token`; both would put the secret in the transcript or shell history. If the user keeps a token in `~/.env` or `~/.env.local` already, Page Drop picks it up with no further setup.

Then run `pagedrop setup`. If more than one Cloudflare account is available, show the choices from the error and pass the user's choice with `--account`. A token scoped to one account may be denied the account list; pass `--account <id>` in that case. Page Drop stores only non-secret account, bucket, and public URL settings in its own config.

## Publish

Every upload needs a key without a file extension; the URL is `<public-url>/<key>` and the stored content type tells browsers what it is. Publish a standalone HTML document with `publish`:

```bash
pagedrop publish page.html --key pages/example
```

Pipe generated HTML directly when a local working copy is unnecessary:

```bash
generate-html | pagedrop publish - --key pages/example
```

Any other file type works the same way; Page Drop infers its content type from the local file:

```bash
pagedrop publish report.pdf --key reports/report
```

Use `--random` instead of `--key` only when the user wants an unguessable URL. If the key already exists the upload fails; confirm with the user before retrying with `--replace`. Report the emitted URL. Never use `--allow-sensitive` unless the user explicitly confirms that the named secret-like file should become public.

## Inspect And Update Remote Text

Inspect only the relevant part of a remote text object:

```bash
pagedrop inspect pages/example --match "Pricing" --context 3
```

Use `update` to change remote text without keeping a local checkout. Supply a JSON array on stdin. Each operation checks its match count before anything is uploaded:

```bash
printf '%s' '[{"op":"replace","old":"Old heading","value":"New heading"}]' \
  | pagedrop update pages/example --edits -
```

Supported operations are `replace`, `replace_all`, `delete`, `insert_before`, and `insert_after`. `replace`, `delete`, and inserts require exactly one match by default. Set `expectedMatches` explicitly when another count is intentional. Use `--dry-run` to inspect the patch. `--if-etag` rejects an already-stale download, but it is not an atomic conditional write; another writer can still update the object between the check and upload.

Replace binary objects with `pagedrop put`; do not structurally edit them.

## Manage Objects

```bash
pagedrop list --json
pagedrop get pages/example
pagedrop get reports/report --output report.pdf
```

Before deletion, confirm the exact key with the user, then run:

```bash
pagedrop delete pages/example --yes
```
