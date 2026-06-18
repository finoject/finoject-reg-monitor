// ニュース項目を「どの法令の・どんな動向か」で意味づけする（法令ビューアとの双方向連携の中核）。
// 各itemに item.lawrefs = [{ id, art, label, kind }] を付与する。
//  - id   : 法令ビューアの law_id（?law=ID で開ける）
//  - art  : 第N条（算用数字。ビューアの条番号表記に一致）or null
//  - label: 表示用ラベル（例「金融商品取引法施行令 第3条」）
//  - kind : 動向の種別（パブコメ/改正/公布/施行/ガイドライン/通達等/告示/その他）
// reg-monitor-site は lawrefs から📖チップを描画し、法令ビューアは lawrefs を逆引きして
// 「この法令の最近の規制動向」を条文に重ねて表示する（同一データを両者で共有）。

// ---- 法令辞書（法令ビューアの全30文書）。names は長い名称を先に書く必要はない（マッチ時に長さ降順で処理する）----
const LAW_DICT = [
  // 金商法
  { id:'419M60000002052', names:['金融商品取引業等に関する内閣府令','金商業等府令'] },
  { id:'340CO0000000321', names:['金融商品取引法施行令','金商法施行令'] },
  { id:'323AC0000000025', names:['金融商品取引法','金商法'] },
  // 資金決済
  { id:'429M60000002007', names:['暗号資産交換業者に関する内閣府令','暗号資産交換業者府令'] },
  { id:'422M60000002004', names:['資金移動業者に関する内閣府令','資金移動業者府令'] },
  { id:'422M60000002003', names:['前払式支払手段に関する内閣府令','前払式支払手段府令'] },
  { id:'505M60000002048', names:['電子決済手段等取引業者に関する内閣府令','電子決済手段等取引業者府令'] },
  { id:'422CO0000000019', names:['資金決済に関する法律施行令','資金決済法施行令'] },
  { id:'421AC0000000059', names:['資金決済に関する法律','資金決済法'] },
  // 犯収法
  { id:'420M60000F5A001', names:['犯罪による収益の移転防止に関する法律施行規則','犯収法施行規則'] },
  { id:'420CO0000000020', names:['犯罪による収益の移転防止に関する法律施行令','犯収法施行令'] },
  { id:'419AC0000000022', names:['犯罪による収益の移転防止に関する法律','犯罪収益移転防止法','犯収法'] },
  // 外為法（AML/CFT・経済制裁）
  { id:'355CO0000000260', names:['外国為替令'] },
  { id:'324AC0000000228', names:['外国為替及び外国貿易法','外為法'] },
  // 銀行法
  { id:'357M50000040010', names:['銀行法施行規則'] },
  { id:'357CO0000000040', names:['銀行法施行令'] },
  { id:'356AC0000000059', names:['銀行法'] },
  // 会社法
  { id:'418M60000010013', names:['会社計算規則'] },
  { id:'418M60000010012', names:['会社法施行規則'] },
  { id:'418M60000010014', names:['電子公告規則'] },
  { id:'417CO0000000364', names:['会社法施行令'] },
  { id:'417AC0000000086', names:['会社法'] },
  // 個人情報
  { id:'428M60020000003', names:['個人情報の保護に関する法律施行規則','個人情報保護法施行規則'] },
  { id:'415CO0000000507', names:['個人情報の保護に関する法律施行令','個人情報保護法施行令'] },
  { id:'415AC0000000057', names:['個人情報の保護に関する法律','個人情報保護法'] },
  // ガイドライン・監督指針
  { id:'fsa-kantoku-kinsho', names:['金融商品取引業者等向けの総合的な監督指針','金商業者向けの総合的な監督指針'] },
  { id:'fsa-kantoku-city',   names:['主要行等向けの総合的な監督指針'] },
  { id:'fsa-kantoku-chusho', names:['中小・地域金融機関向けの総合的な監督指針'] },
  { id:'fsa-guide-14', names:['資金移動業者関係'] },
  { id:'fsa-guide-16', names:['暗号資産交換業者関係'] },
  { id:'fsa-guide-17', names:['電子決済手段等取引業者関係'] },
  { id:'fsa-guide-05', names:['前払式支払手段発行者関係'] },
];
// 表示用の短いラベル（id→名称）
const LABEL = {};
for (const L of LAW_DICT) LABEL[L.id] = L.names[0];

// (id, name) を長さ降順で平坦化。長い名称を先にマッチさせ「○○法施行令」を「○○法」と誤認しないため。
const NAME_ENTRIES = LAW_DICT
  .flatMap(L => L.names.map(n => ({ id:L.id, name:n })))
  .sort((a,b) => b.name.length - a.name.length);

// ---- 漢数字→算用数字（条番号用。ビューアの「第3条の2」表記に一致させる）----
const KN = {〇:0,零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
const KSk = {十:10,百:100,千:1000};
function kanToNum(s){
  if (/^[0-9０-９]+$/.test(s)) return s.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0)-0xFEE0));
  let tot=0, cur=0;
  for (const ch of s){ if (ch in KN) cur=KN[ch]; else if (ch in KSk){ tot += (cur||1)*KSk[ch]; cur=0; } }
  return String(tot+cur);
}
const ARTNUM = '[〇零一二三四五六七八九十百千0-9０-９]+';
// 「第N条」「第N条のM」を算用数字の「第N条」「第N条のM」へ
function normArt(m1, m2){ return '第'+kanToNum(m1)+'条' + (m2 ? 'の'+kanToNum(m2) : ''); }

// ---- 動向の種別判定（優先度順）----
function detectKind(text){
  if (/パブリックコメント|意見募集|御意見の募集|ご意見の募集|コメントの募集|意見の募集/.test(text)) return 'パブコメ';
  if (/(一部を)?改正|改める|改正案/.test(text)) return '改正';
  if (/公布/.test(text)) return '公布';
  if (/監督指針|ガイドライン|事務ガイドライン/.test(text)) return 'ガイドライン';
  if (/告示/.test(text)) return '告示';
  if (/通達|事務連絡|Q\s*&\s*A|ＱＡ|FAQ|よくある(ご)?質問/.test(text)) return '通達等';
  if (/施行(期日|日|令)/.test(text)) return '施行';
  return 'その他';
}

// ---- 法令名＋条番号の抽出 ----
// text 内の各法令名の出現位置を取り、その直後ウィンドウ内の「第N条」を当該法令に紐付ける。
// strict=true: 直前が漢字の一致を除外（「国際協力銀行法」中の「銀行法」、「株式会社法」中の「会社法」等の
// 部分一致を弾く。国会議案名の照合で使用）。ニュース照合は非strict（「改正資金決済法」等を拾うため）。
function matchLaws(text, strict){
  if (!text) return [];
  const found = [];           // {id, name, start, end}
  for (const e of NAME_ENTRIES){
    let from = 0, idx;
    while ((idx = text.indexOf(e.name, from)) !== -1){
      from = idx + e.name.length;
      if (strict && idx > 0 && /[一-鿿々]/.test(text[idx-1])) continue;   // 直前が漢字＝より長い法令名の一部
      found.push({ id:e.id, name:e.name, start:idx, end:idx + e.name.length });
    }
  }
  if (!found.length) return [];
  // 別名称のspanに完全内包される一致を除外（「金融商品取引法施行令」中の「金融商品取引法」を消す）
  const kept = found.filter(f => !found.some(g => g!==f && g.start<=f.start && g.end>=f.end && (g.end-g.start)>(f.end-f.start)));

  // 条番号抽出（位置つき）
  const artRe = new RegExp('第('+ARTNUM+')条(?:の('+ARTNUM+'))?', 'g');
  const arts = [];
  for (let m; (m = artRe.exec(text)); ) arts.push({ art:normArt(m[1], m[2]), pos:m.index });

  // id ごとに集約。条番号は「直前の法令名のうち最も近いもの」に紐付ける（前方80字以内）
  const byId = new Map();   // id -> Set(art)  （art='' は法令レベルのみ）
  const order = [];
  const ensure = id => { if(!byId.has(id)){ byId.set(id, new Set()); order.push(id); } return byId.get(id); };
  for (const f of kept) ensure(f.id);
  for (const a of arts){
    // この条番号の前にある法令名のうち、最も近い（pos<=a.pos かつ 80字以内）ものへ
    let best=null;
    for (const f of kept){ if (f.end <= a.pos && a.pos - f.end <= 80 && (!best || f.end > best.end)) best=f; }
    if (best) ensure(best.id).add(a.art);
  }
  // lawrefs に展開（条番号があれば条ごと、なければ法令レベル1件）
  const refs = [];
  for (const id of order){
    const set = byId.get(id);
    if (set.size){ for (const art of set) refs.push({ id, art }); }
    else refs.push({ id, art:null });
  }
  return refs;
}

// item に lawrefs/kind を付与（text は title＋（任意で）本文）
function buildLawrefs(text){
  const kind = detectKind(text);
  const refs = matchLaws(text);
  return refs.map(r => ({
    id: r.id, art: r.art, kind,
    label: LABEL[r.id] + (r.art ? ' '+r.art : ''),
  }));
}

// 本文取得が意味を持ちそうか（株価・統計など明らかに無関係なものは取得しない＝クロール負荷削減）
function worthFetching(title){
  if (!title) return false;
  if (/法|府令|政令|省令|規則|ガイドライン|監督指針|パブリックコメント|意見募集|告示|通達|改正|公布|施行/.test(title)) return true;
  return false;
}

// ===== 関連ニュース（法令ビューアの「規制動向」枠に、報道見出し＋リンクを補足する）=====
// 取得元はGoogle News RSS検索。表示は下記の指定ソースに限定（三根さん指定）。本文が有料でも見出し＋リンクで足りる。
const NEWS_SOURCES = [
  { label:'日経',         re:/日本経済新聞|日経|nikkei\.com/i },
  { label:'NHK',          re:/NHK|nhk\.or\.jp/i },
  { label:'Bloomberg',    re:/Bloomberg|bloomberg\./i },
  { label:'共同通信',     re:/共同通信|kyodo|nordot/i },
  { label:'時事通信',     re:/時事通信|jiji\.com/i },
  { label:'朝日新聞',     re:/朝日新聞|asahi\.com/i },
  { label:'読売新聞',     re:/読売新聞|yomiuri\.co\.jp/i },
  { label:'毎日新聞',     re:/毎日新聞|mainichi\.jp/i },
  { label:'産経新聞',     re:/産経新聞|サンケイ|sankei\.com/i },
  { label:'東洋経済',     re:/東洋経済|toyokeizai/i },
  { label:'ダイヤモンド', re:/ダイヤモンド|diamond\.jp/i },
  { label:'Yahoo',        re:/Yahoo|yahoo/i },
];
// 許可ソースなら表示ラベルを返す（それ以外＝null＝不採用）
function matchSource(name, url){
  const s = (name||'') + ' ' + (url||'');
  const m = NEWS_SOURCES.find(x => x.re.test(s));
  return m ? m.label : null;
}
// 見出しの正規化＝重複判定キー。末尾の「 - 媒体名」「（媒体名）」（閉じカッコ欠落の切れも含む）「…」を除去し、
// 同一記事が媒体表記ゆれで重複するのを防ぐ（特にYahoo再配信の被り対策）。表示用タイトルではなくキー専用。
function normNewsTitle(t){
  let s = (t||'').replace(/[\s　]+/g,' ').trim();
  s = s.replace(/[（(][^（(]*$/,'');               // 末尾の最後の開きカッコ以降（＝媒体名。閉じ有無問わず）
  s = s.replace(/\s*[-–—｜|]\s*[^-–—｜|]*$/,'');    // 末尾「 - 媒体名」
  s = s.replace(/[…\.\s　]+$/,'');                 // 末尾の省略記号
  return s.replace(/[\s　]/g,'').toLowerCase();
}
// 重複排除：同一見出しは1件に。Yahooは他媒体の再配信＝被るとノイズなので、非Yahooを優先して残す。
function dedupeNews(items){
  const arr = items.slice();
  arr.sort((a,b) => (a.source==='Yahoo'?1:0) - (b.source==='Yahoo'?1:0));   // 非Yahooを先に＝キーを先取り
  const seen = new Set(), out = [];
  for (const it of arr){ const k = normNewsTitle(it.title); if (!k || seen.has(k)) continue; seen.add(k); out.push(it); }
  out.sort((a,b) => (b.date||'').localeCompare(a.date||''));                  // 日付降順に戻す
  return out;
}
// 各文書(law_id)→ニュース検索クエリ。緩いと業界マクロ・適時開示等のノイズを拾うため、完全一致("…")＋規制文脈で絞る。
// 府令/施行令/GLは親法令・テーマに寄せる。新規追加時はここに足す。
// Yahooニュース検索は全文・スペース区切りのAND（"…"やORは効かないため使わない）。法令/規制文脈で絞る。
const Q = {
  金商:'金融商品取引法', 資金決済:'資金決済法', 暗号資産:'暗号資産 規制',
  資金移動:'資金移動業', 前払式:'前払式支払手段', ステーブル:'ステーブルコイン',
  犯収:'マネーロンダリング 金融庁',
  外為:'外為法 制裁',
  銀行:'銀行法 改正', 会社:'会社法 改正',
  個情:'個人情報保護法',
};
const NEWS_QUERY = {
  '323AC0000000025':Q.金商,'340CO0000000321':Q.金商,'419M60000002052':Q.金商,
  '421AC0000000059':Q.資金決済,'422CO0000000019':Q.資金決済,
  '429M60000002007':Q.暗号資産,'422M60000002004':Q.資金移動,'422M60000002003':Q.前払式,'505M60000002048':Q.ステーブル,
  '419AC0000000022':Q.犯収,'420CO0000000020':Q.犯収,'420M60000F5A001':Q.犯収,
  '324AC0000000228':Q.外為,'355CO0000000260':Q.外為,
  '356AC0000000059':Q.銀行,'357CO0000000040':Q.銀行,'357M50000040010':Q.銀行,
  '417AC0000000086':Q.会社,'417CO0000000364':Q.会社,'418M60000010012':Q.会社,'418M60000010013':Q.会社,'418M60000010014':Q.会社,
  '415AC0000000057':Q.個情,'415CO0000000507':Q.個情,'428M60020000003':Q.個情,
  'fsa-kantoku-city':Q.銀行,'fsa-kantoku-chusho':Q.銀行,'fsa-kantoku-kinsho':Q.金商,
  'fsa-guide-14':Q.資金移動,'fsa-guide-16':Q.暗号資産,'fsa-guide-17':Q.ステーブル,'fsa-guide-05':Q.前払式,
};
// 関連ニュースとして無価値な見出し（適時開示・自己株式・決算等の市場/開示データ系）を除外
const NEWS_NOISE = /適時開示|自己株式|株主優待|決算(発表|短信)?|配当予想|月次|業績予想|株価|\[\d{3,4}\]/;
function isNewsNoise(title){ return NEWS_NOISE.test(title||''); }

module.exports = { LAW_DICT, LABEL, NAME_ENTRIES, matchLaws, buildLawrefs, detectKind, worthFetching, kanToNum,
  NEWS_SOURCES, matchSource, normNewsTitle, dedupeNews, NEWS_QUERY, isNewsNoise };
