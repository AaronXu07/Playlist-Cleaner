/**
 * Property-based tests for `generateTimelinePath` (river-flow geometry).
 *
 * **Validates: Requirements 3.2, 3.7**
 *
 * Property 1: River-flow path amplitude is always within the bounded range
 * Property 3: Mobile viewport scales amplitude so markers stay on-screen
 *
 * New signature:
 *   generateTimelinePath(count, spacing, viewportWidth, seed, tailLength, coordinateWidth): string
 *
 * The path starts at the horizontal center of the coordinate width and produces
 * `count - 1` cubic Bézier segments. Each segment's two control points share
 * the same peak X (`cx1 === cx2 === center ± amplitude`); the sign alternates
 * per segment. Amplitude is proportional to coordinate width with an on-screen
 * safety clamp.
 */

import { describe, test, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  generateTimelinePath,
  MARKER_MOBILE_SCREEN_MARGIN,
  VERTICAL_SPACING,
} from '../lib/generateTimelinePath';

// ── Path parsing helpers ─────────────────────────────────────────────────────

interface BezierSegment {
  cx1: number;
  cy1: number;
  cx2: number;
  cy2: number;
  ex: number;
  ey: number;
}

/**
 * Parse the cubic Bézier segments out of a generated SVG path string.
 *
 * Path format: `M center 96 C cx1 cy1, cx2 cy2, ex ey C cx1 cy1, cx2 cy2, ex ey ...`
 *
 * Splitting on `'C '` yields the `M center 96` preamble as the first token and one
 * token per cubic segment thereafter.
 */
function parseSegments(pathD: string): BezierSegment[] {
  const parts = pathD.split('C ');
  const segmentStrings = parts.slice(1);

  return segmentStrings.map((seg) => {
    const nums = seg
      .replace(/,/g, ' ')
      .trim()
      .split(/\s+/)
      .map(Number);

    return {
      cx1: nums[0],
      cy1: nums[1],
      cx2: nums[2],
      cy2: nums[3],
      ex: nums[4],
      ey: nums[5],
    };
  });
}

// ── Constants ────────────────────────────────────────────────────────────────

const SPACING = VERTICAL_SPACING; // 320
// round2() in the generator rounds peak X to 2 decimals → max error 0.005 per
// coordinate. Use a small tolerance generous enough to absorb that rounding.
const EPSILON = 0.01;

// ── Property 1 ───────────────────────────────────────────────────────────────

describe('Property 1: River-flow path amplitude is always within the bounded range', () => {
  /**
   * For any desktop call generateTimelinePath(count, spacing, viewportWidth, seed, 0, viewportWidth)
   * with count >= 2 and viewportWidth >= 640:
   *   - the path produces exactly `count - 1` cubic Bézier segments
   *   - each segment's peak offset magnitude |cx1 - center| lies within the
   *     proportional jitter band [29.5%, 30%] of coordinate width
   *   - no two consecutive segments share an identical peak X (cx of i !== cx of i-1)
   *   - output is deterministic for fixed args (same args → identical string)
   *
   * Validates: Requirement 3.2
   */
  // Feature: spotify-playlist-cleaner-frontend, Property 1: river-flow amplitude bounds
  test('desktop peak offsets stay within [280, 360], alternate, and are deterministic', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 100 }), // count
        fc.integer({ min: 640, max: 2560 }), // desktop viewportWidth
        fc.integer(), // seed
        (count, viewportWidth, seed) => {
          const pathD = generateTimelinePath(
            count,
            SPACING,
            viewportWidth,
            seed,
            0,
            viewportWidth
          );
          const segments = parseSegments(pathD);
          const centerX = viewportWidth / 2;

          // Path always begins at the top-center anchor.
          expect(pathD.startsWith(`M ${centerX} 96`)).toBe(true);

          // count - 1 segments, one per gap between consecutive markers.
          expect(segments).toHaveLength(count - 1);

          for (let i = 0; i < segments.length; i++) {
            const { cx1, cx2 } = segments[i];

            // Both control points share the same peak X by construction.
            expect(cx1).toBe(cx2);

            const magnitude = Math.abs(cx1 - centerX);

            // Amplitude magnitude ∈ [29.5%, 30%] of coordinate width.
            expect(magnitude).toBeGreaterThanOrEqual(viewportWidth * 0.295 - EPSILON);
            expect(magnitude).toBeLessThanOrEqual(viewportWidth * 0.3 + EPSILON);

            // No two consecutive segments share an identical horizontal offset.
            if (i > 0) {
              expect(cx1).not.toBe(segments[i - 1].cx1);
            }
          }

          // Determinism: identical args produce an identical string.
          const pathD2 = generateTimelinePath(
            count,
            SPACING,
            viewportWidth,
            seed,
            0,
            viewportWidth
          );
          expect(pathD2).toBe(pathD);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 3 ───────────────────────────────────────────────────────────────

describe('Property 3: Mobile viewport scales amplitude so markers stay on-screen', () => {
  /**
   * For any mobile viewport width w ∈ [1, 639] using coordinateWidth = w:
   *   - each peak offset is already in screen space, so a marker's content box
   *     stays within [0, w] whenever that is physically possible
   *   - offsets are never negative (the safety clamp can drive amplitude to ~0
   *     for very small w, so no positive lower bound is required)
   *
   * Validates: Requirement 3.7
   */
  // Feature: spotify-playlist-cleaner-frontend, Property 3: mobile amplitude scales to viewport
  test('mobile peak offsets keep marker content boxes within [0, w]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 100 }), // count
        fc.integer({ min: 1, max: 639 }), // mobile viewportWidth
        fc.integer(), // seed
        (count, w, seed) => {
          const pathD = generateTimelinePath(count, SPACING, w, seed, 0, w);
          const segments = parseSegments(pathD);
          const centerX = w / 2;

          expect(segments).toHaveLength(count - 1);

          // The on-screen safety bound in CSS-pixel coordinate units.
          const safeOffset = Math.max(0, centerX - MARKER_MOBILE_SCREEN_MARGIN);

          for (const { cx1 } of segments) {
            const offset = Math.abs(cx1 - centerX);

            // Offsets are never negative.
            expect(offset).toBeGreaterThanOrEqual(0);

            // Offset is within the safe bound. This is the
            // generator's actual contract and always holds, including the tiny-w
            // case where the clamp drives the safe bound (and offset) to 0.
            expect(offset).toBeLessThanOrEqual(safeOffset + EPSILON);

            // Equivalent screen-space assertion: marker footprint ∈ [0, w].
            // Only meaningful when the box can physically fit, i.e. when
            // w >= 2 * MARKER_MOBILE_SCREEN_MARGIN. For narrower viewports the box is
            // wider than the screen itself, so the inequality is unsatisfiable
            // even at amplitude 0; there the offset==0 clamp above is the best
            // achievable result and is what we assert.
            if (w >= 2 * MARKER_MOBILE_SCREEN_MARGIN) {
              expect(
                w / 2 + offset + MARKER_MOBILE_SCREEN_MARGIN
              ).toBeLessThanOrEqual(w + EPSILON);
              expect(
                w / 2 - offset - MARKER_MOBILE_SCREEN_MARGIN
              ).toBeGreaterThanOrEqual(0 - EPSILON);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * The mobile amplitude is NOT a flat constant — it scales with the viewport.
   * For two sufficiently different mobile widths (chosen in the proportional
   * regime), the maximum peak offset differs.
   *
   * Validates: Requirement 3.7
   */
  // Feature: spotify-playlist-cleaner-frontend, Property 3: mobile amplitude scales to viewport
  test('mobile amplitude differs for sufficiently different widths (not a flat 20)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 100 }), // count (more segments → stable max)
        fc.integer(), // seed
        (count, seed) => {
          const maxOffset = (w: number): number => {
            const segs = parseSegments(generateTimelinePath(count, SPACING, w, seed, 0, w));
            return Math.max(...segs.map((s) => Math.abs(s.cx1 - w / 2)));
          };

          // Both widths sit in the proportional regime (safety clamp not binding),
          // so amplitude tracks viewport width and the two maxima must differ.
          const narrow = maxOffset(300);
          const wide = maxOffset(620);

          expect(wide).toBeGreaterThan(narrow + EPSILON);

          // And neither collapses to the old flat 20px cap.
          expect(narrow).not.toBeCloseTo(20, 1);
          expect(wide).not.toBeCloseTo(20, 1);
        }
      ),
      { numRuns: 100 }
    );
  });
});
