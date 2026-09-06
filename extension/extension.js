import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';

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
const DEBOUNCE_MS = 250;
const MAX_TEXT_LEN = 1500;


class SelectionTranslator {
    constructor() {
        this._config = {enabled: true, autoPopup: false};
        this._button = null;
        this._popup = null;
        this._popupTime = 0;
        this._grab = null;
        this._overviewId = 0;
        this._popupSource = null;   // 卡片对应的原文（用于检测选区变化）
        this._pollId = 0;
        this._indicator = null;
        this._selId = 0;
        this._debounceId = 0;
        this._hideId = 0;
        this._currentText = null;
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
                    {enabled: true, autoPopup: false}, cfg);
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
        console.error('selection-translator: 扩展已启动');

        // 监听系统 PRIMARY 选区（即鼠标划选）
        this._selection = global.display.get_selection();
        this._selId = this._selection.connect('owner-changed',
            (sel, selType, source) => {
                console.error('selection-translator: owner-changed selType=' +
                    selType);
                if (selType !== Meta.SelectionType.SELECTION_PRIMARY)
                    return;
                this._scheduleCheck();
            });

        // 焦点窗口变化（点击其他窗口）时关闭结果卡片
        this._focusId = global.display.connect('notify::focus-window',
            () => {
                this._closePopup();
            });

        // 打开概览时关闭卡片（避免抓取冲突）
        this._overviewId = Main.overview.connect('showing',
            () => this._closePopup());

        // 悬浮“译”按钮
        this._button = new St.Button({
            style_class: 'st-btn', label: '译',
            visible: false, reactive: true, can_focus: false,
        });
        Main.layoutManager.uiGroup.add_child(this._button);
        this._button.connect('clicked', () => {
            const text = this._currentText;
            this._hideButton();
            if (text)
                this._translate(text);
        });
        this._button.connect('notify::hover', () => {
            if (this._button.hover) {
                this._cancelAutohide();
            } else {
                this._armAutohide(1500);
            }
        });

        // 顶栏开关
        this._buildIndicator();
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, '划词翻译', false);
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

        Main.panel.addToStatusArea('selection-translator', this._indicator,
            1, 'right');
    }

    stop() {
        this._destroyed = true;
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
                console.error('selection-translator: get_text 回调, enabled=' +
                    this._config.enabled + ' autoPopup=' +
                    this._config.autoPopup + ' len=' +
                    (text ? text.length : 'null'));
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
    _showButton() {
        const [x, y] = global.get_pointer();
        const monitor = Main.layoutManager.currentMonitor;
        const bw = 56, bh = 34;
        let bx = x + 14, by = y + 18;
        bx = Math.max(monitor.x, Math.min(bx, monitor.x + monitor.width - bw));
        by = Math.max(monitor.y, Math.min(by, monitor.y + monitor.height - bh));
        this._button.set_position(bx, by);
        this._button.show();
        this._armAutohide(BTN_AUTOHIDE_MS);
    }

    _hideButton() {
        if (this._button)
            this._button.hide();
        this._cancelAutohide();
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

        // 模态抓取：让 shell 能捕获落在任意应用窗口内的点击/按键
        //（与 GNOME 弹出菜单同款机制，Wayland 下检测“点击卡片外部”的唯一
        //  可靠途径）。注意：pushModal 返回 Grab 对象，popModal 必须传它。
        this._grab = null;
        try {
            this._grab = Main.pushModal(this._popup,
                {actionMode: Shell.ActionMode.POPUP});
        } catch (e) {
            this._grab = null;
        }
        console.error('selection-translator: 模态抓取=' + !!this._grab);

        // 事件捕获必须挂在被抓取的 actor 自己身上（GNOME 菜单同款写法），
        // 用 get_event_actor 判断事件真实目标
        this._popup.connect('captured-event', (actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.KEY_PRESS) {
                const sym = event.get_key_symbol();
                // Super 键放行（用户可能想开概览）
                this._closePopup();
                if (sym === Clutter.KEY_Super_L ||
                    sym === Clutter.KEY_Super_R)
                    return Clutter.EVENT_PROPAGATE;
                console.error('selection-translator: 按键，关闭卡片');
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_PRESS ||
                type === Clutter.EventType.TOUCH_BEGIN) {
                const target = global.stage.get_event_actor(event);
                // 点击悬浮“译”按钮 -> 直接翻译新选区（不让抓取吃掉）
                if (target && this._button && this._button.visible &&
                    (target === this._button ||
                     this._button.contains(target))) {
                    const text = this._currentText;
                    this._closePopup();
                    this._hideButton();
                    if (text)
                        this._translate(text);
                    return Clutter.EVENT_STOP;
                }
                if (!target || !this._popup.contains(target)) {
                    console.error(
                        'selection-translator: 点击卡片外部，关闭卡片');
                    this._closePopup();
                }
                return Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.SCROLL) {
                // 卡片外滚动 = 用户已继续阅读 -> 关闭；卡片内滚动放行
                const target = global.stage.get_event_actor(event);
                if (!target || !this._popup.contains(target)) {
                    this._closePopup();
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

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

        // 结果弹窗 20 秒无操作自动关闭（抓取会接管键盘，不宜过长）
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

    _closePopup() {
        this._stopPoll();
        this._popupSource = null;
        this._popupTime = 0;
        if (this._grab) {
            try {
                Main.popModal(this._grab);
            } catch (e) { /* 抓取可能已被系统解除 */ }
            this._grab = null;
        }
        if (this._popupTimeout) {
            GLib.source_remove(this._popupTimeout);
            this._popupTimeout = 0;
        }
        // captured-event 挂在 popup 上，随 popup 销毁自动失效
        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }
    }
}

export default class extends Extension {
    enable() {
        this._impl = new SelectionTranslator();
        this._impl.start();
    }

    disable() {
        if (this._impl) {
            this._impl.stop();
            this._impl = null;
        }
    }
}
