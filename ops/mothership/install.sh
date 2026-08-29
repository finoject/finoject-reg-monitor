#!/bin/bash
# 母艦 Remote Control 常駐化の導入スクリプト（macOS専用）
#
#   bash ops/mothership/install.sh              # 配置してlaunchdに登録（＝常駐開始）
#   bash ops/mothership/install.sh --no-launchd # 配置だけ（先に手動テストしたいとき）
#   bash ops/mothership/install.sh --uninstall  # 常駐解除（ファイルとログは残す）
#
# plistの__HOME__置換を自動でやるので、パス書き換え漏れの事故が起きない。

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/mothership"
LABEL="com.finoject.mothership"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
MODE="install"

for arg in "$@"; do
  case "$arg" in
    --no-launchd) MODE="files-only" ;;
    --uninstall)  MODE="uninstall" ;;
    *) echo "不明な引数: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "このスクリプトはmacOS（母艦）で実行する前提です（uname=$(uname -s)）" >&2
  exit 1
fi

if [ "$MODE" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || echo "（登録されていませんでした）"
  rm -f "$PLIST_DEST"
  # 常駐が外れても Remote Control 本体は残るので明示的に止める。
  # `pkill -f -- "--remote-control"` は使わない。その文字列を含むコマンドラインを
  # 実行しているだけの無関係なシェルまで巻き込んで殺すため。pidファイルで正確に狙う。
  if [ -f "$DEST_DIR/claude.pid" ]; then
    CPID="$(cat "$DEST_DIR/claude.pid" 2>/dev/null || true)"
    if [ -n "$CPID" ] && kill -0 "$CPID" 2>/dev/null; then
      kill -TERM "$CPID" 2>/dev/null && echo "Remote Control プロセス (pid=$CPID) を停止しました"
    fi
  fi
  if command -v tmux >/dev/null 2>&1; then
    tmux -S "$DEST_DIR/tmux.sock" kill-server 2>/dev/null || true
    tmux -S "/tmp/mothership-$(id -u).sock" kill-server 2>/dev/null || true
  fi
  rm -rf "$DEST_DIR/.lock" "$DEST_DIR/claude.pid"
  echo "常駐を解除しました。$DEST_DIR のスクリプトとログはそのまま残しています。"
  exit 0
fi

# --- 配置 -------------------------------------------------
mkdir -p "$DEST_DIR/logs"
cp "$SRC_DIR/mothership.sh" "$SRC_DIR/status.sh" "$DEST_DIR/"
chmod +x "$DEST_DIR/mothership.sh" "$DEST_DIR/status.sh"

# config.env は秘密情報を含むので既存を絶対に上書きしない
if [ -f "$DEST_DIR/config.env" ]; then
  echo "既存の $DEST_DIR/config.env は変更していません"
else
  cp "$SRC_DIR/config.env.example" "$DEST_DIR/config.env"
  echo "$DEST_DIR/config.env を作成しました"
fi

echo "配置しました: $DEST_DIR"

# --- 依存の確認 -------------------------------------------
if command -v claude >/dev/null 2>&1; then
  echo "INFO: claude = $(command -v claude) ($(claude --version 2>&1 | head -1))"
else
  echo "WARN: claude がPATHに無い。config.env の CLAUDE_BIN で絶対パスを指定してください"
fi
command -v tmux >/dev/null 2>&1 \
  && echo "INFO: tmux があるので tmux モードで動きます（後から画面を覗けます）" \
  || echo "INFO: tmux が無いので script(pty) モードで動きます（brew install tmux で覗けるようになります）"

# 認証の確認（launchd配下でKeychainが読めないと起動直後に落ち続ける）
if ! claude auth status >/dev/null 2>&1; then
  echo "WARN: claude の認証状態を確認できませんでした。"
  echo "      launchd配下ではKeychainが読めず起動に失敗することがあります。その場合は"
  echo "      \`claude setup-token\` で長期トークンを作り、config.env に"
  echo "      CLAUDE_CODE_OAUTH_TOKEN=... を書いてください。"
fi

if [ "$MODE" = "files-only" ]; then
  cat <<MSG

launchdへの登録は行っていません。まず手動で1回テストしてください:

  $DEST_DIR/mothership.sh &
  sleep 20 && $DEST_DIR/status.sh

問題なければ登録:  bash $SRC_DIR/install.sh
MSG
  exit 0
fi

# --- launchd登録 ------------------------------------------
mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__HOME__|$HOME|g" "$SRC_DIR/$LABEL.plist" > "$PLIST_DEST"

# 既に登録済みなら一度外してから入れ直す（plist更新が反映されないのを防ぐ）
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo "登録しました: ${LABEL}（ログイン時に自動起動・落ちたら自動再起動）"
launchctl list | grep -F "$LABEL" || true

cat <<MSG

確認:
  $DEST_DIR/status.sh
  tail -f $DEST_DIR/logs/\$(date +%Y-%m-%d).log

解除:
  bash $SRC_DIR/install.sh --uninstall

まだ終わっていません。電源設定を当てないと、スリープで同じことが起きます:
  sudo bash $SRC_DIR/power-settings.sh
MSG
