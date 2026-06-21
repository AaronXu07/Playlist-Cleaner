/**
 * Property-based tests for `computeMarkerDistribution` — seeded, jittered
 * arc-length marker distribution along the Timeline_SVG river path.
 *
 * **Validates: Requirements 3.1, 3.5, 3.9, 4.1**
 *
 * Property 5: Marker distribution is ordered, in-bounds, and offset from the top.
 *
 * For any marker count in [2, 100] and any integer seed, with the real
 * data-driven path length `totalLength = count * VERTICAL_SPACING (320)`, the
 * returned array must:
 *   - have length === count
 *   - be strictly increasing (chronological order preserved)
 *   - have every position within [0, totalLength]
 *   - keep consecutive positions at least the effective minimum spacing apart
 *   - place the first position within [0, TIMELINE_TOP_OFFSET (96)]
 *   - be deterministic (same inputs ⇒ identical array)
 */

import { describe, test, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  computeMarkerDistribution,
  DEFAULT_MARKER_MIN_SPACING,
} from '../lib/markerDistribution';
import {
  VERTICAL_SPACING,
  TIMELINE_TOP_OFFSET,
} from '../lib/generateTimelinePath';

// Defaults the implementation applies when no options are supplied.
const MIN_SPACING = DEFAULT_MARKER_MIN_SPACING; // VERTICAL_SPACING / 2 = 160
const TOP_OFFSET = TIMELINE_TOP_OFFSET; // 96
const EPSILON = 1e-6;

/**
 * Mirror the implementation's feasibility cap so the spacing assertion is
 * exactly correct. The implementation internally caps the requested minimum
 * spacing to:
 *   feasibleMax = ((totalLength - topOffset) / (count - 1)) * 0.999
 * and uses `effectiveMin = min(requestedMinSpacing, feasibleMax)`.
 */
function effectiveMinSpacing(count: number, totalLength: number): number {
  const feasibleMax = ((totalLength - TOP_OFFSET) / (count - 1)) * 0.999;
  return Math.min(MIN_SPACING, feasibleMax);
}

describe('Property 5: marker distribution ordering/bounds/top-offset/determinism', () => {
  // Feature: spotify-playlist-cleaner-frontend, Property 5: marker distribution ordering/bounds/top-offset/determinism
  test(
    'property: positions are ordered, in-bounds, top-offset, min-spaced, and deterministic',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 100 }),
          fc.integer(),
          (count, seed) => {
            // Real layout: data-driven path length is count * VERTICAL_SPACING.
            const totalLength = count * VERTICAL_SPACING;

            const positions = computeMarkerDistribution(count, totalLength, seed);

            // ── length === count ──────────────────────────────────────────
            expect(positions).toHaveLength(count);

            // ── strictly increasing (chronological order preserved) ───────
            for (let i = 1; i < positions.length; i++) {
              expect(positions[i]).toBeGreaterThan(positions[i - 1]);
            }

            // ── all positions within [0, totalLength] ─────────────────────
            for (const pos of positions) {
              expect(pos).toBeGreaterThanOrEqual(0);
              expect(pos).toBeLessThanOrEqual(totalLength);
            }

            // ── consecutive positions >= effective minimum spacing ────────
            const minSpacing = effectiveMinSpacing(count, totalLength);
            for (let i = 1; i < positions.length; i++) {
              const gap = positions[i] - positions[i - 1];
              expect(gap).toBeGreaterThanOrEqual(minSpacing - EPSILON);
            }

            // ── first position within the [0, TIMELINE_TOP_OFFSET] band ───
            expect(positions[0]).toBeGreaterThanOrEqual(0);
            expect(positions[0]).toBeLessThanOrEqual(TOP_OFFSET);

            // ── determinism: identical inputs ⇒ identical array ───────────
            const again = computeMarkerDistribution(count, totalLength, seed);
            expect(again).toEqual(positions);
          }
        ),
        { numRuns: 200 }
      );
    },
    { timeout: 60_000 }
  );
});

describe('computeMarkerDistribution edge cases', () => {
  test('count === 1 returns [0] (single marker at path start)', () => {
    expect(computeMarkerDistribution(1, 320, 42)).toEqual([0]);
  });

  test('count <= 0 returns [] (no markers)', () => {
    expect(computeMarkerDistribution(0, 320, 42)).toEqual([]);
    expect(computeMarkerDistribution(-5, 320, 42)).toEqual([]);
  });
});
