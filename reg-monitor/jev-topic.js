// 海外の公表記事が Chaindetective の対象領域に当たるかを TypeSafe の Jev で判定する。
//
// 従来はタイトルのキーワード照合（isTopic）だけで選別していたが、2026年9月18日・25日の回で
// 実際に本文へ採った記事の多く（CFTCのパッシブ・ソフトウェア提供者へのノーアクション、
// ESMAのデジタルイノベーション監督重点など）がキーワードに当たらず落ちていた。
// 2026年9月4日〜25日の4週・海外63件で比べた結果、Jev（しきい値0.4）は実際に採った9件を全件拾い、
// キーワード方式は2件だった（FinCENは全件対象なので比較から除く）。
//
// 安全策：
//   ・キーワードに当たる記事は Jev の値に関係なく必ず残す（従来より取りこぼしが増えない）
//   ・Jev が使えない（キー無し・通信失敗）ときは、全件キーワード方式に戻して理由を記録する
//   ・落とした記事もタイトルと確率を excluded に残し、書き手が目で確かめられるようにする
//
// APIキーは環境変数 TYPESAFE_API_KEY、無ければ母艦のキーチェーン（サービス名 typesafe-api-key）から読む。
// 費用は入力トークンのみ（1件あたり約360トークン＝$0.000015程度）。

const { execFileSync } = require('child_process');
const os = require('os');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const THRESHOLD = 0.4;

// 質問文としきい値はここ1か所に置く（レビューしやすくするため）。
// 2026-09-30に4週分の実データで調整した。この文面を変えたら同じ4週で測り直すこと。
const QUESTION = {
  relevant: {
    type: 'noul',
    instructions:
      'This is the title of an official announcement by a financial regulator. Would it be worth including in a weekly briefing ' +
      'for a crypto-asset and stablecoin anti-money-laundering joint monitoring center? ' +
      'Answer yes if it concerns any of: crypto assets, digital assets, stablecoins, tokenization, blockchain or DeFi software, travel rule, ' +
      "AML/CFT, sanctions or illicit finance, customer identification, the regulator's innovation or fintech policy, " +
      'or supervisory/enforcement expectations on operational resilience and compliance programs of market infrastructure. ' +
      'Answer no for routine items unrelated to these, such as community reinvestment schedules, mortgage statistics, ' +
      'conference agendas on unrelated topics, or traditional securities rules with no digital-asset angle.',
  },
};

function loadKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  if (process.platform !== 'darwin') return '';
  try {
    return execFileSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', 'typesafe-api-key', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

async function askOnce(key, item) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      state: `Regulator: ${item.agency}\nTitle: ${String(item.title).slice(0, 400)}`,
      model: 'jev-latest',
      questions: QUESTION,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const p = j && j.answers && j.answers.relevant && j.answers.relevant.noul;
  // 0 は正当な値なので「偽かどうか」でなく数値かどうかで見る
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`Jevの応答に確率がありません: ${JSON.stringify(j).slice(0, 200)}`);
  return { p, tokens: Number(j.usage && j.usage.input_tokens) || 0 };
}

async function ask(key, item, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await askOnce(key, item); }
    catch (e) { last = e; if (i < attempts) await new Promise(r => setTimeout(r, i * 2000)); }
  }
  throw last;
}

// candidates: 対象週に入った海外記事（分野で絞る前）。各要素に allTopics（機関全体が対象）を付けておく。
// 戻り値: { included, excluded, mode, note, tokens }
async function classify(candidates, isTopic, { key = loadKey() } = {}) {
  // spent: 失敗までに消費した入力トークン（途中で失敗しても課金はされている）
  const fallback = (reason, spent = 0) => {
    const included = [], excluded = [];
    for (const x of candidates) (x.allTopics || isTopic(x.title) ? included : excluded).push({ ...x, via: x.allTopics ? 'all' : 'keyword' });
    return { included, excluded, mode: 'keyword', note: reason, tokens: spent };
  };
  const targets = candidates.filter(x => !x.allTopics);
  if (!targets.length) return fallback('Jevに問い合わせる記事なし（全件対象の機関のみ）');
  if (!key) return fallback('TYPESAFE_API_KEY もキーチェーンの typesafe-api-key も無いためキーワード方式で選別');

  const scored = new Map();
  let tokens = 0;
  try {
    // 1件ずつ直列で投げる（週20件前後なので数秒。利用上限 1,200回/分 にも遠い）
    for (const x of targets) { const r = await ask(key, x); scored.set(x, r.p); tokens += r.tokens; }
  } catch (e) {
    // 一部だけJev・残りキーワードという混在は結果の読み方を誤らせるので、全件キーワード方式に戻す
    return fallback(`Jevの判定に失敗したためキーワード方式で選別（${e.message || e}）`, tokens);
  }

  const included = [], excluded = [];
  for (const x of candidates) {
    if (x.allTopics) { included.push({ ...x, via: 'all' }); continue; }
    const p = scored.get(x), kw = isTopic(x.title);
    const row = { ...x, jev: Math.round(p * 1000) / 1000, via: kw ? 'keyword' : 'jev' };
    (kw || p >= THRESHOLD ? included : excluded).push(row);
  }
  return { included, excluded, mode: 'jev', note: `Jev（jev-latest・しきい値${THRESHOLD}）＋キーワードの和集合で選別`, tokens };
}

module.exports = { classify, THRESHOLD, QUESTION, loadKey };
