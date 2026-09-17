// 回帰テスト用のネットワークスタブ。node -r ./test-netstub.js crawler.js で先に読み込む。
// crawler.js は fetch が失敗すると curl にフォールバックするので、両方を塞がないと
// 「取得失敗」を再現できない（＝そのガードを実挙動で検証できない）。
//
// NETSTUB=off      … 全遮断（全機関失敗の再現）
// NETSTUB=aux-fail … 監視対象6機関だけ固定の作り物を返し、補助データ（Yahooニュース・衆議院）だけ失敗させる
const cp = require('child_process');
const realExecFileSync = cp.execFileSync;
const MODE = process.env.NETSTUB || 'off';

const RSS = (title, link, date) => `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate></item>
</channel></rss>`;

// 監視対象6機関それぞれに、必ず1件は拾える最小の作り物を返す
function fixture(url){
  if (url.includes('fsa.go.jp'))  return `<html><body><a href="/news/20260115/01.html">金融庁のテスト公表物です</a></body></html>`;
  if (url.includes('boj.or.jp'))  return RSS('日本銀行のテスト公表物です', 'https://www.boj.or.jp/x.htm', 'Thu, 15 Jan 2026 10:00:00 +0900');
  if (url.includes('jpx.co.jp/rss/index.html')) return `<html><body><a href="/rss/child.xml">RSS</a></body></html>`;
  if (url.includes('jpx.co.jp'))  return RSS('JPXのテスト公表物です', 'https://www.jpx.co.jp/x.html', 'Thu, 15 Jan 2026 10:00:00 +0900');
  if (url.includes('jsda.or.jp')) return `<html><body><li><div>2026年1月15日</div><a href="/x.html">日本証券業協会のテスト公表物です</a></li></body></html>`;
  if (url.includes('jvcea.or.jp'))return RSS('JVCEAのテスト公表物です', 'https://jvcea.or.jp/x/', 'Thu, 15 Jan 2026 10:00:00 +0900');
  if (url.includes('jicpa.or.jp'))return `<html><body><li><div>2026年1月15日</div><a href="/news/x.html">日本公認会計士協会のテスト公表物です</a></li></body></html>`;
  return null;
}

globalThis.fetch = async (url) => {
  const u = String(url);
  if (MODE === 'aux-fail'){
    const body = fixture(u);
    if (body != null) return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  throw new Error('network disabled by test stub: ' + u);
};
cp.execFileSync = function (file, args) {
  if (file === 'curl' || file === 'pdftotext'){
    if (MODE === 'aux-fail' && file === 'curl'){
      const u = (args || []).find(a => typeof a === 'string' && /^https?:\/\//.test(a)) || '';
      const body = fixture(u);
      if (body != null) return body;
    }
    throw new Error('network disabled by test stub');
  }
  return realExecFileSync.apply(this, arguments);
};
