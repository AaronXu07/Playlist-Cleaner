/**
 * Unit tests for Toast component.
 * Requirements: 9.8, 10.1, 10.9
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toast } from './Toast';

describe('Toast component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  test('renders the provided message', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Something went wrong" onDismiss={onDismiss} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  test('renders a close button with aria-label "Dismiss notification"', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Test" onDismiss={onDismiss} />);
    const btn = screen.getByRole('button', { name: 'Dismiss notification' });
    expect(btn).toBeInTheDocument();
  });

  test('has aria-live="polite" on its container (Requirement 10.9)', () => {
    const onDismiss = vi.fn();
    const { container } = render(<Toast message="Test" onDismiss={onDismiss} />);
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
  });

  // ── Manual dismiss ─────────────────────────────────────────────────────────

  test('calls onDismiss when close button is clicked', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Test" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // ── Auto-dismiss ───────────────────────────────────────────────────────────

  test('calls onDismiss after the default 5000ms timeout', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Auto-dismiss test" onDismiss={onDismiss} />);

    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('calls onDismiss after a custom autoDismissMs timeout', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Custom timeout" onDismiss={onDismiss} autoDismissMs={2000} />);

    vi.advanceTimersByTime(1999);
    expect(onDismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('does not call onDismiss before the timeout elapses', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Not yet" onDismiss={onDismiss} autoDismissMs={3000} />);

    vi.advanceTimersByTime(2999);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('cleans up the timeout when unmounted before it fires (no memory leak)', () => {
    const onDismiss = vi.fn();
    const { unmount } = render(<Toast message="Unmount test" onDismiss={onDismiss} />);

    unmount();

    // Advance past the default 5s — onDismiss should NOT be called after unmount
    vi.advanceTimersByTime(5000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // ── Positioning ────────────────────────────────────────────────────────────

  test('renders with fixed bottom-right positioning classes', () => {
    const onDismiss = vi.fn();
    const { container } = render(<Toast message="Position test" onDismiss={onDismiss} />);
    const toast = container.firstChild as HTMLElement;
    expect(toast.className).toMatch(/fixed/);
    expect(toast.className).toMatch(/bottom-4/);
    expect(toast.className).toMatch(/right-4/);
  });
});
