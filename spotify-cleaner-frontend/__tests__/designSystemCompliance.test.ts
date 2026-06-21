/**
 * Design System Compliance Tests
 *
 * Scans all *.tsx and *.css source files (excluding test files, node_modules,
 * and .next) to enforce Design System color token rules.
 *
 * Rules enforced:
 *  1. No raw hex color values that are not in the Design System token set
 *  2. No `purple` keyword or gradient declarations
 *  3. No inline style with unsanctioned color values
 *  4. All color references in TSX use CSS custom properties or Tailwind tokens
 *
 * Requirements: 1.3, 1.9, 10.7, 10.8
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ROOT = resolve(__dirname, '..');

/**
 * Recursively collect all files with given extensions under `dir`,
 * skipping the given exclude directory patterns.
 */
function collectFiles(
  dir: string,
  extensions: string[],
  excludeDirs: string[]
): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (excludeDirs.some((ex) => entry === ex || fullPath.includes(ex))) {
        continue;
      }
      results.push(...collectFiles(fullPath, extensions, excludeDirs));
    } else if (extensions.includes(extname(entry))) {
      results.push(fullPath);
    }
  }

  return results;
}

const EXCLUDE_DIRS = ['node_modules', '.next', '.git'];

// Collect all TSX and CSS source files (excluding test files)
const allTsxFiles = collectFiles(ROOT, ['.tsx'], EXCLUDE_DIRS).filter(
  (f) =>
    !f.includes('__tests__') &&
    !f.endsWith('.test.tsx') &&
    !f.endsWith('.spec.tsx')
);

const allCssFiles = collectFiles(ROOT, ['.css'], EXCLUDE_DIRS);

const allSourceFiles = [...allTsxFiles, ...allCssFiles];

// ── Design System Token Set ───────────────────────────────────────────────────

/**
 * The exact hex values sanctioned by the Design System.
 * Any hex color found in source files MUST be one of these.
 */
const SANCTIONED_HEX_COLORS = new Set([
  '#121212', // --color-bg-base
  '#181818', // --color-bg-surface
  '#282828', // --color-bg-surface-hover
  '#1DB954', // --color-brand
  '#E74C3C', // --color-danger
  '#FFFFFF', // --color-text-primary
  '#A7A7A7', // --color-text-muted
  // Case-insensitive variants
  '#121212'.toLowerCase(),
  '#181818'.toLowerCase(),
  '#282828'.toLowerCase(),
  '#1db954',
  '#e74c3c',
  '#ffffff',
  '#a7a7a7',
]);

/**
 * Parse a hex color string (3 or 6 chars after the #) into { r, g, b }.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  if (h.length === 6) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  return null;
}

/**
 * Convert RGB to HSL hue (0–360).
 */
function rgbToHue(r: number, g: number, b: number): number | null {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) return null; // achromatic

  let hue = 0;
  if (max === rn) {
    hue = (((gn - bn) / delta) % 6) * 60;
  } else if (max === gn) {
    hue = (((bn - rn) / delta) + 2) * 60;
  } else {
    hue = (((rn - gn) / delta) + 4) * 60;
  }
  if (hue < 0) hue += 360;
  return hue;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Design System Compliance — no unsanctioned hex colors', () => {
  test('all source files are found', () => {
    expect(allSourceFiles.length).toBeGreaterThan(0);
  });

  test.each(allSourceFiles)(
    'no unsanctioned raw hex colors in %s',
    (filePath) => {
      const content = readFileSync(filePath, 'utf-8');

      // Match all hex color literals (3 or 6 hex digits preceded by #)
      // word boundary or non-alphanumeric on the right to avoid matching CSS comments like #1DB954;
      const hexPattern = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
      let match: RegExpExecArray | null;
      const violations: string[] = [];

      while ((match = hexPattern.exec(content)) !== null) {
        const hexFull = match[0].toUpperCase();
        const hexLower = match[0].toLowerCase();

        // Allow any that are in our sanctioned set (case-insensitive)
        if (!SANCTIONED_HEX_COLORS.has(hexFull) && !SANCTIONED_HEX_COLORS.has(hexLower)) {
          // Get line number for better error messages
          const upToMatch = content.slice(0, match.index);
          const line = upToMatch.split('\n').length;
          violations.push(`  Line ${line}: ${match[0]}`);
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `Unsanctioned hex colors found in ${filePath}:\n${violations.join('\n')}\n` +
          `Use a CSS custom property (var(--color-*)) or Tailwind token class instead.`
        );
      }
    }
  );
});

describe('Design System Compliance — no purple tones', () => {
  test.each(allSourceFiles)(
    'no purple keyword or purple-hued hex values in %s',
    (filePath) => {
      const content = readFileSync(filePath, 'utf-8');

      // 1. Check for the word "purple" (as a CSS color or Tailwind class)
      // Allow it in comments only — the regex below specifically avoids matching
      // inside /* ... */ or // ... comment lines.
      const lines = content.split('\n');
      const purpleViolations: string[] = [];

      lines.forEach((line, i) => {
        const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        // Check if 'purple' appears as a color value (not in a string context that's a label/text)
        if (/\bpurple\b/i.test(stripped)) {
          purpleViolations.push(`  Line ${i + 1}: ${line.trim()}`);
        }
      });

      if (purpleViolations.length > 0) {
        throw new Error(
          `"purple" keyword found in ${filePath}:\n${purpleViolations.join('\n')}`
        );
      }

      // 2. Check all hex colors are not in the purple hue range (270°–330°)
      const hexPattern = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
      let match: RegExpExecArray | null;
      const purpleHexViolations: string[] = [];

      while ((match = hexPattern.exec(content)) !== null) {
        const rgb = hexToRgb(match[0]);
        if (!rgb) continue;
        const hue = rgbToHue(rgb.r, rgb.g, rgb.b);
        if (hue !== null && hue >= 270 && hue <= 330) {
          const upToMatch = content.slice(0, match.index);
          const line = upToMatch.split('\n').length;
          purpleHexViolations.push(`  Line ${line}: ${match[0]} (hue: ${Math.round(hue)}°)`);
        }
      }

      if (purpleHexViolations.length > 0) {
        throw new Error(
          `Purple-hued colors found in ${filePath}:\n${purpleHexViolations.join('\n')}`
        );
      }
    }
  );
});

describe('Design System Compliance — no gradient declarations', () => {
  test.each(allSourceFiles)(
    'no gradient declarations in %s',
    (filePath) => {
      const content = readFileSync(filePath, 'utf-8');

      const gradientPattern = /(linear|radial|conic)-gradient\s*\(/i;

      if (gradientPattern.test(content)) {
        const lines = content.split('\n');
        const violations: string[] = [];

        lines.forEach((line, i) => {
          if (gradientPattern.test(line)) {
            violations.push(`  Line ${i + 1}: ${line.trim()}`);
          }
        });

        throw new Error(
          `CSS gradient declaration found in ${filePath}:\n${violations.join('\n')}\n` +
          `The Design System prohibits gradient declarations (Requirement 1.9).`
        );
      }
    }
  );
});

describe('Design System Compliance — TSX inline styles use only tokens', () => {
  /**
   * Check that any inline `color:` or `backgroundColor:` style in TSX files
   * uses either:
   *   - 'var(--color-*)' CSS custom property
   *   - 'transparent'
   *   - Tailwind class via className (not checked here, already allowed)
   * and NOT a raw color name like 'purple', 'red', etc.
   */
  const UNSANCTIONED_COLOR_NAMES = [
    'purple', 'violet', 'indigo', 'magenta', 'fuchsia', 'pink',
    'orange', 'yellow', 'teal', 'cyan', 'lime',
    // Allow 'red' and 'green' and 'white' and 'black' only if they appear
    // as named CSS colors outside of var() — but the Design System uses
    // hex-based tokens so none of these should appear as raw named colors
    'red', 'green', 'blue',
  ];

  test.each(allTsxFiles)(
    'no unsanctioned color names in inline styles in %s',
    (filePath) => {
      const content = readFileSync(filePath, 'utf-8');

      // Match inline style color values: color: '...' or backgroundColor: '...'
      // We capture the value inside the quotes
      const colorValuePattern =
        /(?:color|backgroundColor|background|borderColor)\s*:\s*['"]([^'"]+)['"]/g;

      let match: RegExpExecArray | null;
      const violations: string[] = [];

      while ((match = colorValuePattern.exec(content)) !== null) {
        const value = match[1];

        // Allow var(--color-*), 'transparent', or empty string
        if (
          value.startsWith('var(--color-') ||
          value.startsWith('var(--') ||
          value === 'transparent' ||
          value === 'inherit' ||
          value === 'currentColor' ||
          value === ''
        ) {
          continue;
        }

        // Check if the value is an unsanctioned named color
        const lowerValue = value.toLowerCase();
        const unsanctionedMatch = UNSANCTIONED_COLOR_NAMES.find((name) =>
          lowerValue === name || lowerValue.includes(name)
        );

        if (unsanctionedMatch) {
          const upToMatch = content.slice(0, match.index);
          const line = upToMatch.split('\n').length;
          violations.push(
            `  Line ${line}: ${match[0]} — unsanctioned color name "${unsanctionedMatch}"`
          );
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `Unsanctioned color names in inline styles in ${filePath}:\n${violations.join('\n')}\n` +
          `Use var(--color-*) CSS custom properties instead.`
        );
      }
    }
  );
});

describe('Design System Compliance — globals.css confirmed clean (re-verification)', () => {
  const globalsContent = readFileSync(resolve(ROOT, 'app/globals.css'), 'utf-8');

  test('globals.css contains no purple keyword', () => {
    expect(globalsContent.toLowerCase()).not.toMatch(/\bpurple\b/);
  });

  test('globals.css contains no gradient declarations', () => {
    expect(globalsContent).not.toMatch(/(linear|radial|conic)-gradient\s*\(/i);
  });

  test('globals.css only uses sanctioned hex values', () => {
    const hexPattern = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
    let match: RegExpExecArray | null;
    const unsanctionedHex: string[] = [];

    while ((match = hexPattern.exec(globalsContent)) !== null) {
      const hexLower = match[0].toLowerCase();
      if (!SANCTIONED_HEX_COLORS.has(hexLower) && !SANCTIONED_HEX_COLORS.has(match[0].toUpperCase())) {
        unsanctionedHex.push(match[0]);
      }
    }

    expect(unsanctionedHex).toHaveLength(0);
  });
});
