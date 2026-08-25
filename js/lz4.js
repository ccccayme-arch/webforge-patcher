// WebForge Patcher — LZ4 Frame Decompression
// Android 14+ vendor ramdisks use LZ4 frame compression instead of gzip.
// Uses lz4js library (CDN fallback) since browsers lack native LZ4 support.
//
// LZ4 frame format: https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md

import { Utils } from './utils.js';

const LZ4_MAGIC = [0x04, 0x22, 0x4D, 0x18]; // LZ4 frame magic number

export class LZ4 {
  /**
   * Check if data is an LZ4 frame (magic bytes 04 22 4D 18).
   */
  static isLZ4Frame(data) {
    const buf = Utils.u8(data);
    return buf.byteLength >= 4 &&
      buf[0] === LZ4_MAGIC[0] &&
      buf[1] === LZ4_MAGIC[1] &&
      buf[2] === LZ4_MAGIC[2] &&
      buf[3] === LZ4_MAGIC[3];
  }

  /**
   * Decompress an LZ4 frame using lz4js library.
   * Requires lz4js loaded globally as `LZ4` (via CDN).
   * CDN: https://cdn.jsdelivr.net/npm/lz4js@0.3.0/dist/lz4.min.js
   */
  static async decompress(data) {
    const buf = Utils.u8(data);

    if (typeof LZ4 !== 'undefined' && LZ4.decompress) {
      // lz4js provides LZ4.decompress() for frame format
      const result = LZ4.decompress(buf);
      Utils.log(`LZ4 decompressed: ${buf.byteLength} → ${result.byteLength} bytes`);
      return new Uint8Array(result);
    }

    // No native browser LZ4 support — must use library
    throw new Error(
      'LZ4 decompression requires lz4js library. ' +
      'Add via CDN: <script src="https://cdn.jsdelivr.net/npm/lz4js@0.3.0/dist/lz4.min.js"></script>'
    );
  }

  /**
   * Compress data as LZ4 frame (for repacking vendor ramdisks).
   * Requires lz4js.
   */
  static async compress(data) {
    const buf = Utils.u8(data);

    if (typeof LZ4 !== 'undefined' && LZ4.compress) {
      const result = LZ4.compress(buf);
      Utils.log(`LZ4 compressed: ${buf.byteLength} → ${result.byteLength} bytes`);
      return new Uint8Array(result);
    }

    throw new Error(
      'LZ4 compression requires lz4js library. ' +
      'Add via CDN: <script src="https://cdn.jsdelivr.net/npm/lz4js@0.3.0/dist/lz4.min.js"></script>'
    );
  }
}
