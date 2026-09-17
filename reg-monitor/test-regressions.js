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
function runCrawlerWith(dataJsonContent, opts) {
  const noNet = !!(opts && opts.noNetwork);
  const base = fs.mkdtempSync(path.join(require('os').tmpdir(), 'crawltest-'));
  fs.mkdirSync(path.join(base, 'reg-monitor'));
  fs.mkdirSync(path.join(base, 'reg-monitor-site'));
  for (const f of ['crawler.js', 'enrich.js', 'package.json', 'test-netstub.js']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(base, 'reg-monitor', f));
  }
  const nm = path.join(__dirname, 'node_modules');
  if (fs.existsSync(nm)) fs.cpSync(nm, path.join(base, 'reg-monitor', 'node_modules'), { recursive: true });
  const out = path.join(base, 'reg-monitor-site', 'data.json');
  fs.writeFileSync(out, dataJsonContent, 'utf8');
  let code = 0, stderr = '';
  try {
    const argv = noNet ? ['-r', './test-netstub.js', 'crawler.js'] : ['crawler.js'];
    const env = { ...process.env };
    if (noNet) env.NETSTUB = (opts && opts.netstub) || 'off';
    execFileSync(process.execPath, argv, { cwd: path.join(base, 'reg-monitor'), timeout: 120000, stdio: 'pipe', env });
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
t('items が配列でなければ、その理由を示して中止する', () => {
  // 以前は「異常終了したこと」しか見ていなかったため、型検査を消しても
  // 直後の store.items.filter が TypeError で落ちてテストが通った（mutation が生き残った）。
  // 診断メッセージまで確かめることで、意図した防御が働いたことを保証する。
  const bad = '{ "items": { "a": 1 } }';
  const r = runCrawlerWith(bad);
  assert.notStrictEqual(r.code, 0, '異常終了すること');
  assert.strictEqual(r.after, bad, 'ファイルを書き換えていないこと');
  assert.ok(/items が配列ではありません/.test(r.stderr), `型検査の診断が出ること: ${r.stderr.slice(0, 300)}`);
  assert.ok(!/TypeError/.test(r.stderr), `素の TypeError で落ちていないこと: ${r.stderr.slice(0, 300)}`);
});

console.log('■ [回帰] 巡回本体の残りの防御（コードの形で確認）');
// 全機関失敗・原子的な書き出し・RSS失敗時の継続は、外部ネットワークに出ないと
// 実行では再現できない。ここは形の確認にとどめる＝この3件は mutation を kill しない。
const crawlerSrc = fs.readFileSync(path.join(__dirname, 'crawler.js'), 'utf8');
t('全機関の取得に失敗したら data.json を一切変更せず異常終了する（実挙動）', () => {
  // 以前はソース中の文字列の前後関係しか見ていなかったため、ガードを
  // if (false && okSites === 0) に書き換えても通った。実際にネットワークを塞いで確かめる。
  const before = JSON.stringify({ generatedAt: '2026-01-01T00:00:00.000Z',
    items: [{ agency:'金融庁', title:'既存の公表物です', url:'https://www.fsa.go.jp/news/x.html', date:'2026-01-01', detectedAt:'2026-01-01T00:00:00.000Z' }],
    lawnews: { '421AC0000000059': [{ title:'既存ニュース', url:'https://example.com/n' }] },
    dietbills: { '421AC0000000059': [{ title:'既存議案' }] } }, null, 2);
  const r = runCrawlerWith(before, { noNetwork: true });
  assert.notStrictEqual(r.code, 0, '異常終了すること');
  assert.strictEqual(r.after, before, 'data.json を1バイトも変更していないこと');
  assert.ok(/すべての取得に失敗/.test(r.stderr), `全滅を理由として示すこと: ${r.stderr.slice(0, 300)}`);
  assert.ok(!fs.readdirSync(path.join(r.base, 'reg-monitor-site')).some(f => f.endsWith('.tmp')),
    '一時ファイルを残していないこと');
});

t('巡回は成功したが補助データの取得が落ちた回に、lawnews / dietbills を空で上書きしない', () => {
  // 補助データは毎回まるごと置換されるため、ここが守られないと蓄積が静かに消える。
  // 全滅ガードは okSites>0 なら通過するので、「6機関は成功・補助だけ失敗」という
  // 実際に起きる組み合わせで確かめる必要がある（全遮断では書き出しまで到達しない）。
  const before = JSON.stringify({ generatedAt: '2026-01-01T00:00:00.000Z',
    items: [{ agency:'金融庁', title:'既存の公表物です', url:'https://www.fsa.go.jp/news/x.html', date:'2026-01-01', detectedAt:'2026-01-01T00:00:00.000Z' }],
    lawnews: { '421AC0000000059': [{ title:'既存ニュース', url:'https://example.com/n' }] },
    dietbills: { '421AC0000000059': [{ title:'既存議案' }] } }, null, 2);
  const r = runCrawlerWith(before, { noNetwork: true, netstub: 'aux-fail' });
  const after = JSON.parse(r.after);
  assert.ok(after.items.length >= 1, '巡回自体は成功して書き出されていること');
  assert.ok(after.lawnews && after.lawnews['421AC0000000059'] && after.lawnews['421AC0000000059'].length === 1,
    'lawnews が空で上書きされています');
  assert.ok(after.dietbills && after.dietbills['421AC0000000059'] && after.dietbills['421AC0000000059'].length === 1,
    'dietbills が空で上書きされています');
});

t('取得は成功して本当に0件だった回は、前回値で塗り替えず0件を反映する', () => {
  // 「取得失敗で空」と「成功して空」を区別しないと、国会閉会で議案が全て消えた等のときに
  // 古い情報が永久に残る（再レビューで指摘された回帰）。ここは区別できていることを確かめる。
  const src = fs.readFileSync(path.join(__dirname, 'crawler.js'), 'utf8');
  assert.ok(/if \(res\.ok\) return res\.data;/.test(src), '取得成功時は結果をそのまま採用していません');
  assert.ok(/return \{ ok: qFail === 0, data: out \};/.test(src), 'fetchLawNews が成功/失敗を返していません');
  assert.ok(/if \(!html\) return \{ ok:false, data: out \};/.test(src), 'fetchDietBills が失敗を返していません');
  // 実挙動: 取得成功かつ0件の状況を作れないためコードの形で確認する（ネットワークスタブでは常に失敗側になる）
});
// コメントと文字列リテラルを落としたソース。形の検査をコメントに一致させないため。
// （実測: 実処理を直接上書きへ戻して旧コードをコメントで残すだけで、従来の検査は通っていた）
const crawlerCode = crawlerSrc
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

t('一時ファイルにPIDを入れ、失敗時に消す（コメントを除いた実コードで確認）', () => {
  assert.ok(/process\.pid}\.tmp/.test(crawlerCode), '一時名にPIDが入っていません');
  assert.ok(/unlinkSync\(tmp\)/.test(crawlerCode), '失敗時に一時ファイルを消していません');
  assert.ok(/fs\.renameSync\(tmp, OUT\)/.test(crawlerCode), 'rename で差し替えていません');
  // 直接上書きへ巻き戻されていないこと
  assert.ok(!/fs\.writeFileSync\(\s*OUT\s*,/.test(crawlerCode), 'OUT へ直接 writeFileSync しています（原子的でない）');
});

t('全滅ガードがコメントアウトや無効化で殺されていない（コメントを除いた実コードで確認）', () => {
  const iAbort = crawlerCode.indexOf('okSites === 0');
  const iWrite = crawlerCode.indexOf('fs.renameSync(tmp, OUT)');
  assert.ok(iAbort > 0 && iWrite > 0, '該当箇所がありません');
  assert.ok(iAbort < iWrite, '全滅判定が書き出しより後にあります');
  assert.ok(!/if\s*\(\s*false\s*&&/.test(crawlerCode), 'ガードが if (false && ...) で無効化されています');
});
t('[形のみ] RSS生成の失敗でSlack通知を落とさない', () => {
  const m = crawlerSrc.match(/try \{\s*buildFeed\(store\);[\s\S]*?\} catch/);
  assert.ok(m, 'buildFeed が try/catch に入っていません');
});

// ---- 日付パースとURLスキームの回帰（2026-09-17 の三者レビューで追加）----
const { findDate: _fd } = require('./crawler.js');
console.log('\n■ [回帰] 日付パースの正確性');
t('令和元年を2019年として読む', () => { assert.strictEqual(_fd('令和元年5月1日'), '2019-05-01'); });
t('令和N年は 2018+N', () => { assert.strictEqual(_fd('令和8年9月17日'), '2026-09-17'); });
t('平成元年・平成N年も読む', () => {
  assert.strictEqual(_fd('平成元年1月8日'), '1989-01-08');
  assert.strictEqual(_fd('平成31年4月30日'), '2019-04-30');
});
t('存在しない日付は採用しない（2月31日・13月）', () => {
  assert.strictEqual(_fd('令和8年2月31日'), null);
  assert.strictEqual(_fd('令和8年13月1日'), null);
  assert.strictEqual(_fd('2026年2月30日'), null);
});
t('うるう年は正しく判定する', () => {
  assert.strictEqual(_fd('2024年2月29日'), '2024-02-29');
  assert.strictEqual(_fd('2026年2月29日'), null);
});
t('西暦の各表記は従来どおり読める（回帰）', () => {
  assert.strictEqual(_fd('2026年9月17日'), '2026-09-17');
  assert.strictEqual(_fd('2026.9.17'), '2026-09-17');
  assert.strictEqual(_fd('2026-09-17'), '2026-09-17');
  assert.strictEqual(_fd('2026/9/17'), '2026-09-17');
  assert.strictEqual(_fd('日付なし'), null);
  assert.strictEqual(_fd(''), null);
  assert.strictEqual(_fd(null), null);
});

console.log('\n■ [回帰] URLスキームの検査');
const crawlerMod = require('./crawler.js');
t('abs が http(s) 以外を捨てる', () => {
  assert.ok(typeof crawlerMod.abs === 'function', 'abs が export されていません');
  assert.strictEqual(crawlerMod.abs('javascript:alert(1)', 'https://www.fsa.go.jp/'), null);
  assert.strictEqual(crawlerMod.abs('data:text/html,<script>1</script>', 'https://www.fsa.go.jp/'), null);
  assert.strictEqual(crawlerMod.abs('vbscript:msgbox(1)', 'https://www.fsa.go.jp/'), null);
});
t('abs は正常なURLを従来どおり返し、httpはhttpsへ上げる（回帰）', () => {
  assert.strictEqual(crawlerMod.abs('/news/x.html', 'https://www.fsa.go.jp/'), 'https://www.fsa.go.jp/news/x.html');
  assert.strictEqual(crawlerMod.abs('http://www.fsa.go.jp/a', 'https://www.fsa.go.jp/'), 'https://www.fsa.go.jp/a');
  assert.strictEqual(crawlerMod.abs('', 'https://www.fsa.go.jp/x/'), 'https://www.fsa.go.jp/x/');
});
t('parseRSS が javascript: のリンクを項目にしない', () => {
  assert.ok(typeof crawlerMod.parseRSS === 'function', 'parseRSS が export されていません');
  const xml = `<rss><channel>
    <item><title>悪意のある配信元からの項目です</title><link>javascript:alert(1)</link><pubDate>Thu, 15 Jan 2026 10:00:00 +0900</pubDate></item>
    <item><title>正常な項目です</title><link>https://www.fsa.go.jp/ok.html</link><pubDate>Thu, 15 Jan 2026 10:00:00 +0900</pubDate></item>
  </channel></rss>`;
  const items = crawlerMod.parseRSS(xml, '金融庁', 'https://www.fsa.go.jp/rss.xml');
  assert.ok(!items.some(i => /^javascript:/i.test(i.url || '')), 'javascript: が項目に入っています');
  assert.ok(items.some(i => i.url === 'https://www.fsa.go.jp/ok.html'), '正常な項目まで落としています');
});

// ---- 2026-09-17 codex の修正後 mutation testing で「テストが無い」と指摘された4件 ----
console.log('\n■ [回帰] RSS配信・表示側・週次スクリプト・ワークフロー');

t('RSSの pubDate に Invalid Date を出さない', () => {
  // new Date('不正値').toUTCString() は例外を投げず 'Invalid Date' を返すので try/catch では防げない。
  const crawlerSrcNow = fs.readFileSync(path.join(__dirname, 'crawler.js'), 'utf8');
  const m = crawlerSrcNow.match(/const rfc822 = [^\n]*/);
  assert.ok(m, 'rfc822 が見つかりません');
  const rfc822 = new Function('return ' + m[0].replace(/^const rfc822 = /, '').replace(/;$/, ''))();
  assert.ok(!/Invalid Date/.test(rfc822('こわれた日付')), '不正な日付で Invalid Date を返しています');
  assert.ok(!/Invalid Date/.test(rfc822(undefined)), 'undefined で Invalid Date を返しています');
  assert.ok(!/Invalid Date/.test(rfc822('')), '空文字で Invalid Date を返しています');
  assert.strictEqual(rfc822('2026-01-15T01:00:00.000Z'), new Date('2026-01-15T01:00:00.000Z').toUTCString(),
    '正常な日付の変換が変わっています（回帰）');
});

t('表示側(index.html) の safeUrl が危険なスキームを弾く', () => {
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'reg-monitor-site', 'index.html'), 'utf8');
  const m = htmlSrc.match(/function safeUrl\(u\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'safeUrl が見つかりません');
  // ブラウザの location を差し替えて Node で評価する
  const safeUrl = new Function('location', m[0] + '\nreturn safeUrl;')({ href: 'https://finoject.github.io/finoject-reg-monitor/' });
  assert.strictEqual(safeUrl('javascript:alert(1)'), '#', 'javascript: を通しています');
  assert.strictEqual(safeUrl('data:text/html,<script>1</script>'), '#', 'data: を通しています');
  assert.strictEqual(safeUrl('https://www.fsa.go.jp/news/x.html'), 'https://www.fsa.go.jp/news/x.html',
    '正常なURLを壊しています（回帰）');
  assert.strictEqual(safeUrl('/a/b.html'), 'https://finoject.github.io/a/b.html', '相対URLの解決が壊れています');
  assert.strictEqual(safeUrl(null), '#', 'null が base と連結されて実在しないリンクになります');
  assert.strictEqual(safeUrl(undefined), '#');
  assert.strictEqual(safeUrl(''), '#');
  assert.strictEqual(safeUrl('   '), '#');
  assert.strictEqual(safeUrl(42), '#', '数値も弾くこと');
});

t('週次スクリプトが items の型異常を0件扱いにしない', () => {
  for (const f of ['weekly-brief.js', 'chaindetective-weekly.js']) {
    const src2 = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(/if \(!Array\.isArray\(data\.items\)\) throw new Error/.test(src2),
      `${f}: items が配列でないときに throw していません（0件のブリーフィングを平常どおり出してしまいます）`);
    assert.ok(!/Array\.isArray\(data\.items\) \? data\.items : \[\]/.test(src2),
      `${f}: 空配列へのフォールバックが残っています`);
  }
});

t('crawl.yml の push が3回失敗したらジョブを失敗させる', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'crawl.yml'), 'utf8');
  const i = yml.indexOf('for i in 1 2 3; do');
  assert.ok(i > 0, 'push の再試行ループがありません');
  const after = yml.slice(i, i + 1400);
  assert.ok(/3回試行してもpushできませんでした/.test(after), '3回失敗時のエラー出力がありません');
  assert.ok(/3回試行してもpushできませんでした"\n\s*exit 1/.test(after) || /できませんでした"[\s\S]{0,40}exit 1/.test(after),
    '3回失敗しても exit 1 していません（push失敗が握り潰されます）');
  // rebase 競合を受け止めているか（bash -e で無言終了しないこと）
  assert.ok(/if ! git pull --rebase/.test(after), 'rebase の失敗を受け止めていません（bash -e でステップが無言終了します）');
  assert.ok(/git rebase --abort/.test(after), 'rebase 競合時に abort していません');
  // 健全性チェックが公開後に走ること
  assert.ok(/if: always\(\)/.test(yml) && yml.indexOf('deploy-pages') < yml.indexOf('巡回の健全性チェック'),
    '健全性チェックが Pages 公開の後に置かれていません');
});

console.log(`\n合計 ${pass + fail} 件 / 成功 ${pass} / 失敗 ${fail}`);
process.exitCode = fail ? 1 : 0;
