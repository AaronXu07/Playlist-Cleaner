'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

interface ToastProps {
  message: string;
  onDismiss: () => void;
  autoDismissMs?: number;
}

export function Toast({ message, onDismiss, autoDismissMs = 5000 }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(timer);
  }, [onDismiss, autoDismissMs]);

  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-card bg-bg-surface shadow-elevated p-4 text-primary"
    >
      <span className="text-sm">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="flex-shrink-0 rounded-card p-1 hover:bg-bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <X size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}
