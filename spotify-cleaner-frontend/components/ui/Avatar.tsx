'use client';

import { User } from 'lucide-react';

interface AvatarProps {
  /** Spotify display name — shown as initials when no avatarUrl is available. */
  displayName?: string | null;
  /** Spotify profile picture URL. Shown in preference to initials when set. */
  avatarUrl?: string | null;
  onClick: () => void;
  isOpen?: boolean;
}

/**
 * Derives up to 2 initials from a display name.
 * - Multi-word names: first character of first and second word.
 * - Single-word names: first two characters.
 */
function getInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return displayName.slice(0, 2).toUpperCase();
}

export function Avatar({ displayName, avatarUrl, onClick, isOpen = false }: AvatarProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="User menu"
      aria-expanded={isOpen}
      className="
        flex items-center justify-center
        w-10 h-10
        rounded-full
        bg-bg-surface
        text-primary text-sm font-sans
        focus:outline-none focus:ring-2 focus:ring-brand
        transition-colors duration-150
        hover:bg-bg-surface-hover
        overflow-hidden
      "
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={displayName ? `${displayName} profile picture` : 'Profile picture'}
          width={40}
          height={40}
          className="w-full h-full object-cover"
        />
      ) : displayName ? (
        <span aria-hidden="true">{getInitials(displayName)}</span>
      ) : (
        <User size={24} strokeWidth={1.5} aria-hidden="true" />
      )}
    </button>
  );
}
