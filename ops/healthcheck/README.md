# 母艦（Mac mini M4 Pro）ヘルスチェック

毎朝7:00に母艦上のClaude Codeがヘッドレスモードで自己点検し、**異常があるときだけ**Slackに報告する。
チャット側のClaudeや人間を経路に含めず、母艦内で自己完結させる。

reg-monitorの巡回はGitHub Actions側で動くが、freee/Gmail等のMCP認証と母艦そのものは誰も見ていない。
この点検はそこを埋める「検知層」であり、修復はしない。

## 層構成

```
launchd（毎朝7:00発火・OS標準スケジューラ）
  └─ healthcheck.sh（ロック・実行・タイムアウト・失敗時フォールバック）
       └─ claude -p（ヘッドレスで点検を実行）
            ├─ claude mcp list（MCP接続状態）
            ├─ freee / Gmail MCP（認証トークン生存確認）
            ├─ reg-monitor（公開中のdata.jsonのgeneratedAtで巡回の生存確認）
            └─ Slack MCP（異常時のみ通知）
```

`healthcheck.sh` は「claude -p を1回だけ確実に走らせ、静かに失敗させない」ことだけを担う。
点検内容は `healthcheck-prompt.md` にあるので、誤検知・見逃しが出たらプロンプトだけ直せばよい
（スクリプトとplistは触らない）。

## ファイル

| ファイル | 役割 |
|---|---|
| `healthcheck-prompt.md` | 点検指示。`__SLACK_CHANNEL__` 等のプレースホルダは実行時に設定値で埋まる |
| `healthcheck.sh` | 実行本体。ロック／タイムアウト／フォールバック通知／ログ回転 |
| `config.env.example` | 設定テンプレート。`~/healthcheck/config.env` にコピーして使う（**秘密情報を含むのでコミットしない**） |
| `com.finoject.mcp-healthcheck.plist` | launchd定義のテンプレート（`__HOME__` を置換して使う） |
| `install.sh` | 配置・`__HOME__`置換・launchd登録をまとめて行う |

## 導入

```bash
# 1. まず配置だけして手動テスト（launchdに載せる前に必ず）
bash ops/healthcheck/install.sh --no-launchd

# 2. 通知先を設定
#    SLACK_CHANNEL と HEALTHCHECK_SLACK_WEBHOOK_URL を埋める
vi ~/healthcheck/config.env

# 3. 手動実行
~/healthcheck/healthcheck.sh; echo "exit=$?"
cat ~/healthcheck/logs/$(date +%Y-%m-%d).log

# 4. 問題なければlaunchdに登録（毎朝7:00・母艦のローカル時刻）
bash ops/healthcheck/install.sh

# 5. 即時発火テスト
launchctl kickstart "gui/$(id -u)/com.finoject.mcp-healthcheck"

# 解除
bash ops/healthcheck/install.sh --uninstall
```

依存: `jq`（判定JSONの解析。`brew install jq`）、任意で `coreutils`（`gtimeout`。無ければ自前の見張りで代替）。

## 設定（~/healthcheck/config.env）

`healthcheck.sh` は起動時に `config.env` を読み込む（launchdは環境変数を引き継がないため）。
**config.env の値が環境変数より優先される**ので、一時的に値を変えて試すときは config.env を書き換える。

| 変数 | 既定 | 意味 |
|---|---|---|
| `HEALTHCHECK_SLACK_WEBHOOK_URL` | 未設定 | claudeが死んでいる時のフォールバック通知先。未設定ならmacOS通知のみ |
| `SLACK_CHANNEL` | `#ops` | 異常時に点検エージェントがSlack MCPで投稿するチャンネル |
| `REG_MONITOR_DATA_URL` | Pages上のdata.json | 巡回の生存判定に使う公開出力 |
| `STALE_HOURS` | `3` | generatedAtがこれ以上前なら異常 |
| `TIMEOUT_SEC` | `600` | claude -p の打ち切り秒数 |
| `MAX_TURNS` | `30` | 暴走防止の最大ターン数 |
| `LOG_RETENTION_DAYS` | `30` | 日次ログの保持日数 |
| `CLAUDE_BIN` | PATHから解決 | claudeがPATHに無い場合の絶対パス |

## 設計上の要点

- **静かな失敗をさせない**: 利用枠上限・認証切れ・タイムアウトでは `claude -p` 自体が失敗し、Slack MCPも使えない。
  その場合は claude を経由しない2経路（Slack Incoming Webhook → macOS通知）で必ず痕跡を残す。
- **判定形式のチェック**: 点検エージェントが判定を出さずに終わった（余計な作業をして `--max-turns` に当たった等）ケースも
  「静かな失敗」なので、結果が `OK:` / `ALERT:` で始まらなければ失敗として扱う。
- **多重起動防止とロックの自己回復**: `mkdir` の原子性でロックする（macOSに `flock` は無い）。
  ただしロックが残ったまま母艦が再起動すると以後永久にSKIPして死ぬので、
  ロック保持プロセスの生存と年齢の両方を見て残存ロックを回収する。
- **タイムアウトで孫を残さない**: claudeはMCPサーバーを子プロセスとして抱える。`gtimeout` があればプロセスグループごと、
  無ければ `pgrep -P` で子孫を末端から順に落とす。
- **権限の最小化**: `--allowedTools` は読み取り系Bashと点検に要るMCPツールだけ。
  加えて `--disallowedTools` で書き込み系を明示的に禁止する（点検エージェントに書き込み権限を与えない）。
- **cronでなくlaunchd**: スリープ中に発火時刻を過ぎても、launchdは復帰時に1回だけ実行する（cronは黙って飛ばす）。

## reg-monitorの点検について

- 巡回は `.github/workflows/crawl.yml` の cron `37 * * * *`（**毎時37分・1日24回**）。
  したがって朝7:00の点検時点では直近6:37の更新が見えているのが正常。
  `STALE_HOURS=3` は数回のドロップ/遅延を許容した値で、24時間では緩すぎる（1日ほぼ止まっていても気づけない）。
- 見るのは母艦のローカルcloneではなく**公開中の出力**（`https://finoject.github.io/finoject-reg-monitor/data.json` の
  `generatedAt`）。ローカルの `git log` は母艦がpullしていなければ古いだけで、パイプラインの健全性を示さない。
  この1点で「巡回の失敗」と「GitHub Pagesへの公開の失敗」の両方を検知できる。
- data.json は800KB超あるので、プロンプト側で先頭だけ読む（`head -c` / `jq -r .generatedAt`）よう指示している。

## 運用上の注意

1. **利用枠との関係**: ヘッドレス実行も通常のClaude Code利用枠を消費する。点検1回は軽量だが `MAX_TURNS` で暴走を防いでいる。
   上限に当たった朝はフォールバック通知が来るので、その日は手動確認に切り替える。
2. **点検エージェント自体の監視**: 「フォールバック通知すら来ない＝launchdごと死んでいる」ケースは
   `logs/launchd-err.log` の確認と、週1回の `launchctl list | grep finoject` 目視で拾う。
3. **認証切れの先回りはしない**: freee等のOAuthトークンは「切れてから」検知する構成。
   切れる前の更新は各MCPサーバー側の実装に依存するため、ここは検知層と割り切る。
4. **MCPツール名は環境依存**: `mcp__Gmail__search_threads` / `mcp__Slack__slack_send_message` /
   `mcp__freee__freee_auth_status` は母艦の `claude mcp list` の登録名に合わせる（サーバー名の大文字小文字まで一致が必要）。
   初回の手動テストで「ツールが呼べなかった」と報告されたら、まずここを疑う。
5. **CLIのフラグ名**: `--allowedTools` / `--disallowedTools` を使っている。
   Claude Code 2.1.251 では `--allowedTools, --allowed-tools` / `--disallowedTools, --disallowed-tools` の
   両表記が受理されることを確認済み。将来片方だけになった場合は初回テストで引数エラーになるので、
   そのときハイフン表記に変える。
6. **認証情報の受け渡し**: `config.env` を `.` で読み込んでもシェル変数になるだけで claude には渡らない。
   `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` はスクリプト側で明示的に `export` している
   （launchd配下でKeychainが読めない場合、ここが唯一の認証経路になる）。
