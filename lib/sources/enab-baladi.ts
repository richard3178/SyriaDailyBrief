import { load } from "cheerio";
import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

const API_URL =
  "https://english.enabbaladi.net/wp-json/wp/v2/posts?per_page=15";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};

export async function fetchEnabBaladi(sourceId: string): Promise<RawArticle[]> {
  const text = await curlFetch(API_URL, HEADERS);
  // 诊断日志：看 Actions 里 curl 实际拿到的内容
  const raw = typeof text === "string" ? text : String(text);
  console.log(
    `[enab-baladi] len=${raw.length} head=${raw.slice(0, 150).replace(/\n/g, " ")}`
  );

  let posts: unknown[];
  try {
    posts = JSON.parse(raw);
  } catch (e) {
    console.log(`[enab-baladi] JSON.parse failed: ${String(e).slice(0, 120)}`);
    return [];
  }
  if (!Array.isArray(posts)) return [];

  const seen = new Set<string>();
  const items: RawArticle[] = [];

  for (const p of posts) {
    const post = p as Record<string, any>;
    const rawTitle = post?.title?.rendered ?? post?.title;
    const link = post?.link ?? post?.url;
    const rawExcerpt = post?.excerpt?.rendered ?? post?.excerpt;
    const dateGmt = post?.date_gmt ?? post?.date;

    if (typeof rawTitle !== "string" || typeof link !== "string" || !link)
      continue;
    if (!link.startsWith("https://english.enabbaladi.net/archives/")) continue;
    if (seen.has(link)) continue;
    seen.add(link);

    const title = load(rawTitle).text().trim();
    const excerpt = rawExcerpt
      ? load(String(rawExcerpt)).text().trim().slice(0, 300)
      : "";

    let publishedAt: Date | undefined;
    if (typeof dateGmt === "string" && dateGmt.includes("T")) {
      const iso = dateGmt.endsWith("Z") ? dateGmt : `${dateGmt}Z`;
      publishedAt = new Date(iso);
    }

    items.push({
      sourceId,
      title,
      url: link,
      excerpt,
      publishedAt,
      category: "finance",
    });
  }

  return items;
}
