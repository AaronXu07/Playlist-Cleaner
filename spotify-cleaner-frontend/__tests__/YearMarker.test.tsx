/**
 * Property-based tests for the reworked `YearMarker` component.
 *
 * **Validates: Requirements 4.2, 4.5, 4.6**
 *
 * YearMarker is now a single whole-marker interactive control:
 *   - When `datum.preview_url` is non-null the ENTIRE marker is a single native
 *     <button> that toggles playback via the `onToggle` prop, exposes a non-empty
 *     aria-label ("Play preview of …" / "Pause preview of …"), renders a Lucide
 *     Play/Pause icon, shows a focus ring, and is disabled while audio loads.
 *   - When `preview_url` is null the marker renders a plain, non-interactive,
 *     non-focusable container (no <button>, no play/pause icon) with identical
 *     layout dimensions and styling.
 *
 * Props: { datum, position, side, isPlaying, onToggle }
 *
 * Property 6: Every YearMarker renders all required fields on the outer side of the curve.
 * Property 7: Preview-URL presence makes the whole marker an interactive control,
 *             with layout parity.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';

// ── Framer Motion mock ────────────────────────────────────────────────────────
// Replace motion.div with a plain div so whileInView/viewport props don't
// interfere with jsdom (which has no IntersectionObserver / scroll engine).
vi.mock('framer-motion', () => ({
  motion: {
    div: React.forwardRef(
      (
        {
          children,
          className,
          style,
        }: React.HTMLAttributes<HTMLDivElement> & { [key: string]: unknown },
        ref: React.Ref<HTMLDivElement>
      ) => (
        <div ref={ref} className={className} style={style}>
          {children}
        </div>
      )
    ),
  },
}));

// ── AudioContext mock ─────────────────────────────────────────────────────────
// YearMarker calls useAudio() for `isLoading`. Provide a stable, no-op context so
// useAudio() never throws and the real Audio API is never exercised. AudioProvider
// is a passthrough so renders can still be wrapped in it (per the component's
// runtime expectation that it lives inside an AudioProvider).
const mockAudioContextValue = {
  playingUrl: null as string | null,
  isLoading: false,
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn(),
  stop: vi.fn(),
};

vi.mock('@/context/AudioContext', () => ({
  AudioProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAudio: () => mockAudioContextValue,
}));

// ── Imports after mocks are registered ─────────────────────────────────────────
import YearMarker from '../components/landing/YearMarker';
import { AudioProvider } from '../context/AudioContext';
import type { YearMarkerDatum } from '../lib/yearMarkerData';

// ── Helpers ─────────────────────────────────────────────────────────────────--

/** Default position passed to every YearMarker render. */
const DEFAULT_POSITION = { x: 100, y: 200 };

/**
 * Render a YearMarker inside an AudioProvider with the given props.
 * Caller is responsible for calling unmount().
 */
function renderMarker(props: {
  datum: YearMarkerDatum;
  side: 'left' | 'right';
  isPlaying?: boolean;
  onToggle?: () => void;
}) {
  const { datum, side, isPlaying = false, onToggle = vi.fn() } = props;
  return render(
    <AudioProvider>
      <YearMarker
        datum={datum}
        position={DEFAULT_POSITION}
        side={side}
        isPlaying={isPlaying}
        onToggle={onToggle}
      />
    </AudioProvider>
  );
}

// ── Arbitraries ───────────────────────────────────────────────────────────────

const sideArbitrary = fc.constantFrom<'left' | 'right'>('left', 'right');

/**
 * Generates valid YearMarkerDatum objects.
 * preview_url is either null or a non-empty string.
 */
const yearMarkerArbitrary = fc.record({
  year: fc.integer({ min: 1970, max: 2026 }),
  trackTitle: fc.string({ minLength: 1 }),
  artistName: fc.string({ minLength: 1 }),
  albumArt: fc.constant('/test.jpg'),
  preview_url: fc.option(fc.string({ minLength: 1 }), { nil: null }),
});

/** A datum paired with a side. */
const datumWithSideArbitrary = fc.record({
  datum: yearMarkerArbitrary,
  side: sideArbitrary,
});

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let originalAudio: typeof window.Audio;

beforeEach(() => {
  originalAudio = window.Audio;
  // Provide a minimal Audio constructor so AudioProvider doesn't crash.
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

  mockAudioContextValue.playingUrl = null;
  mockAudioContextValue.isLoading = false;
  vi.clearAllMocks();
});

afterEach(() => {
  window.Audio = originalAudio;
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// Feature: spotify-playlist-cleaner-frontend, Property 6: YearMarker fields on outer side
// ═════════════════════════════════════════════════════════════════════════════

describe('Property 6: Every YearMarker renders all required fields on the outer side of the curve', () => {
  /**
   * For any YearMarkerDatum and side, the rendered marker must contain:
   *   1. the track title
   *   2. the artist name
   *   3. the year label
   *   4. an <img> with alt "{trackTitle} by {artistName} album art"
   * and the info block must be aligned to the supplied `side` (the outer side of
   * the curve) — driven by the `side` prop, NOT by index parity.
   *
   * Validates: Requirements 4.2
   */
  test('property: title, artist, year, and album-art img are present and the info block reflects `side`', () => {
    fc.assert(
      fc.property(datumWithSideArbitrary, ({ datum, side }) => {
        const { container, unmount } = renderMarker({ datum, side });

        // 1–3. Required text fields present in the DOM.
        const allText = container.textContent ?? '';
        expect(allText).toContain(datum.trackTitle);
        expect(allText).toContain(datum.artistName);
        expect(allText).toContain(String(datum.year));

        // 4. <img> with the correctly formatted alt text.
        const expectedAlt = `${datum.trackTitle} by ${datum.artistName} album art`;
        const imgs = Array.from(container.querySelectorAll('img'));
        const matchingImg = imgs.find((img) => img.getAttribute('alt') === expectedAlt);
        expect(matchingImg).toBeTruthy();
        expect(matchingImg!.tagName).toBe('IMG');

        // Info block alignment reflects the supplied `side` (outer side of the curve).
        // The info block is the flex-column wrapper holding year/title/artist.
        const infoBlock = container.querySelector('.flex-col');
        expect(infoBlock).not.toBeNull();
        if (side === 'left') {
          // Outer side is left → text aligns to the right edge toward the path.
          expect(infoBlock!.className).toContain('items-end');
          expect(infoBlock!.className).toContain('text-right');
        } else {
          expect(infoBlock!.className).toContain('items-start');
          expect(infoBlock!.className).toContain('text-left');
        }

        unmount();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * The same datum rendered with opposite sides must flip the info-block
   * alignment — confirming the layout is purely `side`-driven and not tied to
   * any index or year value.
   *
   * Validates: Requirements 4.2
   */
  test('property: flipping `side` flips the info-block alignment for an otherwise identical datum', () => {
    fc.assert(
      fc.property(yearMarkerArbitrary, (datum) => {
        const left = renderMarker({ datum, side: 'left' });
        const leftInfo = left.container.querySelector('.flex-col');
        expect(leftInfo!.className).toContain('text-right');
        left.unmount();

        const right = renderMarker({ datum, side: 'right' });
        const rightInfo = right.container.querySelector('.flex-col');
        expect(rightInfo!.className).toContain('text-left');
        right.unmount();
      }),
      { numRuns: 100 }
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Feature: spotify-playlist-cleaner-frontend, Property 7: whole-marker interactivity + layout parity
// ═════════════════════════════════════════════════════════════════════════════

describe('Property 7: Preview-URL presence makes the whole marker an interactive control, with layout parity', () => {
  /**
   * Generate two data objects identical except for preview_url (one non-null
   * string, one null). Assert:
   *   - Non-null: the marker is a SINGLE <button> that calls onToggle on click,
   *     has a non-empty aria-label, renders a Play/Pause Lucide icon, and is a
   *     keyboard-activatable native button (tagName BUTTON, not disabled while
   *     not loading).
   *   - Null: there is NO <button>, the marker root is not focusable, and there
   *     is no play/pause icon.
   *   - Layout parity: the album-art container and the content box carry the
   *     same dimension-affecting classes in both cases.
   *
   * Validates: Requirements 4.5, 4.6
   */
  test('property: non-null preview_url → single interactive button; null → inert container; layout parity holds', () => {
    fc.assert(
      fc.property(
        fc.record({
          base: fc.record({
            year: fc.integer({ min: 1970, max: 2026 }),
            trackTitle: fc.string({ minLength: 1 }),
            artistName: fc.string({ minLength: 1 }),
            albumArt: fc.constant('/test.jpg'),
          }),
          previewUrl: fc.string({ minLength: 1 }),
          side: sideArbitrary,
        }),
        ({ base, previewUrl, side }) => {
          const datumWith: YearMarkerDatum = { ...base, preview_url: previewUrl };
          const datumWithout: YearMarkerDatum = { ...base, preview_url: null };

          // ── Non-null preview_url: whole marker is one interactive <button> ──
          const onToggle = vi.fn();
          const withResult = renderMarker({ datum: datumWith, side, onToggle });

          const buttons = withResult.container.querySelectorAll('button');
          // Exactly one button — the whole marker, not a separate overlay control.
          expect(buttons.length).toBe(1);
          const button = buttons[0];

          // It is a keyboard-activatable native button, enabled while not loading.
          expect(button.tagName).toBe('BUTTON');
          expect(button.hasAttribute('disabled')).toBe(false);

          // Non-empty aria-label.
          const label = button.getAttribute('aria-label');
          expect(label).toBeTruthy();
          expect(label!.trim().length).toBeGreaterThan(0);

          // Renders a Play or Pause Lucide icon.
          const icon = button.querySelector('svg.lucide-play, svg.lucide-pause');
          expect(icon).not.toBeNull();

          // Clicking the marker calls onToggle.
          fireEvent.click(button);
          expect(onToggle).toHaveBeenCalledTimes(1);

          // ── Null preview_url: inert, non-focusable container ──
          const withoutResult = renderMarker({ datum: datumWithout, side });

          // No <button> anywhere.
          expect(withoutResult.container.querySelectorAll('button').length).toBe(0);
          // Nothing focusable (no tabindex, no native control).
          expect(withoutResult.container.querySelector('[tabindex]')).toBeNull();
          // No play/pause icon.
          expect(
            withoutResult.container.querySelector('svg.lucide-play, svg.lucide-pause')
          ).toBeNull();

          // ── Layout parity ──
          // The responsive album-art container is structurally identical in both.
          const albumWith = withResult.container.querySelector('img')?.parentElement;
          const albumWithout = withoutResult.container.querySelector('img')?.parentElement;
          expect(albumWith).not.toBeNull();
          expect(albumWithout).not.toBeNull();
          expect(albumWith!.className).toBe(albumWithout!.className);

          // The content box (the <button> vs the inert <div>) carries the same
          // dimension-affecting layout classes.
          const contentWith = withResult.container.querySelector('button');
          const contentWithout = withoutResult.container.querySelector('.flex.items-start');
          expect(contentWith).not.toBeNull();
          expect(contentWithout).not.toBeNull();
          expect(contentWith!.tagName).toBe('BUTTON');
          expect(contentWithout!.tagName).toBe('DIV');

          const layoutTokens = [
            'flex',
            'items-start',
            'gap-1.5',
            'sm:gap-2',
            side === 'left' ? 'flex-row-reverse' : 'flex-row',
          ];
          for (const token of layoutTokens) {
            expect(contentWith!.classList.contains(token)).toBe(true);
            expect(contentWithout!.classList.contains(token)).toBe(true);
          }

          withResult.unmount();
          withoutResult.unmount();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Icon reflects playback state: Pause icon while playing, Play icon while
   * paused. The aria-label switches accordingly and is always non-empty.
   *
   * Validates: Requirements 4.5
   */
  test('property: interactive marker shows Pause icon + "Pause preview" label while playing, Play otherwise', () => {
    fc.assert(
      fc.property(
        fc.record({
          base: fc.record({
            year: fc.integer({ min: 1970, max: 2026 }),
            trackTitle: fc.string({ minLength: 1 }),
            artistName: fc.string({ minLength: 1 }),
            albumArt: fc.constant('/test.jpg'),
          }),
          previewUrl: fc.string({ minLength: 1 }),
          isPlaying: fc.boolean(),
          side: sideArbitrary,
        }),
        ({ base, previewUrl, isPlaying, side }) => {
          const datum: YearMarkerDatum = { ...base, preview_url: previewUrl };
          const { container, unmount } = renderMarker({ datum, side, isPlaying });

          const button = container.querySelector('button')!;
          const label = button.getAttribute('aria-label') ?? '';
          expect(label.length).toBeGreaterThan(0);

          if (isPlaying) {
            expect(button.querySelector('svg.lucide-pause')).not.toBeNull();
            expect(label.startsWith('Pause preview of')).toBe(true);
          } else {
            expect(button.querySelector('svg.lucide-play')).not.toBeNull();
            expect(label.startsWith('Play preview of')).toBe(true);
          }

          unmount();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * The interactive marker button is disabled while the audio source is loading
   * (AudioContext.isLoading === true), preventing toggles mid-load.
   *
   * Validates: Requirements 4.5
   */
  test('property: interactive marker is disabled while audio is loading', () => {
    fc.assert(
      fc.property(
        fc.record({
          base: fc.record({
            year: fc.integer({ min: 1970, max: 2026 }),
            trackTitle: fc.string({ minLength: 1 }),
            artistName: fc.string({ minLength: 1 }),
            albumArt: fc.constant('/test.jpg'),
          }),
          previewUrl: fc.string({ minLength: 1 }),
          side: sideArbitrary,
        }),
        ({ base, previewUrl, side }) => {
          mockAudioContextValue.isLoading = true;
          const datum: YearMarkerDatum = { ...base, preview_url: previewUrl };
          const { container, unmount } = renderMarker({ datum, side });

          const button = container.querySelector('button')!;
          expect(button.hasAttribute('disabled')).toBe(true);

          unmount();
          mockAudioContextValue.isLoading = false;
        }
      ),
      { numRuns: 100 }
    );
  });
});
