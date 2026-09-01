// finoject Financial Weekly Regulatory Brief ─ 週次「材料」生成
//
// 毎週金曜の朝にGitHub Actionsから実行し、data.json から対象週（金〜木）の全件を切り出して
// weekly/weekly-YYYY-MM-DD.md に書き出し、Slackへ着手通知を投げる。
//
// このスクリプトがやるのは「材料の用意」まで。図表の作成・一次資料の突合・本文の執筆は
// モデルの判断が要るのでセッション側でやる（＝着手通知がその引き渡し）。
//
// ワークフローでは「生成 → コミット → 通知」の順に2回起動する。通知側が data.json を
// 読み直すと、間に crawl.yml の更新が入ったときにコミット済みMarkdownと件数がずれるため、
// 生成時の集計を --summary-out で書き出し、通知は --notify-from でそれを読むだけにする。
//
// ローカル検証:  node weekly-brief.js --week-end 2026-08-07 --no-slack --out-dir /tmp/x

const fs = require('fs');
const path = require('path');

// 週の計算は jstweek.js に一本化する。ここに自前の実装を持つと、片方だけ直したときに
// chaindetective-weekly.js と別の週を指す（実際にそうなりかけた）。
const { nowJst, ymd, addDays, label, resolveWeek } = require('./jstweek');

function parseArgs(argv) {
  const a = { weekEnd: null, slack: true, outDir: null, summaryOut: null, notifyFrom: null };
  const value = i => {
    if (i >= argv.length) throw new Error(`${argv[i - 1]} に値が指定されていません`);
    return argv[i];
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--week-end') a.weekEnd = value(++i);
    else if (argv[i] === '--out-dir') a.outDir = value(++i);
    else if (argv[i] === '--summary-out') a.summaryOut = value(++i);   // 生成時の集計を書き出す
    else if (argv[i] === '--notify-from') a.notifyFrom = value(++i);   // その集計だけを読んで通知する
    else if (argv[i] === '--no-slack') a.slack = false;
    else throw new Error(`不明な引数: ${argv[i]}`);
  }
  if (a.notifyFrom && !a.slack) throw new Error('--notify-from と --no-slack は同時に指定できません');
  if (a.notifyFrom && (a.weekEnd || a.outDir || a.summaryOut)) {
    throw new Error('--notify-from は他のオプションと併用できません（集計は生成時に確定済みのため）');
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);

  // 通知だけのモード。data.json は読まない＝生成時の集計をそのまま流す。
  if (args.notifyFrom) {
    await notifySlack(JSON.parse(fs.readFileSync(args.notifyFrom, 'utf8')));
    return;
  }

  // --week-end は従来どおり「配信日の金曜」を指す（既存の呼び出しをそのまま使える）。
  // 曜日の検算・存在しない日付の排除は resolveWeek 側で行う（chaindetective と同じ経路）。
  const wk = resolveWeek(args.weekEnd, '--week-end');
  const DELIVERY = wk.BASE, TO = wk.TO, FROM = wk.FROM;

  const dataPath = path.join(__dirname, '..', 'reg-monitor-site', 'data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  const from = wk.from, to = wk.to;
  const issue = wk.base;   // 号数・ファイル名は配信日（金曜）で付ける
  // 機関名・表題が欠けていても落とさず、欠けていること自体が見えるようにする。
  // String() を通すのは、truthyな非文字列（数値等）が来ても localeCompare で落ちないようにするため。
  const text = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : String(v));
  const week = (Array.isArray(data.items) ? data.items : [])
    .filter(x => x && typeof x.date === 'string' && x.date >= from && x.date <= to)
    .map(x => ({ ...x, agency: text(x.agency, '（機関名不明）'), title: text(x.title, '（表題なし）') }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.agency.localeCompare(b.agency));

  const byAgency = {};
  for (const it of week) (byAgency[it.agency] = byAgency[it.agency] || []).push(it);

  console.log(`対象期間 ${label(FROM)}〜${label(TO)}  材料 ${week.length}件`);

  const outDir = args.outDir || path.join(__dirname, '..', 'weekly');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `weekly-${issue}.md`);
  fs.writeFileSync(outPath, render({ from, to, issue, FROM, TO, week, byAgency, data }), 'utf8');
  console.log(`出力 ${outPath}`);

  // 通知に必要な値はここで確定させる。後段で作り直さない＝ずれようがない。
  const summary = {
    weekEnd: issue,
    fromLabel: label(FROM),
    toLabel: label(TO),
    count: week.length,
    breakdown: Object.entries(byAgency).map(([k, v]) => [k, v.length]),
    generatedAt: data.generatedAt,
    isDeliveryDay: ymd(nowJst()) === issue,   // 定刻（配信日の金曜）の実行か、後追いのバックフィルか
    repo: process.env.GITHUB_REPOSITORY || 'finoject/finoject-reg-monitor',
  };

  if (args.summaryOut) {
    fs.writeFileSync(args.summaryOut, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`集計 ${args.summaryOut}`);
  }
  if (args.slack) await notifySlack(summary);
}

function render({ from, to, issue, FROM, TO, week, byAgency, data }) {
  const L = [];
  L.push(`# finoject Financial Weekly Regulatory Brief ─ ${issue}号 材料`);
  L.push('');
  L.push(`- 対象期間: **${label(FROM)} 〜 ${label(TO)}**（金〜木の7日間）`);
  L.push(`- data.json 生成時刻: ${data.generatedAt}`);
  L.push(`- 材料件数: ${week.length}件（国内の自動巡回分のみ。**これは母集団を網羅した数字ではないので本文には出さない**）`);
  L.push('');
  L.push('## 執筆前に必ず片付けること');
  L.push('');
  L.push('1. **配信日（金曜）の公表は、この材料には入っていない。** 対象期間は先週金曜〜今週木曜。金曜の公表は翌号の先頭に入るので、**本文に取り込んだ場合は翌号で重複しないよう申し送ること。**');
  L.push('2. **海外パートを足す。** この材料は国内の自動巡回分だけ。米国（SEC・CFTC・FinCEN・OCC・FDIC・GENIUS Act）／EU（MiCA＝ESMA・EBA・EIOPA）／FATF は、`#金融規制情報` のChaindetective週次投稿を入力にしつつ、**日付・数値は必ず一次資料で取り直す**（同投稿は継続論点も含むため、対象週に日付が入るものだけ採る）。');
  L.push('3. **法令改正は施行スケジュールの構造まで書く。** 「政令公布・◯/◯施行」だけでは本体が施行されると誤読される。附則第1条の区分（原則／罰則／例外）を、金融庁「国会提出法案」ページの**法律案要綱PDF末尾「第３ 施行期日等」**（横書きで読める。条文PDFは縦書きでpdftotext不可）で確認する。');
  L.push('4. **「なし」は書かない。** 該当のない機関は何も書かない。件数の集計も出さない。');
  L.push('5. **完成後にCodexへファクトチェック**（文字・図表とも例外なし）。外部一次資料の突合は自分でWebで行う。');
  L.push('');
  L.push('## 機関別 全件');
  L.push('');
  for (const ag of Object.keys(byAgency)) {
    L.push(`### ${ag}`);
    L.push('');
    for (const it of byAgency[ag]) {
      L.push(`- **${it.date}** ${it.title}${it.updated ? ' ※更新' : ''}`);
      L.push(`  - ${it.url}`);
      if (Array.isArray(it.aiSummary) && it.aiSummary.length) {
        // 自動要約は下読み用。本文にそのまま写さず、必ず一次資料で裏を取る
        L.push(`  - <details><summary>自動要約（下読み用・要裏取り）</summary>`);
        for (const s of it.aiSummary) L.push(`    - ${s}`);
        L.push(`    </details>`);
      }
    }
    L.push('');
  }
  return L.join('\n');
}

// 集計JSONが壊れていたら「undefined号」のような通知を送ってしまう。送る前に止める。
function assertSummary(s) {
  if (!s || typeof s !== 'object') throw new Error('集計JSONがオブジェクトではありません');
  for (const k of ['weekEnd', 'fromLabel', 'toLabel', 'generatedAt', 'repo']) {
    if (typeof s[k] !== 'string' || !s[k]) throw new Error(`集計JSONの ${k} が不正です: ${JSON.stringify(s[k])}`);
  }
  if (!Number.isInteger(s.count) || s.count < 0) throw new Error(`集計JSONの count が不正です: ${JSON.stringify(s.count)}`);
  if (!Array.isArray(s.breakdown) || s.breakdown.some(e => !Array.isArray(e) || e.length !== 2)) {
    throw new Error('集計JSONの breakdown が [機関名, 件数] の配列ではありません');
  }
  return s;
}

async function notifySlack(input) {
  const s = assertSummary(input);
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) { console.log('SLACK_WEBHOOK_URL 未設定のため通知をスキップ'); return; }

  const link = `https://github.com/${s.repo}/blob/main/weekly/weekly-${s.weekEnd}.md`;
  const breakdown = s.breakdown.map(([k, n]) => `${k} ${n}`).join('／');

  const text = [
    `:memo: *Weekly Regulatory Brief｜${s.weekEnd}号の材料を用意しました*`,
    `対象期間 ${s.fromLabel}〜${s.toLabel}／国内の自動巡回分 ${s.count}件（${breakdown}）`,
    `材料: <${link}|weekly-${s.weekEnd}.md>`,
    s.isDeliveryDay
      ? `<@U02FJQ7D9PE> 本日17:00配信ぶんです。海外パートの一次資料突合・図表・本文はこれからClaudeと仕上げます。`
      : `<@U02FJQ7D9PE> ${s.weekEnd}号の後追い生成です（定刻の金曜朝ではありません）。`,
    `_data.json 生成時刻 ${s.generatedAt}${s.isDeliveryDay ? '／金曜夕方の追加公表は最終稿直前に取り込みます' : ''}_`,
  ].join('\n');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack通知に失敗: ${res.status} ${await res.text()}`);
  console.log('Slack通知を送信しました');
}

main().catch(e => { console.error(e); process.exit(1); });
