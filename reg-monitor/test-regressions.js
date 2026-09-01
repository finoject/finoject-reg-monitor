// 2026-09-01 の検証で見つかった欠陥に対する回帰テスト。
//
//   node test-regressions.js
//
// ## このテストの読み方
//
// 各テストは次のどちらかで、見出しに区別を書いてある。
//
//   [回帰] 修正を巻き戻すと必ず落ちる。mutation を kill する
//   [互換] 修正前から変わっていないことを確かめる。巻き戻しても落ちない
//
// 「全部が巻き戻しで落ちる」とは書かない。落ちないテストを落ちるかのように書くと、
// 次に読む人が mutation testing を済ませたものと誤解する。互換テストは
// 「直したつもりが従来の挙動まで変えていないか」を守るためにある。
//
// ## 本物を叩く
//
// crawler.js は `require.main === module` で main() を守り、関数を export している。
// テスト側に同じ処理を書き写すと、本番を壊してもテストが通る（実際、RSS日付の3件が
// その状態だった＝本番の変換を JST 加算なしに戻しても 32/32 成功した）。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const E = require('./enrich.js');
const C = require('./crawler.js');            // main() は走らない
const { resolveWeek } = require('./jstweek.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  OK   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message}`); }
}

console.log('■ [回帰] 漢数字の条番号（位取りを含まない連記）');
t('「二〇五」は205', () => assert.strictEqual(E.kanToNum('二〇五'), '205'));
t('「一〇〇」は100', () => assert.strictEqual(E.kanToNum('一〇〇'), '100'));
console.log('■ [互換] 従来の漢数字解釈を壊していない');
t('二百五＝205', () => assert.strictEqual(E.kanToNum('二百五'), '205'));
t('三十七＝37', () => assert.strictEqual(E.kanToNum('三十七'), '37'));
t('二千二十六＝2026', () => assert.strictEqual(E.kanToNum('二千二十六'), '2026'));
t('算用数字はそのまま', () => assert.strictEqual(E.kanToNum('１２３'), '123'));

console.log('■ [回帰] 見出しの正規化（重複判定キー）');
t('（概要）と（新旧対照表）は別キー', () => {
  assert.notStrictEqual(E.normNewsTitle('金融商品取引法改正案（概要）'), E.normNewsTitle('金融商品取引法改正案（新旧対照表）'));
});
t('未知の括弧書きも潰さない（（案）と（確定版））', () => {
  assert.notStrictEqual(E.normNewsTitle('資金決済法改正（案）'), E.normNewsTitle('資金決済法改正（確定版）'));
});
console.log('■ [回帰] 一覧に無い媒体名も落とす（同一記事が2件並ばない）');
t('（ロイター）と（Yahoo）は同一キー ※ロイターは NEWS_SOURCES に無い', () => {
  assert.strictEqual(E.normNewsTitle('資金決済法を改正へ（ロイター）'), E.normNewsTitle('資金決済法を改正へ（Yahoo）'));
});
t('「 - 媒体名」形式とカッコ形式が同一キー', () => {
  assert.strictEqual(E.normNewsTitle('資金決済法を改正へ - ロイター'), E.normNewsTitle('資金決済法を改正へ（ロイター）'));
});
console.log('■ [互換] 既知の媒体名は従来どおり落とす');
t('（日本経済新聞）と（時事通信）は同一キー', () => {
  assert.strictEqual(E.normNewsTitle('資金決済法を改正へ（日本経済新聞）'), E.normNewsTitle('資金決済法を改正へ（時事通信）'));
});

console.log('■ [回帰] ニュース欄のノイズ判定が当局の公表を捨てない');
for (const title of [
  '暗号資産交換業者の月次報告について',
  '主要行等の令和8年3月期決算の概要',
  '資金移動業者の決算に関する留意点',
]) t(`捨てない: ${title}`, () => assert.strictEqual(E.isNewsNoise(title), false));
console.log('■ [回帰] 例外規定をやめたことで、規制語を含むノイズも正しく捨てる');
for (const title of [
  '[7203] トヨタ自動車 会社法に基づく自己株式の取得状況',
  'A社 月次売上高・会員登録者数のお知らせ',
  '適時開示：法定開示資料の訂正',
]) t(`捨てる: ${title}`, () => assert.strictEqual(E.isNewsNoise(title), true));
console.log('■ [互換] 上場会社の開示物は従来どおり捨てる');
for (const title of ['A社 決算短信', 'B社 株主優待の変更', 'C社 月次売上高', '適時開示：D社', 'E社 業績予想の修正', '株価急落 F社', '[7203]トヨタ']) {
  t(`捨てる: ${title}`, () => assert.strictEqual(E.isNewsNoise(title), true));
}

console.log('■ [回帰] 主フィードのノイズ判定（本物の isNoise を呼ぶ）');
for (const title of [
  '資金決済法に関するQ&Aの対応を更新しました',
  'マネー・ローンダリング対策ガイドラインの対応を更新しました',
]) t(`規制文脈は残す: ${title}`, () => assert.strictEqual(C.isNoise(title), false));
console.log('■ [回帰] 法令名を含んでいても、上場会社の開示は捨てる');
for (const title of [
  '会社法に基づく自己株式の取得状況を更新しました',
  '適時開示：金融商品取引法に基づく訂正報告書の一覧を更新しました',
]) t(`捨てる: ${title}`, () => assert.strictEqual(C.isNoise(title), true));
console.log('■ [互換] 法令辞書に無いものは従来どおり捨てる（旧実装でも落ちない＝mutationはkillしない）');
for (const title of [
  '[マーケット情報] 法定開示情報を更新しました',
  '法定開示情報一覧を更新しました',
  '利用法のページを更新しました',
]) t(`捨てる: ${title}`, () => assert.strictEqual(C.isNoise(title), true));
console.log('■ [互換] 従来のノイズは従来どおり捨てる');
for (const title of ['気配提示状況を更新しました', '制度信用・貸借銘柄一覧を更新しました', '会社概要のページを更新しました']) {
  t(`捨てる: ${title}`, () => assert.strictEqual(C.isNoise(title), true));
}

console.log('■ [回帰] 週の区切り（先週金曜〜今週木曜）');
t('基準の金曜を渡すと 先週金〜今週木', () => {
  const w = resolveWeek('2026-09-04');
  assert.strictEqual(w.from, '2026-08-28');
  assert.strictEqual(w.to, '2026-09-03');
});
t('金曜付の項目は必ずどこかの週に入る（8/28 → 9/4号）', () => {
  const prev = resolveWeek('2026-08-28'), next = resolveWeek('2026-09-04'), d = '2026-08-28';
  assert.strictEqual(d >= prev.from && d <= prev.to, false, '前の週には入らないこと');
  assert.strictEqual(d >= next.from && d <= next.to, true, '次の週に入ること');
});
t('★weekly-brief.js も同じ週を指す（自前実装を持たない）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'weekly-brief.js'), 'utf8');
  assert.ok(/require\('\.\/jstweek'\)/.test(src), 'weekly-brief.js が jstweek を使っていません');
  assert.ok(!/function\s+weekEnd|function\s+deliveryFriday|function\s+parseYmdStrict/.test(src), 'weekly-brief.js に週計算の自前実装が復活しています');
});
console.log('■ [互換] 週の連続性・不正入力の排除');
t('連続する週に隙間も重複も無い', () => {
  const a = resolveWeek('2026-08-28'), b = resolveWeek('2026-09-04');
  assert.strictEqual(new Date(a.TO.getTime() + 86400000).toISOString().slice(0, 10), b.from);
});
t('号数は配信日の金曜のまま', () => assert.strictEqual(resolveWeek('2026-09-04').base, '2026-09-04'));
t('金曜以外を渡したら止まる', () => assert.throws(() => resolveWeek('2026-09-03')));
t('存在しない日付は止まる', () => assert.throws(() => resolveWeek('2026-02-30')));
t('年末をまたいでも7日間', () => {
  const w = resolveWeek('2027-01-01');
  assert.strictEqual(w.from, '2026-12-25'); assert.strictEqual(w.to, '2026-12-31');
});
t('うるう年の2月末をまたいでも7日間', () => {
  const w = resolveWeek('2028-03-03');
  assert.strictEqual(w.from, '2028-02-25'); assert.strictEqual(w.to, '2028-03-02');
});

console.log('■ [回帰] RSS日付のJST変換（本物の crawler.js の関数を呼ぶ）');
t('JST 03:00 の公表は当日付', () => assert.strictEqual(C.isoFromRSSDate('Fri, 07 Aug 2026 03:00:00 +0900'), '2026-08-07'));
t('JST 08:59 の公表も当日付', () => assert.strictEqual(C.isoFromRSSDate('Fri, 07 Aug 2026 08:59:00 +0900'), '2026-08-07'));
t('UTC表記でも JST の暦日になる', () => assert.strictEqual(C.isoFromRSSDate('2026-08-06T18:00:00Z'), '2026-08-07'));
t('JST 23:59 は翌日付にならない', () => assert.strictEqual(C.isoFromRSSDate('Fri, 07 Aug 2026 23:59:00 +0900'), '2026-08-07'));

console.log('■ [回帰] 巡回本体の防御（実際に crawler.js を起動して確かめる）');
function runCrawlerWith(dataJsonContent) {
  const base = fs.mkdtempSync(path.join(require('os').tmpdir(), 'crawltest-'));
  fs.mkdirSync(path.join(base, 'reg-monitor'));
  fs.mkdirSync(path.join(base, 'reg-monitor-site'));
  for (const f of ['crawler.js', 'enrich.js', 'package.json']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(base, 'reg-monitor', f));
  }
  const nm = path.join(__dirname, 'node_modules');
  if (fs.existsSync(nm)) fs.cpSync(nm, path.join(base, 'reg-monitor', 'node_modules'), { recursive: true });
  const out = path.join(base, 'reg-monitor-site', 'data.json');
  fs.writeFileSync(out, dataJsonContent, 'utf8');
  let code = 0, stderr = '';
  try {
    execFileSync(process.execPath, ['crawler.js'], { cwd: path.join(base, 'reg-monitor'), timeout: 60000, stdio: 'pipe' });
  } catch (e) { code = e.status === undefined ? -1 : e.status; stderr = String(e.stderr || ''); }
  return { code, stderr, after: fs.readFileSync(out, 'utf8'), base };
}
t('data.json が壊れていたら中止し、ファイルを一切変更しない', () => {
  const broken = '{ "items": [ {"url":"https://exa';
  const r = runCrawlerWith(broken);
  assert.notStrictEqual(r.code, 0, '異常終了すること');
  assert.strictEqual(r.after, broken, 'ファイルを書き換えていないこと');
  assert.ok(/壊れています/.test(r.stderr), `中止の理由が出ること: ${r.stderr.slice(0, 200)}`);
});
t('items が配列でなければ中止する', () => {
  const bad = '{ "items": { "a": 1 } }';
  const r = runCrawlerWith(bad);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.after, bad);
});

console.log('■ [回帰] 巡回本体の残りの防御（コードの形で確認）');
// 全機関失敗・原子的な書き出し・RSS失敗時の継続は、外部ネットワークに出ないと
// 実行では再現できない。ここは形の確認にとどめる＝この3件は mutation を kill しない。
const crawlerSrc = fs.readFileSync(path.join(__dirname, 'crawler.js'), 'utf8');
t('[形のみ] 全機関失敗なら書き出し前に打ち切る', () => {
  const iAbort = crawlerSrc.indexOf('okSites === 0');
  const iWrite = crawlerSrc.indexOf('fs.renameSync(tmp, OUT)');
  assert.ok(iAbort > 0 && iWrite > 0, '該当箇所がありません');
  assert.ok(iAbort < iWrite, '全滅判定が書き出しより後にあります');
});
t('[形のみ] 一時ファイルにPIDを入れ、失敗時に消す', () => {
  assert.ok(/process\.pid}\.tmp/.test(crawlerSrc), '一時名にPIDが入っていません');
  assert.ok(/unlinkSync\(tmp\)/.test(crawlerSrc), '失敗時に一時ファイルを消していません');
});
t('[形のみ] RSS生成の失敗でSlack通知を落とさない', () => {
  const m = crawlerSrc.match(/try \{\s*buildFeed\(store\);[\s\S]*?\} catch/);
  assert.ok(m, 'buildFeed が try/catch に入っていません');
});

console.log(`\n合計 ${pass + fail} 件 / 成功 ${pass} / 失敗 ${fail}`);
process.exitCode = fail ? 1 : 0;
