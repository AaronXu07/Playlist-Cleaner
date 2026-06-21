/**
 * Timeline river-flow path generator.
 *
 * Produces the SVG `d` attribute for the Landing_Page "river" timeline. The
 * path weaves alternately left and right of the horizontal center line within
 * the caller's SVG coordinate width to create a pronounced river flow.
 *
 * Amplitude (the horizontal peak offset from center) is 30% of the caller's
 * coordinate width, plus seeded jitter, with a mobile safety clamp so a
 * Year_Marker's full content box stays on-screen.
 *
 * Geometry is deterministic for a fixed `seed` (mulberry32 PRNG).
 *
 * @see Requirements 3.1, 3.2, 3.7
 */

// ── Geometry constants (imported by TimelineSVG) ─────────────────────────────

/** Vertical scroll height contributed per marker, in viewBox units (px). */
export const VERTICAL_SPACING = 320;

/** Gap before the path / first marker, in viewBox units (px). Multiple of 8. */
export const TIMELINE_TOP_OFFSET = 96;

/** Extra straight segment after the final marker so the path reaches the CTA. */
export const PATH_TAIL = 220;

/** Extra scroll room after the CTA at the bottom of the landing timeline. */
export const TIMELINE_BOTTOM_PADDING = 112;

/** Lower bound of the desktop horizontal peak offset magnitude, in viewBox px. */
export const DESKTOP_AMPLITUDE_MIN = 295;

/** Upper bound of the desktop horizontal peak offset magnitude, in viewBox px. */
export const DESKTOP_AMPLITUDE_MAX = 305;

/** Viewport width (px) at/above which the desktop amplitude range applies. */
export const MOBILE_BREAKPOINT = 640;

/** Gap between the sampled path peak and a Year_Marker content box. */
export const MARKER_PATH_GAP = 4;

/**
 * Mobile Year_Marker width in screen pixels.
 *
 * The marker sits fully outside the curve:
 * 56px album art + 6px flex gap + 88px text column.
 */
export const MARKER_MOBILE_CONTENT_BOX = 150;

/** Mobile edge room needed from the path peak to the screen edge. */
export const MARKER_MOBILE_SCREEN_MARGIN =
  MARKER_PATH_GAP + MARKER_MOBILE_CONTENT_BOX;

/** Default coordinate width retained for callers that do not pass a rendered width. */
const VIEWBOX_WIDTH = 1000;

/**
 * Deterministic pseudo-random number generator (mulberry32).
 * Returns a value in [0, 1) for a given seed.
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

/** Round to 2 decimal places for clean, stable path strings. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Resolves the inclusive amplitude magnitude range (in path coordinate units)
 * for a given viewport width.
 *
 * Target: 60% peak-to-peak of the container width, meaning each side peaks at
 * 30% from center.
 *
 * Desktop keeps the pronounced 30% weave. Mobile uses the same target, clamped
 * by the rendered marker footprint so labels remain within the viewport.
 */
function amplitudeRange(
  viewportWidth: number,
  coordinateWidth = VIEWBOX_WIDTH
): { min: number; max: number } {
  const safeCoordinateWidth =
    Number.isFinite(coordinateWidth) && coordinateWidth > 0
      ? coordinateWidth
      : VIEWBOX_WIDTH;
  const centerX = safeCoordinateWidth / 2;

  // Target 60% peak-to-peak → each side = 30% of the path coordinate width.
  const target = safeCoordinateWidth * 0.3;

  // Safety: on mobile, ensure marker cards don't clip the screen edge.
  const safeWidth = viewportWidth > 0 ? viewportWidth : MOBILE_BREAKPOINT;
  const markerScreenMarginInCoords =
    MARKER_MOBILE_SCREEN_MARGIN * (safeCoordinateWidth / safeWidth);
  const maxSafe = Math.max(0, centerX - markerScreenMarginInCoords);

  // Desktop keeps the pronounced 30% weave; mobile clamps to the space left
  // after the marker's full outside-the-curve footprint.
  const amplitude =
    safeWidth < MOBILE_BREAKPOINT ? Math.min(target, maxSafe) : target;
  if (amplitude <= 0) {
    return { min: 0, max: 0 };
  }

  // Keep a tiny ±0.5% jitter band for visual variation.
  const jitter = Math.max(1, safeCoordinateWidth * 0.005);
  return {
    min: Math.max(0, amplitude - jitter),
    max: amplitude,
  };
}

/**
 * Generates an SVG path `d` attribute for the river-flow timeline.
 *
 * The path starts at the top-center anchor (`TIMELINE_TOP_OFFSET`) and produces
 * `count - 1` cubic Bézier segments, one per gap between consecutive markers.
 * Each segment bulges to a seeded
 * pseudo-random horizontal peak whose magnitude lies in the resolved amplitude
 * range; the sign alternates per segment so the river crosses center at every
 * anchor. No two consecutive segments share an identical peak offset (when the
 * range permits): repeated PRNG draws are nudged to the next distinct in-range
 * value.
 *
 * An optional `tailLength` appends a final straight vertical line from the
 * last anchor down to the sign-in button, so the animated draw finishes
 * exactly at the CTA rather than stopping at the last song marker.
 *
 * @param count          Number of markers (path has `count - 1` wavy segments)
 * @param spacing        Vertical spacing per segment in viewBox px (VERTICAL_SPACING = 320)
 * @param viewportWidth  Current viewport width in px; drives the amplitude range
 * @param seed           Deterministic pseudo-random seed (integer)
 * @param tailLength     Extra straight px to append after the last marker (default 0)
 * @param coordinateWidth SVG coordinate width used for X positions (default 1000)
 * @returns SVG path `d` string
 */
export function generateTimelinePath(
  count: number,
  spacing: number,
  viewportWidth: number,
  seed: number,
  tailLength = 0,
  coordinateWidth = VIEWBOX_WIDTH
): string {
  const safeCoordinateWidth =
    Number.isFinite(coordinateWidth) && coordinateWidth > 0
      ? coordinateWidth
      : VIEWBOX_WIDTH;
  const centerX = round2(safeCoordinateWidth / 2);

  // The path always starts at the top-center anchor, offset from the top edge.
  const start = `M ${centerX} ${TIMELINE_TOP_OFFSET}`;
  if (count <= 1) {
    return tailLength > 0
      ? `${start} L ${centerX} ${round2(TIMELINE_TOP_OFFSET + tailLength)}`
      : start;
  }

  const segmentCount = count - 1;
  const { min: ampMin, max: ampMax } = amplitudeRange(
    viewportWidth,
    safeCoordinateWidth
  );
  const span = ampMax - ampMin;

  const rand = mulberry32(seed);

  // Draw a peak-offset magnitude per segment, enforcing that no two consecutive
  // segments share an identical offset (when the range is non-degenerate).
  const amplitudes: number[] = [];
  for (let i = 0; i < segmentCount; i++) {
    let amp = round2(ampMin + rand() * span);

    if (i > 0 && span > 0) {
      let guard = 0;
      while (amp === amplitudes[i - 1] && guard < 100) {
        // Step to a distinct value, wrapping within [ampMin, ampMax).
        amp = round2(ampMin + (((amp - ampMin) + span * 0.137 + 0.01) % span));
        guard++;
      }
    }

    amplitudes.push(amp);
  }

  const parts: string[] = [start];

  for (let i = 0; i < segmentCount; i++) {
    const yStart = TIMELINE_TOP_OFFSET + i * spacing;
    const yEnd = TIMELINE_TOP_OFFSET + (i + 1) * spacing;

    // Even segments weave right (+), odd segments weave left (-).
    const sign = i % 2 === 0 ? 1 : -1;
    const peakX = round2(centerX + sign * amplitudes[i]);

    // Symmetric bulge: both control points sit at the peak X, so the curve
    // pushes out to `peakX` and returns to center at the next anchor.
    const cx1 = peakX;
    const cy1 = round2(yStart + spacing / 3);
    const cx2 = peakX;
    const cy2 = round2(yEnd - spacing / 3);
    const ex = centerX;
    const ey = yEnd;

    parts.push(`C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`);
  }

  // Optional straight tail — runs from the last marker anchor straight down
  // to the sign-in button so the draw animation finishes at the CTA.
  if (tailLength > 0) {
    const lastY = TIMELINE_TOP_OFFSET + (segmentCount) * spacing;
    parts.push(`L ${centerX} ${round2(lastY + tailLength)}`);
  }

  return parts.join(' ');
}

/**
 * Returns approximate cumulative Y positions for each marker (spacing-based).
 *
 * NOTE: Precise marker placement now comes from the seeded jittered arc-length
 * sampler in `lib/markerDistribution.ts` (see task 20) combined with
 * `SVGPathElement.getPointAtLength()`. This helper is retained for backward
 * compatibility with existing imports and returns the anchor Y coordinate for
 * each marker, offset by `TIMELINE_TOP_OFFSET`.
 *
 * @param count    Number of markers
 * @param spacing  Vertical spacing per segment in viewBox px (VERTICAL_SPACING = 320)
 * @returns Array of anchor Y positions, length == count
 */
export function getMarkerSpacings(count: number, spacing: number): number[] {
  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    positions.push(TIMELINE_TOP_OFFSET + i * spacing);
  }
  return positions;
}
