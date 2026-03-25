# cloudflare-media-variant

Cloudflare Worker for public media delivery and on-demand image variants.

This project is built specifically for Cloudflare Workers. It serves original media files from R2 and generates image variants through Cloudflare Images bindings.

---

## Quick Start

```bash
npm install
npm run dev
```

Build check:

```bash
npm run build
```

Deploy:

```bash
npm run deploy
```

---

## What It Does

- Serves original media files from R2
- Generates image variants on demand from the same R2 object data
- Restricts public access to an allowlisted set of key prefixes
- Uses Cloudflare Cache API for both originals and variants
- Avoids raw-origin fetches and does not require a separate media origin URL

Examples:

```text
# original
https://media.example.com/originals/2026/03/1772981595.png

# resized variant
https://media.example.com/originals/2026/03/1772981595.png?w=400&h=300&fit=cover&format=webp&q=85

# imported WordPress asset
https://media.example.com/imported/2018/09/ap2.png?w=400&format=webp
```

---

## Runtime Model

Request flow:

```text
Client -> cloudflare-media-variant Worker -> R2 / Images binding
```

Behavior:

- `GET` and `HEAD` are supported
- Requests outside the configured path allowlist return `404`
- Requests without resize params return the original object from R2
- Requests with resize params are allowed only for image files
- Resize requests for non-image files return `400`

---

## Configuration

Required bindings and vars:

| Name | Type | Description |
| --- | --- | --- |
| `MEDIA_BUCKET` | R2 binding | Bucket that stores the public media objects |
| `IMAGES` | Images binding | Cloudflare Images binding used for on-demand transformations |
| `ALLOWED_PREFIXES` | env var | CSV allowlist of public key prefixes, e.g. `originals/,imported/` |

Optional vars:

| Name | Type | Description | Default |
| --- | --- | --- | --- |
| `DEBUG_LOGS_ENABLED` | env var | Enables lightweight request logging | `false` |
| `DISABLE_CACHE` | env var | Bypasses Cache API for debugging | `false` |

Recommended `ALLOWED_PREFIXES` value:

```text
originals/,imported/
```

---

## Query Parameters

Supported resize parameters:

| Param | Type | Allowed Values | Description |
| --- | --- | --- | --- |
| `w` | integer | `1..4096` | Target width |
| `h` | integer | `1..4096` | Target height |
| `fit` | string | `contain`, `cover`, `scale-down` | Resize fit behavior |
| `format` | string | `auto`, `webp`, `avif`, `png`, `jpeg` | Output format |
| `q` | integer | `1..100` | Output quality |

Rules:

- If both `w` and `h` are missing, the request is treated as original passthrough
- If only one dimension is provided, aspect ratio is preserved
- Unsupported or malformed resize values return `400`
- Unknown query parameters are not part of the public contract
- `format=auto` prefers `avif`, then `webp`, then falls back to the source-compatible format

---

## Allowed Path Policy

This Worker does not expose the full bucket by default.

Only object keys that start with one of the configured prefixes are publicly accessible.

Example:

```text
ALLOWED_PREFIXES=originals/,imported/
```

That allows:

```text
/originals/2026/03/file.png
/imported/2018/09/ap2.png
```

And blocks:

```text
/private/secret.png
/tmp/debug/file.png
```

---

## Cache Behavior

- Originals and variants are cached at the edge
- Cache keys are normalized from the request URL
- Only supported resize query parameters are included in variant cache keys
- `format=auto` uses `Accept`-aware cache variation internally
- `DISABLE_CACHE=true` disables Cache API usage for local debugging and troubleshooting

---

## Local Development

Recommended development flow:

- keep `MEDIA_BUCKET` configured with `remote = true`
- run `npm run dev` for fast local iteration against the real R2 bucket
- use `wrangler dev --remote` as the final parity check

Why:

- original object access works well with local Worker execution plus remote R2
- Cloudflare Images behavior is still best verified with `wrangler dev --remote`

---

## Project Structure

```text
cloudflare-media-variant/
├── src/
│   └── index.ts
├── package.json
├── tsconfig.json
├── wrangler.toml
└── README.md
```

The package is intentionally small:

- one Worker entrypoint
- no database
- no auth
- no KV or Durable Objects

---

## Limitations

- Cloudflare Workers only
- Depends on Cloudflare Images bindings and R2 bindings
- Not intended for Node.js, Lambda, or generic serverless runtimes
- `same_domain` media delivery is out of scope for this package

---

## License

MIT
