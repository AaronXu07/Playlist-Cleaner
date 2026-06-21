'use client';

import { useEffect, useState } from 'react';
import { Play, Square, Loader2 } from 'lucide-react';

interface CleaningToggleProps {
  isRunning: boolean;
  isLoading: boolean;   // true while start/stop API call is in-flight
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  error: string | null;
}

export function CleaningToggle({
  isRunning,
  isLoading,
  onStart,
  onStop,
  error,
}: CleaningToggleProps) {
  // Controls whether the error <p> is shown; auto-clears after 5 seconds
  const [visibleError, setVisibleError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;

    // Show the new error immediately
    setVisibleError(error);

    // Clear it after 5 seconds
    const timer = setTimeout(() => {
      setVisibleError(null);
    }, 5000);

    return () => clearTimeout(timer);
  }, [error]);

  function handleClick() {
    if (isRunning) {
      onStop();
    } else {
      onStart();
    }
  }

  // Derive button appearance from state
  const colorClass = isRunning ? 'bg-danger' : 'bg-brand';
  const label = isRunning ? 'Stop Cleaning' : 'Start Cleaning';

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={isLoading}
        aria-label={label}
        className={`
          inline-flex items-center gap-2
          px-6 py-3
          rounded-pill
          text-primary text-base font-sans font-bold
          ${colorClass}
          disabled:opacity-60 disabled:cursor-not-allowed
          focus:outline-none focus:ring-2 focus:ring-primary
          transition-colors duration-150
        `}
      >
        {isLoading ? (
          <Loader2
            size={20}
            strokeWidth={1.5}
            className="animate-spin"
            aria-hidden="true"
          />
        ) : isRunning ? (
          <Square size={20} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <Play size={20} strokeWidth={1.5} aria-hidden="true" />
        )}
        <span>{label}</span>
      </button>

      {visibleError && (
        <p role="alert" className="text-danger text-sm text-center max-w-xs">
          {visibleError}
        </p>
      )}
    </div>
  );
}
