// hooks/useCleaningState.ts
// SWR-backed hook that manages the cleaning engine state (active / stopped / loading / error).
// The `isLoading` flag here tracks the in-flight start/stop API call, NOT SWR's own loading.

import { useState } from 'react';
import useSWR from 'swr';
import { getStatus, postPollingStart, postPollingStop, StatusResponse } from '@/lib/api';

export type CleaningState = 'loading' | 'active' | 'stopped' | 'error';

export interface UseCleaningStateReturn {
  state: CleaningState;
  isLoading: boolean;   // true while start/stop API call is in flight
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Derive the CleaningState enum value from SWR's data / isLoading / error
// ---------------------------------------------------------------------------

function deriveState(
  swrIsLoading: boolean,
  swrError: unknown,
  data: StatusResponse | undefined,
): CleaningState {
  if (swrIsLoading) return 'loading';
  if (swrError) return 'error';
  const cleaningEnabled = data?.pollingEnabled ?? data?.isRunning;
  if (cleaningEnabled === true) return 'active';
  return 'stopped';
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCleaningState(): UseCleaningStateReturn {
  // Separate local state for in-flight start/stop call
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    data,
    isLoading: swrIsLoading,
    error: swrError,
    mutate,
  } = useSWR<StatusResponse>('/api/status', getStatus, {
    // Do not retry on error — surface the error state immediately
    shouldRetryOnError: false,
  });

  const state = deriveState(swrIsLoading, swrError, data);

  // ---------------------------------------------------------------------------
  // start()
  // ---------------------------------------------------------------------------

  const start = async (): Promise<void> => {
    setIsLoading(true);
    setError(null);

    // Capture the previous data so we can revert on failure
    const previous = data;

    try {
      await postPollingStart();

      // Optimistic update — mark cleaning as enabled without a re-fetch
      await mutate(
        {
          ...previous,
          registered: true,
          pollingEnabled: true,
          isRunning: true,
        },
        { revalidate: false },
      );
    } catch (err) {
      // Revert to previous state
      await mutate(previous, { revalidate: false });

      const message =
        err instanceof Error ? err.message : 'Failed to start cleaning. Please try again.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // stop()
  // ---------------------------------------------------------------------------

  const stop = async (): Promise<void> => {
    setIsLoading(true);
    setError(null);

    const previous = data;

    try {
      await postPollingStop();

      // Optimistic update — mark cleaning as disabled without a re-fetch
      await mutate(
        {
          ...previous,
          registered: false,
          pollingEnabled: false,
          isRunning: false,
        },
        { revalidate: false },
      );
    } catch (err) {
      // Revert to previous state
      await mutate(previous, { revalidate: false });

      const message =
        err instanceof Error ? err.message : 'Failed to stop cleaning. Please try again.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return { state, isLoading, error, start, stop };
}
