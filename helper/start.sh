#!/bin/bash
# 手动启动「划词翻译」
# 原理：写入手动启动标记，然后重启用扩展让 enable() 重新执行
# （扩展始终保留在系统启用列表中，是否随登录启动由面板菜单的
#  「开机启动」开关决定）

mkdir -p "$HOME/.cache/selection-translator"
touch "$HOME/.cache/selection-translator/manual-start"

gnome-extensions disable selection-translator@kimi 2>/dev/null
gnome-extensions enable selection-translator@kimi
