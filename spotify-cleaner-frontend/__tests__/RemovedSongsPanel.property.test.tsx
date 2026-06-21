/**
 * Property-based tests for the `useRemovals` hook — optimistic re-add and rollback.
 *
 * **Validates: Requirements 9.7, 9.8**
 *
 * Property 11: Optimistic re-add animates row out immediately, then calls the API
 *
 *   For any RemovalRecord shown in the RemovedSongsPanel, clicking its + button must:
 *   (1) immediately add the ID to pendingReAdds (same tick, before API resolves),
 *   (2) issue mutate with the optimistic list (row removed), and
 *   (3) call deleteRemoval with the correct id.
 *   This sequence must hold regardless of network latency.
 *
 * Property 12: Failed re-add rolls back the row to its original position
 *
 *   For any RemovalRecord whose re-add API call returns a non-2xx response:
 *   - The row must be re-inserted at the same index it occupied before the
 *     optimistic removal.
 *   - The + button must be re-enabled (pendingReAdds no longer contains the id).
 *   - rowErrors[id] must contain a non-empty error string.
 *   - Rollback must be correct even when multiple concurrent re-adds are in-flight.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { renderHook, act } from '@testing-library/react';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('swr');
vi.mock('@/lib/api');

// ── Imports after mocking ─────────────────────────────────────────────────────

import useSWR from 'swr';
import { deleteRemoval } from '@/lib/api';
import type { RemovalRecord } from '@/lib/api';
import { useRemovals } from '../hooks/useRemovals';

const mockUseSWR = vi.mocked(useSWR);
const mockDeleteRemoval = vi.mocked(deleteRemoval);

// ── Arbitraries ───────────────────────────────────────────────────────────────

/**
 * Generates a single valid RemovalRecord with all required fields populated.
 */
const removalRecordArbitrary = fc.record({
  id: fc.uuid(),
  user_id: fc.uuid(),
  track_id: fc.uuid(),
  playlist_id: fc.uuid(),
  track_name: fc.string({ minLength: 1, maxLength: 80 }),
  removed_at: fc.date({ min: new Date('2020-01-01'), max: new Date('2026-12-31') }).map((d) =>
    d.toISOString()
  ),
  reason: fc.constantFrom('skipped', 'auto-removed', 'low-play-percentage'),
});

// ── SWR mock helpers ──────────────────────────────────────────────────────────

/**
 * Sets up useSWR to return the given data array via a spy mutate function.
 *
 * Because useRemovals reads `data` directly from the SWR return value, and
 * `mutate` is async in the hook (it awaits `mutate(newData, ...)`), we need
 * the mock mutate to update what useSWR returns on subsequent reads.
 *
 * Strategy: we use a mutable wrapper that both the mock mutate and
 * mockUseSWR can share, so the hook always sees the latest value.
 */
function makeSWRReturn(initialData: RemovalRecord[]) {
  // Mutable container so mutate can update what useSWR returns.
  const state = { data: initialData };

  const mutate = vi.fn(async (newData?: RemovalRecord[] | (() => RemovalRecord[]), _opts?: unknown) => {
    if (typeof newData === 'function') {
      state.data = newData();
    } else if (Array.isArray(newData)) {
      state.data = newData;
    }
    // Re-configure mockUseSWR so subsequent calls in the same render return updated data.
    mockUseSWR.mockReturnValue({
      data: state.data,
      isLoading: false,
      error: null,
      mutate,
    } as unknown as ReturnType<typeof useSWR>);
  });

  mockUseSWR.mockReturnValue({
    data: state.data,
    isLoading: false,
    error: null,
    mutate,
  } as unknown as ReturnType<typeof useSWR>);

  return { mutate, state };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Property 11 ───────────────────────────────────────────────────────────────

describe('Property 11: Optimistic re-add animates row out immediately, then calls the API', () => {
  /**
   * For any non-empty list of removal records, calling reAdd(id) on a valid
   * record must:
   *  1. Add the id to pendingReAdds before any API call completes (optimistic UI),
   *  2. call mutate with an optimistic list that no longer contains the removed record,
   *  3. call deleteRemoval with exactly the correct id.
   *
   * The hook flow is:
   *   a. setPendingReAdds (sync)  → pendingReAdds.has(id) === true immediately
   *   b. await mutate(optimisticList)  → mutate called with record removed
   *   c. await deleteRemoval(id)  → API call made with correct id
   *
   * We verify all three by letting the full reAdd() call complete (deleteRemoval
   * resolves successfully), then asserting the mutate and deleteRemoval calls.
   *
   * Validates: Requirement 9.7
   */
  test(
    'property: pendingReAdds contains id immediately and deleteRemoval is called with correct id',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(removalRecordArbitrary, { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 0, max: 19 }),
          async (list, rawIndex) => {
            vi.clearAllMocks();

            // Clamp index to within the generated list length.
            const targetIndex = rawIndex % list.length;
            const targetRecord = list[targetIndex];

            // Controllable promise — lets us inspect hook state while delete is in-flight.
            let resolveDelete!: () => void;
            const deletePromise = new Promise<void>((resolve) => {
              resolveDelete = resolve;
            });
            mockDeleteRemoval.mockReturnValue(deletePromise);

            const { mutate } = makeSWRReturn(list);

            const { result } = renderHook(() => useRemovals());

            // Kick off reAdd without awaiting so we can inspect intermediate state.
            let reAddPromise!: Promise<void>;
            act(() => {
              reAddPromise = result.current.reAdd(targetRecord.id);
            });

            // --- Assertion window: before the delete API resolves ---

            // 1. The id is in pendingReAdds immediately (synchronous setState).
            expect(result.current.pendingReAdds.has(targetRecord.id)).toBe(true);

            // 2. mutate was called with the optimistic list (record removed).
            //    This happens after the synchronous setPendingReAdds but before deleteRemoval.
            //    We need to flush the microtask queue to let the first `await mutate(...)` run.
            await act(async () => {
              // Yield once to allow the `await mutate(...)` in the hook to settle.
              await Promise.resolve();
            });

            expect(mutate).toHaveBeenCalledWith(
              expect.not.arrayContaining([expect.objectContaining({ id: targetRecord.id })]),
              expect.objectContaining({ revalidate: false })
            );

            // 3. deleteRemoval was called with exactly the target id (after mutate resolved).
            expect(mockDeleteRemoval).toHaveBeenCalledWith(targetRecord.id);

            // Resolve the delete promise to let the hook finish cleanly.
            await act(async () => {
              resolveDelete();
              await reAddPromise;
            });
          }
        ),
        { numRuns: 100 }
      );
    },
    { timeout: 60_000 }
  );

  /**
   * After a successful reAdd, pendingReAdds no longer contains the id and
   * the mutate was called with the optimistic list (exactly once for success).
   *
   * Validates: Requirement 9.7
   */
  test(
    'property: after successful reAdd, pendingReAdds no longer contains the id',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(removalRecordArbitrary, { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 0, max: 19 }),
          async (list, rawIndex) => {
            vi.clearAllMocks();

            const targetIndex = rawIndex % list.length;
            const targetRecord = list[targetIndex];

            mockDeleteRemoval.mockResolvedValue(undefined);
            makeSWRReturn(list);

            const { result } = renderHook(() => useRemovals());

            await act(async () => {
              await result.current.reAdd(targetRecord.id);
            });

            // After success, the id must be removed from pendingReAdds.
            expect(result.current.pendingReAdds.has(targetRecord.id)).toBe(false);

            // deleteRemoval called exactly once with the correct id.
            expect(mockDeleteRemoval).toHaveBeenCalledTimes(1);
            expect(mockDeleteRemoval).toHaveBeenCalledWith(targetRecord.id);
          }
        ),
        { numRuns: 100 }
      );
    },
    { timeout: 60_000 }
  );

  /**
   * The optimistic songs list passed to mutate must not contain the removed
   * record, regardless of which index was targeted.
   *
   * Validates: Requirement 9.7
   */
  test(
    'property: songs list passed to mutate does not contain the removed record',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(removalRecordArbitrary, { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 0, max: 19 }),
          async (list, rawIndex) => {
            vi.clearAllMocks();

            const targetIndex = rawIndex % list.length;
            const targetRecord = list[targetIndex];

            mockDeleteRemoval.mockResolvedValue(undefined);
            const { mutate } = makeSWRReturn(list);

            const { result } = renderHook(() => useRemovals());

            await act(async () => {
              await result.current.reAdd(targetRecord.id);
            });

            // The first mutate call (optimistic removal) must exclude the target.
            const firstCall = mutate.mock.calls[0];
            const optimisticList = firstCall[0] as RemovalRecord[];
            const ids = optimisticList.map((r) => r.id);
            expect(ids).not.toContain(targetRecord.id);
          }
        ),
        { numRuns: 100 }
      );
    },
    { timeout: 60_000 }
  );
});

// ── Property 12 ───────────────────────────────────────────────────────────────

describe('Property 12: Failed re-add rolls back the row to its original position', () => {
  /**
   * When deleteRemoval rejects, the hook must re-insert the removed record at
   * the exact index it occupied before the optimistic removal.
   *
   * Validates: Requirement 9.8
   */
  test(
    'property: row is re-inserted at its original index after API failure',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(removalRecordArbitrary, { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 0, max: 19 }),
          async (list, rawIndex) => {
            vi.clearAllMocks();

            const targetIndex = rawIndex % list.length;
            const targetRecord = list[targetIndex];

            // Mock deleteRemoval to reject.
            mockDeleteRemoval.mockRejectedValue(new Error('HTTP 500'));
            const { mutate } = makeSWRReturn(list);

            const { result } = renderHook(() => useRemovals());

            await act(async () => {
              await result.current.reAdd(targetRecord.id);
            });

            // mutate should have been called at least twice:
            // - Call 0: optimistic removal (without the target)
            // - Call 1: rollback (with the target restored)
            expect(mutate.mock.calls.length).toBeGreaterThanOrEqual(2);

            // Get the rollback call (last mutate call with the record restored).
            const rollbackCall = mutate.mock.calls[mutate.mock.calls.length - 1];
            const rolledBackList = rollbackCall[0] as RemovalRecord[];

            // The rolled-back list must contain the target record.
            const restoredIndex = rolledBackList.findIndex((r) => r.id === targetRecord.id);
            expect(restoredIndex).toBeGreaterThanOrEqual(0);

            // The restored index must equal the original index (clamped to length).
            const expectedIndex = Math.min(targetIndex, rolledBackList.length - 1);
            expect(restoredIndex).toBe(expectedIndex);
          }
        ),
        { numRuns: 100 }
      );
    },
    { timeout: 60_000 }
  );

  /**
   * After a failed reAdd, pendingReAdds must not contain the id
   * (button is re-enabled).
   *
   * Validates: Requirement 9.8
   */
  test(
    'property: pendingReAdds does not contain the id after rollback (button re-enabled)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(removalRecordArbitrary, { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 0, max: 19 }),
          async (list, rawIndex) => {
            vi.clearAllMocks();

            const targetIndex = rawIndex % list.length;
            const targetRecord = list[targetIndex];

            mockDeleteRemoval.mockRejectedValue(new Error('HTTP 500'));
            makeSWRReturn(list);

            const { result } = renderHook(() => useRemovals());

            await act(async () => {
              await result.current.reAdd(targetRecord.id);
            });

            // Button must be re-enabled after rollback.
            expect(result.current.pendingReAdds.has(targetRecord.id)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    },
    { timeout: 60_000 }
  );

  /**
   * After a failed reAdd, rowErrors[id] must contain a non-empty error message.
   *
   * Validates: Requirement 9.8
   */
  test(
    'property: rowErrors[id] has a non-empty error message after rollback',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(removalRecordArbitrary, { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 0, max: 19 }),
          async (list, rawIndex) => {
            vi.clearAllMocks();

            const targetIndex = rawIndex % list.length;
            const targetRecord = list[targetIndex];

            mockDeleteRemoval.mockRejectedValue(new Error('HTTP 500'));
            makeSWRReturn(list);

            const { result } = renderHook(() => useRemovals());

            await act(async () => {
              await result.current.reAdd(targetRecord.id);
            });

            // rowErrors must contain an error message for this id.
            const rowError = result.current.rowErrors[targetRecord.id];
            expect(typeof rowError).toBe('string');
            expect(rowError.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    },
    { timeout: 60_000 }
  );

  /**
   * Concurrent re-add failures: when multiple records are re-added simultaneously
   * and all fail, each must be rolled back to its own original index.
   *
   * Validates: Requirement 9.8 (concurrent rollback correctness)
   */
  test(
    'property: concurrent failed re-adds each roll back to their own original indices',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate a list with at least 2 distinct records so we can pick 2 targets.
          fc
            .array(removalRecordArbitrary, { minLength: 2, maxLength: 10 })
            .filter((list) => new Set(list.map((r) => r.id)).size === list.length),
          async (list) => {
            vi.clearAllMocks();

            // Pick the first two records as concurrent targets.
            const [target0, target1] = list;
            const originalIndex0 = list.findIndex((r) => r.id === target0.id);
            const originalIndex1 = list.findIndex((r) => r.id === target1.id);

            // Both API calls reject.
            let resolveDelete0!: (v: void | PromiseLike<void>) => void;
            let resolveDelete1!: (v: void | PromiseLike<void>) => void;
            const deletePromise0 = new Promise<void>((_, reject) => {
              resolveDelete0 = () => reject(new Error('HTTP 500'));
            });
            const deletePromise1 = new Promise<void>((_, reject) => {
              resolveDelete1 = () => reject(new Error('HTTP 500'));
            });

            mockDeleteRemoval
              .mockReturnValueOnce(deletePromise0)
              .mockReturnValueOnce(deletePromise1);

            const { mutate } = makeSWRReturn(list);

            const { result } = renderHook(() => useRemovals());

            // Fire both reAdds concurrently.
            let p0!: Promise<void>;
            let p1!: Promise<void>;
            act(() => {
              p0 = result.current.reAdd(target0.id);
              p1 = result.current.reAdd(target1.id);
            });

            // Both ids must be in pendingReAdds immediately.
            expect(result.current.pendingReAdds.has(target0.id)).toBe(true);
            expect(result.current.pendingReAdds.has(target1.id)).toBe(true);

            // Resolve (reject) both API calls.
            await act(async () => {
              resolveDelete0();
              resolveDelete1();
              await Promise.allSettled([p0, p1]);
            });

            // Both ids must be removed from pendingReAdds.
            expect(result.current.pendingReAdds.has(target0.id)).toBe(false);
            expect(result.current.pendingReAdds.has(target1.id)).toBe(false);

            // Both should have row errors.
            expect(result.current.rowErrors[target0.id]).toBeTruthy();
            expect(result.current.rowErrors[target1.id]).toBeTruthy();

            // The rollback mutate calls should have restored both records.
            // We check that at some point mutate was called with a list containing
            // each target at its expected (clamped) index.
            const allMutateCalls = mutate.mock.calls as Array<[RemovalRecord[], unknown]>;
            const mutateLists = allMutateCalls.map(([data]) => data as RemovalRecord[]);

            // At least one call should contain target0 at originalIndex0 (clamped).
            const rollback0Found = mutateLists.some((arr) => {
              const idx = arr.findIndex((r) => r.id === target0.id);
              if (idx === -1) return false;
              const expected = Math.min(originalIndex0, arr.length - 1);
              return idx === expected;
            });
            expect(rollback0Found).toBe(true);

            // At least one call should contain target1 at originalIndex1 (clamped).
            const rollback1Found = mutateLists.some((arr) => {
              const idx = arr.findIndex((r) => r.id === target1.id);
              if (idx === -1) return false;
              const expected = Math.min(originalIndex1, arr.length - 1);
              return idx === expected;
            });
            expect(rollback1Found).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    },
    { timeout: 120_000 }
  );

  /**
   * When a record does not exist in the current list (e.g. already removed),
   * reAdd should be a no-op: deleteRemoval must not be called, and neither
   * pendingReAdds nor rowErrors should be updated.
   *
   * Validates: Requirement 9.8 (guard against stale IDs)
   */
  test(
    'unit: reAdd is a no-op when the id is not present in the current songs list',
    async () => {
      vi.clearAllMocks();

      const list = await fc.sample(
        fc.array(removalRecordArbitrary, { minLength: 1, maxLength: 10 }),
        1
      )[0];

      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      mockDeleteRemoval.mockResolvedValue(undefined);
      makeSWRReturn(list);

      const { result } = renderHook(() => useRemovals());

      await act(async () => {
        await result.current.reAdd(nonExistentId);
      });

      // deleteRemoval must NOT have been called.
      expect(mockDeleteRemoval).not.toHaveBeenCalled();

      // pendingReAdds must not contain the non-existent id.
      expect(result.current.pendingReAdds.has(nonExistentId)).toBe(false);

      // No row error for a no-op.
      expect(result.current.rowErrors[nonExistentId]).toBeUndefined();
    }
  );
});
