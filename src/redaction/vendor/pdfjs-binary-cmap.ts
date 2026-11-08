// @ts-nocheck
/*
 * pdf.js（https://github.com/mozilla/pdf.js、pdfjs-dist 4.10.38 の build/pdf.worker.mjs）から抜き出したもの。
 * 元の src/core/binary_cmap.js。cMapUrl で配られる .bcmap（圧縮した CMap）を読む。
 * 変更: FormatError を Error にした。export を付けた。
 *
 * Copyright 2012 Mozilla Foundation
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 */
class FormatError extends Error {}

function hexToInt(a, size) {
  let n = 0;
  for (let i = 0; i <= size; i++) {
    n = n << 8 | a[i];
  }
  return n >>> 0;
}
function hexToStr(a, size) {
  if (size === 1) {
    return String.fromCharCode(a[0], a[1]);
  }
  if (size === 3) {
    return String.fromCharCode(a[0], a[1], a[2], a[3]);
  }
  return String.fromCharCode(...a.subarray(0, size + 1));
}
function addHex(a, b, size) {
  let c = 0;
  for (let i = size; i >= 0; i--) {
    c += a[i] + b[i];
    a[i] = c & 255;
    c >>= 8;
  }
}
function incHex(a, size) {
  let c = 1;
  for (let i = size; i >= 0 && c > 0; i--) {
    c += a[i];
    a[i] = c & 255;
    c >>= 8;
  }
}
const MAX_NUM_SIZE = 16;
const MAX_ENCODED_NUM_SIZE = 19;
class BinaryCMapStream {
  constructor(data) {
    this.buffer = data;
    this.pos = 0;
    this.end = data.length;
    this.tmpBuf = new Uint8Array(MAX_ENCODED_NUM_SIZE);
  }
  readByte() {
    if (this.pos >= this.end) {
      return -1;
    }
    return this.buffer[this.pos++];
  }
  readNumber() {
    let n = 0;
    let last;
    do {
      const b = this.readByte();
      if (b < 0) {
        throw new FormatError("unexpected EOF in bcmap");
      }
      last = !(b & 0x80);
      n = n << 7 | b & 0x7f;
    } while (!last);
    return n;
  }
  readSigned() {
    const n = this.readNumber();
    return n & 1 ? ~(n >>> 1) : n >>> 1;
  }
  readHex(num, size) {
    num.set(this.buffer.subarray(this.pos, this.pos + size + 1));
    this.pos += size + 1;
  }
  readHexNumber(num, size) {
    let last;
    const stack = this.tmpBuf;
    let sp = 0;
    do {
      const b = this.readByte();
      if (b < 0) {
        throw new FormatError("unexpected EOF in bcmap");
      }
      last = !(b & 0x80);
      stack[sp++] = b & 0x7f;
    } while (!last);
    let i = size,
      buffer = 0,
      bufferSize = 0;
    while (i >= 0) {
      while (bufferSize < 8 && stack.length > 0) {
        buffer |= stack[--sp] << bufferSize;
        bufferSize += 7;
      }
      num[i] = buffer & 255;
      i--;
      buffer >>= 8;
      bufferSize -= 8;
    }
  }
  readHexSigned(num, size) {
    this.readHexNumber(num, size);
    const sign = num[size] & 1 ? 255 : 0;
    let c = 0;
    for (let i = 0; i <= size; i++) {
      c = (c & 1) << 8 | num[i];
      num[i] = c >> 1 ^ sign;
    }
  }
  readString() {
    const len = this.readNumber(),
      buf = new Array(len);
    for (let i = 0; i < len; i++) {
      buf[i] = this.readNumber();
    }
    return String.fromCharCode(...buf);
  }
}
export class BinaryCMapReader {
  async process(data, cMap, extend) {
    const stream = new BinaryCMapStream(data);
    const header = stream.readByte();
    cMap.vertical = !!(header & 1);
    let useCMap = null;
    const start = new Uint8Array(MAX_NUM_SIZE);
    const end = new Uint8Array(MAX_NUM_SIZE);
    const char = new Uint8Array(MAX_NUM_SIZE);
    const charCode = new Uint8Array(MAX_NUM_SIZE);
    const tmp = new Uint8Array(MAX_NUM_SIZE);
    let code;
    let b;
    while ((b = stream.readByte()) >= 0) {
      const type = b >> 5;
      if (type === 7) {
        switch (b & 0x1f) {
          case 0:
            stream.readString();
            break;
          case 1:
            useCMap = stream.readString();
            break;
        }
        continue;
      }
      const sequence = !!(b & 0x10);
      const dataSize = b & 15;
      if (dataSize + 1 > MAX_NUM_SIZE) {
        throw new Error("BinaryCMapReader.process: Invalid dataSize.");
      }
      const ucs2DataSize = 1;
      const subitemsCount = stream.readNumber();
      switch (type) {
        case 0:
          stream.readHex(start, dataSize);
          stream.readHexNumber(end, dataSize);
          addHex(end, start, dataSize);
          cMap.addCodespaceRange(dataSize + 1, hexToInt(start, dataSize), hexToInt(end, dataSize));
          for (let i = 1; i < subitemsCount; i++) {
            incHex(end, dataSize);
            stream.readHexNumber(start, dataSize);
            addHex(start, end, dataSize);
            stream.readHexNumber(end, dataSize);
            addHex(end, start, dataSize);
            cMap.addCodespaceRange(dataSize + 1, hexToInt(start, dataSize), hexToInt(end, dataSize));
          }
          break;
        case 1:
          stream.readHex(start, dataSize);
          stream.readHexNumber(end, dataSize);
          addHex(end, start, dataSize);
          stream.readNumber();
          for (let i = 1; i < subitemsCount; i++) {
            incHex(end, dataSize);
            stream.readHexNumber(start, dataSize);
            addHex(start, end, dataSize);
            stream.readHexNumber(end, dataSize);
            addHex(end, start, dataSize);
            stream.readNumber();
          }
          break;
        case 2:
          stream.readHex(char, dataSize);
          code = stream.readNumber();
          cMap.mapOne(hexToInt(char, dataSize), code);
          for (let i = 1; i < subitemsCount; i++) {
            incHex(char, dataSize);
            if (!sequence) {
              stream.readHexNumber(tmp, dataSize);
              addHex(char, tmp, dataSize);
            }
            code = stream.readSigned() + (code + 1);
            cMap.mapOne(hexToInt(char, dataSize), code);
          }
          break;
        case 3:
          stream.readHex(start, dataSize);
          stream.readHexNumber(end, dataSize);
          addHex(end, start, dataSize);
          code = stream.readNumber();
          cMap.mapCidRange(hexToInt(start, dataSize), hexToInt(end, dataSize), code);
          for (let i = 1; i < subitemsCount; i++) {
            incHex(end, dataSize);
            if (!sequence) {
              stream.readHexNumber(start, dataSize);
              addHex(start, end, dataSize);
            } else {
              start.set(end);
            }
            stream.readHexNumber(end, dataSize);
            addHex(end, start, dataSize);
            code = stream.readNumber();
            cMap.mapCidRange(hexToInt(start, dataSize), hexToInt(end, dataSize), code);
          }
          break;
        case 4:
          stream.readHex(char, ucs2DataSize);
          stream.readHex(charCode, dataSize);
          cMap.mapOne(hexToInt(char, ucs2DataSize), hexToStr(charCode, dataSize));
          for (let i = 1; i < subitemsCount; i++) {
            incHex(char, ucs2DataSize);
            if (!sequence) {
              stream.readHexNumber(tmp, ucs2DataSize);
              addHex(char, tmp, ucs2DataSize);
            }
            incHex(charCode, dataSize);
            stream.readHexSigned(tmp, dataSize);
            addHex(charCode, tmp, dataSize);
            cMap.mapOne(hexToInt(char, ucs2DataSize), hexToStr(charCode, dataSize));
          }
          break;
        case 5:
          stream.readHex(start, ucs2DataSize);
          stream.readHexNumber(end, ucs2DataSize);
          addHex(end, start, ucs2DataSize);
          stream.readHex(charCode, dataSize);
          cMap.mapBfRange(hexToInt(start, ucs2DataSize), hexToInt(end, ucs2DataSize), hexToStr(charCode, dataSize));
          for (let i = 1; i < subitemsCount; i++) {
            incHex(end, ucs2DataSize);
            if (!sequence) {
              stream.readHexNumber(start, ucs2DataSize);
              addHex(start, end, ucs2DataSize);
            } else {
              start.set(end);
            }
            stream.readHexNumber(end, ucs2DataSize);
            addHex(end, start, ucs2DataSize);
            stream.readHex(charCode, dataSize);
            cMap.mapBfRange(hexToInt(start, ucs2DataSize), hexToInt(end, ucs2DataSize), hexToStr(charCode, dataSize));
          }
          break;
        default:
          throw new Error(`BinaryCMapReader.process - unknown type: ${type}`);
      }
    }
    if (useCMap) {
      return extend(useCMap);
    }
    return cMap;
  }
}

