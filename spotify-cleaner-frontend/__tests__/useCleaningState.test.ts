/**
 * Unit tests for `useCleaningState` hook.
 *
 * Covers:
 * - State derivation: `pollingEnabled: true` → 'active', false → 'stopped'
 * - Backwards compatibility: `isRunning: true` → 'active'
 * - Failed status fetch → 'error' state, defaulting toggle to stopped
 * - `start()` calls `postPollingStart()` and mutates SWR state to active
 * - `stop()` calls `postPollingStop()` and mutates SWR state to stopped
 * - Error on start/stop reverts state and sets an error message
 *
 * Requirements: 7.2, 7.3, 7.6, 7.7, 7.9
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

// We mock the entire 'swr' module so we can control what data/error/isLoading
// each test scenario returns without hitting the network.
vi.mock('swr');

// We mock '@/lib/api' so start/stop API calls can be controlled per-test.
vi.mock('@/lib/api');

// ── Import after mocking ──────────────────────────────────────────────────────

import useSWR from 'swr';
import { postPollingStart, postPollingStop } from '@/lib/api';
import { useCleaningState } from '../hooks/useCleaningState';
import type { StatusResponse } from '@/lib/api';

// Typed mock helpers
const mockUseSWR = vi.mocked(useSWR);
const mockPostPollingStart = vi.mocked(postPollingStart);
const mockPostPollingStop = vi.mocked(postPollingStop);

// ── SWR mock factory ──────────────────────────────────────────────────────────

/**
 * Build the object that `useSWR` returns, filling defaults for fields we
 * don't need to customise.  The `mutate` function is a spy so tests can
 * assert it was called with the right arguments.
 */
function makeSWRReturn(overrides: {
  data?: StatusResponse;
  isLoading?: boolean;
  error?: unknown;
  mutate?: ReturnType<typeof vi.fn>;
}) {
  const mutate =
    overrides.mutate ??
    vi.fn(async (updater?: StatusResponse | ((data?: StatusResponse) => StatusResponse)) => {
      // No-op by default; individual tests override this when needed.
    });

  return {
    data: overrides.data,
    isLoading: overrides.isLoading ?? false,
    error: overrides.error ?? undefined,
    mutate,
    isValidating: false,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── State derivation from /api/status ─────────────────────────────────────────

describe('useCleaningState — state derivation from /api/status (Requirements 7.7)', () => {
  test('returns "active" when pollingEnabled is true even if no poll cycle is running', () => {
    mockUseSWR.mockReturnValue(
      makeSWRReturn({
        data: {
          registered: true,
          pollingEnabled: true,
          isRunning: false,
          isPollCycleRunning: false,
        },
      }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    expect(result.current.state).toBe('active');
  });

  test('returns "stopped" when pollingEnabled is false even if legacy isRunning is true', () => {
    mockUseSWR.mockReturnValue(
      makeSWRReturn({
        data: {
          registered: false,
          pollingEnabled: false,
          isRunning: true,
          isPollCycleRunning: true,
        },
      }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    expect(result.current.state).toBe('stopped');
  });

  test('returns "active" when isRunning is true', () => {
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: { registered: true, isRunning: true } }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    expect(result.current.state).toBe('active');
  });

  test('returns "stopped" when isRunning is false', () => {
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: { registered: true, isRunning: false } }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    expect(result.current.state).toBe('stopped');
  });

  test('returns "stopped" when isRunning is undefined (not present)', () => {
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: { registered: true } }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    expect(result.current.state).toBe('stopped');
  });

  test('returns "loading" while SWR is still fetching (Requirement 7.7)', () => {
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ isLoading: true, data: undefined }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    expect(result.current.state).toBe('loading');
  });
});

// ── Failed status fetch → error state (Requirement 7.9) ──────────────────────

describe('useCleaningState — failed status fetch (Requirement 7.9)', () => {
  test('returns "error" state when SWR errors', () => {
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ error: new Error('Network failure'), data: undefined }) as ReturnType<
        typeof useSWR
      >
    );

    const { result } = renderHook(() => useCleaningState());

    expect(result.current.state).toBe('error');
  });

  test('does NOT return "active" when SWR errors, even if stale data has isRunning=true', () => {
    // Simulates the edge case where SWR has stale data but a current error.
    mockUseSWR.mockReturnValue(
      makeSWRReturn({
        error: new Error('Network failure'),
        data: { registered: true, isRunning: true },
      }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    // Error takes priority over data
    expect(result.current.state).toBe('error');
  });
});

// ── start() behaviour (Requirements 7.4, 7.6, 7.8) ───────────────────────────

describe('useCleaningState — start() (Requirements 7.4, 7.6, 7.8)', () => {
  test('calls postPollingStart() when start() is invoked', async () => {
    mockPostPollingStart.mockResolvedValue(undefined);

    const mutate = vi.fn().mockResolvedValue(undefined);
    mockUseSWR.mockReturnValue(
      makeSWRReturn({
        data: { registered: true, isRunning: false },
        mutate,
      }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    await act(async () => {
      await result.current.start();
    });

    expect(mockPostPollingStart).toHaveBeenCalledTimes(1);
  });

  test('mutates SWR data to isRunning=true after a successful start()', async () => {
    mockPostPollingStart.mockResolvedValue(undefined);

    const mutate = vi.fn().mockResolvedValue(undefined);
    mockUseSWR.mockReturnValue(
      makeSWRReturn({
        data: { registered: true, isRunning: false },
        mutate,
      }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    await act(async () => {
      await result.current.start();
    });

    // mutate should have been called with an object where isRunning === true
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ isRunning: true }),
      expect.objectContaining({ revalidate: false })
    );
  });

  test('sets isLoading=true during start() and resets it afterwards', async () => {
    let resolveStart: () => void;
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    mockPostPollingStart.mockReturnValue(startPromise);

    const mutate = vi.fn().mockResolvedValue(undefined);
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: { registered: true, isRunning: false }, mutate }) as ReturnType<
        typeof useSWR
      >
    );

    const { result } = renderHook(() => useCleaningState());

    // Kick off start() without awaiting
    act(() => {
      void result.current.start();
    });

    // isLoading must be true while the API call is in-flight
    expect(result.current.isLoading).toBe(true);

    // Resolve the API call
    await act(async () => {
      resolveStart!();
      await startPromise;
    });

    expect(result.current.isLoading).toBe(false);
  });

  test('reverts state and sets error message when start() fails (Requirement 7.6)', async () => {
    mockPostPollingStart.mockRejectedValue(new Error('Start failed'));

    const mutate = vi.fn().mockResolvedValue(undefined);
    const previousData: StatusResponse = { registered: true, isRunning: false };

    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: previousData, mutate }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    await act(async () => {
      await result.current.start();
    });

    // Error message must be set
    expect(result.current.error).toBeTruthy();
    expect(typeof result.current.error).toBe('string');

    // mutate should have been called to revert to previous data
    expect(mutate).toHaveBeenCalledWith(previousData, expect.objectContaining({ revalidate: false }));
  });

  test('clears any previous error when start() is called again', async () => {
    // First call fails
    mockPostPollingStart.mockRejectedValueOnce(new Error('First failure'));

    const mutate = vi.fn().mockResolvedValue(undefined);
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: { registered: true, isRunning: false }, mutate }) as ReturnType<
        typeof useSWR
      >
    );

    const { result } = renderHook(() => useCleaningState());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toBeTruthy();

    // Second call succeeds
    mockPostPollingStart.mockResolvedValueOnce(undefined);

    await act(async () => {
      await result.current.start();
    });

    // Error must be cleared now
    expect(result.current.error).toBeNull();
  });
});

// ── stop() behaviour (Requirements 7.5, 7.6, 7.8) ────────────────────────────

describe('useCleaningState — stop() (Requirements 7.5, 7.6, 7.8)', () => {
  test('calls postPollingStop() when stop() is invoked', async () => {
    mockPostPollingStop.mockResolvedValue(undefined);

    const mutate = vi.fn().mockResolvedValue(undefined);
    mockUseSWR.mockReturnValue(
      makeSWRReturn({
        data: { registered: true, isRunning: true },
        mutate,
      }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    await act(async () => {
      await result.current.stop();
    });

    expect(mockPostPollingStop).toHaveBeenCalledTimes(1);
  });

  test('mutates SWR data to isRunning=false after a successful stop()', async () => {
    mockPostPollingStop.mockResolvedValue(undefined);

    const mutate = vi.fn().mockResolvedValue(undefined);
    mockUseSWR.mockReturnValue(
      makeSWRReturn({
        data: { registered: true, isRunning: true },
        mutate,
      }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    await act(async () => {
      await result.current.stop();
    });

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ isRunning: false }),
      expect.objectContaining({ revalidate: false })
    );
  });

  test('sets isLoading=true during stop() and resets it afterwards', async () => {
    let resolveStop: () => void;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    mockPostPollingStop.mockReturnValue(stopPromise);

    const mutate = vi.fn().mockResolvedValue(undefined);
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: { registered: true, isRunning: true }, mutate }) as ReturnType<
        typeof useSWR
      >
    );

    const { result } = renderHook(() => useCleaningState());

    act(() => {
      void result.current.stop();
    });

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveStop!();
      await stopPromise;
    });

    expect(result.current.isLoading).toBe(false);
  });

  test('reverts state and sets error message when stop() fails (Requirement 7.6)', async () => {
    mockPostPollingStop.mockRejectedValue(new Error('Stop failed'));

    const mutate = vi.fn().mockResolvedValue(undefined);
    const previousData: StatusResponse = { registered: true, isRunning: true };

    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: previousData, mutate }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.error).toBeTruthy();
    expect(typeof result.current.error).toBe('string');

    // Revert: mutate called with the previous data
    expect(mutate).toHaveBeenCalledWith(
      previousData,
      expect.objectContaining({ revalidate: false })
    );
  });
});

// ── Return shape ──────────────────────────────────────────────────────────────

describe('useCleaningState — return shape', () => {
  test('exposes state, isLoading, error, start, stop', () => {
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: { registered: true, isRunning: false } }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    expect(result.current).toHaveProperty('state');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
    expect(result.current).toHaveProperty('start');
    expect(result.current).toHaveProperty('stop');
    expect(typeof result.current.start).toBe('function');
    expect(typeof result.current.stop).toBe('function');
  });

  test('initial isLoading (for start/stop calls) is false', () => {
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: { registered: true, isRunning: false } }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    expect(result.current.isLoading).toBe(false);
  });

  test('initial error is null', () => {
    mockUseSWR.mockReturnValue(
      makeSWRReturn({ data: { registered: true, isRunning: false } }) as ReturnType<typeof useSWR>
    );

    const { result } = renderHook(() => useCleaningState());

    expect(result.current.error).toBeNull();
  });
});
