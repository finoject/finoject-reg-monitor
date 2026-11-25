// 通しテスト用の fetch 差し替え。test-weekly-e2e.js から require するほか、
// 直接起動の試験では node --require でこのファイルを先に読ませる（本物の通信を一切しない）
const rss = items => `<?xml version="1.0" encoding="utf-8"?><rss><channel>${items.map(t =>
  `<item><title>${t}</title><link>https://example.test/${encodeURIComponent(t)}</link><pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
const PROB = { 'Passive software relief': 0.8, 'Mortgage statistics': 0.05 };

const jevAsked = [];
const captured = { worker: null, slack: null };
global.fetch = async (url, opt = {}) => {
  const u = String(url);
  const ok = body => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body), arrayBuffer: async () => Buffer.from(body) });
  if (u.includes('typesafe.ai')) {
    const title = JSON.parse(opt.body).state.split('Title: ')[1];
    jevAsked.push(title);
    return ok(JSON.stringify({ answers: { relevant: { type: 'noul', noul: PROB[title] ?? 0.1 } }, usage: { input_tokens: 300 } }));
  }
  if (u.includes('workers.dev')) { captured.worker = JSON.parse(opt.body); return ok(JSON.stringify({ report: 'テスト用の本文' })); }
  if (u.includes('slack.test')) { captured.slack = JSON.parse(opt.body); return ok('ok'); }
  if (u.includes('sec.gov')) return ok(rss(['Passive software relief', 'Mortgage statistics']));
  if (u.includes('fincen.gov')) return ok('');   // 解析0件＝取得不可扱い（全滅でなければ続行する）
  return ok(rss([]));
};

module.exports = { jevAsked, captured };
