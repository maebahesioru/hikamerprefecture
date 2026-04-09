export type YahooTimelineEntry = {
  id: string;
  displayText: string;
  displayTextBody?: string;
  /** 投稿者（返信者） */
  userId?: string;
  screenName?: string;
  profileImage?: string;
};

export type YahooPaginationResponse = {
  timeline?: {
    head?: { oldestTweetId?: string; totalResultsAvailable?: number };
    entry?: YahooTimelineEntry[];
  };
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function fetchYahooPage(params: {
  query: string;
  start?: number;
  oldestTweetId?: string;
  results?: number;
  md?: "h" | "";
  mtype?: "image" | "";
}): Promise<YahooTimelineEntry[]> {
  const q = new URLSearchParams({
    p: params.query,
    results: String(params.results ?? 40),
    ...(params.md === "h" ? { md: "h" } : {}),
    ...(params.mtype === "image" ? { mtype: "image" } : {}),
    ...(params.start != null ? { start: String(params.start) } : {}),
    ...(params.oldestTweetId ? { oldestTweetId: params.oldestTweetId } : {}),
  });

  const url = `/realtime-api/v1/pagination?${q}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://search.yahoo.co.jp/realtime/search",
      "User-Agent": UA,
    },
  });
  if (!res.ok) throw new Error(`Yahoo API ${res.status}`);
  const data = (await res.json()) as YahooPaginationResponse;
  return data.timeline?.entry ?? [];
}

/**
 * 先頭は start 並列、その後は oldestTweetId で追記（最大 maxTweets 件まで）
 */
export async function fetchYahooEntries(options: {
  query: string;
  parallelPages?: number;
  maxTweets?: number;
  md?: "h" | "";
  mtype?: "image" | "";
}): Promise<YahooTimelineEntry[]> {
  const { query, parallelPages = 4, maxTweets = 800, md = "h", mtype = "" } = options;
  const results = 40;
  const starts = Array.from({ length: parallelPages }, (_, i) => i * results + 1);
  const firstBatches = await Promise.all(
    starts.map((start) =>
      fetchYahooPage({ query, start, results, md, mtype: mtype === "image" ? "image" : undefined }),
    ),
  );
  const out: YahooTimelineEntry[] = [];
  const seen = new Set<string>();
  const pushUnique = (list: YahooTimelineEntry[]) => {
    for (const e of list) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      if (out.length >= maxTweets) return true;
    }
    return false;
  };
  if (pushUnique(firstBatches.flat())) return out;

  let cursor =
    firstBatches.flat().at(-1)?.id ??
    null;
  let guard = 0;
  while (cursor && out.length < maxTweets && guard < 200) {
    guard += 1;
    const page = await fetchYahooPage({ query, oldestTweetId: cursor, results, md, mtype: mtype === "image" ? "image" : undefined });
    if (page.length === 0) break;
    if (pushUnique(page)) break;
    cursor = page.at(-1)?.id ?? null;
  }
  return out;
}
