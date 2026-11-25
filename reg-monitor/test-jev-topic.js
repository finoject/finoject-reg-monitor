// jev-topic.js の回帰テスト（通信しない。fetch を差し替えて確率を与える）
//   node reg-monitor/test-jev-topic.js   → 最後に「全件OK」が出れば成功
const assert = require('assert');
const { classify, THRESHOLD } = require('./jev-topic');

const isTopic = t => /crypto|stablecoin/i.test(t);
const items = [
  { agency: 'FinCEN', title: 'Alert on fraud', allTopics: true },
  { agency: 'SEC', title: 'Crypto rule', },          // キーワードに当たる
  { agency: 'CFTC', title: 'Passive software', },    // キーワードに当たらない
  { agency: 'OCC', title: 'Mortgage stats', },
];

function mockFetch(probs, { failOn } = {}) {
  const calls = [];
  global.fetch = async (url, opt) => {
    const title = JSON.parse(opt.body).state.split('Title: ')[1];
    calls.push(title);
    if (failOn && title === failOn) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, json: async () => ({ answers: { relevant: { type: 'noul', noul: probs[title] } }, usage: { input_tokens: 300 } }) };
  };
  return calls;
}
const titles = r => r.map(x => x.title).sort();

(async () => {
  // 1. キーワードに当たる記事は Jev が低くても残る（和集合＝従来より取りこぼしが増えない）
  let calls = mockFetch({ 'Crypto rule': 0.01, 'Passive software': 0.55, 'Mortgage stats': 0.39 });
  let r = await classify(items, isTopic, { key: 'k' });
  assert.strictEqual(r.mode, 'jev');
  assert.deepStrictEqual(titles(r.included), ['Alert on fraud', 'Crypto rule', 'Passive software']);
  assert.deepStrictEqual(titles(r.excluded), ['Mortgage stats']);
  // 2. 全件対象の機関（FinCEN）は Jev に問い合わせない
  assert.ok(!calls.includes('Alert on fraud'));
  assert.strictEqual(r.tokens, 900);

  // 3. しきい値ちょうどは採用、0 も正しい値として扱う（「偽」で落とさない）
  mockFetch({ 'Crypto rule': 0, 'Passive software': THRESHOLD, 'Mortgage stats': 0 });
  r = await classify(items, isTopic, { key: 'k' });
  assert.ok(titles(r.included).includes('Passive software'));
  assert.strictEqual(r.excluded.find(x => x.title === 'Mortgage stats').jev, 0);

  // 4. 1件でも失敗したら全件キーワード方式に戻り、理由が残る（混在させない）
  mockFetch({ 'Crypto rule': 0.9, 'Passive software': 0.9, 'Mortgage stats': 0.9 }, { failOn: 'Mortgage stats' });
  r = await classify(items, isTopic, { key: 'k' });
  assert.strictEqual(r.mode, 'keyword');
  assert.match(r.note, /失敗/);
  assert.strictEqual(r.tokens, 600);   // 失敗前の2件分は消費済みとして残す
  assert.deepStrictEqual(titles(r.included), ['Alert on fraud', 'Crypto rule']);

  // 5. キーが無ければ通信せずキーワード方式
  calls = mockFetch({});
  r = await classify(items, isTopic, { key: '' });
  assert.strictEqual(r.mode, 'keyword');
  assert.strictEqual(calls.length, 0);

  // 6. 確率が数値でない応答は失敗扱い（キーワード方式に戻る）
  mockFetch({ 'Crypto rule': undefined, 'Passive software': 0.9, 'Mortgage stats': 0.9 });
  r = await classify(items, isTopic, { key: 'k' });
  assert.strictEqual(r.mode, 'keyword');

  // 7. 0〜1の範囲外の確率は失敗扱い（キーワード方式に戻る）
  mockFetch({ 'Crypto rule': 0.9, 'Passive software': 1.5, 'Mortgage stats': 0.9 });
  r = await classify(items, isTopic, { key: 'k' });
  assert.strictEqual(r.mode, 'keyword');

  // 8. 負の確率も失敗扱い（下限側の検証）
  mockFetch({ 'Crypto rule': 0.9, 'Passive software': -0.1, 'Mortgage stats': 0.9 });
  r = await classify(items, isTopic, { key: 'k' });
  assert.strictEqual(r.mode, 'keyword');

  console.log('全件OK');
})().catch(e => { console.error(e); process.exit(1); });
