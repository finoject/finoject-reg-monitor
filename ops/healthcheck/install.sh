#!/bin/bash
# 母艦ヘルスチェックの導入スクリプト（macOS専用）
#
#   bash ops/healthcheck/install.sh              # 配置してlaunchdに登録
#   bash ops/healthcheck/install.sh --no-launchd # 配置だけ（先に手動テストしたいとき）
#   bash ops/healthcheck/install.sh --uninstall  # launchdから解除（ファイルとログは残す）
#
# plistの__HOME__置換を自動でやるので、USERNAMEの書き換え漏れ事故が起きない。

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/healthcheck"
LABEL="com.finoject.mcp-healthcheck"
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
  echo "解除しました。$DEST_DIR のスクリプトとログはそのまま残しています。"
  exit 0
fi

# --- 配置 -------------------------------------------------
mkdir -p "$DEST_DIR/logs"
cp "$SRC_DIR/healthcheck.sh" "$SRC_DIR/healthcheck-prompt.md" "$DEST_DIR/"
chmod +x "$DEST_DIR/healthcheck.sh"

# config.env は秘密情報を含むので既存を絶対に上書きしない
if [ -f "$DEST_DIR/config.env" ]; then
  echo "既存の $DEST_DIR/config.env は変更していません"
else
  cp "$SRC_DIR/config.env.example" "$DEST_DIR/config.env"
  echo "$DEST_DIR/config.env を作成しました（Slackチャンネル/Webhookを設定してください）"
fi

echo "配置しました: $DEST_DIR"

# --- 依存の確認（無くても動くが精度が落ちるものを知らせる） ---
command -v jq >/dev/null 2>&1 || echo "WARN: jq が無い（brew install jq）。判定JSONの解析ができません"
command -v claude >/dev/null 2>&1 || echo "WARN: claude がPATHに無い。config.env の CLAUDE_BIN で絶対パスを指定してください"
command -v gtimeout >/dev/null 2>&1 || echo "INFO: gtimeout が無いので自前の見張りでタイムアウトします（brew install coreutils で改善）"

if [ "$MODE" = "files-only" ]; then
  cat <<MSG

launchdへの登録は行っていません。まず手動で1回テストしてください:

  $DEST_DIR/healthcheck.sh; echo "exit=\$?"
  cat $DEST_DIR/logs/\$(date +%Y-%m-%d).log

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

echo "登録しました: ${LABEL}（毎朝7:00・ローカル時刻）"
launchctl list | grep -F "$LABEL" || true

cat <<MSG

即時発火テスト:
  launchctl kickstart "gui/$(id -u)/$LABEL"
  tail -f $DEST_DIR/logs/\$(date +%Y-%m-%d).log

解除:
  bash $SRC_DIR/install.sh --uninstall
MSG
