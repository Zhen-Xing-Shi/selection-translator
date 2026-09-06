#!/bin/bash
# 手动启动「划词翻译」
# 休眠中的扩展会监听启动标记文件并自行唤醒；
# 若扩展被外部工具禁用，则顺带重新启用（enable 对已启用者无副作用）

mkdir -p "$HOME/.cache/selection-translator"
touch "$HOME/.cache/selection-translator/manual-start"

gnome-extensions enable selection-translator@kimi 2>/dev/null || true
