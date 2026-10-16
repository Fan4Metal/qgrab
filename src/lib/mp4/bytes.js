// Binary helpers: a growable big-endian writer with ISO BMFF box support, and a bit reader.

export class Writer {
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }

  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
    return this;
  }

  u16(v) {
    this.ensure(2);
    this.view.setUint16(this.pos, v & 0xffff);
    this.pos += 2;
    return this;
  }

  u24(v) {
    return this.u8(v >>> 16).u16(v & 0xffff);
  }

  u32(v) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0);
    this.pos += 4;
    return this;
  }

  i32(v) {
    this.ensure(4);
    this.view.setInt32(this.pos, v);
    this.pos += 4;
    return this;
  }

  u64(v) {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v % 2 ** 32);
  }

  bytes(a) {
    this.ensure(a.length);
    this.buf.set(a, this.pos);
    this.pos += a.length;
    return this;
  }

  str(s) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }

  zeros(n) {
    this.ensure(n);
    this.buf.fill(0, this.pos, this.pos + n);
    this.pos += n;
    return this;
  }

  box(type, fill) {
    const start = this.pos;
    this.u32(0).str(type);
    fill(this);
    this.view.setUint32(start, this.pos - start);
    return this;
  }

  fullBox(type, version, flags, fill) {
    return this.box(type, (w) => {
      w.u8(version).u24(flags);
      fill(w);
    });
  }

  result() {
    return this.buf.slice(0, this.pos);
  }
}

export class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  bit() {
    const byte = this.bytes[this.pos >> 3];
    if (byte === undefined) throw new Error('Bitstream truncated');
    return (byte >> (7 - (this.pos++ & 7))) & 1;
  }

  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  ue() {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 31) throw new Error('Invalid Exp-Golomb code');
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }

  se() {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -(v / 2);
  }
}

export function readU32(data, offset) {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

export function readI32(data, offset) {
  return readU32(data, offset) | 0;
}

export function readU64(data, offset) {
  return readU32(data, offset) * 2 ** 32 + readU32(data, offset + 4);
}

export function readType(data, offset) {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

export function concat(parts, total = parts.reduce((n, p) => n + p.length, 0)) {
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export class UnsupportedError extends Error {}
