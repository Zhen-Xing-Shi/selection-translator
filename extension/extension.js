import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HELPER = GLib.build_filenamev(
    [GLib.get_home_dir(), '.local', 'share', 'selection-translator',
     'translate.py']);
const CONFIG_FILE = GLib.build_filenamev(
    [GLib.get_home_dir(), '.config', 'selection-translator', 'config.json']);

const BTN_AUTOHIDE_MS = 6000;
const HOVER_GRACE_MS = 400;
const DEBOUNCE_MS = 250;
const POINTER_WATCH_MS = 70;
const MAX_TEXT_LEN = 1500;


class SelectionTranslator {
    constructor(uuid, manualStart) {
        this._uuid = uuid;
        this._manualStart = manualStart;   // 通过启动器手动启动
        this._config = {enabled: true, autoPopup: false, autostart: false};
        this._button = null;
        this._popup = null;
        this._popupTime = 0;
        this._overviewId = 0;
        this._popupSource = null;   // 卡片对应的原文（用于检测选区变化）
        this._pollId = 0;
        this._pointerWatchId = 0;   // 指针“按下沿”轮询（检测点击浮层外）
        this._pointerWasDown = false;
        this._indicator = null;
        this._selId = 0;
        this._debounceId = 0;
        this._hideId = 0;
        this._dormantId = 0;
        this._currentText = null;
        this._dragDeferLogged = false;
        this._buttonShowTime = 0;
        this._destroyed = false;
        this._loadConfig();
    }

    // ---------- 配置 ----------
    _loadConfig() {
        try {
            const [ok, bytes] = GLib.file_get_contents(CONFIG_FILE);
            if (ok) {
                const cfg = JSON.parse(new TextDecoder().decode(bytes));
                this._config = Object.assign(
                    {enabled: true, autoPopup: false, autostart: false},
                    cfg);
            }
        } catch (e) {
            // 配置文件缺失/损坏时使用默认值
        }
    }

    _saveConfig() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(CONFIG_FILE), 0o755);
            GLib.file_set_contents(CONFIG_FILE,
                JSON.stringify(this._config, null, 2));
        } catch (e) {
            console.error('selection-translator: 保存配置失败', e);
        }
    }

    // ---------- 启用 / 禁用 ----------
    start() {
        this._destroyed = false;
        // 登录时自动加载且未开启“开机启动”-> 休眠：不建托盘、不监听选区，
        // 仅轮询启动标记文件，等待启动器唤醒
        if (!this._config.autostart && !this._manualStart) {
            console.error('selection-translator: 开机启动已关闭，本次休眠' +
                '（可从应用列表「划词翻译」图标手动启动）');
            this._armDormantWatch();
            return;
        }
        this._fullStart();
    }

    _fullStart() {
        this._destroyed = false;
        console.error('selection-translator: 扩展已启动');
        // 清掉可能残留的启动标记
        try {
            GLib.unlink(GLib.build_filenamev(
                [GLib.get_user_cache_dir(), 'selection-translator',
                 'manual-start']));
        } catch (e) { /* 忽略 */ }

        // 监听系统 PRIMARY 选区（即鼠标划选）
        this._selection = global.display.get_selection();
        this._selId = this._selection.connect('owner-changed',
            (sel, selType, source) => {
                if (selType !== Meta.SelectionType.SELECTION_PRIMARY)
                    return;
                this._scheduleCheck();
            });

        // 焦点窗口变化（点击其他窗口）时关闭结果卡片
        this._focusId = global.display.connect('notify::focus-window',
            () => {
                this._closePopup();
            });

        // 打开概览时关闭卡片
        this._overviewId = Main.overview.connect('showing',
            () => this._closePopup());

        // 悬浮“译”按钮
        this._button = new St.Button({
            style_class: 'st-btn', label: '译',
            visible: false, reactive: true, can_focus: false,
        });
        Main.layoutManager.uiGroup.add_child(this._button);
        this._button.connect('clicked', () => this._triggerButton());
        this._button.connect('notify::hover', () => {
            if (this._button.hover) {
                this._cancelAutohide();
            } else {
                this._armAutohide(1500);
            }
        });
        // 悬停即翻译：按指针坐标判断移入。本扩展不做任何指针/键盘抓取，
        // 事件全部原生送达应用（点击取消选区、Ctrl+C 等均不受影响）；
        // “点击浮层外”由 _armPointerWatch 轮询检测。
        this._button.connect('captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.MOTION)
                return Clutter.EVENT_PROPAGATE;
            // 忽略刚弹出的一小段时间（屏幕边缘钳位可能让按钮正好
            // 出现在光标下方，避免一弹出就误触发）
            if (this._button.visible &&
                GLib.get_monotonic_time() - this._buttonShowTime >
                    HOVER_GRACE_MS * 1000) {
                const alloc = this._button.get_allocation_box();
                const [px, py] = global.get_pointer();
                if (px >= alloc.x1 && px <= alloc.x2 &&
                    py >= alloc.y1 && py <= alloc.y2)
                    this._triggerButton();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // 顶栏开关
        this._buildIndicator();
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.5, '划词翻译', false);
        const label = new St.Label({
            text: '译', style_class: 'st-panel-label', y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(label);

        this._switchItem = new PopupMenu.PopupSwitchMenuItem(
            '启用划词翻译', this._config.enabled);
        this._switchItem.connect('toggled', item => {
            this._config.enabled = item.state;
            this._saveConfig();
            if (!item.state) {
                this._hideButton();
                this._closePopup();
            }
        });
        this._indicator.menu.addMenuItem(this._switchItem);

        const autoItem = new PopupMenu.PopupSwitchMenuItem(
            '选中后直接弹出结果（免点击）', this._config.autoPopup);
        autoItem.connect('toggled', item => {
            this._config.autoPopup = item.state;
            this._saveConfig();
        });
        this._indicator.menu.addMenuItem(autoItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 开机启动开关：只写入配置，不影响当前运行状态
        const autostartItem = new PopupMenu.PopupSwitchMenuItem(
            '开机启动', this._config.autostart);
        autostartItem.connect('toggled', item => {
            this._config.autostart = item.state;
            this._saveConfig();
            console.error('selection-translator: 开机启动=' + item.state);
        });
        this._indicator.menu.addMenuItem(autostartItem);

        // 退出：停止当前运行（不影响开机启动开关状态）
        const quitItem = new PopupMenu.PopupMenuItem('退出');
        quitItem.connect('activate', () => this._quit());
        this._indicator.menu.addMenuItem(quitItem);

        Main.panel.addToStatusArea('selection-translator', this._indicator,
            1, 'right');
    }

    // 退出：停止全部功能并隐藏托盘图标（扩展仍在启用列表中，
    // 是否随登录启动由「开机启动」开关决定；
    // 会话内可通过应用列表的「划词翻译」图标重新启动）
    _quit() {
        console.error('selection-translator: 用户退出');
        this.stop();
        // 回到休眠态：仍响应启动器唤醒
        this._destroyed = false;
        this._armDormantWatch();
    }

    // ---------- 休眠唤醒（监听启动标记文件） ----------
    _armDormantWatch() {
        this._cancelDormantWatch();
        const flag = GLib.build_filenamev(
            [GLib.get_user_cache_dir(), 'selection-translator',
             'manual-start']);
        const flagFile = Gio.File.new_for_path(flag);
        this._dormantId = GLib.timeout_add(GLib.PRIORITY_LOW, 1000, () => {
            if (this._destroyed) {
                this._dormantId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (!GLib.file_test(flag, GLib.FileTest.EXISTS))
                return GLib.SOURCE_CONTINUE;
            // 丢弃 60 秒前的陈旧标记（防止上次会话残留导致意外唤醒）
            try {
                const info = flagFile.query_info(
                    Gio.FILE_ATTRIBUTE_TIME_MODIFIED,
                    Gio.FileQueryInfoFlags.NONE, null);
                const age = GLib.get_real_time() / 1000000 -
                    info.get_modification_date_time().to_unix();
                if (age > 60) {
                    GLib.unlink(flag);
                    return GLib.SOURCE_CONTINUE;
                }
                GLib.unlink(flag);
            } catch (e) { /* 忽略 */ }
            this._dormantId = 0;
            console.error('selection-translator: 启动器唤醒');
            this._fullStart();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDormantWatch() {
        if (this._dormantId) {
            GLib.source_remove(this._dormantId);
            this._dormantId = 0;
        }
    }

    stop() {
        this._destroyed = true;
        this._cancelDormantWatch();
        if (this._selId) {
            this._selection.disconnect(this._selId);
            this._selId = 0;
        }
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        if (this._overviewId) {
            Main.overview.disconnect(this._overviewId);
            this._overviewId = 0;
        }
        this._cancelDebounce();
        this._cancelAutohide();
        this._closePopup();
        this._cancelPointerWatch();
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    // ---------- 划词检测 ----------
    _scheduleCheck() {
        this._cancelDebounce();
        this._debounceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                this._debounceId = 0;
                this._checkSelection();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelDebounce() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
    }

    _checkSelection() {
        if (this._destroyed)
            return;
        // 拖拽选区进行中（鼠标键仍按住）：延后到松手后再处理，
        // 避免悬浮按钮在拖动中途弹出干扰拖拽。
        const [, , mods] = global.get_pointer();
        if (mods & (Clutter.ModifierType.BUTTON1_MASK |
                    Clutter.ModifierType.BUTTON2_MASK |
                    Clutter.ModifierType.BUTTON3_MASK)) {
            if (!this._dragDeferLogged) {
                this._dragDeferLogged = true;
                console.error(
                    'selection-translator: 拖拽选区进行中，延迟到松手后检测');
            }
            this._scheduleCheck();
            return;
        }
        this._dragDeferLogged = false;
        // 卡片打开期间出现新的选区事件（点击/重选触发），且指针在卡片外
        // -> 用户已在别处操作，关闭卡片
        if (this._popup && this._popupTime &&
            (GLib.get_monotonic_time() - this._popupTime) > 800000) {
            const alloc = this._popup.get_allocation_box();
            const [px, py] = global.get_pointer();
            if (px < alloc.x1 || px > alloc.x2 ||
                py < alloc.y1 || py > alloc.y2) {
                console.error('selection-translator: 新选区事件+指针在卡片外，关闭卡片');
                this._closePopup();
            }
        }
        this._loadConfig();
        if (!this._config.enabled)
            return;
        St.Clipboard.get_default().get_text(
            St.ClipboardType.PRIMARY, (clipboard, text) => {
                if (this._destroyed)
                    return;
                text = (text || '').replace(/\s+/g, ' ').trim();
                if (!text || text.length > MAX_TEXT_LEN) {
                    // 选区被清空（用户点击了其他位置）-> 关闭卡片和按钮
                    this._currentText = null;
                    this._hideButton();
                    this._closePopup();
                    return;
                }
                this._currentText = text;
                if (this._config.autoPopup) {
                    this._hideButton();
                    this._translate(text);
                } else {
                    this._showButton();
                }
            });
    }

    // ---------- 悬浮按钮 ----------
    _triggerButton() {
        if (!this._button || !this._button.visible)
            return;
        const text = this._currentText;
        this._hideButton();
        if (text)
            this._translate(text);
    }

    _showButton() {
        const [x, y] = global.get_pointer();
        const monitor = Main.layoutManager.currentMonitor;
        const bw = 56, bh = 34;
        let bx = x + 14, by = y + 18;
        bx = Math.max(monitor.x, Math.min(bx, monitor.x + monitor.width - bw));
        by = Math.max(monitor.y, Math.min(by, monitor.y + monitor.height - bh));
        this._button.set_position(bx, by);
        this._buttonShowTime = GLib.get_monotonic_time();
        this._button.show();
        this._armPointerWatch();
        this._armAutohide(BTN_AUTOHIDE_MS);
    }

    _hideButton() {
        if (this._button)
            this._button.hide();
        this._cancelAutohide();
    }

    // ---------- 指针“按下沿”监听（无抓取，事件原生送达应用） ----------
    // 轮询指针按键状态：按下瞬间判断落点——
    //   落在按钮/卡片内：交给控件自身处理
    //   落在外部：隐藏按钮/关闭卡片；左键同时清除 PRIMARY 取消高亮
    // 点击本身应用照收（取消选区、移动光标、切换焦点均正常），
    // 键盘完全自由（Ctrl+C 可用）。
    _armPointerWatch() {
        if (this._pointerWatchId)
            return;
        // 以当前真实按键状态为基准，避免武装瞬间产生假的“按下沿”
        const [, , m] = global.get_pointer();
        this._pointerWasDown = (m & (Clutter.ModifierType.BUTTON1_MASK |
            Clutter.ModifierType.BUTTON2_MASK |
            Clutter.ModifierType.BUTTON3_MASK)) !== 0;
        this._pointerWatchId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, POINTER_WATCH_MS, () => {
                const hasOverlay =
                    (this._button && this._button.visible) || this._popup;
                if (this._destroyed || !hasOverlay) {
                    this._pointerWatchId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                const [px, py, mods] = global.get_pointer();
                const down = (mods & (Clutter.ModifierType.BUTTON1_MASK |
                    Clutter.ModifierType.BUTTON2_MASK |
                    Clutter.ModifierType.BUTTON3_MASK)) !== 0;
                if (down && !this._pointerWasDown) {
                    this._pointerWasDown = true;
                    this._onPointerPress(px, py,
                        (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0);
                } else if (!down) {
                    this._pointerWasDown = false;
                }
                return GLib.SOURCE_CONTINUE;
            });
    }

    _cancelPointerWatch() {
        if (this._pointerWatchId) {
            GLib.source_remove(this._pointerWatchId);
            this._pointerWatchId = 0;
        }
    }

    _onPointerPress(x, y, isLeft) {
        if (this._button && this._button.visible) {
            const b = this._button.get_allocation_box();
            if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2)
                return;   // 落在按钮上：hover/clicked 会触发翻译
        }
        if (this._popup) {
            const p = this._popup.get_allocation_box();
            if (x >= p.x1 && x <= p.x2 && y >= p.y1 && y <= p.y2)
                return;   // 落在卡片上：卡片按钮自行处理
        }
        if (this._button && this._button.visible) {
            console.error('selection-translator: 按下在按钮外，隐藏按钮');
            this._hideButton();
        }
        if (this._popup) {
            console.error('selection-translator: 按下在卡片外，关闭卡片');
            this._closePopup();
        }
        // 仅左键清除选区高亮：右键要保留下文菜单的“复制”，
        // 中键粘贴依赖 PRIMARY，都不能动
        if (isLeft)
            this._clearPrimary();
    }

    _armAutohide(ms) {
        this._cancelAutohide();
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._hideId = 0;
            this._hideButton();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelAutohide() {
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
    }

    // ---------- 翻译 ----------
    _translate(text) {
        this._showPopup('翻译中…', '', null, text);
        this._runHelper(text, (err, stdout) => {
            if (this._destroyed)
                return;
            if (err) {
                this._showPopup('翻译失败', String(err), null, text);
                return;
            }
            let data;
            try {
                data = JSON.parse(stdout);
            } catch (e) {
                this._showPopup('翻译失败', '结果解析出错', null, text);
                return;
            }
            if (data.kind === 'error') {
                this._showPopup('翻译失败', data.message || '未知错误',
                    null, text);
            } else {
                this._showPopup(null, null, data, text);
            }
        });
    }

    _runHelper(text, cb) {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['python3', HELPER, text],
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            cb(e, null);
            return;
        }
        const watchdog = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 20000, () => {
                try {
                    proc.force_exit();
                } catch (e) { /* 忽略 */ }
                cb(new Error('翻译超时'), null);
                return GLib.SOURCE_REMOVE;
            });
        proc.communicate_utf8_async(null, null, (p, res) => {
            GLib.source_remove(watchdog);
            try {
                const [, stdout, ] = p.communicate_utf8_finish(res);
                cb(null, stdout);
            } catch (e) {
                cb(e, null);
            }
        });
    }

    // ---------- 结果弹窗 ----------
    _showPopup(title, message, data, sourceText) {
        this._closePopup();

        const box = new St.BoxLayout({
            vertical: true, style_class: 'st-popup', reactive: true,
        });

        if (data && data.kind === 'word') {
            this._fillWord(box, data);
        } else if (data && data.kind === 'sentence') {
            this._fillSentence(box, data);
        } else {
            // 加载中 / 错误提示
            box.add_child(this._label(title || '提示', 'st-popup-word'));
            if (message)
                box.add_child(this._label(message, 'st-popup-line'));
        }

        // 底部按钮行
        const footer = new St.BoxLayout({style_class: 'st-popup-footer'});
        footer.add_style_pseudo_class('footer');
        const copyBtn = new St.Button({
            style_class: 'st-popup-btn', label: '复制结果', reactive: true,
        });
        copyBtn.connect('clicked', () => {
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, this._copyText(data, sourceText));
            copyBtn.label = '已复制 ✓';
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                if (copyBtn && !copyBtn.is_finalized())
                    copyBtn.label = '复制结果';
                return GLib.SOURCE_REMOVE;
            });
        });
        const closeBtn = new St.Button({
            style_class: 'st-popup-btn', label: '关闭', reactive: true,
        });
        closeBtn.connect('clicked', () => this._closePopup());
        footer.add_child(copyBtn);
        footer.add_child(closeBtn);
        box.add_child(footer);

        Main.layoutManager.uiGroup.add_child(box);

        // 定位：跟随鼠标，避免超出屏幕
        const [px, py] = global.get_pointer();
        const monitor = Main.layoutManager.currentMonitor;
        let x = px + 14, y = py + 18;
        const [, natW] = box.get_preferred_width(-1);
        const [, natH] = box.get_preferred_height(-1);
        if (x + natW > monitor.x + monitor.width)
            x = monitor.x + monitor.width - natW - 8;
        if (y + natH > monitor.y + monitor.height)
            y = Math.max(monitor.y + 8, py - natH - 12);
        box.set_position(Math.max(monitor.x + 8, x), y);

        this._popup = box;
        this._popupTime = GLib.get_monotonic_time();
        this._popupSource = (sourceText || '').replace(/\s+/g, ' ').trim();
        console.error('selection-translator: 卡片打开, source=' +
            this._popupSource.slice(0, 40));

        // 不做模态抓取（抓取会吞掉键盘，Ctrl+C 等被卡死）。
        // “点击卡片外”由指针按下沿轮询检测，事件原生送达应用。
        this._armPointerWatch();

        // 轮询选区：用户点击其他位置后选区被清空/改变 -> 关闭卡片
        this._stopPoll();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            if (this._destroyed || !this._popup) {
                this._pollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            St.Clipboard.get_default().get_text(
                St.ClipboardType.PRIMARY, (clipboard, text) => {
                    if (this._destroyed || !this._popup)
                        return;
                    text = (text || '').replace(/\s+/g, ' ').trim();
                    if (!text || text !== this._popupSource) {
                        console.error('selection-translator: 选区已清空或改变，关闭卡片');
                        this._closePopup();
                    }
                });
            return GLib.SOURCE_CONTINUE;
        });

        // 结果弹窗 20 秒无操作自动关闭
        this._popupTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 20000, () => {
                this._popupTimeout = 0;
                this._closePopup();
                return GLib.SOURCE_REMOVE;
            });
    }

    _fillWord(box, d) {
        // 标题行：单词 + 音标
        const head = new St.BoxLayout();
        const wordText = d.lemma && d.lemma !== d.query.toLowerCase()
            ? `${d.query} → ${d.word}` : d.word;
        head.add_child(this._label(wordText, 'st-popup-word'));
        if (d.phonetic) {
            const ph = this._label(`  /${d.phonetic}/`, 'st-popup-phonetic');
            ph.set_y_align(Clutter.ActorAlign.END);
            ph.set_y_expand(true);
            head.add_child(ph);
        }
        box.add_child(head);

        // 标签行：柯林斯星级 / 考试标签
        const meta = [];
        if (d.collins > 0)
            meta.push('柯林斯 ' + '★'.repeat(Math.min(d.collins, 5)));
        if (d.tag)
            meta.push(d.tag);
        if (d.online)
            meta.push('在线');
        if (meta.length)
            box.add_child(this._label(meta.join(' · '), 'st-popup-dim'));

        box.add_child(this._sep());

        // 中文释义
        const scroll = new St.ScrollView({
            style_class: 'st-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const inner = new St.BoxLayout({vertical: true});
        for (const line of d.translation || [])
            inner.add_child(this._label(line, 'st-popup-line'));
        if ((d.exchange || []).length)
            inner.add_child(this._label('词形: ' + d.exchange.join('  '),
                'st-popup-dim'));
        if ((d.definition || []).length) {
            inner.add_child(this._sep());
            inner.add_child(this._label('英英释义:', 'st-popup-dim'));
            for (const line of d.definition.slice(0, 5))
                inner.add_child(this._label(line, 'st-popup-dim'));
        }
        scroll.set_child(inner);
        box.add_child(scroll);
    }

    _fillSentence(box, d) {
        box.add_child(this._label(d.source, 'st-popup-src'));
        box.add_child(this._sep());
        const scroll = new St.ScrollView({
            style_class: 'st-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const inner = new St.BoxLayout({vertical: true});
        inner.add_child(this._label(d.translation, 'st-popup-line'));
        scroll.set_child(inner);
        box.add_child(scroll);
        const engine = {youdao: '有道', mymemory: 'MyMemory'}[d.engine] ||
            d.engine || '';
        box.add_child(this._label('引擎: ' + engine, 'st-popup-dim'));
    }

    _copyText(data, sourceText) {
        if (!data)
            return sourceText || '';
        if (data.kind === 'word') {
            let s = data.word;
            if (data.phonetic)
                s += ` /${data.phonetic}/`;
            s += '\n' + (data.translation || []).join('\n');
            return s;
        }
        if (data.kind === 'sentence')
            return data.translation;
        return sourceText || '';
    }

    _label(text, style) {
        const l = new St.Label({text: text || '', style_class: style});
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return l;
    }

    _sep() {
        return new St.Widget({style_class: 'st-popup-sep', x_expand: true});
    }

    _stopPoll() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    // 取消应用内的文本高亮：由 shell 以空内容接管 PRIMARY 选区，
    // 原所有者收到“选区被夺走”的通知后会自行移除高亮
    //（GTK/Qt/浏览器/终端均遵守该机制）。
    // 注意：不影响 CLIPBOARD（Ctrl+C 的内容还在）。
    _clearPrimary() {
        try {
            const sel = global.display.get_selection();
            if (sel.unset_owner) {
                // 最贴近原生“取消选中”：PRIMARY 变无所有者
                sel.unset_owner(Meta.SelectionType.SELECTION_PRIMARY);
                console.error('selection-translator: 已撤销 PRIMARY 所有者，取消高亮');
            } else {
                // 兜底：以空格内容接管 PRIMARY（空字符串会被忽略，不转移所有权）
                St.Clipboard.get_default().set_text(
                    St.ClipboardType.PRIMARY, ' ');
                console.error('selection-translator: 已接管 PRIMARY(空格)，取消高亮');
            }
        } catch (e) {
            console.error('selection-translator: 清除 PRIMARY 选区失败', e);
        }
    }

    _closePopup() {
        this._stopPoll();
        this._popupSource = null;
        this._popupTime = 0;
        if (this._popupTimeout) {
            GLib.source_remove(this._popupTimeout);
            this._popupTimeout = 0;
        }
        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }
    }
}

export default class extends Extension {
    enable() {
        // 启动器手动启动标记：存在则视为手动启动并消费掉
        let manualStart = false;
        const flag = GLib.build_filenamev(
            [GLib.get_user_cache_dir(), 'selection-translator',
             'manual-start']);
        try {
            if (GLib.file_test(flag, GLib.FileTest.EXISTS)) {
                manualStart = true;
                GLib.unlink(flag);
            }
        } catch (e) { /* 忽略 */ }
        this._impl = new SelectionTranslator(this.uuid, manualStart);
        this._impl.start();
    }

    disable() {
        if (this._impl) {
            this._impl.stop();
            this._impl = null;
        }
    }
}
