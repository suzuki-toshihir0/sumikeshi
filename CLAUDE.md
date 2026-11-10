# sumikeshi

ブラウザ上で動作するPDF墨消しツール。PDF内のテキストデータを完全削除し、黒塗り矩形を重ねたPDFを生成する。

## コマンド

- `npm run dev` — 開発サーバー起動（Vite）
- `npm run build` — TypeScript型チェック + プロダクションビルド
- `npm run test` — 単体テスト実行（Vitest）
- `npm run test:watch` — 単体テストをwatchモードで実行
- `npm run test:e2e` — E2Eテスト実行（Playwright）
- `npx tsc --noEmit` — 型チェックのみ

## アーキテクチャ

### ディレクトリ構成

- `src/` — ソースコード（Viteのroot）
  - `viewer/` — PDF.jsによるPDF表示・テキストレイヤー
  - `selection/` — テキスト選択・矩形選択モード
  - `redaction/` — 墨消し処理（下の「墨消し処理フロー」）
  - `ui/` — ツールバー、ページナビ、オーバーレイ
  - `utils/` — 座標変換、ファイルI/O
- `tests/unit/` — Vitestによる単体テスト
- `tests/e2e/` — Playwrightによるe2eテスト（`basic.spec.ts`=デスクトップ、`mobile.spec.ts`=モバイル）
- `tests/fixtures/` — テスト用PDF（`npx tsx tests/fixtures/generate-sample.ts` で再生成可能）

### 技術スタック

- **言語**: TypeScript（strict mode）
- **ビルド**: Vite
- **PDF表示**: pdfjs-dist（PDF.js）
- **PDF編集**: pdf-lib（ContentStream操作、メタデータクリア、黒塗り矩形描画）
- **テスト**: Vitest（単体）、Playwright（E2E）
- **デプロイ**: GitHub Actions → GitHub Pages

### 設計上の重要な制約

- **ネットワーク完全遮断**: CSPの `connect-src 'self'` により外部通信を一切行わない（同じサイトの `cmaps/` だけを読む）。すべての処理はブラウザのサンドボックス内で完結する。
- **WebAssembly**: JPEG 2000 の復号器（pdf.js の OpenJPEG）のため、CSP の `script-src` に `'wasm-unsafe-eval'` を入れている。
- **本番依存は2つのみ**: `pdfjs-dist` と `pdf-lib`。フレームワークは使わない（Vanilla TS）。
- **ArrayBufferのコピー**: pdfjs-distはWorkerにArrayBufferをtransferしてdetachedにするため、pdf-lib用に `.slice(0)` でコピーを保持する必要がある（`main.ts` の `loadFile`）。

### 墨消し処理フロー（src/redaction/）

見た目を黒い四角で隠すだけでは、下の文字・画像はデータとして残る（文字のコピー、画像の取り出し、OCR で読める）。範囲にかかるデータそのものを消す。

0. `main.ts` → `redaction-runner.ts` → `redaction-worker.ts`: 墨消しは Web Worker で動かす。壊れた画像で復号器が終わらなくなっても画面が固まらないよう、120 秒で終わらなければ Worker を止めて `RedactionError` にする（pdf.js の JBIG2 の復号器が、特殊な JBIG2 で無限に回る例がある）
1. `pdf-redactor.ts`: pdf-lib で読み込み、墨消しする頁ごとに以下を行い、最後に `sanitize.ts` で文書全体を掃除して保存する
2. `content/lexer.ts` `content/writer.ts`: ContentStream を PDF の構文どおりに読み書きする（文字列・辞書・配列・インライン画像）
3. `content-redactor.ts`: 命令を 1 つずつ追い、CTM（`cm`）・テキスト行列（`Tm` `Td` `T*`）・文字の状態（`Tf` `Tc` `Tw` `Tz` `Ts`）を持つ
   - 文字: `fonts/font-model.ts` の字形の外接矩形（無ければ幅と高さ）から 1 文字ずつ頁の上の箱を求め、範囲にかかる符号を消す。文字を消した BT…ET は、残る文字ごとに絶対位置（`Tm`）で置き直し、消した文字の幅・字数・その文字のためだけの状態（`Tz` など）を残さない。囲む BDC の ActualText / Alt も消す
   - パス: 線は範囲の外の部分を残し、塗りと切り抜き（`W n`）は範囲を抜いた形にする（曲線は折れ線にしてから）
   - 書き直した中身からは Marked Content（`/OC` 以外）と、描く文字の無い BT…ET を外す（消した文字列の数や行が分かる殻を残さない）
   - Form XObject: 中身を同じ処理にかけ、変わったら写しを作って差し替える
   - 画像（`Do` とインライン画像）: `images/` で復号し、範囲にかかる画素を一色で塗って Flate で圧縮し直す。SMask・Mask も塗る
   - 差し替えた元の画像・フォームが資源に残らないよう、使われなくなった XObject を資源から外す（`resources.ts`）
4. `annotations.ts`: 範囲にかかる注釈（フォームの欄、リンク、ポップアップを含む）を消し、フォームの欄の木からも外す
5. 範囲に黒い四角を描く（元の中身は q/Q の釣り合いを取って囲む）。文字選択の 1 文字ずつの矩形は、並ぶ向きと直交する辺が揃うものだけを 1 つにまとめる（`mergeRects`。揃わないものまでまとめると、外接する矩形が範囲の外の字まで消す）
6. `fonts/scrub.ts`: 消した文字の字形・幅・名前を、文書のどこでももう使われていなければフォントから消す。字を消したフォントだけが書き換わると、それ自体が印になるので、文書の中で使うフォントはすべて同じ形に書き直す（Type3 は符号を詰めて字形名を付け直す、埋め込みの TrueType は使う字形だけに詰める、W・Widths・ToUnicode は使う符号の分だけ）。符号を詰め直したら、文書全体の文字列も書き換える（`fonts/usage.ts`）
7. `sanitize.ts`: Info・XMP・ID・構造の木・しおり・添付ファイル・JavaScript・縮小画像（Thumb）を消し、どこからも参照されないオブジェクトを消し、オブジェクトの番号を詰める

#### 安全側に倒すところ（`errors.ts` の `RedactionError`）

情報が残るおそれのある PDF は出力しない。次の場合は処理を止め、理由を利用者に見せる。

- 幅の分からないフォント（`Widths` の無い、標準 14 フォントでないもの）の文字が、範囲にかかり得る（行の先まで伸ばした帯が範囲にかかる）
- 範囲にかかる画像を読めない（未対応のフィルター、壊れたデータ、`SMaskInData` の JPEG 2000 など）
- 暗号化された PDF

#### 対応しているもの

- フォント: 標準 14 フォント（AFM の幅。別名も）、`Widths` のある単純フォント、Type3、Type0（Identity-H/V、定義済みの CMap は pdf.js の `cmaps/*.bcmap` を読む、埋め込みの CMap）、縦書き（`W2` `DW2`）
- 画像: Flate・LZW（予測子を含む）・ASCIIHex・ASCII85・RunLength・DCT（JPEG）・JPX（JPEG 2000）・JBIG2・CCITTFax。色空間は Device*、Cal*、ICCBased、Lab、Indexed、Separation、DeviceN、画像マスク
- 復号器: JBIG2・JPEG・JPEG 2000 は `pdfjs-dist/image_decoders`（使うときだけ読み込む。Worker は ES モジュールで出す設定が要る: `vite.config.ts` の `worker.format`）。CCITT と CMap の読み込み、文字コードの表は pdf.js から `vendor/` に移植した（Apache-2.0）

#### 扱わないもの（既知の制約）

- タイリングパターンの中身、ExtGState の SMask（ソフトマスクの Form）の中身は書き換えない（パターンで塗った図形の範囲の部分は消すので描かれないが、パターンの中のデータは残る）。注釈の外観の中身も書き換えない（範囲にかかる注釈は丸ごと消す）
- CFF・Type1 の埋め込みフォントは字形を書き換えられないので、消した字があればフォントのデータごと外す（ビューアーは代わりのフォントで描く）。単純な TrueType で、使う字の字形を確かめられないものも同じ
- 黒い四角の幅（選んだ範囲の幅）は見た目に出る。文字選択で選ぶと四角の幅が文字列の幅に一致し、候補の名前の幅と比べて絞られる（Bland ら "Story Beyond the Eye"）。同じ行で後ろに残る文字の位置からも分かる
- 文字は字形の単位で消すので、範囲の端に一部がかかった字も丸ごと消える

#### 試験

- `tests/unit/redaction-leaks.test.ts` `redaction-cases.test.ts`: 墨消し後の PDF を pdf.js（`tests/unit/helpers/pdf-oracle.ts`）で読み直し、範囲の文字・画素・パス・注釈・メタデータが残らないことを確かめる。展開したすべてのストリームに秘密の文字列が無いことも見る
- 素材は `tests/fixtures/real/`（中身はすべて架空）。作り方は `generate.sh` と `build-pdfs.ts`
- `tests/e2e/redaction.spec.ts`: ブラウザで範囲を選んで墨消しし、ダウンロードした PDF を確かめる

### E2Eテストの注意事項

- **モバイルE2Eはprojects分離**: `playwright.config.ts` の `projects` でdesktop/mobileを振り分け。モバイルは `devices['iPhone 14']` + Chromium（CDPセッション利用のため）。
- **タッチドラッグ**: Playwrightの `page.touchscreen` は `tap()` のみ提供。ドラッグはCDP `Input.dispatchTouchEvent` で `touchStart` → `touchMove`（複数ステップ）→ `touchEnd` を送る。
- **テキスト選択モードのモバイルE2Eは未実装**: テキスト選択モード（`text-selection.ts`）はモバイルで `selectionchange` イベントのデバウンス（500ms）経由で動作するが、E2Eテストが困難なため意図的にスキップしている。理由: モバイルのテキスト選択はOS/ブラウザのネイティブlong-press動作に依存しており、Playwrightにはlong-press APIがない。CDPで `touchStart` を長時間保持してもChromiumがネイティブテキスト選択として認識する保証がなく、テストが不安定になる。

## コーディング規約

- UIフレームワークを使わず、DOM APIを直接操作する
- クラスベースで各機能をモジュール化し、コールバックで連携する
- PDF座標（左下原点）とCSS座標（左上原点）の変換は `utils/coordinates.ts` に集約する
