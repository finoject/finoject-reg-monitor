#!/bin/bash
# 母艦の電源設定を「絶対に寝ない・落ちても自力で戻る」側に倒す（macOS専用・要sudo）。
#
#   sudo bash ops/mothership/power-settings.sh              # 適用
#   sudo bash ops/mothership/power-settings.sh --dry-run    # 現状表示のみ
#   sudo bash ops/mothership/power-settings.sh --with-update-policy
#       ↑ macOSの自動アップデートによる勝手な再起動も止める（再起動＝bridge全滅なので効く）
#
# LaunchAgent を入れても、母艦がスリープすれば Remote Control は切れる。
# 常駐化と電源設定は両方やって初めて意味がある。

set -euo pipefail

DRY_RUN=0
UPDATE_POLICY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --with-update-policy) UPDATE_POLICY=1 ;;
    *) echo "不明な引数: $arg" >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || { echo "macOS（母艦）で実行してください（uname=$(uname -s)）" >&2; exit 1; }

show() {
  echo "--- 現在の電源設定 ---"
  pmset -g custom 2>/dev/null | grep -E 'sleep|disksleep|womp|autorestart|powernap|standby|hibernatemode|ttyskeepawake' || pmset -g
}

show

if [ "$DRY_RUN" -eq 1 ]; then
  echo; echo "(--dry-run のため変更していません)"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { echo "sudo で実行してください" >&2; exit 1; }

echo; echo "--- 適用中 ---"
# sleep 0        : 本体を絶対にスリープさせない（これが最重要）
# disksleep 0    : ディスクを止めない
# displaysleep 10: 画面だけは消えてよい（本体スリープとは別物）
# womp 1         : ネットワークアクセスで復帰
# autorestart 1  : 停電・電源断からの復帰時に自動起動
# powernap 0     : Power Nap による中途半端な省電力状態を避ける
# standby 0 / hibernatemode 0 : 深いスリープ状態に落とさない
# ttyskeepawake 1: ターミナル/SSHセッションがある間は寝ない
pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1 \
          powernap 0 standby 0 hibernatemode 0 ttyskeepawake 1

if [ "$UPDATE_POLICY" -eq 1 ]; then
  echo "--- 自動アップデートの自動再起動を無効化 ---"
  # セキュリティ更新の自動DL/適用は残し、「macOS本体の更新を自動インストール（＝再起動）」だけ止める
  defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
  defaults write /Library/Preferences/com.apple.commerce AutoUpdateRestartRequired -bool false
  echo "macOS本体の自動アップデート（再起動を伴う）を無効にしました。手動更新は各自で実施してください。"
fi

echo
show

cat <<'MSG'

--- 手動で必要な設定（CLIからは安全に変更できない） ---
1. 自動ログインを有効にする
   システム設定 → ユーザとグループ → 「自動的にログイン」で母艦のユーザーを選択
   ※ LaunchAgent は GUI ログイン中のみ動く。自動ログインが無いと、再起動後に
     誰かが手でログインするまで母艦は復帰しない。
2. FileVault を無効にする（有効だと再起動後にパスワード入力まで自動ログインできない）
   システム設定 → プライバシーとセキュリティ → FileVault
   ※ 物理的な盗難リスクとのトレードオフ。有効のままにするなら、再起動後の復帰は手動になる。
MSG
