// WebForge Patcher — Utilities
// Helper functions used across modules.

export class Utils {
  static u8(buf) {
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  }

  static concat(...arrays) {
    const total = arrays.reduce((s, a) => s + (a?.byteLength || 0), 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) {
      if (a) { out.set(a, off); off += a.byteLength; }
    }
    return out;
  }

  static readU32LE(buf, offset) {
    return new DataView(buf).getUint32(offset, true);
  }

  static writeU32LE(buf, offset, value) {
    new DataView(buf).setUint32(offset, value, true);
  }

  static readU16LE(buf, offset) {
    return new DataView(buf).getUint16(offset, true);
  }

  static writeU16LE(buf, offset, value) {
    new DataView(buf).setUint16(offset, value, true);
  }

  static readString(buf, offset, maxLen) {
    const view = new Uint8Array(buf, offset, maxLen);
    let str = '';
    for (let i = 0; i < maxLen; i++) {
      if (view[i] === 0) break;
      str += String.fromCharCode(view[i]);
    }
    return str;
  }

  static writeString(buf, offset, str, maxLen) {
    const view = new Uint8Array(buf, offset, maxLen);
    view.fill(0);
    for (let i = 0; i < str.length && i < maxLen; i++) {
      view[i] = str.charCodeAt(i);
    }
  }

  static padTo(data, pageSize) {
    if (!data) return new Uint8Array(0);
    const remainder = data.byteLength % pageSize;
    if (remainder === 0) return data;
    const padding = new Uint8Array(pageSize - remainder);
    return Utils.concat(data, padding);
  }

  static alignUp(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
  }

  static hexdump(data, start = 0, length = 64) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    const end = Math.min(start + length, view.byteLength);
    let result = '';
    for (let i = start; i < end; i += 16) {
      const hex = [];
      const ascii = [];
      for (let j = 0; j < 16 && i + j < end; j++) {
        const b = view[i + j];
        hex.push(b.toString(16).padStart(2, '0'));
        ascii.push(b >= 32 && b < 127 ? String.fromCharCode(b) : '.');
      }
      result += `${i.toString(16).padStart(8, '0')}  ${hex.join(' ').padEnd(48)}  ${ascii.join('')}\n`;
    }
    return result;
  }

  static crc32(data) {
    let crc = 0xFFFFFFFF;
    const table = Utils._crcTable || (Utils._crcTable = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
          c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[i] = c;
      }
      return t;
    })());
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    for (let i = 0; i < view.byteLength; i++) {
      crc = table[(crc ^ view[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  static async sha256(data) {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    const hash = await crypto.subtle.digest('SHA-256', buf.buffer);
    return new Uint8Array(hash);
  }

  static isLZ4(data) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    return view[0] === 0x04 && view[1] === 0x22 && view[2] === 0x4D && view[3] === 0x18;
  }

  static isGzip(data) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    return view[0] === 0x1F && view[1] === 0x8B;
  }

  static log(msg, level = 'info') {
    const prefix = { info: '✓', warn: '⚠', error: '✗', debug: '⋅' };
    console.log(`${prefix[level] || '⋅'} ${msg}`);
    const event = new CustomEvent('webforge:log', { detail: { msg, level } });
    window.dispatchEvent(event);
  }
}
