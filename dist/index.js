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
import { readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, normalize } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from "@modelcontextprotocol/sdk/types.js";
// ─── Security Constants ───────────────────────────────────────────────────────
// FAQ item-এর question ও answer-এর সর্বোচ্চ character সীমা।
// এটি oversized payload WP REST API তে push হওয়া থেকে রক্ষা করে।
const MAX_QUESTION_LENGTH = 300;
const MAX_ANSWER_LENGTH = 2000;
// HTTP request-এর timeout (milliseconds)। এটি hanging connections থেকে রক্ষা করে।
const FETCH_TIMEOUT_MS = 30_000;
// ─── Config ───────────────────────────────────────────────────────────────────
// WP_SITE_URL থেকে trailing slash সরানো হচ্ছে যাতে URL double slash না হয়।
const WP_SITE_URL = (process.env.WP_SITE_URL ?? "").replace(/\/$/, "");
const WP_USERNAME = process.env.WP_USERNAME ?? "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD ?? "";
/**
 * SEOPress Pro FAQ এর primary meta key।
 * সাধারণত এটি _seopress_pro_rich_snippets_faq।
 * custom meta key ব্যবহার করলে env var দিয়ে override করুন।
 */
const SEOPRESS_META_KEY = process.env.SEOPRESS_META_KEY ?? "_seopress_pro_rich_snippets_faq";
/**
 * SEOPress-এর legacy/alternate meta key।
 * পুরনো SEOPress version-এ FAQ _seopress_pro_schemas key-তে store হত।
 * has_faq detection-এ উভয় key check করা হয়।
 */
const SEOPRESS_META_KEY_ALT = "_seopress_pro_schemas";
/**
 * Progress file এর path নির্ধারণ।
 * Security: path টি validate করা হচ্ছে যাতে arbitrary file write না হয়।
 * PROGRESS_FILE env var set না থাকলে OS-এর temp directory ব্যবহার হয়।
 */
const RAW_PROGRESS_FILE = process.env.PROGRESS_FILE ?? join(tmpdir(), "wp-seo-mcp-progress.json");
/**
 * SSRF/path-traversal সুরক্ষা: resolve করে absolute path বানানো হচ্ছে।
 * path.normalize দিয়ে "../../../etc/passwd" style traversal ব্লক করা হচ্ছে।
 */
const PROGRESS_FILE = resolve(normalize(RAW_PROGRESS_FILE));
// Required env var validation — যেকোনো একটি missing থাকলে server শুরুই হবে না।
if (!WP_SITE_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
    process.stderr.write("[wp-seo-mcp] ERROR: WP_SITE_URL, WP_USERNAME, এবং WP_APP_PASSWORD অবশ্যই set করতে হবে।\n");
    process.exit(1);
}
// WP REST API v2 এর base URL
const API_BASE = `${WP_SITE_URL}/wp-json/wp/v2`;
// SEOPress Pro REST API এর base URL (FAQ schema push করার জন্য)
const SEOPRESS_API_BASE = `${WP_SITE_URL}/wp-json/seopress/v1`;
/**
 * HTTP Basic Auth header।
 * WordPress Application Password ব্যবহার করা হচ্ছে (regular password নয়)।
 * Security: এটি module-level constant হলেও runtime memory-তেই থাকে,
 * log বা console-এ print হয় না।
 */
const AUTH_HEADER = "Basic " + Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");
// ─── Security Helpers ─────────────────────────────────────────────────────────
/**
 * post id টি valid positive integer কিনা validate করে।
 *
 * Security: id সরাসরি URL path-এ যায় (e.g. /posts/123)।
 * Non-integer বা negative value দিলে URL injection সম্ভব।
 * এই function দিয়ে সেটি রোধ করা হচ্ছে।
 *
 * @throws McpError যদি id valid না হয়
 */
function validatePostId(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) {
        throw new McpError(ErrorCode.InvalidParams, `id must be a positive integer, got: ${JSON.stringify(id)}`);
    }
    return n;
}
/**
 * FAQ item-এর question ও answer sanitize ও validate করে।
 *
 * Security checks:
 *  1. question ও answer অবশ্যই non-empty string হতে হবে।
 *  2. MAX_QUESTION_LENGTH ও MAX_ANSWER_LENGTH সীমার মধ্যে থাকতে হবে —
 *     oversized payload WP REST API বা DB-তে push হওয়া রোধ করে।
 *  3. HTML tags strip করা হচ্ছে না (SEOPress নিজেই sanitize করে),
 *     তবে null byte remove করা হচ্ছে।
 *
 * @throws McpError যদি কোনো item invalid হয়
 */
function validateFaqItem(item, index) {
    if (!item || typeof item !== "object") {
        throw new McpError(ErrorCode.InvalidParams, `faq_items[${index}] must be an object`);
    }
    const { question, answer } = item;
    if (typeof question !== "string" || question.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, `faq_items[${index}].question must be a non-empty string`);
    }
    if (typeof answer !== "string" || answer.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, `faq_items[${index}].answer must be a non-empty string`);
    }
    if (question.length > MAX_QUESTION_LENGTH) {
        throw new McpError(ErrorCode.InvalidParams, `faq_items[${index}].question exceeds ${MAX_QUESTION_LENGTH} characters`);
    }
    if (answer.length > MAX_ANSWER_LENGTH) {
        throw new McpError(ErrorCode.InvalidParams, `faq_items[${index}].answer exceeds ${MAX_ANSWER_LENGTH} characters`);
    }
    // Null byte removal — DB/string processing issues এড়াতে
    return {
        question: question.replace(/\0/g, "").trim(),
        answer: answer.replace(/\0/g, "").trim(),
    };
}
/**
 * একটি AbortController তৈরি করে নির্দিষ্ট timeout-এ abort করার signal দেয়।
 *
 * Security/Reliability: FETCH_TIMEOUT_MS পরে request abort হয়।
 * এটি slow/hanging external connections থেকে server-কে রক্ষা করে।
 */
function fetchWithTimeout(ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return {
        signal: controller.signal,
        clear: () => clearTimeout(timer),
    };
}
// ─── WordPress API Helpers ────────────────────────────────────────────────────
/**
 * Authenticated WordPress REST API call করে JSON response parse করে ফেরত দেয়।
 *
 * path শুরু "http" দিয়ে হলে absolute URL হিসেবে ব্যবহার হয়,
 * অন্যথায় API_BASE (wp-json/wp/v2) এর সাথে যুক্ত হয়।
 *
 * Timeout: FETCH_TIMEOUT_MS পরে McpError throw হবে।
 * Error handling: non-2xx response-এ body সহ McpError throw হয়।
 *
 * @param path   API path (e.g. "/posts/123") অথবা full URL
 * @param options fetch RequestInit (method, body, extra headers ইত্যাদি)
 * @returns parsed JSON response
 * @throws McpError HTTP error বা timeout-এ
 */
async function wpFetch(path, options = {}) {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const { signal, clear } = fetchWithTimeout(FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            ...options,
            signal,
            headers: {
                "Content-Type": "application/json",
                Authorization: AUTH_HEADER,
                ...(options.headers ?? {}),
            },
        });
        if (!res.ok) {
            // Error body-ও capture করা হচ্ছে debugging-এর জন্য
            const body = await res.text().catch(() => "");
            throw new McpError(ErrorCode.InternalError, `WordPress API error ${res.status} for ${url}: ${body}`);
        }
        return res.json();
    }
    catch (err) {
        if (err instanceof McpError)
            throw err;
        // AbortError মানে timeout হয়েছে
        const msg = err instanceof Error ? err.message : String(err);
        throw new McpError(ErrorCode.InternalError, `Request failed for ${url}: ${msg}`);
    }
    finally {
        // Timer clear করা না হলে process hang করবে
        clear();
    }
}
/**
 * Paginated WordPress REST API endpoint fetch করে।
 * Pagination metadata (X-WP-Total, X-WP-TotalPages headers) সহ data ফেরত দেয়।
 *
 * এই headers WordPress REST API-তে paginated list endpoints-এ থাকে।
 * এটি wpFetch থেকে আলাদা কারণ header পড়ার জন্য raw Response দরকার।
 *
 * @returns { data, total, totalPages } — data হলো parsed JSON array,
 *          total মোট posts সংখ্যা, totalPages মোট page সংখ্যা
 */
async function wpFetchPaged(path) {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const { signal, clear } = fetchWithTimeout(FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal,
            headers: {
                "Content-Type": "application/json",
                Authorization: AUTH_HEADER,
            },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new McpError(ErrorCode.InternalError, `WordPress API error ${res.status} for ${url}: ${body}`);
        }
        // WordPress pagination headers parse করা হচ্ছে
        const total = parseInt(res.headers.get("X-WP-Total") ?? "0", 10);
        const totalPages = parseInt(res.headers.get("X-WP-TotalPages") ?? "0", 10);
        const data = await res.json();
        return { data, total, totalPages };
    }
    catch (err) {
        if (err instanceof McpError)
            throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new McpError(ErrorCode.InternalError, `Request failed for ${url}: ${msg}`);
    }
    finally {
        clear();
    }
}
// ─── Content Parsing Helpers ──────────────────────────────────────────────────
/**
 * HTML string থেকে সব tags strip করে plain text বানায়।
 * Common HTML entities decode করা হয় (nbsp, amp, lt, gt, quot, numeric)।
 * Multiple whitespace collapse করা হয়।
 *
 * এটি post content Claude-কে পড়ার উপযোগী করে তোলার জন্য ব্যবহৃত হয়।
 */
function stripHtml(html) {
    return html
        .replace(/<[^>]+>/g, " ") // সব HTML tags সরানো
        .replace(/&nbsp;/g, " ") // non-breaking space → space
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))) // numeric entities
        .replace(/\s{2,}/g, " ") // multiple spaces → single space
        .trim();
}
/**
 * SEOPress meta field থেকে raw value (string অথবা array) parse করে
 * validated FaqItem[] array ফেরত দেয়।
 *
 * SEOPress দুটি format-এ FAQ store করতে পারে:
 *  - JSON string:  "[{\"question\":\"...\",\"answer\":\"...\"}]"
 *  - Array object: [{question: "...", answer: "..."}]
 *
 * Invalid বা empty value হলে empty array ফেরত দেয় (throw করে না)।
 */
function parseSeoPressFaq(raw) {
    if (!raw)
        return [];
    try {
        // string হলে JSON parse করো, array হলে সরাসরি ব্যবহার করো
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed))
            return [];
        // শুধু valid FaqItem object গুলো রাখা হচ্ছে
        return parsed.filter((item) => typeof item === "object" &&
            item !== null &&
            typeof item.question === "string" &&
            typeof item.answer === "string" &&
            item.question.trim().length > 0);
    }
    catch {
        // Malformed JSON বা unexpected type → empty array
        return [];
    }
}
/**
 * Post HTML content-এ FAQ block বা shortcode আছে কিনা detect করে।
 *
 * Check করা হয়:
 *  - Gutenberg Yoast FAQ block comment marker
 *  - Gutenberg Rank Math FAQ block
 *  - Gutenberg SEOPress FAQ block
 *  - schema-faq CSS class (classic editor plugins)
 *  - Yoast FAQ block wrapper class
 *  - [faq] shortcode
 *  - Inline FAQPage JSON-LD (বিরল কিন্তু সম্ভব)
 *
 * Case-insensitive matching করা হয় (toLowerCase ব্যবহার করে)।
 */
function hasFaqInContent(html) {
    if (!html)
        return false;
    const lower = html.toLowerCase();
    return (lower.includes("wp:yoast/faq-block") ||
        lower.includes("wp:rank-math/faq-block") ||
        lower.includes("wp:seopress/faq") ||
        lower.includes('class="schema-faq') ||
        lower.includes('class="wp-block-yoast-faq') ||
        lower.includes("[faq]") ||
        (lower.includes('"@type"') && lower.includes("faqpage")));
}
/**
 * HTML page থেকে সব application/ld+json script blocks extract করে
 * parsed JavaScript object হিসেবে ফেরত দেয়।
 *
 * JSON-LD schema validation-এর জন্য ব্যবহৃত হয় (toolValidateSchema)।
 * Malformed JSON blocks silently skip করা হয়।
 */
function extractJsonLd(html) {
    const results = [];
    // type="application/ld+json" সহ script tags match করার regex
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
        try {
            results.push(JSON.parse(match[1]));
        }
        catch {
            // Malformed JSON-LD block — skip করা হচ্ছে
        }
    }
    return results;
}
/**
 * JSON-LD object list-এ FAQPage type আছে কিনা খোঁজে।
 *
 * দুটি pattern check করা হয়:
 *  1. Direct: { "@type": "FAQPage", ... }
 *  2. Graph-wrapped: { "@graph": [{ "@type": "FAQPage" }] }
 *
 * Google সাধারণত @graph pattern ব্যবহার করে,
 * plugin গুলো direct pattern ব্যবহার করতে পারে।
 */
function findFaqPage(jsonLdList) {
    for (const item of jsonLdList) {
        if (!item || typeof item !== "object")
            continue;
        const obj = item;
        // Pattern 1: সরাসরি FAQPage type
        if (obj["@type"] === "FAQPage")
            return true;
        // Pattern 2: @graph array-এর মধ্যে FAQPage node
        if (Array.isArray(obj["@graph"])) {
            for (const node of obj["@graph"]) {
                if (node &&
                    typeof node === "object" &&
                    node["@type"] === "FAQPage") {
                    return true;
                }
            }
        }
    }
    return false;
}
// ─── Progress File Helpers ────────────────────────────────────────────────────
/**
 * PROGRESS_FILE থেকে saved progress পড়ে।
 * File না থাকলে বা parse error হলে empty/fresh Progress object ফেরত দেয়।
 * Error throw করা হয় না — batch run resume করার ক্ষেত্রে resilient থাকা দরকার।
 */
function readProgress() {
    if (!existsSync(PROGRESS_FILE)) {
        return {
            completed_ids: [],
            skipped_ids: [],
            failed_ids: [],
            report: [],
            last_updated: "",
        };
    }
    try {
        return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
    }
    catch {
        // Corrupted file → fresh start
        return {
            completed_ids: [],
            skipped_ids: [],
            failed_ids: [],
            report: [],
            last_updated: "",
        };
    }
}
/**
 * Progress object PROGRESS_FILE-এ JSON format-এ লেখে।
 * last_updated timestamp automatically set হয়।
 * writeFileSync synchronous — atomic write নয়, কিন্তু MCP server single-threaded।
 */
function writeProgress(progress) {
    progress.last_updated = new Date().toISOString();
    writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf-8");
}
// ─── SEOPress Format Helpers ──────────────────────────────────────────────────
/**
 * FaqItem array কে SEOPress Pro-এর internal storage format-এ convert করে।
 *
 * SEOPress Pro FAQ data integer-keyed object হিসেবে store করে:
 *   { "0": { question: "...", answer: "..." }, "1": {...}, ... }
 *
 * Array index → string key conversion করা হচ্ছে।
 */
function faqItemsToSeoPressObject(items) {
    return Object.fromEntries(items.map((item, i) => [String(i), item]));
}
/**
 * Valid FAQPage JSON-LD object build করে (preview/reference-এর জন্য)।
 *
 * Schema.org FAQPage format:
 *  - @context: https://schema.org
 *  - @type: FAQPage
 *  - mainEntity: Question array (প্রতিটিতে name ও acceptedAnswer)
 *
 * এটি dry_run mode-এ preview হিসেবে ব্যবহৃত হয়।
 * Actual saving-এ SEOPress নিজেই এই format generate করে।
 */
function buildFaqPageJsonLd(items) {
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: items.map((item) => ({
            "@type": "Question",
            name: item.question,
            acceptedAnswer: {
                "@type": "Answer",
                text: item.answer,
            },
        })),
    };
}
// ─── Tool Implementations ─────────────────────────────────────────────────────
/**
 * [Tool: get_site_info]
 *
 * WordPress সাইটের overview জানার জন্য প্রথমে এই tool call করুন।
 *
 * Return করে:
 *  - total_posts: সাইটের মোট published post সংখ্যা
 *  - total_pages_at_20_per_page: 20/page rate-এ মোট page সংখ্যা
 *  - total_pages_at_100_per_page: 100/page rate-এ মোট page সংখ্যা
 *  - seopress_meta_key: active FAQ meta key (config থেকে)
 *  - progress_file: progress save হওয়ার file path
 *
 * Implementation: /posts?per_page=1 call করে শুধু header থেকে total count নেওয়া হয়।
 * এটি efficient — পুরো post list load করা হয় না।
 */
async function toolGetSiteInfo() {
    const { total } = await wpFetchPaged(`/posts?per_page=1&_fields=id`);
    return JSON.stringify({
        total_posts: total,
        total_pages_at_20_per_page: Math.ceil(total / 20),
        total_pages_at_100_per_page: Math.ceil(total / 100),
        seopress_meta_key: SEOPRESS_META_KEY,
        progress_file: PROGRESS_FILE,
    }, null, 2);
}
/**
 * [Tool: get_posts]
 *
 * Paginated post list fetch করে। প্রতিটি post-এর জন্য:
 *  - id, title, url
 *  - content_preview (200 chars plain text)
 *  - has_faq_schema: SEOPress meta-তে FAQ আছে কিনা
 *  - has_faq_in_content: post body-তে FAQ block আছে কিনা
 *  - needs_faq: উপরের দুটোর কোনোটাই নেই কিনা
 *
 * browsing বা spot-check-এর জন্য ব্যবহার করুন।
 * Batch queue বানাতে list_posts_needing_faq ব্যবহার করুন।
 *
 * Security: per_page সর্বোচ্চ 100-এ cap করা আছে।
 */
async function toolGetPosts(args) {
    const page = args.page ?? 1;
    // per_page সর্বোচ্চ 100 — WordPress REST API limit
    const perPage = Math.min(args.per_page ?? 10, 100);
    const qs = new URLSearchParams({
        page: String(page),
        per_page: String(perPage),
        // শুধু দরকারী fields request করা হচ্ছে — bandwidth ও memory বাঁচায়
        _fields: "id,title,link,content,meta",
    });
    if (args.category)
        qs.set("categories", String(args.category));
    const { data, total, totalPages } = await wpFetchPaged(`/posts?${qs}`);
    const posts = data;
    // প্রতিটি post-এর FAQ status check করে summary বানানো হচ্ছে
    const summary = posts.map((p) => {
        const faqFromMeta = parseSeoPressFaq(p.meta?.[SEOPRESS_META_KEY]).length > 0 ||
            parseSeoPressFaq(p.meta?.[SEOPRESS_META_KEY_ALT]).length > 0;
        const faqInContent = hasFaqInContent(p.content?.rendered ?? "");
        return {
            id: p.id,
            title: p.title.rendered,
            url: p.link,
            content_preview: stripHtml(p.content.rendered).slice(0, 200) + "…",
            has_faq_schema: faqFromMeta,
            has_faq_in_content: faqInContent,
            needs_faq: !faqFromMeta && !faqInContent,
        };
    });
    return JSON.stringify({ page, per_page: perPage, total_posts: total, total_pages: totalPages, count: posts.length, posts: summary }, null, 2);
}
/**
 * [Tool: get_post]
 *
 * একটি নির্দিষ্ট post-এর full details fetch করে।
 *
 * Return করে:
 *  - id, title, url
 *  - content_plain: HTML stripped plain text (Claude পড়তে পারবে)
 *  - existing_faq_schema: SEOPress-এ save করা FAQ items (যদি থাকে)
 *  - faq_in_content: content-এ FAQ block আছে কিনা
 *  - needs_faq: FAQ generate করা দরকার কিনা
 *
 * IMPORTANT: save_faq_schema call করার আগে সর্বদা এই tool দিয়ে
 * content পড়ুন, যাতে generated FAQ গুলো article-based হয়।
 *
 * Security: id validate করা হচ্ছে positive integer হিসেবে।
 */
async function toolGetPost(args) {
    const id = validatePostId(args.id);
    const post = (await wpFetch(`/posts/${id}?_fields=id,title,link,content,meta`));
    // Primary ও alternate meta key উভয়ই check করা হচ্ছে
    const faqMeta = parseSeoPressFaq(post.meta?.[SEOPRESS_META_KEY]);
    const faqMetaAlt = parseSeoPressFaq(post.meta?.[SEOPRESS_META_KEY_ALT]);
    // Primary key-এ data থাকলে সেটা, না থাকলে alternate key
    const existingFaq = faqMeta.length > 0 ? faqMeta : faqMetaAlt;
    const faqInContent = hasFaqInContent(post.content?.rendered ?? "");
    return JSON.stringify({
        id: post.id,
        title: post.title.rendered,
        url: post.link,
        content_plain: stripHtml(post.content.rendered),
        existing_faq_schema: existingFaq,
        faq_in_content: faqInContent,
        needs_faq: existingFaq.length === 0 && !faqInContent,
    }, null, 2);
}
/**
 * [Tool: has_faq]
 *
 * একটি post-এ FAQ coverage আছে কিনা তিনটি source check করে:
 *  1. Primary SEOPress meta key (_seopress_pro_rich_snippets_faq)
 *  2. Alternate/legacy SEOPress meta key (_seopress_pro_schemas)
 *  3. Post content-এ Gutenberg FAQ block বা shortcode
 *
 * Return করে:
 *  - has_faq: true/false (যেকোনো একটি source-এ থাকলে true)
 *  - sources: প্রতিটি source-এ কতটি item আছে
 *  - items: existing FAQ items (primary অথবা alternate key থেকে)
 *
 * Security: id validate করা হচ্ছে।
 */
async function toolHasFaq(args) {
    const id = validatePostId(args.id);
    const post = (await wpFetch(`/posts/${id}?_fields=id,title,link,content,meta`));
    const faqMeta = parseSeoPressFaq(post.meta?.[SEOPRESS_META_KEY]);
    const faqMetaAlt = parseSeoPressFaq(post.meta?.[SEOPRESS_META_KEY_ALT]);
    const faqInContent = hasFaqInContent(post.content?.rendered ?? "");
    const hasFaq = faqMeta.length > 0 || faqMetaAlt.length > 0 || faqInContent;
    return JSON.stringify({
        id: args.id,
        title: post.title.rendered,
        url: post.link,
        has_faq: hasFaq,
        sources: {
            [SEOPRESS_META_KEY]: faqMeta.length,
            [SEOPRESS_META_KEY_ALT]: faqMetaAlt.length,
            content_block: faqInContent,
        },
        // Primary key-এ data থাকলে সেটা, না থাকলে alternate
        items: faqMeta.length > 0 ? faqMeta : faqMetaAlt,
    });
}
/**
 * [Tool: save_faq_schema]
 *
 * FAQ items SEOPress Pro-এর schemas-manual endpoint দিয়ে save করে।
 *
 * Validation (save করার আগে):
 *  - faq_items non-empty array হতে হবে
 *  - সর্বোচ্চ 5 টি FAQ item (Google-এর best practice)
 *  - প্রতিটি item-এর question ও answer non-empty হতে হবে
 *  - question সর্বোচ্চ 300 chars, answer সর্বোচ্চ 2000 chars
 *
 * Safety Features:
 *  - allow_overwrite: false (default) — existing FAQ overwrite থেকে রক্ষা
 *  - dry_run: true — actual save ছাড়া payload preview করুন
 *
 * WHY schemas-manual endpoint?
 *  WordPress /posts/{id} endpoint-এ শুধু meta লিখলে SEOPress
 *  _seopress_pro_rich_snippets_type = "faq" set করে না।
 *  তাই front-end-এ JSON-LD output হয় না।
 *  SEOPress-এর own /seopress/v1/posts/{id}/schemas-manual endpoint
 *  ব্যবহার করলে type ও data উভয়ই correctly set হয়।
 *
 * Security: id validate করা হচ্ছে। FAQ content sanitized।
 */
async function toolSaveFaqSchema(args) {
    // Step 1: id validation
    const id = validatePostId(args.id);
    // Step 2: faq_items basic validation
    if (!Array.isArray(args.faq_items) || args.faq_items.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "faq_items must be a non-empty array");
    }
    if (args.faq_items.length > 5) {
        throw new McpError(ErrorCode.InvalidParams, "Maximum 5 FAQ items allowed per post");
    }
    // Step 3: প্রতিটি item sanitize ও validate করা হচ্ছে
    const validatedItems = args.faq_items.map((item, i) => validateFaqItem(item, i));
    // Step 4: Overwrite protection — existing FAQ থাকলে skip (allow_overwrite না হলে)
    if (!args.allow_overwrite) {
        const post = (await wpFetch(`/posts/${id}?_fields=id,meta,content`));
        const existingMeta = parseSeoPressFaq(post.meta?.[SEOPRESS_META_KEY]);
        const existingAlt = parseSeoPressFaq(post.meta?.[SEOPRESS_META_KEY_ALT]);
        const inContent = hasFaqInContent(post.content?.rendered ?? "");
        if (existingMeta.length > 0 || existingAlt.length > 0 || inContent) {
            return JSON.stringify({
                id,
                status: "skipped",
                reason: "Post already has FAQ schema. Pass allow_overwrite: true to force update.",
                existing_count: existingMeta.length || existingAlt.length,
            });
        }
    }
    // Step 5: dry_run mode — save না করে শুধু preview
    if (args.dry_run) {
        return JSON.stringify({
            id,
            dry_run: true,
            status: "would_save",
            endpoint: `PUT /seopress/v1/posts/${id}/schemas-manual`,
            faq_items: validatedItems,
            json_ld_preview: buildFaqPageJsonLd(validatedItems),
        });
    }
    // Step 6: SEOPress Pro schemas-manual endpoint-এ PUT request
    // এই endpoint _seopress_pro_rich_snippets_type = "faq" সহ পুরো schema save করে।
    const schemaPayload = {
        schemas: [
            {
                _seopress_pro_rich_snippets_type: "faq",
                _seopress_pro_rich_snippets_faq: faqItemsToSeoPressObject(validatedItems),
            },
        ],
    };
    const url = `${SEOPRESS_API_BASE}/posts/${id}/schemas-manual`;
    const { signal, clear } = fetchWithTimeout(FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "PUT",
            signal,
            headers: {
                "Content-Type": "application/json",
                Authorization: AUTH_HEADER,
            },
            body: JSON.stringify(schemaPayload),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new McpError(ErrorCode.InternalError, `SEOPress API error ${res.status} for ${url}: ${body}`);
        }
        const result = await res.json();
        if (result.code !== "success") {
            throw new McpError(ErrorCode.InternalError, `SEOPress schemas-manual returned unexpected response: ${JSON.stringify(result)}`);
        }
    }
    catch (err) {
        if (err instanceof McpError)
            throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new McpError(ErrorCode.InternalError, `Request failed for ${url}: ${msg}`);
    }
    finally {
        clear();
    }
    return JSON.stringify({
        id,
        status: "saved",
        endpoint: `PUT /seopress/v1/posts/${id}/schemas-manual`,
        faq_count: validatedItems.length,
        message: `FAQ schema with ${validatedItems.length} items saved to post ${id}`,
    });
}
/**
 * [Tool: list_posts_needing_faq]
 *
 * Post page গুলো scan করে FAQ নেই এমন posts-এর তালিকা তৈরি করে।
 *
 * দুটি mode:
 *  1. Range mode: from_page থেকে to_page পর্যন্ত scan করে
 *  2. scan_all: true — মোট page সংখ্যা auto-detect করে সব scan করে
 *
 * Return করে:
 *  - needing_faq: FAQ দরকার এমন posts (id, title, url)
 *  - already_has_faq: already covered posts
 *  - counts ও pages_scanned summary
 *
 * Use case: এই tool দিয়ে work queue বানিয়ে তারপর
 * প্রতিটি post-এ get_post → save_faq_schema করুন।
 *
 * Security: per_page সর্বোচ্চ 100-এ cap।
 */
async function toolListPostsNeedingFaq(args) {
    const perPage = Math.min(args.per_page ?? 20, 100);
    const fromPage = args.from_page ?? 1;
    let toPage = args.to_page ?? fromPage;
    // scan_all mode: প্রথম request থেকে মোট page সংখ্যা জানা যায়
    if (args.scan_all) {
        const firstQs = new URLSearchParams({
            page: String(fromPage),
            per_page: String(perPage),
            _fields: "id,title,link,content,meta",
        });
        if (args.category)
            firstQs.set("categories", String(args.category));
        const { totalPages } = await wpFetchPaged(`/posts?${firstQs}`);
        toPage = totalPages;
        process.stderr.write(`[wp-seo-mcp] scan_all: detected ${totalPages} total pages at ${perPage}/page\n`);
    }
    // needing_faq: FAQ generate করতে হবে এমন posts
    // skipped: আগে থেকেই FAQ আছে এমন posts
    const needing = [];
    const skipped = [];
    // প্রতিটি page scan করা হচ্ছে
    for (let page = fromPage; page <= toPage; page++) {
        const qs = new URLSearchParams({
            page: String(page),
            per_page: String(perPage),
            _fields: "id,title,link,content,meta",
        });
        if (args.category)
            qs.set("categories", String(args.category));
        let posts;
        try {
            const { data } = await wpFetchPaged(`/posts?${qs}`);
            posts = data;
        }
        catch {
            // Last page পার হলে বা network error হলে loop break
            break;
        }
        if (posts.length === 0)
            break;
        for (const p of posts) {
            const faqMeta = parseSeoPressFaq(p.meta?.[SEOPRESS_META_KEY]).length > 0 ||
                parseSeoPressFaq(p.meta?.[SEOPRESS_META_KEY_ALT]).length > 0;
            const faqContent = hasFaqInContent(p.content?.rendered ?? "");
            if (faqMeta || faqContent) {
                skipped.push({ id: p.id, title: p.title.rendered, url: p.link });
            }
            else {
                needing.push({ id: p.id, title: p.title.rendered, url: p.link });
            }
        }
        // Progress log — stderr-এ যায়, MCP stdout-এ না
        process.stderr.write(`[wp-seo-mcp] Scanned page ${page}/${toPage} — ${needing.length} need FAQ so far\n`);
    }
    return JSON.stringify({
        pages_scanned: toPage - fromPage + 1,
        total_scanned: needing.length + skipped.length,
        needing_faq_count: needing.length,
        already_has_faq_count: skipped.length,
        needing_faq: needing,
        already_has_faq: skipped,
    }, null, 2);
}
/**
 * [Tool: validate_schema]
 *
 * Post-এর live public URL fetch করে FAQPage JSON-LD schema আছে কিনা verify করে।
 *
 * Steps:
 *  1. WordPress API থেকে post-এর public URL জানা হয়
 *  2. Unauthenticated GET request — real visitor-এর মতো page দেখা হয়
 *  3. সব application/ld+json blocks extract করা হয়
 *  4. FAQPage type আছে কিনা check করা হয়
 *  5. mainEntity count করা হয় (FAQ item সংখ্যা)
 *
 * Use case: save_faq_schema-এর পরে এই tool দিয়ে confirm করুন
 * schema front-end-এ correctly render হচ্ছে কিনা।
 *
 * Security: id validate করা হচ্ছে। Live fetch-এ timeout আছে।
 * URL টি WordPress থেকে আসছে — তাই SSRF risk minimal
 * (আমরা already authenticated আছি ওই WP instance-এ)।
 */
async function toolValidateSchema(args) {
    const id = validatePostId(args.id);
    // Step 1: Post-এর public URL জানা
    const post = (await wpFetch(`/posts/${id}?_fields=id,title,link`));
    const liveUrl = post.link;
    if (!liveUrl) {
        return JSON.stringify({
            id,
            valid: false,
            error: "Post has no public URL (may be a draft or private post)",
        });
    }
    // Step 2: Live page fetch — unauthenticated (visitor হিসেবে)
    let html;
    const { signal, clear } = fetchWithTimeout(FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(liveUrl, {
            signal,
            headers: { "User-Agent": "wp-seo-mcp/1.0 (schema-validator)" },
        });
        if (!res.ok) {
            return JSON.stringify({
                id,
                url: liveUrl,
                valid: false,
                error: `HTTP ${res.status} when fetching ${liveUrl}`,
            });
        }
        html = await res.text();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
            id,
            url: liveUrl,
            valid: false,
            error: `Network error fetching ${liveUrl}: ${msg}`,
        });
    }
    finally {
        clear();
    }
    // Step 3 & 4: JSON-LD extract ও FAQPage detect
    const jsonLdList = extractJsonLd(html);
    const hasFaqPage = findFaqPage(jsonLdList);
    // Step 5: FAQPage পাওয়া গেলে Q&A pair count করা
    let faqCount = 0;
    if (hasFaqPage) {
        for (const item of jsonLdList) {
            if (!item || typeof item !== "object")
                continue;
            const obj = item;
            // Direct অথবা @graph-wrapped FAQPage node থেকে mainEntity count
            const nodes = obj["@type"] === "FAQPage"
                ? [obj]
                : Array.isArray(obj["@graph"])
                    ? obj["@graph"].filter((n) => n["@type"] === "FAQPage")
                    : [];
            for (const node of nodes) {
                if (Array.isArray(node["mainEntity"])) {
                    faqCount += node["mainEntity"].length;
                }
            }
        }
    }
    return JSON.stringify({
        id,
        title: post.title?.rendered ?? "",
        url: liveUrl,
        valid: hasFaqPage,
        faq_count_in_schema: faqCount,
        total_json_ld_blocks: jsonLdList.length,
        result: hasFaqPage ? "✅ FAQPage schema present" : "❌ FAQPage schema NOT found",
    }, null, 2);
}
/**
 * [Tool: save_progress]
 *
 * Batch processing-এর result গুলো PROGRESS_FILE-এ persist করে।
 * Interrupted run resume করার জন্য এই tool ব্যবহার করুন।
 *
 * Upsert logic (id দিয়ে):
 *  - নতুন entry হলে append করা হয়
 *  - existing entry হলে replace করা হয়
 *
 * ID sets management:
 *  - "added" → completed_ids
 *  - "skipped" → skipped_ids
 *  - "failed" → failed_ids (completed_ids থেকে remove)
 *
 * প্রতিটি entry-তে থাকা দরকার:
 *  id, title, url, status, faq_count, validation
 */
async function toolSaveProgress(args) {
    if (!Array.isArray(args.entries)) {
        throw new McpError(ErrorCode.InvalidParams, "entries must be an array");
    }
    const progress = readProgress();
    for (const entry of args.entries) {
        // Upsert: id already আছে কিনা check করে replace বা append
        const idx = progress.report.findIndex((r) => r.id === entry.id);
        if (idx >= 0) {
            progress.report[idx] = entry;
        }
        else {
            progress.report.push(entry);
        }
        // Status অনুযায়ী id sets update করা হচ্ছে
        if (entry.status === "added") {
            if (!progress.completed_ids.includes(entry.id))
                progress.completed_ids.push(entry.id);
            // completed হলে skipped/failed থেকে remove করো
            progress.skipped_ids = progress.skipped_ids.filter((id) => id !== entry.id);
            progress.failed_ids = progress.failed_ids.filter((id) => id !== entry.id);
        }
        else if (entry.status === "skipped") {
            if (!progress.skipped_ids.includes(entry.id))
                progress.skipped_ids.push(entry.id);
        }
        else if (entry.status === "failed") {
            if (!progress.failed_ids.includes(entry.id))
                progress.failed_ids.push(entry.id);
            // failed হলে completed থেকে remove করো
            progress.completed_ids = progress.completed_ids.filter((id) => id !== entry.id);
        }
    }
    writeProgress(progress);
    return JSON.stringify({
        status: "saved",
        progress_file: PROGRESS_FILE,
        total_entries: progress.report.length,
        completed: progress.completed_ids.length,
        skipped: progress.skipped_ids.length,
        failed: progress.failed_ids.length,
    });
}
/**
 * [Tool: get_progress]
 *
 * PROGRESS_FILE থেকে saved state load করে formatted report দেয়।
 *
 * Return করে:
 *  - summary: added/skipped/failed counts ও last_updated timestamp
 *  - completed_ids, skipped_ids, failed_ids: id arrays (resume করতে কাজে আসে)
 *  - report: full report entries array
 *  - table: human-readable text table (console output-এর জন্য)
 *
 * Use case:
 *  1. Interrupted batch resume করতে failed_ids দেখুন
 *  2. Final report generate করতে ব্যবহার করুন
 *  3. Coverage statistics জানতে ব্যবহার করুন
 */
async function toolGetProgress() {
    const progress = readProgress();
    // Status অনুযায়ী entries ভাগ করা হচ্ছে
    const added = progress.report.filter((r) => r.status === "added");
    const skipped = progress.report.filter((r) => r.status === "skipped");
    const failed = progress.report.filter((r) => r.status === "failed");
    // Human-readable text table তৈরি করা হচ্ছে
    const lines = [
        "",
        "=== WP SEO FAQ Schema — Progress Report ===",
        `Generated: ${new Date().toISOString()}`,
        `Progress file: ${PROGRESS_FILE}`,
        "",
        `✅ Added:   ${added.length}`,
        `⚠️  Skipped: ${skipped.length}`,
        `❌ Failed:  ${failed.length}`,
        `📊 Total:   ${progress.report.length}`,
        "",
        "─".repeat(100),
        padRow("Post Title", "URL", "Status", "FAQs", "Validation"),
        "─".repeat(100),
        ...progress.report.map((r) => padRow(r.title.slice(0, 40), r.url.slice(0, 35), r.status.toUpperCase(), String(r.faq_count), r.validation)),
        "─".repeat(100),
        "",
    ];
    return JSON.stringify({
        summary: {
            added: added.length,
            skipped: skipped.length,
            failed: failed.length,
            total: progress.report.length,
            last_updated: progress.last_updated,
        },
        completed_ids: progress.completed_ids,
        skipped_ids: progress.skipped_ids,
        failed_ids: progress.failed_ids,
        report: progress.report,
        table: lines.join("\n"),
    }, null, 2);
}
/**
 * Text table row তৈরি করার helper।
 * প্রতিটি column নির্দিষ্ট width-এ pad করা হয়।
 * Column widths: Title(42), URL(37), Status(10), FAQs(6), Validation(15)
 */
function padRow(...cols) {
    const widths = [42, 37, 10, 6, 15];
    return cols.map((c, i) => c.padEnd(widths[i] ?? 15)).join(" | ");
}
// ─── MCP Server Setup ─────────────────────────────────────────────────────────
/**
 * MCP Server instance।
 * name ও version MCP client-কে server identify করতে সাহায্য করে।
 * capabilities: { tools: {} } মানে এই server শুধু tools expose করে।
 */
const server = new Server({ name: "wp-seo-mcp", version: "2.0.0" }, { capabilities: { tools: {} } });
/**
 * ListTools handler — MCP client যখন available tools জানতে চায়।
 * প্রতিটি tool-এর name, description ও inputSchema define করা হয়েছে।
 * inputSchema JSON Schema format-এ — client validation ও UI generation-এর জন্য ব্যবহৃত।
 */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "get_site_info",
            description: "Return total post count, pagination info, active SEOPress meta key, and progress file path. Call this first to understand the scale of the job.",
            inputSchema: { type: "object", properties: {} },
        },
        {
            name: "get_posts",
            description: "Fetch a paginated list of WordPress posts. Each entry shows id, title, URL, content preview, whether it has an FAQ schema in SEOPress meta, whether the post content contains an FAQ block, and a 'needs_faq' boolean. Use this for browsing or spot-checks.",
            inputSchema: {
                type: "object",
                properties: {
                    page: { type: "number", description: "Page number (default 1)" },
                    per_page: { type: "number", description: "Posts per page, max 100 (default 10)" },
                    category: { type: "number", description: "Filter by category ID (optional)" },
                },
            },
        },
        {
            name: "get_post",
            description: "Fetch the full plain-text content, public URL, and existing FAQ schema for a single WordPress post by ID. Always call this before generating FAQ items so answers are grounded in the actual article.",
            inputSchema: {
                type: "object",
                properties: {
                    id: { type: "number", description: "WordPress post ID (positive integer)" },
                },
                required: ["id"],
            },
        },
        {
            name: "has_faq",
            description: "Detect whether a post already has FAQ coverage. Checks three sources: the primary SEOPress meta key, the legacy alt meta key, and Gutenberg/shortcode FAQ blocks in the post content. Returns has_faq (boolean), per-source counts, and any existing items.",
            inputSchema: {
                type: "object",
                properties: {
                    id: { type: "number", description: "WordPress post ID (positive integer)" },
                },
                required: ["id"],
            },
        },
        {
            name: "save_faq_schema",
            description: "Write an array of FAQ items (max 5, question ≤300 chars, answer ≤2000 chars) to the SEOPress meta field of a WordPress post via the schemas-manual endpoint. Will skip if the post already has FAQ schema, unless allow_overwrite is true. Use dry_run: true to preview the payload without saving.",
            inputSchema: {
                type: "object",
                properties: {
                    id: { type: "number", description: "WordPress post ID (positive integer)" },
                    faq_items: {
                        type: "array",
                        description: "Array of FAQ items — max 5",
                        items: {
                            type: "object",
                            properties: {
                                question: { type: "string", description: "Question text (max 300 chars)" },
                                answer: { type: "string", description: "Answer text (max 2000 chars)" },
                            },
                            required: ["question", "answer"],
                        },
                    },
                    dry_run: {
                        type: "boolean",
                        description: "Preview without saving (default false)",
                    },
                    allow_overwrite: {
                        type: "boolean",
                        description: "Allow replacing an existing FAQ schema (default false — non-destructive by default)",
                    },
                },
                required: ["id", "faq_items"],
            },
        },
        {
            name: "list_posts_needing_faq",
            description: "Scan one or more pages of posts and split them into two lists: posts that need an FAQ schema vs. posts that already have one. Set scan_all: true to automatically scan every page on the site and return a complete work queue. Use this to build the queue before starting batch processing.",
            inputSchema: {
                type: "object",
                properties: {
                    from_page: { type: "number", description: "Start page (default 1)" },
                    to_page: { type: "number", description: "End page inclusive (ignored when scan_all is true)" },
                    per_page: { type: "number", description: "Posts per page, max 100 (default 20)" },
                    scan_all: {
                        type: "boolean",
                        description: "If true, auto-detect total pages and scan all of them",
                    },
                    category: { type: "number", description: "Filter by category ID (optional)" },
                },
            },
        },
        {
            name: "validate_schema",
            description: "Fetch the live public URL of a post and check whether a valid FAQPage JSON-LD schema is present in the page source. Returns valid (boolean), faq_count_in_schema, and total JSON-LD blocks found. Use this after save_faq_schema to confirm the schema is rendering correctly.",
            inputSchema: {
                type: "object",
                properties: {
                    id: { type: "number", description: "WordPress post ID (positive integer)" },
                },
                required: ["id"],
            },
        },
        {
            name: "save_progress",
            description: "Persist one or more processing results to a local progress file, enabling resumable batch runs. Each entry requires id, title, url, status ('added'|'skipped'|'failed'), faq_count, and validation result. Duplicate entries are upserted by post id.",
            inputSchema: {
                type: "object",
                properties: {
                    entries: {
                        type: "array",
                        description: "Array of report entries to save",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "number" },
                                title: { type: "string" },
                                url: { type: "string" },
                                status: { type: "string", enum: ["added", "skipped", "failed"] },
                                faq_count: { type: "number" },
                                validation: {
                                    type: "string",
                                    enum: ["valid", "failed", "not_checked", "skipped"],
                                },
                                error: { type: "string" },
                            },
                            required: ["id", "title", "url", "status", "faq_count", "validation"],
                        },
                    },
                },
                required: ["entries"],
            },
        },
        {
            name: "get_progress",
            description: "Load and display the current processing state from the progress file. Returns a summary (added/skipped/failed counts), all post IDs by category, and a formatted text table of the full report. Use this to resume interrupted batch runs or generate the final report.",
            inputSchema: { type: "object", properties: {} },
        },
    ],
}));
/**
 * CallTool handler — MCP client যখন কোনো tool call করে।
 *
 * Pattern:
 *  1. tool name অনুযায়ী সঠিক implementation function call করা হয়
 *  2. result text content হিসেবে ফেরত দেওয়া হয়
 *  3. McpError গুলো re-throw করা হয় (MCP protocol মেনে চলার জন্য)
 *  4. অন্য errors McpError.InternalError-এ wrap করা হয়
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {});
    try {
        let result;
        switch (name) {
            case "get_site_info":
                result = await toolGetSiteInfo();
                break;
            case "get_posts":
                result = await toolGetPosts(a);
                break;
            case "get_post":
                result = await toolGetPost(a);
                break;
            case "has_faq":
                result = await toolHasFaq(a);
                break;
            case "save_faq_schema":
                result = await toolSaveFaqSchema(a);
                break;
            case "list_posts_needing_faq":
                result = await toolListPostsNeedingFaq(a);
                break;
            case "validate_schema":
                result = await toolValidateSchema(a);
                break;
            case "save_progress":
                result = await toolSaveProgress(a);
                break;
            case "get_progress":
                result = await toolGetProgress();
                break;
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
        return { content: [{ type: "text", text: result }] };
    }
    catch (err) {
        // McpError already formatted — সরাসরি throw
        if (err instanceof McpError)
            throw err;
        // Unexpected error → InternalError-এ wrap করা হচ্ছে
        throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
    }
});
// ─── Server Start ─────────────────────────────────────────────────────────────
/**
 * StdioServerTransport ব্যবহার করা হচ্ছে।
 * MCP server stdin/stdout দিয়ে Claude বা অন্য MCP client-এর সাথে communicate করে।
 * Logs ও debug output stderr-এ যায় (stdout MCP protocol-এর জন্য reserved)।
 */
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[wp-seo-mcp] Server v2.0.0 running — site: ${WP_SITE_URL} | meta key: ${SEOPRESS_META_KEY}\n`);
//# sourceMappingURL=index.js.map