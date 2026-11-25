// Chaindetective 週次グローバル規制・AML動向ブリーフィング
//
// 毎週金曜17:07 JSTにGitHub Actionsから実行し、
//   ① 海外7機関＋国内(data.json)から対象週（土〜金）の暗号資産/AML関連の公表を集め
//   ② Cloudflare Worker の /ai（task=briefing）でChaindetective向けの構造化レポートを書かせ
//   ③ Slack #金融規制情報 へ投稿する
// までを完結させる。
//
// ローカルのスケジュールタスクに置いていたが、PCでClaude Codeが動いている時しか発火せず、
// 2026年7月28日の初回手動実行以降1度も投稿されていなかった。そのためActionsへ移設した。
//
// 【禁止事項・厳重順守】「Finospect」および「相続」への言及は完全禁止（Worker側のsystemにも明記）。
//
// APIキーはWorker secret(ANTHROPIC_API_KEY)にあり、このリポジトリには置かない。
//
// ローカル検証:  node chaindetective-weekly.js --week-end 2026-08-07 --dry-run

const fs = require('fs');
const path = require('path');
const { nowJst, ymd, resolveWeek } = require('./jstweek');
const { classify } = require('./jev-topic');

const AI_BASE = process.env.AI_ENDPOINT || 'https://finoject-proxy.kimihiro-mine.workers.dev/ai';
// SECは「連絡先を含むUser-Agent」を要求する（無いと403）。他機関にも同じUAで通っている。
const UA = 'finoject-reg-monitor/1.0 (+https://www.finoject.com; kimihiro.mine@finoject.com)';

// 対象領域＝ステーブルコイン／トラベルルール／資産保護／AML・CFT／制裁・OFAC。
// これに当たらない一般的な証券・銀行監督の公表は落とす（ブリーフィングの焦点をぼかさないため）。
// 略語は必ず語境界で照合する。単なる部分一致にすると `CFT` が「CFTC」に当たって
// CFTCの全記事が該当扱いになる（実測で誤検出）。略語は大文字のまま照合する。
const TOPIC_ACRONYM = /\b(AML|CFT|VASP|VASPs|OFAC|SDN|BSA|MiCA|DeFi|KYC|FATF)\b/;
const TOPIC_TEXT = new RegExp([
  'crypto', 'digital asset', 'virtual asset', 'stablecoin', 'stable coin', 'travel rule',
  'anti-money laundering', 'money launder', 'terrorist financing', 'illicit financ',
  'sanction', 'blockchain', 'tokeni', 'digital currency', 'custody of digital',
  'GENIUS Act', 'distributed ledger', 'DLT', 'Web3', 'eKYC', 'beneficial owner',
  '暗号資産', 'ステーブルコイン', 'トラベルルール', 'マネロン', 'マネー・?ローンダリング',
  '資金洗浄', 'テロ資金', '制裁', '犯罪による収益', '移転防止', '電子決済手段',
].join('|'), 'i');
const isTopic = t => TOPIC_ACRONYM.test(String(t)) || TOPIC_TEXT.test(String(t));

// 自動取得できない機関。黙って落とすと「今週FATFは動きなし」と誤読されるので、必ず明示して申し送る。
const UNREACHABLE = [
  { agency: 'FATF', url: 'https://www.fatf-gafi.org/en/publications.html',
    reason: 'Cloudflareのbot防御により403。自動取得不可（2026-08-13実測）' },
];

const SOURCES = [
  { agency: 'SEC',    kind: 'rss',  url: 'https://www.sec.gov/news/pressreleases.rss' },
  { agency: 'CFTC',   kind: 'rss',  url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml' },
  { agency: 'OCC',    kind: 'rss',  url: 'https://www.occ.gov/rss/occ_news.xml' },          // Windows-1252
  { agency: 'FDIC',   kind: 'rss',  url: 'https://public.govdelivery.com/topics/USFDIC_26/feed.rss' },
  // EBAの /rss.xml は「EBA E-mail alert ○月○日」という中身の無いページしか流さない（2026-11-25実測）。
  // 実際の公表はプレスリリース側にしかなく、USDCをEU域内で初の significant EMT に分類した件
  // （2026-10-14）もこちらにしか載っていなかった。報道発表のフィードに切り替える。
  { agency: 'EBA',    kind: 'rss',  url: 'https://www.eba.europa.eu/news-press/news/rss.xml' },
  // FinCENは機関そのものがAML/CFT専門なので分野フィルタをかけない（全件が対象領域）。
  // 2026-11-25実測：/news-room は /news/ への meta refresh だけを返す311バイトのページになり、
  // HTTPリダイレクトではないので解析が常に0件だった。RSSが用意されているのでそれを使う。
  { agency: 'FinCEN', kind: 'rss', url: 'https://www.fincen.gov/news/index.xml', allTopics: true },
  { agency: 'ESMA',   kind: 'esma',   url: 'https://www.esma.europa.eu/press-news/esma-news' }, // RSSなし→HTML
];

// ---------- 取得 ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 当局サイトは一時的に502やタイムアウトを返す（EBAで実測）。数回は取り直す。
async function fetchText(url, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fetchTextOnce(url); }
    catch (e) { last = e; if (i < attempts) await sleep(i * 3000); }
  }
  throw last;
}

async function fetchTextOnce(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // OCCのフィードは `encoding="Windows-1252"` を宣言する。UTF-8として読むと引用符等が壊れる。
  const head = buf.subarray(0, 200).toString('latin1');
  const m = head.match(/encoding=["']([\w-]+)["']/i);
  const enc = (m && m[1] || 'utf-8').toLowerCase();
  if (enc !== 'utf-8' && enc !== 'utf8') {
    try { return new TextDecoder(enc).decode(buf); } catch { /* 未対応なら下のUTF-8にフォールバック */ }
  }
  return buf.toString('utf8');
}

const decodeEntities = s => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // fromCodePoint（fromCharCodeだとU+FFFF超の数値参照が別文字になる）
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
};

// RSSの日付は RFC822（Fri, 07 Aug 2026 ...）や ISO などまちまち。
// 週の絞り込みはJSTの暦日で行うが、公表元の現地日付とは1日ずれる（米東部の夕方公表＝JSTの翌日）。
// レポートで日付を誤らせないよう、元の表記(published)も一緒に渡す。
function toJstYmd(raw) {
  if (!raw) return '';
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return '';
  return ymd(new Date(t + 9 * 60 * 60 * 1000));
}

function parseRss(xml, agency) {
  const out = [], seen = new Set();
  for (const m of xml.matchAll(/<(item|entry)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const b = m[2];
    const title = tag(b, 'title');
    let url = tag(b, 'link');
    if (!url) {
      // Atomは <link rel="self"> が記事リンク(rel="alternate"／rel無し)より先に来ることがある。
      // 最初のhrefを採ると記事ではなくフィード自身のURLになるので、rel を見て選ぶ。
      const links = [...b.matchAll(/<link\b([^>]*)>/gi)].map(x => x[1]);
      const pick = links.find(a => /rel=["']alternate["']/i.test(a)) || links.find(a => !/rel=/i.test(a));
      const href = (pick || '').match(/href=["']([^"']+)["']/i);
      // RSSの<link>本文はtag()でデコードされるが、Atomの属性値はここで自分でデコードする
      // （&amp; を含むURLがそのまま残るとリンク切れになる）
      if (href) url = decodeEntities(href[1]);
    }
    const published = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    if (!title || !url || seen.has(url)) continue;   // フィード側の重複をそのまま渡さない
    seen.add(url);
    out.push({ agency, title, url, date: toJstYmd(published), published });
  }
  return out;
}

function parseEsma(html) {
  const out = [], seen = new Set();
  for (const m of html.matchAll(/<a[^>]+href="(\/press-news\/esma-news\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = 'https://www.esma.europa.eu' + m[1];
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, ''));
    if (!title || seen.has(url)) continue;
    seen.add(url);
    // 一覧の日付は DD/MM/YYYY。実測（2026-09-01）で、そのカード自身の日付は
    // リンク開始から367〜396字後にあり、次のカードの日付までは2500字以上ある。
    // 600字なら自分の日付だけを確実に拾い、隣のカードには届かない。
    // （300字に縮めた版はESMA全10件の日付を落としていた）
    const after = html.slice(m.index, m.index + 600);
    const d = after.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const published = d ? `${d[3]}-${d[2]}-${d[1]}` : '';
    out.push({ agency: 'ESMA', title, url, date: published, published });
  }
  return out;
}

async function collectOverseas(from, to) {
  const items = [], failed = [], gaps = [];
  for (const s of SOURCES) {
    try {
      const text = await fetchText(s.url);
      // kind を検証せず「rss以外は全部ESMA」にすると、設定のタイプミスが
      // 「ページ構造変更の疑い」として記録され、原因が隠れる。未対応なら落とす。
      const parse = { rss: () => parseRss(text, s.agency), esma: () => parseEsma(text) }[s.kind];
      if (!parse) throw new Error(`未対応の kind: ${s.kind}（SOURCESの設定ミス）`);
      const parsed = parse();
      // 対象週に入るものだけを採る。日付が取れない項目を「念のため」入れると、
      // 別の週の公表が「今週の動向」として混ざるので入れない。
      const dated = parsed.filter(x => x.date);
      // 分野の選別はここではせず、main() で Jev（jev-topic.js）にまとめてかける
      const picked = parsed.filter(x => x.date && x.date >= from && x.date <= to)
        .map(x => (s.allTopics ? { ...x, allTopics: true } : x));
      items.push(...picked);
      console.log(`  ${s.agency}: 取得${parsed.length}件（日付判明${dated.length}件） → 対象週 ${picked.length}件`);
      // HTTP 200でも中身がエラーページやタグ名変更だとパーサーは黙って0件を返す。
      // これを「静かな週」と同じ扱いにすると、全ソースが壊れても投稿が続いて気づけない。
      if (!parsed.length) {
        failed.push({ agency: s.agency, url: s.url, reason: '取得はできたが1件も解析できなかった（ページ構造変更・エラーページの疑い）' });
      } else if (!dated.length) {
        failed.push({ agency: s.agency, url: s.url, reason: `${parsed.length}件取得できたが日付を1件も特定できず、対象週で絞れなかった（一覧の構造変更の疑い）` });
      }
      // CFTC・OCC・EBA・ESMAのフィードは各10件しか流れない。対象期間が長いと古い分が
      // フィードに残らないが、結果は「その機関は静かだった」のと見分けがつかない。
      // どこまで見られたのかを必ず残す。原因は断定しない（配信開始前・元から公表が無い、もありうる）。
      const oldest = dated.reduce((a, x) => (a && a < x.date ? a : x.date), '');
      if (oldest && oldest > to) {
        // 対象期間より後の項目しか残っていない＝この機関については期間を1日も見られていない。
        // 「静かな週」と区別がつかないので、取得できなかったのと同じ扱いにする。
        failed.push({ agency: s.agency, url: s.url,
          reason: `フィードに残っている最古の項目が ${oldest} で、対象期間（${from}〜${to}）より後。` +
            `この機関については対象期間を1日も見られていない` });
      } else if (oldest && oldest > from) {
        // 期間の一部は見られている。取得できた記事があるのに「取得不可」としてモデルに渡すと
        // 「未確認」と書かれてしまうので、unavailable とは別の欄に入れる。
        gaps.push({ agency: s.agency, url: s.url, seenFrom: oldest,
          reason: `フィードに残っている最古の項目が ${oldest}。` +
            `${from} から ${oldest} の前日までは、この機関について公表の有無を確認できていない` });
      }
    } catch (e) {
      failed.push({ agency: s.agency, url: s.url, reason: String(e.message || e) });
      console.log(`  ${s.agency}: 取得失敗 ${e.message || e}`);
    }
  }
  return { items, failed, gaps };
}

function collectDomestic(from, to) {
  const p = path.join(__dirname, '..', 'reg-monitor-site', 'data.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  // items が配列でないのはデータ破損。空配列に読み替えると「国内該当なし」として
  // AIに渡り、欠落が正常な結果に化ける。海外ソースが生きていても全滅判定は通るので、ここで止める。
  if (!data || !Array.isArray(data.items)) throw new Error(`${p} の items が配列ではありません（データ破損。国内分を空として扱いません）`);
  const items = data.items
    .filter(x => x && typeof x.date === 'string' && x.date >= from && x.date <= to)
    .filter(x => isTopic(x.title))
    // published を海外項目と同じ形で必ず持たせる。国内は公表日がそのままJSTなので date と同じ。
    // 欠けているとWorker側の「publishedを使う」指示が国内項目で宙に浮く。
    .map(x => ({ agency: String(x.agency || '国内'), title: String(x.title || ''), url: String(x.url || ''), date: x.date, published: x.date }));
  console.log(`  国内(data.json): 該当分野 ${items.length}件`);
  return items;
}

// ---------- レポート生成・投稿 ----------

async function buildReport(payload) {
  // Worker側に BRIEFING_TOKEN を設定して叩かれ放題を防ぐ場合は、同じ値をここにも渡す
  // （両方とも未設定なら従来どおり通る）。
  const headers = { 'content-type': 'application/json' };
  if (process.env.BRIEFING_TOKEN) headers['x-briefing-token'] = process.env.BRIEFING_TOKEN;
  const res = await fetch(AI_BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify({ task: 'briefing', payload }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`Workerの応答がJSONではありません: ${text.slice(0, 200)}`); }
  if (!res.ok || j.error) {
    // task=briefing 未対応のWorkerだと 400 unknown task が返る＝デプロイ漏れ。原因が分かる形で落とす。
    throw new Error(`Worker /ai (task=briefing) が失敗: ${res.status} ${JSON.stringify(j).slice(0, 300)}` +
      (j.error === 'unknown task' ? '\n→ Workerに task=briefing を追加してデプロイしてください（finoject-law-viewer/proxy/worker.js）' : ''));
  }
  if (typeof j.report !== 'string' || !j.report.trim()) throw new Error('Workerの応答に report がありません');
  const banned = j.report.match(/Finospect|相続/i);
  if (banned) throw new Error(`禁止語が含まれています（投稿中止）: ${banned[0]}`);
  return j.report.trim();
}

async function postSlack(report) {
  const url = process.env.SLACK_WEBHOOK_URL;   // 呼び出し前にmain()で存在を確認済み
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: report }),
  });
  if (!res.ok) throw new Error(`Slack投稿に失敗: ${res.status} ${await res.text()}`);
  console.log('Slackへ投稿しました');
}

// ---------- 本体 ----------

function parseArgs(argv) {
  const a = { weekEnd: null, dryRun: false, out: null };
  const value = i => { if (i >= argv.length) throw new Error(`${argv[i - 1]} に値が指定されていません`); return argv[i]; };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--week-end') a.weekEnd = value(++i);
    else if (argv[i] === '--out') a.out = value(++i);
    else if (argv[i] === '--dry-run') a.dryRun = true;   // 収集のみ。Worker呼び出しもSlack投稿もしない
    else throw new Error(`不明な引数: ${argv[i]}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const wk = resolveWeek(args.weekEnd);
  console.log(`対象期間 ${wk.fromLabel}〜${wk.toLabel}`);

  console.log('収集:');
  const { items: candidates, failed, gaps } = await collectOverseas(wk.from, wk.to);
  const sel = await classify(candidates, isTopic);
  const strip = ({ allTopics, via, ...x }) => x;
  const overseas = sel.included.map(strip);
  const overseasExcluded = sel.excluded.map(strip);
  console.log(`  海外の分野選別: ${sel.note} → 採用${overseas.length}件／除外${overseasExcluded.length}件` +
    (sel.tokens ? `（Jev入力${sel.tokens}トークン＝$${(sel.tokens * 0.042 / 1e6).toFixed(6)}）` : ''));
  const domestic = collectDomestic(wk.from, wk.to);

  // Worker側は件数上限で先頭から切るので、機関の並び順のまま渡すと
  // 上限超過時に後段の機関（FinCEN・ESMA＝AMLの本丸）が丸ごと落ちる。
  // 日付の新しい順に並べ替えて、切られるのが「古い項目」になるようにする。
  const byDateDesc = (a, b) => String(b.date).localeCompare(String(a.date));
  overseas.sort(byDateDesc);
  overseasExcluded.sort((a, b) => (b.jev ?? -1) - (a.jev ?? -1));   // 確率の高い順＝惜しいものから目に入る
  domestic.sort(byDateDesc);

  const payload = {
    weekFrom: wk.from, weekTo: wk.to, weekLabel: `${wk.fromLabel}〜${wk.toLabel}`,
    postDate: ymd(nowJst()),
    overseas, domestic,
    // 分野選別で落とした海外記事。書き手が取りこぼしを目で確かめるために残す（Workerには渡さない）
    overseasFilter: { mode: sel.mode, note: sel.note, jevInputTokens: sel.tokens },
    overseasExcluded,
    // 取れなかったものは必ずモデルに渡す。「動きなし」と書かせないため。
    unavailable: [...UNREACHABLE, ...failed],
    // 取得はできたが、対象期間の古い側をフィードで見られなかった機関。
    // unavailable に混ぜるとWorker側が「自動取得できなかった」と説明してしまうので分ける。
    coverageGaps: gaps,
  };

  if (args.out) { fs.writeFileSync(args.out, JSON.stringify(payload, null, 2), 'utf8'); console.log(`収集結果 ${args.out}`); }

  // 「該当が無い静かな週」と「全ソースが壊れた」を取り違えない。
  // 取得が全滅したときだけ落とす。取得できたうえで0件なら、その旨を書いたブリーフィングを出す。
  // この判定は --dry-run より前に置く。後ろに置くと、動作確認のつもりの実行が全滅していても
  // 終了コード0になり「確認できた」と誤読する。
  // 件数ではなく機関の数で数える。1機関から失敗が2件入る経路が将来できても、
  // 他が生きているのに全滅と誤判定しないため。
  const failedAgencies = new Set(failed.map(f => f.agency));
  if (failedAgencies.size >= new Set(SOURCES.map(s => s.agency)).size) {
    throw new Error(`海外ソース${SOURCES.length}件すべての取得に失敗しました。構造変更・障害を疑ってください（投稿は行いません）\n` +
      failed.map(f => `  - ${f.agency}: ${f.reason}`).join('\n'));
  }

  if (args.dryRun) {
    console.log(`\n--dry-run: 海外${overseas.length}件（除外${overseasExcluded.length}件）／国内${domestic.length}件／取得不可${payload.unavailable.length}件／期間を覆えず${gaps.length}件。Worker・Slackは呼びません`);
    return;
  }

  // 本番実行でwebhookが無いのは secret の登録漏れ。黙ってスキップすると
  // 「投稿が無いのにジョブは成功」になって気づけないので落とす。
  if (!process.env.SLACK_WEBHOOK_URL) {
    throw new Error('SLACK_WEBHOOK_URL が設定されていません（GitHub Actions secretの登録漏れ）。レポートを生成せず中止します');
  }

  if (!overseas.length && !domestic.length) {
    console.log('対象週の該当項目は0件でした（取得は成功）。該当なしとして投稿します');
  }

  // 除外一覧は書き手の点検用。Workerに渡すと落とした記事まで本文に書かれるので外す
  const { overseasExcluded: _ex, overseasFilter: _fl, ...toWorker } = payload;
  const report = await buildReport(toWorker);
  await postSlack(report);
}

// テストから main() を直接呼べるようにする（node で直接起動したときだけ自動で走る）
if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); });
module.exports = { main };
