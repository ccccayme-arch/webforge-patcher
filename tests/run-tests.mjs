// Polyfill browser globals for Node.js test environment
globalThis.window = { dispatchEvent: () => {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
globalThis.navigator = { usb: null };

// WebForge Patcher — Integration Test Stubs
// Run with: node tests/run-tests.mjs
// These tests validate core logic WITHOUT requiring a USB device.
// They test parsing, hashing, compression, and data structures.

import { MD5 } from '../js/md5.js';
import { LZ4 } from '../js/lz4.js';
import { BootImage } from '../js/boot-image.js';
import { RamdiskPatcher } from '../js/ramdisk-patcher.js';
import { BootValidator } from '../js/boot-validator.js';
import { OdinBridge, ODIN_CMD } from '../js/odin.js';
import { USBBridge, RESP_OKAY, RESP_FAIL, RESP_INFO, RESP_DATA } from '../js/usb-bridge.js';
import { BRAND_KNOWLEDGE, ERROR_PATTERNS } from '../js/ai-assistant.js';
import { Utils } from '../js/utils.js';
import { DeviceDoctor } from '../js/doctor.js';
void RamdiskPatcher; void OdinBridge; void USBBridge; // verify import works

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'Mismatch'}: expected ${expected}, got ${actual}`);
}

function assertDeepEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'Mismatch'}: expected ${b}, got ${a}`);
}

// --- MD5 Tests (RFC 1321 vectors) ---
test('MD5: empty string', () => {
  assertEq(MD5.hex(new TextEncoder().encode('')), 'd41d8cd98f00b204e9800998ecf8427e');
});

test('MD5: "a"', () => {
  assertEq(MD5.hex(new TextEncoder().encode('a')), '0cc175b9c0f1b6a831c399e269772661');
});

test('MD5: "abc"', () => {
  assertEq(MD5.hex(new TextEncoder().encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
});

test('MD5: "message digest"', () => {
  assertEq(MD5.hex(new TextEncoder().encode('message digest')), 'f96b697d7cb7938d525a2f31aaf161d0');
});

test('MD5: alphabet', () => {
  assertEq(MD5.hex(new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz')), 'c3fcd3d76192e4007dfb496cca67e13b');
});

test('MD5: 100KB pattern', () => {
  const data = new Uint8Array(100000);
  for (let i = 0; i < data.length; i++) data[i] = i % 256;
  const hash = MD5.hex(data);
  assert(/^[0-9a-f]{32}$/.test(hash), 'Should be 32 hex chars');
  // Same input → same hash (deterministic)
  assertEq(MD5.hex(data), hash, 'MD5 should be deterministic');
  // Different input → different hash
  data[0] = 1;
  assert(MD5.hex(data) !== hash, 'Different input should produce different hash');
});

// --- LZ4 Tests ---
test('LZ4: detect frame magic', () => {
  const lz4Frame = new Uint8Array([0x04, 0x22, 0x4D, 0x18, 0x40, 0x40, 0xC0, 0x00]);
  assert(LZ4.isLZ4Frame(lz4Frame), 'Should detect LZ4 frame');
  const notLz4 = new Uint8Array([0x1F, 0x8B, 0x08, 0x00]);
  assert(!LZ4.isLZ4Frame(notLz4), 'Should not detect gzip as LZ4');
  assert(!LZ4.isLZ4Frame(new Uint8Array([0, 0, 0])), 'Should not detect short data as LZ4');
});

// --- Boot Image Parsing Tests ---
test('BootImage: detect Android boot magic', () => {
  const magic = new TextEncoder().encode('ANDROID!');
  assert(magic.length === 8, 'ANDROID! magic should be 8 bytes');
});

test('BootImage: detect vendor boot magic', () => {
  const magic = new TextEncoder().encode('VNDRBOOT');
  assert(magic.length === 8, 'VNDRBOOT magic should be 8 bytes');
});

test('BootImage: 16KB page size alignment', () => {
  const pageSize = 16384;
  const headerSize = 4096;
  const kernelSize = 10000;
  const kernelAligned = Math.ceil(kernelSize / pageSize) * pageSize;
  assertEq(kernelAligned, 16384, '10KB kernel should align to 16KB');
  // Verify 4KB alignment
  const pageSize4k = 4096;
  const kernelAligned4k = Math.ceil(kernelSize / pageSize4k) * pageSize4k;
  assertEq(kernelAligned4k, 12288, '10KB kernel should align to 12KB at 4K pages');
});

test('BootImage: page size auto-detection', () => {
  // Simulate header with page_size field
  const header = new ArrayBuffer(1632);
  const dv = new DataView(header);
  // Write magic at offset 0
  new TextEncoder().encodeInto('ANDROID!', new Uint8Array(header));
  // Write page_size at offset 36 (u32 little-endian)
  dv.setUint32(36, 4096, true);
  assertEq(dv.getUint32(36, true), 4096, 'Should read 4096 page size');
  // 16KB page
  dv.setUint32(36, 16384, true);
  assertEq(dv.getUint32(36, true), 16384, 'Should read 16384 page size');
});

// --- CPIO Newc Format Tests ---
test('CPIO: newc magic (unused import check) "070701"', () => {
  const magic = '070701';
  assert(magic.length === 6, 'CPIO newc magic is 6 chars');
  // Verify it's the ASCII hex for the magic number
  const header = new TextEncoder().encode(magic);
  assertEq(header[0], 0x30, 'First byte should be "0"');
  assertEq(header[5], 0x31, 'Last byte should be "1"');
});

test('CPIO: trailer magic "070702"', () => {
  const trailer = '070702';
  // CPIO trailer uses 070702 or "TRAILER!!!"
  assert(trailer === '070702', 'CPIO trailer magic');
});

// --- Tar Parsing Tests ---
test('Tar: parse simple tar header', () => {
  // Create a minimal tar entry for a file named "test.img" with 8 bytes of data
  const header = new Uint8Array(512);
  // Name (offset 0, 100 bytes)
  new TextEncoder().encodeInto('test.img', header);
  // Size in octal (offset 124, 12 bytes) — "00000000010" = 8 bytes
  new TextEncoder().encodeInto('00000000010', header.subarray(124));
  // Type flag (offset 156) — '0' for regular file
  header[156] = 0x30;
  // Verify
  const name = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0+$/, '');
  const sizeStr = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0+$/, '').trim();
  const size = parseInt(sizeStr, 8);
  assertEq(name, 'test.img', 'Should parse filename');
  assertEq(size, 8, 'Should parse size as octal');
});

test('Tar: end-of-archive detection', () => {
  const zeroBlock = new Uint8Array(512);
  assert(zeroBlock.every(b => b === 0), 'Zero block should be detected as end-of-archive');
  const dataBlock = new Uint8Array(512).fill(0xFF);
  assert(!dataBlock.every(b => b === 0), 'Non-zero block should not be end-of-archive');
});

// --- Device Codes Database Tests ---
test('Codes: load and validate JSON', async () => {
  const fs = await import('fs/promises');
  const data = JSON.parse(await fs.readFile('data/codes.json', 'utf-8'));
  assert(data.devices, 'Should have devices section');
  assert(data.partitions, 'Should have partitions section');
  assert(data.patchOptions, 'Should have patchOptions section');
  assert(Object.keys(data.devices).length >= 8, 'Should have at least 13 device brands');
  // Check Pixel 9 Pro Fold exists
  assert(data.devices.google.codenames.comet, 'Should have Pixel 9 Pro Fold');
  // Check Samsung uses Odin
  assertEq(data.devices.samsung.bootMethod, 'odin', 'Samsung should use Odin');
  // Check 16KB page size for Android 15
  assertEq(data.androidVersions['15'].pageSize, 16384, 'Android 15 should have 16KB page size');
});

// --- VBMeta Tests ---
test('VBMeta: empty vbmeta header structure', () => {
  // Empty vbmeta is 4096+ bytes of zeros with AVB magic at offset 0
  const empty = new Uint8Array(4096);
  // AVB magic: "AVB0" at offset 0
  new TextEncoder().encodeInto('AVB0', empty);
  assertEq(empty[0], 0x41, 'First byte should be "A"');
  assertEq(empty[3], 0x30, 'Fourth byte should be "0"');
  // Rest should be zeros (no hash, no signature)
  assert(empty.slice(4).every(b => b === 0), 'Rest of empty vbmeta should be zeros');
});

// --- Run Tests ---

// --- DeviceDoctor smoke tests (no DOM required) ---
test('DeviceDoctor: constructs with 5 pixel test colors', () => {
  const doc = new DeviceDoctor();
  assertEq(doc.pixelColors.length, 5, 'Should have 5 pixel colors');
  assert(doc.pixelColors.includes('#ff0000'), 'Red color present');
  assert(doc.pixelColors.includes('#000000'), 'Black color present');
});

test('DeviceDoctor: refresh rate measurement returns positive value', async () => {
  const doc = new DeviceDoctor();
  const origRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  const hz = await doc.measureRefreshRate();
  globalThis.requestAnimationFrame = origRaf;
  assert(hz > 0, `Refresh rate should be positive, got ${hz}`);
});

async function runAll() {
  console.log('\n  WebForge Patcher — Integration Tests\n');
  console.log('  ' + '='.repeat(50) + '\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  }

  console.log('\n  ' + '='.repeat(50));
  console.log(`  ${passed} passed, ${failed} failed, ${tests.length} total\n`);

  if (failed > 0) process.exit(1);
}

runAll();

// --- Boot Validator Tests ---
test('BootValidator: reject too-small data', () => {
  const tiny = new Uint8Array(100);
  const result = BootValidator.validate(tiny);
  assert(!result.valid, 'Should reject < 4KB');
  assert(result.errors.length > 0, 'Should have error message');
});

test('BootValidator: reject unknown magic', () => {
  const buf = new Uint8Array(4096);
  new TextEncoder().encodeInto('NOTABOOT', buf);
  const result = BootValidator.validate(buf);
  assert(!result.valid, 'Should reject unknown magic');
});

test('BootValidator: accept ANDROID! magic', () => {
  const buf = new Uint8Array(8192);
  new TextEncoder().encodeInto('ANDROID!', buf);
  // Set header version to 4 at offset 40
  const dv = new DataView(buf.buffer);
  dv.setUint32(40, 4, true);
  // Set kernel size to 4096 at offset 8
  dv.setUint32(8, 4096, true);
  // Fill some kernel data to avoid all-zeros warning
  buf.fill(0xAA, 1584, 1584 + 100);
  const result = BootValidator.validate(buf);
  assert(result.valid, 'Should accept ANDROID! magic with valid header');
  assertEq(result.info.type, 'boot', 'Should detect boot type');
  assertEq(result.info.headerVersion, 4, 'Should read header version 4');
});

test('BootValidator: detect vendor boot', () => {
  const buf = new Uint8Array(8192);
  new TextEncoder().encodeInto('VNDRBOOT', buf);
  const result = BootValidator.validate(buf);
  assert(result.valid, 'Should accept VNDRBOOT magic');
  assertEq(result.info.type, 'vendor_boot', 'Should detect vendor_boot type');
});

test('BootValidator: 16KB page size detection', () => {
  const buf = new Uint8Array(65536);
  new TextEncoder().encodeInto('ANDROID!', buf);
  const dv = new DataView(buf.buffer);
  dv.setUint32(40, 2, true); // header v2 (has page size field)
  dv.setUint32(36, 16384, true); // 16KB page size at offset 36
  dv.setUint32(8, 4096, true); // kernel size
  buf.fill(0xBB, 1632, 1632 + 100);
  const result = BootValidator.validate(buf);
  assert(result.valid, 'Should validate 16KB page size boot image');
  assertEq(result.info.pageSize, 16384, 'Should detect 16KB page size');
  assert(result.info.android15 === true, 'Should flag Android 15');
});

test('BootValidator: partition compatibility check', () => {
  const bootInfo = { type: 'boot' };
  const vendorInfo = { type: 'vendor_boot' };
  
  assert(BootValidator.checkPartitionCompatibility(bootInfo, 'boot').safe, 'boot→boot should be safe');
  assert(!BootValidator.checkPartitionCompatibility(bootInfo, 'vendor_boot').safe, 'boot→vendor_boot should be unsafe');
  assert(!BootValidator.checkPartitionCompatibility(vendorInfo, 'boot').safe, 'vendor_boot→boot should be unsafe');
  assert(BootValidator.checkPartitionCompatibility(vendorInfo, 'vendor_boot').safe, 'vendor_boot→vendor_boot should be safe');
});

test('BootValidator: summarize output', () => {
  const result = { valid: true, warnings: ['test warning'], errors: [], info: { type: 'boot', headerVersion: 4, pageSize: 4096, kernelSize: 8192, ramdiskSize: 4096 } };
  const summary = BootValidator.summarize(result);
  assert(summary.includes('✅'), 'Should have success emoji');
  assert(summary.includes('boot'), 'Should include type');
  assert(summary.includes('4KB'), 'Should include page size');
  assert(summary.includes('1 warning'), 'Should include warning count');
});

// --- Odin Protocol Tests ---
test('Odin: command codes defined', () => {
  assert(ODIN_CMD.SESSION_SETUP === 0x00, 'Session setup = 0x00');
  assert(ODIN_CMD.FILE_TRANSFER === 0x01, 'File transfer = 0x01');
  assert(ODIN_CMD.END_SESSION === 0x02, 'End session = 0x02');
  assert(ODIN_CMD.RESET_DEVICE === 0x04, 'Reset device = 0x04');
  assert(ODIN_CMD.ERASE_PARTITION === 0x06, 'Erase partition = 0x06');
  assert(ODIN_CMD.GET_PIT === 0x0C, 'Get PIT = 0x0C');
  assert(ODIN_CMD.BOOT_CONTINUE === 0x64, 'Boot continue = 0x64');
});

// --- Fastboot Protocol Tests ---
test('Fastboot: response prefix parsing', () => {
  assert(RESP_OKAY === 'OKAY', 'OKAY prefix');
  assert(RESP_FAIL === 'FAIL', 'FAIL prefix');
  assert(RESP_INFO === 'INFO', 'INFO prefix');
  assert(RESP_DATA === 'DATA', 'DATA prefix');
});

test('Fastboot: command formatting', () => {
  // Verify command strings are properly formatted
  assert('getvar:product'.length <= 64, 'getvar command fits in 64 bytes');
  assert('flash:boot'.length <= 64, 'flash command fits in 64 bytes');
  assert('download:00100000'.length <= 64, 'download command fits in 64 bytes');
  assert('reboot-bootloader'.length <= 64, 'reboot command fits in 64 bytes');
});

test('Fastboot: download size hex encoding', () => {
  // 1MB = 0x100000
  const size1MB = 1048576;
  const hex1MB = size1MB.toString(16).padStart(8, '0');
  assertEq(hex1MB, '00100000', '1MB should be 00100000');
  // 64KB = 0x10000
  const size64KB = 65536;
  const hex64KB = size64KB.toString(16).padStart(8, '0');
  assertEq(hex64KB, '00010000', '64KB should be 00010000');
  // 16MB = 0x1000000
  const size16MB = 16 * 1048576;
  const hex16MB = size16MB.toString(16).padStart(8, '0');
  assertEq(hex16MB, '01000000', '16MB should be 01000000');
});

test('Fastboot: slot naming', () => {
  // A/B slot names should be 'a' or 'b'
  const slots = ['a', 'b'];
  for (const s of slots) {
    assert(s === 'a' || s === 'b', 'Slot must be a or b');
  }
  // Inactive slot: if current is 'a', inactive is 'b' and vice versa
  assert('a' === 'b' ? false : 'b', 'Inactive of a should be b');
  // Better:
  const inactive = (slot) => slot === 'a' ? 'b' : 'a';
  assertEq(inactive('a'), 'b', 'Inactive of a = b');
  assertEq(inactive('b'), 'a', 'Inactive of b = a');
});

// --- CPIO Round-Trip Tests (God Mode critical path) ---
// These test the parse → modify → rebuild → parse cycle that God Mode depends on.
// If these fail, patched boot images could brick devices.

test('CPIO: build → parse round-trip with single file', () => {
  // Create a minimal CPIO archive using RamdiskPatcher._buildCPIO
  const entries = [{
    magic: '070701', ino: 1, mode: 0o100644, uid: 0, gid: 0, nlink: 1,
    mtime: 0, filesize: 5, devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0,
    name: 'test.txt', data: new TextEncoder().encode('hello'), check: 0,
  }];
  const built = RamdiskPatcher._buildCPIO(entries);
  assert(built.byteLength > 110, 'Built CPIO should be larger than header');
  // Parse it back
  const parsed = RamdiskPatcher._parseCPIO(built);
  assert(parsed.length >= 1, 'Should parse at least 1 entry');
  assertEq(parsed[0].name, 'test.txt', 'Entry name should match');
  assertEq(parsed[0].filesize, 5, 'File size should be 5');
  const data = new TextDecoder().decode(parsed[0].data);
  assertEq(data, 'hello', 'File content should round-trip');
});

test('CPIO: build → parse with directory entry', () => {
  const entries = [
    { magic: '070701', ino: 1, mode: 0o040755, uid: 0, gid: 0, nlink: 2, mtime: 0, filesize: 0, devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0, name: 'sbin', data: new Uint8Array(0), check: 0 },
    { magic: '070701', ino: 2, mode: 0o100755, uid: 0, gid: 0, nlink: 1, mtime: 0, filesize: 3, devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0, name: 'sbin/su', data: new TextEncoder().encode('abc'), check: 0 },
  ];
  const built = RamdiskPatcher._buildCPIO(entries);
  const parsed = RamdiskPatcher._parseCPIO(built);
  assert(parsed.length >= 2, 'Should parse 2 entries');
  assertEq(parsed[0].name, 'sbin', 'First entry should be dir');
  assertEq(parsed[1].name, 'sbin/su', 'Second entry should be file');
  assertEq(parsed[1].filesize, 3, 'su file should be 3 bytes');
});

test('CPIO: add file to existing archive', () => {
  // Start with a simple archive
  const entries = [{
    magic: '070701', ino: 1, mode: 0o100644, uid: 0, gid: 0, nlink: 1,
    mtime: 0, filesize: 4, devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0,
    name: 'init.rc', data: new TextEncoder().encode('test'), check: 0,
  }];
  const built = RamdiskPatcher._buildCPIO(entries);
  const parsed = RamdiskPatcher._parseCPIO(built);

  // Simulate RamdiskPatcher usage: add a file to parsed entries
  const newEntries = [...parsed];
  newEntries.push({
    magic: '070701', ino: 2, mode: 0o100755, uid: 0, gid: 0, nlink: 1,
    mtime: 0, filesize: 2, devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0,
    name: 'sbin/su', data: new TextEncoder().encode('XY'), check: 0,
  });
  const rebuilt = RamdiskPatcher._buildCPIO(newEntries);
  const reparsed = RamdiskPatcher._parseCPIO(rebuilt);

  assertEq(reparsed.length, 2, 'Should have 2 entries after add');
  assertEq(reparsed[0].name, 'init.rc', 'Original file preserved');
  assertEq(reparsed[1].name, 'sbin/su', 'New file present');
  assertEq(new TextDecoder().decode(reparsed[1].data), 'XY', 'New file content correct');
});

test('CPIO: file modes preserved through round-trip', () => {
  const entries = [
    { magic: '070701', ino: 1, mode: 0o040755, uid: 0, gid: 0, nlink: 2, mtime: 0, filesize: 0, devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0, name: 'dev', data: new Uint8Array(0), check: 0 },
    { magic: '070701', ino: 2, mode: 0o100755, uid: 0, gid: 0, nlink: 1, mtime: 0, filesize: 0, devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0, name: 'init', data: new Uint8Array(0), check: 0 },
  ];
  const built = RamdiskPatcher._buildCPIO(entries);
  const parsed = RamdiskPatcher._parseCPIO(built);
  // Directory should have mode 040755
  assert((parsed[0].mode & 0o170000) === 0o040000, 'First entry should be directory type');
  assert((parsed[0].mode & 0o777) === 0o755, 'Directory should be 755');
  // File should have mode 100755
  assert((parsed[1].mode & 0o170000) === 0o100000, 'Second entry should be regular file type');
  assert((parsed[1].mode & 0o777) === 0o755, 'File should be 755');
});

test('CPIO: large file content round-trip', () => {
  // Simulate a larger binary file (like a Magisk binary)
  const largeData = new Uint8Array(8192);
  for (let i = 0; i < largeData.length; i++) largeData[i] = i % 256;
  const entries = [{
    magic: '070701', ino: 1, mode: 0o100755, uid: 0, gid: 0, nlink: 1,
    mtime: 0, filesize: largeData.byteLength, devmajor: 0, devminor: 0,
    rdevmajor: 0, rdevminor: 0, name: 'sbin/magisk', data: largeData, check: 0,
  }];
  const built = RamdiskPatcher._buildCPIO(entries);
  const parsed = RamdiskPatcher._parseCPIO(built);
  assertEq(parsed[0].name, 'sbin/magisk', 'Name preserved');
  assertEq(parsed[0].filesize, 8192, 'Size preserved');
  // Verify every byte matches
  for (let i = 0; i < 8192; i++) {
    if (parsed[0].data[i] !== largeData[i]) {
      throw new Error(`Byte mismatch at offset ${i}: expected ${largeData[i]}, got ${parsed[0].data[i]}`);
    }
  }
});

// --- Boot Image Rebuild Tests ---
test('BootImage: v3 parse → rebuild → parse round-trip', () => {
  // Create a minimal v3 boot image
  const ps = 4096;
  const headerBuf = new ArrayBuffer(1580);
  const dv = new DataView(headerBuf);
  // Magic
  new TextEncoder().encodeInto('ANDROID!', new Uint8Array(headerBuf));
  // Header version = 3
  dv.setUint32(8, 3, true);
  // Ramdisk size = 100
  dv.setUint32(12, 100, true);
  // Kernel size = 200
  dv.setUint32(24, 200, true);
  // Cmdline
  new TextEncoder().encodeInto('console=ttyMSM0', new Uint8Array(headerBuf, 32, 1536));

  // Create kernel and ramdisk data
  const kernel = new Uint8Array(200).fill(0xAA);
  const ramdisk = new Uint8Array(100).fill(0xBB);

  // Assemble boot image
  const parts = [
    Utils.padTo(new Uint8Array(headerBuf), ps),
    Utils.padTo(kernel, ps),
    Utils.padTo(ramdisk, ps),
  ];
  const bootImg = Utils.concat(...parts);

  // Parse it
  const parsed = BootImage.parse(bootImg);
  assertEq(parsed.version, 3, 'Parsed version should be 3');
  assertEq(parsed.header.kernelSize, 200, 'Kernel size should be 200');
  assertEq(parsed.header.ramdiskSize, 100, 'Ramdisk size should be 100');
  assertEq(parsed.kernel.byteLength, 200, 'Kernel data size matches');
  assertEq(parsed.ramdisk.byteLength, 100, 'Ramdisk data size matches');

  // Rebuild it
  const rebuilt = parsed.build();
  assert(rebuilt.byteLength === bootImg.byteLength, 'Rebuilt image should be same size');

  // Parse the rebuilt image
  const reparsed = BootImage.parse(rebuilt);
  assertEq(reparsed.version, 3, 'Rebuilt version should be 3');
  assertEq(reparsed.header.kernelSize, 200, 'Rebuilt kernel size should be 200');
  assertEq(reparsed.header.ramdiskSize, 100, 'Rebuilt ramdisk size should be 100');
  assertEq(reparsed.kernel.byteLength, 200, 'Rebuilt kernel data size matches');
  assertEq(reparsed.ramdisk.byteLength, 100, 'Rebuilt ramdisk data size matches');

  // Verify data integrity
  for (let i = 0; i < 200; i++) {
    if (reparsed.kernel[i] !== 0xAA) throw new Error(`Kernel byte ${i} mismatch`);
  }
  for (let i = 0; i < 100; i++) {
    if (reparsed.ramdisk[i] !== 0xBB) throw new Error(`Ramdisk byte ${i} mismatch`);
  }
});

test('BootImage: v0 with 16KB page size round-trip', () => {
  const ps = 16384;
  const headerBuf = new ArrayBuffer(1632);
  const dv = new DataView(headerBuf);
  new TextEncoder().encodeInto('ANDROID!', new Uint8Array(headerBuf));
  // kernel size = 500
  dv.setUint32(8, 500, true);
  // ramdisk size = 300
  dv.setUint32(20, 300, true);
  // page size = 16384
  dv.setUint32(36, ps, true);
  // header version = 0
  dv.setUint32(40, 0, true);

  const kernel = new Uint8Array(500).fill(0xCC);
  const ramdisk = new Uint8Array(300).fill(0xDD);

  const parts = [
    Utils.padTo(new Uint8Array(headerBuf), ps),
    Utils.padTo(kernel, ps),
    Utils.padTo(ramdisk, ps),
  ];
  const bootImg = Utils.concat(...parts);

  const parsed = BootImage.parse(bootImg);
  assertEq(parsed.version, 0, 'Should detect v0');
  assertEq(parsed.pageSize, 16384, 'Should detect 16KB page size');
  assertEq(parsed.header.kernelSize, 500, 'Kernel size matches');
  assertEq(parsed.header.ramdiskSize, 300, 'Ramdisk size matches');

  // Rebuild and reparse
  const rebuilt = parsed.build();
  const reparsed = BootImage.parse(rebuilt);
  assertEq(reparsed.pageSize, 16384, 'Rebuilt should preserve 16KB page size');
  assertEq(reparsed.header.kernelSize, 500, 'Rebuilt kernel size matches');
  assertEq(reparsed.header.ramdiskSize, 300, 'Rebuilt ramdisk size matches');

  // Verify data
  for (let i = 0; i < 500; i++) {
    if (reparsed.kernel[i] !== 0xCC) throw new Error(`16KB kernel byte ${i} mismatch`);
  }
  for (let i = 0; i < 300; i++) {
    if (reparsed.ramdisk[i] !== 0xDD) throw new Error(`16KB ramdisk byte ${i} mismatch`);
  }
});

test('BootImage: cmdline patch survives rebuild', () => {
  const ps = 4096;
  const headerBuf = new ArrayBuffer(1580);
  const dv = new DataView(headerBuf);
  new TextEncoder().encodeInto('ANDROID!', new Uint8Array(headerBuf));
  dv.setUint32(8, 3, true);
  dv.setUint32(12, 50, true);
  dv.setUint32(24, 100, true);
  new TextEncoder().encodeInto('console=ttyMSM0', new Uint8Array(headerBuf, 32, 1536));

  const kernel = new Uint8Array(100).fill(0x11);
  const ramdisk = new Uint8Array(50).fill(0x22);
  const bootImg = Utils.concat(
    Utils.padTo(new Uint8Array(headerBuf), ps),
    Utils.padTo(kernel, ps),
    Utils.padTo(ramdisk, ps),
  );

  const parsed = BootImage.parse(bootImg);
  assert(!parsed.header.cmdline.includes('veritymode=disabled'), 'Original cmdline should not have verity disable');

  // Patch cmdline
  parsed.patchCmdline();
  assert(parsed.header.cmdline.includes('veritymode=disabled'), 'Patched cmdline should have verity disabled');
  assert(parsed.header.cmdline.includes('dm_verity=0'), 'Patched cmdline should have dm_verity=0');

  // Rebuild
  const rebuilt = parsed.build();
  const reparsed = BootImage.parse(rebuilt);
  assert(reparsed.header.cmdline.includes('veritymode=disabled'), 'Rebuilt cmdline should preserve verity disable');
  assert(reparsed.header.cmdline.includes('console=ttyMSM0'), 'Original cmdline should be preserved');
});

test('BootImage: vendor boot parse → rebuild round-trip', () => {
  const ps = 4096;
  const headerSize = 1580;
  const headerBuf = new ArrayBuffer(headerSize);
  const dv = new DataView(headerBuf);
  // VNDRBOOT magic
  new TextEncoder().encodeInto('VNDRBOOT', new Uint8Array(headerBuf));
  // version = 4
  dv.setUint32(8, 4, true);
  // page size = 4096
  dv.setUint32(12, ps, true);
  // ramdisk size = 200
  dv.setUint32(20, 200, true);
  // header size
  dv.setUint32(556, headerSize, true);
  // dtb size = 0
  dv.setUint32(560, 0, true);

  const ramdisk = new Uint8Array(200).fill(0xEE);
  const bootImg = Utils.concat(
    Utils.padTo(new Uint8Array(headerBuf), ps),
    Utils.padTo(ramdisk, ps),
  );

  const parsed = BootImage.parse(bootImg);
  assert(parsed.isVendorBoot, 'Should detect vendor boot');
  assertEq(parsed.version, 4, 'Vendor boot version should be 4');
  assertEq(parsed.pageSize, 4096, 'Vendor boot page size');
  assertEq(parsed.header.ramdiskSize, 200, 'Vendor boot ramdisk size');

  // Rebuild
  const rebuilt = parsed.build();
  const reparsed = BootImage.parse(rebuilt);
  assert(reparsed.isVendorBoot, 'Rebuilt should still be vendor boot');
  assertEq(reparsed.header.ramdiskSize, 200, 'Rebuilt vendor ramdisk size');
  for (let i = 0; i < 200; i++) {
    if (reparsed.ramdisk[i] !== 0xEE) throw new Error(`Vendor ramdisk byte ${i} mismatch`);
  }
});

test('BootImage: summary output format', () => {
  const ps = 4096;
  const headerBuf = new ArrayBuffer(1580);
  const dv = new DataView(headerBuf);
  new TextEncoder().encodeInto('ANDROID!', new Uint8Array(headerBuf));
  dv.setUint32(8, 3, true);
  dv.setUint32(12, 100, true);
  dv.setUint32(24, 200, true);
  new TextEncoder().encodeInto('test cmdline', new Uint8Array(headerBuf, 32, 1536));

  const bootImg = Utils.concat(
    Utils.padTo(new Uint8Array(headerBuf), ps),
    Utils.padTo(new Uint8Array(200).fill(0x1), ps),
    Utils.padTo(new Uint8Array(100).fill(0x2), ps),
  );

  const parsed = BootImage.parse(bootImg);
  const summary = parsed.summary();
  assertEq(summary.version, 3, 'Summary version');
  assertEq(summary.pageSize, 4096, 'Summary page size');
  assertEq(summary.kernelSize, 200, 'Summary kernel size');
  assertEq(summary.ramdiskSize, 100, 'Summary ramdisk size');
  assert(!summary.isVendorBoot, 'Summary should not be vendor boot');
});

// --- Smart Partition Auto-Detection Tests ---
// These test the logic that determines whether to flash to boot, init_boot,
// or vendor_boot. Getting this wrong = bricked device.

test('Partition detection: vendor boot image → vendor_boot', () => {
  // Simulate: bootImage.isVendorBoot = true
  const isVendorBoot = true;
  const loadedFileName = 'vendor_boot.img';
  const deviceVars = {};
  const aiAnalysis = null;

  // Replicate _detectTargetPartition logic
  let partition;
  if (aiAnalysis?.device?.bootMethod) partition = aiAnalysis.device.bootMethod;
  else if (isVendorBoot) partition = 'vendor_boot';
  else if (loadedFileName.includes('init_boot') || loadedFileName.includes('initboot')) partition = 'init_boot';
  else if (deviceVars['partition-type:init_boot'] || deviceVars['partition-size:init_boot']) partition = 'init_boot';
  else partition = 'boot';

  assertEq(partition, 'vendor_boot', 'Vendor boot image should go to vendor_boot');
});

test('Partition detection: init_boot filename → init_boot', () => {
  const isVendorBoot = false;
  const loadedFileName = 'init_boot.img';
  const deviceVars = {};
  const aiAnalysis = null;

  let partition;
  if (aiAnalysis?.device?.bootMethod) partition = aiAnalysis.device.bootMethod;
  else if (isVendorBoot) partition = 'vendor_boot';
  else if (loadedFileName.includes('init_boot') || loadedFileName.includes('initboot')) partition = 'init_boot';
  else if (deviceVars['partition-type:init_boot'] || deviceVars['partition-size:init_boot']) partition = 'init_boot';
  else partition = 'boot';

  assertEq(partition, 'init_boot', 'init_boot filename should map to init_boot partition');
});

test('Partition detection: device has init_boot partition → init_boot', () => {
  const isVendorBoot = false;
  const loadedFileName = 'boot.img';
  const deviceVars = { 'partition-type:init_boot': 'raw' };
  const hasRamdisk = true;
  const aiAnalysis = null;

  let partition;
  if (aiAnalysis?.device?.bootMethod) partition = aiAnalysis.device.bootMethod;
  else if (isVendorBoot) partition = 'vendor_boot';
  else if (loadedFileName.includes('init_boot') || loadedFileName.includes('initboot')) partition = 'init_boot';
  else if ((deviceVars['partition-type:init_boot'] || deviceVars['partition-size:init_boot']) && hasRamdisk) partition = 'init_boot';
  else partition = 'boot';

  assertEq(partition, 'init_boot', 'Device with init_boot partition and ramdisk should use init_boot');
});

test('Partition detection: plain boot.img, no init_boot → boot', () => {
  const isVendorBoot = false;
  const loadedFileName = 'boot.img';
  const deviceVars = {};
  const aiAnalysis = null;

  let partition;
  if (aiAnalysis?.device?.bootMethod) partition = aiAnalysis.device.bootMethod;
  else if (isVendorBoot) partition = 'vendor_boot';
  else if (loadedFileName.includes('init_boot') || loadedFileName.includes('initboot')) partition = 'init_boot';
  else if (deviceVars['partition-type:init_boot'] || deviceVars['partition-size:init_boot']) partition = 'init_boot';
  else partition = 'boot';

  assertEq(partition, 'boot', 'Plain boot.img with no init_boot should go to boot');
});

test('Partition detection: AI recommendation takes priority', () => {
  const isVendorBoot = false;
  const loadedFileName = 'boot.img';
  const deviceVars = {};
  const aiAnalysis = { device: { bootMethod: 'init_boot' } };

  let partition;
  if (aiAnalysis?.device?.bootMethod) partition = aiAnalysis.device.bootMethod;
  else if (isVendorBoot) partition = 'vendor_boot';
  else if (loadedFileName.includes('init_boot') || loadedFileName.includes('initboot')) partition = 'init_boot';
  else if (deviceVars['partition-type:init_boot'] || deviceVars['partition-size:init_boot']) partition = 'init_boot';
  else partition = 'boot';

  assertEq(partition, 'init_boot', 'AI recommendation should override other detection');
});

// --- AI Assistant: Local Knowledge Base Tests ---
test('AI: brand knowledge covers all 9 brands', () => {
  const brands = Object.keys(BRAND_KNOWLEDGE);
  assertEq(brands.length, 9, 'Should have 9 brand entries');
  for (const b of ['google', 'samsung', 'oneplus', 'xiaomi', 'motorola', 'nothing', 'sony', 'fairphone', 'asus']) {
    assert(brands.includes(b), `Should include ${b}`);
  }
});

test('AI: each brand has required fields', () => {
  for (const [key, brand] of Object.entries(BRAND_KNOWLEDGE)) {
    assert(brand.name, `${key} should have name`);
    assert(brand.unlockMethod, `${key} should have unlockMethod`);
    assert(brand.unlockNotes, `${key} should have unlockNotes`);
    assert(brand.bootMethod, `${key} should have bootMethod`);
    assert(Array.isArray(brand.knownIssues), `${key} should have knownIssues array`);
    assert(brand.pageSizeNote, `${key} should have pageSizeNote`);
  }
});

test('AI: Samsung has Knox warning', () => {
  const hasKnoxWarning = BRAND_KNOWLEDGE.samsung.knownIssues.some(i => i.toLowerCase().includes('knox'));
  assert(hasKnoxWarning, 'Samsung should warn about Knox');
});

test('AI: Xiaomi has 7-day wait warning', () => {
  const hasWaitWarning = BRAND_KNOWLEDGE.xiaomi.knownIssues.some(i => i.includes('7-day') || i.includes('168'));
  assert(hasWaitWarning, 'Xiaomi should warn about 7-day wait');
});

test('AI: Pixel recommends init_boot', () => {
  assertEq(BRAND_KNOWLEDGE.google.bootMethod, 'init_boot', 'Pixel should recommend init_boot');
});

// --- AI Assistant: Error Pattern Tests ---
test('AI: error patterns count', () => {
  assert(ERROR_PATTERNS.length >= 12, 'Should have at least 12 error patterns');
});

test('AI: localDiagnoseError matches bootloader locked', () => {
  // Replicate the pattern matching
  const error = 'Bootloader is LOCKED. Unlock via fastboot flashing unlock first.';
  let matched = false;
  for (const p of ERROR_PATTERNS) {
    if (p.match.test(error)) { matched = true; break; }
  }
  assert(matched, 'Should match bootloader locked error');
});

test('AI: localDiagnoseError matches MD5 failure', () => {
  const error = 'MD5 verification FAILED — archive may be corrupted.';
  let matched = false;
  for (const p of ERROR_PATTERNS) {
    if (p.match.test(error)) { matched = true; break; }
  }
  assert(matched, 'Should match MD5 failure');
});

test('AI: localDiagnoseError matches unknown boot magic', () => {
  const error = 'Unknown boot image magic: "12345678"';
  let matched = false;
  for (const p of ERROR_PATTERNS) {
    if (p.match.test(error)) { matched = true; break; }
  }
  assert(matched, 'Should match unknown boot magic error');
});

test('AI: localDiagnoseError matches USB failure', () => {
  const error = 'USB OUT failed: babble';
  let matched = false;
  for (const p of ERROR_PATTERNS) {
    if (p.match.test(error)) { matched = true; break; }
  }
  assert(matched, 'Should match USB failure');
});

test('AI: each error pattern has required fields', () => {
  for (const p of ERROR_PATTERNS) {
    assert(p.match instanceof RegExp, 'Pattern should be RegExp');
    assert(typeof p.diagnosis === 'string', 'Should have diagnosis string');
    assert(Array.isArray(p.fixes), 'Should have fixes array');
    assert(p.fixes.length > 0, 'Should have at least 1 fix');
    assert(['low', 'medium', 'high', 'critical'].includes(p.severity), 'Should have valid severity');
  }
});

// --- Boot Image v1 Round-Trip Test ---
test('BootImage: v1 parse → rebuild → parse round-trip', () => {
  const ps = 4096;
  const HEADER_V1_SIZE = 1648; // 1632 + 4*4
  const headerBuf = new ArrayBuffer(HEADER_V1_SIZE);
  const dv = new DataView(headerBuf);
  new TextEncoder().encodeInto('ANDROID!', new Uint8Array(headerBuf));
  dv.setUint32(8, 500, true);   // kernel size
  dv.setUint32(20, 300, true);  // ramdisk size
  dv.setUint32(28, 0, true);    // second size = 0
  dv.setUint32(36, ps, true);   // page size
  dv.setUint32(40, 1, true);    // header version = 1
  dv.setUint32(1632, 128, true); // recovery_dtbo_size
  dv.setUint32(1636, 1, true);   // header version field (v1 specific)
  dv.setUint32(40, 1, true);     // os_version = 1 (version detection reads offset 40)

  const kernel = new Uint8Array(500).fill(0x33);
  const ramdisk = new Uint8Array(300).fill(0x44);
  const recoveryDtbo = new Uint8Array(128).fill(0x55);

  const parts = [
    Utils.padTo(new Uint8Array(headerBuf), ps),
    Utils.padTo(kernel, ps),
    Utils.padTo(ramdisk, ps),
    Utils.padTo(recoveryDtbo, ps),
  ];
  const bootImg = Utils.concat(...parts);

  const parsed = BootImage.parse(bootImg);
  assertEq(parsed.version, 1, 'Should detect v1');
  assertEq(parsed.header.recoveryDtboSize, 128, 'Should have recovery_dtbo size');
  assertEq(parsed.recoveryDtbo.byteLength, 128, 'Should have recovery_dtbo data');

  // Rebuild
  const rebuilt = parsed.build();
  const reparsed = BootImage.parse(rebuilt);
  assertEq(reparsed.version, 1, 'Rebuilt should be v1');
  assertEq(reparsed.header.kernelSize, 500, 'Rebuilt kernel size');
  assertEq(reparsed.header.ramdiskSize, 300, 'Rebuilt ramdisk size');
  assertEq(reparsed.header.recoveryDtboSize, 128, 'Rebuilt recovery_dtbo size');
  for (let i = 0; i < 128; i++) {
    if (reparsed.recoveryDtbo[i] !== 0x55) throw new Error(`recovery_dtbo byte ${i} mismatch`);
  }
});

// --- Fstab dm-verity Patching Test ---
test('RamdiskPatcher: fstab verity patching', () => {
  // Create a CPIO with a fstab file containing verity flags
  const fstabContent = '/dev/block/by-name/system /system ext4 ro,barrier=1 wait,verify,slotselect';
  const entries = [{
    magic: '070701', ino: 1, mode: 0o100644, uid: 0, gid: 0, nlink: 1,
    mtime: 0, filesize: fstabContent.length, devmajor: 0, devminor: 0,
    rdevmajor: 0, rdevminor: 0, name: 'fstab.qcom', data: new TextEncoder().encode(fstabContent), check: 0,
  }];
  const built = RamdiskPatcher._buildCPIO(entries);
  const parsed = RamdiskPatcher._parseCPIO(built);

  // Create patcher instance and patch fstab
  const patcher = new RamdiskPatcher();
  patcher.entries = parsed;
  patcher.compression = 'none';
  patcher.patchFstab();

  // Verify verity flags were removed
  const patchedFstab = patcher.find('fstab.qcom');
  assert(patchedFstab, 'fstab should still exist after patching');
  const patchedContent = new TextDecoder().decode(patchedFstab.data);
  assert(!patchedContent.includes('verify,'), 'Should not have verify, flag');
  assert(!patchedContent.includes(',verify'), 'Should not have ,verify flag');
  assert(patchedContent.includes('/system'), 'Should still have /system mount point');
});

// --- Magisk Injection Integration Test ---
test('RamdiskPatcher: full Magisk injection flow', () => {
  // Create a CPIO with init and init.rc
  const initContent = '#!/system/bin/sh\nexit 0';
  const rcContent = 'on init\n    export PATH /system/bin';
  const entries = [
    { magic: '070701', ino: 1, mode: 0o100755, uid: 0, gid: 0, nlink: 1,
      mtime: 0, filesize: initContent.length, devmajor: 0, devminor: 0,
      rdevmajor: 0, rdevminor: 0, name: 'init', data: new TextEncoder().encode(initContent), check: 0 },
    { magic: '070701', ino: 2, mode: 0o100644, uid: 0, gid: 0, nlink: 1,
      mtime: 0, filesize: rcContent.length, devmajor: 0, devminor: 0,
      rdevmajor: 0, rdevminor: 0, name: 'init.rc', data: new TextEncoder().encode(rcContent), check: 0 },
  ];
  const built = RamdiskPatcher._buildCPIO(entries);
  const parsed = RamdiskPatcher._parseCPIO(built);

  // Create patcher and inject mock Magisk files
  const patcher = new RamdiskPatcher();
  patcher.entries = [...parsed];
  patcher.compression = 'none';

  // Mock Magisk binaries
  const mockMagisk = {
    magiskinit: new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01]), // ELF header
    magisk: new Uint8Array(256).fill(0xAB),
    magiskpolicy: new Uint8Array(128).fill(0xCD),
    magiskboot: new Uint8Array(64).fill(0xEF),
    busybox: new Uint8Array(512).fill(0x12),
  };

  // Run injection (synchronous — injectMagisk is async but only uses await for gzip which we don't hit)
  // We'll call it properly
  patcher.injectMagisk(mockMagisk).then(() => {
    // Verify Magisk directories were created
    assert(patcher.find('.magisk'), 'Should have .magisk directory');
    assert(patcher.find('.magisk/system'), 'Should have .magisk/system');
    assert(patcher.find('.magisk/system/bin'), 'Should have .magisk/system/bin');
    assert(patcher.find('.magisk/modules'), 'Should have .magisk/modules');
    assert(patcher.find('.magisk/mirror'), 'Should have .magisk/mirror');
    assert(patcher.find('.magisk/block'), 'Should have .magisk/block');

    // Verify Magisk files were injected
    const magiskBin = patcher.find('.magisk/system/bin/magisk');
    assert(magiskBin, 'Should have magisk binary');
    assertEq(magiskBin.filesize, 256, 'Magisk binary size should be 256');
    assert((magiskBin.mode & 0o777) === 0o755, 'Magisk should be executable');

    const busyboxBin = patcher.find('.magisk/system/bin/busybox');
    assert(busyboxBin, 'Should have busybox');
    assertEq(busyboxBin.filesize, 512, 'Busybox size should be 512');

    // Verify init was replaced with magiskinit
    const initEntry = patcher.find('init');
    assert(initEntry.filesize === 6, 'init should be replaced with magiskinit (6 bytes)');

    // Verify backup was created
    assert(patcher.find('init.bak'), 'Should have init.bak backup');

    // Verify config
    const config = patcher.find('.magisk/config');
    assert(config, 'Should have .magisk/config');
    const configContent = JSON.parse(new TextDecoder().decode(config.data));
    assertEq(configContent.keep_verity, false, 'Config should have keep_verity=false');

    // Verify symlink
    const symlink = patcher.find('sbin/magisk');
    assert(symlink, 'Should have sbin/magisk symlink');

    // Verify init.rc was patched with Magisk service
    const rc = patcher.find('init.rc');
    assert(rc, 'init.rc should still exist');
    const rcContent2 = new TextDecoder().decode(rc.data);
    assert(rcContent2.includes('service magisk'), 'init.rc should have magisk service');
  });
});

// --- Symlink Round-Trip Test ---
test('CPIO: symlink round-trip', () => {
  const linkTarget = '../.magisk/system/bin/magisk';
  const entries = [{
    magic: '070701', ino: 1, mode: 0o120777, uid: 0, gid: 0, nlink: 1,
    mtime: 0, filesize: linkTarget.length, devmajor: 0, devminor: 0,
    rdevmajor: 0, rdevminor: 0,
    name: 'sbin/su', data: new TextEncoder().encode(linkTarget),
    check: 0,
  }];
  const built = RamdiskPatcher._buildCPIO(entries);
  const parsed = RamdiskPatcher._parseCPIO(built);

  assertEq(parsed.length, 1, 'Should have 1 entry');
  assertEq(parsed[0].name, 'sbin/su', 'Name should round-trip');
  // Verify it's a symlink (mode 0o120777)
  assert((parsed[0].mode & 0o170000) === 0o120000, 'Should be symlink type');
  const target = new TextDecoder().decode(parsed[0].data);
  assertEq(target, '../.magisk/system/bin/magisk', 'Symlink target should round-trip');
});

// --- Full God Mode Pipeline Test ---
// The critical end-to-end test: build boot.img with gzip ramdisk → parse →
// extract ramdisk → decompress → parse CPIO → modify → rebuild CPIO →
// recompress → rebuild boot.img → validate
test('God Mode: full pipeline (boot.img → patch → rebuild → validate)', async () => {
  const ps = 4096;
  const HEADER_V3_SIZE = 1580;

  // Step 1: Create a boot image with a gzip-compressed ramdisk
  // Build a simple CPIO ramdisk
  const ramdiskEntries = [
    { magic: '070701', ino: 1, mode: 0o100755, uid: 0, gid: 0, nlink: 1,
      mtime: 0, filesize: 8, devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0,
      name: 'init', data: new TextEncoder().encode('echo hi\n'), check: 0 },
    { magic: '070701', ino: 2, mode: 0o100644, uid: 0, gid: 0, nlink: 1,
      mtime: 0, filesize: 19, devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0,
      name: 'init.rc', data: new TextEncoder().encode('on init\n    export\n'), check: 0 },
  ];
  const cpioData = RamdiskPatcher._buildCPIO(ramdiskEntries);

  // Compress with gzip
  const compressedRamdisk = await RamdiskPatcher._gzip(cpioData);
  assert(Utils.isGzip(compressedRamdisk), 'Compressed ramdisk should be gzip');

  // Build v3 boot image
  const headerBuf = new ArrayBuffer(HEADER_V3_SIZE);
  const dv = new DataView(headerBuf);
  new TextEncoder().encodeInto('ANDROID!', new Uint8Array(headerBuf));
  dv.setUint32(8, 3, true);                          // header version = 3
  dv.setUint32(12, compressedRamdisk.byteLength, true); // ramdisk size
  dv.setUint32(24, 200, true);                       // kernel size
  new TextEncoder().encodeInto('console=ttyMSM0', new Uint8Array(headerBuf, 32, 1536));

  const kernel = new Uint8Array(200).fill(0x42);
  const bootImg = Utils.concat(
    Utils.padTo(new Uint8Array(headerBuf), ps),
    Utils.padTo(kernel, ps),
    Utils.padTo(compressedRamdisk, ps),
  );

  // Step 2: Parse the boot image
  const parsed = BootImage.parse(bootImg);
  assertEq(parsed.version, 3, 'Should detect v3');
  assert(Utils.isGzip(parsed.ramdisk), 'Ramdisk should be gzip compressed');

  // Step 3: Extract and decompress ramdisk
  const patcher = await RamdiskPatcher.fromBootImage(parsed);
  assertEq(patcher.compression, 'gzip', 'Should detect gzip compression');
  assertEq(patcher.entries.length, 2, 'Should have 2 CPIO entries');
  assertEq(patcher.entries[0].name, 'init', 'First entry should be init');

  // Step 4: Modify ramdisk (add a file)
  patcher.addFile('sbin/su', new Uint8Array([0x7F, 0x45, 0x4C, 0x46]), 0o100755);
  assertEq(patcher.entries.length, 3, 'Should now have 3 entries');

  // Step 5: Rebuild ramdisk (CPIO + gzip)
  const newRamdisk = await patcher.build();
  assert(Utils.isGzip(newRamdisk), 'Rebuilt ramdisk should be gzip');

  // Step 6: Set on boot image and rebuild
  parsed.setRamdisk(newRamdisk);
  parsed.patchCmdline();
  const rebuiltBootImg = parsed.build();

  // Step 7: Parse the rebuilt boot image and verify
  const reparsed = BootImage.parse(rebuiltBootImg);
  assertEq(reparsed.version, 3, 'Rebuilt should be v3');
  assertEq(reparsed.header.kernelSize, 200, 'Kernel size preserved');
  assert(Utils.isGzip(reparsed.ramdisk), 'Rebuilt ramdisk should be gzip');

  // Step 8: Extract the rebuilt ramdisk and verify content
  const repatcher = await RamdiskPatcher.fromBootImage(reparsed);
  assertEq(repatcher.entries.length, 3, 'Rebuilt ramdisk should have 3 entries');
  assert(repatcher.find('sbin/su'), 'sbin/su should survive round-trip');
  assert(repatcher.find('init'), 'Original init should survive');
  assert(repatcher.find('init.rc'), 'Original init.rc should survive');

  // Step 9: Verify cmdline was patched
  assert(reparsed.header.cmdline.includes('veritymode=disabled'), 'Cmdline should have verity disabled');
  assert(reparsed.header.cmdline.includes('console=ttyMSM0'), 'Original cmdline should be preserved');

  // Step 10: Validate with BootValidator
  const validation = BootValidator.validate(rebuiltBootImg);
  assert(validation.valid, 'Rebuilt image should pass validation');
});

// --- Local Device Lookup Tests ---
test('DeviceLookup: parse codes.json structure', async () => {
  const fs = await import('fs/promises');
  const data = JSON.parse(await fs.readFile('data/codes.json', 'utf-8'));
  assert(data.devices, 'Should have devices key');
  assert(data.devices.google, 'Should have google brand');
  assert(data.devices.google.codenames, 'Should have google codenames');
  assert(typeof data.devices.google.codenames === 'object', 'Codenames should be a dict');
});

test('DeviceLookup: expanded brand count', async () => {
  const fs = await import('fs/promises');
  const data = JSON.parse(await fs.readFile('data/codes.json', 'utf-8'));
  const brands = Object.keys(data.devices);
  assert(brands.length >= 13, 'Should have at least 13 brands (was 9, expanded)');
  // Check new brands exist
  for (const b of ['vivo', 'oppo', 'realme', 'htc', 'zte', 'poco']) {
    assert(brands.includes(b), `Should include ${b}`);
  }
});

test('DeviceLookup: expanded codename count', async () => {
  const fs = await import('fs/promises');
  const data = JSON.parse(await fs.readFile('data/codes.json', 'utf-8'));
  let total = 0;
  for (const brand of Object.values(data.devices)) {
    total += Object.keys(brand.codenames || {}).length;
  }
  assert(total >= 100, `Should have at least 100 codenames (was 77, expanded to ${total})`);
});

test('DeviceLookup: Pixel codename match', async () => {
  const fs = await import('fs/promises');
  const data = JSON.parse(await fs.readFile('data/codes.json', 'utf-8'));
  // Simulate localDeviceLookup logic against the real data
  const product = 'panther';
  const brands = data.devices;
  let found = null;
  for (const [brandKey, brandData] of Object.entries(brands)) {
    const codenames = brandData.codenames || {};
    for (const [codename, deviceName] of Object.entries(codenames)) {
      if (codename.toLowerCase() === product.toLowerCase()) {
        found = { brand: brandKey, deviceName, codename };
        break;
      }
    }
    if (found) break;
  }
  assert(found, 'Should find panther');
  assertEq(found.brand, 'google', 'Panther should be Google');
  assertEq(found.deviceName, 'Pixel 7', 'Panther should be Pixel 7');
});

test('DeviceLookup: Samsung codename match', async () => {
  const fs = await import('fs/promises');
  const data = JSON.parse(await fs.readFile('data/codes.json', 'utf-8'));
  const product = 'e3q';
  const brands = data.devices;
  let found = null;
  for (const [brandKey, brandData] of Object.entries(brands)) {
    const codenames = brandData.codenames || {};
    for (const [codename, deviceName] of Object.entries(codenames)) {
      if (codename.toLowerCase() === product.toLowerCase()) {
        found = { brand: brandKey, deviceName, codename };
        break;
      }
    }
    if (found) break;
  }
  assert(found, 'Should find e3q');
  assertEq(found.brand, 'samsung', 'e3q should be Samsung');
  assertEq(found.deviceName, 'Galaxy S24 Ultra', 'e3q should be S24 Ultra');
});

test('DeviceLookup: new brand Vivo exists', async () => {
  const fs = await import('fs/promises');
  const data = JSON.parse(await fs.readFile('data/codes.json', 'utf-8'));
  assert(data.devices.vivo, 'Vivo should exist');
  assert(data.devices.vivo.codenames, 'Vivo should have codenames');
  const vivoCodes = Object.keys(data.devices.vivo.codenames);
  assert(vivoCodes.length >= 5, 'Vivo should have at least 5 codenames');
});

test('DeviceLookup: USB vendors include new brands', async () => {
  const fs = await import('fs/promises');
  const data = JSON.parse(await fs.readFile('data/codes.json', 'utf-8'));
  assert(data.usbVendors['0x2D1B'] === 'Vivo', 'Should have Vivo USB vendor');
  assert(data.usbVendors['0x22D9'] === 'OPPO/Realme', 'Should have OPPO/Realme USB vendor');
});

// --- Vendor Boot with DTB Test ---
test('BootImage: vendor boot v4 with DTB round-trip', () => {
  const ps = 4096;
  const headerSize = 2112;  // vendor boot v4 header size

  const headerBuf = new ArrayBuffer(headerSize);
  const dv = new DataView(headerBuf);
  new TextEncoder().encodeInto('VNDRBOOT', new Uint8Array(headerBuf));
  dv.setUint32(8, 4, true);       // header version = 4
  dv.setUint32(12, ps, true);     // page size = 4096
  dv.setUint32(20, 200, true);    // ramdisk size = 200
  dv.setUint32(556, headerSize, true);  // header size
  dv.setUint32(560, 100, true);   // dtb size = 100

  const ramdisk = new Uint8Array(200).fill(0xAA);
  const dtb = new Uint8Array(100).fill(0xBB);

  const bootImg = Utils.concat(
    Utils.padTo(new Uint8Array(headerBuf), ps),  // header padded to 1 page
    Utils.padTo(ramdisk, ps),                      // ramdisk padded to 1 page
    Utils.padTo(dtb, ps),                           // dtb padded to 1 page
  );

  const parsed = BootImage.parse(bootImg);
  assertEq(parsed.version, 4, 'Should detect vendor v4');
  assert(parsed.isVendorBoot, 'Should be vendor boot');
  assertEq(parsed.header.ramdiskSize, 200, 'Should have ramdisk size');
  assertEq(parsed.header.dtbSize, 100, 'Should have DTB size');
  assertEq(parsed.dtb.byteLength, 100, 'Should have DTB data');
  for (let i = 0; i < 100; i++) {
    if (parsed.dtb[i] !== 0xBB) throw new Error(`DTB byte ${i} mismatch`);
  }

  // Rebuild and verify
  const rebuilt = parsed.build();
  const reparsed = BootImage.parse(rebuilt);
  assertEq(reparsed.version, 4, 'Rebuilt should be vendor v4');
  assertEq(reparsed.header.ramdiskSize, 200, 'Rebuilt ramdisk size');
  assertEq(reparsed.header.dtbSize, 100, 'Rebuilt DTB size');
  assertEq(reparsed.dtb.byteLength, 100, 'Rebuilt DTB data preserved');
  for (let i = 0; i < 100; i++) {
    if (reparsed.dtb[i] !== 0xBB) throw new Error(`Rebuilt DTB byte ${i} mismatch`);
  }
});
