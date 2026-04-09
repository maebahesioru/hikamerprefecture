import { useCallback, useEffect, useMemo, useState } from "react";
import { JapanPrefectureMap, type PrefContributor } from "./components/JapanPrefectureMap";
import { emptyCounts, PREFECTURES } from "./lib/prefecture";
import { fetchYahooEntries } from "./lib/yahooRealtime";
import { fetchFxTwitterAvatarMap } from "./lib/fxtwitter";
import {
  emptyHikamerPersisted,
  loadHikamerState,
  mergeNewEntriesIntoState,
  saveHikamerState,
} from "./lib/hikamerCloudState";
import { supabase } from "./lib/supabaseClient";

const DEFAULT_QUERY = "@hikamabasyo";

export function App() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 直近の Yahoo 検索で返ってきた件数 */
  const [lastFetchCount, setLastFetchCount] = useState(0);
  /** これまでに一度でもカウントしたユニークツイート数（id ベース・Supabase と同期） */
  const [recordedTweetTotal, setRecordedTweetTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>(() => emptyCounts());
  const [contributorsByPref, setContributorsByPref] = useState<Record<string, PrefContributor[]>>(
    () =>
      Object.fromEntries(PREFECTURES.map((p) => [p.code, [] as PrefContributor[]])),
  );

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cloud = (await loadHikamerState()) ?? emptyHikamerPersisted();

      const entries = await fetchYahooEntries({
        query: DEFAULT_QUERY,
        parallelPages: 4,
        maxTweets: 800,
        md: "h",
      });
      setLastFetchCount(entries.length);

      const beforeSeen = cloud.seenTweetIds.length;
      const merged = mergeNewEntriesIntoState(cloud, entries);
      const newlyRecorded = merged.seenTweetIds.length - beforeSeen;

      const contribOut: Record<string, PrefContributor[]> = { ...merged.contributorsByPref };
      const names: string[] = [];
      for (const p of PREFECTURES) {
        for (const c of contribOut[p.code] ?? []) {
          if (c.screenName) names.push(c.screenName);
        }
      }
      const fxAvatars = await fetchFxTwitterAvatarMap(names);
      for (const p of PREFECTURES) {
        contribOut[p.code] = (contribOut[p.code] ?? [])
          .map((c) => ({
            ...c,
            profileImage: fxAvatars.get(c.screenName) ?? c.profileImage,
          }))
          .filter((c) => c.profileImage.trim().length > 0);
      }

      setCounts(merged.counts);
      setContributorsByPref(contribOut);
      setRecordedTweetTotal(merged.seenTweetIds.length);

      await saveHikamerState({
        counts: merged.counts,
        contributorsByPref: contribOut,
        seenTweetIds: merged.seenTweetIds,
      });

      if (import.meta.env.DEV && newlyRecorded > 0) {
        console.info(`[hikamer] 新規に記録したツイート: ${newlyRecorded}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const tableRows = useMemo(() => {
    return PREFECTURES.map((p) => ({
      code: p.code,
      name: p.name,
      n: counts[p.code] ?? 0,
      people: (contributorsByPref[p.code] ?? []).length,
    })).sort((a, b) => b.n - a.n);
  }, [counts, contributorsByPref]);

  const totalPrefHits = useMemo(
    () => tableRows.reduce((s, r) => s + r.n, 0),
    [tableRows],
  );

  return (
    <div className="app">
      <header className="header">
        <h1>ヒカマー都道府県分布</h1>
        <p className="lead">
          Yahoo リアルタイム検索で取得した<strong>返信</strong>の本文から都道府県名を検出し、件数を塗り分けます。
          各県の位置には、その県名を含めた返信者のアイコンを表示します（<strong>fxtwitter</strong> の <code>avatar_url</code>、失敗時は Yahoo の <code>profileImage</code>）。同一ユーザーは県ごとに1枚。
          {supabase
            ? " ツイートは id で重複排除しつつ Supabase に蓄積するため、Yahoo 側から古いツイートが消えてもこれまでの集計を失いにくくしています。"
            : null}
        </p>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <section className="stats">
        {loading ? <span className="loading-hint">取得中…</span> : null}
        <span>
          今回の検索結果: <strong>{lastFetchCount}</strong> 件
        </span>
        <span>
          記録済みツイート（ユニーク id）: <strong>{recordedTweetTotal}</strong> 件
        </span>
        <span>
          都道府県ヒット合計: <strong>{totalPrefHits}</strong>
        </span>
      </section>

      <div className="map-wrap">
        <JapanPrefectureMap
          counts={counts}
          contributorsByPref={contributorsByPref}
          layoutBusy={loading}
        />
      </div>

      <section className="table-section">
        <h2>都道府県別（件数 / ユニーク人数）</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>順位</th>
                <th>コード</th>
                <th>都道府県</th>
                <th>件数</th>
                <th>人数</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r, i) => (
                <tr key={r.code}>
                  <td>{i + 1}</td>
                  <td>{r.code}</td>
                  <td>{r.name}</td>
                  <td>{r.n}</td>
                  <td>{r.people}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
