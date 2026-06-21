/**
 * Unit tests for the equalizer-style Waveform component.
 *
 * Validates: Requirements 8.5, 8.6, 8.7, 10.4
 *
 * The Waveform renders a row of animated bars (an audio-equalizer look) plus an
 * accessible status label. Bars are decorative (aria-hidden); the status label
 * carries role="status" and aria-live="polite" so screen readers announce
 * cleaning state changes. These tests exercise the bar rendering, the status
 * label, and the reduced-motion / stopped resting states.
 */

import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// ── Framer Motion mock ────────────────────────────────────────────────────────
// Render motion.span as a plain <span> so JSDOM doesn't choke on the animation
// APIs, while still exposing the animate/transition props for inspection.

vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return {
    ...actual,
    motion: {
      ...actual.motion,
      span: vi.fn(
        (
          props: React.HTMLAttributes<HTMLSpanElement> & {
            animate?: unknown;
            transition?: unknown;
            initial?: unknown;
          }
        ) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { animate, transition, initial, ...rest } = props;
          return <span data-testid="waveform-bar" {...rest} />;
        }
      ),
    },
  };
});

// Import AFTER the mock so the component picks up the mocked module
import { Waveform } from '../components/dashboard/Waveform';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Waveform – bar rendering', () => {
  test('renders the decorative bar container hidden from the a11y tree', () => {
    const { getByTestId } = render(
      <Waveform isActive={true} reducedMotion={false} />
    );

    const barContainer = getByTestId('waveform-bars');
    expect(barContainer).toBeInTheDocument();
    expect(barContainer).toHaveAttribute('aria-hidden', 'true');
  });

  test('renders a non-trivial number of bars', () => {
    const { getAllByTestId } = render(
      <Waveform isActive={true} reducedMotion={false} />
    );

    const bars = getAllByTestId('waveform-bar');
    expect(bars.length).toBeGreaterThan(10);
  });

  test('bars use the brand color when active', () => {
    const { getAllByTestId } = render(
      <Waveform isActive={true} reducedMotion={false} />
    );

    const bars = getAllByTestId('waveform-bar');
    for (const bar of bars) {
      expect(bar.style.backgroundColor).toBe('var(--color-brand)');
    }
  });

  test('bars use a muted (surface-hover) color when stopped', () => {
    const { getAllByTestId } = render(
      <Waveform isActive={false} reducedMotion={false} />
    );

    const bars = getAllByTestId('waveform-bar');
    for (const bar of bars) {
      expect(bar.style.backgroundColor).toBe('var(--color-bg-surface-hover)');
    }
  });
});

describe('Waveform – status label accessibility', () => {
  test('status element has role="status" and aria-live="polite" when active', () => {
    render(<Waveform isActive={true} reducedMotion={false} />);

    const statusEl = screen.getByRole('status');
    expect(statusEl).toBeInTheDocument();
    expect(statusEl).toHaveAttribute('aria-live', 'polite');
  });

  test('status element has role="status" and aria-live="polite" when stopped', () => {
    render(<Waveform isActive={false} reducedMotion={false} />);

    const statusEl = screen.getByRole('status');
    expect(statusEl).toBeInTheDocument();
    expect(statusEl).toHaveAttribute('aria-live', 'polite');
  });

  test('status element keeps its a11y attributes in reduced-motion mode', () => {
    render(<Waveform isActive={true} reducedMotion={true} />);

    const statusEl = screen.getByRole('status');
    expect(statusEl).toBeInTheDocument();
    expect(statusEl).toHaveAttribute('aria-live', 'polite');
  });

  test('status text reads "Cleaning in progress" when active', () => {
    render(<Waveform isActive={true} reducedMotion={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Cleaning in progress');
  });

  test('status text reads "Stopped" when inactive', () => {
    render(<Waveform isActive={false} reducedMotion={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Stopped');
  });

  test('status label updates immediately when isActive toggles', () => {
    const { rerender } = render(
      <Waveform isActive={true} reducedMotion={false} />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Cleaning in progress');

    rerender(<Waveform isActive={false} reducedMotion={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Stopped');
  });
});
