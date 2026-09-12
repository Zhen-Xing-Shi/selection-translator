# 开发约定

1. 每次改动需要提交并推送到远程仓库（推送用 `./push.sh`，它会自动探测代理端口）。
2. 每次改动都要在本机重新安装：GNOME Shell 加载的是安装目录
   `~/.local/share/gnome-shell/extensions/selection-translator@kimi/` 中的副本，
   与仓库是相互独立的文件。改动 `extension/` 后必须复制过去并重启 Shell
   （注销重登，或 X11 下 `Alt+F2` → `r`）才会生效；改动 `helper/` 后同理复制到
   `~/.local/share/selection-translator/`。
3. 每次改动都要更新 README.md。
4. README.md 要保持简洁准确：不要把更新历史写进去，只保留当前版本的情况说明。
5. 每次改动代码时都要先阅读 README.md。
