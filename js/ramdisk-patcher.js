// WebForge Patcher — Ramdisk Patcher (God Mode)
// Extracts, modifies, and repacks Android boot ramdisks entirely in-browser.
//
// Pipeline: boot.img → extract ramdisk → decompress (gzip/lz4) → parse CPIO (newc) →
//           inject Magisk files → repack CPIO → recompress → swap into boot.img
//
// CPIO newc format reference:
//   https://www.gnu.org/software/cpio/manual/html_node/ASCII.html
//   Each entry: 110-byte ASCII header, filename (padded), file data (padded)
//   Magic: "070701" (newc) or "070702" (newc with CRC)
//   Archive terminator: entry with name "TRAILER!!!"

import { Utils } from './utils.js';
import { LZ4 } from './lz4.js';

const CPIO_MAGIC = '070701';
const CPIO_MAGIC_CRC = '070702';
const CPIO_TRAILER = 'TRAILER!!!';
const CPIO_HEADER_SIZE = 110;

export class RamdiskPatcher {
  constructor() {
    this.entries = [];
    this.compression = 'gzip';
    this.format = 'newc';
  }

  // ============================================================
  // EXTRACTION & DECOMPRESSION
  // ============================================================

  static async fromBootImage(bootImage) {
    if (!bootImage.ramdisk) throw new Error('Boot image has no ramdisk');

    const ramdisk = bootImage.ramdisk;
    let cpioData;

    if (Utils.isGzip(ramdisk)) {
      Utils.log('Ramdisk: gzip compressed → decompressing...');
      cpioData = await RamdiskPatcher._gunzip(ramdisk);
      Utils.log(`Decompressed: ${(cpioData.byteLength / 1024).toFixed(0)} KB`);
    } else if (Utils.isLZ4(ramdisk)) {
      cpioData = await LZ4.decompress(ramdisk);
      Utils.log(`LZ4 decompressed: ${(cpioData.byteLength / 1024).toFixed(0)} KB`);
    } else {
      Utils.log('Ramdisk: uncompressed (raw CPIO)', 'debug');
      cpioData = ramdisk;
    }

    const patcher = new RamdiskPatcher();
    patcher.compression = Utils.isGzip(ramdisk) ? 'gzip' : Utils.isLZ4(ramdisk) ? 'lz4' : 'none';
    patcher.entries = RamdiskPatcher._parseCPIO(cpioData);

    Utils.log(`CPIO parsed: ${patcher.entries.length} entries`);
    return patcher;
  }

  static async _gunzip(data) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  static async _gzip(data) {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([data]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * Raw DEFLATE decompression for ZIP file entries.
   * Uses native DecompressionStream('deflate-raw') on Chrome 126+.
   * Falls back to pako.inflate() if available (for older browsers).
   */
  static async _inflateRaw(data) {
    // Try native deflate-raw first (Chrome 126+, no dependency)
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([data]).stream().pipeThrough(ds);
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) {
        // 'deflate-raw' not supported on this browser — fall through to pako
        Utils.log('deflate-raw not supported, trying pako fallback', 'debug');
      }
    }

    // Fallback: pako.js (load via CDN in index.html)
    if (typeof pako !== 'undefined' && pako.inflate) {
      return pako.inflate(data);
    }

    throw new Error(
      'DEFLATE decompression failed. Browser lacks deflate-raw support and pako.js is not loaded. ' +
      'Add pako via CDN: <script src="https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js"></script>'
    );
  }

  // ============================================================
  // CPIO PARSER (newc format)
  // ============================================================

  static _parseCPIO(data) {
    const buf = Utils.u8(data);
    const entries = [];
    let offset = 0;

    while (offset + CPIO_HEADER_SIZE <= buf.byteLength) {
      const magic = RamdiskPatcher._readHexStr(buf, offset, 6);
      if (magic !== CPIO_MAGIC && magic !== CPIO_MAGIC_CRC) break;

      const entry = {
        magic,
        ino:      parseInt(RamdiskPatcher._readHexStr(buf, offset + 6, 8), 16),
        mode:     parseInt(RamdiskPatcher._readHexStr(buf, offset + 14, 8), 16),
        uid:      parseInt(RamdiskPatcher._readHexStr(buf, offset + 22, 8), 16),
        gid:      parseInt(RamdiskPatcher._readHexStr(buf, offset + 30, 8), 16),
        nlink:    parseInt(RamdiskPatcher._readHexStr(buf, offset + 38, 8), 16),
        mtime:    parseInt(RamdiskPatcher._readHexStr(buf, offset + 46, 8), 16),
        filesize: parseInt(RamdiskPatcher._readHexStr(buf, offset + 54, 8), 16),
        devmajor: parseInt(RamdiskPatcher._readHexStr(buf, offset + 62, 8), 16),
        devminor: parseInt(RamdiskPatcher._readHexStr(buf, offset + 70, 8), 16),
        rdevmajor:parseInt(RamdiskPatcher._readHexStr(buf, offset + 78, 8), 16),
        rdevminor:parseInt(RamdiskPatcher._readHexStr(buf, offset + 86, 8), 16),
        namesize: parseInt(RamdiskPatcher._readHexStr(buf, offset + 94, 8), 16),
        check:    parseInt(RamdiskPatcher._readHexStr(buf, offset + 102, 8), 16),
      };

      entry.name = Utils.readString(buf.buffer, offset + CPIO_HEADER_SIZE, entry.namesize)
        .replace(/\0+$/, '');

      const namePadding = RamdiskPatcher._pad4(CPIO_HEADER_SIZE + entry.namesize);
      const dataOffset = offset + CPIO_HEADER_SIZE + entry.namesize + namePadding;
      entry.data = buf.slice(dataOffset, dataOffset + entry.filesize);
      const dataPadding = RamdiskPatcher._pad4(entry.filesize);
      offset = dataOffset + entry.filesize + dataPadding;

      if (entry.name === CPIO_TRAILER) break;
      entries.push(entry);
    }

    return entries;
  }

  static _readHexStr(buf, offset, length) {
    let str = '';
    for (let i = 0; i < length; i++) str += String.fromCharCode(buf[offset + i]);
    return str;
  }

  static _pad4(size) { return (4 - (size % 4)) % 4; }

  // ============================================================
  // CPIO BUILDER
  // ============================================================

  static _buildCPIO(entries) {
    const parts = [];

    for (const entry of entries) {
      const nameBytes = new TextEncoder().encode(entry.name + '\0');
      const nameSize = nameBytes.byteLength;
      const namePad = RamdiskPatcher._pad4(CPIO_HEADER_SIZE + nameSize);
      const dataPad = RamdiskPatcher._pad4(entry.filesize);

      parts.push(new Uint8Array(RamdiskPatcher._buildCPIOHeader(entry, nameSize)));
      parts.push(nameBytes);
      if (namePad > 0) parts.push(new Uint8Array(namePad));
      if (entry.filesize > 0 && entry.data) {
        // Use a buffer of exactly filesize bytes — ensures alignment matches header
        const dataBuf = new Uint8Array(entry.filesize);
        if (entry.data.byteLength >= entry.filesize) {
          dataBuf.set(entry.data.subarray(0, entry.filesize));
        } else {
          dataBuf.set(entry.data);
          // remaining bytes stay zero-padded
        }
        parts.push(dataBuf);
      }
      if (dataPad > 0) parts.push(new Uint8Array(dataPad));
    }

    // TRAILER
    const trailer = {
      magic: CPIO_MAGIC, ino: 0, mode: 0, uid: 0, gid: 0, nlink: 1,
      mtime: 0, filesize: 0, devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0,
      namesize: CPIO_TRAILER.length + 1, check: 0,
    };
    const trailerName = new TextEncoder().encode(CPIO_TRAILER + '\0');
    const trailerNamePad = RamdiskPatcher._pad4(CPIO_HEADER_SIZE + trailer.namesize);

    parts.push(new Uint8Array(RamdiskPatcher._buildCPIOHeader(trailer, trailer.namesize)));
    parts.push(trailerName);
    if (trailerNamePad > 0) parts.push(new Uint8Array(trailerNamePad));

    return Utils.concat(...parts);
  }

  static _buildCPIOHeader(entry, nameSize) {
    const header = new Uint8Array(CPIO_HEADER_SIZE);
    const fields = [
      [0, 6, entry.magic || CPIO_MAGIC, 6],
      [6, 8, entry.ino?.toString(16) || '0', 8],
      [14, 8, entry.mode?.toString(16) || '0', 8],
      [22, 8, entry.uid?.toString(16) || '0', 8],
      [30, 8, entry.gid?.toString(16) || '0', 8],
      [38, 8, entry.nlink?.toString(16) || '1', 8],
      [46, 8, entry.mtime?.toString(16) || '0', 8],
      [54, 8, entry.filesize?.toString(16) || '0', 8],
      [62, 8, entry.devmajor?.toString(16) || '0', 8],
      [70, 8, entry.devminor?.toString(16) || '0', 8],
      [78, 8, entry.rdevmajor?.toString(16) || '0', 8],
      [86, 8, entry.rdevminor?.toString(16) || '0', 8],
      [94, 8, nameSize.toString(16), 8],
      [102, 8, '0', 8],
    ];

    for (const [offset, , value, width] of fields) {
      const padded = value.padStart(width, '0').slice(-width);
      for (let i = 0; i < width; i++) header[offset + i] = padded.charCodeAt(i);
    }

    return header.buffer;
  }

  // ============================================================
  // FILE OPERATIONS
  // ============================================================

  find(name) { return this.entries.find(e => e.name === name); }

  list() {
    return this.entries.map(e => ({
      name: e.name, size: e.filesize,
      type: RamdiskPatcher._fileType(e.mode),
      mode: '0' + (e.mode & 0xFFF).toString(8),
    }));
  }

  static _fileType(mode) {
    const types = { 0x8:'file', 0x4:'dir', 0xA:'symlink', 0x2:'char', 0x6:'block', 0x1:'fifo', 0xC:'socket' };
    return types[(mode >> 12) & 0xF] || 'unknown';
  }

  addFile(path, data, mode = 0o100644) {
    const buf = Utils.u8(data);
    const existing = this.find(path);
    if (existing) {
      existing.data = buf;
      existing.filesize = buf.byteLength;
      existing.mode = mode;
      Utils.log(`Updated: ${path} (${buf.byteLength} bytes)`);
    } else {
      this.entries.push({
        magic: CPIO_MAGIC, ino: 300000 + this.entries.length,
        mode, uid: 0, gid: 0, nlink: 1, mtime: 0,
        filesize: buf.byteLength, devmajor: 0, devminor: 0,
        rdevmajor: 0, rdevminor: 0, name: path, data: buf, check: 0,
      });
      Utils.log(`Added: ${path} (${buf.byteLength} bytes)`);
    }
  }

  addDir(path, mode = 0o040755) {
    if (this.find(path)) return;
    this.entries.push({
      magic: CPIO_MAGIC, ino: 300000 + this.entries.length,
      mode, uid: 0, gid: 0, nlink: 2, mtime: 0, filesize: 0,
      devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0,
      name: path, data: new Uint8Array(0), check: 0,
    });
  }

  addSymlink(path, target, mode = 0o120777) {
    const targetBytes = new TextEncoder().encode(target);
    const existing = this.find(path);
    if (existing) {
      existing.data = targetBytes;
      existing.filesize = targetBytes.byteLength;
      existing.mode = mode;
    } else {
      this.entries.push({
        magic: CPIO_MAGIC, ino: 300000 + this.entries.length,
        mode, uid: 0, gid: 0, nlink: 1, mtime: 0,
        filesize: targetBytes.byteLength, devmajor: 0, devminor: 0,
        rdevmajor: 0, rdevminor: 0, name: path, data: targetBytes, check: 0,
      });
    }
    Utils.log(`Symlink: ${path} → ${target}`);
  }

  removeFile(path) {
    const idx = this.entries.findIndex(e => e.name === path);
    if (idx >= 0) { this.entries.splice(idx, 1); Utils.log(`Removed: ${path}`); return true; }
    return false;
  }

  // ============================================================
  // MAGISK INJECTION
  // ============================================================

  async injectMagisk(magiskFiles, options = {}) {
    const { keepVerity = false, keepEncrypted = false } = options;
    Utils.log('=== Magisk Injection (God Mode) ===');

    // 1. Backup original init
    const origInit = this.find('init');
    if (origInit) { this.addFile('init.bak', origInit.data, origInit.mode); Utils.log('Backed up init → init.bak'); }

    // 2. Magisk directories
    this.addDir('.magisk');
    this.addDir('.magisk/system');
    this.addDir('.magisk/system/bin');
    this.addDir('.magisk/system/lib');
    this.addDir('.magisk/system/lib64');
    this.addDir('.magisk/mirror');
    this.addDir('.magisk/block');
    this.addDir('.magisk/modules');

    // 3. Replace init with magiskinit
    if (magiskFiles.magiskinit) {
      this.addFile('init', magiskFiles.magiskinit, origInit ? origInit.mode : 0o100755);
      Utils.log('init replaced with magiskinit');
    } else throw new Error('magiskinit binary is required');

    // 4. Add Magisk binaries
    if (magiskFiles.magisk) this.addFile('.magisk/system/bin/magisk', magiskFiles.magisk, 0o100755);
    if (magiskFiles.magiskpolicy) this.addFile('.magisk/system/bin/magiskpolicy', magiskFiles.magiskpolicy, 0o100755);
    if (magiskFiles.magiskboot) this.addFile('.magisk/system/bin/magiskboot', magiskFiles.magiskboot, 0o100755);
    if (magiskFiles.busybox) this.addFile('.magisk/system/bin/busybox', magiskFiles.busybox, 0o100755);

    // 5. Config
    const config = { keep_verity: keepVerity, keep_encrypted: keepEncrypted, ramdisk_type: 'Magisk', version: 'WebForge', versionCode: 'webforge-1.0' };
    this.addFile('.magisk/config', new TextEncoder().encode(JSON.stringify(config)), 0o100600);

    // 6. Init service RC
    const magiskRc = `
on early-init
    write /proc/sys/kernel/printk 0
    start ueventd

on init
    export PATH /system/bin:/system/xbin:/vendor/bin:/sbin
    mkdir /.magisk 0755
    mkdir /.magisk/mirror 0755
    mkdir /.magisk/block 0755
    mkdir /.magisk/modules 0755

service magisk /system/bin/magisk --daemon
    user root
    seclabel u:r:magisk:s0
    oneshot

service magiskpolicy /system/bin/magiskpolicy --live --apply /.magisk/.sepolicy.rules
    user root
    seclabel u:r:magisk:s0
    oneshot
    disabled`;
    this.addFile('.magisk/init-magisk.rc', new TextEncoder().encode(magiskRc.trim()), 0o100644);

    // 7. Symlinks
    this.addSymlink('sbin/magisk', '../.magisk/system/bin/magisk');

    // 8. Patch init.rc if it exists
    const origRc = this.find('init.rc');
    if (origRc) {
      let rcContent = new TextDecoder().decode(origRc.data);
      if (!rcContent.includes('service magisk')) {
        rcContent += '\n' + magiskRc.trim() + '\n';
        this.addFile('init.rc', new TextEncoder().encode(rcContent), origRc.mode);
        Utils.log('Patched init.rc with Magisk service');
      }
    }

    Utils.log('=== Magisk injection complete ===');
  }

  // ============================================================
  // VERITY DISABLE
  // ============================================================

  patchFstab() {
    const fstabFiles = this.entries.filter(e => e.name.startsWith('fstab.'));
    if (fstabFiles.length === 0) { Utils.log('No fstab files found in ramdisk', 'warn'); return; }

    for (const fstab of fstabFiles) {
      let content = new TextDecoder().decode(fstab.data);
      content = content.replace(/verify_at_resume,/g, '');
      content = content.replace(/verify,/g, '');
      content = content.replace(/,verify/g, '');
      content = content.replace(/support_scfs/g, '');
      content = content.replace(/fs_verity/g, '');
      content = content.replace(/^(\s*\/dev\/\S+\s+\/\S+\s+\S+\s+.*verify.*)$/gm, '# $1  # Disabled by WebForge');
      content = content.replace(/verity=[^,\s]*/g, 'verity=off');
      this.addFile(fstab.name, new TextEncoder().encode(content), fstab.mode);
      Utils.log(`Patched ${fstab.name} (dm-verity disabled)`);
    }
  }

  // ============================================================
  // BUILD & COMPRESS
  // ============================================================

  async build() {
    Utils.log('Rebuilding ramdisk...');
    const cpioData = RamdiskPatcher._buildCPIO(this.entries);
    Utils.log(`CPIO rebuilt: ${cpioData.byteLength} bytes (${this.entries.length} entries)`);

    let compressed;
    if (this.compression === 'gzip') {
      compressed = await RamdiskPatcher._gzip(cpioData);
      Utils.log(`Gzip compressed: ${compressed.byteLength} bytes`);
    } else if (this.compression === 'lz4') {
      compressed = await LZ4.compress(cpioData);
      Utils.log(`LZ4 compressed: ${compressed.byteLength} bytes`);
    } else {
      compressed = cpioData;
    }

    return compressed;
  }

  static async patchBootImage(bootImage, magiskFiles, options = {}) {
    const patcher = await RamdiskPatcher.fromBootImage(bootImage);
    await patcher.injectMagisk(magiskFiles, options);
    patcher.patchFstab();
    const newRamdisk = await patcher.build();
    bootImage.setRamdisk(newRamdisk);
    if (bootImage.isVendorBoot) bootImage.patchVendorCmdline();
    else bootImage.patchCmdline();
    const result = bootImage.build();
    Utils.log(`Boot image rebuilt: ${(result.byteLength / 1024 / 1024).toFixed(2)} MB`);
    return result;
  }

  // ============================================================
  // MAGISK APK EXTRACTION
  // ============================================================

  static async extractFromAPK(apkData) {
    const buf = Utils.u8(apkData);
    Utils.log('Extracting Magisk binaries from APK...');

    const files = await RamdiskPatcher._parseZIP(buf);
    Utils.log(`APK contains ${files.length} files`);

    const magiskFiles = {};

    for (const file of files) {
      const name = file.name;
      if (name.includes('arm64-v8a/') || name.includes('armeabi-v7a/')) {
        const baseName = name.split('/').pop();
        if (['libmagiskinit.so', 'libmagisk.so', 'libmagiskpolicy.so', 'libmagiskboot.so'].includes(baseName)) {
          const key = baseName.replace(/^lib/, '').replace(/\.so$/, '');
          magiskFiles[key] = file.data;
          Utils.log(`Found: ${key} (${file.data.byteLength} bytes) from ${name}`);
        }
        if (baseName === 'libbusybox.so') {
          magiskFiles.busybox = file.data;
          Utils.log(`Found: busybox (${file.data.byteLength} bytes)`);
        }
      }
    }

    if (!magiskFiles.magiskinit) throw new Error('magiskinit not found in APK. Ensure this is a valid Magisk APK.');

    Utils.log(`Extracted ${Object.keys(magiskFiles).length} Magisk binaries`);
    return magiskFiles;
  }

  /**
   * Async ZIP parser — reads central directory, extracts & decompresses entries.
   * ZIP format: https://en.wikipedia.org/wiki/ZIP_(file_format)
   */
  static async _parseZIP(buf) {
    const files = [];
    const dv = new DataView(buf.buffer);

    // Find end of central directory record (EOCD)
    let eocdOffset = -1;
    for (let i = buf.byteLength - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error('Not a valid ZIP/APK file');

    const cdOffset = dv.getUint32(eocdOffset + 16, true);
    const cdEntries = dv.getUint16(eocdOffset + 10, true);

    let offset = cdOffset;
    for (let i = 0; i < cdEntries; i++) {
      if (dv.getUint32(offset, true) !== 0x02014b50) break;

      const compMethod = dv.getUint16(offset + 10, true);
      const compSize = dv.getUint32(offset + 20, true);
      const uncompSize = dv.getUint32(offset + 24, true);
      const nameLen = dv.getUint16(offset + 28, true);
      const extraLen = dv.getUint16(offset + 30, true);
      const commentLen = dv.getUint16(offset + 32, true);
      const localHeaderOffset = dv.getUint32(offset + 42, true);

      const name = Utils.readString(buf.buffer, offset + 46, nameLen);

      const localExtraLen = dv.getUint16(localHeaderOffset + 28, true);
      const localNameLen = dv.getUint16(localHeaderOffset + 26, true);
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

      let data;
      if (compMethod === 0) {
        // Stored (no compression)
        data = buf.slice(dataOffset, dataOffset + uncompSize);
      } else if (compMethod === 8) {
        // DEFLATE (raw) — async decompression
        const compressed = buf.slice(dataOffset, dataOffset + compSize);
        data = await RamdiskPatcher._inflateRaw(compressed);
      } else {
        Utils.log(`Unsupported compression (${compMethod}) for ${name}`, 'warn');
        offset += 46 + nameLen + extraLen + commentLen;
        continue;
      }

      files.push({ name, data, compMethod, uncompSize });
      offset += 46 + nameLen + extraLen + commentLen;
    }

    return files;
  }
}
