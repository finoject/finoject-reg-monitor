#!/bin/bash
# 母艦（Mac mini）一括セットアップ。母艦のターミナルで実行する。
#
#   git clone https://github.com/finoject/finoject-reg-monitor.git
#   cd finoject-reg-monitor
#   bash ops/install.sh
#
# 入るもの:
#   1. mothership  … Remote Control を launchd で常駐化（セッション切断の直接の対策）
#   2. healthcheck … 毎朝7:00の自己点検（配置のみ。設定を入れてから登録する）
# 電源設定（sudo が要る）は別コマンドとして最後に案内する。

set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "このスクリプトはmacOS（母艦）で実行する前提です（uname=$(uname -s)）" >&2
  exit 1
fi

echo "==================== 1/2 母艦の常駐化 ===================="
bash "$SRC/mothership/install.sh"

echo
echo "==================== 2/2 ヘルスチェック ===================="
# 設定（Slackチャンネル/Webhook）を入れる前にlaunchdへ載せると初回から誤報が出るため、
# ここでは配置だけ行う。登録は下の案内に従って各自で行う。
bash "$SRC/healthcheck/install.sh" --no-launchd

cat <<MSG

==================== 残りの手順 ====================

[A] 電源設定を当てる（これをやらないと、スリープで同じ切断が再発します）
    sudo bash $SRC/mothership/power-settings.sh --with-update-policy

[B] 自動ログインを有効にする（再起動後に母艦が自力で戻るために必須）
    システム設定 → ユーザとグループ → 「自動的にログイン」

[C] ヘルスチェックの通知先を設定してから登録する
    vi ~/healthcheck/config.env          # SLACK_CHANNEL と Webhook を記入
    ~/healthcheck/healthcheck.sh         # 手動で1回テスト
    bash $SRC/healthcheck/install.sh     # 問題なければ毎朝7:00で登録

[D] 確認
    ~/mothership/status.sh

MSG
