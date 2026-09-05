#!/usr/bin/env bash
set -euo pipefail
export ANDROID_HOME=/home/user/android-sdk
mkdir -p "$ANDROID_HOME/cmdline-tools"
cd "$ANDROID_HOME"
echo "Downloading cmdline-tools..."
curl -sSL -o clt.zip "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
rm -rf cmdline-tools/latest cmdline-tools/cmdline-tools
unzip -q clt.zip -d cmdline-tools
mv cmdline-tools/cmdline-tools cmdline-tools/latest
rm clt.zip
SDKM="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
echo "Accepting licenses..."
yes | "$SDKM" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
echo "Installing platform-tools, platform 34, build-tools 34.0.0..."
"$SDKM" --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-34" "build-tools;34.0.0"
echo "SDK_INSTALL_DONE"
ls "$ANDROID_HOME"
