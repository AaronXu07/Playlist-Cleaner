/**
 * Seeded, jittered arc-length marker distribution.
 *
 * Computes the arc-length sample positions used to place Year_Markers along the
 * river-flow Timeline_SVG path. Instead of sampling the path at uniform
 * `i / (count - 1)` fractions, this module starts from evenly-spaced anchors and
 * applies a *seeded* jitter so the markers appear unevenly spaced (an organic,
 * non-mechanical rhythm) while still preserving strict chronological order.
 *
 * The returned numbers are arc-length offsets to be passed to
 * `SVGPathElement.getPointAtLength()` by `TimelineSVG`.
 *
 * Design contract (see design.md "Marker distribution (jittered arc-length
 * sampling)" and requirements 3.1, 3.5, 3.9, 4.1):
 *   1. Start from evenly-spaced anchors `Lᵢ = totalLength * i / (count - 1)`.
 *   2. Apply a deterministic, seed-derived jitter `δᵢ` to each *interior* anchor,
 *      bounded to a fraction of the inter-anchor gap. Endpoints (first/last) are
 *      not jittered so the path is sampled from its true start/end.
 *   3. Clamp and sort so positions are strictly increasing and at least
 *      `minSpacing` apart (so adjacent marker content boxes never overlap).
 *   4. Clamp the first position into the `[0, topOffset]` band (so the earliest
 *      marker sits at/below the 96px Timeline_Top_Offset, never flush to the top)
 *      and clamp the last position to be `<= totalLength`. All positions stay
 *      within `[0, totalLength]`.
 *
 * The function is **pure** (no DOM, no globals, no `Date`/`Math.random`) and
 * **deterministic** for a fixed `seed`, so server-render and client hydration
 * always agree on identical marker positions.
 *
 * @see Requirements 3.1, 3.5, 3.9, 4.1
 */

import {
  TIMELINE_TOP_OFFSET as SHARED_TIMELINE_TOP_OFFSET,
  VERTICAL_SPACING as SHARED_VERTICAL_SPACING,
} from './generateTimelinePath';

/**
 * Local fallbacks for the shared geometry constants. We prefer the values
 * exported by `generateTimelinePath.ts`, but defining fallbacks here keeps this
 * module's intent self-documenting and resilient to refactors of the shared
 * module. (A multiple of the 8px spacing unit; px of scroll height per marker.)
 */
const TIMELINE_TOP_OFFSET = SHARED_TIMELINE_TOP_OFFSET ?? 96;
const VERTICAL_SPACING = SHARED_VERTICAL_SPACING ?? 320;

/**
 * Default minimum arc-length spacing between consecutive markers, in px.
 *
 * Half of {@link VERTICAL_SPACING}. With the data-driven `totalLength = count *
 * VERTICAL_SPACING`, the nominal anchor gap is always `> VERTICAL_SPACING`, so
 * this default always leaves slack for jitter while still guaranteeing that two
 * adjacent marker content boxes (48px album art plus title/artist/year text)
 * cannot collide.
 */
export const DEFAULT_MARKER_MIN_SPACING = VERTICAL_SPACING / 2;

/**
 * Default jitter magnitude as a fraction of the inter-anchor gap (±0.4 of the
 * gap). Interior anchors are displaced by up to this fraction in either
 * direction before the min-spacing clamp re-establishes ordering.
 */
export const DEFAULT_JITTER_FRACTION = 0.4;

/** Options controlling the jittered distribution. All optional. */
export interface MarkerDistributionOptions {
  /**
   * Minimum arc-length distance enforced between consecutive markers.
   * Defaults to {@link DEFAULT_MARKER_MIN_SPACING}. Internally capped to a
   * feasible value so the full set always fits within `[0, totalLength]`.
   */
  minSpacing?: number;
  /**
   * Arc-length band the first marker is clamped into (`[0, topOffset]`), so the
   * earliest-year marker renders at/below the 96px Timeline_Top_Offset.
   * Defaults to {@link TIMELINE_TOP_OFFSET}.
   */
  topOffset?: number;
  /**
   * Jitter magnitude as a fraction of the inter-anchor gap. Defaults to
   * {@link DEFAULT_JITTER_FRACTION}.
   */
  jitterFraction?: number;
}

/**
 * Deterministic pseudo-random number generator (mulberry32). Returns a function
 * producing values in `[0, 1)` for a given integer seed. Inlined so this module
 * is standalone and does not depend on a PRNG export elsewhere.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Clamp `value` into the inclusive range `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Computes seeded, jittered arc-length sample positions for marker placement.
 *
 * Given the number of markers, the path's total arc length, and a seed, returns
 * an array of exactly `count` strictly-increasing arc-length positions (each a
 * number to pass to `SVGPathElement.getPointAtLength()`). The result is pure and
 * deterministic for a fixed `seed`, guaranteeing SSR/client hydration agreement.
 *
 * Guarantees on the returned array (for `count >= 2`, `totalLength > 0`):
 *   - length === `count`
 *   - strictly increasing (chronological order preserved)
 *   - every position within `[0, totalLength]`
 *   - consecutive positions at least the effective minimum spacing apart
 *   - the first position within `[0, topOffset]` (at/below the 96px band)
 *   - the last position `<= totalLength`
 *
 * Edge cases: `count <= 0` returns `[]`; `count === 1` returns `[0]` (the path
 * start, which maps to the point at the Timeline_Top_Offset).
 *
 * @param count        Number of markers (= length of the returned array)
 * @param totalLength  Total arc length of the path (e.g. `pathEl.getTotalLength()`)
 * @param seed         Deterministic integer seed (same seed ⇒ identical output)
 * @param options      Optional minimum spacing, top-offset band, and jitter fraction
 * @returns Array of `count` arc-length positions in strictly increasing order
 */
export function computeMarkerDistribution(
  count: number,
  totalLength: number,
  seed: number,
  options: MarkerDistributionOptions = {}
): number[] {
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    // Single marker sits at the path start, which maps to the Top_Offset point.
    return [0];
  }

  const topOffset = clamp(
    options.topOffset ?? TIMELINE_TOP_OFFSET,
    0,
    Math.max(0, totalLength)
  );
  const jitterFraction = Math.max(0, options.jitterFraction ?? DEFAULT_JITTER_FRACTION);

  // Degenerate path: nothing meaningful to distribute. Return zeros so callers
  // never crash; this is unreachable for the real `count * 320` total length.
  if (totalLength <= 0) {
    return new Array(count).fill(0);
  }

  const lastIndex = count - 1;
  const gap = totalLength / lastIndex;

  // Cap the requested minimum spacing to a feasible value so that, starting from
  // `topOffset`, all `count - 1` gaps still fit within `totalLength`. The 0.999
  // factor preserves *strict* increase even in the worst case.
  const requestedMinSpacing = Math.max(0, options.minSpacing ?? DEFAULT_MARKER_MIN_SPACING);
  const feasibleMax = ((totalLength - topOffset) / lastIndex) * 0.999;
  const minSpacing = Math.min(requestedMinSpacing, feasibleMax);

  const rand = mulberry32(seed);

  // 1 & 2: evenly-spaced anchors with seeded jitter on interior anchors only.
  const positions: number[] = [];
  for (let i = 0; i <= lastIndex; i++) {
    const anchor = gap * i;
    if (i === 0 || i === lastIndex) {
      // Endpoints are not jittered: keep the true path start (0) and end.
      positions.push(anchor);
    } else {
      // δᵢ ∈ [-jitterFraction * gap, +jitterFraction * gap]
      const delta = (rand() * 2 - 1) * jitterFraction * gap;
      positions.push(anchor + delta);
    }
  }

  // 4 (first): clamp the earliest marker into the [0, topOffset] top band.
  positions[0] = clamp(positions[0], 0, topOffset);
  // 4 (last): clamp the latest marker to the end of the path.
  positions[lastIndex] = clamp(positions[lastIndex], 0, totalLength);

  // 3 (forward): enforce strictly-increasing order with the minimum spacing.
  for (let i = 1; i <= lastIndex; i++) {
    const lowerBound = positions[i - 1] + minSpacing;
    if (positions[i] < lowerBound) {
      positions[i] = lowerBound;
    }
  }

  // 3 (backward): if the forward pass overshot the path end, pull positions back
  // from the end while preserving the minimum spacing. Feasible because
  // `minSpacing` was capped above.
  if (positions[lastIndex] > totalLength) {
    positions[lastIndex] = totalLength;
    for (let i = lastIndex - 1; i >= 0; i--) {
      const upperBound = positions[i + 1] - minSpacing;
      if (positions[i] > upperBound) {
        positions[i] = upperBound;
      }
    }
    // Keep the first marker within the [0, topOffset] band after the pull-back.
    positions[0] = clamp(positions[0], 0, topOffset);
  }

  return positions;
}
