// WebForge Patcher — Samsung Odin Protocol (Heimdall/WebUSB)
// Full implementation of the Odin download protocol via WebUSB.
//
// Odin command reference (reverse-engineered from Heimdall/libmjolnir/Heimdall):
//
//   0x00 — SESSION_SETUP    — Handshake, begin Odin session
//   0x01 — FILE_TRANSFER   — Send file data to flash a partition
//   0x02 — END_SESSION     — Clean session teardown
//   0x04 — RESET_DEVICE    — Reboot the device
//   0x05 — DEVICE_INFO     — Read device metadata (model, fw, serial)
//   0x06 — ERASE_PARTITION — Erase a named partition
//   0x07 — WRITE_PIT       — Write a PIT (Partition Information Table)
//   0x08 — CONTROL_LOG     — Enable/disable device-side logging
//   0x09 — NAND_READ       — Read raw NAND partition data
//   0x0A — TFLASH_ENTER    — Enter T-Flash (SD card direct access) mode
//   0x0B — TFLASH_EXIT     — Exit T-Flash mode
//   0x0C — GET_PIT         — Read the PIT from the device
//   0x64 — BOOT_CONTINUE   — Continue boot (don't reboot, just go)
//
// Response codes:
//   0x00 — OK / success
//   0x01 — File transfer complete
//   0x02 — End session ack
//   0x04 — Reset ack (connection will drop)
//   0x06 — Erase complete
//   0x07 — PIT write complete
//   0x08 — Log control ack
//   0x0C — PIT data follows
//   0xFF — Generic error
//   0xF0 — File transfer in progress (intermediate)
//   0xF1 — File transfer fail

import { Utils } from './utils.js';
import { LZ4 } from './lz4.js';
import { MD5 } from './md5.js';

const ODIN_CLASS = 0xFF;

// Default chunk sizes — reduced on retry for stability
const CHUNK_LARGE = 65536;   // 64KB — normal transfer
const CHUNK_SMALL = 16384;   // 16KB — retry on error
const CHUNK_TINY  = 4096;    // 4KB  — last-resort retry

// Odin response codes
export const ODIN_RESP = {
  OK:            0x00,
  FILE_DONE:     0x01,
  SESSION_END:   0x02,
  RESET_ACK:     0x04,
  ERASE_DONE:    0x06,
  PIT_WRITE_OK:  0x07,
  LOG_ACK:       0x08,
  PIT_DATA:      0x0C,
  BOOT_ACK:      0x64,
  ERROR:         0xFF,
  FILE_PROGRESS: 0xF0,
  FILE_FAIL:     0xF1,
};

// Odin command codes
export const ODIN_CMD = {
  SESSION_SETUP:   0x00,
  FILE_TRANSFER:   0x01,
  END_SESSION:     0x02,
  RESET_DEVICE:    0x04,
  DEVICE_INFO:     0x05,
  ERASE_PARTITION: 0x06,
  WRITE_PIT:       0x07,
  CONTROL_LOG:     0x08,
  NAND_READ:       0x09,
  TFLASH_ENTER:    0x0A,
  TFLASH_EXIT:     0x0B,
  GET_PIT:         0x0C,
  BOOT_CONTINUE:   0x64,
};

// PIT entry flags
const PIT_FLAG_WRITE = 0x01;
const PIT_FLAG_STL    = 0x02;
const PIT_FLAG_HIDDEN = 0x04;

export class OdinBridge {
  constructor() {
    this.device = null;
    this.interfaceNumber = null;
    this.endpointIn = null;
    this.endpointOut = null;
    this.pitData = null;
    this.deviceInfo = null;
    this._sessionActive = false;
    this._maxPacketSize = 512;
    this._flashAbort = false;
  }

  // ============================================================
  // Device Connection
  // ============================================================

  async requestDevice() {
    const filters = [{ vendorId: 0x04E8, classCode: 0xFF }];
    this.device = await navigator.usb.requestDevice({ filters });
    Utils.log(`Samsung device: ${this.device.manufacturerName || 'Samsung'} ${this.device.productName || ''}`);
  }

  async connect() {
    if (!this.device) throw new Error('No Samsung device selected');
    Utils.log('Opening Odin connection...');
    await this.device.open();

    let found = false;
    for (const config of this.device.configurations) {
      for (const iface of config.interfaces) {
        if (iface.alternates.some((a) => a.interfaceClass === ODIN_CLASS)) {
          this.interfaceNumber = iface.interfaceNumber;
          if (this.device.configuration?.configurationValue !== config.configurationValue)
            await this.device.selectConfiguration(config.configurationValue);
          await this.device.claimInterface(this.interfaceNumber);
          const alt = iface.alternates.find(a => a.interfaceClass === ODIN_CLASS);
          for (const ep of alt.endpoints) {
            if (ep.direction === 'in') this.endpointIn = ep.endpointNumber;
            else if (ep.direction === 'out') this.endpointOut = ep.endpointNumber;
            if (ep.packetSize > this._maxPacketSize) this._maxPacketSize = ep.packetSize;
          }
          found = true;
          Utils.log(`Odin interface claimed (max packet: ${this._maxPacketSize}B)`);
          break;
        }
      }
      if (found) break;
    }
    if (!found) throw new Error('No Odin interface found. Ensure device is in Download Mode (Vol Down + Power, then Vol Up).');
  }

  async disconnect() {
    if (this.device && this.device.opened) {
      if (this._sessionActive) { try { await this.endSession(); } catch (e) {} }
      if (this.interfaceNumber !== null) {
        try { await this.device.releaseInterface(this.interfaceNumber); } catch (e) {}
      }
      await this.device.close();
    }
    this.device = null;
    this._sessionActive = false;
  }

  // ============================================================
  // Low-Level Protocol
  // ============================================================

  /**
   * Send an Odin command with optional data payload.
   * Header: 4-byte cmd (LE) + 2-byte data size (LE) + 1-byte reserved.
   */
  async sendCommand(cmdCode, data = null) {
    const dataSize = data ? data.byteLength : 0;
    const header = new ArrayBuffer(7);
    const dv = new DataView(header);
    dv.setUint32(0, cmdCode, true);
    dv.setUint16(4, dataSize & 0xFFFF, true);
    dv.setUint8(6, 0x00);
    await this.device.transferOut(this.endpointOut, new Uint8Array(header));
    if (data && dataSize > 0) {
      await this._sendData(data, CHUNK_LARGE);
    }
  }

  /**
   * Send data in chunks. Reports progress via events if onProgress is provided.
   */
  async _sendData(data, chunkSize, onProgress = null) {
    const buf = Utils.u8(data);
    let offset = 0;
    while (offset < buf.byteLength) {
      const end = Math.min(offset + chunkSize, buf.byteLength);
      await this.device.transferOut(this.endpointOut, buf.slice(offset, end));
      offset = end;
      if (onProgress) onProgress(offset, buf.byteLength);
    }
  }

  /**
   * Read an Odin response packet.
   * Returns { cmdCode, dataSize, payload }.
   */
  async readResponse() {
    const result = await this.device.transferIn(this.endpointIn, 7);
    if (!result.data || result.data.byteLength < 7) {
      return { cmdCode: ODIN_RESP.ERROR, dataSize: 0, payload: null };
    }
    const data = new Uint8Array(result.data.buffer);
    const dv = new DataView(data.buffer);
    const cmdCode = dv.getUint32(0, true);
    const dataSize = dv.getUint16(4, true);
    let payload = null;
    if (dataSize > 0) {
      // Read payload in chunks for large responses (PIT, NAND)
      payload = await this._readPayload(dataSize);
    }
    return { cmdCode, dataSize, payload };
  }

  /**
   * Read a payload of given size, handling multi-packet transfers.
   */
  async _readPayload(totalSize) {
    const chunks = [];
    let remaining = totalSize;
    while (remaining > 0) {
      const readSize = Math.min(remaining, 65536);
      const result = await this.device.transferIn(this.endpointIn, readSize);
      if (result.data && result.data.byteLength > 0) {
        chunks.push(new Uint8Array(result.data.buffer));
        remaining -= result.data.byteLength;
      } else {
        break;
      }
    }
    // Combine chunks
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }

  // ============================================================
  // Session Management
  // ============================================================

  async initSession() {
    Utils.log('Initializing Odin session...');
    await this.sendCommand(ODIN_CMD.SESSION_SETUP);
    const resp = await this.readResponse();
    if (resp.cmdCode === ODIN_RESP.OK || resp.cmdCode === ODIN_RESP.SESSION_END) {
      this._sessionActive = true;
      Utils.log('Odin session active');
    } else {
      Utils.log(`Odin init unexpected response: 0x${resp.cmdCode.toString(16)}`, 'warn');
    }
    return resp;
  }

  async endSession() {
    if (!this._sessionActive) return;
    Utils.log('Ending Odin session...');
    await this.sendCommand(ODIN_CMD.END_SESSION);
    try {
      await this.readResponse();
    } catch (e) { /* session end may drop connection */ }
    this._sessionActive = false;
    Utils.log('Odin session ended');
  }

  async reboot() {
    Utils.log('Rebooting Samsung device...');
    await this.sendCommand(ODIN_CMD.RESET_DEVICE);
    try { await this.readResponse(); } catch (e) { /* device reboots */ }
    this._sessionActive = false;
    Utils.log('Device rebooting...');
  }

  async bootContinue() {
    Utils.log('Continuing boot...');
    await this.sendCommand(ODIN_CMD.BOOT_CONTINUE);
    try { await this.readResponse(); } catch (e) { /* device boots */ }
    this._sessionActive = false;
    Utils.log('Device continuing boot...');
  }

  // ============================================================
  // Device Interrogation
  // ============================================================

  /**
   * Read the PIT (Partition Information Table) from the device.
   * The PIT describes all partitions: names, sizes, flags, and flash names.
   */
  async readPIT() {
    Utils.log('Reading PIT (Partition Information Table)...');
    await this.sendCommand(ODIN_CMD.GET_PIT);
    const resp = await this.readResponse();

    if (resp.cmdCode === ODIN_RESP.PIT_DATA && resp.payload && resp.payload.byteLength > 0) {
      this.pitData = OdinBridge._parsePIT(resp.payload);
      Utils.log(`PIT: ${this.pitData.partitions.length} partitions found`);
      for (const p of this.pitData.partitions) {
        const writable = (p.flags & PIT_FLAG_WRITE) ? 'writable' : 'readonly';
        const sizeMB = (p.blockCount * p.blockSize / 1024 / 1024).toFixed(1);
        Utils.log(`  ${p.name} → ${p.flashName} (${sizeMB}MB, ${writable})`, 'debug');
      }
      return this.pitData;
    }

    // Some devices return PIT data with a different response code
    if (resp.payload && resp.payload.byteLength > 0) {
      Utils.log(`PIT returned with code 0x${resp.cmdCode.toString(16)} — attempting parse`, 'debug');
      this.pitData = OdinBridge._parsePIT(resp.payload);
      if (this.pitData.partitions.length > 0) return this.pitData;
    }

    Utils.log('PIT read returned no data', 'warn');
    return null;
  }

  /**
   * Get comprehensive device info: model, firmware, serial, bootloader.
   * The response contains multiple null-terminated strings.
   */
  async getDeviceInfo() {
    Utils.log('Reading Samsung device info...');
    await this.sendCommand(ODIN_CMD.DEVICE_INFO);
    const resp = await this.readResponse();

    if (resp.payload && resp.payload.byteLength > 0) {
      // Parse null-terminated strings from the payload
      const strings = OdinBridge._extractStrings(resp.payload);
      this.deviceInfo = {
        model: strings[0] || 'unknown',
        firmware: strings[1] || 'unknown',
        bootloader: strings[2] || 'unknown',
        serial: strings[3] || this.device?.serialNumber || 'unknown',
        region: strings[4] || 'unknown',
        raw: strings,
      };

      Utils.log(`Model: ${this.deviceInfo.model}`);
      Utils.log(`Firmware: ${this.deviceInfo.firmware}`);
      Utils.log(`Bootloader: ${this.deviceInfo.bootloader}`);
      Utils.log(`Serial: ${this.deviceInfo.serial}`);

      window.dispatchEvent(new CustomEvent('webforge:device-info', {
        detail: this.deviceInfo
      }));
      return this.deviceInfo;
    }

    // Fallback: use USB descriptor info
    Utils.log('Device info not available via Odin — using USB descriptor', 'debug');
    this.deviceInfo = {
      model: 'unknown',
      firmware: 'unknown',
      bootloader: 'unknown',
      serial: this.device?.serialNumber || 'unknown',
      region: 'unknown',
      raw: [],
    };
    return this.deviceInfo;
  }

  /**
   * Full device interrogation: init → get info → read PIT.
   * Returns a complete snapshot of the device state.
   */
  async interrogate() {
    Utils.log('Interrogating Samsung device...');

    if (!this._sessionActive) await this.initSession();
    const info = await this.getDeviceInfo();
    const pit = await this.readPIT();

    return {
      deviceInfo: info,
      pit: pit,
      usb: {
        vendorId: `0x${this.device.vendorId.toString(16).toUpperCase()}`,
        productId: `0x${this.device.productId.toString(16).toUpperCase()}`,
        serial: this.device.serialNumber || 'unknown',
        manufacturer: this.device.manufacturerName || 'Samsung',
        product: this.device.productName || '',
      },
    };
  }

  // ============================================================
  // Partition Operations
  // ============================================================

  /**
   * Erase a single partition by name.
   */
  async erasePartition(partitionName) {
    Utils.log(`Erasing partition: ${partitionName}...`);
    const nameBytes = new TextEncoder().encode(partitionName + '\0');
    await this.sendCommand(ODIN_CMD.ERASE_PARTITION, nameBytes);
    const resp = await this.readResponse();

    if (resp.cmdCode === ODIN_RESP.OK || resp.cmdCode === ODIN_RESP.ERASE_DONE) {
      Utils.log(`Erase ${partitionName}: OK`);
    } else {
      Utils.log(`Erase ${partitionName}: 0x${resp.cmdCode.toString(16)}`, 'warn');
    }
    return resp;
  }

  /**
   * Erase multiple partitions in sequence.
   * Useful for factory reset: erase cache, userdata, etc.
   */
  async erasePartitions(partitionNames) {
    Utils.log(`Batch erase: ${partitionNames.join(', ')}`);
    for (const name of partitionNames) {
      try {
        await this.erasePartition(name);
      } catch (err) {
        Utils.log(`Erase ${name} failed: ${err.message}`, 'warn');
      }
    }
    Utils.log('Batch erase complete');
  }

  /**
   * Factory reset via Odin: erase userdata and cache.
   */
  async factoryReset() {
    Utils.log('Performing factory reset (erasing userdata + cache)...');
    await this.erasePartitions(['USERDATA', 'CACHE', 'PERSIST']);
    Utils.log('Factory reset complete');
  }

  /**
   * Read a raw NAND partition to memory.
   * CAUTION: Large partitions will consume significant browser memory.
   * Only use for small partitions (PIT, PARAM, etc.)
   */
  async readNANDPartition(partitionName, maxBytes = 16 * 1024 * 1024) {
    Utils.log(`Reading NAND partition: ${partitionName} (max ${maxBytes} bytes)...`);
    const nameBytes = new TextEncoder().encode(partitionName + '\0');
    await this.sendCommand(ODIN_CMD.NAND_READ, nameBytes);
    const resp = await this.readResponse();

    if (resp.payload && resp.payload.byteLength > 0) {
      const data = resp.payload.byteLength > maxBytes
        ? resp.payload.slice(0, maxBytes)
        : resp.payload;
      Utils.log(`Read ${partitionName}: ${data.byteLength} bytes`);
      return data;
    }

    Utils.log(`NAND read ${partitionName} returned no data`, 'warn');
    return null;
  }

  // ============================================================
  // PIT Operations
  // ============================================================

  /**
   * Write a PIT (Partition Information Table) to the device.
   * DANGEROUS: A wrong PIT can brick the device permanently.
   */
  async writePIT(pitBinaryData) {
    Utils.log('Writing PIT to device...', 'warn');
    Utils.log('⚠️ PIT writes are dangerous — incorrect PIT can brick the device!', 'warn');

    await this.sendCommand(ODIN_CMD.WRITE_PIT, pitBinaryData);
    const resp = await this.readResponse();

    if (resp.cmdCode === ODIN_RESP.PIT_WRITE_OK || resp.cmdCode === ODIN_RESP.OK) {
      Utils.log('PIT write: OK');
    } else {
      Utils.log(`PIT write failed: 0x${resp.cmdCode.toString(16)}`, 'error');
      throw new Error(`PIT write failed with code 0x${resp.cmdCode.toString(16)}`);
    }
    return resp;
  }

  /**
   * Read PIT, modify a partition entry, and write it back.
   * Useful for resizing partitions or changing flags.
   */
  async modifyPIT(modifications) {
    if (!this.pitData) await this.readPIT();
    if (!this.pitData) throw new Error('No PIT data to modify');

    const modified = OdinBridge._buildPIT(this.pitData, modifications);
    Utils.log('Writing modified PIT...');
    await this.writePIT(modified);
  }

  // ============================================================
  // File Transfer (Flash) with Streaming Progress
  // ============================================================

  /**
   * Flash a single file to a partition with byte-level progress tracking
   * and automatic retry on failure.
   */
  async flashFile(fileData, partitionName = null, retries = 2) {
    const buf = Utils.u8(fileData);
    const sizeMB = buf.byteLength / 1024 / 1024;
    const label = partitionName || 'partition';
    Utils.log(`Flashing ${label} (${sizeMB.toFixed(2)} MB)...`);

    let lastError = null;
    let chunkSize = CHUNK_LARGE;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          Utils.log(`Retry ${attempt}/${retries} with ${(chunkSize / 1024).toFixed(0)}KB chunks...`, 'warn');
          // Re-init session on retry
          if (!this._sessionActive) await this.initSession();
        }

        await this._sendFileWithProgress(buf, chunkSize, label);
        const resp = await this.readResponse();

        if (resp.cmdCode === ODIN_RESP.OK || resp.cmdCode === ODIN_RESP.FILE_DONE) {
          Utils.log(`Flash ${label}: OK`);
          window.dispatchEvent(new CustomEvent('webforge:flash-progress', {
            detail: { partition: label, progress: 100 }
          }));
          return resp;
        }

        if (resp.cmdCode === ODIN_RESP.FILE_FAIL) {
          throw new Error(`Device rejected file transfer`);
        }

        Utils.log(`Flash ${label}: 0x${resp.cmdCode.toString(16)}`, 'warn');
        return resp;

      } catch (err) {
        lastError = err;
        Utils.log(`Flash attempt ${attempt + 1} failed: ${err.message}`, 'warn');
        // Reduce chunk size on retry
        if (chunkSize === CHUNK_LARGE) chunkSize = CHUNK_SMALL;
        else if (chunkSize === CHUNK_SMALL) chunkSize = CHUNK_TINY;
      }
    }

    throw new Error(`Flash ${label} failed after ${retries + 1} attempts: ${lastError?.message}`);
  }

  /**
   * Send file data with progress events.
   */
  async _sendFileWithProgress(buf, chunkSize, label) {
    const header = new ArrayBuffer(7);
    const dv = new DataView(header);
    dv.setUint32(0, ODIN_CMD.FILE_TRANSFER, true);
    dv.setUint16(4, buf.byteLength & 0xFFFF, true);
    dv.setUint8(6, 0x00);
    await this.device.transferOut(this.endpointOut, new Uint8Array(header));

    let offset = 0;
    let lastProgressPercent = 0;

    while (offset < buf.byteLength) {
      if (this._flashAbort) throw new Error('Flash aborted by user');
      const end = Math.min(offset + chunkSize, buf.byteLength);
      await this.device.transferOut(this.endpointOut, buf.slice(offset, end));
      offset = end;

      // Dispatch progress (throttle to every 5%)
      const percent = Math.floor((offset / buf.byteLength) * 100);
      if (percent >= lastProgressPercent + 5 || percent === 100) {
        lastProgressPercent = percent;
        window.dispatchEvent(new CustomEvent('webforge:flash-progress', {
          detail: { partition: label, progress: percent, bytes: offset, total: buf.byteLength }
        }));
      }
    }
  }

  /**
   * Abort an in-progress flash.
   */
  abortFlash() {
    this._flashAbort = true;
    Utils.log('Flash abort requested...', 'warn');
  }

  /**
   * Flash a .tar.md5, .tar, or .tar.lz4 archive to the Samsung device.
   * Detects LZ4 compression, verifies MD5, then flashes each partition
   * with streaming progress and retry logic.
   */
  async flashTarMD5(tarData) {
    this._flashAbort = false;
    const buf = Utils.u8(tarData);
    const sizeMB = buf.byteLength / 1024 / 1024;
    Utils.log(`Processing Odin archive (${sizeMB.toFixed(2)} MB)...`);

    // Check if the file is LZ4 compressed (Samsung .lz4 firmware files)
    let tarBuffer = buf;
    if (LZ4.isLZ4Frame(buf)) {
      Utils.log('LZ4 compressed archive detected → decompressing...');
      try {
        tarBuffer = await LZ4.decompress(buf);
        Utils.log(`Decompressed: ${(tarBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
      } catch (err) {
        throw new Error(`LZ4 decompression failed: ${err.message}`);
      }
    }

    // Verify MD5 if this is a .tar.md5 file
    const verified = OdinBridge._verifyMD5(tarBuffer);
    if (verified === false) {
      throw new Error('MD5 verification FAILED — archive may be corrupted. Aborting flash.');
    } else if (verified === true) {
      Utils.log('MD5 verification: OK');
    }

    // Parse tar entries
    const files = OdinBridge._parseTar(tarBuffer);
    Utils.log(`Found ${files.length} partitions: ${files.map(f => f.name).join(', ')}`);

    // If we have PIT data, match tar entries to PIT partition names
    if (this.pitData) {
      OdinBridge._matchToPIT(files, this.pitData);
    }

    // Flash each partition file
    let flashed = 0;
    let failed = 0;
    for (const file of files) {
      if (file.size === 0) continue;
      if (file.type === '5') continue; // directory entry
      if (this._flashAbort) {
        Utils.log('Flash aborted by user', 'warn');
        break;
      }

      const partName = file.name.replace(/\.(bin|img|tar)$/, '');

      try {
        await this.flashFile(file.data, partName);
        flashed++;
      } catch (err) {
        Utils.log(`Flash ${partName} FAILED: ${err.message}`, 'error');
        failed++;
        // Continue with remaining partitions — don't abort the whole batch
      }
    }

    if (failed > 0) {
      Utils.log(`Flash complete with ${failed} failure(s) (${flashed} succeeded)`, 'warn');
    } else {
      Utils.log(`Odin flash complete (${flashed} partitions flashed)`);
    }

    return { flashed, failed };
  }

  /**
   * Full flash flow: init → interrogate → flash → reboot.
   * Convenience method for a complete Odin session.
   */
  async fullFlash(tarData, { autoReboot = true, verify = true } = {}) {
    await this.initSession();

    // Interrogate device first (get model, firmware for logging)
    try { await this.getDeviceInfo(); } catch (e) { /* non-fatal */ }

    if (verify) {
      try { await this.readPIT(); } catch (e) { /* non-fatal */ }
    }

    const result = await this.flashTarMD5(tarData);
    await this.endSession();

    if (autoReboot) {
      await this.reboot();
    } else {
      await this.bootContinue();
    }

    return result;
  }

  // ============================================================
  // T-Flash (SD Card) Operations
  // ============================================================

  async enterTFlash() {
    Utils.log('Entering T-Flash (SD card) mode...');
    await this.sendCommand(ODIN_CMD.TFLASH_ENTER);
    const resp = await this.readResponse();
    if (resp.cmdCode === ODIN_RESP.OK) {
      Utils.log('T-Flash mode active');
    }
    return resp;
  }

  async exitTFlash() {
    Utils.log('Exiting T-Flash mode...');
    await this.sendCommand(ODIN_CMD.TFLASH_EXIT);
    const resp = await this.readResponse();
    Utils.log('T-Flash mode exited');
    return resp;
  }

  // ============================================================
  // Logging Control
  // ============================================================

  /**
   * Enable or disable device-side logging.
   * When enabled, the device sends additional debug info during operations.
   */
  async setLogging(enabled) {
    Utils.log(`${enabled ? 'Enabling' : 'Disabling'} device logging...`);
    const flag = new Uint8Array([enabled ? 0x01 : 0x00]);
    await this.sendCommand(ODIN_CMD.CONTROL_LOG, flag);
    const resp = await this.readResponse();
    if (resp.cmdCode === ODIN_RESP.LOG_ACK || resp.cmdCode === ODIN_RESP.OK) {
      Utils.log(`Device logging ${enabled ? 'enabled' : 'disabled'}`);
    }
    return resp;
  }

  // ============================================================
  // Static Parsing / Utility Methods
  // ============================================================

  /**
   * Parse a Samsung PIT (Partition Information Table) binary.
   * PIT format: header + repeated entries.
   * Each entry: flags(4) + type(4) + partition_name(32) + flash_name(32) + ...
   */
  static _parsePIT(data) {
    const buf = Utils.u8(data);
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const partitions = [];

    // PIT entry size is device-dependent: 86 bytes (older) or 84 bytes (newer)
    // Try 86 first, fall back to 84 if parsing fails
    for (const ENTRY_SIZE of [86, 84]) {
      partitions.length = 0;
      let offset = 0;
      let valid = true;

      while (offset + ENTRY_SIZE <= buf.byteLength) {
        const flags = dv.getUint32(offset, true);
        if (flags === 0xFFFFFFFF) { offset += ENTRY_SIZE; continue; }

        const type = dv.getUint32(offset + 4, true);
        const partName = Utils.readString(buf.buffer, buf.byteOffset + offset + 8, 32).replace(/\0+$/, '');
        const flashName = Utils.readString(buf.buffer, buf.byteOffset + offset + 40, 32).replace(/\0+$/, '');

        // Validate: at least one name should be non-empty and ASCII
        if (!partName && !flashName) { offset += ENTRY_SIZE; continue; }
        if (partName && !/^[\x20-\x7E]+$/.test(partName)) { valid = false; break; }

        partitions.push({
          flags,
          type,
          name: partName,
          flashName,
          blockSize: dv.getUint32(offset + 72, true),
          blockCount: dv.getUint32(offset + 76, true),
          fileSize: dv.getUint32(offset + 80, true),
          writable: !!(flags & PIT_FLAG_WRITE),
          hidden: !!(flags & PIT_FLAG_HIDDEN),
        });
        offset += ENTRY_SIZE;
      }

      if (valid && partitions.length > 0) break;
    }

    return { partitions, entrySize: partitions.length > 0 ? 86 : 84, raw: buf };
  }

  /**
   * Build a PIT binary from parsed PIT data + modifications.
   */
  static _buildPIT(pitData, modifications = {}) {
    const entrySize = pitData.entrySize || 86;
    const buf = new Uint8Array(pitData.partitions.length * entrySize);
    const dv = new DataView(buf.buffer);

    for (let i = 0; i < pitData.partitions.length; i++) {
      const p = pitData.partitions[i];
      const offset = i * entrySize;

      // Apply modifications
      const mod = modifications[p.name] || {};
      const flags = mod.flags ?? p.flags;
      const blockCount = mod.blockCount ?? p.blockCount;

      dv.setUint32(offset, flags, true);
      dv.setUint32(offset + 4, p.type, true);

      // Partition name (32 bytes)
      const nameBytes = new TextEncoder().encode(p.name);
      buf.set(nameBytes.slice(0, 31), offset + 8);

      // Flash name (32 bytes)
      const flashBytes = new TextEncoder().encode(p.flashName);
      buf.set(flashBytes.slice(0, 31), offset + 40);

      dv.setUint32(offset + 72, p.blockSize, true);
      dv.setUint32(offset + 76, blockCount, true);
      dv.setUint32(offset + 80, p.fileSize, true);
    }

    return buf;
  }

  /**
   * Match tar file entries to PIT partition names.
   * Odin tar files use short names (e.g., "BOOT.img") while PIT uses
   * longer names (e.g., "BOOT"). This maps them.
   */
  static _matchToPIT(files, pitData) {
    for (const file of files) {
      const baseName = file.name.replace(/\.(bin|img|tar)$/, '').toUpperCase();
      const pitEntry = pitData.partitions.find(p =>
        p.name.toUpperCase() === baseName ||
        p.flashName.toUpperCase() === baseName
      );
      if (pitEntry) {
        file.pitMatch = pitEntry.name;
        file.flashName = pitEntry.flashName;
        Utils.log(`  ${file.name} → PIT: ${pitEntry.name} (${pitEntry.flashName})`, 'debug');
      }
    }
  }

  /**
   * Extract null-terminated strings from a binary payload.
   */
  static _extractStrings(data) {
    const strings = [];
    let current = '';
    for (let i = 0; i < data.byteLength; i++) {
      if (data[i] === 0) {
        if (current.length > 0) {
          strings.push(current);
          current = '';
        }
      } else if (data[i] >= 0x20 && data[i] <= 0x7E) {
        current += String.fromCharCode(data[i]);
      } else {
        if (current.length > 0) {
          strings.push(current);
          current = '';
        }
      }
    }
    if (current.length > 0) strings.push(current);
    return strings.filter(s => s.length >= 2); // filter noise
  }

  /**
   * Verify the MD5 checksum of a .tar.md5 archive.
   * Samsung format: tar data + 32-char hex MD5 appended at the end.
   * Returns: true (verified), false (mismatch), null (no MD5 found)
   */
  static _verifyMD5(buf) {
    const tailStart = Math.max(0, buf.byteLength - 64);
    const tail = new TextDecoder().decode(buf.slice(tailStart));
    const md5Match = tail.match(/([0-9a-fA-F]{32})\s*$/);
    if (!md5Match) return null;

    const expectedMD5 = md5Match[1].toLowerCase();

    // Find where the hex string starts
    let md5Start = -1;
    for (let i = buf.byteLength - 33; i >= 0 && i >= buf.byteLength - 128; i--) {
      let match = true;
      for (let j = 0; j < 32; j++) {
        const c = String.fromCharCode(buf[i + j]);
        if (!/[0-9a-fA-F]/.test(c)) { match = false; break; }
      }
      if (match) { md5Start = i; break; }
    }
    if (md5Start < 0) return null;

    const tarData = buf.slice(0, md5Start);
    const actualMD5 = MD5.hex(tarData);

    if (actualMD5 === expectedMD5) {
      Utils.log(`MD5 verified: ${actualMD5}`);
      return true;
    } else {
      Utils.log(`MD5 mismatch: expected ${expectedMD5}, got ${actualMD5}`, 'error');
      return false;
    }
  }

  /**
   * Parse a tar archive and extract file entries.
   * Standard POSIX tar format: 512-byte headers, 512-aligned data.
   */
  static _parseTar(buf) {
    const files = [];
    let offset = 0;

    while (offset + 512 <= buf.byteLength) {
      const header = buf.slice(offset, offset + 512);

      if (header.every(b => b === 0)) {
        if (offset + 1024 <= buf.byteLength) {
          const nextBlock = buf.slice(offset + 512, offset + 1024);
          if (nextBlock.every(b => b === 0)) break;
        }
        break;
      }

      const name = Utils.readString(header.buffer, header.byteOffset, 100).replace(/\0+$/, '');
      if (!name) break;

      const sizeStr = Utils.readString(header.buffer, header.byteOffset + 124, 12).replace(/\0+$/, '').trim();
      const size = parseInt(sizeStr, 8) || 0;
      const typeFlag = String.fromCharCode(header[156] || 0x30);

      offset += 512;

      if (size > 0 && typeFlag !== '5') {
        const data = buf.slice(offset, offset + size);
        files.push({ name, data, size, type: typeFlag });
        offset += Math.ceil(size / 512) * 512;
      }
    }

    return files;
  }
}
