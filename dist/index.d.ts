#!/usr/bin/env node
/**
 * wp-seo-mcp — WordPress SEO FAQ Schema MCP Server
 * =================================================
 * এই MCP server টি WordPress সাইটের posts থেকে FAQ schema generate করে
 * SEOPress Pro meta field-এ push করার জন্য তৈরি।
 *
 * Available Tools (MCP-এর মাধ্যমে Claude বা অন্য LLM এ expose হয়):
 * ─────────────────────────────────────────────────────────────────
 *   get_site_info          — সাইটের মোট post সংখ্যা, pagination info ও config জানুন
 *   get_posts              — paginated post list fetch করুন (FAQ status সহ)
 *   get_post               — একটি নির্দিষ্ট post-এর full content ও meta পড়ুন
 *   has_faq                — কোনো post-এ FAQ schema/block আছে কিনা detect করুন
 *   save_faq_schema        — SEOPress meta field-এ FAQ items লিখুন
 *   list_posts_needing_faq — FAQ নেই এমন posts-এর তালিকা বানান
 *   validate_schema        — live URL থেকে FAQPage JSON-LD আছে কিনা verify করুন
 *   save_progress          — batch processing-এর progress local file-এ save করুন
 *   get_progress           — saved progress load করে summary/report দেখুন
 *
 * Required Environment Variables:
 * ────────────────────────────────
 *   WP_SITE_URL        WordPress সাইটের URL  (e.g. https://example.com)
 *   WP_USERNAME        WordPress username
 *   WP_APP_PASSWORD    Application Password (Settings → Users → Application Passwords)
 *
 * Optional Environment Variables:
 * ────────────────────────────────
 *   SEOPRESS_META_KEY  FAQ store করার meta key (default: _seopress_pro_rich_snippets_faq)
 *   PROGRESS_FILE      Progress JSON file path (default: OS temp dir)
 */
export {};
//# sourceMappingURL=index.d.ts.map