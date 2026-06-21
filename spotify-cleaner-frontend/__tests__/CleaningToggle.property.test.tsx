/**
 * Property-based tests for `CleaningToggle`.
 *
 * **Validates: Requirements 7.8**
 *
 * Property 9: CleaningToggle is disabled for the entire duration of any
 * in-flight API call.
 *
 * For any start or stop action triggered by the user, the CleaningToggle
 * button must remain in a disabled state from the moment the API call is
 * initiated until a response (success or error) is received. No intermediate
 * click events must be processed while disabled.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { render, screen, cleanup } from '@testing-library/react';
import { CleaningToggle } from '../components/dashboard/CleaningToggle';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Property 9a: button.disabled matches isLoading prop ───────────────────────

describe('Property 9: CleaningToggle is disabled for the entire duration of any in-flight API call', () => {
  /**
   * For any boolean value of `isLoading`, the button's `disabled` attribute
   * must exactly match that value.  This captures the core invariant: from the
   * moment the parent sets `isLoading=true` (API call initiated) to the moment
   * it sets `isLoading=false` (response received), the button is disabled.
   *
   * Runs 100 iterations, each with a randomly generated `isLoading` boolean.
   */
  test(
    'property: button disabled state always equals isLoading prop (isRunning=false)',
    () => {
      fc.assert(
        fc.property(
          fc.boolean(), // isLoading
          (isLoading) => {
            const onStart = vi.fn().mockResolvedValue(undefined);
            const onStop = vi.fn().mockResolvedValue(undefined);

            render(
              <CleaningToggle
                isRunning={false}
                isLoading={isLoading}
                onStart={onStart}
                onStop={onStop}
                error={null}
              />
            );

            const button = screen.getByRole('button', { name: 'Start Cleaning' }) as HTMLButtonElement;
            expect(button.disabled).toBe(isLoading);

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'property: button disabled state always equals isLoading prop (isRunning=true)',
    () => {
      fc.assert(
        fc.property(
          fc.boolean(), // isLoading
          (isLoading) => {
            const onStart = vi.fn().mockResolvedValue(undefined);
            const onStop = vi.fn().mockResolvedValue(undefined);

            render(
              <CleaningToggle
                isRunning={true}
                isLoading={isLoading}
                onStart={onStart}
                onStop={onStop}
                error={null}
              />
            );

            const button = screen.getByRole('button', { name: 'Stop Cleaning' }) as HTMLButtonElement;
            expect(button.disabled).toBe(isLoading);

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'property: button disabled state matches isLoading across all combinations of isRunning and isLoading',
    () => {
      fc.assert(
        fc.property(
          fc.boolean(), // isRunning
          fc.boolean(), // isLoading
          (isRunning, isLoading) => {
            const onStart = vi.fn().mockResolvedValue(undefined);
            const onStop = vi.fn().mockResolvedValue(undefined);
            const expectedLabel = isRunning ? 'Stop Cleaning' : 'Start Cleaning';

            render(
              <CleaningToggle
                isRunning={isRunning}
                isLoading={isLoading}
                onStart={onStart}
                onStop={onStop}
                error={null}
              />
            );

            const button = screen.getByRole('button', { name: expectedLabel }) as HTMLButtonElement;
            expect(button.disabled).toBe(isLoading);

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  // ── Property 9b: clicking a disabled button never fires onStart/onStop ──────

  /**
   * For any API response delay (10ms–5000ms), while `isLoading=true` the
   * button is disabled and clicking it must not invoke `onStart` or `onStop`.
   *
   * Since CleaningToggle receives `isLoading` as a prop (it does not manage
   * its own async state), we simulate the in-flight scenario by rendering with
   * `isLoading=true` and programmatically dispatching click events on the
   * disabled button, asserting that neither callback is invoked.
   *
   * The delay value represents how long a real API call would take, exercising
   * that the property holds regardless of latency.
   */
  test(
    'property: clicking the button while isLoading=true never invokes onStart or onStop',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 5000 }), // mock API response delay (ms)
          fc.boolean(),                        // isRunning
          (delay, isRunning) => {
            // Suppress unused-variable warning — delay documents the simulated
            // in-flight window even though jsdom timer advancement is not needed
            // for this synchronous assertion.
            void delay;

            const onStart = vi.fn().mockResolvedValue(undefined);
            const onStop = vi.fn().mockResolvedValue(undefined);
            const expectedLabel = isRunning ? 'Stop Cleaning' : 'Start Cleaning';

            render(
              <CleaningToggle
                isRunning={isRunning}
                isLoading={true} // API call is in-flight
                onStart={onStart}
                onStop={onStop}
                error={null}
              />
            );

            const button = screen.getByRole('button', { name: expectedLabel }) as HTMLButtonElement;

            // Confirm the button is actually disabled
            expect(button.disabled).toBe(true);

            // Attempt to click multiple times while in-flight
            button.click();
            button.click();
            button.click();

            // Neither callback should have been invoked — the disabled attribute
            // prevents click events from being processed
            expect(onStart).not.toHaveBeenCalled();
            expect(onStop).not.toHaveBeenCalled();

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * Cross-check: when isLoading transitions from true → false, the button
   * becomes enabled and clicks reach the correct handler.
   * This verifies the bookend: once the API call resolves, the toggle is
   * re-enabled and interactive again.
   */
  test(
    'property: after isLoading transitions to false, clicking the button invokes the correct handler',
    () => {
      fc.assert(
        fc.property(
          fc.boolean(), // isRunning
          (isRunning) => {
            const onStart = vi.fn().mockResolvedValue(undefined);
            const onStop = vi.fn().mockResolvedValue(undefined);
            const expectedLabel = isRunning ? 'Stop Cleaning' : 'Start Cleaning';

            // Phase 1 — in-flight (loading)
            const { rerender } = render(
              <CleaningToggle
                isRunning={isRunning}
                isLoading={true}
                onStart={onStart}
                onStop={onStop}
                error={null}
              />
            );

            const button = screen.getByRole('button', { name: expectedLabel }) as HTMLButtonElement;
            expect(button.disabled).toBe(true);

            // Phase 2 — API response received (no longer loading)
            rerender(
              <CleaningToggle
                isRunning={isRunning}
                isLoading={false}
                onStart={onStart}
                onStop={onStop}
                error={null}
              />
            );

            expect(button.disabled).toBe(false);

            button.click();

            if (isRunning) {
              expect(onStop).toHaveBeenCalledTimes(1);
              expect(onStart).not.toHaveBeenCalled();
            } else {
              expect(onStart).toHaveBeenCalledTimes(1);
              expect(onStop).not.toHaveBeenCalled();
            }

            cleanup();
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
