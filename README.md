# 金融規制ウォッチ（5機関 新着モニター）

金融庁・日本銀行・日本証券業協会・JVCEA・日本公認会計士協会の公開情報を
**毎朝07:30（JST）に自動巡回**し、新着項目（日付・タイトル・リンク）を一覧表示する静的サイト。

## 仕組み
- `reg-monitor/crawler.js` … 5機関を巡回して `reg-monitor-site/data.json` を更新（既出URLと比較し新規のみ追記）。
- `reg-monitor-site/index.html` … `data.json` を読み込み、最新日付が上にくる一覧を表示。
- `.github/workflows/crawl.yml` … 毎朝07:30 JSTにcron実行 → 巡回 → data.jsonをコミット → GitHub Pagesへ公開。

## データ源
- 日本銀行 / JVCEA … 公式RSS
- 金融庁 / 日本証券業協会 / 日本公認会計士協会 … 公開ページのHTML解析

## 手動実行
GitHubの「Actions」タブ →「crawl-and-publish」→「Run workflow」で即時実行可能。
ローカルでは `cd reg-monitor && npm install && node crawler.js`。
