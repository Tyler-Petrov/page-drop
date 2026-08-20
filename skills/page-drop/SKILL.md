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

If authentication is missing, ask the user to complete the browser step started by:

```bash
pagedrop login
```

Then run `pagedrop setup`. If more than one Cloudflare account is available, show the choices from the error and pass the user's choice with `--account`. Do not request or create an R2 access key. Wrangler owns and refreshes the OAuth session; Page Drop stores only non-secret account, bucket, and public URL settings.

## Publish

Publish a standalone HTML document with `publish`:

```bash
pagedrop publish page.html --key pages/example.html
```

Pipe generated HTML directly when a local working copy is unnecessary:

```bash
generate-html | pagedrop publish - --key pages/example.html
```

Upload another file type with `put`; Page Drop infers its content type:

```bash
pagedrop put report.pdf --key reports/report.pdf
```

Omit `--key` only when the user wants a new random URL. Report the emitted URL. Never use `--allow-sensitive` unless the user explicitly confirms that the named secret-like file should become public.

## Inspect And Update Remote Text

Inspect only the relevant part of a remote text object:

```bash
pagedrop inspect pages/example.html --match "Pricing" --context 3
```

Use `update` to change remote text without keeping a local checkout. Supply a JSON array on stdin. Each operation checks its match count before anything is uploaded:

```bash
printf '%s' '[{"op":"replace","old":"Old heading","value":"New heading"}]' \
  | pagedrop update pages/example.html --edits -
```

Supported operations are `replace`, `replace_all`, `delete`, `insert_before`, and `insert_after`. `replace`, `delete`, and inserts require exactly one match by default. Set `expectedMatches` explicitly when another count is intentional. Use `--dry-run` to inspect the patch. `--if-etag` rejects an already-stale download, but it is not an atomic conditional write; another writer can still update the object between the check and upload.

Replace binary objects with `pagedrop put`; do not structurally edit them.

## Manage Objects

```bash
pagedrop list --json
pagedrop get pages/example.html
pagedrop get reports/report.pdf --output report.pdf
```

Before deletion, confirm the exact key with the user, then run:

```bash
pagedrop delete pages/example.html --yes
```
