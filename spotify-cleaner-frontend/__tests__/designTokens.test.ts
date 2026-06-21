/**
 * SMOKE tests for design tokens.
 * Reads raw file content and asserts that the correct values are present.
 * Requirements: 1.1–1.4, 1.9
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

const globalsCss = readFileSync(resolve(ROOT, 'app/globals.css'), 'utf-8');
const tailwindConfig = readFileSync(resolve(ROOT, 'tailwind.config.ts'), 'utf-8');

// ── CSS Custom Properties ────────────────────────────────────────────────────

describe('globals.css — CSS custom property values', () => {
  const tokens: Array<[string, string]> = [
    ['--color-bg-base',          '#121212'],
    ['--color-bg-surface',       '#181818'],
    ['--color-bg-surface-hover', '#282828'],
    ['--color-brand',            '#1DB954'],
    ['--color-danger',           '#E74C3C'],
    ['--color-text-primary',     '#FFFFFF'],
    ['--color-text-muted',       '#A7A7A7'],
    ['--shadow-elevated',        '0 4px 16px rgba(0, 0, 0, 0.48)'],
    ['--radius-card',            '8px'],
    ['--radius-pill',            '9999px'],
  ];

  test.each(tokens)('%s is set to %s', (property, value) => {
    // Match: `--property: value` with optional surrounding whitespace
    const pattern = new RegExp(
      property.replace(/-/g, '\\-') +
      '\\s*:\\s*' +
      value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    expect(globalsCss).toMatch(pattern);
  });
});

// ── Tailwind Config Entries ──────────────────────────────────────────────────

describe('tailwind.config.ts — Tailwind utility class mappings', () => {
  test('colors.brand maps to --color-brand CSS variable', () => {
    expect(tailwindConfig).toContain('brand');
    expect(tailwindConfig).toContain('var(--color-brand)');
  });

  test('colors.danger maps to --color-danger CSS variable', () => {
    expect(tailwindConfig).toContain('danger');
    expect(tailwindConfig).toContain('var(--color-danger)');
  });

  test("colors['bg-base'] maps to --color-bg-base CSS variable", () => {
    expect(tailwindConfig).toContain('"bg-base"');
    expect(tailwindConfig).toContain('var(--color-bg-base)');
  });

  test("colors['bg-surface'] maps to --color-bg-surface CSS variable", () => {
    expect(tailwindConfig).toContain('"bg-surface"');
    expect(tailwindConfig).toContain('var(--color-bg-surface)');
  });

  test("colors['bg-surface-hover'] maps to --color-bg-surface-hover CSS variable", () => {
    expect(tailwindConfig).toContain('"bg-surface-hover"');
    expect(tailwindConfig).toContain('var(--color-bg-surface-hover)');
  });

  test('colors.primary maps to --color-text-primary CSS variable', () => {
    expect(tailwindConfig).toContain('primary');
    expect(tailwindConfig).toContain('var(--color-text-primary)');
  });

  test('colors.muted maps to --color-text-muted CSS variable', () => {
    expect(tailwindConfig).toContain('muted');
    expect(tailwindConfig).toContain('var(--color-text-muted)');
  });

  test('boxShadow.elevated maps to --shadow-elevated CSS variable', () => {
    expect(tailwindConfig).toContain('elevated');
    expect(tailwindConfig).toContain('var(--shadow-elevated)');
  });

  test('borderRadius.card maps to --radius-card CSS variable', () => {
    expect(tailwindConfig).toContain('card');
    expect(tailwindConfig).toContain('var(--radius-card)');
  });

  test('borderRadius.pill maps to --radius-pill CSS variable', () => {
    expect(tailwindConfig).toContain('pill');
    expect(tailwindConfig).toContain('var(--radius-pill)');
  });
});

// ── No Purple Hues ───────────────────────────────────────────────────────────

describe('globals.css — no purple hue values (Requirement 1.9)', () => {
  test('contains no hsl() values in the purple range (270°–330°)', () => {
    // Match hsl(H, ...) where H falls in the purple range 270–330
    const hslPattern = /hsl\(\s*(\d+(?:\.\d+)?)/g;
    let match: RegExpExecArray | null;
    const purpleHues: number[] = [];

    while ((match = hslPattern.exec(globalsCss)) !== null) {
      const hue = parseFloat(match[1]);
      if (hue >= 270 && hue <= 330) {
        purpleHues.push(hue);
      }
    }

    expect(purpleHues).toHaveLength(0);
  });

  test('contains no hex color codes in the purple range', () => {
    // Extract all 3/6-digit hex colors and check they are not purple-toned
    // Purple hex colors have high blue+red, low green: roughly R > 100, G < 100, B > 100
    const hexPattern = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
    let match: RegExpExecArray | null;
    const purpleHexes: string[] = [];

    while ((match = hexPattern.exec(globalsCss)) !== null) {
      const hex = match[1];
      let r: number, g: number, b: number;

      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
      } else {
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
      }

      // Convert RGB to HSL hue and check for purple range (270–330)
      const rNorm = r / 255;
      const gNorm = g / 255;
      const bNorm = b / 255;
      const max = Math.max(rNorm, gNorm, bNorm);
      const min = Math.min(rNorm, gNorm, bNorm);
      const delta = max - min;

      if (delta > 0) {
        let hue = 0;
        if (max === rNorm) {
          hue = (((gNorm - bNorm) / delta) % 6) * 60;
        } else if (max === gNorm) {
          hue = (((bNorm - rNorm) / delta) + 2) * 60;
        } else {
          hue = (((rNorm - gNorm) / delta) + 4) * 60;
        }
        if (hue < 0) hue += 360;

        if (hue >= 270 && hue <= 330) {
          purpleHexes.push(`#${hex}`);
        }
      }
    }

    expect(purpleHexes).toHaveLength(0);
  });
});

// ── No Gradient Declarations ─────────────────────────────────────────────────

describe('globals.css — no CSS gradient declarations (Requirement 1.9)', () => {
  test('contains no linear-gradient()', () => {
    expect(globalsCss).not.toMatch(/linear-gradient\s*\(/i);
  });

  test('contains no radial-gradient()', () => {
    expect(globalsCss).not.toMatch(/radial-gradient\s*\(/i);
  });

  test('contains no conic-gradient()', () => {
    expect(globalsCss).not.toMatch(/conic-gradient\s*\(/i);
  });
});
