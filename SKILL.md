---
name: page-drop
description: Publish and manage standalone HTML pages with the pagedrop CLI. Use when a user asks to publish, host, share, update, retrieve, list, or delete a Page Drop webpage.
---

# Page Drop

Use `pagedrop` to publish standalone HTML files to Cloudflare R2 and return a public URL.

## Publish A Page

1. Ensure the page is a standalone HTML document. Inline its required CSS and JavaScript, and use absolute URLs or data URLs for required assets.
2. Choose a stable key when the page will be updated later. Keys must start with a lowercase letter or number, contain only lowercase letters, numbers, underscores, and hyphens, and be at most 64 characters long.
3. Publish the file:

```bash
pagedrop page.html --key page-key
```

Omit `--key` only when the user wants a new random URL:

```bash
pagedrop page.html
```

HTML can also be piped directly without creating a file:

```bash
generate-html | pagedrop - --key page-key
```

Report the `URL:` emitted by the command. Reusing a key replaces that page at the same URL.

## Manage Pages

```bash
pagedrop list
pagedrop get page-key
pagedrop get page-key --output page.html
pagedrop delete page-key
```

Confirm the target key with the user before deleting a page. Do not expose or modify Page Drop credentials unless the user explicitly asks to configure them.

## Troubleshooting

- Run `pagedrop --help` to confirm the command is installed.
- If credentials are missing, explain that Page Drop accepts `credentials.json` or the `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `PAGE_DROP_BASE_URL` environment variables.
- Never print secret values or commit `credentials.json`.
