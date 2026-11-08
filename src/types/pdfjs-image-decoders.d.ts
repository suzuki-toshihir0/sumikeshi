// pdfjs-dist の image_decoders には型定義が無いので、使う分だけ宣言する
declare module 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs' {
  export class Jbig2Image {
    parseChunks(chunks: { data: Uint8Array; start: number; end: number }[]): Uint8Array;
  }
  export class JpegImage {
    constructor(options?: { decodeTransform?: Int32Array | null; colorTransform?: number });
    numComponents: number;
    width: number;
    height: number;
    parse(data: Uint8Array): void;
    getData(options: { width: number; height: number; forceRGB?: boolean; forceRGBA?: boolean; isSourcePDF?: boolean }): Uint8ClampedArray | Uint8Array;
  }
  export class JpxImage {
    static decode(
      data: Uint8Array,
      options?: { numComponents?: number; isIndexedColormap?: boolean; smaskInData?: boolean },
    ): Uint8Array;
    static parseImageProperties(data: Uint8Array): { width: number; height: number; bitsPerComponent: number; componentsCount: number };
  }
}
