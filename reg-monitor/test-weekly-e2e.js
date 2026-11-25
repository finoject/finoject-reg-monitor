// chaindetective-weekly.js の通しテスト（通信しない。当局サイト・Jev・Worker・Slack をすべて差し替える）
//   node reg-monitor/test-weekly-e2e.js   → 最後に「全件OK」が出れば成功
// 確かめること：
//   ・Jevで落とした記事と選別情報（overseasExcluded / overseasFilter）が Worker に渡らない
//   ・キーワードに当たらない記事でも Jev が高ければ Worker に渡る
const assert = require('assert');

const { jevAsked, captured } = require('./test-mock-fetch');

process.env.SLACK_WEBHOOK_URL = 'https://slack.test/hook';
process.env.TYPESAFE_API_KEY = 'test-key';
process.argv = ['node', 'chaindetective-weekly.js', '--week-end', '2026-09-25'];
console.log = () => {};   // 収集ログを黙らせる

const { main } = require('./chaindetective-weekly');
main().then(() => {
  const workerBody = captured.worker, slackBody = captured.slack;
  assert.ok(workerBody, 'Workerが呼ばれていない');
  const payload = workerBody.payload;
  assert.ok(!('overseasExcluded' in payload), '除外一覧がWorkerに漏れている');
  assert.ok(!('overseasFilter' in payload), '選別情報がWorkerに漏れている');
  assert.ok(!JSON.stringify(workerBody).includes('Mortgage statistics'), '除外した記事がWorkerへの送信内容のどこかに含まれている');
  const titles = payload.overseas.map(x => x.title);
  assert.ok(titles.includes('Passive software relief'), 'Jevが高い記事がWorkerに渡っていない');
  assert.ok(!titles.includes('Mortgage statistics'), 'Jevが低い記事がWorkerに渡っている');
  assert.ok(!payload.overseas.some(x => 'allTopics' in x || 'via' in x), '内部用の項目がWorkerに漏れている');
  assert.deepStrictEqual(jevAsked.sort(), ['Mortgage statistics', 'Passive software relief']);
  assert.strictEqual(slackBody.text, 'テスト用の本文');
  // Routineと同じ直接起動（node chaindetective-weekly.js --dry-run）で main() が走ること。
  // 通信は --require で差し込む mock に置き換える（本物の当局サイト・Jevは呼ばない）
  const { execFileSync } = require('child_process');
  const fs = require('fs'), os = require('os'), path = require('path');
  const out = path.join(os.tmpdir(), `cdw-e2e-${process.pid}.json`);
  execFileSync(process.execPath, ['--require', path.join(__dirname, 'test-mock-fetch.js'), path.join(__dirname, 'chaindetective-weekly.js'),
    '--dry-run', '--week-end', '2026-09-25', '--out', out], { env: { ...process.env, TYPESAFE_API_KEY: 'test-key' }, stdio: 'ignore' });
  const direct = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out);
  assert.deepStrictEqual(direct.overseas.map(x => x.title), ['Passive software relief'], '直接起動で収集・選別が走っていない');
  assert.deepStrictEqual(direct.overseasExcluded.map(x => x.title), ['Mortgage statistics']);
  process.stdout.write('全件OK\n');
}).catch(e => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
