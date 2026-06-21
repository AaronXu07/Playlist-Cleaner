/**
 * Property 4: Year-marker data is contiguous and the rendered count matches
 * the dataset length.
 *
 * Validates: Requirements 4.1
 *
 * This test verifies the curated YEAR_MARKERS array is complete and correct
 * against the data-driven invariants:
 * - Count matches the dataset length (11 entries, 2016–2026 inclusive)
 * - No duplicate years
 * - Years (sorted ascending) form a strictly increasing contiguous sequence
 * - Range is exactly 2016–2026
 * - Every integer year in the range is present
 * - Each albumArt is hosted on i.scdn.co
 * - Each non-null preview_url is hosted on p.scdn.co
 */

// Feature: spotify-playlist-cleaner-frontend, Property 4: year-marker data contiguity & data-driven count

import { describe, test, expect } from 'vitest';
import * as fc from 'fast-check';
import { YEAR_MARKERS } from '../lib/yearMarkerData';

const EXPECTED_COUNT = 11;
const MIN_YEAR = 2016;
const MAX_YEAR = 2026;

const ALBUM_ART_HOST = /^https:\/\/i\.scdn\.co\/image\//;
const PREVIEW_HOST = /^https:\/\/p\.scdn\.co\/mp3-preview\//;

const sortedYears = () => YEAR_MARKERS.map(m => m.year).sort((a, b) => a - b);

describe('YEAR_MARKERS — data contiguity & data-driven count (Property 4)', () => {

  test('contains exactly 11 entries', () => {
    expect(YEAR_MARKERS.length).toBe(EXPECTED_COUNT);
  });

  test('contains no duplicate years', () => {
    const uniqueYears = new Set(YEAR_MARKERS.map(m => m.year));
    expect(uniqueYears.size).toBe(YEAR_MARKERS.length);
  });

  test('years sorted ascending form a strictly increasing contiguous sequence', () => {
    const years = sortedYears();
    for (let i = 0; i < years.length - 1; i++) {
      expect(years[i + 1] - years[i], `Gap between ${years[i]} and ${years[i + 1]}`).toBe(1);
    }
  });

  test('range is exactly 2016–2026', () => {
    const years = YEAR_MARKERS.map(m => m.year);
    expect(Math.min(...years)).toBe(MIN_YEAR);
    expect(Math.max(...years)).toBe(MAX_YEAR);
  });

  test('contains every integer year from 2016 to 2026 with no gaps', () => {
    const yearSet = new Set(YEAR_MARKERS.map(m => m.year));
    for (let year = MIN_YEAR; year <= MAX_YEAR; year++) {
      expect(yearSet.has(year), `Missing year ${year}`).toBe(true);
    }
  });

  test('every albumArt is hosted on i.scdn.co', () => {
    for (const marker of YEAR_MARKERS) {
      expect(marker.albumArt, `albumArt for ${marker.year}`).toMatch(ALBUM_ART_HOST);
    }
  });

  test('every non-null preview_url is hosted on p.scdn.co', () => {
    for (const marker of YEAR_MARKERS) {
      if (marker.preview_url !== null) {
        expect(marker.preview_url, `preview_url for ${marker.year}`).toMatch(PREVIEW_HOST);
      }
    }
  });

  /**
   * **Validates: Requirements 4.1**
   *
   * Property 4: For any year sampled in the range [2016, 2026], that year
   * must be present in YEAR_MARKERS. This catches gaps that a sequential
   * loop might miss and provides confidence across the full input space.
   */
  test('property: every year in [2016, 2026] is present in YEAR_MARKERS', () => {
    const yearSet = new Set(YEAR_MARKERS.map(m => m.year));

    fc.assert(
      fc.property(
        fc.integer({ min: MIN_YEAR, max: MAX_YEAR }),
        (year) => {
          return yearSet.has(year);
        }
      ),
      { numRuns: 100 }
    );
  });

});
