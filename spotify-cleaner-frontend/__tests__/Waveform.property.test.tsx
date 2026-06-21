/**
 * Property-based tests for the equalizer-style `Waveform` component.
 *
 * **Validates: Requirements 8.3, 8.4, 8.5**
 *
 * The redesigned Waveform renders a row of animated bars. The invariants we
 * assert across arbitrary state sequences:
 *
 *   - When active (and not reduced-motion), every bar loops forever
 *     (transition.repeat === Infinity) with a sane per-bar duration.
 *   - When stopped or reduced-motion, bars settle to a static height with a
 *     short, non-looping transition (no repeat).
 *   - The accessible status label always reflects the current isActive value
 *     within the same render cycle.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

// ── Framer Motion mock ────────────────────────────────────────────────────────
// Capture every `transition` prop passed to motion.span across all renders.

const capturedTransitions: Array<Record<string, unknown>> = [];

vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return {
    ...actual,
    motion: {
      ...actual.motion,
      span: vi.fn(
        (
          props: React.HTMLAttributes<HTMLSpanElement> & {
            transition?: Record<string, unknown>;
            animate?: unknown;
            initial?: unknown;
          }
        ) => {
          if (props.transition) {
            capturedTransitions.push(props.transition);
          }
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { transition, animate, initial, ...rest } = props;
          return <span {...rest} />;
        }
      ),
    },
  };
});

// Import AFTER the mock is set up
import { Waveform } from '../components/dashboard/Waveform';

beforeEach(() => {
  capturedTransitions.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  capturedTransitions.length = 0;
  cleanup();
});

// ── Properties ────────────────────────────────────────────────────────────────

describe('Waveform animation invariants', () => {
  test('property: active bars loop forever with a per-bar duration in [0.7, 1.3]s', () => {
    fc.assert(
      fc.property(fc.constant(true), () => {
        capturedTransitions.length = 0;
        cleanup();

        render(<Waveform isActive={true} reducedMotion={false} />);

        // Every captured transition is a looping bar transition.
        expect(capturedTransitions.length).toBeGreaterThan(0);
        return capturedTransitions.every((t) => {
          const duration = t.duration as number;
          return (
            t.repeat === Infinity &&
            typeof duration === 'number' &&
            duration >= 0.7 &&
            duration <= 1.3
          );
        });
      }),
      { numRuns: 20 }
    );
  });

  test('property: stopped bars use a short, non-looping settle transition', () => {
    capturedTransitions.length = 0;
    render(<Waveform isActive={false} reducedMotion={false} />);

    expect(capturedTransitions.length).toBeGreaterThan(0);
    for (const t of capturedTransitions) {
      expect(t.repeat).toBeUndefined();
      expect(t.duration).toBe(0.5);
    }
  });

  test('property: reduced-motion bars never loop, regardless of active state', () => {
    fc.assert(
      fc.property(fc.boolean(), (isActive) => {
        capturedTransitions.length = 0;
        cleanup();

        render(<Waveform isActive={isActive} reducedMotion={true} />);

        return capturedTransitions.every((t) => t.repeat === undefined);
      }),
      { numRuns: 50 }
    );
  });

  test('property: status label always matches the current isActive value', () => {
    fc.assert(
      fc.property(fc.boolean(), (isActive) => {
        cleanup();

        const { rerender } = render(
          <Waveform isActive={isActive} reducedMotion={false} />
        );

        const initialLabel = isActive ? 'Cleaning in progress' : 'Stopped';
        expect(screen.getByRole('status').textContent).toBe(initialLabel);

        rerender(<Waveform isActive={!isActive} reducedMotion={false} />);

        const toggledLabel = !isActive ? 'Cleaning in progress' : 'Stopped';
        expect(screen.getByRole('status').textContent).toBe(toggledLabel);

        cleanup();
      }),
      { numRuns: 100 }
    );
  });
});
