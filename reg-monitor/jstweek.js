// 週次ジョブが共有するJSTの週計算。
// weekly-brief.js（メルマガ材料・金曜09:17）と chaindetective-weekly.js（AMLブリーフィング・金曜17:07）が
// 同じ「金〜木」の週を指すよう、ここ1か所に置く。別々に持つと片方だけ直して食い違う。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];
const MIN_YEAR = 2000, MAX_YEAR = 2100;

// JSTの暦日をUTCフィールドとして持つDateを返す（以降 getUTC*/toISOString はJSTの値として読める）
const nowJst = () => new Date(Date.now() + JST_OFFSET_MS);
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };
const label = d => `${ymd(d)}（${DOW_JA[d.getUTCDay()]}）`;

// 形式と実在日の両方を検証する。`new Date('2026-04-31')` は例外を投げず 2026-05-01 に
// 正規化されるため、往復で元の文字列に戻るかまで見ないと「存在しない日付を渡したのに
// 別の週が黙って生成される」事故になる。
function parseYmdStrict(s, optName = '--week-end') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${optName} は YYYY-MM-DD 形式で指定してください: ${JSON.stringify(s)}`);
  }
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || ymd(d) !== s) {
    throw new Error(`${optName} に存在しない日付が指定されました: ${s}`);
  }
  // 形式も実在日も通るが業務上ありえない年（`0000-01-07` 等）を弾く
  const y = d.getUTCFullYear();
  if (y < MIN_YEAR || y > MAX_YEAR) {
    throw new Error(`${optName} の年が範囲外です（${MIN_YEAR}〜${MAX_YEAR}）: ${s}`);
  }
  return d;
}

// 基準日＝金曜。金曜に走れば当日、それ以外に走れば直前の金曜。
// 週の名前（号数・投稿の見出し）はこの金曜で付ける。
function weekEnd(today) {
  const back = (today.getUTCDay() - 5 + 7) % 7;   // 金=5
  return addDays(today, -back);
}

// 対象週（先週金曜〜今週木曜）を解決する。曜日は必ず暦で検算する（「7/25（金）」と誤記した事故の再発防止）。
//
// 終端を基準日の金曜そのものにすると、金曜の公表を取りこぼす。週次ジョブは金曜の
// 09:17／17:07 に走るが、日本の当局の公表は金曜の午後に集中するため、その時点では
// まだ data.json に入っていない。しかも翌週の対象期間（翌土曜〜翌金曜）からも外れるので
// 永久に拾えない。実データで確認：金曜付182件のうち181件が該当。
// 終端を木曜にすれば、金曜の公表は翌週の対象期間の先頭（先週金曜）に入る。
function resolveWeek(weekEndArg, optName) {
  const BASE = weekEndArg ? parseYmdStrict(weekEndArg, optName) : weekEnd(nowJst());
  if (BASE.getUTCDay() !== 5) {
    throw new Error(`${optName || '--week-end'} は金曜を指定してください: ${label(BASE)}`);
  }
  const TO = addDays(BASE, -1);   // 対象期間の終端＝木曜
  const FROM = addDays(TO, -6);   // 対象期間の始端＝先週金曜
  if (TO.getUTCDay() !== 4 || FROM.getUTCDay() !== 5) {
    throw new Error(`対象期間の曜日が不正です: ${label(FROM)}〜${label(TO)}（金〜木である必要があります）`);
  }
  return {
    BASE, FROM, TO,
    base: ymd(BASE), from: ymd(FROM), to: ymd(TO),
    baseLabel: label(BASE), fromLabel: label(FROM), toLabel: label(TO),
  };
}

module.exports = { JST_OFFSET_MS, DOW_JA, nowJst, ymd, addDays, label, parseYmdStrict, weekEnd, resolveWeek };
