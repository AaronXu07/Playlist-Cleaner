// hooks/useRemovals.ts
// SWR-backed hook for the removed songs list with optimistic re-add support.

import { useState } from 'react';
import useSWR from 'swr';
import { getRemovals, deleteRemoval, RemovalRecord } from '@/lib/api';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

interface UseRemovalsReturn {
  songs: RemovalRecord[];
  pendingReAdds: Set<string>; // set of in-flight removal IDs
  isLoading: boolean;
  error: string | null;
  /** Per-row errors keyed by removal record ID. */
  rowErrors: Record<string, string>;
  reAdd: (id: string) => Promise<void>;
  retry: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRemovals(): UseRemovalsReturn {
  const {
    data,
    isLoading,
    error: swrError,
    mutate,
  } = useSWR<RemovalRecord[]>('/api/removals', getRemovals);

  // Track which IDs are currently in-flight so the UI can disable buttons.
  // useRef so updates don't trigger an extra re-render beyond what mutate
  // already causes; useState is used for the Set reference so the component
  // re-renders when we add/remove from it.
  const [pendingReAdds, setPendingReAdds] = useState<Set<string>>(new Set());

  // Per-row errors (keyed by removal record ID).
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // Top-level fetch error (exposed as `error` for the retry / panel error state).
  const fetchError: string | null = swrError
    ? (swrError as Error).message ?? 'Failed to load removed songs'
    : null;

  // -------------------------------------------------------------------------
  // reAdd
  // -------------------------------------------------------------------------

  async function reAdd(id: string): Promise<void> {
    const currentSongs: RemovalRecord[] = data ?? [];

    // 1. Track original index so we can restore on failure.
    const originalIndex = currentSongs.findIndex((s) => s.id === id);
    const record = currentSongs[originalIndex];

    if (!record) return; // already gone — nothing to do

    // 2. Mark as in-flight.
    setPendingReAdds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

    // 3. Optimistically remove from SWR cache immediately.
    const optimisticSongs = currentSongs.filter((s) => s.id !== id);
    await mutate(optimisticSongs, { revalidate: false });

    // 4. Call the API.
    try {
      await deleteRemoval(id);

      // 5. Success: clear the in-flight marker (and any previous row error).
      setPendingReAdds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setRowErrors((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      // 6. Failure: revert — re-insert the record at its original index.
      const revertedSongs = [...optimisticSongs];
      // Clamp index in case the list changed between optimistic removal and here.
      const insertAt = Math.min(originalIndex, revertedSongs.length);
      revertedSongs.splice(insertAt, 0, record);
      await mutate(revertedSongs, { revalidate: false });

      // Clear in-flight marker.
      setPendingReAdds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });

      // Store the per-row error message.
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to re-add track';
      setRowErrors((prev) => ({ ...prev, [id]: errorMessage }));
    }
  }

  // -------------------------------------------------------------------------
  // retry
  // -------------------------------------------------------------------------

  function retry(): void {
    // Clear all error state and re-trigger the SWR fetch.
    setRowErrors({});
    mutate();
  }

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  return {
    songs: data ?? [],
    pendingReAdds,
    isLoading,
    error: fetchError,
    rowErrors,
    reAdd,
    retry,
  };
}
