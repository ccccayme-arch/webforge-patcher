// WebForge Patcher — vbmeta.img Generator
// Creates an empty/disabled vbmeta image for AVB bypass.
// Equivalent to: avbtool make_vbmeta_image --flags 3

import { Utils } from './utils.js';

const AVB_MAGIC = 'AVB0';
const VBMETA_HEADER_SIZE = 256;
const VBMETA_FOOTER_SIZE = 64;

const FLAG_HASHTREE_DISABLED = 1 << 0;
const FLAG_VERIFICATION_DISABLED = 1 << 1;

export class VBMeta {
  static createEmpty() {
    const header = new Uint8Array(VBMETA_HEADER_SIZE);
    const dv = new DataView(header.buffer);
    for (let i = 0; i < 4; i++) header[i] = AVB_MAGIC.charCodeAt(i);
    dv.setUint32(4, 1, false);  // major version (big-endian in AVB)
    dv.setUint32(8, 0, false);  // minor version
    dv.setUint32(20, 0, false); // algorithm: NONE
    dv.setUint32(92, FLAG_HASHTREE_DISABLED | FLAG_VERIFICATION_DISABLED, false);
    const releaseStr = new TextEncoder().encode('webforge');
    header.set(releaseStr, 96);
    const result = Utils.concat(header, new Uint8Array(VBMETA_FOOTER_SIZE));
    Utils.log(`Generated empty vbmeta.img (${result.byteLength} bytes, flags=0x3)`);
    return result;
  }

  static parse(data) {
    const buf = Utils.u8(data);
    if (buf.byteLength < 4) throw new Error('Too small for vbmeta');
    const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
    if (magic !== AVB_MAGIC) throw new Error(`Not a vbmeta image (magic: ${magic})`);
    const dv = new DataView(buf.buffer);
    return {
      magic,
      version: `${dv.getUint32(4, false)}.${dv.getUint32(8, false)}`,
      algorithm: dv.getUint32(20, false),
      flags: dv.getUint32(92, false),
      hashtreeDisabled: !!(dv.getUint32(92, false) & FLAG_HASHTREE_DISABLED),
      verificationDisabled: !!(dv.getUint32(92, false) & FLAG_VERIFICATION_DISABLED),
    };
  }
}
