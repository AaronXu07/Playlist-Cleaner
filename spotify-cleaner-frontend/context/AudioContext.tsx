'use client';

import React, { createContext, useContext, useRef, useState, useEffect } from 'react';

interface AudioContextValue {
  playingUrl: string | null;
  isLoading: boolean; // true when audio.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA (3)
  play: (url: string) => Promise<void>;
  pause: () => void;
  stop: () => void;
}

const AudioCtx = createContext<AudioContextValue | null>(null);

export function AudioProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Initialise the singleton Audio element once on mount (client only)
  useEffect(() => {
    if (typeof window !== 'undefined' && audioRef.current === null) {
      audioRef.current = new Audio();
    }

    const audio = audioRef.current;
    if (!audio) return;

    const handleEnded = () => {
      setPlayingUrl(null);
    };

    const handleLoadStart = () => {
      setIsLoading(true);
    };

    const handleCanPlay = () => {
      setIsLoading(false);
    };

    const handleCanPlayThrough = () => {
      setIsLoading(false);
    };

    const handleError = () => {
      setIsLoading(false);
      setPlayingUrl(null);
    };

    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('loadstart', handleLoadStart);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('canplaythrough', handleCanPlayThrough);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('loadstart', handleLoadStart);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('canplaythrough', handleCanPlayThrough);
      audio.removeEventListener('error', handleError);
      // Clean up on provider unmount
      audio.pause();
      audio.src = '';
    };
  }, []);

  const stop = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.src = '';
    setPlayingUrl(null);
    setIsLoading(false);
  };

  const play = async (url: string): Promise<void> => {
    const audio = audioRef.current;
    if (!audio) return;

    stop();
    audio.src = url;
    setPlayingUrl(url);

    await audio.play();
  };

  const pause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    setPlayingUrl(null);
  };

  return (
    <AudioCtx.Provider value={{ playingUrl, isLoading, play, pause, stop }}>
      {children}
    </AudioCtx.Provider>
  );
}

export function useAudio(): AudioContextValue {
  const ctx = useContext(AudioCtx);
  if (ctx === null) {
    throw new Error('useAudio must be used within an AudioProvider');
  }
  return ctx;
}
