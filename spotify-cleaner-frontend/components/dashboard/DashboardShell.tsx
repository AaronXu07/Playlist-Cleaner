'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCleaningState } from '@/hooks/useCleaningState';
import { useRemovals } from '@/hooks/useRemovals';
import { postLogout } from '@/lib/api';
import { Avatar } from '@/components/ui/Avatar';
import { DropdownMenu } from '@/components/ui/DropdownMenu';
import { CleaningToggle } from '@/components/dashboard/CleaningToggle';
import { Waveform } from '@/components/dashboard/Waveform';
import { RemovedSongsPanel } from '@/components/dashboard/RemovedSongsPanel';

interface DashboardShellProps {
  user: { userId: string; spotifyId: string; displayName?: string | null; avatarUrl?: string | null };
}

export function DashboardShell({ user }: DashboardShellProps) {
  const router = useRouter();

  // ---------------------------------------------------------------------------
  // Cleaning engine state
  // ---------------------------------------------------------------------------
  const {
    state: cleaningState,
    isLoading: isCleaningLoading,
    error: cleaningError,
    start: startCleaning,
    stop: stopCleaning,
  } = useCleaningState();

  // ---------------------------------------------------------------------------
  // Removed songs state
  // ---------------------------------------------------------------------------
  const removals = useRemovals();

  // ---------------------------------------------------------------------------
  // Avatar / dropdown state
  // ---------------------------------------------------------------------------
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // ---------------------------------------------------------------------------
  // Reduced-motion preference
  // ---------------------------------------------------------------------------
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mq.matches);

    function handleChange(e: MediaQueryListEvent) {
      setPrefersReducedMotion(e.matches);
    }

    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, []);

  // ---------------------------------------------------------------------------
  // Sign out
  // ---------------------------------------------------------------------------
  async function handleSignOut() {
    try {
      await postLogout();
      router.push('/');
    } catch {
      router.push('/?error=logout_failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="relative flex h-screen min-h-0 flex-col overflow-hidden">
      <header className="relative z-20 flex shrink-0 items-center justify-between px-4 py-4 sm:px-8">
        <h1 className="text-xl font-bold text-primary sm:text-2xl">Dashboard</h1>
        <div className="relative">
          <Avatar
            displayName={user.displayName ?? user.spotifyId}
            avatarUrl={user.avatarUrl}
            onClick={() => setDropdownOpen((prev) => !prev)}
            isOpen={dropdownOpen}
          />
          <DropdownMenu
            isOpen={dropdownOpen}
            onClose={() => setDropdownOpen(false)}
            onSignOut={handleSignOut}
          />
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center px-4 pb-4 sm:px-8 sm:pb-6">
        {/* Background waveform — fixed to viewport, always vertically centred */}
        <Waveform
          isActive={cleaningState === 'active'}
          reducedMotion={prefersReducedMotion}
        />

        {/* Foreground content card */}
        <section className="relative z-10 mt-2 flex min-h-0 w-full max-w-xl flex-1 flex-col gap-3 sm:mt-3">
          <CleaningToggle
            isRunning={cleaningState === 'active'}
            isLoading={isCleaningLoading}
            onStart={startCleaning}
            onStop={stopCleaning}
            error={cleaningError}
          />
          <RemovedSongsPanel
            songs={removals.songs}
            isLoading={removals.isLoading}
            error={removals.error}
            rowErrors={removals.rowErrors}
            pendingReAdds={removals.pendingReAdds}
            onRetry={removals.retry}
            onReAdd={removals.reAdd}
          />
        </section>
      </main>
    </div>
  );
}
