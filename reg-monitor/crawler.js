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
  for(let k=0;k<2;k++) t = t.replace(/^\s*(お知らせ|プレスリリース|セミナー|その他|会長声明|報道発表資料|報道発表|新着情報|新着|公表)\s*/,'');
  return t.trim();
}

// ---- パーサ ----
function parseRSS(xml, agency){
  const items=[];
  const blocks = xml.split(/<item[\s>]/i).slice(1).concat(xml.split(/<entry[\s>]/i).slice(1));
  for(const b of blocks){
    const title = clean((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]);
    let link = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)||[])[1];
    if(!link){ const lm=b.match(/<link[^>]*href="([^"]+)"/i); if(lm) link=lm[1]; }
    const dateRaw = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)||b.match(/<dc:date>([\s\S]*?)<\/dc:date>/i)||b.match(/<updated>([\s\S]*?)<\/updated>/i)||[])[1];
    if(title && link) items.push({ agency, title, url: abs(link.trim(), 'https://'+agency), date: isoFromRSSDate(dateRaw) });
  }
  return items;
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

const SITES = [
  { key:'fsa',   name:'金融庁',            type:'fsa',  url:'https://www.fsa.go.jp/news/index.html' },
  { key:'boj',   name:'日本銀行',          type:'rss',  url:'https://www.boj.or.jp/rss/whatsnew.xml' },
  { key:'jsda',  name:'日本証券業協会',    type:'html', url:'https://www.jsda.or.jp/shinchaku/index.html', fallbackFile:'jsda.html' },
  { key:'jvcea', name:'JVCEA',             type:'rss',  url:'https://jvcea.or.jp/feed/' },
  { key:'jicpa', name:'日本公認会計士協会', type:'html', url:'https://jicpa.or.jp/news/information/' },
];

async function crawlSite(s){
  try {
    let body;
    try { body = await get(s.url); }
    catch(err){
      // host環境(VPN等)で取得できない場合のローカルフォールバック（クラウド実行では不要）
      if (s.fallbackFile && fs.existsSync(path.join(__dirname, s.fallbackFile)))
        body = fs.readFileSync(path.join(__dirname, s.fallbackFile), 'utf8');
      else throw err;
    }
    let items = s.type==='rss' ? parseRSS(body, s.name)
              : s.type==='fsa' ? parseFSA(body, s.url)
              : parseHTML(body, s.name, s.url);
    items = items.filter(it => it.date && it.url && it.title);
    items.sort((a,b)=> b.date.localeCompare(a.date));
    return { ok:true, items: items.slice(0, 40) };
  } catch(e){ return { ok:false, error:String(e.message||e), items:[] }; }
}

async function main(){
  let store = { generatedAt:null, items:[] };
  if (fs.existsSync(OUT)) { try { store = JSON.parse(fs.readFileSync(OUT,'utf8')); } catch{} }
  const seenUrls = new Set(store.items.map(it=>it.url));
  const nowIso = new Date().toISOString();
  const report=[]; let added=0;
  for (const s of SITES){
    const res = await crawlSite(s);
    report.push(`${s.name}: ${res.ok?res.items.length+'件':'失敗('+res.error+')'}`);
    for (const it of res.items){
      if (!seenUrls.has(it.url)){ seenUrls.add(it.url); store.items.push({ ...it, detectedAt: nowIso }); added++; }
    }
  }
  store.items.sort((a,b)=> (b.date||'').localeCompare(a.date||'') || (b.detectedAt||'').localeCompare(a.detectedAt||''));
  store.generatedAt = nowIso;
  store.sources = SITES.map(s=>({name:s.name, url:s.url}));
  fs.writeFileSync(OUT, JSON.stringify(store, null, 2), 'utf8');
  console.log('=== 巡回結果 ==='); report.forEach(r=>console.log(' - '+r));
  console.log(`新規追加: ${added}件 / 総蓄積: ${store.items.length}件 -> ${OUT}`);
}
main();
