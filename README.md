# WebForge Patcher

A browser-based Android boot image patcher and flasher PWA. No server, no desktop app — just open the page in Chrome, connect your device via USB, and patch/flash directly.

**Live demo:** Deploy via GitHub Pages (see Deployment section).

## Stats

- 27 files · ~7,000 lines · ~518KB total
- 60 integration tests, all passing
- Zero runtime dependencies (native browser APIs only)
- Works offline (PWA with service worker caching)

## Features

### Boot Image Patching (God Mode)
- Parse and rebuild Android boot images (header v0–v4, including vendor boot)
- Full Magisk ramdisk injection: decompress → parse CPIO → inject binaries → repack → recompress
- Supports gzip and LZ4 ramdisk compression
- Android 15 16KB page size support (auto-detected, toggleable)
- dm-verity / AVB disable via empty vbmeta generation and cmdline patching
- Pre-flash image validation: header structure, page alignment, partition compatibility
- Smart partition auto-detection (boot vs init_boot vs vendor_boot)

### Fastboot Flashing
- WebUSB-based Fastboot protocol implementation
- Flash boot, init_boot, vendor_boot, and vbmeta partitions
- **Temporary boot** — test patched image without writing to flash
- Memory-optimized streaming transfer for large images
- Full device variable query (`getvar:all` with fallback to individual queries)
- A/B slot management: get current slot, switch to inactive slot
- Bootloader unlock/lock commands
- OEM device-specific commands
- Multiple reboot modes: normal, bootloader, recovery, fastbootd
- Device interrogation: complete snapshot of vars, battery, unlock state
- Partition queries: type, size, verification
- Battery charge check (Pixel-specific)
- Flash abort support
- Connection status badge (locked/unlocked indicator)

### Samsung Odin (WebOdin)
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
- Multiple reboot options (normal, continue boot)

### AI Assistant (Groq-Powered)
- Smart device detection and patching strategy recommendation
- Error diagnosis when flashing fails (13 local error patterns + Groq enhancement)
- Boot image analysis and compatibility checking
- Interactive chat with device-specific rooting knowledge
- **Offline knowledge base** — 9 brands with detailed rooting instructions:
  - Google Pixel, Samsung, OnePlus, Xiaomi, Motorola, Nothing, Sony, Fairphone, ASUS
  - Each includes unlock method, boot method, known issues, page size notes
- **Local device database** — 100+ codenames across 13 brands for instant identification
- Hybrid diagnosis: local pattern match (instant) → Groq enhancement → generic fallback
- Groq model: llama-3.3-70b-versatile (fast inference, structured JSON output)

### Device Database
- 100+ device codenames across 13 brands (Google, Samsung, OnePlus, Xiaomi, Motorola, Nothing, Sony, Fairphone, ASUS, Vivo, OPPO, Realme, HTC, ZTE, POCO)
- Partition metadata (boot, init_boot, vendor_boot, vbmeta, etc.)
- Android version mappings (12–15, including 16KB page size info)
- Boot header version specs (v0–v4, vendor boot)
- USB vendor ID lookup table

### PWA Features
- Installable on mobile and desktop
- Offline support via service worker caching
- No external dependencies (all code is local)
- COOP/COEP headers for SharedArrayBuffer support
- Mobile-first responsive design

## Architecture

```
webforge-patcher/
├── index.html              # PWA shell with 4 tabs (Patch, Flash, WebOdin, Log)
├── manifest.json           # PWA manifest
├── service-worker.js       # Offline caching
├── css/
│   └── style.css           # Mobile-first responsive styles
├── js/
│   ├── app.js             # Main controller (920 lines)
│   ├── boot-image.js      # Boot image parser/rebuilder v0-v4 (360 lines)
│   ├── ramdisk-patcher.js # CPIO + Magisk injection + fstab patching (520 lines)
│   ├── usb-bridge.js      # WebUSB Fastboot protocol (740 lines)
│   ├── odin.js            # Samsung Odin protocol (920 lines)
│   ├── ai-assistant.js    # Groq AI + offline knowledge base (730 lines)
│   ├── boot-validator.js  # Pre-flash validation (220 lines)
│   ├── vbmeta.js          # Empty vbmeta generator
│   ├── lz4.js             # LZ4 frame decompression
│   ├── md5.js             # RFC 1321 MD5 implementation
│   └── utils.js           # Shared utilities
├── data/
│   └── codes.json         # Device database (100+ codenames, 13 brands)
├── tests/
│   └── run-tests.mjs      # 60 integration tests
├── dev-server.mjs         # Local dev server with COOP/COEP
└── .github/workflows/
    └── deploy.yml          # GitHub Pages CI/CD
```

## Usage

### Patching a Boot Image
1. Open the PWA in Chrome/Edge on desktop
2. Go to the **Patch** tab
3. Load a `boot.img`, `init_boot.img`, or `vendor_boot.img` file
4. (Optional) Load a Magisk APK for root injection
5. Select patch mode (Magisk / KernelSU / Disable Verity)
6. Toggle 16KB page size if needed (auto-detected for Android 15)
7. Click **Patch**
8. Download the patched image or flash directly

### Flashing via Fastboot
1. Boot device into Fastboot mode (Volume Down + Power)
2. Go to the **Flash** tab
3. Click **Connect Fastboot** and select your device
4. The app auto-detects device info, boot method, and known issues
5. Click **Flash** to write the patched image
6. (Optional) Flash empty vbmeta to disable AVB verification
7. Reboot device

### Flashing via Odin (Samsung)
1. Boot Samsung into Download Mode (Volume Down + Bixby + Power)
2. Go to the **WebOdin** tab
3. Click **Connect Odin** and select your device
4. Load a `.tar.md5` firmware file
5. Click **Flash** to begin
6. MD5 verification and streaming flash with retry are automatic

### AI Assistant
1. Go to the **AI** tab
2. Enter your Groq API key (get one free at console.groq.com)
3. Connect a device — AI auto-analyzes and recommends a patching strategy
4. Ask questions in the chat about rooting, flashing, or troubleshooting
5. Errors are automatically diagnosed with suggested fixes

## Development

### Running locally
```bash
node dev-server.mjs
# Open http://localhost:8080
```

### Running tests
```bash
node tests/run-tests.mjs
```

### Deploying
Push to GitHub — the Actions workflow in `.github/workflows/deploy.yml` automatically deploys to GitHub Pages.

## Browser Requirements

- **Chrome 94+** or **Edge 94+** (WebUSB support required)
- Desktop recommended for USB operations
- Mobile works for viewing logs and AI chat
- `CompressionStream` / `DecompressionStream` support (Chrome 80+)

## Safety

- **Always backup your data** before flashing
- Bootloader unlock **wipes all data**
- Flashing incorrect images can **brick your device**
- Samsung rooting **voids Knox warranty permanently**
- Xiaomi requires a **7-day unlock wait period**
- The app validates images before flashing but cannot prevent all user errors

## License

MIT — Use at your own risk. The authors are not responsible for bricked devices.
