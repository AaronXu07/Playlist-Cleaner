'use client';

import { useEffect, useRef } from 'react';
import { LogOut } from 'lucide-react';

interface DropdownMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onSignOut: () => void;
}

export function DropdownMenu({ isOpen, onClose, onSignOut }: DropdownMenuProps) {
  const menuRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    function handleMouseDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <nav
      ref={menuRef}
      aria-label="User menu"
      className="
        absolute top-12 right-0
        bg-bg-surface
        shadow-elevated
        rounded-card
        py-2
      "
      style={{ minWidth: '160px' }}
    >
      <button
        type="button"
        onClick={onSignOut}
        aria-label="Sign out"
        className="
          flex items-center gap-2
          w-full px-4 py-2
          text-sm text-primary text-left
          hover:bg-bg-surface-hover
          focus:outline-none focus:ring-2 focus:ring-brand focus:ring-inset
          transition-colors duration-150
        "
      >
        <LogOut size={16} strokeWidth={1.5} aria-hidden="true" />
        Sign out
      </button>
    </nav>
  );
}
