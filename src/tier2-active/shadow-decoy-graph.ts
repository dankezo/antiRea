/**
 * Shadow decoy graphs (BLA-02, PASS-lab 2026-11-14).
 *
 * Standalone decoy records have a structural weakness: an attacker who
 * reconstructs the dataset offline can run referential-integrity
 * filtering - drop records whose author/series references do not
 * resolve, whose chain links are asymmetric, whose declared counts do
 * not match, whose timestamps run backwards - and the decoys fall out,
 * because a lone synthetic record cannot satisfy closure rules it was
 * never built under. A shadow graph is a decoy SET built to satisfy
 * those rules: a small, closed, internally consistent synthetic graph
 * (authors, series, chained records) that an offline reconstruction
 * absorbs as if it were real, contaminating the clone instead of being
 * filtered out of it.
 *
 * Lab record (registration frozen before measurement, seed family
 * 20301xxx, block 20301201-20301212): a fixpoint referential-integrity
 * attacker removed 100% of standalone decoys (720/720 pooled over 12
 * instances) and 0% of shadow-graph decoys (0/720); the decoy-free
 * control lost 0% of real records (0/24,000); generation cost was
 * ~1x the standalone arm. The generator takes NO input from the real
 * graph, so by construction it leaks nothing about real data beyond
 * the shared schema (field existence and type).
 *
 * What this does NOT claim, stated plainly:
 *
 * - Not resistance to statistical fingerprinting: the shadow graph's
 *   distributions are deliberately NOT fitted to the host's real data
 *   (fitting them would leak the real distributions - the RSH-01
 *   trade-off). A determined attacker with a good model of the real
 *   population may still spot the subgraph statistically. Consistency
 *   is the property measured; population mimicry is not claimed.
 * - Not a serving layer: this module only GENERATES the graph and can
 *   CHECK a graph's internal closure. Placement is the host's contract:
 *   shadow entities must be reachable only through the enumeration
 *   surfaces an extractor walks (list/search/sitemap-style surfaces),
 *   never linked from a real record, never served on a surface a
 *   legitimate user navigates - the C35 off-graph placement discipline.
 *   If a real record ever references a shadow id, the two graphs merge
 *   and both the evidence value and the no-legit-harm property die.
 * - Advisory evidence only: a client absorbing the shadow graph is
 *   proof of bulk reconstruction, feeding the same evidence channels as
 *   canary touches - it is never, by itself, grounds to ban a user who
 *   might have received shadow records inside a bulk response.
 *
 * Deterministic per seed (FNV-1a + mulberry32, the pair the Canary
 * Maze and Decoy Mirage use): the same options regenerate the same
 * graph byte-for-byte, so a host can regenerate instead of storing,
 * and can rotate the graph by rotating the seed. Zero dependencies.
 */

export interface ShadowAuthor {
  id: string;
  kind: "author";
  /** Declared record count; always equals the actual generated count. */
  recordCount: number;
}

export interface ShadowSeries {
  id: string;
  kind: "series";
  authorId: string;
  /** Declared record count; always equals the actual generated count. */
  recordCount: number;
}

export interface ShadowRecord {
  id: string;
  kind: "record";
  authorId: string;
  seriesId: string;
  /** Previous record in the same series chain, or null at the head. */
  prevId: string | null;
  /** Next record in the same series chain, or null at the tail. */
  nextId: string | null;
  /** Day offset from the graph's base day; non-decreasing along the chain. */
  tsDay: number;
  /** Category label drawn from the host-supplied vocabulary. */
  category: string;
  /** Synthetic title length in characters (a shape field, not content). */
  titleLen: number;
}

export interface ShadowDecoyGraph {
  authors: ShadowAuthor[];
  series: ShadowSeries[];
  records: ShadowRecord[];
}

export interface ShadowDecoyGraphOptions {
  /**
   * Seed for the deterministic generator. Rotate it to rotate the
   * whole graph. Strings are hashed with FNV-1a.
   */
  seed: string | number;
  /** Number of shadow authors. Default 5. */
  authors?: number;
  /** Series per author. Default 1. */
  seriesPerAuthor?: number;
  /** Records per series chain. Default 12. */
  recordsPerSeries?: number;
  /**
   * Id prefix for every shadow entity (authors `Pau-N`, series
   * `Pse-N`, records `Prec-N`). Use a prefix that cannot collide with
   * real ids. Default "sh-".
   */
  idPrefix?: string;
  /**
   * Category vocabulary, HOST-SUPPLIED (RSH-01): pass labels from the
   * host's own domain so the decoys speak the host's dialect instead
   * of a library accent. When omitted, neutral labels ("cat-0" ...)
   * are used - visible as synthetic under inspection, so supplying a
   * vocabulary is strongly recommended.
   */
  categories?: readonly string[];
  /** Number of neutral categories when `categories` is omitted. Default 8. */
  categoryCount?: number;
  /** Base day offset for record timestamps. Default 0. */
  baseDay?: number;
  /** Day span over which chain timestamps spread. Default 380. */
  daySpan?: number;
}

/* FNV-1a + mulberry32: the deterministic pair used across the decoy modules. */
const hashSeed = (input: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  const n = Math.floor(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * Generate a closed, internally consistent shadow decoy graph.
 * Invariants (all checkable with `verifyShadowGraphClosure`): every
 * record's authorId and seriesId resolve inside the graph; every
 * series' authorId resolves; declared recordCounts equal actual
 * counts; chain prev/next links are symmetric; timestamps are
 * non-decreasing along each chain.
 */
export function generateShadowDecoyGraph(options: ShadowDecoyGraphOptions): ShadowDecoyGraph {
  const authorCount = clampInt(options.authors, 5, 1, 500);
  const seriesPerAuthor = clampInt(options.seriesPerAuthor, 1, 1, 50);
  const recordsPerSeries = clampInt(options.recordsPerSeries, 12, 1, 10_000);
  const prefix = typeof options.idPrefix === "string" && options.idPrefix.length > 0 ? options.idPrefix : "sh-";
  const baseDay = clampInt(options.baseDay, 0, 0, 1_000_000);
  const daySpan = clampInt(options.daySpan, 380, 1, 100_000);
  const categories: readonly string[] =
    options.categories && options.categories.length > 0
      ? options.categories
      : Array.from({ length: clampInt(options.categoryCount, 8, 1, 256) }, (_, i) => `cat-${i}`);

  const seedMaterial = typeof options.seed === "number" ? `n:${options.seed}` : `s:${options.seed}`;
  const rand = mulberry32(hashSeed(`shadow-graph:${seedMaterial}`));

  const authors: ShadowAuthor[] = [];
  const series: ShadowSeries[] = [];
  const records: ShadowRecord[] = [];

  for (let a = 1; a <= authorCount; a++) {
    const authorId = `${prefix}au-${a}`;
    authors.push({ id: authorId, kind: "author", recordCount: seriesPerAuthor * recordsPerSeries });
    for (let s = 1; s <= seriesPerAuthor; s++) {
      const seriesIndex = (a - 1) * seriesPerAuthor + s;
      const seriesId = `${prefix}se-${seriesIndex}`;
      series.push({ id: seriesId, kind: "series", authorId, recordCount: recordsPerSeries });
      let day = baseDay + Math.floor(rand() * Math.max(1, Math.floor(daySpan / 4)));
      for (let j = 1; j <= recordsPerSeries; j++) {
        day += Math.floor(rand() * Math.max(1, Math.floor(daySpan / Math.max(1, recordsPerSeries))));
        if (day > baseDay + daySpan) day = baseDay + daySpan;
        records.push({
          id: `${prefix}rec-${seriesIndex}-${j}`,
          kind: "record",
          authorId,
          seriesId,
          prevId: j > 1 ? `${prefix}rec-${seriesIndex}-${j - 1}` : null,
          nextId: j < recordsPerSeries ? `${prefix}rec-${seriesIndex}-${j + 1}` : null,
          tsDay: day,
          category: categories[Math.floor(rand() * categories.length)] as string,
          titleLen: 20 + Math.floor(rand() * 60),
        });
      }
    }
  }
  return { authors, series, records };
}

export interface ShadowGraphClosureResult {
  ok: boolean;
  /** Human-readable invariant violations; empty when `ok`. */
  violations: string[];
}

/**
 * Check a shadow graph's internal closure - the same invariants an
 * attacker's referential-integrity filter tests. Hosts run this after
 * generation (and after any host-side transformation of the graph)
 * to prove the graph still satisfies them before serving it.
 */
export function verifyShadowGraphClosure(graph: ShadowDecoyGraph): ShadowGraphClosureResult {
  const violations: string[] = [];
  const authorById = new Map(graph.authors.map((x) => [x.id, x]));
  const seriesById = new Map(graph.series.map((x) => [x.id, x]));
  const recordById = new Map(graph.records.map((x) => [x.id, x]));

  const actualByAuthor = new Map<string, number>();
  const actualBySeries = new Map<string, number>();
  for (const r of graph.records) {
    actualByAuthor.set(r.authorId, (actualByAuthor.get(r.authorId) ?? 0) + 1);
    actualBySeries.set(r.seriesId, (actualBySeries.get(r.seriesId) ?? 0) + 1);
  }

  for (const s of graph.series) {
    if (!authorById.has(s.authorId)) violations.push(`series ${s.id}: author ${s.authorId} does not resolve`);
    if ((actualBySeries.get(s.id) ?? 0) !== s.recordCount) {
      violations.push(`series ${s.id}: declared recordCount ${s.recordCount} != actual ${actualBySeries.get(s.id) ?? 0}`);
    }
  }
  for (const a of graph.authors) {
    if ((actualByAuthor.get(a.id) ?? 0) !== a.recordCount) {
      violations.push(`author ${a.id}: declared recordCount ${a.recordCount} != actual ${actualByAuthor.get(a.id) ?? 0}`);
    }
  }
  for (const r of graph.records) {
    if (!authorById.has(r.authorId)) violations.push(`record ${r.id}: author ${r.authorId} does not resolve`);
    if (!seriesById.has(r.seriesId)) violations.push(`record ${r.id}: series ${r.seriesId} does not resolve`);
    if (r.prevId !== null) {
      const p = recordById.get(r.prevId);
      if (!p) violations.push(`record ${r.id}: prev ${r.prevId} does not resolve`);
      else {
        if (p.nextId !== r.id) violations.push(`record ${r.id}: prev/next asymmetry with ${p.id}`);
        if (p.seriesId !== r.seriesId) violations.push(`record ${r.id}: prev ${p.id} is in another series`);
        if (p.tsDay > r.tsDay) violations.push(`record ${r.id}: timestamp runs backwards along the chain`);
      }
    }
    if (r.nextId !== null) {
      const n = recordById.get(r.nextId);
      if (!n) violations.push(`record ${r.id}: next ${r.nextId} does not resolve`);
      else if (n.prevId !== r.id) violations.push(`record ${r.id}: next/prev asymmetry with ${n.id}`);
    }
  }
  return { ok: violations.length === 0, violations };
}
