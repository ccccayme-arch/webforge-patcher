# Flashing Guide: Moto G Play (2023) — Codename `rhodep`

## Device Specs

| Field | Value |
|---|---|
| Codename | rhodep |
| Model | XT2271-5 |
| Chipset | MediaTek Helio G37 (MT6765) |
| OS | Android 12 |
| RAM | 3GB |
| Storage | 32GB |
| Partition | `boot` (not `init_boot`) |
| Page size | 4KB |
| USB Vendor ID | 0x22B8 |
| Architecture | ARM64 |

## ⚠️ Carrier Compatibility Check

If your G Play is a **Tracfone, Verizon, or AT&T prepaid** variant, the "OEM Unlocking" toggle in Developer Options will be greyed out and Motorola's website will reject your device ID. Retail/factory-unlocked models are fine.

Check: Settings → Developer Options → OEM Unlocking. If greyed out, you likely have a carrier-locked variant.

---

## Phase 1: Request Bootloader Unlock Key (free, 24-48hr wait)

1. Settings → About → tap **Build Number** 7× to enable Developer Options
2. Developer Options → enable **OEM Unlocking** + **USB Debugging**
3. Power off, hold **Volume Down + Power** → boot to Fastboot mode
4. On your computer, run: `fastboot oem get_unlock_data`
5. Copy the full device ID string it outputs
6. Go to https://en-us.support.motorola.com/app/standalone/bootloader/unlock-your-device-a
7. Create a free Motorola account, paste the device ID, submit
8. Wait 24-48 hours for the unlock key email

## Phase 2: Unlock the Bootloader

9. Boot to Fastboot mode again (Vol Down + Power)
10. Run: `fastboot oem unlock YOUR_KEY_HERE`
11. Phone wipes and reboots — this is expected

## Phase 3: Get Your boot.img

### Option A: From Stock Firmware
12. Download your exact firmware from Motorola's support site (match your XT model number)
13. The firmware comes as a `.zip` — inside you'll find `boot.img` (may be inside a `.bin` or sparse image; extract it)

### Option B: Dump via mtkclient (MediaTek-specific)
14. If you can temporarily use mtkclient (MediaTek bootrom exploit tool), you can dump `boot.img` directly:
    `dd if=/dev/block/by-name/boot of=/sdcard/boot.img`

## Phase 4: Patch with WebForge (on desktop Chrome)

15. Open https://ccccayme.github.io/webforge-patcher/ in Chrome
16. Go to the **Patch** tab
17. Load your `boot.img`
18. Load a Magisk APK (download from https://github.com/topjohnwu/Magisk/releases)
19. Select **boot** as the target partition (the app should auto-detect this for rhodep)
20. Click **Patch** — the app injects Magisk into the ramdisk via CPIO round-trip
21. Download the patched `boot.img`

## Phase 5: Flash (on desktop Chrome with WebUSB)

22. Boot phone to Fastboot mode, connect via USB
23. In WebForge, go to the **Flash** tab
24. Click **Connect Device** — Chrome will prompt for USB permission (vendor 0x22B8)
25. Select **boot** partition
26. Load your patched `boot.img`
27. Click **Flash** — WebForge streams it via WebUSB Fastboot
28. Once done, reboot: `fastboot reboot`

## Phase 6: Verify Root

29. Phone boots up — open Magisk app
30. It should show as installed with the version number
31. Done — you're rooted!

---

## rhodep-Specific Gotchas

- **MediaTek A/B partitions**: If on A/B slots, flash to both: `fastboot --slot=other flash boot patched_boot.img`
- **Bootloop recovery**: If the phone bootloops after flashing, boot to Fastboot and flash the **stock** (unpatched) `boot.img` to recover
- **RAM limitation**: G Play has only 3GB RAM — avoid heavy Magisk modules
- **MediaTek ramdisk format**: Usually fine with standard gzip, but keep an eye out for unusual compression formats in the ramdisk
- **Firmware matching**: Make sure the firmware version matches your current OS version exactly — mismatched boot.img will cause bootloops
