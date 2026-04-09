export type FxTwitterUserResponse = {
  code: number;
  message?: string;
  user?: {
    screen_name: string;
    avatar_url: string;
  };
};

const FX_API_BASE = import.meta.env.DEV ? "/fxtwitter-api" : "https://api.fxtwitter.com";

/** `_normal.jpg` → `_400x400` */
export function upsizeTwitterAvatarUrl(url: string): string {
  return url.replace(/_normal(\.(?:jpe?g|png|webp))$/i, "_400x400$1");
}

export async function fetchFxTwitterAvatarUrl(screenName: string): Promise<string | null> {
  if (!screenName.trim()) return null;
  const res = await fetch(`${FX_API_BASE}/${encodeURIComponent(screenName)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as FxTwitterUserResponse;
  if (data.code !== 200 || !data.user?.avatar_url) return null;
  return upsizeTwitterAvatarUrl(data.user.avatar_url);
}

/** 重複を除き、全件を同時に取得（待機なし） */
export async function fetchFxTwitterAvatarMap(screenNames: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(screenNames.map((s) => s.trim()).filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const results = await Promise.all(
    unique.map(async (sn) => {
      const url = await fetchFxTwitterAvatarUrl(sn);
      return [sn, url] as const;
    }),
  );
  for (const [sn, url] of results) {
    if (url) out.set(sn, url);
  }
  return out;
}
