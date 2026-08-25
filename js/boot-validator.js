// WebForge Patcher — Boot Image Validator
// Pre-flash validation: checks boot image structure, header fields,
// page alignment, and flags potential issues before flashing.
// Prevents bricking from corrupted or incompatible images.

import { Utils } from './utils.js';

const ANDROID_MAGIC = 'ANDROID!';
const VENDOR_MAGIC = 'VNDRBOOT';

export class BootValidator {
  /**
   * Validate a boot image before flashing.
   * Returns { valid, warnings, errors, info }.
   */
  static validate(data) {
    const buf = Utils.u8(data);
    const result = { valid: true, warnings: [], errors: [], info: {} };

    if (buf.byteLength < 4096) {
      result.errors.push('Image too small (< 4KB). Not a valid boot image.');
      result.valid = false;
      return result;
    }

    // Detect image type
    const magic = new TextDecoder().decode(buf.slice(0, 8)).replace(/\0+$/, '');

    if (magic === ANDROID_MAGIC) {
      return BootValidator._validateStandardBoot(buf, result);
    } else if (magic === VENDOR_MAGIC) {
      return BootValidator._validateVendorBoot(buf, result);
    } else {
      result.errors.push(`Unknown magic: "${magic}". Expected "ANDROID!" or "VNDRBOOT".`);
      result.valid = false;
      return result;
    }
  }

  static _validateStandardBoot(buf, result) {
    const dv = new DataView(buf.buffer, buf.byteOffset);

    // Read header version (offset 40, u32)
    const headerVersion = dv.getUint32(40, true);
    result.info.headerVersion = headerVersion;

    if (headerVersion > 4) {
      result.warnings.push(`Unknown boot header version ${headerVersion}. Parser may not handle it correctly.`);
    }

    // Read kernel size (offset 8, u32)
    const kernelSize = dv.getUint32(8, true);
    result.info.kernelSize = kernelSize;
    if (kernelSize === 0) {
      result.warnings.push('Kernel size is 0 — image may be incomplete or a placeholder.');
    }
    if (kernelSize > 64 * 1024 * 1024) {
      result.warnings.push(`Kernel is ${(kernelSize / 1024 / 1024).toFixed(1)} MB — unusually large.`);
    }

    // Read ramdisk size (offset 12, u32)
    const ramdiskSize = dv.getUint32(12, true);
    result.info.ramdiskSize = ramdiskSize;
    if (ramdiskSize === 0 && headerVersion < 3) {
      result.warnings.push('No ramdisk in boot image. Some devices require a ramdisk for boot.');
    }

    // Read second stage size (offset 16, u32) — v0-v2 only
    if (headerVersion <= 2) {
      const secondSize = dv.getUint32(16, true);
      result.info.secondSize = secondSize;
    }

    // Read page size (offset 36, u32) — v0-v2 only
    if (headerVersion <= 2) {
      const pageSize = dv.getUint32(36, true);
      result.info.pageSize = pageSize;
      if (pageSize !== 4096 && pageSize !== 2048 && pageSize !== 8192 && pageSize !== 16384) {
        result.warnings.push(`Non-standard page size: ${pageSize}. Expected 2048/4096/8192/16384.`);
      }
      if (pageSize === 16384) {
        result.info.android15 = true;
        result.warnings.push('16KB page size detected (Android 15). Ensure your device supports this.');
      }
    } else {
      result.info.pageSize = 4096; // v3+ always uses 4096
    }

    const pageSize = result.info.pageSize;

    // Verify image structure alignment
    const headerEnd = (headerVersion <= 2) ? 1632 : (headerVersion === 3 ? 1580 : 1584);
    let offset = Math.ceil(headerEnd / pageSize) * pageSize;

    // After header: kernel, ramdisk, second stage (if v0-v2), dtbo (if v1-v2), dtb (v2+)
    if (kernelSize > 0) {
      offset += Math.ceil(kernelSize / pageSize) * pageSize;
    }
    if (ramdiskSize > 0) {
      offset += Math.ceil(ramdiskSize / pageSize) * pageSize;
    }
    if (result.info.secondSize > 0) {
      offset += Math.ceil(result.info.secondSize / pageSize) * pageSize;
    }

    result.info.calculatedImageSize = offset;
    result.info.actualImageSize = buf.byteLength;

    // Check if image size is reasonable
    if (buf.byteLength > 256 * 1024 * 1024) {
      result.warnings.push(`Image is ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB — very large for a boot image.`);
    }

    // Check for recovery_dtbo (v1-v2)
    if (headerVersion === 1 || headerVersion === 2) {
      const recoveryDtboSize = dv.getUint32(1632, true);
      result.info.recoveryDtboSize = recoveryDtboSize;
    }

    // Check for dtb (v2)
    if (headerVersion === 2) {
      const dtbSize = dv.getUint32(1660 - 8, true); // offset 1652
      result.info.dtbSize = dtbSize;
    }

    // Check OS version / patch level (v3+)
    if (headerVersion >= 3) {
      const osVersion = dv.getUint32(8, true); // offset 8 in v3+
      const patchLevel = dv.getUint32(12, true); // offset 12 in v3+
      result.info.osVersion = osVersion;
      result.info.patchLevel = patchLevel;
    }

    // RAM integrity: check that the image isn't all zeros after header
    const afterHeader = buf.slice(headerEnd, Math.min(headerEnd + 1024, buf.byteLength));
    if (afterHeader.every(b => b === 0)) {
      result.warnings.push('Data after header is all zeros. Image may be corrupted or empty.');
    }

    result.info.type = 'boot';
    return result;
  }

  static _validateVendorBoot(buf, result) {
    const dv = new DataView(buf.buffer, buf.byteOffset);

    // Vendor boot header v4
    const headerVersion = dv.getUint32(8 + 8, true); // offset after magic
    result.info.headerVersion = headerVersion;
    result.info.type = 'vendor_boot';

    // Page size (offset 40, u32)
    const pageSize = dv.getUint32(40, true);
    result.info.pageSize = pageSize;

    if (pageSize !== 4096 && pageSize !== 8192 && pageSize !== 16384) {
      result.warnings.push(`Vendor boot page size: ${pageSize}. Expected 4096/8192/16384.`);
    }
    if (pageSize === 16384) {
      result.info.android15 = true;
    }

    // Kernel size (offset 44, u32)
    const kernelSize = dv.getUint32(44, true);
    result.info.kernelSize = kernelSize;

    // Ramdisk size (offset 52, u32)
    const ramdiskSize = dv.getUint32(52, true);
    result.info.ramdiskSize = ramdiskSize;

    // Vendor ramdisk size
    result.info.vendorRamdiskSize = ramdiskSize;

    if (ramdiskSize > 128 * 1024 * 1024) {
      result.warnings.push(`Vendor ramdisk is ${(ramdiskSize / 1024 / 1024).toFixed(1)} MB — large.`);
    }

    // Check for boot args
    const cmdLine = new TextDecoder().decode(buf.slice(64, 64 + 512)).replace(/\0+$/, '');
    result.info.cmdline = cmdLine.substring(0, 100) + (cmdLine.length > 100 ? '...' : '');

    return result;
  }

  /**
   * Check if an image is safe to flash to a specific partition.
   * Returns { safe, reason }.
   */
  static checkPartitionCompatibility(imageInfo, partitionName) {
    if (imageInfo.type === 'vendor_boot' && partitionName !== 'vendor_boot') {
      return { safe: false, reason: 'Vendor boot image cannot be flashed to non-vendor_boot partition.' };
    }
    if (imageInfo.type === 'boot' && partitionName === 'vendor_boot') {
      return { safe: false, reason: 'Standard boot image cannot be flashed to vendor_boot partition.' };
    }
    if (imageInfo.android15 && partitionName === 'init_boot') {
      // Android 15 init_boot with 16KB pages — this is expected
      return { safe: true, reason: 'Android 15 16KB init_boot detected.' };
    }
    return { safe: true, reason: 'OK' };
  }

  /**
   * Generate a human-readable summary of the validation.
   */
  static summarize(result) {
    if (!result.valid) {
      return `❌ INVALID: ${result.errors.join('; ')}`;
    }
    const parts = [];
    parts.push(`Type: ${result.info.type || 'unknown'}`);
    parts.push(`Header: v${result.info.headerVersion ?? '?'}`);
    parts.push(`Page: ${(result.info.pageSize / 1024).toFixed(0)}KB`);
    if (result.info.kernelSize) parts.push(`Kernel: ${(result.info.kernelSize / 1024 / 1024).toFixed(1)}MB`);
    if (result.info.ramdiskSize) parts.push(`Ramdisk: ${(result.info.ramdiskSize / 1024 / 1024).toFixed(1)}MB`);
    let summary = `✅ ${parts.join(' · ')}`;
    if (result.warnings.length > 0) {
      summary += `\n⚠️ ${result.warnings.length} warning(s)`;
    }
    return summary;
  }
}
