# sumikeshi

ブラウザ上で動作するPDF・画像の墨消しツール。PDF内のテキストデータを完全削除し、黒塗り矩形を重ねたPDFを生成する。写真などの画像は、範囲の画素を黒に置き換え、メタデータの無い画像として書き出す（下の「画像の墨消し」）。

## コマンド

- `npm run dev` — 開発サーバー起動（Vite）
- `npm run build` — TypeScript型チェック + プロダクションビルド
- `npm run test` — 単体テスト実行（Vitest）
- `npm run test:watch` — 単体テストをwatchモードで実行
- `npm run test:e2e` — E2Eテスト実行（Playwright）
- `npm run test:pbt` — 画面の性質の試験（Bombadil。既定 3 分。`bash tests/pbt/run.sh 10m out.bin` で時間とトレースの書き出し先を変えられる）
- `npx tsc --noEmit` — 型チェックのみ

## アーキテクチャ

### ディレクトリ構成

- `src/` — ソースコード（Viteのroot）
  - `viewer/` — PDF.jsによるPDF表示・テキストレイヤー、画像の表示（`image-viewer.ts`）
  - `selection/` — テキスト選択・矩形選択モード
  - `redaction/` — PDF の墨消し処理（下の「墨消し処理フロー」）
  - `image/` — 画像の墨消し（下の「画像の墨消し」）
  - `ui/` — ツールバー、ページナビ、オーバーレイ
  - `utils/` — 座標変換、ファイルI/O
- `tests/unit/` — Vitestによる単体テスト
- `tests/e2e/` — Playwrightによるe2eテスト（`basic.spec.ts` `redaction.spec.ts` `photo.spec.ts`=デスクトップ、`mobile.spec.ts`=モバイル）。`photo.spec.ts` の素材は試験の中で canvas から作り、`helpers/photo-meta.ts` で Exif（位置情報・縮小画像）・XMP・コメント・PNG の文字の欄を仕込む
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

### 画像の墨消し（src/image/）

PDF の墨消しとは別の道で、Worker も pdf-lib も使わない。範囲は PDF と同じ `PdfRect`（左下を原点、1 画素を 1 単位）で持ち、選択と枠の表示は PDF と同じ部品を使う（`utils/coordinates.ts` の `imageViewport` が、pdf.js の `PageViewport` と同じ形の座標の変換を作る。型は `PageView`）。

1. `image-format.ts`: 形式は中身の先頭のバイトで決める（iPhone は JPEG に変えた写真に .heic の名前を残すことがある）。書き出しは JPEG・HEIC → JPEG（画質 0.95）、PNG・WebP・AVIF → PNG
2. `image-document.ts`: `createImageBitmap`（`imageOrientation: 'from-image'`）で読み、Exif の向きを当てて canvas に描く。読めなければ img 要素で読む（HEIC は Safari でだけ読める）。持つのは canvas の画素だけで、元のファイルのバイト列（Exif・XMP など）は持たない
3. 墨消し: 範囲の画素の箱（外向きに丸める）を `putImageData` で不透明の黒に置き換え（下の画素と混ぜない）、読み直して黒になったことを確かめる。画像全体の画素は読み出さない（4800 万画素で約 195MB になる）
4. 書き出し: canvas の `toBlob` で圧縮し直す（メタデータは入らない）。書き出したものを読み直し、大きさ、これまでに墨消ししたすべての範囲が黒いこと、全体を 256 画素以下に縮めて canvas と合うこと（色ごとの差の平均 6 以下）を確かめてから渡す。JPEG は範囲の外の色がにじむので、範囲の確かめは一辺 16 画素以上の範囲の内側（端から 1/4、最大 16 画素を除き、各色 24 以下）だけで、小さな範囲は 3 の読み直しと全体の比べで確かめる（`lossyCheckBox`）。続けて墨消しするときは手元の画素に重ねるので、JPEG を読み直して圧縮し直すことはない
5. `image-paint.ts`: canvas に載らない大きさは開かない（iOS の Safari は 1 辺 8192 画素、面積 67,108,864 画素まで。超えると黙って何も描かない）

扱わないもの: 動画、GIF、複数の頁の TIFF、Live Photos の動画の部分。色の管理（ICC プロファイル）は書き出しで外れ、iPhone の Display P3 の写真は sRGB になる。指紋の対策で canvas の読み出しを乱すブラウザ（Firefox の resistFingerprinting など）では、4 の確かめで止まることがある（乱れた画像は渡さない）。

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
5. 範囲に黒い四角を描く（元の中身は q/Q の釣り合いを取って囲む）。文字選択の 1 文字ずつの矩形は、並ぶ向きと直交する辺が揃うものだけを 1 つにまとめる（`mergeRects`。揃わないものまでまとめると、外接する矩形が範囲の外の字まで消す）。文字選択で作った範囲（`source: 'text'`）は、黒い四角の幅から文字列の幅が分からないよう、文字の進む向きに、次の字・線・画像・注釈の手前（何も無ければ本文の端）まで広げる（`extend-boxes.ts`。先に何も消さずに頁を読み、描かれるものの位置を `RedactionContext.observe` で集める）
6. `fonts/scrub.ts`: 消した文字の字形・幅・名前を、文書のどこでももう使われていなければフォントから消す。字を消したフォントだけが書き換わると、それ自体が印になるので、書き直しても描き方と取り出せる文字の変わらないことが確かなフォント（ToUnicode のある Type3、ToUnicode があって標準の Identity でほかのフォントと何も共有しない Type0）は、字を消したかどうかに関わらず同じ形に書き直す（Type3 は符号を詰めて字形名を付け直す、Type0 は使う字形だけに詰めて符号も詰める、W・ToUnicode は使う符号の分だけ）。それ以外は、字形のデータを共有するフォントをまとめて使う字形を数え、消した字の字形だけを消す（元の番号のまま使わない字形を空にした形や複合フォントは、その場で空にして番号を変えない）。符号を詰め直したら、文書全体の文字列も書き換える（`fonts/usage.ts`）
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
- 消した文字列の幅は、同じ行で後ろに残る文字の位置から分かる（残す字を動かさない限り塞げない。Bland ら "Story Beyond the Eye"）。文字選択の黒い四角は空いているところまで広げるが、矩形で選んだ範囲は選んだとおりの幅で、行の詰まった文章では広げられないこともある
- 文字は字形の単位で消すので、範囲の端に一部がかかった字も丸ごと消える

#### 試験

- `tests/unit/redaction-leaks.test.ts` `redaction-cases.test.ts`: 墨消し後の PDF を pdf.js（`tests/unit/helpers/pdf-oracle.ts`）で読み直し、範囲の文字・画素・パス・注釈・メタデータが残らないことを確かめる。展開したすべてのストリームに秘密の文字列が無いことも見る
- 素材は `tests/fixtures/real/`（中身はすべて架空）。作り方は `generate.sh` と `build-pdfs.ts`
- `tests/e2e/redaction.spec.ts`: ブラウザで範囲を選んで墨消しし、ダウンロードした PDF を確かめる

### 性質の試験（property-based testing）

- **単体（fast-check）**: `tests/unit/image-properties.test.ts`。画像の純粋な関数（範囲を画素の箱にする丸め、座標の往復、表示用の canvas の大きさ、確かめる箱、形式の判定など）を、ランダムな入力で確かめる。`npm run test` に含まれる
- **画面（Bombadil）**: `tests/pbt/`。[Bombadil](https://github.com/antithesishq/bombadil)（npm の `@antithesishq/bombadil` に Linux・macOS の実行ファイルが同梱。Chrome は `CHROME` の環境変数か PATH から探す）が、ファイルを開く・範囲を選ぶ・墨消し・頁送り・ダウンロード・画面の大きさの変更をランダムに行い、`spec.ts` の性質（線形時相論理）が毎状態で成り立つかを見る
  - 素材（`make-fixtures.ts` が `.fixtures/` に作る）は、頁・画像ごとに背景の色を変えてあり（`palette.ts`）、canvas の左上の色で何が表示されているかを見分ける
  - 仕込みの操作（`installShim`）で、alert の記録、範囲の記録（枠が描き直されるたびに頁ごとに覚え、墨消しを押したら全頁の分を記録する。文書が替わったかは `#page-container` の `data-doc-revision` で見る）、非同期の処理へのランダムな遅れを入れる。pdf.js の Worker へのやり取りは順番を保って遅らせる（入れ替えると pdf.js 自体が壊れる）
  - 主な性質: 表示の食い違いが無い（canvas・文字のレイヤー・頁番号・ボタン）、最後に選んだファイルがいつか表示され、表示された後は前のファイルに戻らない、処理中は選べない、墨消しの後に結果を落とせるなら、その文書で墨消しした範囲はどの頁でも黒い、想定外の知らせ・捕まえていない例外が無い
  - 破れたら終了コード 2。トレースは `npx bombadil browser inspect <トレース>`（画面）か `npx bombadil trace <トレース> --json` で見る。見つけた破れは、E2E で再現してから直す
  - 仕様の書き方: `always` などは `@antithesishq/bombadil`、`extract` などは `@antithesishq/bombadil/browser` から読む。手元のファイルの import は拡張子（`.ts`）まで書く。export した操作の生成器はすべて登録されるので、まとめたもの（`all`）と仕込み（`setup`）だけを export する。負の座標の操作を作ると止まる

### E2Eテストの注意事項

- **範囲を選べるようになるのを待つ**: 範囲を選べるのは、文書の読み込みと描画（文字のレイヤーまで）が終わってから。墨消しの処理中と、次の文書の読み込み中は、選び方を切り替えても選べない（`SelectionManager` の `active`）。選べるかは `#page-container` の `data-selectable` に出しているので、試験は `waitForRender` でこれを待ってから範囲を選ぶ。
- **モバイルE2Eはprojects分離**: `playwright.config.ts` の `projects` でdesktop/mobileを振り分け。モバイルは `devices['iPhone 14']` + Chromium（CDPセッション利用のため）。
- **タッチドラッグ**: Playwrightの `page.touchscreen` は `tap()` のみ提供。ドラッグはCDP `Input.dispatchTouchEvent` で `touchStart` → `touchMove`（複数ステップ）→ `touchEnd` を送る。
- **テキスト選択モードのモバイルE2Eは未実装**: テキスト選択モード（`text-selection.ts`）はモバイルで `selectionchange` イベントのデバウンス（500ms）経由で動作するが、E2Eテストが困難なため意図的にスキップしている。理由: モバイルのテキスト選択はOS/ブラウザのネイティブlong-press動作に依存しており、Playwrightにはlong-press APIがない。CDPで `touchStart` を長時間保持してもChromiumがネイティブテキスト選択として認識する保証がなく、テストが不安定になる。

## コーディング規約

- UIフレームワークを使わず、DOM APIを直接操作する
- クラスベースで各機能をモジュール化し、コールバックで連携する
- PDF座標（左下原点）とCSS座標（左上原点）の変換は `utils/coordinates.ts` に集約する
