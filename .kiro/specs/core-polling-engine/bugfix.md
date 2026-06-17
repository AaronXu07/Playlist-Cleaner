# Bugfix Requirements Document

## Introduction

The polling engine has a blind spot for ultra-fast skips: tracks played for fewer than ~30 seconds do not appear in Spotify's `recently-played` endpoint, and `currently-playing` only provides a snapshot in time. As a result, the most obvious form of user skipping — tapping "next" within a few seconds — is completely invisible to the current skip-detection pipeline.

The fix infers skips from **playback position discontinuities** observed across consecutive polls. When the Live_Track_Tracker sees a track disappear or change and the accumulated `max_progress_ms` is very small, it records a listen event anyway — even if Spotify never logs the play. These inferred events are tagged with `source = "delta"` to distinguish them from live-tracked and recently-played-derived events, and the deduplication layer is extended to prevent double-counting on the rare occasion a short play does surface in `recently-played`.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user skips a track after fewer than ~30 seconds of playback and the track therefore does not appear in `recently-played`, THEN the system records no listen event for that track, making the skip invisible to skip detection.

1.2 WHEN `currently-playing` transitions from Track A to Track B and Track A's `max_progress_ms` is very small (e.g., 0 ms to several thousand ms), THEN the system still emits a live listen event only if `max_progress_ms > 0` (per Req 4.4), silently dropping zero-progress track changes.

1.3 WHEN `currently-playing` returns a completely different track than the previous poll and the previous track was skipped in under ~30 seconds, THEN the system has no record of the previous track's playback and cannot count it toward the 3-skip removal threshold.

### Expected Behavior (Correct)

2.1 WHEN a track change is detected (previous `track_id` differs from current `track_id`) and the previous track's `max_progress_ms` is greater than 0 ms, THEN the system SHALL emit a listen event for the previous track using `listened_pct = min(max_progress_ms / duration_ms, 1.0)` and tag it with `source = "delta"`.

2.2 WHEN a track change is detected and the previous track's `max_progress_ms` is exactly 0 ms (track was registered but no progress was ever observed), THEN the system SHALL emit a listen event for the previous track with `listened_pct = 0.0` and `was_skipped = true`, tagged `source = "delta"`, so that zero-second skips are captured.

2.3 WHEN `currently-playing` returns a 204 No Content or transitions to a non-playlist context and the previously tracked track's `max_progress_ms` is 0 ms, THEN the system SHALL emit a listen event with `listened_pct = 0.0` and `source = "delta"` rather than silently discarding the event.

2.4 WHEN a `source = "delta"` listen event would be inserted and a `source = "live"` or `source = "recent"` event already exists for the same `(user_id, track_id, listened_at)`, THEN the system SHALL treat the existing event as authoritative and skip the delta insert without raising an error.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a track is played to completion or near-completion (high `max_progress_ms`), THEN the system SHALL CONTINUE TO emit a `source = "live"` listen event with the correctly computed `listened_pct`, unaffected by the delta-tracking path.

3.2 WHEN a recently-played reconciliation run finds tracks that the live tracker already recorded, THEN the system SHALL CONTINUE TO deduplicate by `(user_id, track_id, listened_at)` and skip the insert, preventing double-counting.

3.3 WHEN a track's `duration_ms` is 0 or negative, THEN the system SHALL CONTINUE TO discard the event and take no action, whether the event originates from the live, recent, or delta path.

3.4 WHEN a track is played within a playlist context for longer than 30 seconds and appears in both `currently-playing` (as a live event) and later in `recently-played`, THEN the system SHALL CONTINUE TO record only one listen event for that track via the existing deduplication logic.

3.5 WHEN skip detection evaluates the last 3 listen events for a `(user_id, track_id, playlist_id)` triple, THEN the system SHALL CONTINUE TO apply the same `was_skipped` threshold (`listened_pct < 0.10`) regardless of whether the events are sourced from `"live"`, `"recent"`, or `"delta"`.

---

## Bug Condition

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type TrackChangeEvent
    // X.prev_track_id     — the track_id seen in the previous poll
    // X.curr_track_id     — the track_id seen in the current poll (may be null/different)
    // X.max_progress_ms   — highest progress_ms ever observed for prev_track_id this session
    // X.prev_duration_ms  — duration_ms of the previous track

  OUTPUT: boolean

  // Bug fires when a track change occurs and the previous track had too
  // little progress to ever appear in recently-played
  RETURN (X.prev_track_id ≠ X.curr_track_id OR X.curr_track_id = null)
     AND (X.max_progress_ms / X.prev_duration_ms) < 0.50
     AND X.max_progress_ms < 30_000
END FUNCTION
```

> Note: the 30 000 ms / 50% thresholds are conservative approximations of Spotify's ~30-second recently-played registration floor. The fix must record the event regardless; this function describes which events are at risk of being lost without the fix.

### Property: Fix Checking

```pascal
// Property: Fast-Skip events are always recorded
FOR ALL X WHERE isBugCondition(X) DO
  result ← processTrackChange'(X)   // F' = fixed engine
  ASSERT listen_event_exists(X.user_id, X.prev_track_id, source IN {"delta", "live"})
  ASSERT listen_event.was_skipped = (listen_event.listened_pct < 0.10)
END FOR
```

### Property: Preservation Checking

```pascal
// Property: Non-fast-skip events are unaffected
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT processTrackChange'(X) = processTrackChange(X)  // F' = F for non-buggy inputs
END FOR
```
