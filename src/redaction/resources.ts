/**
 * 頁や Form XObject の資源（Resources）を、書き換えるときだけ写しを作って編集する。
 * 同じ資源の辞書を、ほかの頁やフォームが共有していることがあるため、元は変えない。
 */
import { PDFContext, PDFDict, PDFName, PDFObject, PDFRef } from 'pdf-lib';
import { resolve } from './pdf-objects';

export type ResourceCategory = 'XObject' | 'Properties' | 'Font' | 'ColorSpace' | 'ExtGState' | 'Pattern' | 'Shading';

export class ResourceEditor {
  private copy: PDFDict | null = null;
  private categoryCopies = new Map<string, PDFDict>();
  private counter = 0;

  constructor(private readonly ctx: PDFContext, private readonly original: PDFDict | undefined) {}

  get changed(): boolean {
    return this.copy !== null;
  }

  /** 今の資源の辞書（編集していれば写し） */
  get dict(): PDFDict | undefined {
    return this.copy ?? this.original;
  }

  categoryDict(category: ResourceCategory): PDFDict | undefined {
    const d = this.dict;
    if (!d) return undefined;
    const o = resolve(this.ctx, d.get(PDFName.of(category)));
    return o instanceof PDFDict ? o : undefined;
  }

  /** 名前で資源を引く（参照は解決しない） */
  lookupRaw(category: ResourceCategory, name: string): PDFObject | undefined {
    return this.categoryDict(category)?.get(PDFName.of(name));
  }

  lookup(category: ResourceCategory, name: string): PDFObject | undefined {
    return resolve(this.ctx, this.lookupRaw(category, name));
  }

  /** 資源を新しい名前で足し、その名前を返す */
  add(category: ResourceCategory, value: PDFRef | PDFObject, prefix: string): string {
    const cat = this.ensureCategory(category);
    let name: string;
    do {
      name = `${prefix}${++this.counter}`;
    } while (cat.has(PDFName.of(name)));
    cat.set(PDFName.of(name), value);
    return name;
  }

  private ensureCategory(category: ResourceCategory): PDFDict {
    const existing = this.categoryCopies.get(category);
    if (existing) return existing;
    if (!this.copy) {
      this.copy = this.original ? shallowCopy(this.ctx, this.original) : (this.ctx.obj({}) as PDFDict);
    }
    const orig = resolve(this.ctx, this.copy.get(PDFName.of(category)));
    const cat = orig instanceof PDFDict ? shallowCopy(this.ctx, orig) : (this.ctx.obj({}) as PDFDict);
    this.copy.set(PDFName.of(category), cat);
    this.categoryCopies.set(category, cat);
    return cat;
  }
}

export function shallowCopy(ctx: PDFContext, d: PDFDict): PDFDict {
  const out = ctx.obj({}) as PDFDict;
  for (const [k, v] of d.entries()) out.set(k, v);
  return out;
}
