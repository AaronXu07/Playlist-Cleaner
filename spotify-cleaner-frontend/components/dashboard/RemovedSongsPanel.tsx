'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { LoadingSkeleton } from '@/components/ui/LoadingSkeleton';
import { Toast } from '@/components/ui/Toast';
import type { RemovalRecord } from '@/lib/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of removed songs shown per page. */
const PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RemovedSongsPanelProps {
  songs: RemovalRecord[];
  isLoading: boolean;
  error: string | null;
  /** Per-row errors keyed by removal record ID (from useRemovals). */
  rowErrors: Record<string, string>;
  /** IDs of in-flight re-add requests (from useRemovals). */
  pendingReAdds: Set<string>;
  onRetry: () => void;
  onReAdd: (id: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RemovedSongsPanel({
  songs,
  isLoading,
  error,
  rowErrors,
  pendingReAdds,
  onRetry,
  onReAdd,
}: RemovedSongsPanelProps) {
  // Track whether the user has dismissed the error toast for this "batch" of
  // rowErrors. The toast re-appears whenever new rowErrors arrive (different
  // latest error message).
  const [dismissedToastMessage, setDismissedToastMessage] = useState<
    string | null
  >(null);

  // Current page (0-indexed).
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(songs.length / PAGE_SIZE));

  // Clamp the current page whenever the list shrinks (e.g. after a re-add
  // removes the last row on the final page).
  useEffect(() => {
    if (page > totalPages - 1) {
      setPage(totalPages - 1);
    }
  }, [page, totalPages]);

  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageSongs = songs.slice(pageStart, pageStart + PAGE_SIZE);
  const shouldDistributeRows = pageSongs.length >= 8;

  // Pick the most recent row error to show in the toast.
  const rowErrorValues = Object.values(rowErrors);
  const latestRowError =
    rowErrorValues.length > 0
      ? rowErrorValues[rowErrorValues.length - 1]
      : null;

  const toastVisible =
    latestRowError !== null && latestRowError !== dismissedToastMessage;

  function handleDismissToast() {
    setDismissedToastMessage(latestRowError);
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  function renderBody() {
    // 1. Loading state
    if (isLoading) {
      return (
        <div className="flex flex-col gap-2" aria-label="Loading removed songs">
          <LoadingSkeleton height={56} className="w-full" />
          <LoadingSkeleton height={56} className="w-full" />
          <LoadingSkeleton height={56} className="w-full" />
        </div>
      );
    }

    // 2. Error state
    if (error) {
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
          <button
            type="button"
            onClick={onRetry}
            aria-label="Retry loading removed songs"
            className="text-sm text-primary underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Retry
          </button>
        </div>
      );
    }

    // 3. Empty state
    if (songs.length === 0) {
      return (
        <p className="text-sm text-muted">
          <br />No songs removed yet. <br /><br />Start cleaning, then listen to Spotify as usual.
          <br /><br />You can leave this page while it works, and songs you tend to skip will appear
          here once they are removed. <br /><br />Turn cleaning off when you are done.
        </p>
      );
    }

    // 4. Song list (current page only)
    return (
      <ul
        className={`
          flex h-full max-h-full flex-col overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]
          ${shouldDistributeRows ? 'justify-between gap-2' : 'gap-3'}
        `}
        aria-live="polite"
        aria-label="Removed songs list"
      >
        <AnimatePresence initial={false}>
          {pageSongs.map((song) => (
            <SongRow
              key={song.id}
              song={song}
              isPending={pendingReAdds.has(song.id)}
              rowError={rowErrors[song.id] ?? null}
              onReAdd={onReAdd}
            />
          ))}
        </AnimatePresence>
      </ul>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const showPager = !isLoading && !error && songs.length > 0 && totalPages > 1;

  return (
    <>
      <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-card border border-[var(--color-glass-edge)] shadow-glass-panel">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[var(--color-glass-surface)] backdrop-blur backdrop-brightness-100 backdrop-contrast-100 backdrop-saturate-150"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[var(--color-glass-highlight)]"
        />

        <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-2 p-5">
          <h2 className="text-xl font-bold text-primary">Removed Songs</h2>

          {/* Paginated list area (no infinite scroll) */}
          <div className="min-h-0 flex-1">{renderBody()}</div>

          {/* Pagination controls — only when there's more than one page */}
          {showPager && (
            <nav
              className="flex items-center justify-between border-t border-[var(--color-glass-edge)] pt-2"
              aria-label="Removed songs pagination"
            >
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                aria-label="Previous page"
                className="
                  flex items-center gap-1 px-3 py-1.5 rounded-card text-sm text-primary
                  hover:bg-bg-surface-hover
                  disabled:opacity-40 disabled:cursor-not-allowed
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                  transition-colors duration-150
                "
              >
                <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
                Prev
              </button>

              <span className="text-sm text-muted" aria-live="polite">
                Page {safePage + 1} of {totalPages}
              </span>

              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={safePage >= totalPages - 1}
                aria-label="Next page"
                className="
                  flex items-center gap-1 px-3 py-1.5 rounded-card text-sm text-primary
                  hover:bg-bg-surface-hover
                  disabled:opacity-40 disabled:cursor-not-allowed
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                  transition-colors duration-150
                "
              >
                Next
                <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            </nav>
          )}
        </div>
      </div>

      {/* Error toast for failed re-add operations */}
      {toastVisible && latestRowError && (
        <Toast message={latestRowError} onDismiss={handleDismissToast} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// SongRow sub-component
// ---------------------------------------------------------------------------

interface SongRowProps {
  song: RemovalRecord;
  isPending: boolean;
  rowError: string | null;
  onReAdd: (id: string) => Promise<void>;
}

function SongRow({ song, isPending, rowError, onReAdd }: SongRowProps) {
  const artistName = song.artist_name ?? undefined;
  const albumArt = song.album_art ?? undefined;
  const playlistName = song.playlist_name?.trim() || song.playlist_id;
  const secondaryText = [`From ${playlistName}`, artistName]
    .filter(Boolean)
    .join(' • ');

  const altText = artistName
    ? `${song.track_name} by ${artistName} album art`
    : `${song.track_name} album art`;

  return (
    <motion.li
      layout
      initial={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: 'easeInOut' }}
      className="w-full min-w-0 shrink-0 overflow-hidden"
    >
      <div className="grid w-full min-w-0 grid-cols-[3rem_minmax(0,1fr)_2rem] items-center gap-3">
        {/* Album art */}
        {albumArt ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={albumArt}
            alt={altText}
            width={48}
            height={48}
            className="rounded flex-shrink-0 object-cover"
          />
        ) : (
          /* Gray placeholder when no album art is available */
          <div
            className="w-12 h-12 rounded flex-shrink-0 bg-bg-surface-hover"
            role="img"
            aria-label={altText}
          />
        )}

        {/* Track info */}
        <div className="min-w-0 overflow-hidden">
          <p
            className="max-w-full truncate text-sm font-medium text-primary"
            title={song.track_name}
          >
            {song.track_name}
          </p>
          <p className="max-w-full truncate text-xs text-muted" title={secondaryText}>
            {secondaryText}
          </p>
          {/* Inline row error */}
          {rowError && (
            <p className="text-xs text-danger mt-1" role="alert">
              {rowError}
            </p>
          )}
        </div>

        {/* Re-add button */}
        <button
          type="button"
          onClick={() => onReAdd(song.id)}
          disabled={isPending}
          aria-label={`Re-add ${song.track_name} to playlist`}
          className="
            flex-shrink-0
            flex items-center justify-center
            w-8 h-8
            rounded-card
            text-primary
            hover:bg-bg-surface-hover
            disabled:opacity-40 disabled:cursor-not-allowed
            focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
            transition-colors duration-150
          "
        >
          <Plus size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </motion.li>
  );
}
