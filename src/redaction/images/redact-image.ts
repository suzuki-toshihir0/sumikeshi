import type { PDFRef, PDFStream } from 'pdf-lib';
import type { Operation } from '../content/lexer';
import type { RedactionContext } from '../content-redactor';
import type { Matrix } from '../geometry';
import type { ResourceEditor } from '../resources';

/** 仮の実装（画像はまだ扱わない） */
export async function redactImageXObject(
  _rc: RedactionContext, _image: PDFStream, _ctm: Matrix, _resources: ResourceEditor,
): Promise<PDFRef | null> {
  return null;
}

export async function redactInlineImage(
  _rc: RedactionContext, _op: Operation, _resources: ResourceEditor, _ctm: Matrix,
): Promise<Operation | null> {
  return null;
}
