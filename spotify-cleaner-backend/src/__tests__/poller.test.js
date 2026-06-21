// Feature: core-polling-engine
// Property 1: Only users with a non-null refresh_token receive polling intervals
// Property 2: Skip-if-running guard is concurrent-safe
// Property 3: Stagger offset is always within [0, 5000] ms

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before imports of the module under test)
// ---------------------------------------------------------------------------

vi.mock('../lib/supabase.js', () => {
  const mockFrom = vi.fn()
  return { default: vi.fn(() => ({ from: mockFrom })) }
})

vi.mock('../lib/spotify.js', () => ({
  refreshTokenIfNeeded: vi.fn(),
  getCurrentlyPlaying: vi.fn(),
  getRecentlyPlayed: vi.fn(),
  removeTrackFromPlaylist: vi.fn(),
}))

vi.mock('../lib/crypto.js', () => ({
  encrypt: vi.fn((v) => `enc:${v}`),
  decrypt: vi.fn((v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)),
}))

// Import after mocks are registered
import getSupabase from '../lib/supabase.js'
import {
  userState,
  startPollingEngine,
  registerUser,
  deregisterUser,
  runPollCycle,
} from '../lib/poller.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the full Supabase builder chain mock for a given data/error result.
 * Supports:
 *   supabase.from(t).select(s).not(col, op, val) → { data, error }
 *   supabase.from(t).select(s).not(col, op, val).eq(col, val) → { data, error }
 */
function buildSupabaseMock(result) {
  const eqAfterNotMock = vi.fn().mockResolvedValue(result)
  const notMock = vi.fn(() => ({ eq: eqAfterNotMock }))
  const selectMock = vi.fn(() => ({ not: notMock }))
  const fromMock = vi.fn(() => ({ select: selectMock }))
  getSupabase.mockReturnValue({ from: fromMock })
  return { fromMock, selectMock, notMock, eqAfterNotMock }
}

// ---------------------------------------------------------------------------
// Property 1 — Only users with non-null refresh_token get intervals
// Validates: Requirements 1.4
// ---------------------------------------------------------------------------

describe('Property 1: Only users with a non-null refresh_token receive polling intervals', () => {
  // Feature: core-polling-engine, Property 1: Only users with a non-null refresh_token receive polling intervals

  beforeEach(() => {
    vi.clearAllMocks()
    // Clean up any state left over from previous runs
    userState.clear()
  })

  afterEach(() => {
    // Clean up intervals so fake timers don't bleed between tests
    userState.forEach((_, id) => deregisterUser(id))
    userState.clear()
  })

  it('registerUser is called for every user where refresh_token !== null', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.uuid(),
            refresh_token: fc.option(fc.string({ minLength: 1 }), { nil: null }),
          }),
          { minLength: 0, maxLength: 20 }
        ),
        async (users) => {
          vi.clearAllMocks()
          userState.clear()

          // Supabase returns only users with non-null refresh_token
          // (simulating WHERE refresh_token IS NOT NULL)
          const activeUsers = users.filter((u) => u.refresh_token !== null)
          buildSupabaseMock({ data: activeUsers, error: null })

          await startPollingEngine()

          // Every user with non-null refresh_token must be registered
          for (const user of activeUsers) {
            expect(userState.has(user.id)).toBe(true)
          }

          // Users with null refresh_token must NOT be registered
          const nullUsers = users.filter((u) => u.refresh_token === null)
          for (const user of nullUsers) {
            // Only fails if the same UUID appeared in both lists (impossible here),
            // but guard against it by checking the null ones weren't in activeUsers
            if (!activeUsers.some((a) => a.id === user.id)) {
              expect(userState.has(user.id)).toBe(false)
            }
          }

          // Total registered count must equal activeUsers length
          // (some UUIDs from fc.uuid() may collide, so use >=)
          expect(userState.size).toBe(new Set(activeUsers.map((u) => u.id)).size)

          // Clean up for next run
          userState.forEach((_, id) => deregisterUser(id))
          userState.clear()
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 2 — Skip-if-running guard is concurrent-safe
// Validates: Requirements 1.9
// ---------------------------------------------------------------------------

describe('Property 2: Skip-if-running guard is concurrent-safe', () => {
  // Feature: core-polling-engine, Property 2: Skip-if-running guard is concurrent-safe

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    userState.forEach((_, id) => deregisterUser(id))
    userState.clear()
  })

  it('does not call getSupabase when isRunning = true for the userId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        async (userId) => {
          vi.clearAllMocks()
          userState.clear()

          // Seed userState with isRunning: true
          userState.set(userId, {
            intervalId: null,
            isRunning: true,
            consecutive204s: 0,
            reducedMode: false,
            liveTrack: null,
          })

          // Set up a mock so we can detect any call
          buildSupabaseMock({ data: [], error: null })

          // Call runPollCycle — the skip-if-running guard should return immediately
          await runPollCycle(userId)

          // getSupabase must NOT have been called at all
          expect(getSupabase).not.toHaveBeenCalled()

          // Clean up
          userState.delete(userId)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 3 — Stagger offset is always within [0, 5000] ms
// Validates: Requirements 1.10
// ---------------------------------------------------------------------------

describe('Property 3: Stagger offset is always within [0, 5000] ms', () => {
  // Feature: core-polling-engine, Property 3: Stagger offset is always within [0, 5000] ms

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    userState.forEach((_, id) => deregisterUser(id))
    userState.clear()
    vi.useRealTimers()
  })

  it('every stagger delay d satisfies 0 <= d <= 5000', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        (userId) => {
          // Capture all setTimeout calls made during registerUser
          const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

          // Clean state so registerUser isn't a no-op
          deregisterUser(userId)

          setTimeoutSpy.mockClear()
          registerUser(userId)

          // registerUser calls setTimeout once for the stagger delay
          const staggerCalls = setTimeoutSpy.mock.calls
          expect(staggerCalls.length).toBeGreaterThanOrEqual(1)

          // The first setTimeout call is the stagger; check its delay argument
          const staggerDelay = staggerCalls[0][1]
          expect(staggerDelay).toBeGreaterThanOrEqual(0)
          expect(staggerDelay).toBeLessThanOrEqual(5000)

          // Clean up for next iteration
          deregisterUser(userId)
          setTimeoutSpy.mockRestore()
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ---------------------------------------------------------------------------
// Additional imports for Properties 9–12
// ---------------------------------------------------------------------------

import {
  processLiveTrack,
  writeListenEvent,
} from '../lib/poller.js'

// ---------------------------------------------------------------------------
// Property 9 — max_progress_ms is the running maximum of all observed
//              progress_ms values
// Validates: Requirements 4.1
// ---------------------------------------------------------------------------

describe('Property 9: max_progress_ms is the running maximum of all observed progress_ms values', () => {
  // Feature: core-polling-engine, Property 9: max_progress_ms is the running maximum of all observed progress_ms values

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    userState.clear()
  })

  it('state.liveTrack.maxProgressMs equals Math.max(...sequence) after all updates', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 600000 }), { minLength: 1, maxLength: 50 }),
        (sequence) => {
          const userId = 'user-prop9'
          const trackId = 'track-1'

          // Fresh state with an active liveTrack for each run
          const state = {
            intervalId: null,
            isRunning: false,
            consecutive204s: 0,
            reducedMode: false,
            liveTrack: {
              trackId,
              durationMs: 300000,
              maxProgressMs: 0,
              playlistId: 'pl-1',
              pausedSince: null,
            },
          }

          // Feed each progress_ms value through processLiveTrack (same track, is_playing=true)
          for (const progressMs of sequence) {
            const cpResult = {
              item: { id: trackId, duration_ms: 300000 },
              context: { uri: 'spotify:playlist:pl-1' },
              progress_ms: progressMs,
              is_playing: true,
            }
            processLiveTrack(userId, cpResult, state)
          }

          // liveTrack should still be open (no track-change or 204 occurred)
          expect(state.liveTrack).not.toBeNull()
          expect(state.liveTrack.maxProgressMs).toBe(Math.max(...sequence))
        }
      ),
      { numRuns: 200 }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 10 — Live-event source is "delta" iff listened_pct < 0.50
// Validates: Requirements 4.3, 4.8
// ---------------------------------------------------------------------------

describe('Property 10: Live-event source is "delta" iff listened_pct < 0.50', () => {
  // Feature: core-polling-engine, Property 10: Live-event source is "delta" iff listened_pct < 0.50

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    userState.clear()
  })

  it('emitted event source is "delta" iff listenedPct < 0.50, else "live"', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1 }),
        (listenedPct) => {
          const userId = 'user-prop10'
          const originalTrackId = 'track-original'
          const newTrackId = 'track-new'
          const durationMs = 100000

          // maxProgressMs encodes the listenedPct we want to test:
          // listened_pct = maxProgressMs / durationMs
          const maxProgressMs = Math.round(listenedPct * durationMs)

          // State with an existing liveTrack whose listenedPct is controlled by maxProgressMs
          const state = {
            intervalId: null,
            isRunning: false,
            consecutive204s: 0,
            reducedMode: false,
            liveTrack: {
              trackId: originalTrackId,
              durationMs,
              maxProgressMs,
              playlistId: 'pl-1',
              pausedSince: null,
            },
          }

          // Trigger a track-change by presenting a DIFFERENT trackId in the cp result
          const cpResult = {
            item: { id: newTrackId, duration_ms: 300000 },
            context: { uri: 'spotify:playlist:pl-1' },
            progress_ms: 0,
            is_playing: true,
          }

          const events = processLiveTrack(userId, cpResult, state)

          // Exactly one event should have been emitted (the closing of originalTrackId)
          expect(events.length).toBeGreaterThanOrEqual(1)
          const emitted = events[0]

          const actualListenedPct = maxProgressMs / durationMs
          const expectedSource = actualListenedPct < 0.50 ? 'delta' : 'live'
          expect(emitted.source).toBe(expectedSource)
        }
      ),
      { numRuns: 200 }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 11 — Listen event writes are idempotent on (user_id, track_id, listened_at)
// Validates: Requirements 5.1, 5.2
// ---------------------------------------------------------------------------

describe('Property 11: Listen event writes are idempotent on (user_id, track_id, listened_at)', () => {
  // Feature: core-polling-engine, Property 11: Listen event writes are idempotent on (user_id, track_id, listened_at)

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  it('exactly 1 INSERT is issued regardless of how many times writeListenEvent is called', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: fc.uuid(),
          trackId: fc.string({ minLength: 1 }),
          listenedAt: fc.date(),
          listenedPct: fc.float({ min: 0, max: 1 }),
        }),
        fc.integer({ min: 1, max: 5 }),
        async (eventData, N) => {
          vi.clearAllMocks()

          const event = {
            userId: eventData.userId,
            trackId: eventData.trackId,
            playlistId: 'pl-idempotent',
            listenedPct: eventData.listenedPct,
            listenedAt: eventData.listenedAt.toISOString(),
            source: 'live',
          }

          // Track how many times insert() is called
          let insertCallCount = 0

          // Build the Supabase chain mock:
          // - First select call → empty (not yet inserted)
          // - Subsequent select calls → row exists
          // - insert() → success, count calls
          let selectCallCount = 0

          const insertMock = vi.fn().mockImplementation(() => {
            insertCallCount++
            return Promise.resolve({ error: null })
          })

          const limitMock = vi.fn().mockImplementation(() => {
            selectCallCount++
            // First call: not yet inserted
            if (selectCallCount === 1) {
              return Promise.resolve({ data: [], error: null })
            }
            // Subsequent calls: already exists
            return Promise.resolve({ data: [{ id: 'exists' }], error: null })
          })

          const eqMock3 = vi.fn(() => ({ limit: limitMock }))
          const eqMock2 = vi.fn(() => ({ eq: eqMock3 }))
          const eqMock1 = vi.fn(() => ({ eq: eqMock2 }))
          const selectMock = vi.fn(() => ({ eq: eqMock1 }))

          const fromMock = vi.fn((table) => {
            if (table === 'listen_events') {
              return {
                select: selectMock,
                insert: insertMock,
              }
            }
            return { select: selectMock, insert: insertMock }
          })

          getSupabase.mockReturnValue({ from: fromMock })

          // Call writeListenEvent N times with the same event
          for (let i = 0; i < N; i++) {
            await writeListenEvent(event)
          }

          // Exactly 1 INSERT should have been issued
          expect(insertCallCount).toBe(1)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 12 — was_skipped = (listened_pct < 0.25) for all inserted listen events
// Validates: Requirements 5.3
// ---------------------------------------------------------------------------

describe('Property 12: was_skipped = (listened_pct < 0.25) for all inserted listen events', () => {
  // Feature: core-polling-engine, Property 12: was_skipped = (listened_pct < 0.25) for all inserted listen events

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  it('was_skipped in inserted row equals (listenedPct < 0.25) for all listenedPct values', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: 0, max: 1 }),
        async (listenedPct) => {
          vi.clearAllMocks()

          const event = {
            userId: 'user-prop12',
            trackId: 'track-prop12',
            playlistId: 'pl-prop12',
            listenedPct,
            listenedAt: new Date().toISOString(),
            source: 'recent',
          }

          // Capture the row passed to insert()
          let capturedRow = null
          const insertMock = vi.fn().mockImplementation((row) => {
            capturedRow = row
            return Promise.resolve({ error: null })
          })

          // Select returns empty → no duplicate → INSERT will proceed
          const limitMock = vi.fn().mockResolvedValue({ data: [], error: null })
          const eqMock3 = vi.fn(() => ({ limit: limitMock }))
          const eqMock2 = vi.fn(() => ({ eq: eqMock3 }))
          const eqMock1 = vi.fn(() => ({ eq: eqMock2 }))
          const selectMock = vi.fn(() => ({ eq: eqMock1 }))

          const fromMock = vi.fn(() => ({
            select: selectMock,
            insert: insertMock,
          }))

          getSupabase.mockReturnValue({ from: fromMock })

          await writeListenEvent(event)

          // An insert must have happened
          expect(insertMock).toHaveBeenCalledOnce()
          expect(capturedRow).not.toBeNull()

          // was_skipped must equal (listenedPct < 0.25)
          expect(capturedRow.was_skipped).toBe(listenedPct < 0.25)
        }
      ),
      { numRuns: 200 }
    )
  })
})

// ---------------------------------------------------------------------------
// Additional imports for Properties 13–17
// ---------------------------------------------------------------------------

import {
  detectSkip,
  runPollCycle as _runPollCycle,
} from '../lib/poller.js'

import {
  removeTrackFromPlaylist,
  refreshTokenIfNeeded,
  getCurrentlyPlaying,
  getRecentlyPlayed,
} from '../lib/spotify.js'

// ---------------------------------------------------------------------------
// Property 13 — Skip detection triggers removal iff exactly 2 most-recent
//               events are all skips
// Feature: core-polling-engine, Property 13: Skip detection triggers removal iff exactly 2 most-recent events are all skips
// Validates: Requirements 6.2, 6.3, 6.4
// ---------------------------------------------------------------------------

describe('Property 13: Skip detection triggers removal iff exactly 2 most-recent events are all skips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  it('removeTrackFromPlaylist is called iff both of the first 2 rows have was_skipped = true', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ was_skipped: fc.boolean() }),
          { minLength: 0, maxLength: 5 }
        ),
        async (rows) => {
          vi.clearAllMocks()

          // The DB returns at most 2 rows (LIMIT 2); trim the generated list
          const dbRows = rows.slice(0, 2)

          // Both rows must exist and both must be skipped for removal to fire
          const shouldRemove =
            dbRows.length === 2 &&
            dbRows[0].was_skipped === true &&
            dbRows[1].was_skipped === true

          // ── Supabase mock ────────────────────────────────────────────────
          // detectSkip makes two sequential from() calls:
          //   1. from('removal_log') → { data: [], error: null }  (no cutoff)
          //   2. from('listen_events') → { data: dbRows, error: null }
          // After that, if removal fires, removeTrack calls:
          //   3. from('removal_log').insert(...)
          //
          // We use a call counter keyed on table name to return the right data.

          const removalLogInsertMock = vi.fn().mockResolvedValue({ error: null })

          // removal_log select chain (call 1): no cutoff
          const removalLogLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
          const removalLogOrderMock = vi.fn(() => ({ limit: removalLogLimitMock }))
          const removalLogEq3 = vi.fn(() => ({ order: removalLogOrderMock }))
          const removalLogEq2 = vi.fn(() => ({ eq: removalLogEq3 }))
          const removalLogEq1 = vi.fn(() => ({ eq: removalLogEq2 }))
          const removalLogSelectMock = vi.fn(() => ({ eq: removalLogEq1 }))

          // listen_events select chain (call 2): returns dbRows
          const listenEventsLimitMock = vi.fn().mockResolvedValue({ data: dbRows, error: null })
          const listenEventsOrderMock = vi.fn(() => ({ limit: listenEventsLimitMock }))
          const listenEventsEq3 = vi.fn(() => ({ order: listenEventsOrderMock }))
          const listenEventsEq2 = vi.fn(() => ({ eq: listenEventsEq3 }))
          const listenEventsEq1 = vi.fn(() => ({ eq: listenEventsEq2 }))
          const listenEventsSelectMock = vi.fn(() => ({ eq: listenEventsEq1 }))

          const fromMock = vi.fn((table) => {
            if (table === 'removal_log') {
              return {
                select: removalLogSelectMock,
                insert: removalLogInsertMock,
              }
            }
            // listen_events
            return { select: listenEventsSelectMock }
          })

          getSupabase.mockReturnValue({ from: fromMock })

          // removeTrackFromPlaylist is already mocked at module level; reset it
          removeTrackFromPlaylist.mockResolvedValue(true)

          await detectSkip('user-1', 'track-1', 'pl-1', 'access-token')

          if (shouldRemove) {
            expect(removeTrackFromPlaylist).toHaveBeenCalledOnce()
          } else {
            expect(removeTrackFromPlaylist).not.toHaveBeenCalled()
          }
        }
      ),
      { numRuns: 200 }
    )
  })

  it('no removal for 0 rows, 1 row, 1 skip + 1 non-skip, and 2 non-skips', async () => {
    const cases = [
      [],                                                    // 0 rows
      [{ was_skipped: true }],                              // 1 row (skip)
      [{ was_skipped: false }],                             // 1 row (non-skip)
      [{ was_skipped: true }, { was_skipped: false }],      // 1 skip + 1 non-skip
      [{ was_skipped: false }, { was_skipped: true }],      // 1 non-skip + 1 skip
      [{ was_skipped: false }, { was_skipped: false }],     // 2 non-skips
    ]

    for (const dbRows of cases) {
      vi.clearAllMocks()

      const removalLogInsertMock = vi.fn().mockResolvedValue({ error: null })
      const removalLogLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
      const removalLogOrderMock = vi.fn(() => ({ limit: removalLogLimitMock }))
      const removalLogEq3 = vi.fn(() => ({ order: removalLogOrderMock }))
      const removalLogEq2 = vi.fn(() => ({ eq: removalLogEq3 }))
      const removalLogEq1 = vi.fn(() => ({ eq: removalLogEq2 }))
      const removalLogSelectMock = vi.fn(() => ({ eq: removalLogEq1 }))

      const listenEventsLimitMock = vi.fn().mockResolvedValue({ data: dbRows, error: null })
      const listenEventsOrderMock = vi.fn(() => ({ limit: listenEventsLimitMock }))
      const listenEventsEq3 = vi.fn(() => ({ order: listenEventsOrderMock }))
      const listenEventsEq2 = vi.fn(() => ({ eq: listenEventsEq3 }))
      const listenEventsEq1 = vi.fn(() => ({ eq: listenEventsEq2 }))
      const listenEventsSelectMock = vi.fn(() => ({ eq: listenEventsEq1 }))

      const fromMock = vi.fn((table) => {
        if (table === 'removal_log') {
          return { select: removalLogSelectMock, insert: removalLogInsertMock }
        }
        return { select: listenEventsSelectMock }
      })

      getSupabase.mockReturnValue({ from: fromMock })
      removeTrackFromPlaylist.mockResolvedValue(true)

      await detectSkip('user-1', 'track-1', 'pl-1', 'access-token')

      expect(removeTrackFromPlaylist).not.toHaveBeenCalled()
    }
  })
})

// ---------------------------------------------------------------------------
// Property 14 — Re-add history cutoff excludes pre-removal listen events
// Feature: core-polling-engine, Property 14: Re-add history cutoff excludes pre-removal listen events from skip detection
// Validates: Requirements 11.1, 11.2, 11.3, 11.4
// ---------------------------------------------------------------------------

describe('Property 14: Re-add history cutoff excludes pre-removal listen events from skip detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  it('only events after removedAt are considered; pre-cutoff events cannot trigger removal', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            listened_at: fc.date(),
            was_skipped: fc.boolean(),
          }),
          { minLength: 0, maxLength: 5 }
        ),
        fc.date(),
        async (allRows, removedAt) => {
          vi.clearAllMocks()

          // Simulate what the DB does with  listened_at > cutoff  (gt filter)
          const afterCutoff = allRows.filter(
            (r) => r.listened_at.getTime() > removedAt.getTime()
          )
          // DB returns at most 2 rows (LIMIT 2)
          const dbRows = afterCutoff
            .sort((a, b) => b.listened_at.getTime() - a.listened_at.getTime())
            .slice(0, 2)
            .map((r) => ({ was_skipped: r.was_skipped }))

          const shouldRemove =
            dbRows.length === 2 &&
            dbRows[0].was_skipped === true &&
            dbRows[1].was_skipped === true

          // ── Supabase mock ────────────────────────────────────────────────
          // removal_log query returns the cutoff date
          const removalLogInsertMock = vi.fn().mockResolvedValue({ error: null })
          const removalLogLimitMock = vi.fn().mockResolvedValue({
            data: [{ removed_at: removedAt.toISOString() }],
            error: null,
          })
          const removalLogOrderMock = vi.fn(() => ({ limit: removalLogLimitMock }))
          const removalLogEq3 = vi.fn(() => ({ order: removalLogOrderMock }))
          const removalLogEq2 = vi.fn(() => ({ eq: removalLogEq3 }))
          const removalLogEq1 = vi.fn(() => ({ eq: removalLogEq2 }))
          const removalLogSelectMock = vi.fn(() => ({ eq: removalLogEq1 }))

          // listen_events query chain:
          //   .select().eq().eq().eq().order().limit()            (no cutoff)
          //   .select().eq().eq().eq().order().limit().gt()       (with cutoff)
          //
          // When cutoff is present, detectSkip calls .gt() on the *limit* result,
          // so the limit mock must return a thenable AND expose .gt().
          const listenEventsGtMock = vi.fn().mockResolvedValue({ data: dbRows, error: null })
          // limitMock: thenable for the no-cutoff path, and exposes .gt() for the cutoff path
          const listenEventsLimitMock = vi.fn(() => {
            const p = Promise.resolve({ data: dbRows, error: null })
            p.gt = listenEventsGtMock
            return p
          })
          const listenEventsOrderMock = vi.fn(() => ({ limit: listenEventsLimitMock }))
          const listenEventsEq3 = vi.fn(() => ({ order: listenEventsOrderMock }))
          const listenEventsEq2 = vi.fn(() => ({ eq: listenEventsEq3 }))
          const listenEventsEq1 = vi.fn(() => ({ eq: listenEventsEq2 }))
          const listenEventsSelectMock = vi.fn(() => ({ eq: listenEventsEq1 }))

          const fromMock = vi.fn((table) => {
            if (table === 'removal_log') {
              return { select: removalLogSelectMock, insert: removalLogInsertMock }
            }
            return { select: listenEventsSelectMock }
          })

          getSupabase.mockReturnValue({ from: fromMock })
          removeTrackFromPlaylist.mockResolvedValue(true)

          await detectSkip('user-1', 'track-1', 'pl-1', 'access-token')

          if (shouldRemove) {
            expect(removeTrackFromPlaylist).toHaveBeenCalledOnce()
          } else {
            expect(removeTrackFromPlaylist).not.toHaveBeenCalled()
          }

          // The listen_events query must have had gt() called with the cutoff,
          // proving the cutoff was actually passed to the query builder.
          expect(listenEventsGtMock).toHaveBeenCalledWith(
            'listened_at',
            removedAt.toISOString()
          )
        }
      ),
      { numRuns: 150 }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 15 — last_poll_at is always updated to the cycle-start timestamp
// Feature: core-polling-engine, Property 15: last_poll_at is always updated to the cycle-start timestamp at cycle end
// Validates: Requirements 8.1, 8.2, 8.3
// ---------------------------------------------------------------------------

describe('Property 15: last_poll_at is always updated to the cycle-start timestamp at cycle end', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  it('UPDATE users SET last_poll_at is always called, even on a minimal cycle', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        async (userId) => {
          vi.clearAllMocks()
          userState.clear()

          // Seed in-memory state so runPollCycle is not a no-op
          userState.set(userId, {
            intervalId: null,
            isRunning: false,
            consecutive204s: 0,
            reducedMode: false,
            liveTrack: null,
          })

          // ── Spotify mocks (minimal cycle — no tracks) ───────────────────
          refreshTokenIfNeeded.mockResolvedValue({ accessToken: 'tok' })
          getCurrentlyPlaying.mockResolvedValue(null)   // 204
          getRecentlyPlayed.mockResolvedValue([])        // empty

          // ── Supabase mock ────────────────────────────────────────────────
          // We need to handle:
          //   1. from('users').select(...).eq(...).limit(1)  → user row
          //   2. from('users').update(...).eq(...)           → last_poll_at update (in finally)
          //
          // Track whether the update call included a last_poll_at value.
          let lastPollAtUpdated = false
          let capturedLastPollAt = null

          const usersEqForUpdate = vi.fn().mockResolvedValue({ error: null })
          const usersUpdateMock = vi.fn((payload) => {
            if (payload && payload.last_poll_at !== undefined) {
              lastPollAtUpdated = true
              capturedLastPollAt = payload.last_poll_at
            }
            return { eq: usersEqForUpdate }
          })

          const usersLimitMock = vi.fn().mockResolvedValue({
            data: [{
              access_token: 'enc:tok',
              refresh_token: 'enc:ref',
              token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              last_poll_at: null,
            }],
            error: null,
          })
          const usersEqForSelect = vi.fn(() => ({ limit: usersLimitMock }))
          const usersSelectMock = vi.fn(() => ({ eq: usersEqForSelect }))

          const fromMock = vi.fn((table) => {
            if (table === 'users') {
              return {
                select: usersSelectMock,
                update: usersUpdateMock,
              }
            }
            // Any other table (listen_events, removal_log) — return safe no-op chain
            const noopResolved = vi.fn().mockResolvedValue({ data: [], error: null })
            const noopChain = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ order: vi.fn(() => ({ limit: noopResolved })) })) })) }))
            return { select: noopChain, insert: vi.fn().mockResolvedValue({ error: null }) }
          })

          getSupabase.mockReturnValue({ from: fromMock })

          const before = Date.now()
          await runPollCycle(userId)
          const after = Date.now()

          // The update must have been called with a last_poll_at value
          expect(lastPollAtUpdated).toBe(true)
          expect(capturedLastPollAt).not.toBeNull()

          // The timestamp must be within the test window (cycleStart was captured before any awaits)
          const ts = new Date(capturedLastPollAt).getTime()
          expect(ts).toBeGreaterThanOrEqual(before - 100)  // small tolerance
          expect(ts).toBeLessThanOrEqual(after + 100)

          // Clean up
          userState.delete(userId)
        }
      ),
      { numRuns: 50 }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 17 — Reduced_Interval_Mode activates after exactly 5 consecutive
//               204s, exits on any active track
// Feature: core-polling-engine, Property 17: Reduced_Interval_Mode activates after exactly 5 consecutive 204s, exits on any active track
// Validates: Requirements 13.1, 13.2, 13.3
// ---------------------------------------------------------------------------

describe('Property 17: Reduced_Interval_Mode activates after exactly 5 consecutive 204s, exits on any active track', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  it('reducedMode is true only after N >= 5 consecutive 204s, then resets on active-track 200', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (N) => {
          const userId = 'user-prop17'

          // Fresh state for each run
          const state = {
            intervalId: null,
            isRunning: false,
            consecutive204s: 0,
            reducedMode: false,
            liveTrack: null,
          }

          // Feed N consecutive 204s (cpResult = null)
          for (let i = 0; i < N; i++) {
            processLiveTrack(userId, null, state)

            // Before we've hit 5, reducedMode must stay false
            if (i < 4) {
              expect(state.reducedMode).toBe(false)
            }
          }

          // After N calls:
          if (N >= 5) {
            expect(state.reducedMode).toBe(true)
            expect(state.consecutive204s).toBe(N)
          } else {
            expect(state.reducedMode).toBe(false)
            expect(state.consecutive204s).toBe(N)
          }

          // Now feed one active-track 200 response (playlist context)
          const activeTrackResult = {
            item: { id: 'track-active', duration_ms: 200000 },
            context: { uri: 'spotify:playlist:pl-active' },
            progress_ms: 5000,
            is_playing: true,
          }
          processLiveTrack(userId, activeTrackResult, state)

          // reducedMode must be false and consecutive204s must be 0 after any active track
          expect(state.reducedMode).toBe(false)
          expect(state.consecutive204s).toBe(0)
        }
      ),
      { numRuns: 200 }
    )
  })
})

// ---------------------------------------------------------------------------
// Additional imports for tasks 18.2–18.4
// ---------------------------------------------------------------------------

import {
  forbiddenPlaylists,
} from '../lib/poller.js'

// ---------------------------------------------------------------------------
// Task 18.2 — Unit tests: processLiveTrack state transitions
// Validates: Requirements 4.4, 4.5, 4.7, 9.5
// ---------------------------------------------------------------------------

describe('Unit tests: processLiveTrack', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    userState.clear()
  })

  it('Test 1: 204 response → live event emitted and liveTrack cleared', () => {
    // Requirements: 4.4
    const userId = 'user-18-2-1'
    const state = {
      intervalId: null,
      isRunning: false,
      consecutive204s: 0,
      reducedMode: false,
      liveTrack: {
        trackId: 't1',
        durationMs: 200000,
        maxProgressMs: 50000,
        playlistId: 'pl-1',
        pausedSince: null,
      },
    }

    // null = 204
    const events = processLiveTrack(userId, null, state)

    // A live event for t1 should have been emitted
    expect(events).toHaveLength(1)
    expect(events[0].trackId).toBe('t1')

    // liveTrack cleared
    expect(state.liveTrack).toBeNull()

    // consecutive204s incremented to 1
    expect(state.consecutive204s).toBe(1)
  })

  it('Test 2: is_playing = false → state retained, no event emitted, pausedSince set', () => {
    // Requirements: 4.5
    const userId = 'user-18-2-2'
    const state = {
      intervalId: null,
      isRunning: false,
      consecutive204s: 0,
      reducedMode: false,
      liveTrack: {
        trackId: 't2',
        durationMs: 200000,
        maxProgressMs: 60000,
        playlistId: 'pl-1',
        pausedSince: null,
      },
    }

    const cpResult = {
      item: { id: 't2', duration_ms: 200000 },
      context: { uri: 'spotify:playlist:pl-1' },
      progress_ms: 60000,
      is_playing: false,
    }

    const events = processLiveTrack(userId, cpResult, state)

    // No event emitted — track is paused but not closed
    expect(events).toHaveLength(0)

    // State retained
    expect(state.liveTrack).not.toBeNull()
    expect(state.liveTrack.trackId).toBe('t2')

    // pausedSince set
    expect(state.liveTrack.pausedSince).not.toBeNull()
  })

  it('Test 3: paused > 30 consecutive minutes → live event closed using last maxProgressMs', () => {
    // Requirements: 4.7
    const userId = 'user-18-2-3'
    const state = {
      intervalId: null,
      isRunning: false,
      consecutive204s: 0,
      reducedMode: false,
      liveTrack: {
        trackId: 't3',
        durationMs: 200000,
        maxProgressMs: 80000,
        playlistId: 'pl-1',
        // Set pausedSince to 31 minutes ago
        pausedSince: Date.now() - 31 * 60 * 1000,
      },
    }

    const cpResult = {
      item: { id: 't3', duration_ms: 200000 },
      context: { uri: 'spotify:playlist:pl-1' },
      progress_ms: 80000,
      is_playing: false,
    }

    const events = processLiveTrack(userId, cpResult, state)

    // Event should be emitted (paused too long)
    expect(events).toHaveLength(1)

    // liveTrack cleared
    expect(state.liveTrack).toBeNull()
  })

  it('Test 4: track switch from playlist to non-playlist context → live event closed, new track not tracked', () => {
    // Requirements: 9.5
    const userId = 'user-18-2-4'
    const state = {
      intervalId: null,
      isRunning: false,
      consecutive204s: 0,
      reducedMode: false,
      liveTrack: {
        trackId: 'playlist-track',
        durationMs: 180000,
        maxProgressMs: 90000,
        playlistId: 'pl-1',
        pausedSince: null,
      },
    }

    // New track is in an album context (non-playlist)
    const cpResult = {
      item: { id: 'album-track', duration_ms: 150000 },
      context: { uri: 'spotify:album:abc' },
      progress_ms: 0,
      is_playing: true,
    }

    const events = processLiveTrack(userId, cpResult, state)

    // Closed the old playlist track — one event emitted
    expect(events).toHaveLength(1)

    // Non-playlist track is NOT tracked
    expect(state.liveTrack).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Task 18.3 — Unit tests: revoked permissions flow
// Validates: Requirements 12.3, 12.4, 12.5
// ---------------------------------------------------------------------------

describe('Unit tests: revoked permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
  })

  /**
   * Helper: set up the Supabase mock and seed userState for a revocation test.
   * Returns { userId, updateMock } so individual tests can make assertions.
   */
  function setupRevocationTest() {
    const userId = 'user-revoked-18-3'

    // Seed in-memory state so runPollCycle is not a no-op
    userState.set(userId, {
      intervalId: null,
      isRunning: false,
      consecutive204s: 0,
      reducedMode: false,
      liveTrack: null,
    })

    // refreshTokenIfNeeded throws REVOKED error
    const revokedErr = Object.assign(new Error('REVOKED'), { code: 'REVOKED' })
    refreshTokenIfNeeded.mockRejectedValue(revokedErr)

    // getCurrentlyPlaying should not be called — set it up as a spy
    getCurrentlyPlaying.mockResolvedValue(null)

    // Track the update() call so we can inspect its payload
    const updateEqMock = vi.fn().mockResolvedValue({ error: null })
    const updateMock = vi.fn(() => ({ eq: updateEqMock }))

    // users select chain for loading the user row
    const usersLimitMock = vi.fn().mockResolvedValue({
      data: [{
        access_token: 'enc:tok',
        refresh_token: 'enc:ref',
        token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        last_poll_at: null,
      }],
      error: null,
    })
    const usersEqForSelect = vi.fn(() => ({ limit: usersLimitMock }))
    const usersSelectMock = vi.fn(() => ({ eq: usersEqForSelect }))

    const fromMock = vi.fn((table) => {
      if (table === 'users') {
        return {
          select: usersSelectMock,
          update: updateMock,
        }
      }
      return {
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
        insert: vi.fn().mockResolvedValue({ error: null }),
        update: updateMock,
      }
    })

    getSupabase.mockReturnValue({ from: fromMock })

    return { userId, updateMock, updateEqMock }
  }

  it('Test 1: refresh_token set to null in DB after revocation', async () => {
    // Requirements: 12.3
    const { userId, updateMock } = setupRevocationTest()

    await _runPollCycle(userId)

    // update() must have been called with { refresh_token: null }
    expect(updateMock).toHaveBeenCalledWith({ refresh_token: null })
  })

  it('Test 2: after revocation, deregisterUser called and no further Spotify calls made', async () => {
    // Requirements: 12.3, 12.4
    const { userId } = setupRevocationTest()

    await _runPollCycle(userId)

    // userState should no longer contain this user (deregistered)
    expect(userState.has(userId)).toBe(false)

    // getCurrentlyPlaying was never called (no further Spotify calls after revocation)
    expect(getCurrentlyPlaying).not.toHaveBeenCalled()
  })

  it('Test 3: console.warn called with a message containing the userId', async () => {
    // Requirements: 12.5
    const { userId } = setupRevocationTest()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await _runPollCycle(userId)

    // A warning log mentioning the userId must have been emitted
    const warned = warnSpy.mock.calls.some(
      (args) => args.some((a) => typeof a === 'string' && a.includes(userId))
    )
    expect(warned).toBe(true)

    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Task 18.4 — Unit tests: 403 Spotify-owned playlist handling
// Validates: Requirements 9.6
// ---------------------------------------------------------------------------

describe('Unit tests: 403 forbidden playlist', () => {
  const userId = 'user-18-4'
  const trackId = 'track-18-4'
  const playlistId = 'playlist-forbidden-18-4'
  const accessToken = 'access-token-18-4'

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
    // Ensure the playlistId is not in the blocklist at the start of each test
    forbiddenPlaylists.delete(playlistId)
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.delete(playlistId)
  })

  /**
   * Build a Supabase mock that returns 2 skipped listen_events rows to trigger
   * removal, with no prior removal_log cutoff.
   * Accepts an optional insertMock override for removal_log.insert.
   */
  function buildForbiddenSupabaseMock(removalLogInsertMock = vi.fn().mockResolvedValue({ error: null })) {
    const skippedRows = [
      { was_skipped: true },
      { was_skipped: true },
    ]

    // removal_log select: no cutoff
    const removalLogLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
    const removalLogOrderMock = vi.fn(() => ({ limit: removalLogLimitMock }))
    const removalLogEq3 = vi.fn(() => ({ order: removalLogOrderMock }))
    const removalLogEq2 = vi.fn(() => ({ eq: removalLogEq3 }))
    const removalLogEq1 = vi.fn(() => ({ eq: removalLogEq2 }))
    const removalLogSelectMock = vi.fn(() => ({ eq: removalLogEq1 }))

    // listen_events select: 2 skipped rows
    const listenEventsLimitMock = vi.fn().mockResolvedValue({ data: skippedRows, error: null })
    const listenEventsOrderMock = vi.fn(() => ({ limit: listenEventsLimitMock }))
    const listenEventsEq3 = vi.fn(() => ({ order: listenEventsOrderMock }))
    const listenEventsEq2 = vi.fn(() => ({ eq: listenEventsEq3 }))
    const listenEventsEq1 = vi.fn(() => ({ eq: listenEventsEq2 }))
    const listenEventsSelectMock = vi.fn(() => ({ eq: listenEventsEq1 }))

    const fromMock = vi.fn((table) => {
      if (table === 'removal_log') {
        return {
          select: removalLogSelectMock,
          insert: removalLogInsertMock,
        }
      }
      return { select: listenEventsSelectMock }
    })

    getSupabase.mockReturnValue({ from: fromMock })

    return { removalLogInsertMock, fromMock }
  }

  it('Test 1: removal_log is NOT written after 403', async () => {
    // Requirements: 9.6
    const removalLogInsertMock = vi.fn().mockResolvedValue({ error: null })
    buildForbiddenSupabaseMock(removalLogInsertMock)

    // removeTrackFromPlaylist throws 403 FORBIDDEN_PLAYLIST
    const forbiddenErr = Object.assign(new Error('403'), { code: 'FORBIDDEN_PLAYLIST' })
    removeTrackFromPlaylist.mockRejectedValue(forbiddenErr)

    await detectSkip(userId, trackId, playlistId, accessToken)

    // removal_log.insert must NOT have been called
    expect(removalLogInsertMock).not.toHaveBeenCalled()
  })

  it('Test 2: playlist ID is added to in-memory forbiddenPlaylists after 403', async () => {
    // Requirements: 9.6
    buildForbiddenSupabaseMock()

    const forbiddenErr = Object.assign(new Error('403'), { code: 'FORBIDDEN_PLAYLIST' })
    removeTrackFromPlaylist.mockRejectedValue(forbiddenErr)

    // Not in blocklist before call
    expect(forbiddenPlaylists.has(playlistId)).toBe(false)

    await detectSkip(userId, trackId, playlistId, accessToken)

    // Added to blocklist after call
    expect(forbiddenPlaylists.has(playlistId)).toBe(true)

    // Cleanup
    forbiddenPlaylists.delete(playlistId)
  })

  it('Test 3: subsequent removal attempts for same playlist_id skipped without calling Spotify', async () => {
    // Requirements: 9.6
    // Pre-populate the blocklist with an active (non-expired) TTL entry
    forbiddenPlaylists.set(playlistId, Date.now() + 6 * 60 * 60 * 1000)

    buildForbiddenSupabaseMock()

    // removeTrackFromPlaylist mock is set up but should NOT be called
    removeTrackFromPlaylist.mockResolvedValue(true)

    await detectSkip(userId, trackId, playlistId, accessToken)

    // Spotify removal must NOT have been called
    expect(removeTrackFromPlaylist).not.toHaveBeenCalled()

    // Cleanup
    forbiddenPlaylists.delete(playlistId)
  })
})

// ---------------------------------------------------------------------------
// Task 18.5 — Integration test: full poll cycle with mocked Spotify client
// Validates: Requirements 1.1, 1.3, 5.1, 8.1
// ---------------------------------------------------------------------------

describe('Integration: full poll cycle with mocked Spotify client', () => {
  const userId = 'user-int-18-5'

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.clear()
  })

  it('calls both Spotify endpoints, writes the recently-played event, and updates last_poll_at', async () => {
    // Seed userState with a fresh entry (not running)
    userState.set(userId, {
      intervalId: null,
      isRunning: false,
      consecutive204s: 0,
      reducedMode: false,
      liveTrack: null,
      pollCount: 3,
    })

    // ── Spotify mocks ────────────────────────────────────────────────────
    refreshTokenIfNeeded.mockResolvedValue({ accessToken: 'tok' })

    // getCurrentlyPlaying returns an active track in a playlist
    getCurrentlyPlaying.mockResolvedValue({
      item: { id: 'track-int-1', duration_ms: 200000 },
      context: { uri: 'spotify:playlist:pl-int-1' },
      progress_ms: 50000,
      is_playing: true,
    })

    // getRecentlyPlayed returns one item played 1 minute ago
    const recentPlayedAt = new Date(Date.now() - 60000).toISOString()
    getRecentlyPlayed.mockResolvedValue([
      {
        track: { id: 'track-rp-1', duration_ms: 180000 },
        context: { uri: 'spotify:playlist:pl-rp-1' },
        played_at: recentPlayedAt,
      },
    ])

    // ── Supabase mock ────────────────────────────────────────────────────
    // Set last_poll_at to 2 minutes ago so the recently-played item passes the filter
    const lastPollAt = new Date(Date.now() - 120000).toISOString()

    // Capture listen_events inserts
    let capturedInsertRow = null
    const listenEventsInsertMock = vi.fn().mockImplementation((row) => {
      capturedInsertRow = row
      return Promise.resolve({ error: null })
    })

    // Track last_poll_at update
    let lastPollAtUpdated = false
    let capturedLastPollAt = null
    const usersUpdateEqMock = vi.fn().mockResolvedValue({ error: null })
    const usersUpdateMock = vi.fn((payload) => {
      if (payload && payload.last_poll_at !== undefined) {
        lastPollAtUpdated = true
        capturedLastPollAt = payload.last_poll_at
      }
      return { eq: usersUpdateEqMock }
    })

    // users.select chain: returns the user row
    const usersLimitMock = vi.fn().mockResolvedValue({
      data: [{
        access_token: 'enc:tok',
        refresh_token: 'enc:ref',
        token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        last_poll_at: lastPollAt,
      }],
      error: null,
    })
    const usersEqForSelect = vi.fn(() => ({ limit: usersLimitMock }))
    const usersSelectMock = vi.fn(() => ({ eq: usersEqForSelect }))

    // listen_events.select chain: dedup returns empty (no existing events)
    const listenEventsLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
    const listenEventsEq3 = vi.fn(() => ({ limit: listenEventsLimitMock }))
    const listenEventsEq2 = vi.fn(() => ({ eq: listenEventsEq3 }))
    const listenEventsEq1 = vi.fn(() => ({ eq: listenEventsEq2 }))
    const listenEventsSelectMock = vi.fn(() => ({ eq: listenEventsEq1 }))

    // removal_log.select chain: no cutoff, and skip detection returns no skips
    const removalLogLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
    const removalLogOrderMock = vi.fn(() => ({ limit: removalLogLimitMock }))
    const removalLogEq3 = vi.fn(() => ({ order: removalLogOrderMock }))
    const removalLogEq2 = vi.fn(() => ({ eq: removalLogEq3 }))
    const removalLogEq1 = vi.fn(() => ({ eq: removalLogEq2 }))
    const removalLogSelectMock = vi.fn(() => ({ eq: removalLogEq1 }))
    const removalLogInsertMock = vi.fn().mockResolvedValue({ error: null })

    // skip detection listen_events query (order + limit): returns < 2 rows → no removal
    const skipCheckLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
    const skipCheckOrderMock = vi.fn(() => ({ limit: skipCheckLimitMock }))
    const skipCheckEq3 = vi.fn(() => ({ order: skipCheckOrderMock }))
    const skipCheckEq2 = vi.fn(() => ({ eq: skipCheckEq3 }))
    const skipCheckEq1 = vi.fn(() => ({ eq: skipCheckEq2 }))
    const skipCheckSelectMock = vi.fn(() => ({ eq: skipCheckEq1 }))

    // Table dispatch: route by table name
    let listenEventsSelectCallCount = 0
    const fromMock = vi.fn((table) => {
      if (table === 'users') {
        return {
          select: usersSelectMock,
          update: usersUpdateMock,
        }
      }
      if (table === 'listen_events') {
        listenEventsSelectCallCount++
        // First select is the dedup check; subsequent selects are skip-detection queries
        return {
          select: listenEventsSelectCallCount <= 1 ? listenEventsSelectMock : skipCheckSelectMock,
          insert: listenEventsInsertMock,
        }
      }
      if (table === 'removal_log') {
        return {
          select: removalLogSelectMock,
          insert: removalLogInsertMock,
        }
      }
      // Fallback: safe no-op
      const noopLimit = vi.fn().mockResolvedValue({ data: [], error: null })
      const noopEq = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ limit: noopLimit })) })) }))
      return {
        select: vi.fn(() => ({ eq: noopEq })),
        insert: vi.fn().mockResolvedValue({ error: null }),
      }
    })

    getSupabase.mockReturnValue({ from: fromMock })

    // ── Run the cycle ────────────────────────────────────────────────────
    await _runPollCycle(userId)

    // Both Spotify endpoints must have been called
    expect(getCurrentlyPlaying).toHaveBeenCalledOnce()
    expect(getRecentlyPlayed).toHaveBeenCalledOnce()

    // listen_events.insert was called for the recently-played event (track-rp-1)
    expect(listenEventsInsertMock).toHaveBeenCalledOnce()
    expect(capturedInsertRow).not.toBeNull()
    expect(capturedInsertRow.track_id).toBe('track-rp-1')

    // last_poll_at was updated
    expect(lastPollAtUpdated).toBe(true)
    expect(capturedLastPollAt).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Task 18.6 — Integration test: skip detection → removal log written
// Validates: Requirements 6.2, 7.2
// ---------------------------------------------------------------------------

describe('Integration: skip detection → removal log written', () => {
  const userId = 'user-int-18-6'
  const trackId = 'track-int-18-6'
  const playlistId = 'pl-int-18-6'
  const accessToken = 'tok-int-18-6'

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.delete(playlistId)
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.delete(playlistId)
  })

  it('calls removeTrackFromPlaylist and inserts removal_log row with stored display metadata', async () => {
    // ── Supabase mock ────────────────────────────────────────────────────

    // removal_log select: no cutoff
    const removalLogLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
    const removalLogOrderMock = vi.fn(() => ({ limit: removalLogLimitMock }))
    const removalLogEq3 = vi.fn(() => ({ order: removalLogOrderMock }))
    const removalLogEq2 = vi.fn(() => ({ eq: removalLogEq3 }))
    const removalLogEq1 = vi.fn(() => ({ eq: removalLogEq2 }))
    const removalLogSelectMock = vi.fn(() => ({ eq: removalLogEq1 }))

    // Capture the removal_log insert row
    let capturedRemovalRow = null
    const removalLogInsertMock = vi.fn().mockImplementation((row) => {
      capturedRemovalRow = row
      return Promise.resolve({ error: null })
    })

    // listen_events select: 2 rows with was_skipped: true
    const listenEventsLimitMock = vi.fn().mockResolvedValue({
      data: [{ was_skipped: true }, { was_skipped: true }],
      error: null,
    })
    const listenEventsOrderMock = vi.fn(() => ({ limit: listenEventsLimitMock }))
    const listenEventsEq3 = vi.fn(() => ({ order: listenEventsOrderMock }))
    const listenEventsEq2 = vi.fn(() => ({ eq: listenEventsEq3 }))
    const listenEventsEq1 = vi.fn(() => ({ eq: listenEventsEq2 }))
    const listenEventsSelectMock = vi.fn(() => ({ eq: listenEventsEq1 }))

    const fromMock = vi.fn((table) => {
      if (table === 'removal_log') {
        return {
          select: removalLogSelectMock,
          insert: removalLogInsertMock,
        }
      }
      // listen_events
      return { select: listenEventsSelectMock }
    })

    getSupabase.mockReturnValue({ from: fromMock })

    // removeTrackFromPlaylist resolves successfully
    removeTrackFromPlaylist.mockResolvedValue(true)

    // ── Run detectSkip directly ──────────────────────────────────────────
    const trackMetadata = {
      name: 'Stored Test Track',
      artist: 'Stored Artist',
      albumArt: 'https://i.scdn.co/image/stored-album-art',
    }

    await detectSkip(userId, trackId, playlistId, accessToken, undefined, trackMetadata)

    // removeTrackFromPlaylist must have been called once
    expect(removeTrackFromPlaylist).toHaveBeenCalledOnce()

    // removal_log.insert must have been called with the correct row
    expect(removalLogInsertMock).toHaveBeenCalledOnce()
    expect(capturedRemovalRow).not.toBeNull()
    expect(capturedRemovalRow.reason).toBe('skipped 2/2 recent listens')
    expect(capturedRemovalRow.user_id).toBe(userId)
    expect(capturedRemovalRow.track_id).toBe(trackId)
    expect(capturedRemovalRow.playlist_id).toBe(playlistId)
    expect(capturedRemovalRow.track_name).toBe(trackMetadata.name)
    expect(capturedRemovalRow.artist_name).toBe(trackMetadata.artist)
    expect(capturedRemovalRow.album_art).toBe(trackMetadata.albumArt)
  })
})

// ---------------------------------------------------------------------------
// Task 18.7 — Integration test: registerUser post-startup via auth callback
// Validates: Requirements 1.6
// ---------------------------------------------------------------------------

describe('Integration: registerUser post-startup via auth callback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    userState.clear()
  })

  afterEach(() => {
    // Deregister any users registered during the test
    userState.forEach((_, id) => deregisterUser(id))
    userState.clear()
    vi.useRealTimers()
  })

  it('registers a new user immediately and is idempotent on repeated calls', () => {
    const newUserId = 'user-int-18-7-new'

    // userState is clear — simulates the engine already running but this user not yet present
    expect(userState.has(newUserId)).toBe(false)

    // Call registerUser (simulates post-OAuth auth callback)
    registerUser(newUserId)

    // userState must contain the new user immediately after the call
    expect(userState.has(newUserId)).toBe(true)

    // The entry should exist with intervalId: null (stagger setTimeout hasn't fired yet)
    const state = userState.get(newUserId)
    expect(state).not.toBeNull()
    expect(state.intervalId).toBeNull()
    expect(state.isRunning).toBe(false)

    // Advance fake timers past the max stagger (5000 ms) + a bit so the setTimeout fires
    // and setInterval is created
    vi.advanceTimersByTime(6000)

    // After the stagger fires, intervalId should now be set
    expect(userState.get(newUserId).intervalId).not.toBeNull()

    // ── Idempotency: calling registerUser again should be a no-op ────────
    const stateBeforeSecondCall = { ...userState.get(newUserId) }

    registerUser(newUserId)

    // userState still has exactly the same entry (size hasn't changed)
    expect(userState.has(newUserId)).toBe(true)
    expect(userState.get(newUserId).intervalId).toBe(stateBeforeSecondCall.intervalId)
  })
})

// ---------------------------------------------------------------------------
// Feature: playlist-403-blocklist-fix
// Task 1 — Bug condition exploration test (poller layer)
// Property 1: Bug Condition — a missing-scope 403 on an editable playlist must
//             NOT blocklist the playlist and MUST record a durable re-auth
//             signal for the affected user.
//
// The fixed spotify layer classifies an editable-playlist generic 403 as
// MISSING_SCOPE; this test drives removeTrack with that classification and
// asserts the expected poller-layer behavior.
//
// This test MUST FAIL on the UNFIXED code: there is no `usersNeedingReauth`
// re-auth signal store, so no durable re-auth signal can be recorded. The
// failure confirms the "no re-auth signal exists" defect.
//
// Validates: Requirements 1.2, 1.3 (encodes expected behavior 2.2, 2.3)
// ---------------------------------------------------------------------------

// Namespace import so a missing `usersNeedingReauth` export on unfixed code
// resolves to `undefined` instead of crashing the module load.
import * as pollerExports from '../lib/poller.js'

describe('Bug condition (Property 1): missing-scope 403 does not blocklist and records re-auth signal', () => {
  // Feature: playlist-403-blocklist-fix, Property 1: Bug Condition

  const userId = 'user-bug-cond'
  const trackId = 'track-bug-cond'
  const playlistId = 'playlist-editable-bug-cond'
  const accessToken = 'access-token-bug'

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.delete(playlistId)
    pollerExports.usersNeedingReauth?.delete?.(userId)
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.delete(playlistId)
    pollerExports.usersNeedingReauth?.delete?.(userId)
  })

  /** Supabase mock: 2 skipped listen_events rows (no cutoff) → triggers removeTrack. */
  function buildSkipTriggerSupabaseMock() {
    const skippedRows = [{ was_skipped: true }, { was_skipped: true }]

    const removalLogLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
    const removalLogOrderMock = vi.fn(() => ({ limit: removalLogLimitMock }))
    const removalLogEq3 = vi.fn(() => ({ order: removalLogOrderMock }))
    const removalLogEq2 = vi.fn(() => ({ eq: removalLogEq3 }))
    const removalLogEq1 = vi.fn(() => ({ eq: removalLogEq2 }))
    const removalLogSelectMock = vi.fn(() => ({ eq: removalLogEq1 }))
    const removalLogInsertMock = vi.fn().mockResolvedValue({ error: null })

    const listenEventsLimitMock = vi.fn().mockResolvedValue({ data: skippedRows, error: null })
    const listenEventsOrderMock = vi.fn(() => ({ limit: listenEventsLimitMock }))
    const listenEventsEq3 = vi.fn(() => ({ order: listenEventsOrderMock }))
    const listenEventsEq2 = vi.fn(() => ({ eq: listenEventsEq3 }))
    const listenEventsEq1 = vi.fn(() => ({ eq: listenEventsEq2 }))
    const listenEventsSelectMock = vi.fn(() => ({ eq: listenEventsEq1 }))

    const fromMock = vi.fn((table) => {
      if (table === 'removal_log') {
        return { select: removalLogSelectMock, insert: removalLogInsertMock }
      }
      return { select: listenEventsSelectMock }
    })

    getSupabase.mockReturnValue({ from: fromMock })
    return { removalLogInsertMock }
  }

  it('editable-playlist 403 (MISSING_SCOPE) → playlist NOT blocklisted and user flagged for re-auth', async () => {
    // Feature: playlist-403-blocklist-fix, Property 1: Bug Condition
    buildSkipTriggerSupabaseMock()

    // The fixed spotify layer classifies an editable-playlist generic 403 as
    // MISSING_SCOPE (token lacks playlist-modify scope, playlist itself is fine).
    const scopeErr = Object.assign(new Error('403'), { code: 'MISSING_SCOPE' })
    removeTrackFromPlaylist.mockRejectedValue(scopeErr)

    await detectSkip(userId, trackId, playlistId, accessToken)

    // Expected behavior 2.2 — must NOT add the editable playlist to the blocklist.
    const blocked =
      typeof forbiddenPlaylists.has === 'function' && forbiddenPlaylists.has(playlistId)
    expect(blocked).toBe(false)

    // Expected behavior 2.3 — must record a durable re-auth signal for the user.
    expect(pollerExports.usersNeedingReauth?.has?.(userId)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Feature: playlist-403-blocklist-fix
// Task 2 — Preservation property tests (poller layer)
// Property 2: Preservation — non-bug poller outcomes are unchanged.
//
// These tests MUST PASS on the UNFIXED code (they encode the baseline behavior
// to preserve) AND must continue to pass on the FIXED code:
//   - Req 3.2: a successful (2xx) removal still writes a removal_log row and
//              never blocklists the playlist.
//   - Req 3.3: a non-403 error (404 / 429-after-retries-exhausted / 5xx /
//              network / timeout) is logged and skipped — no removal_log row,
//              no blocklist entry.
//   - Req 3.4: a genuine FORBIDDEN_PLAYLIST result blocklists the playlist and
//              writes no removal_log row.
//   - Req 3.5: while a playlist's blocklist entry is active, subsequent removal
//              attempts skip the Spotify call entirely.
//
// `forbiddenPlaylists.has(...)` / `.clear()` work identically whether the
// export is a Set (unfixed) or a Map (fixed), and Req 3.5 is asserted via the
// observable "second attempt makes no Spotify call" behavior rather than the
// data-structure internals, so the assertions hold in both worlds.
//
// Validates: Requirements 3.2, 3.3, 3.4, 3.5
// ---------------------------------------------------------------------------

describe('Preservation (Property 2): non-bug poller outcomes are unchanged', () => {
  // Feature: playlist-403-blocklist-fix, Property 2: Preservation

  const accessToken = 'access-token-preserve'

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.clear()
  })

  /**
   * Supabase mock that returns 2 skipped listen_events rows (and no removal_log
   * cutoff) so detectSkip proceeds to call removeTrack. Returns the removal_log
   * insert mock so callers can assert whether a removal was recorded.
   */
  function buildSkipTriggerSupabaseMock() {
    const skippedRows = [{ was_skipped: true }, { was_skipped: true }]

    const removalLogInsertMock = vi.fn().mockResolvedValue({ error: null })
    const removalLogLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
    const removalLogOrderMock = vi.fn(() => ({ limit: removalLogLimitMock }))
    const removalLogEq3 = vi.fn(() => ({ order: removalLogOrderMock }))
    const removalLogEq2 = vi.fn(() => ({ eq: removalLogEq3 }))
    const removalLogEq1 = vi.fn(() => ({ eq: removalLogEq2 }))
    const removalLogSelectMock = vi.fn(() => ({ eq: removalLogEq1 }))

    const listenEventsLimitMock = vi.fn().mockResolvedValue({ data: skippedRows, error: null })
    const listenEventsOrderMock = vi.fn(() => ({ limit: listenEventsLimitMock }))
    const listenEventsEq3 = vi.fn(() => ({ order: listenEventsOrderMock }))
    const listenEventsEq2 = vi.fn(() => ({ eq: listenEventsEq3 }))
    const listenEventsEq1 = vi.fn(() => ({ eq: listenEventsEq2 }))
    const listenEventsSelectMock = vi.fn(() => ({ eq: listenEventsEq1 }))

    const fromMock = vi.fn((table) => {
      if (table === 'removal_log') {
        return { select: removalLogSelectMock, insert: removalLogInsertMock }
      }
      return { select: listenEventsSelectMock }
    })

    getSupabase.mockReturnValue({ from: fromMock })
    return { removalLogInsertMock }
  }

  // ── Req 3.2 — successful (2xx) removal ────────────────────────────────────
  it('Req 3.2: successful removal → removal_log inserted and playlist NOT blocklisted (unchanged)', async () => {
    // Feature: playlist-403-blocklist-fix, Property 2: Preservation
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        async (userId, trackId, playlistId) => {
          vi.clearAllMocks()
          forbiddenPlaylists.clear()

          const { removalLogInsertMock } = buildSkipTriggerSupabaseMock()
          removeTrackFromPlaylist.mockResolvedValue(true)

          await detectSkip(userId, trackId, playlistId, accessToken)

          // Spotify removal attempted, removal recorded, playlist not blocklisted.
          expect(removeTrackFromPlaylist).toHaveBeenCalledOnce()
          expect(removalLogInsertMock).toHaveBeenCalledOnce()
          expect(forbiddenPlaylists.has(playlistId)).toBe(false)
        }
      ),
      { numRuns: 50 }
    )
  })

  // ── Req 3.3 — non-403 errors ──────────────────────────────────────────────
  it('Req 3.3: non-403 errors (404/429-exhausted/5xx/network/timeout) → logged, no removal_log, no blocklist (unchanged)', async () => {
    // Feature: playlist-403-blocklist-fix, Property 2: Preservation
    const nonForbiddenError = fc.oneof(
      // 404 Not Found
      fc.constant(Object.assign(new Error('Request failed with status code 404'), {
        response: { status: 404 },
      })),
      // 429 after rate-limit retries exhausted (plain Error, no code/response)
      fc.constant(new Error('[spotify] Rate-limit retries exhausted for https://api.spotify.com/v1/playlists/x/tracks')),
      // 5xx server error
      fc.constant(Object.assign(new Error('Request failed with status code 503'), {
        response: { status: 503 },
      })),
      // Network error
      fc.constant(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
      // Timeout
      fc.constant(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }))
    )

    await fc.assert(
      fc.asyncProperty(
        nonForbiddenError,
        fc.uuid(),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        async (err, userId, trackId, playlistId) => {
          vi.clearAllMocks()
          forbiddenPlaylists.clear()

          const { removalLogInsertMock } = buildSkipTriggerSupabaseMock()
          removeTrackFromPlaylist.mockRejectedValue(err)
          const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

          await detectSkip(userId, trackId, playlistId, accessToken)

          // Spotify removal attempted, failure logged, nothing recorded or blocklisted.
          expect(removeTrackFromPlaylist).toHaveBeenCalledOnce()
          expect(errorSpy).toHaveBeenCalled()
          expect(removalLogInsertMock).not.toHaveBeenCalled()
          expect(forbiddenPlaylists.has(playlistId)).toBe(false)

          errorSpy.mockRestore()
        }
      ),
      { numRuns: 50 }
    )
  })

  // ── Req 3.4 / 3.5 — genuine forbidden playlist blocklisted + skipped ──────
  it('Req 3.4/3.5: FORBIDDEN_PLAYLIST → blocklisted, no removal_log, and a still-active entry skips the Spotify call (unchanged)', async () => {
    // Feature: playlist-403-blocklist-fix, Property 2: Preservation
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        async (userId, trackId, playlistId) => {
          vi.clearAllMocks()
          forbiddenPlaylists.clear()

          const { removalLogInsertMock } = buildSkipTriggerSupabaseMock()
          const forbiddenErr = Object.assign(new Error('403'), { code: 'FORBIDDEN_PLAYLIST' })
          removeTrackFromPlaylist.mockRejectedValue(forbiddenErr)

          // First attempt: classified FORBIDDEN_PLAYLIST → blocklist, no removal_log (Req 3.4).
          await detectSkip(userId, trackId, playlistId, accessToken)

          expect(removeTrackFromPlaylist).toHaveBeenCalledOnce()
          expect(removalLogInsertMock).not.toHaveBeenCalled()
          expect(forbiddenPlaylists.has(playlistId)).toBe(true)

          // Second attempt while the entry is still active: the Spotify removal
          // call is skipped entirely (Req 3.5).
          removeTrackFromPlaylist.mockClear()
          buildSkipTriggerSupabaseMock()

          await detectSkip(userId, trackId, playlistId, accessToken)

          expect(removeTrackFromPlaylist).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 50 }
    )
  })
})

// ---------------------------------------------------------------------------
// Task 4 — Property 3: Recovery — Blocklist entries are not permanent
// Validates: Requirements 2.4
//
// Recovery is a universal property over insertion times: a blocklist entry is
// blocked iff `now < expiresAt`, an expired entry is lazily evicted and becomes
// retryable, `blockPlaylist` sets `expiresAt = now + BLOCKLIST_TTL_MS`, and a
// successful re-auth (`registerUser`) clears the user from `usersNeedingReauth`
// and drops their blocklist entries. Fast-check exercises many TTL/clock
// combinations; Vitest fake timers give us a controlled `Date.now()`.
// ---------------------------------------------------------------------------

import {
  isPlaylistBlocked,
  blockPlaylist,
  BLOCKLIST_TTL_MS,
  usersNeedingReauth,
} from '../lib/poller.js'

describe('Property 3: Recovery — blocklist entries are not permanent', () => {
  // Feature: playlist-403-blocklist-fix, Property 3: Recovery — Blocklist entries are not permanent

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.clear()
    usersNeedingReauth.clear()
  })

  afterEach(() => {
    // Drop any polling intervals registerUser may have created so fake timers
    // don't bleed into other tests, then restore real timers.
    userState.forEach((_, id) => deregisterUser(id))
    userState.clear()
    forbiddenPlaylists.clear()
    usersNeedingReauth.clear()
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // isPlaylistBlocked(playlistId) === (now < expiresAt), with lazy eviction
  // of expired entries (which then become retryable).
  // -------------------------------------------------------------------------
  it('isPlaylistBlocked returns true iff now < expiresAt; expired entries are evicted and retryable', () => {
    fc.assert(
      fc.property(
        // base wall-clock time (epoch ms)
        fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
        // varied insertion offset → expiresAt relative to base (past or future)
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        // how far the clock advances after insertion
        fc.integer({ min: 0, max: 2_000_000_000 }),
        (baseTime, expiresOffset, advanceMs) => {
          forbiddenPlaylists.clear()
          vi.setSystemTime(baseTime)

          const playlistId = 'pl-recovery'
          const expiresAt = baseTime + expiresOffset
          forbiddenPlaylists.set(playlistId, expiresAt)

          // Advance the controlled clock.
          vi.setSystemTime(baseTime + advanceMs)

          const now = Date.now()
          const expectedBlocked = now < expiresAt

          expect(isPlaylistBlocked(playlistId)).toBe(expectedBlocked)

          if (expectedBlocked) {
            // Still active — entry remains in the map.
            expect(forbiddenPlaylists.has(playlistId)).toBe(true)
          } else {
            // Expired (or already past) — lazily evicted from the map …
            expect(forbiddenPlaylists.has(playlistId)).toBe(false)
            // … and retryable: a subsequent check is still false (no entry).
            expect(isPlaylistBlocked(playlistId)).toBe(false)
          }
        }
      ),
      { numRuns: 200 }
    )
  })

  // -------------------------------------------------------------------------
  // An entry inserted with a past expiry is immediately retryable: the first
  // isPlaylistBlocked call evicts it.
  // -------------------------------------------------------------------------
  it('an already-expired entry is evicted on the next check and becomes retryable', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }), // strictly-positive age past expiry
        (baseTime, agePastExpiry) => {
          forbiddenPlaylists.clear()
          vi.setSystemTime(baseTime)

          const playlistId = 'pl-expired'
          // expiresAt is in the past relative to `now`.
          forbiddenPlaylists.set(playlistId, baseTime - agePastExpiry)

          expect(isPlaylistBlocked(playlistId)).toBe(false)
          expect(forbiddenPlaylists.has(playlistId)).toBe(false)
        }
      ),
      { numRuns: 200 }
    )
  })

  // -------------------------------------------------------------------------
  // blockPlaylist sets expiresAt = now + BLOCKLIST_TTL_MS.
  // -------------------------------------------------------------------------
  it('blockPlaylist sets expiresAt = now + BLOCKLIST_TTL_MS', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (baseTime, playlistId) => {
          forbiddenPlaylists.clear()
          vi.setSystemTime(baseTime)

          blockPlaylist(playlistId)

          expect(forbiddenPlaylists.get(playlistId)).toBe(baseTime + BLOCKLIST_TTL_MS)
          // And the freshly-blocked entry is reported as active.
          expect(isPlaylistBlocked(playlistId)).toBe(true)
        }
      ),
      { numRuns: 200 }
    )
  })

  // -------------------------------------------------------------------------
  // A successful re-auth via registerUser clears the user from
  // usersNeedingReauth and drops blocklist entries.
  // -------------------------------------------------------------------------
  it('registerUser (successful re-auth) clears usersNeedingReauth and drops blocklist entries', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
        fc.uuid(),
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 0, maxLength: 5 }),
        (baseTime, userId, playlistIds) => {
          // Reset state for this run (registerUser starts fake timers, so clean up).
          userState.forEach((_, id) => deregisterUser(id))
          userState.clear()
          forbiddenPlaylists.clear()
          usersNeedingReauth.clear()
          vi.setSystemTime(baseTime)

          // Simulate the pre-re-auth state: the user is flagged for re-auth and
          // has active blocklist entries.
          usersNeedingReauth.add(userId)
          for (const pid of playlistIds) {
            blockPlaylist(pid)
          }

          // Successful re-authentication.
          registerUser(userId)

          // Re-auth signal cleared for the user …
          expect(usersNeedingReauth.has(userId)).toBe(false)
          // … and the blocklist is dropped so previously-blocked playlists retry.
          expect(forbiddenPlaylists.size).toBe(0)

          // Clean up the polling interval/state created by registerUser.
          deregisterUser(userId)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ---------------------------------------------------------------------------
// Feature: playlist-403-blocklist-fix
// Task 5 — Unit tests for the fix (poller layer)
//
// Concrete, deterministic example-based tests (distinct from the recovery
// property tests above):
//   - removeTrack via detectSkip:
//       MISSING_SCOPE     → no blocklist, user added to usersNeedingReauth,
//                           no removal_log insert
//       FORBIDDEN_PLAYLIST→ blocklisted with a future expiresAt,
//                           no removal_log insert
//   - Blocklist helpers:
//       isPlaylistBlocked → false for an expired entry, which it evicts
//       blockPlaylist     → expiresAt = now + BLOCKLIST_TTL_MS
//
// Validates: Requirements 2.2, 2.3, 2.4, 3.2, 3.3, 3.4, 3.5
// ---------------------------------------------------------------------------

describe('Unit tests (Task 5): removeTrack 403 handling via detectSkip', () => {
  // Feature: playlist-403-blocklist-fix

  const userId = 'user-task5'
  const trackId = 'track-task5'
  const playlistId = 'playlist-task5'
  const accessToken = 'access-token-task5'

  beforeEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.delete(playlistId)
    usersNeedingReauth.delete(userId)
  })

  afterEach(() => {
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.delete(playlistId)
    usersNeedingReauth.delete(userId)
  })

  /**
   * Supabase mock: 2 skipped listen_events rows (no removal_log cutoff) so
   * detectSkip proceeds to call removeTrack. Returns the removal_log insert mock.
   */
  function buildSkipTriggerSupabaseMock() {
    const skippedRows = [{ was_skipped: true }, { was_skipped: true }]

    const removalLogInsertMock = vi.fn().mockResolvedValue({ error: null })
    const removalLogLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
    const removalLogOrderMock = vi.fn(() => ({ limit: removalLogLimitMock }))
    const removalLogEq3 = vi.fn(() => ({ order: removalLogOrderMock }))
    const removalLogEq2 = vi.fn(() => ({ eq: removalLogEq3 }))
    const removalLogEq1 = vi.fn(() => ({ eq: removalLogEq2 }))
    const removalLogSelectMock = vi.fn(() => ({ eq: removalLogEq1 }))

    const listenEventsLimitMock = vi.fn().mockResolvedValue({ data: skippedRows, error: null })
    const listenEventsOrderMock = vi.fn(() => ({ limit: listenEventsLimitMock }))
    const listenEventsEq3 = vi.fn(() => ({ order: listenEventsOrderMock }))
    const listenEventsEq2 = vi.fn(() => ({ eq: listenEventsEq3 }))
    const listenEventsEq1 = vi.fn(() => ({ eq: listenEventsEq2 }))
    const listenEventsSelectMock = vi.fn(() => ({ eq: listenEventsEq1 }))

    const fromMock = vi.fn((table) => {
      if (table === 'removal_log') {
        return { select: removalLogSelectMock, insert: removalLogInsertMock }
      }
      return { select: listenEventsSelectMock }
    })

    getSupabase.mockReturnValue({ from: fromMock })
    return { removalLogInsertMock }
  }

  it('MISSING_SCOPE → no blocklist, user added to usersNeedingReauth, no removal_log insert', async () => {
    // Feature: playlist-403-blocklist-fix (Req 2.2, 2.3, 3.2)
    const { removalLogInsertMock } = buildSkipTriggerSupabaseMock()

    const scopeErr = Object.assign(new Error('403'), { code: 'MISSING_SCOPE' })
    removeTrackFromPlaylist.mockRejectedValue(scopeErr)

    await detectSkip(userId, trackId, playlistId, accessToken)

    // Req 2.2 — editable playlist is NOT blocklisted.
    expect(forbiddenPlaylists.has(playlistId)).toBe(false)
    // Req 2.3 — durable re-auth signal recorded for the user.
    expect(usersNeedingReauth.has(userId)).toBe(true)
    // Req 3.2 — no removal_log row written (the removal did not succeed).
    expect(removalLogInsertMock).not.toHaveBeenCalled()
  })

  it('FORBIDDEN_PLAYLIST → blocklisted with a future expiresAt, no removal_log insert', async () => {
    // Feature: playlist-403-blocklist-fix (Req 2.4, 3.4)
    const { removalLogInsertMock } = buildSkipTriggerSupabaseMock()

    const forbiddenErr = Object.assign(new Error('403'), { code: 'FORBIDDEN_PLAYLIST' })
    removeTrackFromPlaylist.mockRejectedValue(forbiddenErr)

    const before = Date.now()
    await detectSkip(userId, trackId, playlistId, accessToken)

    // Req 3.4 — genuine forbidden playlist is blocklisted …
    expect(forbiddenPlaylists.has(playlistId)).toBe(true)
    // … Req 2.4 — with a future expiry (recoverable, not permanent).
    const expiresAt = forbiddenPlaylists.get(playlistId)
    expect(typeof expiresAt).toBe('number')
    expect(expiresAt).toBeGreaterThan(before)
    expect(expiresAt).toBeGreaterThan(Date.now())

    // The user is not flagged for re-auth on a genuine forbidden playlist.
    expect(usersNeedingReauth.has(userId)).toBe(false)
    // No removal_log row written.
    expect(removalLogInsertMock).not.toHaveBeenCalled()

    forbiddenPlaylists.delete(playlistId)
  })
})

describe('Unit tests (Task 5): blocklist helpers', () => {
  // Feature: playlist-403-blocklist-fix (Req 2.4)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    forbiddenPlaylists.clear()
  })

  afterEach(() => {
    forbiddenPlaylists.clear()
    vi.useRealTimers()
  })

  it('isPlaylistBlocked returns false for an expired entry and evicts it', () => {
    // Feature: playlist-403-blocklist-fix
    const base = 1_700_000_000_000
    vi.setSystemTime(base)

    const playlistId = 'pl-expired-unit'
    // Insert an entry that expired 1 ms ago.
    forbiddenPlaylists.set(playlistId, base - 1)

    expect(isPlaylistBlocked(playlistId)).toBe(false)
    // Lazily evicted.
    expect(forbiddenPlaylists.has(playlistId)).toBe(false)
  })

  it('isPlaylistBlocked returns true for an active (non-expired) entry', () => {
    // Feature: playlist-403-blocklist-fix
    const base = 1_700_000_000_000
    vi.setSystemTime(base)

    const playlistId = 'pl-active-unit'
    forbiddenPlaylists.set(playlistId, base + 60_000) // expires in 1 minute

    expect(isPlaylistBlocked(playlistId)).toBe(true)
    expect(forbiddenPlaylists.has(playlistId)).toBe(true)
  })

  it('blockPlaylist sets expiresAt = now + BLOCKLIST_TTL_MS', () => {
    // Feature: playlist-403-blocklist-fix
    const base = 1_700_000_000_000
    vi.setSystemTime(base)

    const playlistId = 'pl-block-unit'
    blockPlaylist(playlistId)

    expect(forbiddenPlaylists.get(playlistId)).toBe(base + BLOCKLIST_TTL_MS)
  })
})

// ---------------------------------------------------------------------------
// Feature: playlist-403-blocklist-fix
// Task 6 — Integration tests for the full poll cycle
//
// These exercise the wired-together flow detectSkip → removeTrack →
// removeTrackFromPlaylist (mocked at the ../lib/spotify.js module boundary,
// consistent with the rest of poller.test.js) plus the recovery path via
// registerUser. They must all PASS on the fixed code.
//
// Scenarios:
//   1. Stale-token user whose OWNED playlist returns a generic 403 "Forbidden"
//      (classified MISSING_SCOPE by the fixed spotify layer): the playlist is
//      NOT blocklisted, the user is flagged in usersNeedingReauth, and cleaning
//      resumes after a simulated re-auth (registerUser) clears the signal.
//   2. Genuine Spotify-owned (non-editable) playlist (classified
//      FORBIDDEN_PLAYLIST): it is blocklisted, skipped while the entry is
//      active, and retried after the TTL elapses (fake timers advanced past
//      BLOCKLIST_TTL_MS).
//   3. Re-auth flow via the auth.js callback → registerUser clears
//      usersNeedingReauth and the user's blocklist entries.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.4, 3.4, 3.5
// ---------------------------------------------------------------------------

describe('Integration (Task 6): full poll cycle 403 handling + recovery', () => {
  // Feature: playlist-403-blocklist-fix

  const userId = 'user-int-task6'
  const trackId = 'track-int-task6'
  const playlistId = 'playlist-int-task6'
  const accessToken = 'access-token-int-task6'
  const authUserId = 'spotify-int-task6'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    userState.clear()
    forbiddenPlaylists.clear()
    usersNeedingReauth.clear()
  })

  afterEach(() => {
    // registerUser starts a stagger setTimeout / polling setInterval — drop any
    // intervals so fake timers don't leak into other tests.
    userState.forEach((_, id) => deregisterUser(id))
    userState.clear()
    forbiddenPlaylists.clear()
    usersNeedingReauth.clear()
    vi.useRealTimers()
  })

  /**
   * Supabase mock that returns 2 skipped listen_events rows (no removal_log
   * cutoff) so detectSkip proceeds to call removeTrack. Returns the removal_log
   * insert mock so a test can assert whether a removal was logged.
   */
  function buildSkipTriggerSupabaseMock() {
    const skippedRows = [{ was_skipped: true }, { was_skipped: true }]

    const removalLogInsertMock = vi.fn().mockResolvedValue({ error: null })
    const removalLogLimitMock = vi.fn().mockResolvedValue({ data: [], error: null })
    const removalLogOrderMock = vi.fn(() => ({ limit: removalLogLimitMock }))
    const removalLogEq3 = vi.fn(() => ({ order: removalLogOrderMock }))
    const removalLogEq2 = vi.fn(() => ({ eq: removalLogEq3 }))
    const removalLogEq1 = vi.fn(() => ({ eq: removalLogEq2 }))
    const removalLogSelectMock = vi.fn(() => ({ eq: removalLogEq1 }))

    const listenEventsLimitMock = vi.fn().mockResolvedValue({ data: skippedRows, error: null })
    const listenEventsOrderMock = vi.fn(() => ({ limit: listenEventsLimitMock }))
    const listenEventsEq3 = vi.fn(() => ({ order: listenEventsOrderMock }))
    const listenEventsEq2 = vi.fn(() => ({ eq: listenEventsEq3 }))
    const listenEventsEq1 = vi.fn(() => ({ eq: listenEventsEq2 }))
    const listenEventsSelectMock = vi.fn(() => ({ eq: listenEventsEq1 }))

    const fromMock = vi.fn((table) => {
      if (table === 'removal_log') {
        return { select: removalLogSelectMock, insert: removalLogInsertMock }
      }
      return { select: listenEventsSelectMock }
    })

    getSupabase.mockReturnValue({ from: fromMock })
    return { removalLogInsertMock }
  }

  // -------------------------------------------------------------------------
  // Scenario 1 — stale-token user, owned playlist, generic 403 → MISSING_SCOPE.
  // Req 2.1, 2.2, 2.3 + recovery 2.4.
  // -------------------------------------------------------------------------
  it('stale-token owned playlist (MISSING_SCOPE): not blocklisted, user flagged, cleaning resumes after re-auth', async () => {
    // Feature: playlist-403-blocklist-fix (Req 2.1, 2.2, 2.3, 2.4)
    const { removalLogInsertMock } = buildSkipTriggerSupabaseMock()

    // The fixed spotify layer probes editability on a generic 403 and, because
    // the playlist is owned by the user, classifies it as MISSING_SCOPE.
    const scopeErr = Object.assign(new Error('403'), { code: 'MISSING_SCOPE' })
    removeTrackFromPlaylist.mockRejectedValue(scopeErr)

    // Full skip-detection → removal path through the poll cycle.
    await detectSkip(userId, trackId, playlistId, accessToken, authUserId)

    // Req 2.1 — removeTrackFromPlaylist was actually invoked (the cycle ran).
    expect(removeTrackFromPlaylist).toHaveBeenCalledOnce()
    // Req 2.2 — the editable playlist must NOT be blocklisted.
    expect(forbiddenPlaylists.has(playlistId)).toBe(false)
    expect(isPlaylistBlocked(playlistId)).toBe(false)
    // Req 2.3 — the user is flagged for re-authentication.
    expect(usersNeedingReauth.has(userId)).toBe(true)
    // No removal was logged (the removal did not succeed).
    expect(removalLogInsertMock).not.toHaveBeenCalled()

    // ── Simulated re-auth (Req 2.4): registerUser clears the re-auth signal ──
    registerUser(userId)
    expect(usersNeedingReauth.has(userId)).toBe(false)

    // Cleaning resumes: with a freshly-scoped token the removal now succeeds and
    // a removal_log row is written.
    removeTrackFromPlaylist.mockReset()
    removeTrackFromPlaylist.mockResolvedValue(true)
    const { removalLogInsertMock: resumedInsertMock } = buildSkipTriggerSupabaseMock()

    await detectSkip(userId, trackId, playlistId, accessToken, authUserId)

    expect(removeTrackFromPlaylist).toHaveBeenCalledOnce()
    expect(resumedInsertMock).toHaveBeenCalledOnce()

    deregisterUser(userId)
  })

  // -------------------------------------------------------------------------
  // Scenario 2 — genuine non-editable playlist → FORBIDDEN_PLAYLIST.
  // Req 3.4 (blocklisted, skipped while active) + 2.4 (retried after TTL).
  // -------------------------------------------------------------------------
  it('genuine forbidden playlist: blocklisted, skipped while active, retried after TTL elapses', async () => {
    // Feature: playlist-403-blocklist-fix (Req 3.4, 3.5, 2.4)
    const base = 1_700_000_000_000
    vi.setSystemTime(base)

    buildSkipTriggerSupabaseMock()

    // A genuine read-only / Spotify-owned playlist → FORBIDDEN_PLAYLIST.
    const forbiddenErr = Object.assign(new Error('403'), { code: 'FORBIDDEN_PLAYLIST' })
    removeTrackFromPlaylist.mockRejectedValue(forbiddenErr)

    // First attempt: removal is tried and the playlist becomes blocklisted.
    await detectSkip(userId, trackId, playlistId, accessToken, authUserId)
    expect(removeTrackFromPlaylist).toHaveBeenCalledOnce()
    // Req 3.4 — blocklisted with a future expiry (recoverable, not permanent).
    expect(isPlaylistBlocked(playlistId)).toBe(true)
    expect(forbiddenPlaylists.get(playlistId)).toBe(base + BLOCKLIST_TTL_MS)

    // ── Req 3.5 — a second attempt while the entry is active skips Spotify ──
    removeTrackFromPlaylist.mockClear()
    buildSkipTriggerSupabaseMock()
    await detectSkip(userId, trackId, playlistId, accessToken, authUserId)
    expect(removeTrackFromPlaylist).not.toHaveBeenCalled()

    // ── Req 2.4 — advance fake timers past the TTL → entry expires & retries ──
    vi.setSystemTime(base + BLOCKLIST_TTL_MS + 1)
    expect(isPlaylistBlocked(playlistId)).toBe(false)

    // After the TTL elapses a subsequent cycle calls Spotify again (retry).
    removeTrackFromPlaylist.mockClear()
    removeTrackFromPlaylist.mockResolvedValue(true)
    const { removalLogInsertMock } = buildSkipTriggerSupabaseMock()
    await detectSkip(userId, trackId, playlistId, accessToken, authUserId)
    expect(removeTrackFromPlaylist).toHaveBeenCalledOnce()
    // The retry succeeded → a removal_log row is written.
    expect(removalLogInsertMock).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // Scenario 3 — re-auth flow via auth.js callback → registerUser clears state.
  // Req 2.4.
  // -------------------------------------------------------------------------
  it('re-auth via registerUser clears usersNeedingReauth and drops the user blocklist entries', () => {
    // Feature: playlist-403-blocklist-fix (Req 2.4)
    const base = 1_700_000_000_000
    vi.setSystemTime(base)

    // Pre-re-auth state: the user is flagged and several playlists are blocked
    // (this is the state the auth.js callback observes before re-consent).
    usersNeedingReauth.add(userId)
    blockPlaylist(playlistId)
    blockPlaylist('another-blocked-playlist')
    expect(usersNeedingReauth.has(userId)).toBe(true)
    expect(forbiddenPlaylists.size).toBe(2)

    // The auth.js OAuth callback calls registerUser on a successful re-auth.
    registerUser(userId)

    // Re-auth signal cleared for the user …
    expect(usersNeedingReauth.has(userId)).toBe(false)
    // … and the blocklist is dropped so previously-blocked playlists can retry.
    expect(forbiddenPlaylists.size).toBe(0)
    expect(isPlaylistBlocked(playlistId)).toBe(false)

    deregisterUser(userId)
  })
})
