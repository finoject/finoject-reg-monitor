# 母艦（Mac mini）Remote Control 常駐化

iPhone / ThinkPad からセッションが切れる原因は、クライアント側ではなく **母艦そのものが落ちていること**。
これはその対策で、Mac mini 上の `claude --remote-control` を launchd 配下で常駐させ、
落ちても自動で復帰させる。

## 何が起きていたか

Remote Control のセッションは `environment_kind: bridge`、つまり **実行実体が Mac mini 上のプロセス**にある。
母艦化によって「iPhone を閉じてもセッションが死なない」状態にはなったが、
単一障害点が iPhone から Mac mini に移っただけで、母艦が落ちれば全 bridge セッションが同時に死ぬ。

実際の観測（2026-08-28）:

| セッション | `last_init_error` | epoch |
|---|---|---|
| Mac miniへの記録・記憶の不具合 | `computer_unreachable` 8/29 00:48:57 JST | 3 |
| Refinancierは切るべきか？ | `computer_unreachable` 8/29 00:48:12 JST | 9 |
| 日立向けピッチデック作成 | `computer_unreachable` 8/26 09:39 JST | 5 |
| Hecto Financial 資金移動業登録 | `computer_unreachable` 8/24 15:11 JST | 14 |

**45秒差で複数セッションが同時に落ちている**＝個別の不具合ではなく母艦の一括障害。
`worker_epoch` が積み上がっているのは、同じことが何度も繰り返されてきたということ。

直接の技術的原因は `claude --remote-control` が **インタラクティブ起動でTTYを要求する**こと。
そのためターミナルや tmux から手起動する運用になり、**再起動・ログアウト・ターミナル終了で母艦ごと消える**。

## 層構成

```
launchd（LaunchAgent・ログイン時に起動、落ちたら KeepAlive で再起動）
  └─ mothership.sh（ロック・ネットワーク復帰待ち・pty割り当て・見張り・通知）
       └─ pty（tmux または /usr/bin/script）
            └─ claude --remote-control 母艦
```

`mothership.sh` は「claude --remote-control を pty 付きで1本だけ確実に上げ続ける」ことだけを担う。

## ファイル

| ファイル | 役割 |
|---|---|
| `mothership.sh` | 実行本体。既存セッションの引き継ぎ／多重起動防止／ネットワーク待ち／pty割り当て／生存見張り／異常通知 |
| `com.finoject.mothership.plist` | launchd定義テンプレート（`__HOME__` を置換して使う） |
| `config.env.example` | 設定テンプレート。`~/mothership/config.env` にコピーして使う（**コミットしない**） |
| `install.sh` | 配置・`__HOME__`置換・launchd登録 |
| `power-settings.sh` | 電源設定（要sudo）。スリープ禁止・停電復帰・自動更新の再起動抑止 |
| `status.sh` | 生存確認。困ったらまずこれ |

## 導入

母艦のターミナルで:

```bash
# 常駐化とヘルスチェックをまとめて
bash ops/install.sh

# 常駐化だけなら
bash ops/mothership/install.sh

# 電源設定（別途sudoが要る。これをやらないとスリープで同じ切断が再発する）
sudo bash ops/mothership/power-settings.sh --with-update-policy

# 確認
~/mothership/status.sh

# 解除
bash ops/mothership/install.sh --uninstall
```

任意: `brew install tmux` を入れておくと tmux モードになり、母艦の画面を後から覗ける
（`tmux -S ~/mothership/tmux.sock attach -t mothership`、抜けるのは `Ctrl-b d`）。
無ければ macOS 標準の `/usr/bin/script` で pty を作るので、追加インストールは必須ではない。

## 設定（~/mothership/config.env）

`mothership.sh` は起動時に `config.env` を読み込む（launchdは環境変数を引き継がないため）。

| 変数 | 既定 | 意味 |
|---|---|---|
| `MOTHERSHIP_SESSION_NAME` | `母艦` | Remote Control セッションの表示名 |
| `MOTHERSHIP_PTY` | `auto` | `tmux` / `script` / `auto`（tmuxがあればtmux） |
| `MOTHERSHIP_TMUX_SESSION` | `bokan` | 手動運用と同じ名前。**既に在れば新規に立てず引き継ぐ**（母艦の二重起動を防ぐ） |
| `MOTHERSHIP_WORKDIR` | `$HOME` | claude を起動する作業ディレクトリ |
| `MOTHERSHIP_NET_WAIT_SEC` | `180` | 再起動直後にネットワーク復帰を待つ上限 |
| `MOTHERSHIP_SLACK_WEBHOOK_URL` | 未設定 | 母艦が落ちた時の通知先。**母艦経由でない経路**なのが要点 |
| `CLAUDE_CODE_OAUTH_TOKEN` | 未設定 | Keychainが読めない場合の長期トークン（`claude setup-token`） |
| `CLAUDE_BIN` | PATHから解決 | claudeがPATHに無い場合の絶対パス |
| `MOTHERSHIP_LOG_RETENTION_DAYS` | `30` | 日次ログの保持日数 |

## 設計上の要点

- **ptyを自前で用意する**: `claude --remote-control` はインタラクティブ起動なのでTTYが要る。
  launchd 配下にTTYは無いため、tmux か `/usr/bin/script` で擬似端末を割り当てる。これが常駐化の肝。
- **LaunchDaemon ではなく LaunchAgent**: claude の認証はユーザーの Keychain と `~/.claude` にある。
  root で動かすと認証が読めない。代償として「GUIログイン中しか動かない」ので、**自動ログインが前提**になる。
- **`pgrep -f` / `pkill -f` を使わない**: `--remote-control` という文字列は、それを含むコマンドラインを
  実行しているだけの無関係なシェルにも当たる（検証中に実際に自分自身を kill した）。
  多重起動の判定は mkdir の原子性によるロックと pid ファイルで行い、停止も pid を直接狙う。
- **pidの再利用に備える**: ロック保持者が生きているかだけでなく、その pid が本当に `mothership.sh` かを
  `ps -o command=` で確認する。再起動後の pid 再利用で「永久にSKIPして死ぬ」のを防ぐ。
- **ネットワーク復帰を待つ**: 再起動直後は launchd の方が Wi-Fi/DNS より先に走る。
  待たずに起動すると失敗し、KeepAlive の再試行を無駄に消費する。
- **ProcessType = Interactive**: Background にすると長時間アイドル時に App Nap 相当の抑制を受け、接続が切れやすい。
- **`ThrottleInterval` と自前のバックオフ**: 認証切れ等で即死する場合、KeepAlive が秒間隔で再起動を連打する。
  設定不備は通知してから長めに待って抜ける。
- **`$VAR` の直後に全角文字を置かない**: 母艦の macOS が積んでいる bash は 3.2 で、
  変数名の切り出しがマルチバイト非対応。`"$LABEL（…）"` と書くと全角括弧のバイトまで
  変数名に含めてしまい、`set -u` のもとで `LABEL?: unbound variable` で落ちる
  （2026-08-29 に実際に踏んだ。Linux の bash 5 では正しく動くためテストをすり抜ける）。
  日本語が続く箇所は必ず `"${LABEL}（…）"` と波括弧で閉じる。検出は次で行える:
  `grep -nP '\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]' ops/*.sh ops/*/*.sh`
- **母艦経由でない通知経路**: 母艦が落ちている時は Remote Control もSlack MCPも使えない。
  Incoming Webhook と macOS 通知で必ず痕跡を残す（healthcheck と同じ考え方）。

## これで直らないもの

- **母艦の画面でメニューやダイアログが開いたまま詰まっている（2026-08-29 の実際の障害）**:
  `/remote-control` を実行するとメニューが開く。それを閉じないでいると、
  **メッセージは届いているのに処理されず溜まる**。プロセスは生きているので、
  このスクリプトも launchd も何も検知できない。Jump で母艦の画面を見て
  `Escape` を1回送るのが唯一の対処。**外から見える記録では通常の不達と区別がつかない**ので、
  母艦が応答しないときは電源より先にこれを疑うこと。
- **母艦の電源が物理的に切れている**: `power-settings.sh` の `autorestart 1` で停電復帰はするが、
  手で電源を落とされたら戻らない。
- **自動ログインが無効／FileVault有効**: LaunchAgent は GUI ログイン中しか動かない。
  再起動後、誰かが手でログインするまで母艦は復帰しない。`status.sh` の [5] で検出できる。
- **無人で回り続ける定期ジョブ**: bridge に置くと母艦の停止と一緒に止まる。
  reg-monitor の巡回が GitHub Actions で動いているのは正しい設計で、今回の母艦障害の影響を受けていない。
  これは「記憶をどこに置くか」とは別カテゴリの話。
- **記憶そのものの耐久性**: 記憶・記録が母艦にあるのは母艦化の目的そのもので、正しい。
  ただし常駐化が守るのは**可用性**（いつでも母艦の記憶に届くこと）であって、
  **耐久性**（SSD故障・盗難・ディスク枯渇で記憶が消えないこと）は別問題で、バックアップでしか手当てできない。

## トラブルシューティング

| 症状 | 見るところ |
|---|---|
| セッションが `computer_unreachable` | `~/mothership/status.sh` の [1][2][4][5] |
| 起動直後に落ち続ける | `~/mothership/logs/<日付>.log` の `exit=` と `launchd-err.log`。認証切れなら `claude setup-token` |
| 登録したのに動かない | `launchctl list \| grep finoject`。自動ログインが無効だと GUI セッションが無く起動しない |
| 画面を見たい | `tmux -S ~/mothership/tmux.sock attach -t mothership`（抜けるのは `Ctrl-b d`。`Ctrl-c` はclaudeに届く） |
| 二重に上がった | ロックで防いでいるが、手起動が残っているなら `~/mothership/claude.pid` の pid を確認して止める |
