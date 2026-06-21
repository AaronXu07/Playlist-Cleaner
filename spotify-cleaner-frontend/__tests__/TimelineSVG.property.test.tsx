/**
 * Property-based tests for `TimelineSVG` — scroll-to-pathLength mapping.
 *
 * **Validates: Requirements 3.4**
 *
 * Property 2: Scroll progress maps linearly to drawn path length
 *
 * For any `scrollYProgress` value `p` in [0, 1], the `pathLength` MotionValue
 * must be set to exactly `p` (identity mapping). This must hold at boundary
 * values (0 and 1) and for all intermediate scroll positions.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { render, act } from '@testing-library/react';
import React from 'react';

// ── Shared scroll-change callback registry ────────────────────────────────────
// The component wires: scrollYProgress.on('change', (v) => pathLength.set(v))
// We capture those callbacks here so tests can fire them manually.

const scrollChangeCallbacks: Array<(v: number) => void> = [];

// ── pathLength MotionValue mock ───────────────────────────────────────────────
// Track every value passed to set() so we can assert the identity mapping.

const capturedPathLengthValues: number[] = [];

const mockPathLength = {
  set: vi.fn((v: number) => {
    capturedPathLengthValues.push(v);
  }),
  get: vi.fn(() => capturedPathLengthValues[capturedPathLengthValues.length - 1] ?? 0),
  on: vi.fn(),
  // MotionValue methods the component or framer-motion internals may call
  destroy: vi.fn(),
  getVelocity: vi.fn(() => 0),
};

// ── Framer Motion mock ────────────────────────────────────────────────────────
vi.mock('framer-motion', async (importOriginal) => {
  // We only need to override the hooks; keep everything else (motion.path etc.)
  // as a simple passthrough so the component renders without errors.
  const actual = await importOriginal<typeof import('framer-motion')>();
  return {
    ...actual,
    // useMotionValue(initial) → return our tracked mock instead of a real MotionValue
    useMotionValue: vi.fn(() => mockPathLength),
    // useScroll → return a mock scrollYProgress whose .on() captures the handler
    useScroll: vi.fn(() => ({
      scrollYProgress: {
        on: vi.fn((event: string, callback: (v: number) => void) => {
          if (event === 'change') {
            scrollChangeCallbacks.push(callback);
          }
          // Return a no-op unsubscribe function
          return vi.fn();
        }),
      },
    })),
    // motion.path — render as a plain <path> so jsdom doesn't choke on it
    motion: {
      ...((actual as { motion?: object }).motion ?? {}),
      path: React.forwardRef(
        (
          props: React.SVGAttributes<SVGPathElement> & { [key: string]: unknown },
          ref: React.Ref<SVGPathElement>
        ) => {
          const {
            pathLength: _pl,
            initial: _i,
            animate: _a,
            transition: _t,
            ...rest
          } = props as React.SVGAttributes<SVGPathElement> & {
            pathLength?: unknown;
            initial?: unknown;
            animate?: unknown;
            transition?: unknown;
          };
          return <path ref={ref} {...rest} />;
        }
      ),
      div: React.forwardRef(
        (
          {
            children,
            className,
            style,
            ...rest
          }: React.HTMLAttributes<HTMLDivElement> & { [key: string]: unknown },
          ref: React.Ref<HTMLDivElement>
        ) => (
          <div ref={ref} className={className} style={style}>
            {children}
          </div>
        )
      ),
    },
  };
});

// ── AudioContext mock ─────────────────────────────────────────────────────────
vi.mock('@/context/AudioContext', () => ({
  AudioProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAudio: () => ({
    playingUrl: null,
    isLoading: false,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    stop: vi.fn(),
  }),
}));

// ── Import under test (after all mocks are in place) ─────────────────────────
import TimelineSVG from '../components/landing/TimelineSVG';
import { YEAR_MARKERS } from '../lib/yearMarkerData';
import { VERTICAL_SPACING } from '../lib/generateTimelinePath';

// ── Setup / teardown ──────────────────────────────────────────────────────────

// In jsdom, SVG path elements are instances of SVGElement (not SVGPathElement,
// which jsdom doesn't expose). We patch SVGElement.prototype once at module
// level so every <path> element created by the component has these methods.
// The arc length is data-driven (one VERTICAL_SPACING segment per marker) so it
// stays consistent with the component's geometry rather than a fixed constant.
const getTotalLengthStub = () => YEAR_MARKERS.length * VERTICAL_SPACING;
const getPointAtLengthStub = (_length: number) => ({ x: 500, y: 0 } as DOMPoint);

if (typeof SVGElement !== 'undefined') {
  if (typeof (SVGElement.prototype as unknown as Record<string, unknown>).getTotalLength !== 'function') {
    (SVGElement.prototype as unknown as Record<string, unknown>).getTotalLength = getTotalLengthStub;
  }
  if (typeof (SVGElement.prototype as unknown as Record<string, unknown>).getPointAtLength !== 'function') {
    (SVGElement.prototype as unknown as Record<string, unknown>).getPointAtLength = getPointAtLengthStub;
  }
}

beforeEach(() => {
  // Clear captured values and callbacks before each test
  capturedPathLengthValues.length = 0;
  scrollChangeCallbacks.length = 0;
  vi.clearAllMocks();

  // Re-attach the set spy (clearAllMocks wipes the implementation)
  mockPathLength.set.mockImplementation((v: number) => {
    capturedPathLengthValues.push(v);
  });
  mockPathLength.get.mockImplementation(
    () => capturedPathLengthValues[capturedPathLengthValues.length - 1] ?? 0
  );

  // Provide a minimal Audio constructor
  window.Audio = (function () {
    return {
      src: '',
      paused: true,
      readyState: 4,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  }) as unknown as typeof Audio;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helper: render TimelineSVG and return the captured scroll callback ─────────

/**
 * Render `<TimelineSVG>` without `prefers-reduced-motion` so the scroll wiring
 * runs, then return the scroll-change callback that the component registered.
 */
async function renderAndGetScrollCallback(): Promise<(v: number) => void> {
  // Ensure matchMedia reports no reduced-motion preference
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, // prefers-reduced-motion: false
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

  // Mock scrollYProgress passed as a prop; its .on('change') captures the handler
  const scrollYProgress = {
    get: () => 0,
    set: vi.fn(),
    on: vi.fn((event: string, callback: (v: number) => void) => {
      if (event === 'change') {
        scrollChangeCallbacks.push(callback);
      }
      return vi.fn();
    }),
  } as unknown as import('framer-motion').MotionValue<number>;

  await act(async () => {
    render(<TimelineSVG markers={[]} scrollYProgress={scrollYProgress} />);
  });

  // The component registers exactly one 'change' listener with scrollYProgress.on()
  // If no callback was registered something went wrong in the component mount
  if (scrollChangeCallbacks.length === 0) {
    throw new Error(
      'No scroll change callback was registered — ' +
        'check that the scrollYProgress prop is wiring correctly.'
    );
  }

  return scrollChangeCallbacks[scrollChangeCallbacks.length - 1];
}

// ── Property 2 ───────────────────────────────────────────────────────────────

describe('Property 2: Scroll progress maps linearly to drawn path length', () => {
  /**
   * For any p in [0, 1], calling the scrollYProgress change handler with p
   * must result in pathLength.set(p) being called with the exact same value.
   *
   * This validates the identity mapping:
   *   scrollYProgress.on('change', (v) => pathLength.set(v))
   *
   * Validates: Requirement 3.4
   */
  test(
    'property: pathLength.set is called with the exact scrollYProgress value for any p in [0,1]',
    async () => {
      // Render once; the callback is stable for all 100 runs
      const onScrollChange = await renderAndGetScrollCallback();

      await fc.assert(
        fc.asyncProperty(
          fc.float({ min: 0, max: 1, noNaN: true }),
          async (p) => {
            // Reset captured values so we only observe this iteration's call
            capturedPathLengthValues.length = 0;
            mockPathLength.set.mockClear();

            // Fire the scroll change handler as the component does internally
            act(() => {
              onScrollChange(p);
            });

            // pathLength.set must have been called at least once
            expect(mockPathLength.set).toHaveBeenCalled();

            // The most recent call must have been with exactly p (identity mapping)
            const lastCall =
              mockPathLength.set.mock.calls[mockPathLength.set.mock.calls.length - 1];
            expect(lastCall[0]).toBe(p);

            // The captured value must also equal p (round-trip consistency)
            expect(capturedPathLengthValues[capturedPathLengthValues.length - 1]).toBe(p);

            // Value must remain in [0, 1] — no clamping or transformation applied
            expect(lastCall[0]).toBeGreaterThanOrEqual(0);
            expect(lastCall[0]).toBeLessThanOrEqual(1);
          }
        ),
        { numRuns: 100 }
      );
    },
    { timeout: 60_000 }
  );

  /**
   * Boundary check: verify the identity mapping at the exact boundary values.
   *
   * Validates: Requirement 3.4
   */
  test('boundary: p=0 maps to pathLength 0, p=1 maps to pathLength 1', async () => {
    const onScrollChange = await renderAndGetScrollCallback();

    for (const boundary of [0, 1] as const) {
      capturedPathLengthValues.length = 0;
      mockPathLength.set.mockClear();

      act(() => {
        onScrollChange(boundary);
      });

      expect(mockPathLength.set).toHaveBeenCalledWith(boundary);
      expect(capturedPathLengthValues[capturedPathLengthValues.length - 1]).toBe(boundary);
    }
  });

  /**
   * Monotonicity: a non-decreasing sequence of scroll values must produce a
   * non-decreasing sequence of pathLength.set calls (linear identity mapping
   * preserves ordering).
   *
   * Validates: Requirement 3.4
   */
  test(
    'property: non-decreasing scroll sequence produces non-decreasing pathLength values',
    async () => {
      const onScrollChange = await renderAndGetScrollCallback();

      await fc.assert(
        fc.asyncProperty(
          // Generate a sorted array of [0,1] floats to simulate a realistic scroll sequence
          fc
            .array(fc.float({ min: 0, max: 1, noNaN: true }), {
              minLength: 2,
              maxLength: 20,
            })
            .map((arr) => arr.slice().sort((a, b) => a - b)),
          async (sortedValues) => {
            const observed: number[] = [];

            for (const v of sortedValues) {
              capturedPathLengthValues.length = 0;
              mockPathLength.set.mockClear();

              act(() => {
                onScrollChange(v);
              });

              const last =
                capturedPathLengthValues[capturedPathLengthValues.length - 1];
              observed.push(last);
            }

            // The observed values must be non-decreasing (identity mapping preserves order)
            for (let i = 1; i < observed.length; i++) {
              expect(observed[i]).toBeGreaterThanOrEqual(observed[i - 1]);
            }
          }
        ),
        { numRuns: 100 }
      );
    },
    { timeout: 60_000 }
  );
});
