// Settings persistence + panel UI.
// Stored under extension_settings['pretext-render']; every toggle maps to a
// module enable/disable plus an <html> class so style.css can react too.

import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

export const EXT_KEY = 'pretext-render';

export const DEFAULT_SETTINGS = {
    inputAutosize: true,       // textarea auto height via pretext layout()
    streamStabilize: true,     // reserve height during streaming, batched scroll
    bubbleShrinkwrap: false,   // opt-in: fit bubble width to widest line
    virtualScroll: true,       // content-visibility virtualization for long chats
    virtualOverscan: 3,        // screens beyond viewport kept fully rendered
    movingPanels: false,       // enhanced MovingUI: drag any panel
};

export function loadSettings() {
    const stored = extension_settings[EXT_KEY] ?? {};
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    extension_settings[EXT_KEY] = settings;
    return settings;
}

export function saveSettings() {
    saveSettingsDebounced();
}

const FEATURES = [
    {
        key: 'inputAutosize',
        label: '输入框自动高度',
        hint: '用 pretext 纯算术计算输入框高度，替代 scrollHeight 读取，消除 reflow',
    },
    {
        key: 'streamStabilize',
        label: '流式输出防跳动',
        hint: '流式期间预算文本高度并预留空间，滚动更新合帧，消除页面抖动',
    },
    {
        key: 'bubbleShrinkwrap',
        label: '气泡宽度收缩',
        hint: '气泡宽度贴合文本最宽行（实验性：含代码块/图片的消息自动跳过）',
    },
    {
        key: 'virtualScroll',
        label: '长聊天虚拟滚动',
        hint: '视口外消息跳过渲染（content-visibility），高度由 pretext 估算',
    },
    {
        key: 'movingPanels',
        label: '子窗口自由移动',
        hint: '增强 MovingUI：主聊天窗口之外的子面板也可拖动并记住位置',
    },
];

/**
 * Build the settings panel and wire toggles to module lifecycle.
 * modules: { [featureKey]: { enable(), disable() } }
 */
export function buildSettingsPanel(settings, modules) {
    const rows = FEATURES.map(f => `
        <div class="ptr-setting-row">
            <label class="checkbox_label" for="ptr-${f.key}">
                <input type="checkbox" id="ptr-${f.key}" ${settings[f.key] ? 'checked' : ''} />
                <span>${f.label}</span>
            </label>
            <small class="ptr-hint">${f.hint}</small>
        </div>`).join('');

    const html = `
        <div class="pretext-render-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Pretext 渲染增强</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    ${rows}
                    <div class="ptr-setting-row" data-ptr-extra="virtualScroll">
                        <label for="ptr-virtualOverscan">预渲染屏数</label>
                        <input type="number" id="ptr-virtualOverscan" class="text_pole"
                               min="1" max="10" step="1" value="${settings.virtualOverscan}" />
                        <small class="ptr-hint">视口外保留完整渲染的屏幕高度倍数，越大滚动越顺滑、内存越高</small>
                    </div>
                    <hr class="sysHR" />
                    <small class="ptr-hint">
                        基于 <a href="https://github.com/chenglou/pretext" target="_blank" rel="noopener">@chenglou/pretext</a>
                        — 无 DOM reflow 的文本测量。
                    </small>
                </div>
            </div>
        </div>`;

    $('#extensions_settings2').append(html);

    for (const f of FEATURES) {
        $(`#ptr-${f.key}`).on('change', function () {
            settings[f.key] = this.checked;
            saveSettings();
            const mod = modules[f.key];
            if (!mod) return;
            if (this.checked) mod.enable(); else mod.disable();
            updateExtraVisibility();
        });
    }

    $('#ptr-virtualOverscan').on('change', function () {
        const n = Math.max(1, Math.min(10, parseInt(this.value, 10) || 3));
        this.value = String(n);
        settings.virtualOverscan = n;
        saveSettings();
        modules.virtualScroll?.refresh?.();
    });

    function updateExtraVisibility() {
        $('[data-ptr-extra="virtualScroll"]').toggle(!!settings.virtualScroll);
    }
    updateExtraVisibility();
}
