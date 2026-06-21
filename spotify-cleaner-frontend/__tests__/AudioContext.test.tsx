/**
 * Property-based tests for `AudioContext` / `AudioProvider`.
 *
 * **Validates: Requirements 5.3, 5.6**
 *
 * Property 7: At most one preview audio track plays at any time
 *
 * For any sequence of `play(url)` calls issued to the AudioContext, the number
 * of HTMLAudioElement instances that are simultaneously in a non-paused state
 * must never exceed 1. Each new `play()` call must stop the currently playing
 * track before starting the new one.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { render, act } from '@testing-library/react';
import React, { useRef } from 'react';
import { AudioProvider, useAudio } from '../context/AudioContext';

// ── HTMLAudioElement mock ─────────────────────────────────────────────────────

/**
 * Tracks all Audio instances created during a test run so we can assert
 * across all of them simultaneously (no more than 1 can be "playing" at once).
 */
let audioInstances: MockAudioInstance[] = [];

interface MockAudioInstance {
  src: string;
  paused: boolean;
  pauseCallCount: number;
  playCallCount: number;
  eventListeners: Record<string, Array<() => void>>;
  pause(): void;
  play(): Promise<void>;
  addEventListener(event: string, handler: () => void): void;
  removeEventListener(event: string, handler: () => void): void;
}

/**
 * Build one mock Audio instance and register it in the global list.
 * All methods are arrow functions so `this` always refers to `instance`.
 */
function createMockAudio(): MockAudioInstance {
  const instance: MockAudioInstance = {
    src: '',
    paused: true,
    pauseCallCount: 0,
    playCallCount: 0,
    eventListeners: {},

    pause() {
      instance.paused = true;
      instance.pauseCallCount++;
    },

    play() {
      instance.paused = false;
      instance.playCallCount++;
      return Promise.resolve();
    },

    addEventListener(event: string, handler: () => void) {
      if (!instance.eventListeners[event]) {
        instance.eventListeners[event] = [];
      }
      instance.eventListeners[event].push(handler);
    },

    removeEventListener(event: string, handler: () => void) {
      if (instance.eventListeners[event]) {
        instance.eventListeners[event] = instance.eventListeners[event].filter(
          (h) => h !== handler
        );
      }
    },
  };

  audioInstances.push(instance);
  return instance;
}

// ── Test consumer component ───────────────────────────────────────────────────

/**
 * A minimal React component that captures the `useAudio()` context into an
 * external object reference on every render, so tests can call `play()` and
 * read `playingUrl` after state updates.
 */
interface AudioController {
  play: (url: string) => Promise<void>;
  playingUrl: string | null;
}

function TestConsumer({ holder }: { holder: { current: AudioController } }) {
  const audio = useAudio();

  // Update the holder on every render so it's always fresh
  holder.current = {
    play: audio.play,
    playingUrl: audio.playingUrl,
  };

  return <div data-testid="playing-url">{audio.playingUrl ?? '__none__'}</div>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function renderAudioProvider(): Promise<{
  holder: { current: AudioController };
  unmount: () => void;
}> {
  // This object is mutated by TestConsumer on each render
  const holder: { current: AudioController } = {
    current: { play: async () => {}, playingUrl: null },
  };

  const { unmount } = render(
    <AudioProvider>
      <TestConsumer holder={holder} />
    </AudioProvider>
  );

  // Flush the useEffect that creates the Audio instance
  await act(async () => {});

  return { holder, unmount };
}

/** Count how many mock audio instances are currently in a non-paused state. */
function countPlayingInstances(): number {
  return audioInstances.filter((inst) => !inst.paused).length;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let originalAudio: typeof window.Audio;

beforeEach(() => {
  audioInstances = [];
  originalAudio = window.Audio;

  /**
   * When a constructor returns an object, `new Ctor()` yields that object
   * (not the implicit `this`). This makes `audioRef.current` in AudioContext
   * point directly to our `instance`, so `audioRef.current.pause()` and
   * `audioRef.current.paused` operate on the same object we track.
   */
  const MockAudioCtor = function () {
    return createMockAudio();
  } as unknown as typeof Audio;

  window.Audio = MockAudioCtor;
});

afterEach(() => {
  window.Audio = originalAudio;
  audioInstances = [];
  vi.restoreAllMocks();
});

// ── Property 7 ───────────────────────────────────────────────────────────────

describe('Property 7: At most one preview audio track plays at any time', () => {
  /**
   * For any sequence of play(url) calls:
   * 1. After each play(url_n), playingUrl === url_n
   * 2. At no point are more than 1 audio instances in a non-paused state
   * 3. Each new play() call invokes pause() on the previous source (via stop())
   *    — after n sequential play calls, pause() was called at least (n-1) times
   *
   * Validates: Requirements 5.3, 5.6
   */
  test(
    'property: sequential play() calls never leave more than one track active',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 20 }),
          async (urls) => {
            // Fresh render for each property run
            const { holder, unmount } = await renderAudioProvider();

            for (let i = 0; i < urls.length; i++) {
              const url = urls[i];

              await act(async () => {
                await holder.current.play(url);
              });

              // 1. playingUrl must reflect exactly the latest URL
              expect(holder.current.playingUrl).toBe(url);

              // 2. At most one audio source is in a non-paused state
              const playing = countPlayingInstances();
              expect(playing).toBeLessThanOrEqual(1);

              // 3. After the i-th play (0-indexed), stop() should have been
              //    called at least i times total (each play() after the first
              //    calls stop() which calls audio.pause()).
              const totalPauseCalls = audioInstances.reduce(
                (sum, inst) => sum + inst.pauseCallCount,
                0
              );
              expect(totalPauseCalls).toBeGreaterThanOrEqual(i);
            }

            unmount();
          }
        ),
        { numRuns: 100 }
      );
    },
    // Give the async PBT enough time — 100 runs × up to 20 URLs each
    { timeout: 60_000 }
  );

  test(
    'property: pause() is called on the previous source before a new URL begins playing',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 10 }),
          async (urls) => {
            const { holder, unmount } = await renderAudioProvider();

            for (let i = 1; i < urls.length; i++) {
              await act(async () => {
                await holder.current.play(urls[i - 1]);
              });

              // Snapshot pause count before the next play()
              const pauseBefore = audioInstances.reduce(
                (sum, inst) => sum + inst.pauseCallCount,
                0
              );

              await act(async () => {
                await holder.current.play(urls[i]);
              });

              // pause() must have been called at least once more (the stop()
              // inside play() pauses the previous source)
              const pauseAfter = audioInstances.reduce(
                (sum, inst) => sum + inst.pauseCallCount,
                0
              );

              expect(pauseAfter).toBeGreaterThan(pauseBefore);
            }

            unmount();
          }
        ),
        { numRuns: 100 }
      );
    },
    { timeout: 60_000 }
  );
});
