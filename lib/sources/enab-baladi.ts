import { load } from "cheerio";
import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

interface WpPost {
  date?: string;
  link?: string;
  title?: { rendered?: string };
}

export async function fetchWpJson(
  sourceId: string,
  url: string,
  category: string
): Promise<RawArticle[]> {
  const text = await curlFetch(url, HEADERS);
  console.log(
    `[wp-json] ${sourceId} len=${text.length} head=${text.slice(0, 120).replace(/\n/g, " ")}`
  );
  let posts: WpPost[] = [];
  try {
    posts = JSON.parse(text);
  } catch {
    console.log(`[wp-json] ${sourceId} JSON parse failed`);
    return [];
  }
  const items: RawArticle[] = [];
  const seen = new Set<string>();
  let noDate = 0;
  const cutoff = Date.now() - 3 * 86400_000;
  for (const p of posts) {
    const itemUrl = p.link ?? "";
    if (!itemUrl || seen.has(itemUrl)) continue;
    seen.add(itemUrl);
    const title = p.title?.rendered
      ? load(p.title.rendered).text().trim()
      : "";
    if (!title) continue;
    const publishedAt = p.date ? new Date(p.date) : new Date(NaN);
    if (Number.isNaN(publishedAt.getTime())) {
      noDate++;
      continue;
    }
    if (publishedAt.getTime() < cutoff) continue;
    items.push({ sourceId, title, url: itemUrl, publishedAt, category });
  }
  console.log(`[wp-json] ${sourceId} kept=${items.length} noDate=${noDate}`);
  return items.slice(0, 15);
}
