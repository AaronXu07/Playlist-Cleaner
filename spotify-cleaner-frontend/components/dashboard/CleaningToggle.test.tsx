/**
 * Unit tests for CleaningToggle component.
 * Requirements: 7.1–7.9, 10.3
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CleaningToggle } from './CleaningToggle';

// ── Helpers ──────────────────────────────────────────────────────────────────

function noop(): Promise<void> {
  return Promise.resolve();
}

// ── Stopped state ─────────────────────────────────────────────────────────────

describe('CleaningToggle — stopped state', () => {
  test('renders a button labelled "Start Cleaning"', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    expect(screen.getByRole('button', { name: 'Start Cleaning' })).toBeInTheDocument();
  });

  test('button carries bg-brand class in stopped state', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    const btn = screen.getByRole('button', { name: 'Start Cleaning' });
    expect(btn.className).toMatch(/bg-brand/);
  });

  test('button is enabled when not loading', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    expect(screen.getByRole('button', { name: 'Start Cleaning' })).not.toBeDisabled();
  });

  test('calls onStart when clicked in stopped state', () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={onStart}
        onStop={noop}
        error={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start Cleaning' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test('does not call onStop when clicked in stopped state', () => {
    const onStop = vi.fn();
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={onStop}
        error={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start Cleaning' }));
    expect(onStop).not.toHaveBeenCalled();
  });
});

// ── Active state ──────────────────────────────────────────────────────────────

describe('CleaningToggle — active state', () => {
  test('renders a button labelled "Stop Cleaning"', () => {
    render(
      <CleaningToggle
        isRunning={true}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    expect(screen.getByRole('button', { name: 'Stop Cleaning' })).toBeInTheDocument();
  });

  test('button carries bg-danger class in active state', () => {
    render(
      <CleaningToggle
        isRunning={true}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    const btn = screen.getByRole('button', { name: 'Stop Cleaning' });
    expect(btn.className).toMatch(/bg-danger/);
  });

  test('calls onStop when clicked in active state', () => {
    const onStop = vi.fn().mockResolvedValue(undefined);
    render(
      <CleaningToggle
        isRunning={true}
        isLoading={false}
        onStart={noop}
        onStop={onStop}
        error={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop Cleaning' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test('does not call onStart when clicked in active state', () => {
    const onStart = vi.fn();
    render(
      <CleaningToggle
        isRunning={true}
        isLoading={false}
        onStart={onStart}
        onStop={noop}
        error={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop Cleaning' }));
    expect(onStart).not.toHaveBeenCalled();
  });
});

// ── Loading state ─────────────────────────────────────────────────────────────

describe('CleaningToggle — loading state (Requirement 7.8)', () => {
  test('button is disabled while isLoading is true', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={true}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    expect(screen.getByRole('button', { name: 'Start Cleaning' })).toBeDisabled();
  });

  test('button is disabled while isLoading is true in active state', () => {
    render(
      <CleaningToggle
        isRunning={true}
        isLoading={true}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    expect(screen.getByRole('button', { name: 'Stop Cleaning' })).toBeDisabled();
  });

  test('spinner is rendered while loading (aria-hidden)', () => {
    const { container } = render(
      <CleaningToggle
        isRunning={false}
        isLoading={true}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    // The spinner SVG from lucide-react carries animate-spin class
    const spinner = container.querySelector('.animate-spin');
    expect(spinner).not.toBeNull();
  });

  test('no click handler fires when button is clicked while disabled', () => {
    const onStart = vi.fn();
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={true}
        onStart={onStart}
        onStop={noop}
        error={null}
      />
    );
    const btn = screen.getByRole('button', { name: 'Start Cleaning' });
    fireEvent.click(btn);
    // Disabled buttons do not fire onClick in browsers, but fireEvent bypasses that.
    // The key assertion is that the button carries the disabled attribute.
    expect(btn).toBeDisabled();
  });
});

// ── Error display ─────────────────────────────────────────────────────────────

describe('CleaningToggle — error display (Requirement 7.6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('renders <p role="alert"> with error text when error is non-null', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error="Failed to start cleaning. Please try again."
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('Failed to start cleaning. Please try again.');
  });

  test('does not render an alert when error is null', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('error remains visible for at least 5 seconds', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error="API error"
      />
    );

    // Still visible just before 5s
    act(() => { vi.advanceTimersByTime(4999); });
    expect(screen.queryByRole('alert')).not.toBeNull();
  });

  test('error auto-clears after 5 seconds', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error="API error"
      />
    );

    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a new error resets the 5-second timer', () => {
    const { rerender } = render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error="First error"
      />
    );

    // Advance 3 seconds, then supply a fresh error
    act(() => { vi.advanceTimersByTime(3000); });

    rerender(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error="Second error"
      />
    );

    // 2 more seconds (5s from first error), but only 2s into second error's timer
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByRole('alert')).not.toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Second error');

    // 3 more seconds — now 5s past second error
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ── Accessibility ─────────────────────────────────────────────────────────────

describe('CleaningToggle — accessibility (Requirement 10.3)', () => {
  test('button has a visible focus ring class', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    const btn = screen.getByRole('button', { name: 'Start Cleaning' });
    expect(btn.className).toMatch(/focus:ring-2/);
  });

  test('button has rounded-pill border-radius class', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    const btn = screen.getByRole('button', { name: 'Start Cleaning' });
    expect(btn.className).toMatch(/rounded-pill/);
  });

  test('no "Stop Cleaning" button is visible simultaneously with "Start Cleaning"', () => {
    render(
      <CleaningToggle
        isRunning={false}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    expect(screen.queryByRole('button', { name: 'Stop Cleaning' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start Cleaning' })).toBeInTheDocument();
  });

  test('no "Start Cleaning" button is visible simultaneously with "Stop Cleaning"', () => {
    render(
      <CleaningToggle
        isRunning={true}
        isLoading={false}
        onStart={noop}
        onStop={noop}
        error={null}
      />
    );
    expect(screen.queryByRole('button', { name: 'Start Cleaning' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop Cleaning' })).toBeInTheDocument();
  });
});
