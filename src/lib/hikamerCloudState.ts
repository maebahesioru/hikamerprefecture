import type { PrefContributor } from "../components/JapanPrefectureMap";
import { emptyCounts, extractPrefectureCodesFromTweet, PREFECTURES } from "./prefecture";
import type { YahooTimelineEntry } from "./yahooRealtime";
import { supabase } from "./supabaseClient";

export type HikamerPersisted = {
  counts: Record<string, number>;
  contributorsByPref: Record<string, PrefContributor[]>;
  seenTweetIds: string[];
};

const ROW_ID = "default";

function emptyContributorsRecord(): Record<string, PrefContributor[]> {
  return Object.fromEntries(PREFECTURES.map((p) => [p.code, [] as PrefContributor[]]));
}

export function emptyHikamerPersisted(): HikamerPersisted {
  return {
    counts: emptyCounts(),
    contributorsByPref: emptyContributorsRecord(),
    seenTweetIds: [],
  };
}

export async function loadHikamerState(): Promise<HikamerPersisted | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("hikamer_aggregated_state")
    .select("counts, contributors_by_pref, seen_tweet_ids")
    .eq("id", ROW_ID)
    .maybeSingle();
  if (error) {
    console.error("[hikamer] load", error);
    return null;
  }
  if (!data) return null;
  return {
    counts: (data.counts as Record<string, number>) ?? {},
    contributorsByPref:
      (data.contributors_by_pref as Record<string, PrefContributor[]>) ?? {},
    seenTweetIds: (data.seen_tweet_ids as string[]) ?? [],
  };
}

export async function saveHikamerState(state: HikamerPersisted): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from("hikamer_aggregated_state").upsert(
    {
      id: ROW_ID,
      counts: state.counts,
      contributors_by_pref: state.contributorsByPref,
      seen_tweet_ids: state.seenTweetIds,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) {
    console.error("[hikamer] save", error);
    return false;
  }
  return true;
}

function contributorsToMaps(
  contrib: Record<string, PrefContributor[]>,
): Record<string, Map<string, PrefContributor>> {
  return Object.fromEntries(
    PREFECTURES.map((p) => {
      const m = new Map<string, PrefContributor>();
      for (const c of contrib[p.code] ?? []) {
        const uid = c.dedupeKey ?? c.screenName;
        if (uid) m.set(uid, { ...c, dedupeKey: uid });
      }
      return [p.code, m];
    }),
  ) as Record<string, Map<string, PrefContributor>>;
}

export function mapsToRecord(
  maps: Record<string, Map<string, PrefContributor>>,
): Record<string, PrefContributor[]> {
  return Object.fromEntries(PREFECTURES.map((p) => [p.code, [...maps[p.code].values()]]));
}

/**
 * 未処理ツイートだけを都道府県集計に足す（ツイート id で二重計上しない）
 */
export function mergeNewEntriesIntoState(
  base: HikamerPersisted,
  newEntries: YahooTimelineEntry[],
): HikamerPersisted {
  const seen = new Set(base.seenTweetIds);
  const counts: Record<string, number> = { ...base.counts };
  for (const p of PREFECTURES) {
    counts[p.code] = counts[p.code] ?? 0;
  }
  const byPref = contributorsToMaps(base.contributorsByPref);

  for (const e of newEntries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const text = e.displayText ?? e.displayTextBody ?? "";
    const codes = extractPrefectureCodesFromTweet(text);
    const uid = e.userId ?? e.screenName ?? e.id;
    const img = e.profileImage?.trim();
    const screenName = e.screenName ?? "";

    for (const c of codes) {
      counts[c] = (counts[c] ?? 0) + 1;
      if (!screenName || byPref[c].has(uid)) continue;
      byPref[c].set(uid, {
        profileImage: img ?? "",
        screenName,
        dedupeKey: uid,
      });
    }
  }

  for (const p of PREFECTURES) {
    counts[p.code] = counts[p.code] ?? 0;
  }

  return {
    counts,
    contributorsByPref: mapsToRecord(byPref),
    seenTweetIds: [...seen],
  };
}
