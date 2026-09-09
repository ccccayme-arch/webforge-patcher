# Release Notes

## v1.0.3 — September 9, 2026

### Fixes
- **Fixed broken live demo URL** — README and device guide pointed to
  `ccccayme.github.io` (404) instead of the correct `ccccayme-arch.github.io`

### Device Database
- Added **rhodep** (Moto G Play 2023, XT2271-5, MediaTek Helio G37) — now auto-detected over WebUSB
- Added **tonga** (Moto G Power 2022) — now auto-detected over WebUSB
- Motorola codename coverage: 11 devices

### Documentation
- Added `docs/flashing-rhodep-moto-g-play-2023.md` — complete step-by-step
  unlocking, patching, and rooting guide for the Moto G Play (2023), including
  carrier-variant warnings and MediaTek-specific gotchas

---

## v1.0.2 — August 25, 2026

### Documentation
- Added **CSS & UX Polish** section to README covering Odin panel, bootloader card,
  toast system, status indicators, utility classes, and responsive breakpoints
- Added `docs/cpio-builder-bugfix.md` — full technical writeup of the critical CPIO
  data offset alignment bug (root cause, fix, verification, lessons learned)
- Updated project stats: 28 files, ~7,800 lines, 68 tests

---

## v1.0.1 — August 24, 2026

### CSS Rewrite & UX Polish
Complete stylesheet rewrite eliminating all accumulated duplicate rules. Organized
into clear sections: Variables → Base → Layout → Components → Panels → Utilities.

#### New UI Components
- **Toast notifications** — `Utils.toast(msg, type, duration)` with 4 variants:
  - `success` (✓ green), `warn` (⚠ amber), `error` (✕ red), `info` (ℹ blue)
  - Slide-in/out animations, auto-dismiss, safe-area-inset support for notched devices
  - Wired at 25+ user touchpoints: connect, disconnect, patch, flash, boot, unlock,
    reboot, download, and error fallback
- **Connection status indicators** — `.status-dot` with 3 states:
  - `.connected` (green, pulsing glow animation), `.disconnected` (gray), `.error` (red)
  - Wired for both Fastboot and Odin panels via `Utils.setStatus(elementId, state)`
- **Loading utilities** — `.spinner` / `.spinner-lg` rotation animation, `.skeleton`
  shimmer effect for loading placeholders
- **Empty state** — `.empty-state` with icon + text for panels with no content

#### CSS Deduplication
- Eliminated duplicate `@media (max-width: 480px)` and `@media (min-width: 768px)` blocks
- Collapsed duplicate `@keyframes fadeIn`, duplicate `code` styling, duplicate
  `.ai-input-row` definitions, conflicting `.btn:disabled` opacity values
- Result: zero conflicting rules, single source of truth for every selector

#### Design Tokens
- Added: `--shadow-sm/md/glow`, `--transition`, `--transition-fast`, `--border-subtle`,
  `--accent-soft`, `--success-soft`, `--warn-soft`, `--error-soft`, `--radius-sm/lg`
- Card hover border-color transitions, refined focus rings

#### JS Cleanup
- `Utils.toast()` and `Utils.setStatus()` added to Utils class
- Old inline `_showError` / `_showSuccess` toast implementations replaced with `Utils.toast`
- Remaining `style.setProperty` calls replaced with `classList.add('hidden')`
- Only 2 `style.` references remain (both are dynamic progress bar widths — correct)

#### HTML
- Toast container (`#toast-container`) added before script tags
- Status dots added to Fastboot and Odin device info cards

**Files changed:** 4 (css/style.css, index.html, js/app.js, js/utils.js)
**Tests:** 68 passed, 0 failed

---

## v1.0.0 — August 24, 2026

Initial release. Browser-based Android boot image patcher and flasher PWA.

### Core Features

#### Boot Image Patching (God Mode)
- Parse and rebuild Android boot images (header v0–v4, including vendor boot)
- Full Magisk ramdisk injection: decompress → parse CPIO → inject binaries →
  repack → recompress
- Supports gzip and LZ4 ramdisk compression
- Android 15 16KB page size support (auto-detected, toggleable)
- dm-verity / AVB disable via empty vbmeta generation and cmdline patching
- Pre-flash validation: header structure, page alignment, partition compatibility
- Smart partition auto-detection (boot vs init_boot vs vendor_boot)

#### Fastboot Flashing
- WebUSB-based Fastboot protocol implementation
- Flash boot, init_boot, vendor_boot, and vbmeta partitions
- Temporary boot — test patched image without writing to flash
- Memory-optimized streaming transfer for large images
- Full device variable query (`getvar:all` with fallback)
- A/B slot management: get current slot, switch to inactive slot
- Bootloader unlock/lock commands
- OEM device-specific commands
- Multiple reboot modes: normal, bootloader, recovery, fastbootd
- Device interrogation: complete snapshot of vars, battery, unlock state
- Partition queries: type, size, verification
- Battery charge check (Pixel-specific)
- Flash abort support

#### Samsung Odin (WebOdin)
- Full Odin/Download Mode protocol over WebUSB
- Flash .tar.md5 firmware archives
- Samsung .lz4 decompression support
- RFC 1321 MD5 integrity verification
- PIT (Partition Information Table) parsing and display
- NAND RSP/PIRS command support
- Device interrogation (model, firmware, bootloader, serial, region)
- Factory reset (erase userdata/cache)
- Streaming flash with automatic retry on failure
- Flash abort capability

#### AI Assistant (Groq-Powered)
- Smart device detection and patching strategy recommendation
- Error diagnosis when flashing fails (13 local error patterns + Groq enhancement)
- Boot image analysis and compatibility checking
- Interactive chat with device-specific rooting knowledge
- Offline knowledge base: 9 brands with detailed rooting instructions
  (Google Pixel, Samsung, OnePlus, Xiaomi, Motorola, Nothing, Sony, Fairphone, ASUS)
- Local device database: 100+ codenames across 13 brands for instant identification
- Hybrid diagnosis: local pattern match → Groq enhancement → generic fallback
- Groq model: llama-3.3-70b-versatile

#### PWA
- Installable on mobile and desktop
- Offline support via service worker caching
- COOP/COEP headers for SharedArrayBuffer support
- Mobile-first responsive design

### Critical Bug Fix (Pre-Release)
**CPIO newc builder data offset alignment bug** — The `_buildCPIO()` method was not
emitting name padding bytes between the name field and file data, causing a 2-byte+
offset shift that cascaded through every entry in the archive. This would have
silently corrupted every patched boot image, producing unbootable ramdisks that
would brick devices on flash. Fixed before initial deployment.

See `docs/cpio-builder-bugfix.md` for full technical details.

### CSS Polish (Post-Initial Commit)
- Odin panel: `.odin-warning` amber box, `.pit-table` monospace table, `.btn-abort`
- Bootloader card: `.bootloader-card` title with warning icon, `.btn-unlock` amber variant
- AI panel: key input, analysis output, chat messages, diagnosis card styling
- Staggered card entrance animations per panel
- Mobile responsive breakpoints (480px, 768px landscape)
- Replaced 31/32 inline styles with CSS classes (subsequently completed to 100%)

### Inline Style Elimination
- Replaced all `element.style.display = 'block'/'none'` with `classList.add/remove('hidden')`
- Removed inline styles from innerHTML injections (diagnosis, device info)
- Zero `style.display` calls remain in any JS module

### Project Stats
- 28 files, ~7,800 lines, ~520KB
- 68 integration tests, 0 failures
- Zero runtime dependencies (native browser APIs only)
- Works offline (PWA with service worker caching)

### License
MIT — Use at your own risk.
