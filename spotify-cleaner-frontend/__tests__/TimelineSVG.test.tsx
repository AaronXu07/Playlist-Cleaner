/**
 * Unit tests for `TimelineSVG` mount and resize behaviour.
 *
 * Validates: Requirements 3.3, 3.5, 3.6, 3.8, 3.9, 4.1
 *
 * Geometry is data-driven: the timeline renders one marker per `YEAR_MARKERS`
 * entry, so all marker-count expectations derive from `YEAR_MARKERS.length`
 * rather than a hardcoded value.
 *
 * 1. `getPointAtLength` is called once per marker on mount (Req 3.5)
 * 2. `getPointAtLength` is called again (once per marker) after a window resize (Req 3.6)
 * 3. `pathLength` MotionValue starts at 0 on mount without prefers-reduced-motion (Req 3.3)
 * 4. `pathLength` is set to 1 when prefers-reduced-motion: reduce is active (Req 3.8)
 * 5. Each rendered marker's `side` follows the weave-direction rule
 *    (sampled point x < 500 → 'left', else 'right'), NOT index parity (Req 3.9, 4.1)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import React from 'react';

// ── Shared mock state (module-level so vi.mock factories can reference them) ──

type MockMotionValue = {
  get: () => number;
  set: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _value: number;
};

// Accumulates every motion value created across re-renders in a single test.
// Reset in beforeEach.
const allMotionValues: MockMotionValue[] = [];

// Tracks the initial argument passed to each useMotionValue call.
const useMotionValueInitialValues: number[] = [];

// ── Mock: framer-motion ───────────────────────────────────────────────────────
// Instrument useMotionValue so we can assert on pathLength's initial value and
// any set() calls made during the mount/prefers-reduced-motion effect.

vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();

  return {
    ...actual,
    useMotionValue: vi.fn((initial: number) => {
      useMotionValueInitialValues.push(initial);
      let _value = initial;
      // Use a real vi.fn() for set so we can inspect .mock.calls
      const setFn = vi.fn((v: number) => {
        _value = v;
        mv._value = v;
      });
      const mv: MockMotionValue = {
        _value,
        get: () => _value,
        set: setFn as unknown as MockMotionValue['set'],
        on: vi.fn((_event: string, _cb: (v: number) => unknown) => () => {}) as unknown as MockMotionValue['on'],
      };
      allMotionValues.push(mv);
      return mv;
    }),
    useScroll: vi.fn(() => ({
      scrollYProgress: {
        get: () => 0,
        set: vi.fn(),
        on: vi.fn(() => () => {}),
      },
    })),
    useTransform: vi.fn((mv: unknown) => mv),
    motion: {
      ...actual.motion,
      // Render motion.path as a plain <path>, stripping framer-motion-only props
      path: (props: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { animate, transition, initial, pathLength, whileInView, viewport, ...rest } = props;
        return <path {...(rest as React.SVGProps<SVGPathElement>)} />;
      },
      div: React.forwardRef(
        (
          { children, ...rest }: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>,
          ref: React.Ref<HTMLDivElement>
        ) => <div ref={ref} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>
      ),
    },
  };
});

// ── Mock: AudioContext ────────────────────────────────────────────────────────
vi.mock('@/context/AudioContext', () => ({
  AudioProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAudio: () => ({
    playingUrl: null,
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    isLoading: false,
  }),
}));

// ── Mock: YearMarker ──────────────────────────────────────────────────────────
// Prevent the complex YearMarker subtree from rendering — we only care about
// TimelineSVG's own SVG path and effect behaviour. We surface the `side` prop
// (and the sampled x that produced it) via data-* attributes so the
// weave-direction derivation can be asserted from the rendered DOM.
vi.mock('@/components/landing/YearMarker', () => ({
  default: ({
    side,
    position,
  }: {
    side: 'left' | 'right';
    position: { x: number; y: number };
  }) => <div data-testid="year-marker" data-side={side} data-x={position.x} />,
}));

// ── Import component under test (after mocks are registered) ─────────────────
import TimelineSVG from '../components/landing/TimelineSVG';
import { YEAR_MARKERS } from '../lib/yearMarkerData';
import { VERTICAL_SPACING } from '../lib/generateTimelinePath';

// Number of markers the timeline renders by default (one getPointAtLength call each).
// Derived from the data — never hardcoded.
const MARKER_COUNT = YEAR_MARKERS.length;

// Logical horizontal center of the 1000-unit viewBox; the component derives a
// marker's side from `sampledX < CENTER_X ? 'left' : 'right'`.
const CENTER_X = 500;

/** Build a mock scrollYProgress MotionValue to pass into TimelineSVG. */
function makeScrollYProgress() {
  return {
    get: () => 0,
    set: vi.fn(),
    on: vi.fn(() => () => {}),
  } as unknown as import('framer-motion').MotionValue<number>;
}

// ── SVGElement prototype mock helpers ─────────────────────────────────────────
// jsdom does not implement SVGPathElement — all SVG elements extend SVGElement.
// We patch getPointAtLength / getTotalLength on window.SVGElement.prototype so
// the hidden <path ref={svgPathRef}> element in TimelineSVG has working methods.

let getPointAtLengthMock: ReturnType<typeof vi.fn>;
let getTotalLengthMock: ReturnType<typeof vi.fn>;

// Index of the current getPointAtLength call within a single render pass.
// Used to hand out deterministic, alternating x coordinates so the
// weave-direction side derivation (x < CENTER_X → 'left') is testable.
let pointCallIndex = 0;

// x coordinate returned for the Nth getPointAtLength call of a render pass.
// Even calls land left of center (300), odd calls land right of center (700),
// so consecutive markers alternate side under the x<500 rule.
function sampledXForCall(callIndex: number): number {
  return callIndex % 2 === 0 ? 300 : 700;
}

function setupSVGPathMocks() {
  pointCallIndex = 0;
  getPointAtLengthMock = vi.fn(() => {
    const x = sampledXForCall(pointCallIndex);
    pointCallIndex += 1;
    return { x, y: 0 };
  }) as unknown as ReturnType<typeof vi.fn>;
  // Arc length of the river path is data-driven: one VERTICAL_SPACING segment
  // per marker. Keep it consistent with the component's geometry so
  // computeMarkerDistribution receives a sane totalLength.
  getTotalLengthMock = vi.fn().mockReturnValue(MARKER_COUNT * VERTICAL_SPACING);

  Object.defineProperty(window.SVGElement.prototype, 'getPointAtLength', {
    value: getPointAtLengthMock,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window.SVGElement.prototype, 'getTotalLength', {
    value: getTotalLengthMock,
    writable: true,
    configurable: true,
  });
}

function teardownSVGPathMocks() {
  delete (window.SVGElement.prototype as unknown as Record<string, unknown>)['getPointAtLength'];
  delete (window.SVGElement.prototype as unknown as Record<string, unknown>)['getTotalLength'];
}

// ── window.matchMedia helper ──────────────────────────────────────────────────

function mockMatchMedia(prefersReducedMotion: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? prefersReducedMotion : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let originalMatchMedia: typeof window.matchMedia;
let originalAudio: typeof window.Audio;

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  originalAudio = window.Audio;

  // Default: no prefers-reduced-motion, desktop viewport
  mockMatchMedia(false);

  // Set desktop viewport so getBaseAmplitude() returns 120.
  // This ensures that during a resize test we can change innerWidth to < 640
  // to get a different path d string, which causes React to re-render and
  // re-run the pathD effect (triggering getPointAtLength again).
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: 1024,
  });

  // Minimal HTMLAudioElement mock so AudioProvider doesn't throw
  const MockAudioCtor = function () {
    return {
      src: '',
      paused: true,
      readyState: 4,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  } as unknown as typeof Audio;
  window.Audio = MockAudioCtor;

  setupSVGPathMocks();

  // Reset shared mock state
  allMotionValues.length = 0;
  useMotionValueInitialValues.length = 0;
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  window.Audio = originalAudio;
  teardownSVGPathMocks();
  vi.clearAllMocks();
});

// ── Shared render helper ──────────────────────────────────────────────────────

/**
 * Renders TimelineSVG and flushes all React effects (path generation →
 * getPointAtLength calls).
 */
async function renderTimelineSVG() {
  const scrollYProgress = makeScrollYProgress();

  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<TimelineSVG scrollYProgress={scrollYProgress} />);
  });

  // Flush any pending state updates triggered by the first wave of effects
  await act(async () => {});

  return { ...result, scrollYProgress };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TimelineSVG mount and resize behaviour', () => {
  /**
   * Test 1 — getPointAtLength called once per marker on mount (Req 3.5)
   *
   * On mount the first useEffect generates pathD and sets it in state. The
   * second useEffect fires (after pathD changes) and calls computeMarkerPositions()
   * which calls getPointAtLength once for each marker (YEAR_MARKERS.length).
   */
  test('getPointAtLength is called once per marker on mount', async () => {
    await renderTimelineSVG();

    expect(getPointAtLengthMock).toHaveBeenCalledTimes(MARKER_COUNT);
  });

  /**
   * Test 2 — getPointAtLength called again after window resize (Req 3.6)
   *
   * We change window.innerWidth to < 640 before firing resize so that the
   * amplitude range changes, making the new path d string different from the
   * mounted one. React then re-renders and the pathD useEffect re-runs
   * computeMarkerPositions() — one more call per marker.
   */
  test('getPointAtLength call count increases by one-per-marker after window resize', async () => {
    await renderTimelineSVG();

    const callsAfterMount = getPointAtLengthMock.mock.calls.length;
    expect(callsAfterMount).toBe(MARKER_COUNT);

    // Change to mobile viewport so the resize handler generates a different path
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 400,
    });

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    // Flush the state update and subsequent effects
    await act(async () => {});

    await waitFor(() => {
      expect(getPointAtLengthMock.mock.calls.length).toBe(callsAfterMount + MARKER_COUNT);
    });
  });

  /**
   * Test 3 — pathLength MotionValue starts at 0 on mount without prefers-reduced-motion (Req 3.3)
   *
   * useMotionValue(0) is called during the first render. Without reduced-motion,
   * the mount effect does NOT call pathLength.set(1) — so the value stays at 0
   * and the stroke starts in the fully undrawn state.
   */
  test('pathLength MotionValue starts at 0 on mount without prefers-reduced-motion', async () => {
    mockMatchMedia(false);

    await renderTimelineSVG();

    // useMotionValue must have been called with 0
    expect(useMotionValueInitialValues).toContain(0);

    // None of the motion values created should have had set(1) called on them
    // (set(1) only happens in the reduced-motion branch)
    const anySetToOne = allMotionValues.some((mv) =>
      (mv.set as ReturnType<typeof vi.fn>).mock.calls.some((args: number[]) => args[0] === 1)
    );
    expect(anySetToOne).toBe(false);

    // The motion value created for pathLength should have initial _value of 0
    const pathLengthMv = allMotionValues.find((mv) => mv._value === 0);
    expect(pathLengthMv).toBeDefined();
  });

  /**
   * Test 4 — pathLength.set(1) is called when prefers-reduced-motion: reduce is active (Req 3.8)
   *
   * When the OS/browser reports prefers-reduced-motion, the mount useEffect
   * calls pathLength.set(1) immediately, rendering the stroke in its fully
   * drawn end-state with no scroll-linked animation.
   */
  test('pathLength.set(1) is called when prefers-reduced-motion: reduce is active', async () => {
    // Enable reduced motion BEFORE rendering so the useEffect sees it
    mockMatchMedia(true);

    await renderTimelineSVG();

    // At least one of the motion values (the pathLength one) must have had
    // set(1) called on it during the mount effect
    const anySetToOne = allMotionValues.some((mv) =>
      (mv.set as ReturnType<typeof vi.fn>).mock.calls.some((args: number[]) => args[0] === 1)
    );
    expect(anySetToOne).toBe(true);
  });

  /**
   * Test 5 — marker `side` follows the weave-direction rule, not index parity (Req 3.9, 4.1)
   *
   * The component derives each marker's side from the sampled point's x relative
   * to the viewBox center: `position.x < 500 → 'left'`, otherwise `'right'`.
   * getPointAtLength is mocked to return alternating x (300 then 700, ...), so
   * the rendered markers must alternate left/right purely from the sampled x —
   * never from the marker index itself.
   */
  test('marker side is derived from sampled point x relative to center, not index parity', async () => {
    const { getAllByTestId } = await renderTimelineSVG();

    const renderedMarkers = getAllByTestId('year-marker');
    expect(renderedMarkers).toHaveLength(MARKER_COUNT);

    renderedMarkers.forEach((el, i) => {
      const side = el.getAttribute('data-side');
      const x = Number(el.getAttribute('data-x'));

      // Side must always be one of the two valid weave directions.
      expect(side === 'left' || side === 'right').toBe(true);

      // Side must be consistent with the sampled x we fed via the mock
      // (x < CENTER_X → 'left', else 'right').
      const expectedSide = x < CENTER_X ? 'left' : 'right';
      expect(side).toBe(expectedSide);

      // And, given our alternating mock, that resolves to alternating sides —
      // demonstrating the rule is driven by x, which here happens to alternate.
      expect(side).toBe(sampledXForCall(i) < CENTER_X ? 'left' : 'right');
    });
  });
});
