// WebForge Patcher — Android Boot Image Parser & Repacker
// Supports boot image header v0–v4, including Android 15 16KB page size.
//
// Key design: page size is read from the header, NEVER hardcoded to 4096.
// Android 15 devices may use 16384 (16KB) page alignment.

import { Utils } from './utils.js';

const BOOT_MAGIC = 'ANDROID!';
const BOOT_MAGIC_SIZE = 8;
const VENDOR_BOOT_MAGIC = 'VNDRBOOT';

const HEADER_V0_SIZE = 1632;
const HEADER_V1_SIZE = 1632 + 4 * 4;
const HEADER_V2_SIZE = 1632 + 4 * 4 + 4 * 8;
const HEADER_V3_SIZE = 1580;
const HEADER_V4_SIZE = 1580 + 4;

export class BootImage {
  constructor() {
    this.version = -1;
    this.pageSize = 4096;
    this.kernel = null;
    this.ramdisk = null;
    this.second = null;
    this.dtb = null;
    this.recoveryDtbo = null;
    this.bootSig = null;
    this.header = {};
    this.isVendorBoot = false;
    this.rawData = null;
    this._patchedData = null;
  }

  static parse(data) {
    const buf = Utils.u8(data);
    if (buf.byteLength < BOOT_MAGIC_SIZE) {
      throw new Error('File too small to be a boot image');
    }
    const magic = Utils.readString(buf.buffer, 0, BOOT_MAGIC_SIZE);
    if (magic.startsWith(VENDOR_BOOT_MAGIC)) return BootImage._parseVendorBoot(buf);
    if (magic.startsWith(BOOT_MAGIC)) return BootImage._parseBoot(buf);
    throw new Error(`Unknown boot image magic: "${magic.trim()}"`);
  }

  static _parseBoot(buf) {
    const img = new BootImage();
    img.rawData = buf;
    // Detect header version.
    // v0: no explicit version field (default)
    // v1/v2: header_version at offset 1636
    // v3/v4: header_version at offset 8
    // offset 40 is os_version for v0-v2, NOT the version
    let version = 0;
    if (buf.byteLength > 1640) {
      const v1636 = Utils.readU32LE(buf.buffer, 1636);
      if (v1636 === 1 || v1636 === 2) version = v1636;
    }
    if (version === 0) {
      const v8 = Utils.readU32LE(buf.buffer, 8);
      if (v8 === 3 || v8 === 4) version = v8;
    }
    img.version = version;
    Utils.log(`Detected boot image header v${version}`);
    switch (version) {
      case 0: return BootImage._parseV0(img, buf);
      case 1: return BootImage._parseV1(img, buf);
      case 2: return BootImage._parseV2(img, buf);
      case 3: return BootImage._parseV3(img, buf);
      case 4: return BootImage._parseV4(img, buf);
      default:
        Utils.log(`Unknown boot version ${version}, attempting v3 parse`, 'warn');
        img.version = 3;
        return BootImage._parseV3(img, buf);
    }
  }

  static _parseV0(img, buf) {
    const dv = buf.buffer;
    img.pageSize = Utils.readU32LE(dv, 36);
    if (!img.pageSize || img.pageSize < 512) { img.pageSize = 4096; Utils.log('Page size invalid, defaulting to 4096', 'warn'); }
    img.header = {
      magic: Utils.readString(dv, 0, 8),
      kernelSize: Utils.readU32LE(dv, 8),
      ramdiskSize: Utils.readU32LE(dv, 20),
      secondSize: Utils.readU32LE(dv, 28),
      pageSize: img.pageSize,
      osVersion: Utils.readU32LE(dv, 44),
      name: Utils.readString(dv, 48, 16),
      cmdline: Utils.readString(dv, 64, 512),
      extraCmdline: Utils.readString(dv, 592, 1024),
    };
    let offset = Utils.alignUp(HEADER_V0_SIZE, img.pageSize);
    img.kernel = buf.slice(offset, offset + img.header.kernelSize);
    offset += Utils.alignUp(img.header.kernelSize, img.pageSize);
    img.ramdisk = buf.slice(offset, offset + img.header.ramdiskSize);
    offset += Utils.alignUp(img.header.ramdiskSize, img.pageSize);
    if (img.header.secondSize > 0) {
      img.second = buf.slice(offset, offset + img.header.secondSize);
      offset += Utils.alignUp(img.header.secondSize, img.pageSize);
    }
    const remaining = buf.byteLength - offset;
    if (remaining > img.pageSize) { img.dtb = buf.slice(offset); img.header.dtSize = img.dtb.byteLength; }
    Utils.log(`v0: ps=${img.pageSize}, kernel=${img.header.kernelSize}, ramdisk=${img.header.ramdiskSize}`);
    return img;
  }

  static _parseV1(img, buf) {
    const dv = buf.buffer;
    img.pageSize = Utils.readU32LE(dv, 36);
    if (!img.pageSize || img.pageSize < 512) img.pageSize = 4096;
    img.header = {
      magic: Utils.readString(dv, 0, 8),
      kernelSize: Utils.readU32LE(dv, 8),
      ramdiskSize: Utils.readU32LE(dv, 20),
      secondSize: Utils.readU32LE(dv, 28),
      pageSize: img.pageSize,
      osVersion: Utils.readU32LE(dv, 44),
      name: Utils.readString(dv, 48, 16),
      cmdline: Utils.readString(dv, 64, 512),
      extraCmdline: Utils.readString(dv, 592, 1024),
      recoveryDtboSize: Utils.readU32LE(dv, 1632),
      headerVersion: Utils.readU32LE(dv, 1636),
    };
    let offset = Utils.alignUp(HEADER_V1_SIZE, img.pageSize);
    img.kernel = buf.slice(offset, offset + img.header.kernelSize);
    offset += Utils.alignUp(img.header.kernelSize, img.pageSize);
    img.ramdisk = buf.slice(offset, offset + img.header.ramdiskSize);
    offset += Utils.alignUp(img.header.ramdiskSize, img.pageSize);
    if (img.header.secondSize > 0) { img.second = buf.slice(offset, offset + img.header.secondSize); offset += Utils.alignUp(img.header.secondSize, img.pageSize); }
    if (img.header.recoveryDtboSize > 0) { img.recoveryDtbo = buf.slice(offset, offset + img.header.recoveryDtboSize); offset += Utils.alignUp(img.header.recoveryDtboSize, img.pageSize); }
    const dtSize = Utils.readU32LE(dv, 40);
    if (dtSize > 0) { img.dtb = buf.slice(offset, offset + dtSize); img.header.dtSize = dtSize; }
    Utils.log(`v1: ps=${img.pageSize}, kernel=${img.header.kernelSize}, ramdisk=${img.header.ramdiskSize}, recoveryDtbo=${img.header.recoveryDtboSize}`);
    return img;
  }

  static _parseV2(img, buf) {
    img = BootImage._parseV1(img, buf);
    const dtbSize = Utils.readU32LE(buf.buffer, 1648);
    if (dtbSize > 0) {
      let offset = Utils.alignUp(HEADER_V2_SIZE, img.pageSize);
      offset += Utils.alignUp(img.header.kernelSize, img.pageSize);
      offset += Utils.alignUp(img.header.ramdiskSize, img.pageSize);
      if (img.header.secondSize > 0) offset += Utils.alignUp(img.header.secondSize, img.pageSize);
      if (img.header.recoveryDtboSize > 0) offset += Utils.alignUp(img.header.recoveryDtboSize, img.pageSize);
      img.dtb = buf.slice(offset, offset + dtbSize);
      img.header.dtSize = dtbSize;
    }
    return img;
  }

  static _parseV3(img, buf) {
    const dv = buf.buffer;
    img.pageSize = 4096; // v3 always 4096; Android 15 overrides via setPageSize()
    img.header = {
      magic: Utils.readString(dv, 0, 8),
      headerVersion: Utils.readU32LE(dv, 8),
      ramdiskSize: Utils.readU32LE(dv, 12),
      osVersion: Utils.readU32LE(dv, 16),
      kernelSize: Utils.readU32LE(dv, 24),
      cmdline: Utils.readString(dv, 32, 1536),
    };
    let offset = Utils.alignUp(HEADER_V3_SIZE, img.pageSize);
    img.kernel = buf.slice(offset, offset + img.header.kernelSize);
    offset += Utils.alignUp(img.header.kernelSize, img.pageSize);
    img.ramdisk = buf.slice(offset, offset + img.header.ramdiskSize);
    Utils.log(`v3: ps=${img.pageSize}, kernel=${img.header.kernelSize}, ramdisk=${img.header.ramdiskSize}`);
    return img;
  }

  static _parseV4(img, buf) {
    img = BootImage._parseV3(img, buf);
    img.header.bootSigSize = Utils.readU32LE(buf.buffer, HEADER_V3_SIZE);
    let offset = Utils.alignUp(HEADER_V4_SIZE, img.pageSize);
    offset += Utils.alignUp(img.header.kernelSize, img.pageSize);
    offset += Utils.alignUp(img.header.ramdiskSize, img.pageSize);
    if (img.header.bootSigSize > 0) img.bootSig = buf.slice(offset, offset + img.header.bootSigSize);
    Utils.log(`v4: bootSig=${img.header.bootSigSize || 0}`);
    return img;
  }

  static _parseVendorBoot(buf) {
    const img = new BootImage();
    img.rawData = buf;
    img.isVendorBoot = true;
    const version = Utils.readU32LE(buf.buffer, 8);
    img.version = version;
    const dv = buf.buffer;
    img.pageSize = Utils.readU32LE(dv, 12) || 4096;
    img.header = {
      magic: Utils.readString(dv, 0, 8),
      headerVersion: version,
      pageSize: img.pageSize,
      kernelAddr: Utils.readU32LE(dv, 16),
      ramdiskSize: Utils.readU32LE(dv, 20),
      vendorCmdline: Utils.readString(dv, 24, 512),
      tagsAddr: Utils.readU32LE(dv, 536),
      name: Utils.readString(dv, 540, 16),
      headerSize: Utils.readU32LE(dv, 556),
      dtbSize: Utils.readU32LE(dv, 560),
    };
    let offset = Utils.alignUp(img.header.headerSize, img.pageSize);
    img.ramdisk = buf.slice(offset, offset + img.header.ramdiskSize);
    offset += Utils.alignUp(img.header.ramdiskSize, img.pageSize);
    if (img.header.dtbSize > 0) { img.dtb = buf.slice(offset, offset + img.header.dtbSize); }
    Utils.log(`vendor_boot v${version}: ps=${img.pageSize}, ramdisk=${img.header.ramdiskSize}, dtb=${img.header.dtbSize}`);
    return img;
  }

  // === REPACKING ===

  build() {
    if (this.isVendorBoot) return this._buildVendorBoot();
    switch (this.version) {
      case 0: return this._buildV0();
      case 1: return this._buildV1();
      case 2: return this._buildV2();
      case 3: return this._buildV3();
      case 4: return this._buildV4();
      default: this.version = 3; return this._buildV3();
    }
  }

  _buildV0() {
    const ps = this.pageSize;
    const headerBuf = new ArrayBuffer(HEADER_V0_SIZE);
    this._writeCommonHeaderV0(headerBuf);
    Utils.writeU32LE(headerBuf, 40, 0);
    Utils.writeU32LE(headerBuf, 8, this.kernel.byteLength);
    Utils.writeU32LE(headerBuf, 20, this.ramdisk.byteLength);
    Utils.writeU32LE(headerBuf, 28, this.second ? this.second.byteLength : 0);
    const parts = [Utils.padTo(new Uint8Array(headerBuf), ps), Utils.padTo(this.kernel, ps), Utils.padTo(this.ramdisk, ps)];
    if (this.second && this.second.byteLength > 0) parts.push(Utils.padTo(this.second, ps));
    if (this.dtb && this.dtb.byteLength > 0) parts.push(Utils.padTo(this.dtb, ps));
    return Utils.concat(...parts);
  }

  _buildV1() {
    const ps = this.pageSize;
    const headerBuf = new ArrayBuffer(HEADER_V1_SIZE);
    this._writeCommonHeaderV0(headerBuf);
    // offset 40 is os_version, not dt_size — don't overwrite
    Utils.writeU32LE(headerBuf, 1632, this.recoveryDtbo ? this.recoveryDtbo.byteLength : 0);
    Utils.writeU32LE(headerBuf, 1636, 1);
    Utils.writeU32LE(headerBuf, 8, this.kernel.byteLength);
    Utils.writeU32LE(headerBuf, 20, this.ramdisk.byteLength);
    Utils.writeU32LE(headerBuf, 28, this.second ? this.second.byteLength : 0);
    const parts = [Utils.padTo(new Uint8Array(headerBuf), ps), Utils.padTo(this.kernel, ps), Utils.padTo(this.ramdisk, ps)];
    if (this.second && this.second.byteLength > 0) parts.push(Utils.padTo(this.second, ps));
    if (this.recoveryDtbo && this.recoveryDtbo.byteLength > 0) parts.push(Utils.padTo(this.recoveryDtbo, ps));
    if (this.dtb && this.dtb.byteLength > 0) parts.push(Utils.padTo(this.dtb, ps));
    return Utils.concat(...parts);
  }

  _buildV2() {
    const result = this._buildV1();
    Utils.writeU32LE(result.buffer, 1636, 2);  // Override v1 with v2
    Utils.writeU32LE(result.buffer, 1648, this.dtb ? this.dtb.byteLength : 0);
    return result;
  }

  _buildV3() {
    const ps = this.pageSize;
    const headerBuf = new ArrayBuffer(HEADER_V3_SIZE);
    Utils.writeString(headerBuf, 0, BOOT_MAGIC, BOOT_MAGIC_SIZE);
    Utils.writeU32LE(headerBuf, 8, 3);
    Utils.writeU32LE(headerBuf, 12, this.ramdisk.byteLength);
    Utils.writeU32LE(headerBuf, 24, this.kernel.byteLength);
    Utils.writeString(headerBuf, 32, this.header.cmdline || '', 1536);
    const parts = [Utils.padTo(new Uint8Array(headerBuf), ps), Utils.padTo(this.kernel, ps), Utils.padTo(this.ramdisk, ps)];
    return Utils.concat(...parts);
  }

  _buildV4() {
    const ps = this.pageSize;
    const headerBuf = new ArrayBuffer(HEADER_V4_SIZE);
    Utils.writeString(headerBuf, 0, BOOT_MAGIC, BOOT_MAGIC_SIZE);
    Utils.writeU32LE(headerBuf, 8, 4);
    Utils.writeU32LE(headerBuf, 12, this.ramdisk.byteLength);
    Utils.writeU32LE(headerBuf, 24, this.kernel.byteLength);
    Utils.writeString(headerBuf, 32, this.header.cmdline || '', 1536);
    Utils.writeU32LE(headerBuf, HEADER_V3_SIZE, this.bootSig ? this.bootSig.byteLength : 0);
    const parts = [Utils.padTo(new Uint8Array(headerBuf), ps), Utils.padTo(this.kernel, ps), Utils.padTo(this.ramdisk, ps)];
    if (this.bootSig && this.bootSig.byteLength > 0) parts.push(Utils.padTo(this.bootSig, ps));
    return Utils.concat(...parts);
  }

  _writeCommonHeaderV0(headerBuf) {
    Utils.writeString(headerBuf, 0, BOOT_MAGIC, BOOT_MAGIC_SIZE);
    Utils.writeU32LE(headerBuf, 36, this.pageSize);
    Utils.writeU32LE(headerBuf, 40, this.version);
    Utils.writeString(headerBuf, 48, this.header.name || '', 16);
    Utils.writeString(headerBuf, 64, this.header.cmdline || '', 512);
    Utils.writeString(headerBuf, 592, this.header.extraCmdline || '', 1024);
  }

  _buildVendorBoot() {
    const ps = this.pageSize;
    const headerSize = this.header.headerSize || 1580;
    const headerBuf = new ArrayBuffer(headerSize);
    Utils.writeString(headerBuf, 0, VENDOR_BOOT_MAGIC, 8);
    Utils.writeU32LE(headerBuf, 8, this.version);
    Utils.writeU32LE(headerBuf, 12, ps);
    Utils.writeU32LE(headerBuf, 20, this.ramdisk.byteLength);
    Utils.writeString(headerBuf, 24, this.header.vendorCmdline || '', 512);
    Utils.writeString(headerBuf, 540, this.header.name || '', 16);
    Utils.writeU32LE(headerBuf, 556, headerSize);
    Utils.writeU32LE(headerBuf, 560, this.dtb ? this.dtb.byteLength : 0);
    const parts = [Utils.padTo(new Uint8Array(headerBuf), ps), Utils.padTo(this.ramdisk, ps)];
    if (this.dtb && this.dtb.byteLength > 0) parts.push(Utils.padTo(this.dtb, ps));
    return Utils.concat(...parts);
  }

  // === PATCHING ===

  setPageSize(ps) {
    if (![4096, 8192, 16384].includes(ps)) throw new Error(`Unsupported page size: ${ps}`);
    this.pageSize = ps;
    Utils.log(`Page size set to ${ps}`);
  }

  setRamdisk(newRamdisk) {
    this.ramdisk = Utils.u8(newRamdisk);
    Utils.log(`Ramdisk replaced (${this.ramdisk.byteLength} bytes)`);
  }

  patchCmdline(append) {
    const verityOff = 'androidboot.veritymode=disabled androidboot.vbmeta.device_state=unlocked androidboot.enable_dm_verity=0';
    let newCmd = (this.header.cmdline || '').trim();
    if (!newCmd.includes('veritymode=disabled')) newCmd += ' ' + verityOff;
    if (append) newCmd += ' ' + append;
    this.header.cmdline = newCmd.replace(/\s+/g, ' ').trim();
    Utils.log(`Cmdline patched`);
  }

  patchVendorCmdline(append) {
    const verityOff = 'androidboot.veritymode=disabled';
    let newCmd = (this.header.vendorCmdline || '').trim();
    if (!newCmd.includes('veritymode=disabled')) newCmd += ' ' + verityOff;
    if (append) newCmd += ' ' + append;
    this.header.vendorCmdline = newCmd.replace(/\s+/g, ' ').trim();
    Utils.log(`Vendor cmdline patched`);
  }

  summary() {
    return {
      version: this.version,
      isVendorBoot: this.isVendorBoot,
      pageSize: this.pageSize,
      kernelSize: this.kernel ? this.kernel.byteLength : 0,
      ramdiskSize: this.ramdisk ? this.ramdisk.byteLength : 0,
      secondSize: this.second ? this.second.byteLength : 0,
      dtbSize: this.dtb ? this.dtb.byteLength : 0,
      bootSigSize: this.bootSig ? this.bootSig.byteLength : 0,
      cmdline: (this.header.cmdline || this.header.vendorCmdline || '').substring(0, 100),
      ramdiskFormat: this.ramdisk ? (Utils.isGzip(this.ramdisk) ? 'gzip' : Utils.isLZ4(this.ramdisk) ? 'lz4' : 'raw') : 'none',
    };
  }
}
