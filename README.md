# wp-seo-mcp

WordPress SEO FAQ Schema MCP Server — scans WordPress posts for missing FAQ schema, generates FAQ items using Claude (or any LLM), and pushes them to SEOPress Pro via the REST API.

---

## What it does

- Fetches posts from the WordPress REST API
- Checks SEOPress Pro meta fields and post content for existing FAQ coverage
- Exposes tools to Claude so it can read post content and generate relevant FAQ items
- Saves generated FAQ items via the SEOPress Pro `schemas-manual` endpoint
- Validates FAQPage JSON-LD on the live public URL
- Persists batch processing progress to a local file — interrupted runs can be resumed

---

## Requirements

- Node.js 18+
- WordPress 5.6+ (REST API enabled)
- **SEOPress Pro** plugin installed and active
- WordPress Application Password

---

## Installation

```bash
git clone <repo-url>
cd wp-seo-mcp
npm install
npm run build
```

---

## Configuration

The server is configured entirely through **environment variables**.

### Required

| Variable | Description | Example |
|---|---|---|
| `WP_SITE_URL` | Your WordPress site URL | `https://example.com` |
| `WP_USERNAME` | WordPress username | `admin` |
| `WP_APP_PASSWORD` | Application Password | `abcd 1234 efgh 5678` |

### Optional

| Variable | Default | Description |
|---|---|---|
| `SEOPRESS_META_KEY` | `_seopress_pro_rich_snippets_faq` | Meta key used to store FAQ data |
| `PROGRESS_FILE` | OS temp directory | Path for the progress JSON file |

### How to create a WordPress Application Password

1. Go to WordPress Admin → **Users** → **Profile**
2. Scroll down to the **Application Passwords** section
3. Enter a name (e.g. "Claude MCP") and click **Add New Application Password**
4. Copy the generated password — spaces are fine, they work as-is

---

## Claude Desktop Setup

Add the following to your `claude_desktop_config.json`:

**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "wp-seo-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/wp-seo-mcp/dist/index.js"],
      "env": {
        "WP_SITE_URL": "https://your-site.com",
        "WP_USERNAME": "your-username",
        "WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

> **Note:** Use an absolute path in `args`. The `~/` shorthand will not work.

---

## Available Tools

### `get_site_info`
Returns an overview of the site — total post count, pagination info, and active meta key.

**Call this first** to understand the scale of the job before starting batch processing.

```
Parameters: (none)
```

**Example output:**
```json
{
  "total_posts": 247,
  "total_pages_at_20_per_page": 13,
  "total_pages_at_100_per_page": 3,
  "seopress_meta_key": "_seopress_pro_rich_snippets_faq",
  "progress_file": "/tmp/wp-seo-mcp-progress.json"
}
```

---

### `get_post`
Fetches the full plain-text content and existing FAQ data for a single post.

> **Always call this before generating FAQ items** so the output is grounded in the actual article.

```
Parameters:
  id  (number, required)  — WordPress post ID
```

**Example output:**
```json
{
  "id": 123,
  "title": "How to Grow Tomatoes",
  "url": "https://example.com/how-to-grow-tomatoes",
  "content_plain": "Tomatoes need full sun...",
  "existing_faq_schema": [],
  "faq_in_content": false,
  "needs_faq": true
}
```

---

### `get_posts`
Fetches a paginated list of posts, each with its FAQ status.

```
Parameters:
  page        (number)  — Page number, default 1
  per_page    (number)  — Posts per page, max 100, default 10
  category    (number)  — Filter by category ID (optional)
```

---

### `has_faq`
Checks whether a post already has FAQ coverage across three sources.

```
Parameters:
  id  (number, required)  — WordPress post ID
```

Sources checked:
1. Primary SEOPress meta key (`_seopress_pro_rich_snippets_faq`)
2. Legacy/alternate SEOPress meta key (`_seopress_pro_schemas`)
3. Gutenberg FAQ blocks and `[faq]` shortcodes in post content

---

### `save_faq_schema`
Saves FAQ items to SEOPress Pro via the `schemas-manual` endpoint.

```
Parameters:
  id              (number, required)   — WordPress post ID
  faq_items       (array, required)    — FAQ items, max 5
    question      (string)             — Question text (max 300 chars)
    answer        (string)             — Answer text (max 2000 chars)
  dry_run         (boolean)            — Preview without saving (default false)
  allow_overwrite (boolean)            — Replace existing FAQ schema (default false)
```

**Non-destructive by default:** If the post already has FAQ schema, the tool returns a `skipped` status and makes no changes. Pass `allow_overwrite: true` to force an update.

**dry_run example:**
```json
{
  "id": 123,
  "faq_items": [
    { "question": "When to plant tomatoes?", "answer": "Plant after the last frost..." }
  ],
  "dry_run": true
}
```

**Why the `schemas-manual` endpoint?**
Writing only to the standard WordPress `/posts/{id}` meta endpoint leaves the SEOPress `_seopress_pro_rich_snippets_type` field unset, so no FAQPage JSON-LD is output on the front end. Using SEOPress's own `schemas-manual` endpoint sets both the type and the FAQ data correctly.

---

### `list_posts_needing_faq`
Scans pages of posts and splits them into two lists: posts that need FAQ schema vs. posts that already have it.

```
Parameters:
  from_page   (number)   — Start page, default 1
  to_page     (number)   — End page inclusive (ignored when scan_all is true)
  per_page    (number)   — Posts per page, max 100, default 20
  scan_all    (boolean)  — Auto-detect total pages and scan all of them
  category    (number)   — Filter by category ID (optional)
```

Use `scan_all: true` to build a complete work queue for the entire site in one call.

---

### `validate_schema`
Fetches the live public URL of a post and checks whether a valid FAQPage JSON-LD schema is present.

```
Parameters:
  id  (number, required)  — WordPress post ID
```

Use this after `save_faq_schema` to confirm the schema is rendering correctly on the front end.

**Example output:**
```json
{
  "id": 123,
  "url": "https://example.com/how-to-grow-tomatoes",
  "valid": true,
  "faq_count_in_schema": 3,
  "result": "✅ FAQPage schema present"
}
```

---

### `save_progress`
Persists batch processing results to the local progress file for resumable runs.

```
Parameters:
  entries  (array, required)  — Report entries
    id          (number)
    title       (string)
    url         (string)
    status      (string)  — "added" | "skipped" | "failed"
    faq_count   (number)
    validation  (string)  — "valid" | "failed" | "not_checked" | "skipped"
    error       (string)  — optional, reason for failure
```

Entries are upserted by post ID — calling this again with the same ID updates the existing record.

---

### `get_progress`
Loads the saved progress file and returns a summary, ID lists, and a formatted text table.

```
Parameters: (none)
```

Use `failed_ids` from the output to resume an interrupted batch run.

---

## Recommended Workflow

### Single Post
```
1. get_post (id: 123)                    ← read the post content
2. [Claude generates FAQ items from content]
3. save_faq_schema (dry_run: true)        ← preview the payload
4. save_faq_schema                        ← save for real
5. validate_schema                        ← confirm it rendered
```

### Batch Processing (Full Site)
```
1. get_site_info                          ← understand the scale
2. list_posts_needing_faq (scan_all)      ← build the work queue
3. For each post in needing_faq:
   a. get_post (id)                       ← read the content
   b. [Claude generates FAQ items]
   c. save_faq_schema                     ← save to SEOPress
   d. validate_schema                     ← verify on the live URL
   e. save_progress                       ← persist the result
4. get_progress                           ← generate the final report
```

### Resuming an Interrupted Run
```
1. get_progress                           ← check failed_ids
2. Reprocess the failed posts
3. save_progress (status: "added")        ← mark them complete
```

---

## Claude Prompt Examples

After connecting the MCP server in Claude Desktop:

```
Scan all posts on my WordPress site. For every post that is missing FAQ schema,
read the article content, generate 3–5 relevant FAQ items, and save them to
SEOPress. After each save, validate the schema and save the progress.
```

For a single post:

```
Read post ID 456 and generate 3 FAQ items based on the article content.
Show me a dry_run preview before saving anything.
```

---

## Security

- **Use an Application Password** — never your regular WordPress login password
- Never hardcode `WP_APP_PASSWORD` in source code; always pass it via environment variable
- The server only makes requests to the configured `WP_SITE_URL`
- `PROGRESS_FILE` path is validated with `path.resolve()` — path traversal attacks (`../../../etc/passwd`) are blocked
- FAQ question length is capped at 300 chars and answer at 2000 chars — prevents oversized payloads
- All HTTP requests have a **30-second timeout** — prevents hanging connections
- `allow_overwrite` defaults to `false` — existing FAQ schema is never accidentally overwritten
- The `Authorization` header is never printed to logs or stdout

---

## Troubleshooting

**"REST API not accessible"**
Go to WordPress Admin → Settings → Permalinks and click Save. This re-registers the REST API routes.

**"SEOPress API error 404"**
Verify that the SEOPress Pro plugin is installed and active, and that `WP_SITE_URL` is correct.

**"validate_schema returns false after save"**
- Clear your WordPress page cache (WP Rocket, W3 Total Cache, etc.)
- Check that Rich Snippets are enabled in SEOPress settings
- Wait a few minutes for CDN caches to expire, then retry

**"WP_USERNAME and WP_APP_PASSWORD must all be set"**
Verify that the `env` block in your MCP config is set correctly and the server has been restarted.

---

## Development

```bash
npm install      # install dependencies
npm run build    # compile TypeScript to dist/
npm run dev      # run directly with ts-node (for testing)
```

Compiled output: `dist/index.js`

---

## License

MIT
