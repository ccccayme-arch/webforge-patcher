// WebForge Patcher — USB Bridge (Fastboot Protocol)
// Handles WebUSB connection to Android devices in Fastboot mode.
// Includes memory-optimized streaming flash, slot management, OEM commands,
// temporary boot, and partition operations.
//
// Fastboot protocol reference:
//   Commands are ASCII strings sent as USB bulk OUT transfers.
//   Responses: OKAY<msg>, FAIL<msg>, INFO<msg>, DATA<size_hex>
//   All transfers are bulk (not interrupt like Odin).

import { Utils } from './utils.js';

const FASTBOOT_CLASS = 0xFF;
const FASTBOOT_SUBCLASS = 0x42;
const FASTBOOT_MAX_MSG = 64;   // Fastboot max message size (pre-v4)
const DOWNLOAD_CHUNK = 65536;   // 64KB download chunks
const MAX_RESPONSE_RETRIES = 3;

// Response prefixes
export const RESP_OKAY = 'OKAY';
export const RESP_FAIL = 'FAIL';
export const RESP_INFO = 'INFO';
export const RESP_DATA = 'DATA';

export class USBBridge {
  constructor() {
    this.device = null;
    this.interfaceNumber = null;
    this.endpointIn = null;
    this.endpointOut = null;
    this.maxPacketSize = 64;
    this._connected = false;
    this._flashAbort = false;
  }

  // ============================================================
  // Device Connection
  // ============================================================

  async requestDevice() {
    const filters = [
      // Standard fastboot interface
      { classCode: 0xFF, subclassCode: 0x42 },
      // Samsung fastboot (rare, usually Odin)
      { classCode: 0xFF, subclassCode: 0x00, protocolCode: 0x00, vendorId: 0x04E8 },
      // Google
      { vendorId: 0x18D1, classCode: 0xFF },
      // OnePlus
      { vendorId: 0x2A70, classCode: 0xFF },
      // Xiaomi
      { vendorId: 0x18D1 },
      // Motorola
      { vendorId: 0x22B8, classCode: 0xFF },
      // Nothing
      { vendorId: 0x3358, classCode: 0xFF },
      // Sony
      { vendorId: 0x0FCE, classCode: 0xFF },
    ];
    try {
      this.device = await navigator.usb.requestDevice({ filters });
      Utils.log(`Device: ${this.device.manufacturerName || 'Unknown'} ${this.device.productName || ''} (${this.device.serialNumber || 'no serial'})`);
      return this.device;
    } catch (err) {
      if (err.name === 'NotFoundError') throw new Error('No device selected. Connect a device in Fastboot mode (Vol Down + Power) and try again.');
      throw err;
    }
  }

  async connect() {
    if (!this.device) throw new Error('No device selected. Call requestDevice() first.');
    Utils.log('Opening Fastboot USB connection...');
    await this.device.open();

    let found = false;
    for (const config of this.device.configurations) {
      for (const iface of config.interfaces) {
        const isFb = iface.alternates.some(alt =>
          alt.interfaceClass === FASTBOOT_CLASS && alt.interfaceSubclass === FASTBOOT_SUBCLASS
        );
        // Also accept generic vendor-class interfaces on known vendor IDs
        const isGenericFb = iface.alternates.some(alt =>
          alt.interfaceClass === FASTBOOT_CLASS && alt.endpoints.length >= 2
        );

        if (isFb || isGenericFb) {
          this.interfaceNumber = iface.interfaceNumber;
          if (this.device.configuration?.configurationValue !== config.configurationValue) {
            await this.device.selectConfiguration(config.configurationValue);
          }
          await this.device.claimInterface(this.interfaceNumber);
          const alt = iface.alternates.find(a =>
            a.interfaceClass === FASTBOOT_CLASS && (a.interfaceSubclass === FASTBOOT_SUBCLASS || a.endpoints.length >= 2)
          );
          for (const ep of alt.endpoints) {
            if (ep.direction === 'in') this.endpointIn = ep.endpointNumber;
            else if (ep.direction === 'out') {
              this.endpointOut = ep.endpointNumber;
              this.maxPacketSize = Math.max(this.maxPacketSize, ep.packetSize || 64);
            }
          }
          found = true;
          this._connected = true;
          Utils.log(`Fastboot interface claimed (IF#${this.interfaceNumber}, maxPacket=${this.maxPacketSize}B)`);
          break;
        }
      }
      if (found) break;
    }
    if (!found) throw new Error('No Fastboot interface found. Ensure device is in Fastboot mode (Vol Down + Power).');

    // Verify connection with getvar
    try {
      const product = await this.getVar('product');
      Utils.log(`Connected: ${product}`);
    } catch (err) {
      Utils.log('Connected but getvar:product failed — device may not be ready', 'warn');
    }
  }

  async disconnect() {
    if (this.device && this.device.opened) {
      if (this.interfaceNumber !== null) {
        try { await this.device.releaseInterface(this.interfaceNumber); } catch (e) {}
      }
      await this.device.close();
      Utils.log('Fastboot USB disconnected');
    }
    this.device = null;
    this.interfaceNumber = null;
    this.endpointIn = null;
    this.endpointOut = null;
    this._connected = false;
  }

  // ============================================================
  // Low-Level USB Transfer
  // ============================================================

  async transferOut(data) {
    if (!this.device || !this.endpointOut) throw new Error('Device not connected');
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    const result = await this.device.transferOut(this.endpointOut, buf);
    if (result.status !== 'ok') throw new Error(`USB OUT failed: ${result.status}`);
    return result.bytesWritten;
  }

  async transferIn(length = 512) {
    if (!this.device || !this.endpointIn) throw new Error('Device not connected');
    const result = await this.device.transferIn(this.endpointIn, length);
    if (result.status !== 'ok') throw new Error(`USB IN failed: ${result.status}`);
    return new Uint8Array(result.data.buffer);
  }

  // ============================================================
  // Fastboot Command Protocol
  // ============================================================

  /**
   * Send a fastboot command and read the response.
   * Handles OKAY, FAIL, INFO, and DATA response types.
   * Collects all INFO messages and returns the final OKAY/FAIL payload.
   */
  async command(cmd) {
    const cmdBytes = new TextEncoder().encode(cmd);
    if (cmdBytes.byteLength > FASTBOOT_MAX_MSG) {
      throw new Error(`Command too long (${cmdBytes.byteLength} bytes, max ${FASTBOOT_MAX_MSG}): ${cmd}`);
    }
    await this.transferOut(cmdBytes);

    let info = [];
    let retries = 0;

    while (true) {
      const reply = await this.transferIn(512);
      const text = new TextDecoder().decode(reply);

      if (text.startsWith(RESP_OKAY)) {
        return { type: 'ok', message: text.substring(4), info };
      } else if (text.startsWith(RESP_FAIL)) {
        const msg = text.substring(4);
        Utils.log(`Fastboot FAIL: ${cmd} → ${msg}`, 'warn');
        throw new Error(`Fastboot fail: ${msg}`);
      } else if (text.startsWith(RESP_INFO)) {
        info.push(text.substring(4));
        continue;
      } else if (text.startsWith(RESP_DATA)) {
        const size = parseInt(text.substring(4), 16);
        return { type: 'data', size, info };
      } else {
        // Unknown response — retry
        if (++retries > MAX_RESPONSE_RETRIES) {
          Utils.log(`Unexpected response: "${text}"`, 'warn');
          return { type: 'unknown', message: text, info };
        }
      }
    }
  }

  /**
   * Send a command, collecting all INFO lines as a combined message.
   * Useful for commands like `getvar all` that return multiple INFO lines.
   */
  async commandWithInfo(cmd) {
    const result = await this.command(cmd);
    return {
      ...result,
      fullInfo: result.info.join('\n'),
    };
  }

  // ============================================================
  // Getvar (Device Variable Query)
  // ============================================================

  /**
   * Query a single device variable.
   */
  async getVar(name) {
    const result = await this.command(`getvar:${name}`);
    return result.message;
  }

  /**
   * Query ALL device variables.
   * Uses 'getvar all' which returns each variable as an INFO line,
   * terminated by OKAY. Returns an object with all key-value pairs.
   */
  async getAllVars() {
    const result = await this.command('getvar:all');
    const vars = {};
    for (const line of result.info) {
      const eqIdx = line.indexOf(':');
      if (eqIdx > 0) {
        const key = line.substring(0, eqIdx).trim();
        const val = line.substring(eqIdx + 1).trim();
        vars[key] = val;
      } else if (line.trim()) {
        vars[line.trim()] = '';
      }
    }
    // Also check the OKAY message for trailing data
    if (result.message) {
      const eqIdx = result.message.indexOf(':');
      if (eqIdx > 0) {
        vars[result.message.substring(0, eqIdx).trim()] = result.message.substring(eqIdx + 1).trim();
      }
    }
    return vars;
  }

  /**
   * Convenience: fetch the most useful device variables for display and AI.
   */
  async fetchDeviceVars() {
    try {
      return await this.getAllVars();
    } catch (e) {
      // Fallback: query individually
      Utils.log('getvar:all failed, querying individually...', 'debug');
      const vars = {};
      const names = [
        'product', 'serialno', 'secure', 'unlocked', 'max-download-size',
        'current-slot', 'slot-count', 'battery-soc-ok',
        'slot-retry-count:a', 'slot-retry-count:b',
        'slot-successful:a', 'slot-successful:b',
        'partition-type:boot', 'partition-type:init_boot',
        'partition-type:vendor_boot', 'partition-type:vbmeta',
      ];
      const results = await Promise.all(names.map(n => this.getVar(n).catch(() => null)));
      names.forEach((n, i) => { if (results[i] !== null) vars[n] = results[i]; });
      return vars;
    }
  }

  // ============================================================
  // Flash Operations
  // ============================================================

  /**
   * Flash a partition with memory-optimized chunked transfer.
   * Slices the buffer lazily — each chunk is a view, no full copy until USB transfer.
   */
  async flashPartition(partition, data) {
    this._flashAbort = false;
    const buf = Utils.u8(data);
    const sizeMB = buf.byteLength / 1024 / 1024;
    Utils.log(`Flashing ${partition} (${sizeMB.toFixed(2)} MB)...`);

    // Send download command with size
    const sizeHex = buf.byteLength.toString(16).padStart(8, '0');
    const dlResult = await this.command(`download:${sizeHex}`);
    if (dlResult.type !== 'data') {
      throw new Error(`Device refused download: expected DATA, got ${dlResult.type}`);
    }
    if (dlResult.size !== buf.byteLength) {
      throw new Error(`Size mismatch: device expected ${dlResult.size}, got ${buf.byteLength}`);
    }

    // Send data in chunks with progress
    const chunkSize = Math.max(this.maxPacketSize * 32, DOWNLOAD_CHUNK);
    let offset = 0;
    let lastProgressPercent = 0;

    while (offset < buf.byteLength) {
      if (this._flashAbort) throw new Error('Flash aborted by user');
      const end = Math.min(offset + chunkSize, buf.byteLength);
      const chunk = buf.slice(offset, end);
      await this.transferOut(chunk);
      offset = end;

      const percent = Math.floor((offset / buf.byteLength) * 100);
      if (percent >= lastProgressPercent + 5 || percent === 100) {
        lastProgressPercent = percent;
        window.dispatchEvent(new CustomEvent('webforge:flash-progress', {
          detail: { partition, progress: percent, bytes: offset, total: buf.byteLength }
        }));
        if (percent % 10 === 0) Utils.log(`  ${partition}: ${percent}% (${(offset / 1048576).toFixed(1)} MB)`);
      }
    }

    // Wait for download OKAY
    const dlComplete = await this._readResponse();
    if (dlComplete.type === 'fail') throw new Error(`Download failed: ${dlComplete.message}`);

    // Send flash command
    Utils.log(`Sending flash:${partition}...`);
    const flashResult = await this.command(`flash:${partition}`);
    Utils.log(`Flash ${partition}: OK`);
    return flashResult;
  }

  /**
   * Stream flash directly from a File object — avoids loading the entire
   * image into memory. Reads the file in chunks and sends each chunk over USB.
   */
  async flashFromFile(partition, file) {
    this._flashAbort = false;
    const sizeMB = file.size / 1024 / 1024;
    Utils.log(`Streaming flash ${partition} from ${file.name} (${sizeMB.toFixed(2)} MB)...`);

    const sizeHex = file.size.toString(16).padStart(8, '0');
    const dlResult = await this.command(`download:${sizeHex}`);
    if (dlResult.type !== 'data') throw new Error(`Device refused download`);

    const chunkSize = DOWNLOAD_CHUNK;
    let offset = 0;

    while (offset < file.size) {
      if (this._flashAbort) throw new Error('Flash aborted by user');
      const end = Math.min(offset + chunkSize, file.size);
      const slice = file.slice(offset, end);
      const chunk = new Uint8Array(await slice.arrayBuffer());
      await this.transferOut(chunk);
      offset = end;

      const percent = Math.floor((offset / file.size) * 100);
      window.dispatchEvent(new CustomEvent('webforge:flash-progress', {
        detail: { partition, progress: percent, bytes: offset, total: file.size }
      }));
      if (percent % 10 === 0) Utils.log(`  ${partition}: ${percent}% (${(offset / 1048576).toFixed(1)} MB)`);
    }

    const dlComplete = await this._readResponse();
    if (dlComplete.type === 'fail') throw new Error(`Download failed: ${dlComplete.message}`);

    const result = await this.command(`flash:${partition}`);
    Utils.log(`Flash ${partition} complete (streamed)`);
    return result;
  }

  /**
   * Abort an in-progress flash.
   */
  abortFlash() {
    this._flashAbort = true;
    Utils.log('Flash abort requested...', 'warn');
  }

  /**
   * Read a raw response (used after download data transfer).
   */
  async _readResponse() {
    let retries = 0;
    while (true) {
      const reply = await this.transferIn(512);
      const text = new TextDecoder().decode(reply);
      if (text.startsWith(RESP_OKAY)) return { type: 'ok', message: text.substring(4), info: [] };
      if (text.startsWith(RESP_FAIL)) return { type: 'fail', message: text.substring(4), info: [] };
      if (text.startsWith(RESP_INFO)) continue;
      if (++retries > MAX_RESPONSE_RETRIES) return { type: 'unknown', message: text, info: [] };
    }
  }

  // ============================================================
  // Partition Operations
  // ============================================================

  async erasePartition(partition) {
    Utils.log(`Erasing ${partition}...`);
    const result = await this.command(`erase:${partition}`);
    Utils.log(`Erase ${partition}: OK`);
    return result;
  }

  /**
   * Get partition type (ext4, raw, etc.)
   */
  async getPartitionType(partition) {
    return await this.getVar(`partition-type:${partition}`);
  }

  /**
   * Get partition size in bytes.
   */
  async getPartitionSize(partition) {
    const sizeStr = await this.getVar(`partition-size:${partition}`);
    return parseInt(sizeStr, 16) || 0;
  }

  /**
   * Erase multiple partitions in sequence.
   */
  async erasePartitions(partitions) {
    for (const p of partitions) {
      try { await this.erasePartition(p); }
      catch (err) { Utils.log(`Erase ${p} failed: ${err.message}`, 'warn'); }
    }
  }

  /**
   * Factory reset: erase userdata and cache.
   */
  async factoryReset() {
    Utils.log('Factory reset (erasing userdata + cache)...');
    await this.erasePartitions(['userdata', 'cache']);
    Utils.log('Factory reset complete');
  }

  // ============================================================
  // Boot (Temporary Boot Without Flashing)
  // ============================================================

  /**
   * Temporarily boot from an image without writing to the device.
   * Sends the image to RAM and boots it — doesn't persist across reboots.
   * Useful for testing patched boot images before committing.
   */
  async bootTemp(data) {
    this._flashAbort = false;
    const buf = Utils.u8(data);
    const sizeMB = buf.byteLength / 1024 / 1024;
    Utils.log(`Temporary boot (${sizeMB.toFixed(2)} MB)...`);

    const sizeHex = buf.byteLength.toString(16).padStart(8, '0');
    const dlResult = await this.command(`download:${sizeHex}`);
    if (dlResult.type !== 'data') throw new Error('Device refused download for boot');

    // Send data in chunks
    const chunkSize = DOWNLOAD_CHUNK;
    let offset = 0;
    while (offset < buf.byteLength) {
      if (this._flashAbort) throw new Error('Boot aborted');
      const end = Math.min(offset + chunkSize, buf.byteLength);
      await this.transferOut(buf.slice(offset, end));
      offset = end;

      const percent = Math.floor((offset / buf.byteLength) * 100);
      window.dispatchEvent(new CustomEvent('webforge:flash-progress', {
        detail: { partition: 'boot (temp)', progress: percent, bytes: offset, total: buf.byteLength }
      }));
    }

    // Wait for download OKAY
    const dlComplete = await this._readResponse();
    if (dlComplete.type === 'fail') throw new Error(`Download failed: ${dlComplete.message}`);

    // Send boot command
    Utils.log('Sending boot command...');
    try {
      await this.command('boot');
      Utils.log('Temporary boot: image sent to device');
    } catch (err) {
      Utils.log('Boot command result: ' + err.message, 'warn');
    }
  }

  // ============================================================
  // Slot Management (A/B Devices)
  // ============================================================

  /**
   * Get the current active slot (a or b).
   */
  async getCurrentSlot() {
    return await this.getVar('current-slot');
  }

  /**
   * Get the inactive slot (the one not currently booted).
   */
  async getInactiveSlot() {
    const current = await this.getCurrentSlot();
    return current === 'a' ? 'b' : 'a';
  }

  /**
   * Set the active boot slot.
   * After flashing to the inactive slot, set it active for next boot.
   */
  async setActiveSlot(slot) {
    if (slot !== 'a' && slot !== 'b') throw new Error(`Invalid slot: ${slot}. Must be 'a' or 'b'.`);
    Utils.log(`Setting active slot: ${slot}`);
    const result = await this.command(`set_active:${slot}`);
    Utils.log(`Active slot set to ${slot}`);
    return result;
  }

  /**
   * Switch to the inactive slot (convenience method).
   * Common pattern after flashing a patched boot to the inactive slot.
   */
  async switchToInactiveSlot() {
    const inactive = await this.getInactiveSlot();
    await this.setActiveSlot(inactive);
    return inactive;
  }

  /**
   * Get slot retry count.
   */
  async getSlotRetryCount(slot) {
    return await this.getVar(`slot-retry-count:${slot}`);
  }

  /**
   * Get slot successful flag.
   */
  async getSlotSuccessful(slot) {
    return await this.getVar(`slot-successful:${slot}`);
  }

  /**
   * Check if a slot is marked as successful (booted successfully at least once).
   */
  async isSlotSuccessful(slot) {
    const val = await this.getSlotSuccessful(slot);
    return val === 'yes';
  }

  // ============================================================
  // Reboot Operations
  // ============================================================

  /**
   * Reboot the device. Optional mode:
   * ''         — normal reboot
   * 'bootloader' — reboot back to bootloader/fastboot
   * 'recovery'   — reboot to recovery
   * 'fastboot'   — reboot to fastbootd (userspace fastboot)
   * 'edl'        — reboot to emergency download (Qualcomm EDL)
   */
  async reboot(mode = '') {
    const cmd = mode ? `reboot-${mode}` : 'reboot';
    Utils.log(`Rebooting (${mode || 'normal'})...`);
    try {
      await this.command(cmd);
    } catch (e) {
      Utils.log('Device rebooting (connection dropped)');
    }
    this._connected = false;
  }

  async rebootBootloader() { return this.reboot('bootloader'); }
  async rebootRecovery() { return this.reboot('recovery'); }
  async rebootFastbootd() { return this.reboot('fastboot'); }

  /**
   * Continue boot (exit fastboot mode, boot normally).
   */
  async continueBoot() {
    Utils.log('Continuing boot...');
    try {
      await this.command('continue');
    } catch (e) {
      Utils.log('Device continuing boot (connection dropped)');
    }
    this._connected = false;
  }

  // ============================================================
  // OEM Commands (Device-Specific)
  // ============================================================

  /**
   * Unlock the bootloader.
   * This WILL wipe all user data.
   * Some devices require `flashing unlock_critical` as well.
   */
  async unlockBootloader() {
    Utils.log('⚠️ Unlocking bootloader — ALL DATA WILL BE WIPED!', 'warn');
    try {
      await this.command('flashing:unlock');
      Utils.log('Bootloader unlock command sent. Check device screen for confirmation.');
    } catch (err) {
      Utils.log('Unlock failed: ' + err.message, 'error');
      throw err;
    }
  }

  /**
   * Lock the bootloader.
   * Device must be in original (unmodified) state.
   */
  async lockBootloader() {
    Utils.log('Locking bootloader...', 'warn');
    try {
      await this.command('flashing:lock');
      Utils.log('Bootloader lock command sent.');
    } catch (err) {
      Utils.log('Lock failed: ' + err.message, 'error');
      throw err;
    }
  }

  /**
   * Check if bootloader is unlocked.
   */
  async isUnlocked() {
    const val = await this.getVar('unlocked');
    return val === 'yes';
  }

  /**
   * Check if device is secure (locked down).
   */
  async isSecure() {
    const val = await this.getVar('secure');
    return val === 'yes';
  }

  /**
   * Send an OEM command (device-specific).
   * Examples: 'oem device-info', 'oem unlock', 'oem reboot-edl'
   */
  async oemCommand(cmd) {
    Utils.log(`OEM: ${cmd}`, 'debug');
    return await this.command(`oem ${cmd}`);
  }

  /**
   * Get OEM device info (manufacturer-specific).
   */
  async oemDeviceInfo() {
    try {
      const result = await this.commandWithInfo('oem device-info');
      return result.fullInfo || result.message;
    } catch (e) {
      // Not all devices support this
      return 'not supported';
    }
  }

  // ============================================================
  // Verification & Utilities
  // ============================================================

  /**
   * Verify a partition was flashed correctly by checking its size.
   */
  async verifyFlash(partition, expectedSize) {
    const actualSize = await this.getPartitionSize(partition);
    if (actualSize !== expectedSize) {
      Utils.log(`Size mismatch on ${partition}: expected ${expectedSize}, got ${actualSize}`, 'warn');
      return false;
    }
    Utils.log(`Verified ${partition}: size OK (${actualSize} bytes)`);
    return true;
  }

  /**
   * Check if battery has enough charge for flashing (Pixel-specific).
   */
  async checkBattery() {
    try {
      const ok = await this.getVar('battery-soc-ok');
      if (ok === 'no' || ok === 'false') {
        Utils.log('⚠️ Battery too low for flashing. Charge to at least 50%.', 'warn');
        return false;
      }
      Utils.log('Battery: OK for flashing');
      return true;
    } catch (e) {
      Utils.log('Battery check not supported (non-Pixel device)', 'debug');
      return true;
    }
  }

  /**
   * Check max download size supported by the device.
   */
  async getMaxDownloadSize() {
    const sizeStr = await this.getVar('max-download-size');
    return parseInt(sizeStr, 16) || 0;
  }

  /**
   * Full device interrogation: fetch all vars, check battery, check unlock state.
   * Returns a complete snapshot for display and AI analysis.
   */
  async interrogate() {
    Utils.log('Interrogating Fastboot device...');
    const vars = await this.fetchDeviceVars();
    const battery = await this.checkBattery().catch(() => null);
    const maxDl = await this.getMaxDownloadSize().catch(() => 0);

    return {
      vars,
      product: vars['product'] || 'unknown',
      serial: vars['serialno'] || this.device?.serialNumber || 'unknown',
      secure: vars['secure'] === 'yes',
      unlocked: vars['unlocked'] === 'yes',
      currentSlot: vars['current-slot'] || '',
      slotCount: vars['slot-count'] || '1',
      maxDownloadSize: maxDl,
      batteryOk: battery,
      usb: {
        vendorId: `0x${this.device.vendorId.toString(16).toUpperCase()}`,
        productId: `0x${this.device.productId.toString(16).toUpperCase()}`,
        serial: this.device.serialNumber || 'unknown',
        manufacturer: this.device.manufacturerName || '',
        product: this.device.productName || '',
      },
    };
  }

  /**
   * Check if WebUSB is supported in the current browser.
   */
  static isSupported() {
    return typeof navigator !== 'undefined' && 'usb' in navigator;
  }
}
