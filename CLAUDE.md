# finoject-reg-monitor

プロジェクトの中身は [README.md](README.md)、母艦の運用は [ops/healthcheck/README.md](ops/healthcheck/README.md) を参照。

---

# 環境の前提（毎回確認しないこと。この前提で話すこと）

## 母艦: Mac mini

- **モニターを接続していないヘッドレス運用。物理的な画面は存在しない。**
  - ❌「Mac mini の画面を見てください」「マウスを動かしてください」「Dock から…」
  - ❌「Mac mini を直接触れますか？」と選択肢として聞くこと
  - ⭕ 画面を見る手段は次の1つだけ
- **画面を見る唯一の方法: ThinkPad から Jump Desktop（Jump）で接続する。**
  Jump で Mac の画面が出れば、ターミナルもシステム設定も普通に操作できる。
  つまり「Mac 上でやる作業」は全部 Jump 経由で実行可能。入口が Jump なだけ。
- **Jump で接続できること自体が診断になる**: 接続できた＝Mac は起動していてネットにもいる。
- 電源は切っていない。ノースリープ設定も適用済み（ユーザー申告）。
  したがって「電源を入れてください」「スリープから起こしてください」は的外れ。

### 大原則: 記憶も成果物も、全部 Mac mini に置く

**iPhone も ThinkPad も単なる作業端末。中身は母艦にしかない。**
クラウド上のコンテナは使い捨てで、`~/Vault/` にも `~/.claude/` にも一切触れない。
「母艦でやって」と言われたら、断らずに下の手順で母艦にセッションを立てること。

### セッションを母艦で動かす方法（2026-08-29 実証）

**根本原因は「環境セレクタが Default のままだったこと」。** 選択肢は存在する。
2026-08-26〜08-29 に iPhone から作られたセッションが5本とも例外なくクラウドだったのは、
このセレクタを一度も切り替えていなかったため。

公式ドキュメント（Cloud environments）の記述:

> When you have more than one environment, sessions choose one per surface:
> On the web, the Desktop app, and the mobile app, sessions use the environment
> shown in the selector.

**恒久的な直し方（これが本丸）**

1. iPhone の Claude アプリ、または ThinkPad で claude.ai/code を開く
2. **メッセージ入力欄のすぐ上の行**にある**雲のアイコン**（現在の環境名が出ている）を選ぶ
   — 設定ページからは行けない。**この雲アイコンだけが入口**（ドキュメント明記）
3. 開いたメニューの **Remote Control** セクションから **mac-mini:ClaudeCode:df6a** を選ぶ

以後、そのサーフェスで作る新規セッションは母艦に立つ。

**その場しのぎの手段（セレクタが使えないときだけ）**

- 既にあるセッションを開く。母艦の `claude remote-control` が公開したもの。
- `create_session` に `environment_id: env_01Cgj7qVTfvNvpA1kNhxRvCG` を渡す。
  クラウド側のセッションからでも母艦上にセッションが立つ（2026-08-29 実証）。
  ただし**これは対症療法**。毎回「母艦でやって」と言わせる時点で解決していない。
  まずセレクタを直すこと。

**CLI は事情が違う。** `claude --cloud` 等の CLI 経路は、明示指定が無いと
**bridge 環境を除外して**フォールバックする（ドキュメント明記）。CLI から母艦を
既定にしたい場合は `/remote-env` で選ぶ（`remote.defaultEnvironmentId` に保存される）。

環境IDの対応（`list_environments` で確認できる）:

| environment_id | 名前 | 種別 | 実体 |
|---|---|---|---|
| `env_01Cgj7qVTfvNvpA1kNhxRvCG` | mac-mini:ClaudeCode:df6a | bridge | **母艦（Mac mini）** |
| `env_01N6qPSHcKhQXtzgoyQovip8` | Default | anthropic_cloud | クラウドの使い捨てコンテナ |

自分がどちらに居るかは `uname -a` で判別する。**Darwin なら母艦、Linux ならクラウド。**
クラウドに居ることが分かったら、それを理由に作業を断らず、2. で母艦に渡すこと。

定期タスク（Routine）は `environment_id` を明示できるので既に母艦へ寄せてある（9本）。
唯一 `finoject-24x365-watchdog` だけがクラウドだが、これは**母艦の生死を監視する役だから
母艦に置けない**という必然であって、方針の例外ではない。クラウドへ移そうとしないこと。

### 母艦について、作る前に知っておくこと

- **Remote Control の常駐化は既に済んでいる。作り直さないこと。**
  `~/Library/LaunchAgents/com.finoject.bokan-remote-control.plist` が
  RunAtLoad ＋ StartInterval 60秒で `~/Vault/ClaudeCode/bokan/bokan-watchdog.sh` を回している。
  tmux セッション名は `bokan`、起動形式は `claude remote-control --name '母艦'`、
  ログは `~/Library/Logs/bokan-remote-control.log`。
  （2026-08-29、これを確認せずに launchd 常駐化を一式作ってしまい、全部捨てた）
- **リポジトリはホーム直下ではなく `~/Vault/ClaudeCode/` の下**。
  例: `~/Vault/ClaudeCode/finoject-reg-monitor`
- **シェルスクリプトで `$VAR` の直後に全角文字を置かない。** 母艦の bash は 3.2 で
  変数名の切り出しがマルチバイト非対応のため、`"$LABEL（…）"` は
  `LABEL?: unbound variable` で落ちる。必ず `"${LABEL}（…）"` と波括弧で閉じる。
  Linux の bash 5 では正しく動くのでテストをすり抜ける。
- **Windows 側で触ったファイルが CRLF になって入ってくる。**
  `git status` で全ファイルが変更に見えたら、まず
  `git diff -w --ignore-cr-at-eol` で差分が消えるか確認する。

## `computer_unreachable` の読み方（2026-08-29 の実例つき）

**まず母艦の画面（Jump）で、メニューやダイアログが開いたままになっていないかを見ること。**

2026-08-29 の実際の原因はこれだった。`/remote-control` を実行するとメニューが開くが、
それを閉じないまま公開していたため、**メッセージは届いていたのに処理されず溜まっていた**。
`Escape` を1回送れば解消する。電源・スリープ・プロセスの死・容量不足・ネットワークの
いずれでもなかった。そして**外から見える記録では通常の不達と区別がつかない**。

判定に使ってよい指標・悪い指標:

| 指標 | 使えるか |
|---|---|
| 母艦にバインドされた Routine の `last_run.status` が SUCCEEDED か | **これが唯一の実測**。母艦が生きているかはこれで判断する |
| 母艦の画面の `✓ Connected` と `Capacity: n/32` | 現在地として信用してよい |
| `last_init_error` | **単独では使えない**。前回の失敗の記録で、そのセッションが次に正常起動すれば消える。裏を返すと、残っている＝「前回失敗してから一度も開かれていない」というだけで、今も不通である証拠にはならない |
| `connection_status: disconnected` | **使えない**。使っていないセッションの通常の姿であり、異常ではない |

2026-08-29 に、下2つを「現在の障害」と読み違えて「母艦が落ちた」と誤診した。
同じ読み違いが `finoject-24x365-watchdog` の STEP 3 にも埋め込まれており、
母艦が正常でも「電源を確認してください」と誤報が飛ぶ条件になっている（未修正）。

## 手元: ThinkPad（Windows）

- 普段の操作端末。Claude Desktop アプリを使っている。
- iPhone からも同じセッションを見る。
- コマンドを打つなら PowerShell（Windows キー →「powershell」）。

## 対策の重さの決め方（2026-08-29 ユーザー方針）

- **完全を目指さない。** コスト・手間と発生頻度のバランスで決める。
  「二度と起きない」を作りに行かず、**「起きたら気づけて、直し方が分かる」**で十分なことが多い。
- **作る前に、既にあるものを確認する。** 2026-08-29 に母艦の常駐化を一式作ったが、
  既に `com.finoject.bokan-remote-control` が同じ仕事を、より良い設計でしていた。全部捨てた。
- **実際に起きた障害にだけ対策を作る。** まだ起きていない故障モード（電源断・スリープ・
  プロセス死）に先回りしない。今回それらは1件も起きていなかった。
- 軽い対策が既存の仕組みの中に収まるなら、新しい常駐プロセスやセッションを増やさない。

## 説明の仕方

- 略さない。どの機器の、どのアプリで、何を入力するかまで書く。
- 専門用語を前提にしない。コマンドには「何が起きたら成功か」を添える。
