/**
 * Property-based and unit tests for `RemovedSongsPanel`.
 *
 * **Validates: Requirements 9.6, 9.10**
 *
 * Property 10: Every song row renders all required fields and a correctly
 * labeled re-add button.
 *
 * For any RemovalRecord in the removals list, the rendered song row must
 * include:
 *   - An <img> element with width=48 and height=48 (or a placeholder div of
 *     equivalent size when no album_art is present)
 *   - The track_name as visible text
 *   - A <button aria-label="Re-add {track_name} to playlist">
 *   - A Lucide Plus SVG icon inside that button
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

// ── Framer Motion mock ────────────────────────────────────────────────────────
// AnimatePresence and motion.li need to render children directly in jsdom.
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    li: React.forwardRef(
      (
        {
          children,
          className,
          style,
          ...rest
        }: React.LiHTMLAttributes<HTMLLIElement> & { [key: string]: unknown },
        ref: React.Ref<HTMLLIElement>
      ) => (
        <li ref={ref} className={className} style={style}>
          {children}
        </li>
      )
    ),
  },
}));

// ── Import component under test (after mocks are registered) ─────────────────
import { RemovedSongsPanel } from '../components/dashboard/RemovedSongsPanel';
import type { RemovalRecord } from '../lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RemovedSongsPanelProps {
  songs: RemovalRecord[];
  isLoading: boolean;
  error: string | null;
  rowErrors: Record<string, string>;
  pendingReAdds: Set<string>;
  onRetry: () => void;
  onReAdd: (id: string) => Promise<void>;
}

// ── Render helper ─────────────────────────────────────────────────────────────

function renderPanel(songs: RemovalRecord[], overrides?: Partial<RemovedSongsPanelProps>) {
  return render(
    <RemovedSongsPanel
      songs={songs}
      isLoading={false}
      error={null}
      rowErrors={{}}
      pendingReAdds={new Set()}
      onRetry={vi.fn()}
      onReAdd={vi.fn()}
      {...overrides}
    />
  );
}

// ── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generates a RemovalRecord matching the shape returned by GET /api/removals.
 * track_name has minLength:1 so the aria-label and text content checks are
 * always meaningful. album_art is omitted (undefined) to exercise the
 * placeholder path; the component gracefully falls back to a div placeholder.
 */
const removalRecordArbitrary = fc.record({
  id: fc.uuidV(4),
  track_id: fc.string(),
  track_name: fc.string({ minLength: 1 }),
  user_id: fc.constant('user-1'),
  playlist_id: fc.string(),
  playlist_name: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  removed_at: fc.date().map((d) => d.toISOString()),
  reason: fc.string(),
});

// ── Teardown ──────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Property 10 ───────────────────────────────────────────────────────────────

describe('Property 10: Every song row renders all required fields and a correctly labeled re-add button', () => {
  /**
   * Property 10a: For any RemovalRecord in a list of 1–10 songs, every
   * rendered song row must include:
   *   1. An <img width="48" height="48"> (when album_art is present) OR a
   *      placeholder element of equivalent size (w-12 h-12, i.e. 48px)
   *   2. The track_name as visible text
   *   3. A <button> whose aria-label equals "Re-add {track_name} to playlist"
   *   4. An SVG element (Lucide Plus icon) inside that button
   *
   * Runs 100 iterations.
   */
  test(
    'property 10a: each song row has an image/placeholder, track_name text, and a correctly labeled re-add button with svg icon',
    () => {
      fc.assert(
        fc.property(
          fc.array(removalRecordArbitrary, { minLength: 1, maxLength: 10 }),
          (songs) => {
            const { container, unmount } = renderPanel(songs);

            for (const song of songs) {
              // ── 1. Image or placeholder ────────────────────────────────────
              // When album_art is missing the component renders a <div> placeholder
              // with class "w-12 h-12". When album_art is present it renders an
              // <img width=48 height=48>. We accept either.
              const hasImg = (() => {
                const imgs = container.querySelectorAll('img');
                return Array.from(imgs).some(
                  (img) =>
                    img.getAttribute('width') === '48' &&
                    img.getAttribute('height') === '48'
                );
              })();
              const hasPlaceholder = container.querySelector('.w-12.h-12') !== null;
              expect(hasImg || hasPlaceholder).toBe(true);

              // ── 2. track_name visible in text content ──────────────────────
              const allText = container.textContent ?? '';
              expect(allText).toContain(song.track_name);

              // ── 3. Button with correct aria-label ─────────────────────────
              const expectedLabel = `Re-add ${song.track_name} to playlist`;
              const reAddButton = container.querySelector(
                `button[aria-label="${CSS.escape(expectedLabel)}"]`
              ) ?? Array.from(container.querySelectorAll('button')).find(
                (btn) => btn.getAttribute('aria-label') === expectedLabel
              );
              expect(reAddButton).not.toBeNull();

              // ── 4. SVG icon inside the button ──────────────────────────────
              const svgInsideButton = reAddButton!.querySelector('svg');
              expect(svgInsideButton).not.toBeNull();
            }

            unmount();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * Property 10b: For any single RemovalRecord, when album_art is explicitly
   * provided, the rendered <img> must carry width=48 and height=48.
   *
   * Runs 100 iterations.
   */
  test(
    'property 10b: when album_art is provided, img has width=48 and height=48',
    () => {
      fc.assert(
        fc.property(
          removalRecordArbitrary,
          (record) => {
            // Enrich the record with album_art to exercise the <img> path
            const songWithArt = {
              ...record,
              album_art: '/test.jpg',
            } as RemovalRecord & { album_art: string };

            const { container, unmount } = renderPanel([songWithArt]);

            const imgs = container.querySelectorAll('img');
            const albumImg = Array.from(imgs).find(
              (img) =>
                img.getAttribute('width') === '48' &&
                img.getAttribute('height') === '48'
            );
            expect(albumImg).not.toBeNull();

            unmount();
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('RemovedSongsPanel unit tests', () => {
  /**
   * Loading state must show exactly 3 skeleton rows.
   * The component renders 3 LoadingSkeleton components each wrapped in a <div>.
   * They are hidden from the a11y tree (aria-hidden) so we query by the
   * aria-label on their container.
   */
  test('loading state shows exactly 3 skeleton rows', () => {
    renderPanel([], { isLoading: true });

    // The loading container has aria-label="Loading removed songs"
    const loadingContainer = screen.getByLabelText('Loading removed songs');
    expect(loadingContainer).toBeTruthy();

    // There should be exactly 3 children (the skeleton divs)
    const skeletons = loadingContainer.querySelectorAll('[aria-hidden="true"]');
    expect(skeletons).toHaveLength(3);
  });

  /**
   * Error state: the panel must show the error message text AND a retry
   * button with aria-label="Retry loading removed songs".
   */
  test('error state shows error message and retry button with correct aria-label', () => {
    const errorMessage = 'Failed to load removed songs.';
    renderPanel([], { error: errorMessage });

    // Error message text visible in DOM
    expect(screen.getByText(errorMessage)).toBeTruthy();

    // Retry button with the required aria-label
    const retryButton = screen.getByRole('button', {
      name: 'Retry loading removed songs',
    });
    expect(retryButton).toBeTruthy();
  });

  /**
   * Empty state: when songs is an empty array and there is no error or loading,
   * the correct placeholder message must be shown.
   */
  test('empty state shows correct message text', () => {
    renderPanel([]);

    expect(
      screen.getByText('No songs removed yet — start a clean to see results here.')
    ).toBeTruthy();
  });

  /**
   * When pendingReAdds contains the record's id, the re-add button for that
   * row must be rendered as disabled.
   */
  test('song row with pendingReAdds.has(id) === true renders button as disabled', () => {
    const song: RemovalRecord = {
      id: 'test-id-1',
      track_id: 'track-abc',
      track_name: 'My Test Track',
      user_id: 'user-1',
      playlist_id: 'playlist-1',
      removed_at: new Date().toISOString(),
      reason: 'skipped',
    };

    renderPanel([song], { pendingReAdds: new Set(['test-id-1']) });

    const reAddButton = screen.getByRole('button', {
      name: 'Re-add My Test Track to playlist',
    });
    expect(reAddButton).toBeDisabled();
  });

  /**
   * When rowErrors[id] is set, the row must show the inline error text.
   * The component also surfaces the error in a Toast, so there may be multiple
   * elements with the same text — we verify that at least one is the inline
   * <p role="alert"> inside the row.
   */
  test('row with rowErrors[id] shows inline error text', () => {
    const song: RemovalRecord = {
      id: 'test-id-2',
      track_id: 'track-def',
      track_name: 'Another Track',
      user_id: 'user-1',
      playlist_id: 'playlist-1',
      removed_at: new Date().toISOString(),
      reason: 'skipped',
    };
    const inlineError = 'Failed to re-add this track.';

    const { container } = renderPanel([song], {
      rowErrors: { 'test-id-2': inlineError },
    });

    // The inline error inside the row is a <p role="alert"> with text-danger
    const inlineAlerts = container.querySelectorAll('p[role="alert"]');
    const inlineMatch = Array.from(inlineAlerts).find(
      (el) => el.textContent === inlineError
    );
    expect(inlineMatch).not.toBeNull();
  });

  test('shows 10 removed songs per page before paginating', () => {
    const songs: RemovalRecord[] = Array.from({ length: 11 }, (_, index) => ({
      id: `test-id-${index + 1}`,
      track_id: `track-${index + 1}`,
      track_name: `Removed Track ${String(index + 1).padStart(2, '0')}`,
      user_id: 'user-1',
      playlist_id: 'playlist-1',
      removed_at: new Date().toISOString(),
      reason: 'skipped',
    }));

    const { container } = renderPanel(songs);
    const allText = container.textContent ?? '';

    expect(allText).toContain('Removed Track 01');
    expect(allText).toContain('Removed Track 10');
    expect(allText).not.toContain('Removed Track 11');
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
  });

  test('shows the source playlist for each removed song row', () => {
    const songs: RemovalRecord[] = [
      {
        id: 'test-id-playlist-a',
        track_id: 'track-shared',
        track_name: 'Shared Track',
        artist_name: 'Same Artist',
        user_id: 'user-1',
        playlist_id: 'playlist-a',
        playlist_name: 'Road Trip',
        removed_at: new Date().toISOString(),
        reason: 'skipped',
      },
      {
        id: 'test-id-playlist-b',
        track_id: 'track-shared',
        track_name: 'Shared Track',
        artist_name: 'Same Artist',
        user_id: 'user-1',
        playlist_id: 'playlist-b',
        playlist_name: 'Gym Mix',
        removed_at: new Date().toISOString(),
        reason: 'skipped',
      },
    ];

    renderPanel(songs);

    expect(screen.getByText('From Road Trip • Same Artist')).toBeTruthy();
    expect(screen.getByText('From Gym Mix • Same Artist')).toBeTruthy();
  });

  test('caps long song text between the album art and re-add button', () => {
    const song: RemovalRecord = {
      id: 'test-id-long-title',
      track_id: 'track-long-title',
      track_name: 'Monster (Shawn Mendes & Justin Bieber)',
      artist_name: 'Shawn Mendes, Justin Bieber',
      user_id: 'user-1',
      playlist_id: 'liked-songs',
      playlist_name: 'Liked Songs',
      removed_at: new Date().toISOString(),
      reason: 'skipped',
    };

    renderPanel([song]);

    const title = screen.getByText('Monster (Shawn Mendes & Justin Bieber)');
    const description = screen.getByText(
      'From Liked Songs • Shawn Mendes, Justin Bieber'
    );
    const trackInfo = title.parentElement;
    const row = trackInfo?.parentElement;

    expect(title.className).toContain('truncate');
    expect(description.className).toContain('truncate');
    expect(trackInfo?.className).toContain('min-w-0');
    expect(trackInfo?.className).toContain('overflow-hidden');
    expect(row?.className).toContain('grid-cols-[3rem_minmax(0,1fr)_2rem]');
    expect(row?.className).toContain('min-w-0');
    expect(
      screen.getByRole('button', {
        name: 'Re-add Monster (Shawn Mendes & Justin Bieber) to playlist',
      })
    ).toBeTruthy();
  });
});
