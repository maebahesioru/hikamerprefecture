import { useEffect, useMemo, useRef } from "react";
import { feature } from "topojson-client";
import type { FeatureCollection, Feature as GeoFeature, Geometry, Polygon } from "geojson";
import type { Topology } from "topojson-specification";
import { forceCollide, forceSimulation, forceX, forceY } from "d3-force";
import { geoPath } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateOrRd } from "d3-scale-chromatic";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { select } from "d3-selection";
import japanTopo from "jpn-atlas/japan/japan.json";
import { PREFECTURE_BY_CODE } from "../lib/prefecture";

export type PrefContributor = {
  profileImage: string;
  screenName: string;
  /** 同一ユーザーの重複排除用（userId 優先）。未設定時は screenName で代替 */
  dedupeKey?: string;
};

type Props = {
  counts: Record<string, number>;
  /** 都道府県コード → その県名を本文に含めた返信者（重複ユーザーは1回） */
  contributorsByPref: Record<string, PrefContributor[]>;
  /** true の間は前回の地図上アイコン配置を再計算しない（取得中に散らばって見えるのを防ぐ） */
  layoutBusy?: boolean;
};

type AvatarLayoutItem = {
  code: string;
  cx: number;
  cy: number;
  positions: { x: number; y: number }[];
  size: number;
  contributors: PrefContributor[];
  minSizeFloor: number;
  prefArea: number;
  clusterScale: number;
  poly: Polygon;
  bounds: [[number, number], [number, number]];
  anchor: [number, number];
};

const topo = japanTopo as unknown as Topology;
const prefCollection = feature(topo, topo.objects.prefectures) as FeatureCollection;
const pathGen = geoPath();

/** 隣接クラスタ間で、円と円の中心の距離に足す余白（地図座標）。大きすぎると縮小連鎖でアイコン同士が空きすぎる */
const CLUSTER_PAIR_CENTER_GAP = 0.52;

/** 全県共通の画面向け拡大（地図座標の径に掛けて表示） */
function uniformAvatarDisplayScale(vbWidth: number): number {
  return Math.min(9.5, Math.max(6.8, vbWidth * 0.0092));
}

/** 外周リングの面積（投影座標系の平面） */
function ringArea(ring: number[][]): number {
  if (ring.length < 3) return 0;
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const j = (i + 1) % n;
    s += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(s / 2);
}

/**
 * MultiPolygon では本土（面積最大ポリゴン）だけを使う。
 */
function featureLargestPolygonPart(gf: GeoFeature<Geometry>): GeoFeature<Geometry> {
  const g = gf.geometry;
  if (g.type === "Polygon") return gf;
  if (g.type === "MultiPolygon") {
    let best: number[][][] | null = null;
    let bestA = -1;
    for (const poly of g.coordinates) {
      const outer = poly[0];
      if (!outer?.length) continue;
      const a = ringArea(outer);
      if (a > bestA) {
        bestA = a;
        best = poly;
      }
    }
    if (!best) return gf;
    return {
      type: "Feature",
      id: gf.id,
      properties: gf.properties ?? {},
      geometry: { type: "Polygon", coordinates: best },
    };
  }
  return gf;
}

function mainlandPolygonArea(f: GeoFeature<Geometry>): number {
  const mainland = featureLargestPolygonPart(f);
  const g = mainland.geometry;
  if (g.type !== "Polygon") return 0;
  const outer = g.coordinates[0];
  return outer?.length ? Math.abs(ringArea(outer)) : 0;
}

const _mainlandAreas: number[] = [];
for (const f of prefCollection.features) {
  const a = mainlandPolygonArea(f as GeoFeature<Geometry>);
  if (a > 0) _mainlandAreas.push(a);
}
const PREF_AREA_MIN = _mainlandAreas.length > 0 ? Math.min(..._mainlandAreas) : 1;
const PREF_AREA_MAX = _mainlandAreas.length > 0 ? Math.max(..._mainlandAreas) : 1;

function prefAreaNormalizedT(area: number): number {
  const smin = Math.sqrt(PREF_AREA_MIN);
  const smax = Math.sqrt(PREF_AREA_MAX);
  const s = Math.sqrt(Math.max(area, 1e-9));
  return smax > smin ? Math.min(1, Math.max(0, (s - smin) / (smax - smin))) : 0.5;
}

function minIconDiameterFromArea(area: number): number {
  const t = prefAreaNormalizedT(area);
  return 8 + t * 10;
}

/**
 * アイコン径の「ピクセル風」上限。実際の size は min(格子見積もり, cap×係数) なので、
 * 係数が小さいと cap 側だけが効き、格子・縦長補正をいじっても見た目が変わらない。
 */
function avatarFallbackMaxFromArea(area: number, mentionCount: number): number {
  const t = prefAreaNormalizedT(area);
  const base = 38 + t * 28;
  const mentionBoost = Math.min(9, Math.sqrt(Math.max(mentionCount, 1)) * 1.05);
  return Math.max(28, Math.min(105, base + mentionBoost * 0.45));
}

function pointInRing(x: number, y: number, ring: number[][]): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if ((yi > y) === (yj > y)) continue;
    const xInt = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (x < xInt) inside = !inside;
  }
  return inside;
}

function pointInPolygonGeom(x: number, y: number, poly: Polygon): boolean {
  const outer = poly.coordinates[0];
  if (!outer?.length || !pointInRing(x, y, outer)) return false;
  for (let h = 1; h < poly.coordinates.length; h++) {
    const hole = poly.coordinates[h];
    if (hole?.length && pointInRing(x, y, hole)) return false;
  }
  return true;
}

function anchorInsidePolygon(
  poly: Polygon,
  cx: number,
  cy: number,
  bounds: [[number, number], [number, number]],
): [number, number] {
  if (pointInPolygonGeom(cx, cy, poly)) return [cx, cy];
  const mx = (bounds[0][0] + bounds[1][0]) / 2;
  const my = (bounds[0][1] + bounds[1][1]) / 2;
  if (pointInPolygonGeom(mx, my, poly)) return [mx, my];
  const ring = poly.coordinates[0];
  for (let i = 0; i < Math.min(ring.length, 80); i += Math.max(1, Math.floor(ring.length / 40))) {
    if (pointInPolygonGeom(ring[i][0], ring[i][1], poly)) return [ring[i][0], ring[i][1]];
  }
  return [cx, cy];
}

/** 点を県ポリゴン内に押し戻す（重心方向へ線分探索） */
function clampPointToPolygon(
  x: number,
  y: number,
  poly: Polygon,
  cx: number,
  cy: number,
  bounds: [[number, number], [number, number]],
): [number, number] {
  if (pointInPolygonGeom(x, y, poly)) return [x, y];
  for (let s = 0; s <= 1; s += 0.04) {
    const px = x + (cx - x) * s;
    const py = y + (cy - y) * s;
    if (pointInPolygonGeom(px, py, poly)) return [px, py];
  }
  return anchorInsidePolygon(poly, cx, cy, bounds);
}

/**
 * bbox 内に k 個の等径円を格子に並べるときの直径の見積もり（cols を総当たり）。
 * 縦長（宮城・山形など）は短辺が列方向に効きやすく、余白 pad をやや大きめにし、
 * さらに縦横比に応じたストリップ補正でやや大きく取れるようにする。
 */
function maxCircleDiameterInRectGrid(bw: number, bh: number, k: number): number {
  if (k <= 0) return 0;
  const long = Math.max(bw, bh);
  const short = Math.min(bw, bh);
  const aspect = long / Math.max(1e-9, short);
  let padFrac = Math.min(0.96, 0.828 + 0.13 * Math.min(1, (aspect - 1) / 2.3));
  if (bh >= bw * 1.12) {
    padFrac = Math.min(0.98, padFrac + 0.032);
  }
  if (k === 1) {
    let d = short * padFrac;
    // k>1 と同様、帯状 bbox では縦横比に応じた補正（k=1 だけ short 固定だと埼玉・滋賀などが極小になる）
    if (bh >= bw * 1.12) {
      const tallAr = bh / Math.max(1e-9, bw);
      d *= Math.min(1.14, 1 + 0.042 * Math.min(5.5, tallAr - 1));
    } else if (bw >= bh * 1.12) {
      const wideAr = bw / Math.max(1e-9, bh);
      d *= Math.min(1.14, 1 + 0.05 * Math.min(6, wideAr - 1));
    }
    return d;
  }
  let best = 0;
  for (let cols = 1; cols <= k; cols++) {
    const rows = Math.ceil(k / cols);
    const cellD = Math.min(bw / cols, bh / rows);
    if (cellD > best) best = cellD;
  }
  let d = best * padFrac;
  if (bh >= bw * 1.12) {
    const tallAr = bh / Math.max(1e-9, bw);
    d *= Math.min(1.14, 1 + 0.042 * Math.min(5.5, tallAr - 1));
  } else if (bw >= bh * 1.12) {
    const wideAr = bw / Math.max(1e-9, bh);
    d *= Math.min(1.09, 1 + 0.03 * Math.min(4.5, wideAr - 1));
  }
  return d;
}

/**
 * 南北または東西に極端に細い県: 短辺だけの内接円だとアイコンが小さすぎる。
 * 実際のポリゴン内では clamp されるが、表示径の下限を幾何平均で持ち上げる。
 */
function stripAwareGridDiameter(bw: number, bh: number, k: number): number {
  const base = maxCircleDiameterInRectGrid(bw, bh, k);
  const long = Math.max(bw, bh);
  const short = Math.min(bw, bh);
  const ar = long / Math.max(1e-9, short);
  if (ar < 1.32) return base;
  const geoMean = Math.sqrt(bw * bh);
  const boostedRaw = Math.min(geoMean * 0.56, long * 0.52, short * 2.35);
  /** 幾何平均だけが効きすぎると千葉のような大きな半島で径が膨らみすぎるので短辺比で頭打ち */
  const boosted = Math.min(boostedRaw, short * 1.62);
  return Math.max(base, boosted);
}

function resolveCircleOverlapsInPolygon(
  nodes: { x: number; y: number }[],
  minCenterDist: number,
  poly: Polygon,
  cx: number,
  cy: number,
  bounds: [[number, number], [number, number]],
): void {
  const n = nodes.length;
  if (n < 2) return;
  const minD = Math.max(minCenterDist, 1e-6);
  for (let round = 0; round < 72; round++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= minD - 1e-9) continue;
        const push = dist < 1e-12 ? minD / 2 : (minD - dist) / 2;
        const ux = dist < 1e-12 ? 1 : dx / dist;
        const uy = dist < 1e-12 ? 0 : dy / dist;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        moved = true;
      }
    }
    for (const node of nodes) {
      const [px, py] = clampPointToPolygon(node.x, node.y, poly, cx, cy, bounds);
      node.x = px;
      node.y = py;
    }
    if (!moved) break;
  }
}

/**
 * 1 人 = 1 点。d3-force（forceCollide + 重心への弱い引力）。
 * collisionRadius は描画の半径（size×visScale/2）と一致させる。
 */
function layoutContributorsInPolygon(
  poly: Polygon,
  bounds: [[number, number], [number, number]],
  contributors: PrefContributor[],
  centroid: [number, number],
  /** 地図座標系での円の半径（= size×visScale/2 に揃える） */
  collisionRadius: number,
): { x: number; y: number }[] {
  const n = contributors.length;
  const [cx, cy] = centroid;
  const [[bx0, by0], [bx1, by1]] = bounds;
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  const short = Math.min(bw, bh);
  const spreadFromBBox = short / Math.max(5, 2 + Math.sqrt(n));
  /** 東京など bbox が極小で人数が多いときの底上げ。係数が大きいと県内でアイコン間隔だけ異常に空く */
  const r0 = Math.max(collisionRadius, 0.08);
  const spreadFromRadius = r0 * Math.max(1.28, 0.48 * Math.sqrt(Math.max(n, 2)));
  const spreadBase = Math.max(spreadFromBBox, spreadFromRadius);
  const spreadX = spreadBase * Math.sqrt(bw / Math.max(1e-9, short));
  const spreadY = spreadBase * Math.sqrt(bh / Math.max(1e-9, short));

  if (n === 0) {
    const [ix, iy] = anchorInsidePolygon(poly, cx, cy, bounds);
    return [{ x: ix, y: iy }];
  }
  if (n === 1) {
    const [ix, iy] = anchorInsidePolygon(poly, cx, cy, bounds);
    return [{ x: ix, y: iy }];
  }

  const nodes: { x: number; y: number }[] = [];
  const golden = 2.39996322972865332;
  const phase = bh >= bw ? Math.PI / 2 : 0;
  for (let i = 0; i < n; i++) {
    const a = i * golden + phase;
    const rad = Math.sqrt(i + 1);
    let x = cx + spreadX * rad * Math.cos(a);
    let y = cy + spreadY * rad * Math.sin(a);
    [x, y] = clampPointToPolygon(x, y, poly, cx, cy, bounds);
    nodes.push({ x, y });
  }

  const rCollide = Math.max(collisionRadius, 0.08);
  const tall = bh >= bw;
  const strAlongShort = 0.18;
  const strAlongLong = 0.072;
  const sim = forceSimulation(nodes)
    .force("x", forceX(cx).strength(tall ? strAlongShort : strAlongLong))
    .force("y", forceY(cy).strength(tall ? strAlongLong : strAlongShort))
    .force("collide", forceCollide(rCollide).strength(0.98).iterations(6))
    .alphaDecay(0.02)
    .alphaMin(0.001);

  let ticks = 0;
  while (sim.alpha() > sim.alphaMin() && ticks < 480) {
    sim.tick();
    ticks += 1;
  }

  for (const node of nodes) {
    const [px, py] = clampPointToPolygon(node.x, node.y, poly, cx, cy, bounds);
    node.x = px;
    node.y = py;
  }

  const minCenter = 2 * rCollide * 1.03;
  resolveCircleOverlapsInPolygon(nodes, minCenter, poly, cx, cy, bounds);

  return nodes;
}

/**
 * 全アイコンを「自分の県ポリゴンに属する円」として扱い、重なりを位置だけで解消する。
 * 県内・県境どちらも同じループで扱う（clamp で各点を所属県に戻す）。
 */
type GlobalAvatarCircleNode = {
  pt: { x: number; y: number };
  r: number;
  poly: Polygon;
  bounds: [[number, number], [number, number]];
  anchor: [number, number];
  code: string;
};

function buildGlobalAvatarCircleNodes(
  items: AvatarLayoutItem[],
  visScale: number,
): GlobalAvatarCircleNode[] {
  const out: GlobalAvatarCircleNode[] = [];
  for (const it of items) {
    const r = Math.max((it.size * visScale) / 2, 0.08);
    for (const p of it.positions) {
      out.push({
        pt: p,
        r,
        poly: it.poly,
        bounds: it.bounds,
        anchor: it.anchor,
        code: it.code,
      });
    }
  }
  return out;
}

function resolveGlobalAvatarCircleOverlaps(
  nodes: GlobalAvatarCircleNode[],
  gapGeo: number,
  maxRounds: number,
): void {
  const n = nodes.length;
  if (n < 2) return;
  for (let round = 0; round < maxRounds; round++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.pt.x - a.pt.x;
        const dy = b.pt.y - a.pt.y;
        const need = a.r + b.r + gapGeo;
        const needSq = need * need;
        const distSq = dx * dx + dy * dy;
        if (distSq >= needSq - 1e-12) continue;
        const dist = Math.sqrt(Math.max(distSq, 1e-24));
        let push = dist < 1e-12 ? need / 2 : (need - dist) / 2;
        /** 深い重なりは少し強めに押し離す（clamp 後に戻りやすいため） */
        if (dist < need * 0.55) push *= 1.22;
        else if (dist < need * 0.82) push *= 1.1;
        const ux = dist < 1e-12 ? 1 : dx / dist;
        const uy = dist < 1e-12 ? 0 : dy / dist;
        a.pt.x -= ux * push;
        a.pt.y -= uy * push;
        b.pt.x += ux * push;
        b.pt.y += uy * push;
        moved = true;
      }
    }
    for (const node of nodes) {
      const [px, py] = clampPointToPolygon(
        node.pt.x,
        node.pt.y,
        node.poly,
        node.anchor[0],
        node.anchor[1],
        node.bounds,
      );
      node.pt.x = px;
      node.pt.y = py;
    }
    if (!moved) break;
  }
}

/** 別クラスタの点同士の最短距離（県境付きの重なり検出に使用） */
function minPairwiseCenterDist(
  a: { x: number; y: number }[],
  b: { x: number; y: number }[],
): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  let minD = Infinity;
  for (const pa of a) {
    for (const pb of b) {
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

function relaxClusterSizes(
  items: {
    code?: string;
    cx: number;
    cy: number;
    size: number;
    positions: { x: number; y: number }[];
    contributors: PrefContributor[];
    minSizeFloor: number;
  }[],
  visScale: number,
): void {
  const MIN = 0.12;
  for (let iter = 0; iter < 40; iter++) {
    for (const it of items) {
      const nk = it.contributors.length;
      if (nk === 0) continue;
      it.cx = it.positions.reduce((s, p) => s + p.x, 0) / nk;
      it.cy = it.positions.reduce((s, p) => s + p.y, 0) / nk;
    }
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const rA = (a.size * visScale) / 2;
        const rB = (b.size * visScale) / 2;
        const minD = minPairwiseCenterDist(a.positions, b.positions);
        let gap = CLUSTER_PAIR_CENTER_GAP;
        const ca = a.code;
        const cb = b.code;
        if (
          (ca === "13" && cb === "14") ||
          (ca === "14" && cb === "13")
        ) {
          gap += 0.14;
        }
        const need = rA + rB + gap;
        if (minD >= need - 1e-9) continue;
        const factorRaw = minD / Math.max(need, 1e-9);
        const factor = Math.min(1, Math.max(0.12, factorRaw));
        /** minSizeFloor はここでは使わない（千葉×東京のように隣県衝突で縮められなくなるため） */
        const na = Math.max(MIN, a.size * factor);
        const nb = Math.max(MIN, b.size * factor);
        if (na < a.size - 1e-6 || nb < b.size - 1e-6) {
          const ratioA = na / a.size;
          const ratioB = nb / b.size;
          for (const p of a.positions) {
            p.x = a.cx + (p.x - a.cx) * ratioA;
            p.y = a.cy + (p.y - a.cy) * ratioA;
          }
          for (const p of b.positions) {
            p.x = b.cx + (p.x - b.cx) * ratioB;
            p.y = b.cy + (p.y - b.cy) * ratioB;
          }
          a.size = na;
          b.size = nb;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

export function JapanPrefectureMap({ counts, contributorsByPref, layoutBusy = false }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mapLayerRef = useRef<SVGGElement>(null);
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const lastAvatarLayoutRef = useRef<AvatarLayoutItem[] | null>(null);

  useEffect(() => {
    const el = svgRef.current;
    const layer = mapLayerRef.current;
    if (!el || !layer) return;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.35, 14])
      .on("zoom", (e) => {
        select(layer).attr("transform", e.transform.toString());
      });
    zoomBehaviorRef.current = z;
    select<SVGSVGElement, unknown>(el).call(z);
    return () => {
      select<SVGSVGElement, unknown>(el).on(".zoom", null);
      zoomBehaviorRef.current = null;
    };
  }, []);

  const max = useMemo(() => Math.max(1, ...Object.values(counts)), [counts]);

  const color = useMemo(
    () => scaleSequential(interpolateOrRd).domain([0, max]),
    [max],
  );

  const mapView = useMemo(() => {
    const [[bx0, by0], [bx1, by1]] = pathGen.bounds(prefCollection as FeatureCollection);
    const rw = bx1 - bx0;
    const rh = by1 - by0;
    const pad = Math.max(rw, rh) * 0.014;
    const x0 = bx0 - pad;
    const y0 = by0 - pad;
    const w = rw + 2 * pad;
    const h = rh + 2 * pad;
    return { vb: `${x0} ${y0} ${w} ${h}`, vbW: w };
  }, []);

  const avatarClusters = useMemo(() => {
    if (layoutBusy && lastAvatarLayoutRef.current) {
      return lastAvatarLayoutRef.current;
    }
    const visScale = uniformAvatarDisplayScale(mapView.vbW);

    const items: AvatarLayoutItem[] = [];
    for (const f of prefCollection.features) {
      const code = String(f.id ?? "");
      const n = counts[code] ?? 0;
      if (n <= 0) continue;
      const all = contributorsByPref[code] ?? [];
      if (all.length === 0) continue;
      const gf = f as GeoFeature<Geometry>;
      const mainland = featureLargestPolygonPart(gf);
      const g = mainland.geometry;
      if (g.type !== "Polygon") continue;
      const poly = g as Polygon;
      const c = pathGen.centroid(mainland) as [number, number];
      const b = pathGen.bounds(mainland);
      const [ax, ay] = anchorInsidePolygon(poly, c[0], c[1], b);
      const prefArea = Math.abs(ringArea(poly.coordinates[0]));
      const [[bx0, by0], [bx1, by1]] = b;
      const bw = bx1 - bx0;
      const bh = by1 - by0;
      const k = all.length;
      const verticalStrip = bh >= bw * 1.12;
      const horizontalStrip = bw >= bh * 1.12;
      const capScale = verticalStrip ? 0.058 : horizontalStrip ? 0.054 : 0.046;
      const cap = avatarFallbackMaxFromArea(prefArea, n) * capScale;
      const dGrid = stripAwareGridDiameter(bw, bh, k);
      const dToSize = verticalStrip ? 0.97 : horizontalStrip ? 0.952 : 0.9;
      const fromGrid = (dGrid * dToSize) / visScale;
      let size = Math.min(fromGrid, cap);
      size = Math.max(0.25, size);
      /** 面積が大きく人数が少ない県（千葉など）で格子＋cap が大きく取りすぎるのを抑える */
      const tArea = prefAreaNormalizedT(prefArea);
      if (k <= 5 && tArea > 0.52) {
        size *= Math.min(1, 0.7 + 0.065 * k);
      }
      const rGeo = (size * visScale) / 2;
      const positions = layoutContributorsInPolygon(poly, b, all, [ax, ay], rGeo);
      const cx = positions.reduce((s, p) => s + p.x, 0) / k;
      const cy = positions.reduce((s, p) => s + p.y, 0) / k;
      let minSizeFloor = Math.max(0.12, minIconDiameterFromArea(prefArea) * 0.035);
      minSizeFloor = Math.max(minSizeFloor, size * 0.42);
      items.push({
        code,
        cx,
        cy,
        positions,
        size,
        contributors: all,
        minSizeFloor,
        prefArea,
        clusterScale: 1,
        poly,
        bounds: b,
        anchor: [ax, ay],
      });
    }
    relaxClusterSizes(items, visScale);

    const runIntraOverlapResolve = () => {
      for (const it of items) {
        const nk = it.contributors.length;
        if (nk < 2) continue;
        const rFinal = Math.max((it.size * visScale) / 2, 0.08);
        resolveCircleOverlapsInPolygon(
          it.positions,
          2 * rFinal * 1.04,
          it.poly,
          it.anchor[0],
          it.anchor[1],
          it.bounds,
        );
      }
    };

    runIntraOverlapResolve();
    /** 県内で境界へ寄ったあと、県境をまたいだ円同士が再び近づくのでクラスタ間をもう一度締める */
    relaxClusterSizes(items, visScale);
    runIntraOverlapResolve();

    for (const it of items) {
      it.size = Math.max(it.size, it.minSizeFloor);
    }
    /** 底上げで径が戻ると隣県と再衝突しうるので最終調整 */
    relaxClusterSizes(items, visScale);
    runIntraOverlapResolve();

    for (const it of items) {
      it.clusterScale = visScale;
    }

    const globalNodes = buildGlobalAvatarCircleNodes(items, visScale);
    resolveGlobalAvatarCircleOverlaps(globalNodes, 0.11, 260);
    resolveGlobalAvatarCircleOverlaps(globalNodes, 0.045, 120);
    runIntraOverlapResolve();

    lastAvatarLayoutRef.current = items;
    return items;
  }, [counts, contributorsByPref, mapView.vbW, layoutBusy]);

  return (
    <div className="map-zoom-root">
      <div className="map-zoom-toolbar">
        <button
          type="button"
          className="btn-reset-zoom"
          onClick={() => {
            const el = svgRef.current;
            const z = zoomBehaviorRef.current;
            if (el && z) select(el).call(z.transform, zoomIdentity);
          }}
        >
          ズームをリセット
        </button>
        <span className="map-zoom-hint">
          ドラッグで移動 · ホイールでズーム · ダブルクリックで拡大 · 県ごとに返信者アイコンを 1 人 1 つ表示（位置は d3-force で自動調整）
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={mapView.vb}
        className="japan-map-svg"
        role="img"
        aria-label="日本の都道府県別ヒカマー言及数"
        style={{ touchAction: "none" }}
      >
        <title>ヒカマー都道府県分布</title>
        <defs>
          <clipPath id="avatar-round" clipPathUnits="objectBoundingBox">
            <circle cx={0.5} cy={0.5} r={0.5} />
          </clipPath>
        </defs>
        <g ref={mapLayerRef}>
          {prefCollection.features.map((f) => {
            const code = String(f.id ?? "");
            const n = counts[code] ?? 0;
            const d = pathGen(f as GeoFeature<Geometry>) ?? "";
            const fill = n === 0 ? "#eef2ff" : color(n);
            const name = PREFECTURE_BY_CODE[code]?.name ?? code;
            const people = contributorsByPref[code] ?? [];
            const namesHint =
              people.length > 0
                ? people
                    .slice(0, 5)
                    .map((p) => `@${p.screenName}`)
                    .join(", ") + (people.length > 5 ? " …" : "")
                : "";
            return (
              <path
                key={code}
                d={d}
                fill={fill}
                stroke="#334155"
                strokeWidth={0.35}
                vectorEffect="non-scaling-stroke"
              >
                <title>
                  {name}: {n} 件{namesHint ? ` — ${namesHint}` : ""}
                </title>
              </path>
            );
          })}
          {avatarClusters.map((cl) => {
            const d = cl.size * cl.clusterScale;
            const r = d / 2;
            return (
              <g key={`avatars-${cl.code}`} style={{ pointerEvents: "none" }}>
                {cl.contributors.map((u, i) => {
                  const p = cl.positions[i];
                  if (!p) return null;
                  return (
                    <g key={`${cl.code}-${u.screenName}-${i}`} transform={`translate(${p.x},${p.y})`}>
                      <image
                        href={u.profileImage}
                        x={-r}
                        y={-r}
                        width={d}
                        height={d}
                        clipPath="url(#avatar-round)"
                        preserveAspectRatio="xMidYMid slice"
                      >
                        <title>@{u.screenName}</title>
                      </image>
                      <circle
                        cx={0}
                        cy={0}
                        r={r}
                        fill="none"
                        stroke="#fff"
                        strokeWidth={0.5}
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
