import { fetchSanaPage } from "./sana-pages";
import { fetchRss } from "./rss";
import { fetchWpJson } from "./enab-baladi";
import type { RawArticle, SourceDef } from "./types";

/**
 * Single dispatcher used by daily.ts, dry-run.ts, and the cron route.
 * Add a new branch here when introducing a non-RSS fetcher.
 */
export async function fetchSource(source: SourceDef): Promise<RawArticle[]> {
  if (source.type === "scrape") return fetchSanaPage(source.id);
  if (source.type === "wpjson") return fetchWpJson(source.id, source.url, source.category);
  return fetchRss(source.id, source.url, source.category, {
    useCurl: source.useCurl,
  });
}
