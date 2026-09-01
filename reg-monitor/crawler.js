// 5つの金融関連サイトを巡回し、新着項目(日付・タイトル・リンク)を抽出して
// reg-monitor-site/data.json に蓄積する。前回までに見たURLと比較し、新規のみ追加。
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { buildLawrefs, worthFetching, NEWS_QUERY, matchSource, dedupeNews, isNewsNoise, matchLaws } = require('./enrich');

const OUT = path.join(__dirname, '..', 'reg-monitor-site', 'data.json');
const FEED_OUT = path.join(__dirname, '..', 'reg-monitor-site', 'feed.xml');   // RSS（誰でも自分のSlack等で購読可能にする）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// fetch を試し、失敗したら curl にフォールバック（一部サイトはNode fetchが繋がらないため）
async function get(url){
  try {
    const r = await fetch(url, { headers:{ 'User-Agent':UA, 'Accept-Language':'ja,en;q=0.8' }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } catch (e) {
    return execFileSync('curl', ['-sL','--max-time','30','-A',UA,'-H','Accept-Language: ja',url],
      { encoding:'utf8', maxBuffer: 50*1024*1024 });
  }
}

// ---- 本文取得（法令連携の精度向上のため、リンク先ページ・PDFのテキストを読む）----
// PDFを一時ファイルへ落として pdftotext で抽出（poppler-utils。失敗時は空文字）
function pdfText(url){
  const tmp = path.join(os.tmpdir(), 'reg_'+Date.now()+'_'+Math.floor(performance.now())+'.pdf');
  try {
    execFileSync('curl', ['-sL','--max-time','30','-A',UA,'-o',tmp,url], { maxBuffer: 60*1024*1024 });
    const txt = execFileSync('pdftotext', ['-layout','-q','-enc','UTF-8',tmp,'-'], { encoding:'utf8', maxBuffer: 60*1024*1024 });
    return txt || '';
  } catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch{} }
}
// リンク先ページの可視テキスト（＋同ページからリンクされた主要PDFの本文）を返す。ネット失敗は空。
async function fetchBodyText(url){
  if (/\.pdf(\?|#|$)/i.test(url)) return pdfText(url).slice(0,200000);   // URL自体がPDF（日銀の会見要旨・講演、FSAのPDF等）→ pdftextで直接抽出
  let html=''; try { html = await get(url); } catch { return ''; }
  if (/^%PDF|^\s*%PDF/.test(html)) return pdfText(url).slice(0,200000);   // 拡張子が無くても中身がPDFなら抽出（従来は諦めて空＝「本文未取得」の一因だった）
  let text='', pdfs=[];
  try {
    const $ = cheerio.load(html);
    $('script,style,noscript').remove();
    text = clean($('main').text() || $('body').text() || '');
    // 改正・パブコメ系の本文PDF（新旧対照表/府令案/概要 等）を最大3本まで読む
    $('a[href$=".pdf"], a[href*=".pdf?"]').each((i,el)=>{
      const u = abs($(el).attr('href'), url); if (u && pdfs.length<6) pdfs.push(u);
    });
  } catch {}
  let acc = text;
  for (const u of pdfs.slice(0,3)){ acc += '\n' + pdfText(u); if (acc.length > 200000) break; }
  return acc.slice(0, 200000);
}

// ---- ユーティリティ ----
const pad = n => String(n).padStart(2,'0');
function findDate(text){
  if(!text) return null; let m;
  if ((m = text.match(/令和\s*(\d+)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) return `${2018+(+m[1])}-${pad(+m[2])}-${pad(+m[3])}`;
  if ((m = text.match(/(20\d{2})\s*[年.\-\/]\s*(\d{1,2})\s*[月.\-\/]\s*(\d{1,2})/))) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  return null;
}
// RSSの日付は必ずJSTの暦日に落とす。getFullYear/getMonth/getDate は実行環境のローカル時刻を返すため、
// GitHub Actions（UTC）で走らせると JST 00:00〜08:59 の公表が前日付になる（実測で確認済み）。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ymdJst = d => new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
function isoFromRSSDate(s){ if(!s) return null; const d=new Date(s); return !isNaN(d)?ymdJst(d):findDate(s); }
function clean(s){
  return (s||'').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#8217;/g,"'")
    .replace(/\s+/g,' ').trim();
}
function abs(href, base){ try { return new URL(href, base).href.replace(/^http:\/\//,'https://'); } catch { return null; } }
function titleClean(t){
  t = t.replace(/^\s*(令和\s*\d+\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|20\d{2}[.\-\/]\d{1,2}[.\-\/]\d{1,2})\s*/,'');
  for(let k=0;k<2;k++) t = t.replace(/^\s*(お知らせ|プレスリリース|セミナー|その他|会長声明|報道発表資料|報道発表|新着情報|新着|公表|法定開示|業務情報|JPXからのお知らせ)\s*/,'');
  return t.trim();
}

// ---- ノイズ判定 ----
// 実務的に価値の無い文字列（サイト保守・ページの定期リフレッシュ通知等）。全機関・将来追加分に適用。
// 取りこぼし防止のため保守的に（具体的な無価値パターンのみ）。新たなノイズが出たらここに追記する。
const NOISE_TITLE = [
  /ページを更新しました/,        // 「〜のページを更新しました」＝サイト保守通知
  /^\[マーケット情報\]/,          // JPXサイト更新情報カテゴリ（データページの定期更新通知）
  // 定型データ・一覧の定期更新通知（例: 気配提示状況/最終清算数値・最終決済価格/制度信用・貸借銘柄一覧/不適正意見等一覧/ご紹介/対応 を更新しました）。
  // 鉤括弧「」付きの実質的更新（JSDA「○○統計情報・取扱状況」を更新しました 等）は対象外＝残す。
  /(?:一覧|状況|数値|価格|ご紹介|対応)を更新しました/,
];
// 「〜を更新しました」系は、法令・規制の実質的な公表にも当たる
// （例:「資金決済法に関するQ&Aの対応を更新しました」）。ただし例外を広く取ると
// 明確なノイズまで通す。一度「法」1文字を含めば救う実装にしたところ、
// 「[マーケット情報] 法定開示情報を更新しました」まで残す状態になった。
//
// そこで2段にする。
//   強いノイズ標識（カテゴリ見出し等）＝ 常にノイズ。例外を認めない
//   弱いノイズ標識（〜を更新しました）＝ 規制文脈のときだけ残す
// 規制文脈の判定は推測の正規表現ではなく、**既知の法令辞書 matchLaws（30文書）** と
// 具体的な行政文書の語だけで行う。辞書に無い「利用法」「法定開示」に誤反応しない。
//
// isNoise は蓄積済みの項目も毎回削除する（下の store.items.filter）ため、
// 広すぎる判定は過去分まで遡って消す。迷ったら残す側に倒す。
const NOISE_STRONG = [
  /^\[マーケット情報\]/,          // JPXサイト更新情報カテゴリ（データページの定期更新通知）
  /適時開示/,                     // 上場会社の開示。法令名を含んでも規制の公表ではない
  /自己株式|株主優待|決算短信|業績予想/,   // 同上（「会社法に基づく自己株式の取得状況を更新しました」等）
];
const REGULATORY_DOC = /府令|政令|省令|告示|ガイドライン|監督指針|事務ガイドライン|パブリックコメント|意見募集|報告徴求|行政処分|業務改善命令|自主規制規則/;
function isRegulatoryContext(t){
  if (REGULATORY_DOC.test(t)) return true;
  return matchLaws(t).length > 0;             // 既知の法令名を含むか（辞書照合＝誤反応しない）
}
function isNoise(title){
  const t = title || '';
  if (NOISE_STRONG.some(re => re.test(t))) return true;      // 例外を認めない
  if (!NOISE_TITLE.some(re => re.test(t))) return false;
  return !isRegulatoryContext(t);
}

// ---- パーサ ----
function parseRSS(xml, agency, base){
  const items=[];
  const blocks = xml.split(/<item[\s>]/i).slice(1).concat(xml.split(/<entry[\s>]/i).slice(1));
  for(const b of blocks){
    const title = clean((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]);
    let link = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)||[])[1];
    if(!link){ const lm=b.match(/<link[^>]*href="([^"]+)"/i); if(lm) link=lm[1]; }
    const dateRaw = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)||b.match(/<dc:date>([\s\S]*?)<\/dc:date>/i)||b.match(/<updated>([\s\S]*?)<\/updated>/i)||[])[1];
    // RSSのlinkが相対パス（JPX等）でも正しく解決するためフィードURLをbaseに使う
    if(title && link) items.push({ agency, title, url: abs(link.trim(), base||('https://'+agency)), date: isoFromRSSDate(dateRaw) });
  }
  return items;
}
// RSSハブ(大元の「RSS」一覧ページ)から子フィードのURLを全て発見する。
// 機関がRSS一覧ページを持つ場合、毎回ここを見て子RSSを動的に辿る→フィードが増減しても自動追従。
function discoverFeeds(html, base, exclude){
  const set = new Set();
  for (const m of html.matchAll(/(?:href|src)="([^"]+\.(?:xml|rdf|rss)(?:\?[^"]*)?)"/gi)){
    const u = abs(m[1], base);
    if (!u || /sitemap/i.test(u)) continue;
    if (exclude && exclude.some(p => u.includes(p))) continue;   // 任意の除外パターン（ノイズフィード等）
    set.add(u);
  }
  return [...set];
}
// 金融庁: ニュースURLに日付(YYYYMMDD)が入る → URLから日付を取得（最も確実）
function parseFSA(html, base){
  const $=cheerio.load(html); const items=[]; const seen=new Set();
  $('a[href]').each((i,el)=>{
    const href=$(el).attr('href')||''; const title=clean($(el).text());
    if(!/\/news\//.test(href) || title.length<6) return;
    const m=href.match(/(20\d{2})(\d{2})(\d{2})/); if(!m) return;
    const mm=+m[2], dd=+m[3]; if(mm<1||mm>12||dd<1||dd>31) return;
    const url=abs(href,base); if(!url||seen.has(url)) return; seen.add(url);
    items.push({ agency:'金融庁', title, url, date:`${m[1]}-${m[2]}-${m[3]}` });
  });
  return items;
}
// 汎用: 日付が近傍にある本文リンク
function parseHTML(html, agency, base){
  const $=cheerio.load(html); const items=[]; const seen=new Set();
  $('a[href]').each((i,el)=>{
    const $a=$(el); const title=clean($a.text()); let href=$a.attr('href');
    if(!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href) || title.length<8) return;
    let date=null, node=$a;
    for(let k=0;k<4 && !date;k++){ date=findDate($.html(node)); if(!date){ node=node.parent(); if(!node.length) break; } }
    if(!date) return;
    const url=abs(href,base); if(!url||seen.has(url)) return; seen.add(url);
    items.push({ agency, title:titleClean(title), url, date });
  });
  return items;
}

// 監視対象の全機関。1回の巡回でこの配列を全件ループ取得する（巡回は機関単位でなくワークフロー単位）。
// → cron（crawl.yml: JST 8/11/14/17/20 の1日5回）は全機関共通。ここに機関を追加すれば自動的に同頻度で監視される。
// 【恒久ルール】全組織を1日複数回巡回する。将来追加する組織もこの配列に足すだけで同頻度監視。頻度は減らさない。
const SITES = [
  { key:'fsa',   name:'金融庁',            type:'fsa',  url:'https://www.fsa.go.jp/news/index.html' },
  { key:'boj',   name:'日本銀行',          type:'rss',  url:'https://www.boj.or.jp/rss/whatsnew.xml' },
  // JPXは「RSS一覧」ページ(ハブ)を指定。マーケットニュース/JPXニュース/売買停止(株式)/売買停止(先物・オプション)/注意喚起/サイト更新情報 の全子RSSを毎回自動発見して巡回する。
  { key:'jpx',   name:'日本取引所グループ', type:'rss-index', url:'https://www.jpx.co.jp/rss/index.html', excludeFeeds:['site-updates'] },  // サイト更新情報(ページ更新の保守通知=ノイズ)は除外
  { key:'jsda',  name:'日本証券業協会',    type:'html', url:'https://www.jsda.or.jp/shinchaku/index.html', fallbackFile:'jsda.html' },
  { key:'jvcea', name:'JVCEA',             type:'rss',  url:'https://jvcea.or.jp/feed/' },
  { key:'jicpa', name:'日本公認会計士協会', type:'html', url:'https://jicpa.or.jp/news/information/' },
];

async function crawlSite(s){
  try {
    let items = [];
    if (s.type === 'rss-index'){
      // RSSハブを取得→子フィードを全発見→各フィードを巡回（毎回。フィード増減に自動追従）
      const hub = await get(s.url);
      const feeds = discoverFeeds(hub, s.url, s.excludeFeeds);
      for (const f of feeds){
        try { const fx = await get(f); items = items.concat(parseRSS(fx, s.name, f).slice(0, 40)); } catch(_){}
      }
    } else {
      let body;
      try { body = await get(s.url); }
      catch(err){
        // host環境(VPN等)で取得できない場合のローカルフォールバック（クラウド実行では不要）
        if (s.fallbackFile && fs.existsSync(path.join(__dirname, s.fallbackFile)))
          body = fs.readFileSync(path.join(__dirname, s.fallbackFile), 'utf8');
        else throw err;
      }
      items = s.type==='rss' ? parseRSS(body, s.name, s.url)
            : s.type==='fsa' ? parseFSA(body, s.url)
            : parseHTML(body, s.name, s.url);
    }
    items = items.filter(it => it.date && it.url && it.title);
    items.sort((a,b)=> b.date.localeCompare(a.date));
    // rss-indexは複数フィードを束ねるため全件返す（各フィードは40件で制限済み）。単一ソースは40件に制限。
    return { ok:true, items: s.type==='rss-index' ? items : items.slice(0, 40) };
  } catch(e){ return { ok:false, error:String(e.message||e), items:[] }; }
}

// 新規分をSlackへ投稿（SLACK_WEBHOOK_URL が設定されている時のみ。新規ゼロなら送らない）
// RSS 2.0 フィードを生成（reg-monitor-site/feed.xml）。
// 目的: 利用者が各自のSlack（公式RSSアプリ /feed subscribe <url>）・Teams・Feedly等で、サーバ秘密情報なしに更新を購読できるようにする。
// pubDate=detectedAt（当方が新着検知した時刻）＝購読側で「新着」として通知される。最新検知順に最大60件。
function buildFeed(store){
  const xe = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  const SHORT = { '日本取引所グループ':'JPX' };
  const SELF = 'https://finoject.github.io/finoject-reg-monitor/feed.xml';
  const items = store.items.slice()
    .sort((a,b)=> (b.detectedAt||'').localeCompare(a.detectedAt||'') || (b.date||'').localeCompare(a.date||''))
    .slice(0, 60);
  const rfc822 = iso => { try { return new Date(iso).toUTCString(); } catch { return new Date().toUTCString(); } };
  const entries = items.map(it=>{
    const ag = SHORT[it.agency] || it.agency || '';
    const refs = (it.lawrefs && it.lawrefs.length)
      ? '　関連法令: ' + [...new Set(it.lawrefs.map(r=>(r.label||'').replace(/\s*第.+$/,'')))].slice(0,4).join('、')
      : '';
    const desc = `[${ag}]${it.date?(' '+it.date):''}${it.updated?'（更新）':''}${refs}`;
    return `    <item>
      <title>${xe('['+ag+'] '+(it.title||''))}</title>
      <link>${xe(it.url)}</link>
      <guid isPermaLink="false">${xe(it.url)}</guid>
      <pubDate>${rfc822(it.detectedAt || it.date)}</pubDate>
      <category>${xe(ag)}</category>
      <description>${xe(desc)}</description>
    </item>`;
  }).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>finoject Financial Regulation Watch</title>
    <link>https://finoject.github.io/finoject-law-viewer/</link>
    <atom:link href="${SELF}" rel="self" type="application/rss+xml"/>
    <description>金融庁・日本銀行・JPX・日本証券業協会・日本暗号資産等取引業協会・日本公認会計士協会の新着公表物（関連法令付き）。finoject提供・非公式。</description>
    <language>ja</language>
    <lastBuildDate>${rfc822(store.generatedAt || new Date().toISOString())}</lastBuildDate>
${entries}
  </channel>
</rss>
`;
  fs.writeFileSync(FEED_OUT, xml, 'utf8');
  console.log('RSS書き出し: ' + items.length + '件 -> ' + FEED_OUT);
}

async function postSlack(addedItems){
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook || !addedItems.length) return;
  const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const SHORT = { '日本取引所グループ':'JPX' };
  const order = SITES.map(s=>s.name);
  const jst = new Date(Date.now()+9*3600000);
  const dateStr = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}`;
  const CAP = 60;                       // 安全のため1通あたり最大件数
  const capped = addedItems.slice(0, CAP);
  const byAg = {};
  for (const it of capped){ (byAg[it.agency]=byAg[it.agency]||[]).push(it); }
  let text = `:bell: *finoject Financial Regulation Watch｜本日の新着 (${dateStr})* — ${addedItems.length}件`;
  for (const ag of order){
    const list = byAg[ag]; if (!list || !list.length) continue;
    text += `\n\n*${esc(SHORT[ag]||ag)}* (${list.length})`;
    for (const it of list){ text += `\n• <${it.url}|${esc(it.title)}>${it.updated?' :arrows_counterclockwise:(更新)':''}`; }
  }
  if (addedItems.length > CAP) text += `\n\n…ほか ${addedItems.length - CAP} 件`;
  text += `\n\nfinoject Financial Regulation Deck（本日の更新・条文・規制動向を1画面で）: https://finoject.github.io/finoject-law-viewer/`;
  try {
    const r = await fetch(hook, { method:'POST', headers:{'Content-Type':'application/json; charset=utf-8'}, body: JSON.stringify({ text }) });
    console.log('Slack投稿: ' + (r.ok ? 'OK' : 'HTTP '+r.status));
  } catch(e){ console.log('Slack投稿 失敗: ' + (e.message||e)); }
}

// ---- 関連ニュース：Yahoo!ニュース検索から見出し＋直リンクを取得（法令ビューアの規制動向枠に補足表示）----
// Yahoo記事は直URL(news.yahoo.co.jp/articles/…)なので、プロキシ経由で画面内に差し込み表示できる。
// （Googleニュース検索のRSSはリダイレクトURLで実記事に解決できず埋め込み不可のため、Yahoo検索に変更）
async function yahooNews(q){
  const url = 'https://news.yahoo.co.jp/search?p=' + encodeURIComponent(q) + '&ei=utf-8';
  let html=''; try { html = await get(url); } catch { return []; }
  const $ = cheerio.load(html); const out=[]; const seen=new Set();
  $('.newsFeed_list li').each((i, li) => {
    const a = $(li).find('a[href*="/articles/"]').first();
    let href = a.attr('href'); if (!href) return;
    href = href.split('?')[0].split('#')[0];
    if (seen.has(href)) return; seen.add(href);
    const full = clean(a.text());
    const title = (full.split(/[……]/)[0] || full).trim();   // Yahooは「見出し…要約 媒体」。…の前が見出し
    if (!title || isNewsNoise(title)) return;
    // 日付はYahoo検索結果から確実に取れない（古い記事を当年と誤認する）ため付けない＝記事内で確認できる
    out.push({ title, url: href, source:'Yahoo', date:'' });
  });
  return out;
}
// 各文書(law_id)分の関連ニュースを取得。クエリは重複するので一意クエリだけ叩いて結果を共有する。
async function fetchLawNews(){
  const out = {};
  const q2ids = {};
  for (const [id,q] of Object.entries(NEWS_QUERY)){ (q2ids[q]=q2ids[q]||[]).push(id); }
  for (const [q,ids] of Object.entries(q2ids)){
    let news = [];
    try { news = dedupeNews(await yahooNews(q)).slice(0, 6); } catch {}
    for (const id of ids) out[id] = news;
  }
  console.log('関連ニュース取得(Yahoo): ' + Object.keys(out).filter(k=>out[k].length).length + '/' + Object.keys(out).length + ' 文書分');
  return out;
}

// ---- 国会の審議状況：衆議院 議案一覧から、対象法令に関する法律案のステータスを取得 ----
// menu.htm（最新国会回次）の各行に 件名／審議状況（例「衆議院で審議中」「成立」）／経過リンク が揃っている。
// 件名を法令名辞書(matchLaws)で当てて、対象法令(法律)に紐付ける。data.json の store.dietbills[law_id] に格納。
async function fetchDietBills(){
  const out = {};
  const MENU = 'https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/menu.htm';
  let html = '';
  try {
    const r = await fetch(MENU, { headers:{ 'User-Agent':UA, 'Accept-Language':'ja' }, signal: AbortSignal.timeout(25000) });
    html = new TextDecoder('shift_jis').decode(await r.arrayBuffer());      // 衆議院サイトはShift_JIS
  } catch(e) {
    try { const b = execFileSync('curl', ['-sL','--max-time','30','-A',UA, MENU], { encoding:'buffer', maxBuffer: 50*1024*1024 });
          html = new TextDecoder('shift_jis').decode(b); } catch(_) { return out; }
  }
  if (!html) return out;
  const session = (html.match(/第(\d+)回国会/)||[])[1] || '';
  const base = 'https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/';
  const $ = cheerio.load(html);
  $('tr').each((i, tr) => {
    const tds = $(tr).find('td'); if (tds.length < 5) return;
    const name = clean($(tds[2]).text());
    if (!name || !/法律案/.test(name)) return;                              // 法律案の行のみ
    const status = clean($(tds[3]).text());
    const link = $(tds[4]).find('a[href*="keika"]').attr('href');
    const url = link ? abs(link, base) : MENU;
    const ids = [...new Set(matchLaws(name, true).map(r => r.id))];         // 件名を法令名で厳格マッチ→対象法令(法律)に紐付け
    for (const id of ids){ (out[id] = out[id] || []).push({ session, name, status, url }); }
  });
  const n = Object.values(out).reduce((a,b)=>a+b.length,0);
  console.log(`国会議案(第${session}回): 対象法案 ${n}件 / ${Object.keys(out).length}法令分`);
  return out;
}

// ---- 法令連携：各itemに lawrefs（参照法令＋条＋種別）を付与 ----
// 見出しだけで判る分は常に算出。worthFetchingな新規itemは本文/PDFまで読んで精度を上げる。
// 1回の巡回での本文取得数は上限を設け（クロール負荷の抑制）、未処理分は次回以降に回す。
const MAX_FETCH_PER_RUN = 40;
const ENRICH_VERSION = 2;   // 法令照合ロジックを更新したら +1。既存itemも一度だけ再enrichして修正を反映（2026-06-19: 日本語内空白の正規化）
const BODY_CACHE = new Map();   // この巡回中に取得した本文を url→text でキャッシュ（enrichとaiSummarizeで二重取得を避ける）
async function enrichItems(items){
  let fetched = 0, fromBody = 0;
  for (const it of items){
    if (it.enriched && it.enrichV === ENRICH_VERSION) continue;   // 処理済み かつ 現行ロジック版なら再処理しない
    // 取得上限に達した回でも、未処理(版違い含む)は次回に回す（下のelseで continue。enrichedは更新しない）
    const titleRefs = buildLawrefs(it.title || '');
    let refs = titleRefs;
    const needFetch = worthFetching(it.title || '') && fetched < MAX_FETCH_PER_RUN;
    if (needFetch){
      fetched++;
      const body = await fetchBodyText(it.url);
      if (body) BODY_CACHE.set(it.url, body);   // aiSummarizeで本文として再利用（二重取得回避）
      if (body){
        const full = buildLawrefs((it.title||'') + '\n' + body);
        // 本文の方が情報量が多いので、条番号付き or より多くの法令を拾えたら採用
        if (full.length && (full.some(r=>r.art) || full.length >= titleRefs.length)){ refs = full; if(full.length>titleRefs.length||full.some(r=>r.art)) fromBody++; }
      }
    } else if (!worthFetching(it.title||'')){
      // 取得不要（株価・統計等）。見出し一致が無ければ法令連携なしで確定
    } else {
      // 取得上限に達した → 今回は見出しのみ。次回再処理できるよう enriched を立てない
      if (titleRefs.length) it.lawrefs = titleRefs;
      continue;
    }
    if (refs.length) it.lawrefs = refs; else delete it.lawrefs;
    it.enriched = new Date().toISOString();
    it.enrichV = ENRICH_VERSION;
  }
  console.log(`法令連携: 本文取得 ${fetched}件 / うち本文で精度向上 ${fromBody}件 / lawrefs付与 ${items.filter(i=>i.lawrefs&&i.lawrefs.length).length}件`);
}

// ---- AI要点の事前生成（巡回時にWorker /ai でClaude要約を作り data.json に保存。一覧カードに即表示用）----
// 法令紐づき(lawrefs有)の高価値更新だけを対象に、1件ずつ生成してキャッシュ（生成は新着時のみ＝低コスト）。
// APIキーはWorker側のsecretにあり、ここ(reg-monitorリポジトリ/Actions)には置かない。
const AI_BASE = process.env.AI_ENDPOINT || 'https://finoject-proxy.kimihiro-mine.workers.dev/ai';
const AI_SUM_VERSION = 3;            // 要点プロンプト/様式を変えたら +1（既存も一度だけ再生成）。v2=本文を渡して具体化(2026-06-19)／v3=URL自体がPDFでも本文抽出＋法令紐づきが無くても本文があれば要約(2026-06-22)
const MAX_AI_PER_RUN = 20;           // 1巡回あたりの生成上限（コスト/レート制御＋本文取得の所要時間。未処理は次回以降に回る）
async function aiSummarize(items){
  let made = 0, tried = 0;
  for (const it of items){                                   // items は日付降順済み＝新しい更新から生成
    if (made >= MAX_AI_PER_RUN || tried >= MAX_AI_PER_RUN) break;   // 生成・試行の両方に上限（本文取得の負荷も抑制）
    if (isNoise(it.title)) continue;                         // サイト保守通知等のノイズは要約しない
    if (Array.isArray(it.aiSummary) && it.aiSumV === AI_SUM_VERSION) continue;   // 生成済みは再生成しない
    // 本文を取得（PDF含む）。法令紐づきが無い項目（日銀会見・講演・談話、当局の公表等）でも、本文が読めれば本文ベースで要約する。
    let body = BODY_CACHE.get(it.url);
    if (body === undefined){ try { body = await fetchBodyText(it.url); } catch { body = ''; } if (body) BODY_CACHE.set(it.url, body); }
    if (!(it.lawrefs && it.lawrefs.length) && !body) continue;   // 法令紐づきも本文も無い＝具体要約の根拠が無い→「本文未取得」要約を作らずスキップ
    tried++;
    try {
      const r = await fetch(AI_BASE, {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ task:'update', payload:{
          title: it.title||'', agency: it.agency||'', date: it.date||'',
          lawrefs: [...new Set((it.lawrefs||[]).map(x=>x.label))].slice(0,8),
          body: (body || '').slice(0, 6000),                 // 本文抜粋（Worker側で具体的変更点を抽出）
        }}),
        signal: AbortSignal.timeout(40000),
      });
      if (!r.ok) continue;                                   // 未デプロイ/失敗時はスキップ（次回再試行）
      const j = await r.json();
      if (j && Array.isArray(j.lines) && j.lines.length){
        it.aiSummary = j.lines.slice(0, 4).map(s => String(s));
        it.aiSumV = AI_SUM_VERSION;
        made++;
      }
    } catch(_){}
  }
  console.log(`AI要点: 生成 ${made}件 / 試行 ${tried}件 / 保有 ${items.filter(i=>Array.isArray(i.aiSummary)).length}件`);
}

async function main(){
  let store = { generatedAt:null, items:[] };
  if (fs.existsSync(OUT)) {
    // 解析できないときに黙って空から始めると、この回の数件だけで data.json を上書きし
    // 蓄積を全て失う。読めない＝異常なので落とす。前回のファイルはそのまま残る。
    let raw;
    try { raw = fs.readFileSync(OUT,'utf8'); }
    catch(e){ throw new Error(`${OUT} を読めません（蓄積を失わないため中止）: ${e.message}`); }
    try { store = JSON.parse(raw); }
    catch(e){ throw new Error(`${OUT} がJSONとして壊れています（蓄積を失わないため中止・ファイルは変更しません）: ${e.message}`); }
    if (!store || typeof store !== 'object' || !Array.isArray(store.items)) {
      throw new Error(`${OUT} の items が配列ではありません（蓄積を失わないため中止・ファイルは変更しません）`);
    }
  }
  const firstRun = !store.items.length;            // 初回はbaseline取得のみ（大量投稿を防ぐ）
  store.items = store.items.filter(it => !isNoise(it.title));  // 既に蓄積済みのノイズ項目も毎回除去（恒久クリーンアップ）
  const byUrl = new Map(store.items.map(it=>[it.url, it]));   // URL→既存レコード
  const nowIso = new Date().toISOString();
  const report=[]; const addedItems=[]; let okSites=0;
  for (const s of SITES){
    const res = await crawlSite(s);
    if (res.ok) okSites++;
    report.push(`${s.name}: ${res.ok?res.items.length+'件':'失敗('+res.error+')'}`);
    for (const it of res.items){
      if (isNoise(it.title)) continue;             // 無価値なノイズ（ページ更新通知等）は追加しない
      const prev = byUrl.get(it.url);
      if (!prev){                                  // 新規URL
        const rec={ ...it, detectedAt: nowIso }; store.items.push(rec); byUrl.set(it.url, rec); addedItems.push(rec);
      } else if (it.date && (!prev.date || it.date > prev.date)){
        // 同一URLだがサイトの日付が新しい＝定例レポート等の更新。日付/タイトルを更新し「更新」として再浮上
        prev.date = it.date; if(it.title) prev.title = it.title; prev.detectedAt = nowIso; prev.updated = true;
        delete prev.enriched;                        // タイトル更新の可能性 → 法令連携を再算出
        addedItems.push(prev);
      }
    }
  }
  // 全機関の取得に失敗した回は、ここで打ち切る。
  // 判定を書き出しの後に置くと、items は残っても generatedAt が失敗回の時刻へ進み、
  // lawnews は全法令が空配列、dietbills は空オブジェクトで上書きされる（補助取得も
  // 同じ障害で空を返すため）。利用側からは「最新の巡回で何も無かった」と誤読される。
  if (okSites === 0) {
    console.log('=== 巡回結果 ==='); report.forEach(r=>console.log(' - '+r));
    console.error(`巡回失敗: ${SITES.length}機関すべての取得に失敗しました。${OUT} は一切変更していません`);
    process.exitCode = 1;
    return;
  }
  await enrichItems(store.items);                    // 法令ビューア連携用に lawrefs を付与（本文/PDFも解析）
  store.lawnews = await fetchLawNews();               // 各法令の関連ニュース（指定ソースの見出し＋リンク）
  store.dietbills = await fetchDietBills();            // 各法令に関する国会の法律案の審議状況（衆議院議案一覧）
  store.items.sort((a,b)=> (b.date||'').localeCompare(a.date||'') || (b.detectedAt||'').localeCompare(a.detectedAt||''));
  await aiSummarize(store.items);                     // AI要点を事前生成（新しい更新から。lawrefs有のみ・上限あり・既生成はスキップ）
  store.generatedAt = nowIso;
  store.sources = SITES.map(s=>({name:s.name, url:s.url}));
  // 一時ファイルへ書いてから差し替える。writeFileSync は原子的でないため、
  // 20分のタイムアウト等で書き込み中に打ち切られると data.json が壊れて残る。
  // 一時名にPIDを入れる：同名だと、手動起動が定期実行と重なったとき片方が他方の
  // 一時ファイルを rename してしまう。失敗したら必ず消す（.tmp を残さない）。
  const tmp = `${OUT}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, OUT);
  } catch(e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  // RSSの書き出し失敗でSlack通知まで落とさない。落とすと、次回は同じURLが既存扱いになって
  // addedItems が0件になり、その回の新着通知が永久に失われる（feed失敗は一過性でも通知は戻らない）。
  try {
    buildFeed(store);                                 // RSS（誰でも各自のSlack/Teams/Feedlyで購読可能に）
  } catch(e) {
    console.error('RSS生成に失敗（data.json は更新済み・Slack通知は続行）: ' + (e && e.message || e));
    process.exitCode = 1;
  }
  console.log('=== 巡回結果 ==='); report.forEach(r=>console.log(' - '+r));
  console.log(`新規追加: ${addedItems.length}件 / 総蓄積: ${store.items.length}件 -> ${OUT}`);
  // 新規分をSlackへ（初回baselineは投稿しない）
  if (!firstRun) await postSlack(addedItems);
  else console.log('初回baselineのためSlack投稿はスキップ');
}

// require されたときは main() を走らせない。回帰テストが本物の関数を叩けるようにするため。
// これが無いと、テスト側が同じ処理を書き写して検証することになり、
// 本番を壊してもテストが通る（実際に RSS日付の3件がその状態だった）。
if (require.main === module) main();

module.exports = { ymdJst, isoFromRSSDate, isNoise, isRegulatoryContext, titleClean, findDate };
