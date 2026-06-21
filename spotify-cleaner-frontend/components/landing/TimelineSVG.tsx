'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useMotionValue, type MotionValue } from 'framer-motion';
import {
  generateTimelinePath,
  PATH_TAIL,
  TIMELINE_BOTTOM_PADDING,
  VERTICAL_SPACING,
  TIMELINE_TOP_OFFSET,
} from '@/lib/generateTimelinePath';
import { YEAR_MARKERS, YearMarkerDatum } from '@/lib/yearMarkerData';
import YearMarker from '@/components/landing/YearMarker';
import { useAudio } from '@/context/AudioContext';

// ─── Constants ────────────────────────────────────────────────────────────────

const PATH_SEED = 42;

/** Sensible SSR fallback viewport width (desktop) so the path is well-formed pre-hydration. */
const SSR_VIEWPORT_WIDTH = 1280;

/** Fallback scroll viewport height for SSR/tests before layout is measurable. */
const SSR_SCROLL_VIEWPORT_HEIGHT = 800;

/** Extra scroll runway after the CTA so the draw can finish before scroll clamps. */
const BOTTOM_RUNWAY_VIEWPORT_RATIO = 0.45;

// ─── Types ────────────────────────────────────────────────────────────────────

interface MarkerPosition {
  x: number;
  y: number;
}

export interface TimelineSVGProps {
  markers?: YearMarkerDatum[];
  /**
   * Scroll progress (0→1) computed by the parent via `useScroll`. Passing it
   * down (rather than calling `useScroll` here) ensures the scroll container
   * ref is hydrated in the same component that reads it.
   */
  scrollYProgress: MotionValue<number>;
  /** Scrollable parent used to convert scroll pixels into path draw progress. */
  scrollContainerRef?: RefObject<HTMLElement>;
  /** Reports the rendered timeline height so parent overlays can stay aligned. */
  onHeightChange?: (height: number) => void;
  /** Optional CTA rendered at the terminal end of the path (e.g. sign-in button). */
  cta?: ReactNode;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute marker positions along an SVGPathElement near the visual peak of each
 * Bézier segment.
 *
 * The path consists of `count - 1` wavy cubic Bézier segments followed by a
 * straight tail. Middle markers sit near segment peaks, while the first marker
 * anchors the start and the final marker anchors the start of the tail so the
 * sign-in CTA stays visually connected to the last song.
 */
function computeMarkerPositions(
  pathEl: SVGPathElement,
  count: number
): MarkerPosition[] {
  const totalLength = pathEl.getTotalLength();
  // Exclude the straight tail so markers only land on the wavy portion.
  const usableLength = Math.max(0, totalLength - PATH_TAIL);

  if (count <= 0) return [];
  if (count === 1) {
    const pt = pathEl.getPointAtLength(0);
    return [{ x: pt.x, y: pt.y }];
  }

  const segmentCount = count - 1;
  const segmentArcLength = usableLength / segmentCount;

  return Array.from({ length: count }, (_, i) => {
    if (i === 0) {
      // First marker sits at the very start of the path (top-center anchor).
      const pt = pathEl.getPointAtLength(0);
      return { x: pt.x, y: pt.y };
    }

    if (i === count - 1) {
      // Last marker sits at the end of the wavy portion, just before the tail.
      const pt = pathEl.getPointAtLength(usableLength);
      return { x: pt.x, y: pt.y };
    }

    // Segment i-1 runs from arc-length (i-1)*segmentArcLength to i*segmentArcLength.
    // The curve is symmetric, so the segment midpoint is also the visual bulge.
    const peakLength = (i - 0.5) * segmentArcLength;
    const peak = pathEl.getPointAtLength(peakLength);
    return { x: peak.x, y: peak.y };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Convert a vertical target position into a pathLength fraction by walking the
 * real SVG path. This keeps the draw head moving with scroll pixels even though
 * the sinusoidal curve has more arc length than vertical height.
 */
function getPathProgressAtY(pathEl: SVGPathElement, targetY: number): number {
  const totalLength = pathEl.getTotalLength();
  if (!Number.isFinite(totalLength) || totalLength <= 0) return 0;

  const startY = pathEl.getPointAtLength(0).y;
  const endY = pathEl.getPointAtLength(totalLength).y;
  const clampedY = clamp(targetY, startY, endY);

  if (clampedY <= startY) return 0;
  if (clampedY >= endY) return 1;

  let low = 0;
  let high = totalLength;

  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    const point = pathEl.getPointAtLength(mid);
    if (point.y < clampedY) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return clamp(((low + high) / 2) / totalLength, 0, 1);
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * TimelineSVG
 *
 * Renders the scroll-linked river-flow SVG path spanning the full landing-page
 * scroll height (TIMELINE_TOP_OFFSET + markers.length × VERTICAL_SPACING), places
 * YearMarker components at seeded jittered arc-length points along that path, and
 * drives the stroke draw via a Framer Motion `pathLength` MotionValue mapped
 * from real scroll pixels to the measured SVG path.
 *
 * Geometry is fully data-driven from `markers.length` — there is no hardcoded
 * marker count or fixed total height.
 *
 * Requirements: 3.1–3.9, 4.1, 4.2
 */
export default function TimelineSVG({
  markers = YEAR_MARKERS,
  scrollYProgress,
  scrollContainerRef,
  onHeightChange,
  cta,
}: TimelineSVGProps) {
  const count = markers.length;
  const segmentCount = Math.max(0, count - 1);
  // Terminal Y of the path in CSS-pixel SVG units — this is where the CTA sits.
  // The path's last point is the end of the tail segment.
  const terminalY = TIMELINE_TOP_OFFSET + segmentCount * VERTICAL_SPACING + PATH_TAIL;

  // ── Motion / scroll ──────────────────────────────────────────────────────
  const pathLength = useMotionValue(0);
  const pathLengthRef = useRef(pathLength);
  pathLengthRef.current = pathLength;
  const [reducedMotion, setReducedMotion] = useState(false);

  // ── Path geometry state ─────────────────────────────────────────────────
  const [pathD, setPathD] = useState<string>('');
  const [markerPositions, setMarkerPositions] = useState<MarkerPosition[]>([]);
  const [drawProgress, setDrawProgressState] = useState(0);

  // ── Container width tracking ─────────────────────────────────────────────
  // The SVG coordinate width matches the rendered CSS width, so path length,
  // marker X positions, and stroke draw progress all use the same units.
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(SSR_VIEWPORT_WIDTH);
  const [hasMeasuredContainer, setHasMeasuredContainer] = useState(false);
  const [scrollViewportHeight, setScrollViewportHeight] = useState(
    SSR_SCROLL_VIEWPORT_HEIGHT
  );

  // ── Refs ────────────────────────────────────────────────────────────────
  const svgPathRef = useRef<SVGPathElement>(null);

  // ── Audio context ────────────────────────────────────────────────────────
  const { playingUrl, play, pause } = useAudio();

  const bottomRunway = Math.max(
    TIMELINE_BOTTOM_PADDING,
    scrollViewportHeight * BOTTOM_RUNWAY_VIEWPORT_RATIO
  );
  const containerHeight = terminalY + bottomRunway;
  const renderedHeight = containerHeight;

  const setDrawProgress = useCallback((nextProgress: number) => {
    const clampedProgress = clamp(nextProgress, 0, 1);
    pathLengthRef.current.set(clampedProgress);
    setDrawProgressState((currentProgress) =>
      currentProgress === clampedProgress ? currentProgress : clampedProgress
    );
  }, []);

  const updatePathLength = useCallback(
    (fallbackProgress?: number) => {
      if (reducedMotion) {
        setDrawProgress(1);
        return;
      }

      const pathEl = svgPathRef.current;
      const progress = clamp(fallbackProgress ?? scrollYProgress.get(), 0, 1);
      const scrollEl = scrollContainerRef?.current;
      const timelineEl = containerRef.current;

      if (progress <= 0) {
        setDrawProgress(0);
        return;
      }

      if (progress >= 1) {
        setDrawProgress(1);
        return;
      }

      if (!pathEl) {
        setDrawProgress(progress);
        return;
      }

      const totalLength = pathEl.getTotalLength();
      const startY = pathEl.getPointAtLength(0).y;
      const endY = pathEl.getPointAtLength(totalLength).y;
      if (endY <= startY) {
        setDrawProgress(progress);
        return;
      }

      let targetY = startY + (endY - startY) * progress;

      if (scrollEl && timelineEl) {
        const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
        if (scrollEl.scrollTop >= maxScrollTop - 1) {
          setDrawProgress(1);
          return;
        }

        const timelineRect = timelineEl.getBoundingClientRect();
        const scrollRect = scrollEl.getBoundingClientRect();
        const timelineTopInScrollContent =
          timelineRect.top - scrollRect.top + scrollEl.scrollTop;

        const distanceIntoTimeline = Math.max(
          0,
          scrollEl.scrollTop - timelineTopInScrollContent
        );
        const viewportHeight =
          scrollEl.clientHeight ||
          (typeof window !== 'undefined' ? window.innerHeight : 0);
        const distanceAtBottom = Math.max(
          0,
          maxScrollTop - timelineTopInScrollContent
        );
        const completionLead = Math.max(
          0,
          endY - startY - distanceAtBottom
        );
        const visibleLead = completionLead || viewportHeight * (1 - BOTTOM_RUNWAY_VIEWPORT_RATIO);
        const drawAhead = Math.min(distanceIntoTimeline, visibleLead);

        targetY = startY + distanceIntoTimeline + drawAhead;
      }

      setDrawProgress(getPathProgressAtY(pathEl, targetY));
    },
    [reducedMotion, scrollContainerRef, scrollYProgress, setDrawProgress]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.matchMedia) return;

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncPreference = () => {
      setReducedMotion(media.matches);
      if (media.matches) {
        setDrawProgress(1);
      }
    };

    syncPreference();
    if (media.addEventListener) {
      media.addEventListener('change', syncPreference);
    } else {
      media.addListener?.(syncPreference);
    }

    return () => {
      if (media.removeEventListener) {
        media.removeEventListener('change', syncPreference);
      } else {
        media.removeListener?.(syncPreference);
      }
    };
  }, [setDrawProgress]);

  useEffect(() => {
    onHeightChange?.(containerHeight);
  }, [containerHeight, onHeightChange]);

  useEffect(() => {
    const scrollEl = scrollContainerRef?.current;

    const updateScrollViewportHeight = () => {
      const nextHeight =
        scrollEl?.clientHeight ||
        (typeof window !== 'undefined' ? window.innerHeight : 0) ||
        SSR_SCROLL_VIEWPORT_HEIGHT;
      setScrollViewportHeight(nextHeight);
    };

    let observer: ResizeObserver | null = null;
    if (scrollEl && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateScrollViewportHeight);
      observer.observe(scrollEl);
    }

    updateScrollViewportHeight();
    window.addEventListener('resize', updateScrollViewportHeight);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateScrollViewportHeight);
    };
  }, [scrollContainerRef]);

  // ── On mount: check reduced-motion, generate path ───────────────────────
  useEffect(() => {
    if (!hasMeasuredContainer) return;

    // Generate the path d attribute using the current container width (Req 3.2, 3.7).
    const d = generateTimelinePath(
      count,
      VERTICAL_SPACING,
      containerWidth,
      PATH_SEED,
      PATH_TAIL,
      containerWidth
    );
    setPathD(d);
  }, [count, containerWidth, hasMeasuredContainer]);

  // ── After path d is set, compute marker positions via getPointAtLength ───
  useEffect(() => {
    if (!pathD || !svgPathRef.current) return;
    const positions = computeMarkerPositions(svgPathRef.current, count);
    setMarkerPositions(positions);
    updatePathLength(scrollYProgress.get());
  }, [pathD, count, scrollYProgress, updatePathLength]);

  // ── Resize handler: recompute path for the new viewport width and re-sample
  //    all marker positions (count derived from markers.length) (Req 3.6, 3.7) ─
  // NOTE: Path regeneration is driven by containerWidth state updates from the
  // ResizeObserver and window resize fallback below.

  // ── Track container width for real-pixel SVG geometry ─────────────────────
  // The SVG viewBox width follows the rendered container width, so X and Y
  // coordinates stay in CSS-pixel units at every viewport size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = (width = el.getBoundingClientRect().width) => {
      const fallbackWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
      const nextWidth = width || fallbackWidth || SSR_VIEWPORT_WIDTH;
      setContainerWidth(nextWidth);
      setHasMeasuredContainer(true);
    };

    let observer: ResizeObserver | null = null;
    const handleResize = () => updateWidth();

    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? el.getBoundingClientRect().width;
        updateWidth(width);
      });
      observer.observe(el);
    }

    window.addEventListener('resize', handleResize);

    updateWidth();

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = scrollYProgress.on('change', (progress) => {
      updatePathLength(progress);
    });

    const handleScrollOrResize = () => updatePathLength(scrollYProgress.get());
    const scrollEl = scrollContainerRef?.current;

    scrollEl?.addEventListener('scroll', handleScrollOrResize, { passive: true });
    window.addEventListener('resize', handleScrollOrResize);
    handleScrollOrResize();

    return () => {
      unsubscribe();
      scrollEl?.removeEventListener('scroll', handleScrollOrResize);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [scrollContainerRef, scrollYProgress, updatePathLength, pathD]);

  // CTA pixel offset from the container top. Y coordinates are kept 1:1 with
  // CSS pixels so scrolling and drawing stay aligned across viewport widths.
  const ctaTopPx = terminalY;
  const svgViewBoxWidth = Math.max(1, containerWidth);

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{ width: '100%', height: containerHeight }}
    >
      {/* ── SVG timeline path ────────────────────────────────────────────── */}
      <svg
        width="100%"
        height={renderedHeight}
        viewBox={`0 0 ${svgViewBoxWidth} ${renderedHeight}`}
        preserveAspectRatio="none"
        style={{ overflow: 'visible', position: 'absolute', top: 0, left: 0 }}
        aria-hidden="true"
      >
        {/*
          Hidden reference path used for getPointAtLength calls.
          We render it with transparent stroke so the DOM element is available
          immediately on mount for position computation.
        */}
        <path
          ref={svgPathRef}
          d={pathD}
          fill="none"
          stroke="transparent"
          strokeWidth={0}
        />

        {/* Animated draw path (Req 3.3, 3.4) */}
        {pathD && (
          <path
            d={pathD}
            stroke="var(--color-brand)"
            strokeWidth={6}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - drawProgress}
          />
        )}
      </svg>

      {/* ── Year markers ─────────────────────────────────────────────────── */}
      {markerPositions.length === count &&
        markers.map((datum, i) => {
          const position = markerPositions[i];
          // X and Y are both in CSS-pixel coordinates because the SVG viewBox
          // width tracks the rendered container width.
          const scaledPosition = {
            x: position.x,
            y: position.y,
          };
          // OUTER side of the curve: derived from the sampled point relative to
          // the rendered center. Left of center → the river is weaving left;
          // right of (or at) center → weaving right.
          const side: 'left' | 'right' =
            position.x < svgViewBoxWidth / 2 ? 'left' : 'right';
          const isPlaying =
            playingUrl === datum.preview_url && datum.preview_url !== null;

          return (
            <YearMarker
              key={datum.year}
              datum={datum}
              position={scaledPosition}
              side={side}
              isPlaying={isPlaying}
              onToggle={() => {
                if (playingUrl === datum.preview_url) {
                  pause();
                } else if (datum.preview_url) {
                  play(datum.preview_url);
                }
              }}
            />
          );
        })}

      {/* ── CTA at the terminal end of the path ──────────────────────────── */}
      {cta && (
        <div
          style={{
            position: 'absolute',
            // ctaTopPx is terminalY in CSS pixels because vertical SVG units are
            // intentionally kept 1:1 with scroll pixels.
            top: ctaTopPx,
            left: '50%',
            transform: 'translate(-50%, 0)',
            zIndex: 20,
          }}
        >
          {cta}
        </div>
      )}
    </div>
  );
}
