'use client';

import { motion } from 'framer-motion';

// ---------------------------------------------------------------------------
// Equalizer-style waveform
//
// Renders a row of vertical bars that animate their heights in a continuous
// loop while cleaning is active (an audio-equalizer look), collapse to a thin
// flat baseline when stopped, and render statically (no looping animation) when
// the user prefers reduced motion.
// ---------------------------------------------------------------------------

/** Number of bars in the waveform. */
const BAR_COUNT = 100;

/** Baseline bar height (%) used for the stopped / resting state. */
const BASELINE_PCT = 6;

interface WaveformProps {
  isActive: boolean;
  reducedMotion: boolean;
}

/**
 * Deterministic per-bar peak height (%) so SSR and client hydration always
 * agree. Uses a centre-weighted envelope (taller in the middle, shorter at the
 * edges) layered with sine detail for an organic, music-like silhouette.
 */
function barPeakPct(i: number): number {
  const t = i / (BAR_COUNT - 1); // 0 → 1
  const envelope = Math.sin(t * Math.PI); // 0 → 1 → 0 (tallest in the centre)
  const detail =
    0.5 + 0.5 * Math.abs(Math.sin(i * 1.7) * 0.6 + Math.sin(i * 0.5) * 0.4);
  return Math.round(BASELINE_PCT + envelope * detail * 80); // ~6% → ~86%
}

/** Deterministic per-bar loop duration in seconds (0.7s–1.3s). */
function barDuration(i: number): number {
  return 0.7 + Math.abs(Math.sin(i * 2.3)) * 0.6;
}

export function Waveform({ isActive, reducedMotion }: WaveformProps) {
  const bars = Array.from({ length: BAR_COUNT });
  const barColor = isActive
    ? 'var(--color-brand)'
    : 'var(--color-bg-surface-hover)';
  const statusText = isActive ? 'Cleaning in progress' : 'Stopped';

  return (
    <div className="fixed inset-0 flex items-center justify-center pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
      {/* Bars — decorative, hidden from the a11y tree. */}
      <div
        aria-hidden="true"
        data-testid="waveform-bars"
        className="flex items-center justify-center gap-[3px] w-full max-w-5xl px-8"
        style={{ height: 340, opacity: 0.2 }}
      >
        {bars.map((_, i) => {
          const peak = barPeakPct(i);

          // Static (reduced-motion or stopped) vs looping (active) targets.
          const animate =
            reducedMotion || !isActive
              ? {
                  height: `${
                    isActive ? Math.max(BASELINE_PCT, Math.round(peak * 0.2)) : BASELINE_PCT
                  }%`,
                }
              : {
                  height: [
                    `${BASELINE_PCT}%`,
                    `${peak}%`,
                    `${Math.max(BASELINE_PCT, Math.round(peak * 0.4))}%`,
                    `${Math.round(peak * 0.8)}%`,
                    `${BASELINE_PCT}%`,
                  ],
                };

          const transition =
            reducedMotion || !isActive
              ? { duration: 0.5, ease: 'easeOut' as const }
              : {
                  duration: barDuration(i),
                  repeat: Infinity,
                  ease: 'easeInOut' as const,
                  delay: (i % 10) * 0.05,
                };

          return (
            <motion.span
              key={i}
              className="flex-1 rounded-full"
              style={{
                backgroundColor: barColor,
                minWidth: 2,
                maxWidth: 8,
                transformOrigin: 'center',
              }}
              initial={false}
              animate={animate}
              transition={transition}
            />
          );
        })}
      </div>

      {/* Screen-reader-only status label (visually hidden — no on-screen text). */}
      <p role="status" aria-live="polite" className="sr-only">
        {statusText}
      </p>
    </div>
  );
}
