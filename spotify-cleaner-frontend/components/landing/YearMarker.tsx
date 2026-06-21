'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Play, Pause, Music } from 'lucide-react';
import { YearMarkerDatum } from '@/lib/yearMarkerData';
import { useAudio } from '@/context/AudioContext';

interface YearMarkerProps {
  datum: YearMarkerDatum;
  position: { x: number; y: number };
  side: 'left' | 'right'; // OUTER side of the curve — the direction the path weaves toward here
  isPlaying: boolean; // derived from AudioContext: playingUrl === datum.preview_url
  onToggle: () => void; // single handler: play if paused, pause if this marker is playing
}

/**
 * Displays a year marker on the timeline with album art, track info, and — when a preview
 * is available — acts as a single interactive control that toggles preview playback for
 * that track. Positioned absolutely within the SVG container at the computed (x, y)
 * coordinates from getPointAtLength().
 *
 * The `side` prop is the OUTER side of the curve (the direction the river path weaves toward
 * at this point). The title/artist/year info block is placed on that side so the text never
 * overlaps the timeline path.
 *
 * Requirements: 4.2, 4.5, 4.6, 4.7, 5.2, 5.4, 5.7, 10.2, 10.3, 10.5
 */
export default function YearMarker({
  datum,
  position,
  side,
  isPlaying,
  onToggle,
}: YearMarkerProps) {
  const { trackTitle, artistName, albumArt, year, preview_url } = datum;
  const { isLoading } = useAudio();

  // Album art may fail to load; fall back to a styled tile preserving dimensions.
  const [imgFailed, setImgFailed] = useState(false);
  const altText = `${trackTitle} by ${artistName} album art`;

  const hasPreview = preview_url !== null;
  const ariaLabel = isPlaying
    ? `Pause preview of ${trackTitle} by ${artistName}`
    : `Play preview of ${trackTitle} by ${artistName}`;

  // Album art node — 64×64 on mobile, 96×96 on sm+ (Req 10.5).
  const albumArtNode = (
    <div className="relative flex-shrink-0 w-14 h-14 sm:w-24 sm:h-24">
      {imgFailed ? (
        /* Fallback tile when the album art image fails to load (Req 10.5) */
        <div
          role="img"
          aria-label={altText}
          className="w-full h-full rounded-sm bg-bg-surface-hover flex items-center justify-center"
        >
          <Music size={28} strokeWidth={1.5} className="text-muted sm:hidden" aria-hidden="true" />
          <Music size={40} strokeWidth={1.5} className="text-muted hidden sm:block" aria-hidden="true" />
        </div>
      ) : (
        /* Album art thumbnail — responsive size (Req 10.5) */
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={albumArt}
          alt={altText}
          width={96}
          height={96}
          onError={() => setImgFailed(true)}
          className="w-full h-full object-cover rounded-sm"
        />
      )}
      {/* Play/Pause icon overlay — only shown for the interactive variant (Req 4.5, 5.2) */}
      {hasPreview && (
        <div className="absolute bottom-1 right-1 w-7 h-7 sm:w-10 sm:h-10 rounded-full bg-surface/80 flex items-center justify-center">
          {isPlaying ? (
            <Pause size={18} strokeWidth={1.5} className="sm:hidden" aria-hidden="true" />
          ) : (
            <Play size={18} strokeWidth={1.5} className="sm:hidden" aria-hidden="true" />
          )}
          {isPlaying ? (
            <Pause size={28} strokeWidth={1.5} className="hidden sm:block" aria-hidden="true" />
          ) : (
            <Play size={28} strokeWidth={1.5} className="hidden sm:block" aria-hidden="true" />
          )}
        </div>
      )}
    </div>
  );

  // Track info block — placed on the outer side of the curve (Req 4.2, 4.7).
  const infoNode = (
    <div
      className={[
        'flex flex-col justify-center min-w-0',
        side === 'left' ? 'items-end text-right' : 'items-start text-left',
      ].join(' ')}
    >
      {/* Year label (Req 4.2) */}
      <span className="text-xs sm:text-base font-bold text-primary leading-none mb-1">{year}</span>
      {/* Track title (Req 4.2) */}
      <span className="text-sm sm:text-lg text-primary leading-tight truncate max-w-[88px] sm:max-w-[240px]">
        {trackTitle}
      </span>
      {/* Artist name (Req 4.2) */}
      <span className="text-xs sm:text-sm text-muted leading-tight truncate max-w-[88px] sm:max-w-[240px]">
        {artistName}
      </span>
    </div>
  );

  // Shared layout classes so the interactive and non-interactive variants have identical
  // dimensions and visual styling — keeping the timeline rhythm unchanged (Req 4.6).
  const contentClassName = [
    'flex items-start gap-1.5 sm:gap-2 text-left',
    // When side is 'left', flow the content to the left of the timeline path.
    side === 'left' ? 'flex-row-reverse' : 'flex-row',
  ].join(' ');

  // Position the marker so it sits fully OUTSIDE the curve:
  // - left side: the right edge of the card aligns with the path peak (translate -100%)
  // - right side: the left edge aligns with the path peak (no translate needed)
  // A small gap (4px) is added between the path peak and the card edge.
  const GAP = 4;
  const translateX = side === 'left' ? `calc(-100% - ${GAP}px)` : `${GAP}px`;

  return (
    <div
      className="absolute"
      style={{
        left: position.x,
        top: position.y,
        transform: `translate(${translateX}, -50%)`,
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        whileInView={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        viewport={{ once: true }}
      >
        {hasPreview ? (
          /* Interactive variant: the ENTIRE marker is a single native <button> that toggles
             playback on click / Enter / Space (Req 4.5, 5.2, 5.4, 5.7, 10.2). */
          <button
            type="button"
            onClick={onToggle}
            disabled={isLoading}
            aria-label={ariaLabel}
            className={[
              contentClassName,
              // Visible keyboard focus ring of >=2px (Req 10.3)
              'rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors duration-150',
            ].join(' ')}
          >
            {albumArtNode}
            {infoNode}
          </button>
        ) : (
          /* Non-interactive variant: plain container, not a button, not focusable, no audio
             icon — but identical layout dimensions and styling (Req 4.6). */
          <div className={contentClassName}>
            {albumArtNode}
            {infoNode}
          </div>
        )}
      </motion.div>
    </div>
  );
}
