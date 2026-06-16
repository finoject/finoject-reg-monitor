// 5つの金融関連サイトを巡回し、新着項目(日付・タイトル・リンク)を抽出して
// reg-monitor-site/data.json に蓄積する。前回までに見たURLと比較し、新規のみ追加。
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'reg-monitor-site', 'data.json');
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

// ---- ユーティリティ ----
const pad = n => String(n).padStart(2,'0');
function findDate(text){
  if(!text) return null; let m;
  if ((m = text.match(/令和\s*(\d+)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) return `${2018+(+m[1])}-${pad(+m[2])}-${pad(+m[3])}`;
  if ((m = text.match(/(20\d{2})\s*[年.\-\/]\s*(\d{1,2})\s*[月.\-\/]\s*(\d{1,2})/))) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  return null;
}
function isoFromRSSDate(s){ if(!s) return null; const d=new Date(s); return !isNaN(d)?`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`:findDate(s); }
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
  { key:'jpx',   name:'日本取引所グループ', type:'rss-index', url:'https://www.jpx.co.jp/rss/index.html' },
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
  let text = `:bell: *金融規制ウォッチ｜本日の新着 (${dateStr})* — ${addedItems.length}件`;
  for (const ag of order){
    const list = byAg[ag]; if (!list || !list.length) continue;
    text += `\n\n*${esc(SHORT[ag]||ag)}* (${list.length})`;
    for (const it of list){ text += `\n• <${it.url}|${esc(it.title)}>${it.updated?' :arrows_counterclockwise:(更新)':''}`; }
  }
  if (addedItems.length > CAP) text += `\n\n…ほか ${addedItems.length - CAP} 件`;
  text += `\n\n全件: https://finoject.github.io/finoject-reg-monitor/`;
  try {
    const r = await fetch(hook, { method:'POST', headers:{'Content-Type':'application/json; charset=utf-8'}, body: JSON.stringify({ text }) });
    console.log('Slack投稿: ' + (r.ok ? 'OK' : 'HTTP '+r.status));
  } catch(e){ console.log('Slack投稿 失敗: ' + (e.message||e)); }
}

async function main(){
  let store = { generatedAt:null, items:[] };
  if (fs.existsSync(OUT)) { try { store = JSON.parse(fs.readFileSync(OUT,'utf8')); } catch{} }
  const firstRun = !store.items.length;            // 初回はbaseline取得のみ（大量投稿を防ぐ）
  const byUrl = new Map(store.items.map(it=>[it.url, it]));   // URL→既存レコード
  const nowIso = new Date().toISOString();
  const report=[]; const addedItems=[];
  for (const s of SITES){
    const res = await crawlSite(s);
    report.push(`${s.name}: ${res.ok?res.items.length+'件':'失敗('+res.error+')'}`);
    for (const it of res.items){
      const prev = byUrl.get(it.url);
      if (!prev){                                  // 新規URL
        const rec={ ...it, detectedAt: nowIso }; store.items.push(rec); byUrl.set(it.url, rec); addedItems.push(rec);
      } else if (it.date && (!prev.date || it.date > prev.date)){
        // 同一URLだがサイトの日付が新しい＝定例レポート等の更新。日付/タイトルを更新し「更新」として再浮上
        prev.date = it.date; if(it.title) prev.title = it.title; prev.detectedAt = nowIso; prev.updated = true;
        addedItems.push(prev);
      }
    }
  }
  store.items.sort((a,b)=> (b.date||'').localeCompare(a.date||'') || (b.detectedAt||'').localeCompare(a.detectedAt||''));
  store.generatedAt = nowIso;
  store.sources = SITES.map(s=>({name:s.name, url:s.url}));
  fs.writeFileSync(OUT, JSON.stringify(store, null, 2), 'utf8');
  console.log('=== 巡回結果 ==='); report.forEach(r=>console.log(' - '+r));
  console.log(`新規追加: ${addedItems.length}件 / 総蓄積: ${store.items.length}件 -> ${OUT}`);
  // 新規分をSlackへ（初回baselineは投稿しない）
  if (!firstRun) await postSlack(addedItems);
  else console.log('初回baselineのためSlack投稿はスキップ');
}
main();
