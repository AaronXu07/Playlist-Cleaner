/**
 * Property-based tests for accessibility invariants.
 *
 * **Validates: Requirements 10.2, 10.5**
 *
 * Property 13: Every icon-only interactive element has a non-empty accessible name
 *   For any rendered component tree, every <button> element that has no visible
 *   text child must have a non-empty aria-label attribute.
 *   Components tested: YearMarker (whole-marker control), CleaningToggle (loading state), Avatar, Toast.
 *
 * Property 14: All album art images carry correctly formatted alt text
 *   For any {trackTitle, artistName} pair, the rendered <img> alt must equal
 *   "{trackTitle} by {artistName} album art". alt must never be empty or undefined.
 *   Components tested: YearMarker, RemovedSongsPanel rows.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { render, cleanup } from '@testing-library/react';
import React from 'react';

// ── Framer Motion mock ────────────────────────────────────────────────────────
vi.mock('framer-motion', () => ({
  motion: {
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
    li: React.forwardRef(
      (
        {
          children,
          className,
          style,
          ...rest
        }: React.HTMLAttributes<HTMLLIElement> & { [key: string]: unknown },
        ref: React.Ref<HTMLLIElement>
      ) => (
        <li ref={ref} className={className} style={style}>
          {children}
        </li>
      )
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useScroll: () => ({ scrollYProgress: { get: () => 0 } }),
  useTransform: (_val: unknown, _from: unknown, _to: unknown) => ({ get: () => 0 }),
}));

// ── AudioContext mock ─────────────────────────────────────────────────────────
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

// ── Imports after mocks ───────────────────────────────────────────────────────
import YearMarker from '../components/landing/YearMarker';
import { CleaningToggle } from '../components/dashboard/CleaningToggle';
import { Avatar } from '../components/ui/Avatar';
import { Toast } from '../components/ui/Toast';
import { RemovedSongsPanel } from '../components/dashboard/RemovedSongsPanel';
import type { YearMarkerDatum } from '../lib/yearMarkerData';
import type { RemovalRecord } from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if a button element has no visible text content.
 * A button is considered "icon-only" when its trimmed text content is empty.
 */
function isIconOnly(button: Element): boolean {
  // Walk through child nodes looking for non-empty text nodes
  function hasVisibleText(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? '').trim().length > 0;
    }
    // Recurse into non-aria-hidden children
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      for (const child of Array.from(el.childNodes)) {
        if (hasVisibleText(child)) return true;
      }
    }
    return false;
  }
  return !hasVisibleText(button);
}

/** Default position used for YearMarker renders. */
const DEFAULT_POSITION = { x: 100, y: 200 };

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let originalAudio: typeof window.Audio;

beforeEach(() => {
  originalAudio = window.Audio;
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
  cleanup();
  vi.restoreAllMocks();
});

// ── Arbitraries ───────────────────────────────────────────────────────────────

const yearMarkerDatumArbitrary = fc.record({
  year: fc.integer({ min: 1970, max: 2026 }),
  trackTitle: fc.string({ minLength: 1 }),
  artistName: fc.string({ minLength: 1 }),
  albumArt: fc.constant('/test.jpg'),
  preview_url: fc.option(fc.string({ minLength: 1 }), { nil: null }),
});

const removalRecordArbitrary = fc.record({
  id: fc.uuid(),
  user_id: fc.uuid(),
  track_id: fc.uuid(),
  playlist_id: fc.uuid(),
  track_name: fc.string({ minLength: 1, maxLength: 80 }),
  removed_at: fc
    .date({ min: new Date('2020-01-01'), max: new Date('2026-12-31') })
    .map((d) => d.toISOString()),
  reason: fc.constantFrom('skipped', 'auto-removed', 'low-play-percentage'),
});

/** RemovalRecord enriched with artist_name and album_art for alt text testing. */
const enrichedRemovalRecordArbitrary = fc.record({
  id: fc.uuid(),
  user_id: fc.uuid(),
  track_id: fc.uuid(),
  playlist_id: fc.uuid(),
  track_name: fc.string({ minLength: 1, maxLength: 80 }),
  removed_at: fc
    .date({ min: new Date('2020-01-01'), max: new Date('2026-12-31') })
    .map((d) => d.toISOString()),
  reason: fc.constantFrom('skipped', 'auto-removed', 'low-play-percentage'),
  artist_name: fc.string({ minLength: 1 }),
  album_art: fc.constant('/test-album.jpg'),
});

// ═════════════════════════════════════════════════════════════════════════════
// Property 13: Every icon-only interactive element has a non-empty accessible name
// ═════════════════════════════════════════════════════════════════════════════

describe('Property 13: Every icon-only interactive element has a non-empty accessible name', () => {
  /**
   * YearMarker — when preview_url is non-null the whole marker is a single
   * <button>. That button must have a non-empty aria-label.
   *
   * Validates: Requirement 10.2
   */
  test(
    'property: YearMarker control button aria-label is non-empty for any trackTitle and preview_url',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            trackTitle: fc.string({ minLength: 1 }),
            preview_url: fc.string({ minLength: 1 }),
          }),
          ({ trackTitle, preview_url }) => {
            const datum: YearMarkerDatum = {
              year: 2000,
              trackTitle,
              artistName: 'Artist',
              albumArt: '/test.jpg',
              preview_url,
            };

            const { container } = render(
              <YearMarker
                datum={datum}
                position={DEFAULT_POSITION}
                side="left"
                isPlaying={false}
                onToggle={vi.fn()}
              />
            );

            // The whole marker is a single button with a non-empty aria-label.
            const buttons = Array.from(container.querySelectorAll('button'));
            expect(buttons.length).toBe(1);
            for (const button of buttons) {
              const label = button.getAttribute('aria-label');
              expect(label).toBeTruthy();
              expect(label!.trim().length).toBeGreaterThan(0);
            }

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * YearMarker control aria-label switches between "Play preview of …" and
   * "Pause preview of …" but is always non-empty.
   *
   * Validates: Requirement 10.2
   */
  test(
    'property: YearMarker control aria-label is non-empty in both play and pause states',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            trackTitle: fc.string({ minLength: 1 }),
            preview_url: fc.string({ minLength: 1 }),
            isPlaying: fc.boolean(),
          }),
          ({ trackTitle, preview_url, isPlaying }) => {
            const datum: YearMarkerDatum = {
              year: 2000,
              trackTitle,
              artistName: 'Artist',
              albumArt: '/test.jpg',
              preview_url,
            };

            const { container } = render(
              <YearMarker
                datum={datum}
                position={DEFAULT_POSITION}
                side="left"
                isPlaying={isPlaying}
                onToggle={vi.fn()}
              />
            );

            const buttons = Array.from(container.querySelectorAll('button'));
            for (const button of buttons) {
              const label = button.getAttribute('aria-label');
              expect(label).toBeTruthy();
              expect(label!.trim().length).toBeGreaterThan(0);
            }

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * CleaningToggle in loading state renders a spinner icon alongside text,
   * but the button itself carries aria-label. Assert it is always non-empty
   * regardless of isRunning/isLoading combinations.
   *
   * Validates: Requirement 10.2
   */
  test(
    'property: CleaningToggle button aria-label is non-empty for all isRunning/isLoading combinations',
    () => {
      fc.assert(
        fc.property(
          fc.boolean(), // isRunning
          fc.boolean(), // isLoading
          (isRunning, isLoading) => {
            const { container } = render(
              <CleaningToggle
                isRunning={isRunning}
                isLoading={isLoading}
                onStart={vi.fn().mockResolvedValue(undefined)}
                onStop={vi.fn().mockResolvedValue(undefined)}
                error={null}
              />
            );

            const buttons = Array.from(container.querySelectorAll('button'));
            expect(buttons.length).toBeGreaterThan(0);

            for (const button of buttons) {
              const label = button.getAttribute('aria-label');
              expect(label).toBeTruthy();
              expect(label!.trim().length).toBeGreaterThan(0);
            }

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * Avatar renders an icon-only button (initials or User icon).
   * It must always have aria-label="User menu".
   *
   * Validates: Requirement 10.2
   */
  test(
    'property: Avatar button aria-label is non-empty for any displayName value',
    () => {
      fc.assert(
        fc.property(
          fc.option(fc.string({ minLength: 0 }), { nil: undefined }),
          (displayName) => {
            const { container } = render(
              <Avatar
                displayName={displayName ?? undefined}
                onClick={vi.fn()}
                isOpen={false}
              />
            );

            const buttons = Array.from(container.querySelectorAll('button'));
            expect(buttons.length).toBeGreaterThan(0);

            for (const button of buttons) {
              if (isIconOnly(button)) {
                const label = button.getAttribute('aria-label');
                expect(label).toBeTruthy();
                expect(label!.trim().length).toBeGreaterThan(0);
              }
            }

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * Toast close button is icon-only (X icon). It must always have a
   * non-empty aria-label.
   *
   * Validates: Requirement 10.2
   */
  test(
    'property: Toast dismiss button aria-label is non-empty for any message string',
    () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          (message) => {
            const { container } = render(
              <Toast
                message={message}
                onDismiss={vi.fn()}
                autoDismissMs={60_000} // prevent auto-dismiss during the test
              />
            );

            const buttons = Array.from(container.querySelectorAll('button'));
            expect(buttons.length).toBeGreaterThan(0);

            for (const button of buttons) {
              if (isIconOnly(button)) {
                const label = button.getAttribute('aria-label');
                expect(label).toBeTruthy();
                expect(label!.trim().length).toBeGreaterThan(0);
              }
            }

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * Comprehensive sweep: for any combination of component states, every
   * icon-only button in the rendered output has a non-empty aria-label.
   *
   * Tests all four components in a single property to cover cross-component
   * combinations (100 iterations total).
   *
   * Validates: Requirement 10.2
   */
  test(
    'property: all icon-only buttons across YearMarker, CleaningToggle, Avatar, Toast always have aria-label',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            trackTitle: fc.string({ minLength: 1 }),
            preview_url: fc.string({ minLength: 1 }),
            isRunning: fc.boolean(),
            isLoading: fc.boolean(),
            displayName: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
            toastMessage: fc.string({ minLength: 1 }),
          }),
          ({ trackTitle, preview_url, isRunning, isLoading, displayName, toastMessage }) => {
            const datum: YearMarkerDatum = {
              year: 2000,
              trackTitle,
              artistName: 'Artist',
              albumArt: '/test.jpg',
              preview_url,
            };

            // Render each component into its own container
            const containers: Element[] = [];

            const r1 = render(
              <YearMarker
                datum={datum}
                position={DEFAULT_POSITION}
                side="left"
                isPlaying={false}
                onToggle={vi.fn()}
              />
            );
            containers.push(r1.container);

            const r2 = render(
              <CleaningToggle
                isRunning={isRunning}
                isLoading={isLoading}
                onStart={vi.fn().mockResolvedValue(undefined)}
                onStop={vi.fn().mockResolvedValue(undefined)}
                error={null}
              />
            );
            containers.push(r2.container);

            const r3 = render(
              <Avatar
                displayName={displayName ?? undefined}
                onClick={vi.fn()}
                isOpen={false}
              />
            );
            containers.push(r3.container);

            const r4 = render(
              <Toast
                message={toastMessage}
                onDismiss={vi.fn()}
                autoDismissMs={60_000}
              />
            );
            containers.push(r4.container);

            // Assert all icon-only buttons across every rendered container
            for (const container of containers) {
              const buttons = Array.from(container.querySelectorAll('button'));
              for (const button of buttons) {
                if (isIconOnly(button)) {
                  const label = button.getAttribute('aria-label');
                  expect(label).toBeTruthy();
                  expect(label!.trim().length).toBeGreaterThan(0);
                }
              }
            }

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// Property 14: All album art images carry correctly formatted alt text
// ═════════════════════════════════════════════════════════════════════════════

describe('Property 14: All album art images carry correctly formatted alt text', () => {
  /**
   * YearMarker: for any {trackTitle, artistName} pair, the rendered <img>
   * alt must equal "{trackTitle} by {artistName} album art".
   *
   * Validates: Requirement 10.5
   */
  test(
    'property: YearMarker img alt equals "{trackTitle} by {artistName} album art" for any input',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            trackTitle: fc.string({ minLength: 1 }),
            artistName: fc.string({ minLength: 1 }),
          }),
          ({ trackTitle, artistName }) => {
            const datum: YearMarkerDatum = {
              year: 2000,
              trackTitle,
              artistName,
              albumArt: '/test.jpg',
              preview_url: null,
            };

            const { container } = render(
              <YearMarker
                datum={datum}
                position={DEFAULT_POSITION}
                side="left"
                isPlaying={false}
                onToggle={vi.fn()}
              />
            );

            const imgs = Array.from(container.querySelectorAll('img'));
            expect(imgs.length).toBeGreaterThan(0);

            const expectedAlt = `${trackTitle} by ${artistName} album art`;

            for (const img of imgs) {
              const alt = img.getAttribute('alt');
              expect(alt).toBeTruthy();
              expect(alt!.length).toBeGreaterThan(0);
              expect(alt).toBe(expectedAlt);
            }

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * YearMarker: alt is never empty or undefined regardless of datum shape.
   *
   * Validates: Requirement 10.5
   */
  test(
    'property: YearMarker img alt is never empty or missing for any YearMarkerDatum',
    () => {
      fc.assert(
        fc.property(yearMarkerDatumArbitrary, (datum) => {
          const { container } = render(
            <YearMarker
              datum={datum}
              position={DEFAULT_POSITION}
              side="right"
              isPlaying={false}
              onToggle={vi.fn()}
            />
          );

          const imgs = Array.from(container.querySelectorAll('img'));
          expect(imgs.length).toBeGreaterThan(0);

          for (const img of imgs) {
            const alt = img.getAttribute('alt');
            expect(alt).not.toBeNull();
            expect(alt).not.toBeUndefined();
            expect(alt!.trim().length).toBeGreaterThan(0);
          }

          cleanup();
        }),
        { numRuns: 100 }
      );
    }
  );

  /**
   * RemovedSongsPanel rows: when album_art is provided, img alt must equal
   * "{track_name} by {artist_name} album art".
   *
   * Validates: Requirement 10.5
   */
  test(
    'property: RemovedSongsPanel img alt equals "{track_name} by {artist_name} album art" when album_art is present',
    () => {
      fc.assert(
        fc.property(
          fc.array(enrichedRemovalRecordArbitrary, { minLength: 1, maxLength: 5 }),
          (records) => {
            // Cast enriched records to RemovalRecord (the component accepts extras via cast)
            const songs = records as unknown as RemovalRecord[];

            const { container } = render(
              <RemovedSongsPanel
                songs={songs}
                isLoading={false}
                error={null}
                rowErrors={{}}
                pendingReAdds={new Set()}
                onRetry={vi.fn()}
                onReAdd={vi.fn().mockResolvedValue(undefined)}
              />
            );

            const imgs = Array.from(container.querySelectorAll('img'));
            // Each enriched record has album_art, so there should be one img per record.
            expect(imgs.length).toBe(records.length);

            for (let i = 0; i < imgs.length; i++) {
              const record = records[i];
              const expectedAlt = `${record.track_name} by ${record.artist_name} album art`;
              const alt = imgs[i].getAttribute('alt');

              expect(alt).toBeTruthy();
              expect(alt!.length).toBeGreaterThan(0);
              expect(alt).toBe(expectedAlt);
            }

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * RemovedSongsPanel rows: alt is never empty for any track_name / artist_name.
   *
   * Validates: Requirement 10.5
   */
  test(
    'property: RemovedSongsPanel img alt is never empty or undefined when album_art is provided',
    () => {
      fc.assert(
        fc.property(
          enrichedRemovalRecordArbitrary,
          (record) => {
            const songs = [record] as unknown as RemovalRecord[];

            const { container } = render(
              <RemovedSongsPanel
                songs={songs}
                isLoading={false}
                error={null}
                rowErrors={{}}
                pendingReAdds={new Set()}
                onRetry={vi.fn()}
                onReAdd={vi.fn().mockResolvedValue(undefined)}
              />
            );

            const imgs = Array.from(container.querySelectorAll('img'));
            expect(imgs.length).toBeGreaterThan(0);

            for (const img of imgs) {
              const alt = img.getAttribute('alt');
              expect(alt).not.toBeNull();
              expect(alt).not.toBeUndefined();
              expect(alt!.trim().length).toBeGreaterThan(0);
            }

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * Combined property: both YearMarker and RemovedSongsPanel produce correctly
   * formatted alt text for the same {trackTitle/track_name, artistName/artist_name}
   * values, verifying the format is consistent across components.
   *
   * Validates: Requirement 10.5
   */
  test(
    'property: alt text format "{X} by {Y} album art" is consistent across YearMarker and RemovedSongsPanel',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            trackTitle: fc.string({ minLength: 1 }),
            artistName: fc.string({ minLength: 1 }),
          }),
          ({ trackTitle, artistName }) => {
            const expectedAlt = `${trackTitle} by ${artistName} album art`;

            // ── YearMarker ──
            const datum: YearMarkerDatum = {
              year: 2000,
              trackTitle,
              artistName,
              albumArt: '/test.jpg',
              preview_url: null,
            };

            const ymResult = render(
              <YearMarker
                datum={datum}
                position={DEFAULT_POSITION}
                side="left"
                isPlaying={false}
                onToggle={vi.fn()}
              />
            );

            const ymImgs = Array.from(ymResult.container.querySelectorAll('img'));
            expect(ymImgs.length).toBeGreaterThan(0);
            for (const img of ymImgs) {
              expect(img.getAttribute('alt')).toBe(expectedAlt);
            }

            ymResult.unmount();

            // ── RemovedSongsPanel ──
            const record = {
              id: '00000000-0000-0000-0000-000000000001',
              user_id: '00000000-0000-0000-0000-000000000002',
              track_id: '00000000-0000-0000-0000-000000000003',
              playlist_id: '00000000-0000-0000-0000-000000000004',
              track_name: trackTitle,
              removed_at: new Date().toISOString(),
              reason: 'skipped',
              artist_name: artistName,
              album_art: '/test-album.jpg',
            };

            const rspResult = render(
              <RemovedSongsPanel
                songs={[record] as unknown as RemovalRecord[]}
                isLoading={false}
                error={null}
                rowErrors={{}}
                pendingReAdds={new Set()}
                onRetry={vi.fn()}
                onReAdd={vi.fn().mockResolvedValue(undefined)}
              />
            );

            const rspImgs = Array.from(rspResult.container.querySelectorAll('img'));
            expect(rspImgs.length).toBeGreaterThan(0);
            for (const img of rspImgs) {
              expect(img.getAttribute('alt')).toBe(expectedAlt);
            }

            rspResult.unmount();
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
