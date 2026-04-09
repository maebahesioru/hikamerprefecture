/** JIS 都道府県コード（01–47）→ 表示名・本文マッチ用キーワード（長い語を先にマッチさせる） */

export type PrefectureRow = {
  code: string;
  name: string;
  /** ツイート本文に含まれたらこの都道府県としてカウント */
  keywords: string[];
};

const rows: PrefectureRow[] = [
  { code: "01", name: "北海道", keywords: ["北海道", "札幌", "函館", "旭川", "道北", "道南", "道東", "道央"] },
  { code: "02", name: "青森県", keywords: ["青森県", "青森"] },
  { code: "03", name: "岩手県", keywords: ["岩手県", "岩手", "盛岡"] },
  { code: "04", name: "宮城県", keywords: ["宮城県", "宮城", "仙台"] },
  { code: "05", name: "秋田県", keywords: ["秋田県", "秋田"] },
  { code: "06", name: "山形県", keywords: ["山形県", "山形"] },
  { code: "07", name: "福島県", keywords: ["福島県", "福島"] },
  { code: "08", name: "茨城県", keywords: ["茨城県", "茨城", "水戸"] },
  { code: "09", name: "栃木県", keywords: ["栃木県", "栃木", "宇都宮"] },
  { code: "10", name: "群馬県", keywords: ["群馬県", "群馬", "前橋", "高崎"] },
  { code: "11", name: "埼玉県", keywords: ["埼玉県", "埼玉", "さいたま", "川越"] },
  { code: "12", name: "千葉県", keywords: ["千葉県", "千葉"] },
  { code: "13", name: "東京都", keywords: ["東京都", "東京", "新宿", "渋谷", "池袋"] },
  { code: "14", name: "神奈川県", keywords: ["神奈川県", "神奈川", "横浜", "川崎", "鎌倉", "横須賀"] },
  { code: "15", name: "新潟県", keywords: ["新潟県", "新潟"] },
  { code: "16", name: "富山県", keywords: ["富山県", "富山"] },
  { code: "17", name: "石川県", keywords: ["石川県", "石川", "金沢"] },
  { code: "18", name: "福井県", keywords: ["福井県", "福井"] },
  { code: "19", name: "山梨県", keywords: ["山梨県", "山梨", "甲府"] },
  { code: "20", name: "長野県", keywords: ["長野県", "長野", "松本"] },
  { code: "21", name: "岐阜県", keywords: ["岐阜県", "岐阜"] },
  { code: "22", name: "静岡県", keywords: ["静岡県", "静岡", "浜松"] },
  { code: "23", name: "愛知県", keywords: ["愛知県", "愛知", "名古屋", "名駅"] },
  { code: "24", name: "三重県", keywords: ["三重県", "三重", "四日市"] },
  { code: "25", name: "滋賀県", keywords: ["滋賀県", "滋賀", "大津"] },
  { code: "26", name: "京都府", keywords: ["京都府", "京都", "祇園", "嵐山"] },
  { code: "27", name: "大阪府", keywords: ["大阪府", "大阪", "難波", "梅田", "心斎橋"] },
  { code: "28", name: "兵庫県", keywords: ["兵庫県", "兵庫", "神戸", "姫路"] },
  { code: "29", name: "奈良県", keywords: ["奈良県", "奈良"] },
  { code: "30", name: "和歌山県", keywords: ["和歌山県", "和歌山"] },
  { code: "31", name: "鳥取県", keywords: ["鳥取県", "鳥取"] },
  { code: "32", name: "島根県", keywords: ["島根県", "島根", "松江"] },
  { code: "33", name: "岡山県", keywords: ["岡山県", "岡山"] },
  { code: "34", name: "広島県", keywords: ["広島県", "広島", "広島市"] },
  { code: "35", name: "山口県", keywords: ["山口県", "山口", "下関"] },
  { code: "36", name: "徳島県", keywords: ["徳島県", "徳島"] },
  { code: "37", name: "香川県", keywords: ["香川県", "香川", "高松"] },
  { code: "38", name: "愛媛県", keywords: ["愛媛県", "愛媛", "松山"] },
  { code: "39", name: "高知県", keywords: ["高知県", "高知"] },
  { code: "40", name: "福岡県", keywords: ["福岡県", "福岡", "博多"] },
  { code: "41", name: "佐賀県", keywords: ["佐賀県", "佐賀"] },
  { code: "42", name: "長崎県", keywords: ["長崎県", "長崎"] },
  { code: "43", name: "熊本県", keywords: ["熊本県", "熊本"] },
  { code: "44", name: "大分県", keywords: ["大分県", "大分"] },
  { code: "45", name: "宮崎県", keywords: ["宮崎県", "宮崎"] },
  { code: "46", name: "鹿児島県", keywords: ["鹿児島県", "鹿児島"] },
  { code: "47", name: "沖縄県", keywords: ["沖縄県", "沖縄", "那覇"] },
];

/** キーワードが長い順（「東京都」が「東京」より先） */
const flatSorted: { code: string; kw: string }[] = rows
  .flatMap((r) => r.keywords.map((kw) => ({ code: r.code, kw })))
  .sort((a, b) => b.kw.length - a.kw.length);

/**
 * 部分一致の地雷（短いキーワードが別語・別県名に含まれる）への対処。
 * - 京都: 「東京都」に「京都」が連続出現 → (?<!東)京都
 * - 三重: 「第三重」などに「三重」が連続出現 → (?<!第)三重
 */
function keywordMatchesInText(text: string, kw: string): boolean {
  if (kw === "京都") {
    return /(?<!東)京都/u.test(text);
  }
  if (kw === "三重") {
    return /(?<!第)三重/u.test(text);
  }
  return text.includes(kw);
}

export const PREFECTURES = rows;

export const PREFECTURE_BY_CODE = Object.fromEntries(rows.map((r) => [r.code, r])) as Record<
  string,
  PrefectureRow
>;

export function stripYahooHighlights(text: string): string {
  return text.replace(/\tSTART\t[^\t]*\tEND\t/g, "");
}

/**
 * 1ツイートにつき、言及された都道府県コードを重複なく返す
 */
export function extractPrefectureCodesFromTweet(text: string): string[] {
  const normalized = stripYahooHighlights(text);
  const found = new Set<string>();
  for (const { code, kw } of flatSorted) {
    if (keywordMatchesInText(normalized, kw)) found.add(code);
  }
  return [...found];
}

export function emptyCounts(): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.code, 0]));
}
