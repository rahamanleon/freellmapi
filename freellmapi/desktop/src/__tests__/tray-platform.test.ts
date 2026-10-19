import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dt, NATIVE_LOCALES } from '../i18n.js';
import { describe, expect, it } from 'vitest';
import { shouldOpenDashboardOnLaunch, trayMenuOffersPopover, trayPlatform } from '../tray-platform.js';

// #1353: on Windows the tray failed with "Unable to create status tray icon"
// because every platform got the macOS template PNG. The Windows branch never
// runs on the mac this repo is developed on, so it is asserted here.

const yaml = createRequire(import.meta.url)('js-yaml');
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assets = join(desktopRoot, 'assets');

// ICONDIR + ICONDIRENTRY widths (0 means 256).
function icoSizes(buf: Buffer): number[] {
  expect(buf.readUInt16LE(0)).toBe(0);
  expect(buf.readUInt16LE(2)).toBe(1);
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => buf.readUInt8(6 + 16 * i) || 256);
}

describe('tray per platform (#1353)', () => {
  it('keeps the macOS menu bar on the tinted template image and the popover', () => {
    expect(trayPlatform('darwin')).toEqual({
      iconFile: 'trayTemplate.png',
      templateImage: true,
      leftClick: 'popover',
    });
  });

  it('gives Windows an .ico, no template flag, and a left-click that opens the dashboard', () => {
    expect(trayPlatform('win32')).toEqual({
      iconFile: 'tray.ico',
      templateImage: false,
      leftClick: 'dashboard',
    });
  });

  it('gives Linux the full-colour PNG rather than the black template glyph', () => {
    const linux = trayPlatform('linux');
    expect(linux.iconFile).toBe('tray.png');
    expect(linux.templateImage).toBe(false);
  });

  it('ships every tray icon it names inside the packaged assets', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(existsSync(join(assets, trayPlatform(platform).iconFile))).toBe(true);
    }
    // tray.ts resolves ../assets from build/, so assets/ must be packed.
    const config = yaml.load(readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8')) as {
      files?: string[];
    };
    expect(config.files).toContain('assets/**/*');
  });

  it('ships a multi-size Windows .ico covering 100% to 400% DPI', () => {
    const sizes = icoSizes(readFileSync(join(assets, 'tray.ico')));
    for (const size of [16, 20, 24, 32, 40, 48, 64]) expect(sizes).toContain(size);
  });
});

describe('opening the dashboard at launch (#1353)', () => {
  it('opens it once on a first Windows launch', () => {
    expect(shouldOpenDashboardOnLaunch('win32', { trayBuilt: true, welcomedBefore: false })).toBe(true);
    expect(shouldOpenDashboardOnLaunch('win32', { trayBuilt: true, welcomedBefore: true })).toBe(false);
  });

  it('leaves macOS and Linux launching quietly into the tray', () => {
    expect(shouldOpenDashboardOnLaunch('darwin', { trayBuilt: true, welcomedBefore: false })).toBe(false);
    expect(shouldOpenDashboardOnLaunch('linux', { trayBuilt: true, welcomedBefore: false })).toBe(false);
  });

  it('always opens it when the tray could not be built, since nothing else is visible', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(shouldOpenDashboardOnLaunch(platform, { trayBuilt: false, welcomedBefore: true })).toBe(true);
    }
  });
});

describe('the compact popover keeps an entry point (#1412)', () => {
  it('names the panel in the tray menu only where left-click does not toggle it', () => {
    expect(trayMenuOffersPopover('win32')).toBe(true);
    for (const platform of ['darwin', 'linux'] as const) {
      expect(trayMenuOffersPopover(platform)).toBe(false);
    }
  });

  // What #1412 broke: Windows gave left-click to the dashboard and nothing else
  // could open the popover. A platform added later must not slip through, and
  // dt() falls back to English for a missing key, so each locale is compared
  // against the English label rather than just checked for a non-empty string.
  it('leaves every supported platform a route to the popover, in every locale', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const reachable = trayPlatform(platform).leftClick === 'popover' || trayMenuOffersPopover(platform);
      expect(reachable, `${platform}: no way to open the compact panel`).toBe(true);
    }
    const english = dt('en', 'showCompactPanel');
    for (const locale of NATIVE_LOCALES.filter(l => l !== 'en')) {
      expect(dt(locale, 'showCompactPanel'), `${locale} is untranslated`).not.toBe(english);
    }
  });
});
