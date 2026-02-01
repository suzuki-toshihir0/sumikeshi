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
  - `redaction/` — 墨消し処理（ContentStream操作、メタデータクリア）
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

- **ネットワーク完全遮断**: CSPの `connect-src 'none'` により外部通信を一切行わない。すべての処理はブラウザのサンドボックス内で完結する。
- **本番依存は2つのみ**: `pdfjs-dist` と `pdf-lib`。フレームワークは使わない（Vanilla TS）。
- **ArrayBufferのコピー**: pdfjs-distはWorkerにArrayBufferをtransferしてdetachedにするため、pdf-lib用に `.slice(0)` でコピーを保持する必要がある（`main.ts` の `loadFile`）。

### 墨消し処理フロー（pdf-redactor.ts）

1. pdf-libで `PDFDocument.load()` でPDFを読み込む
2. 各ページのContentStreamをパースし、BT...ETブロック内のテキスト描画オペレーター（Tj, TJ等）を特定
3. 墨消し対象領域と重なるテキストオペレーターを空文字列 `() Tj` に置換
4. 墨消し領域に黒塗り矩形を `page.drawRectangle()` で描画
5. メタデータを全クリア
6. `PDFDocument.save()` で出力

### E2Eテストの注意事項

- **モバイルE2Eはprojects分離**: `playwright.config.ts` の `projects` でdesktop/mobileを振り分け。モバイルは `devices['iPhone 14']` + Chromium（CDPセッション利用のため）。
- **タッチドラッグ**: Playwrightの `page.touchscreen` は `tap()` のみ提供。ドラッグはCDP `Input.dispatchTouchEvent` で `touchStart` → `touchMove`（複数ステップ）→ `touchEnd` を送る。
- **テキスト選択モードのモバイルE2Eは未実装**: テキスト選択モード（`text-selection.ts`）はモバイルで `selectionchange` イベントのデバウンス（500ms）経由で動作するが、E2Eテストが困難なため意図的にスキップしている。理由: モバイルのテキスト選択はOS/ブラウザのネイティブlong-press動作に依存しており、Playwrightにはlong-press APIがない。CDPで `touchStart` を長時間保持してもChromiumがネイティブテキスト選択として認識する保証がなく、テストが不安定になる。

## コーディング規約

- UIフレームワークを使わず、DOM APIを直接操作する
- クラスベースで各機能をモジュール化し、コールバックで連携する
- PDF座標（左下原点）とCSS座標（左上原点）の変換は `utils/coordinates.ts` に集約する
