# 划词翻译 (selection-translator)

为 GNOME Wayland 桌面定制的系统级划词翻译工具：选中英文（或中文）文字后，
鼠标旁弹出「译」按钮，点击即弹出释义卡片。

- 单词：本地 ECDICT 离线词库（音标、中英释义、词形变化、柯林斯星级）
- 句子：有道网页翻译接口，MyMemory 兜底
- 通过 GNOME Shell 扩展实现，Wayland 下全局生效（原生与 X11 应用通吃）

## 组成

- `extension/` — GNOME Shell 扩展（划词检测、悬浮按钮、结果卡片），
  安装到 `~/.local/share/gnome-shell/extensions/selection-translator@kimi/`
- `helper/translate.py` — 翻译引擎（本地词库 + 在线接口），
  安装到 `~/.local/share/selection-translator/translate.py`
- 词库 `ecdict.db` 来源于 [ECDICT](https://github.com/skywind3000/ECDICT)
  （`ecdict-sqlite-28.zip`，约 800MB，不入库），放入
  `~/.local/share/selection-translator/` 后执行一次
  `python3 translate.py --build-index` 建立变形词索引

## 配置

`~/.config/selection-translator/config.json`：

```json
{"enabled": true, "autoPopup": false, "autostart": false}
```

- `enabled`：总开关（顶栏「译」菜单也可切换）
- `autoPopup`：选中后直接弹结果（免点击按钮）
- `autostart`：开机启动（面板菜单开关）

## 启动 / 退出 / 开机启动

- 启动：应用列表（Show Apps）中的「划词翻译」图标，或执行
  `~/.local/share/selection-translator/start.sh`
- 退出：顶栏「译」菜单 →「退出」（停止当前运行，不影响开机启动开关）
- 开机启动：顶栏「译」菜单 →「开机启动」开关；off 时登录后扩展休眠
  （不显示托盘、不监听选区），可随时用启动图标唤醒

## 卸载

```bash
gsettings reset org.gnome.shell enabled-extensions
rm -rf ~/.local/share/gnome-shell/extensions/selection-translator@kimi \
       ~/.local/share/selection-translator ~/.config/selection-translator \
       ~/.local/share/applications/selection-translator.desktop
```

然后注销重新登录。
