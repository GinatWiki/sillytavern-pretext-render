// Moving panels — extend ST's native MovingUI to arbitrary sub-panels.
//
// Native MovingUI (RossAscends-mods.js dragElement) only wires 7 hardcoded
// ids. This module adds a picker: click any floating panel (including ones
// created by OTHER extensions) to make it draggable + resizable. We reuse the
// native dragElement, so positions/sizes persist into power_user.movingUIState
// and ST restores them on load via loadMovingUIState() — our own persistence
// is only needed to remember WHICH panels were picked.

import { saveSettingsDebounced } from '../../../../../script.js';
import { dragElement } from '../../../../RossAscends-mods.js';
import { power_user } from '../../../../power-user.js';
import { saveSettings } from './settings.js';

// Already wired by ST's initMovingUI — don't double-register.
const NATIVE_IDS = new Set([
    'sheld', 'left-nav-panel', 'right-nav-panel',
    'WorldInfo', 'floatingPrompt', 'logprobsViewer', 'cfgConfig',
]);

let settings = null;
let enabled = false;
let pickerActive = false;
let domObserver = null;
let settingsRoot = null; // jQuery container for the extras UI

// settings.movingPanelsList: { [panelId]: { injectedHeader: boolean } }
function registry() {
    if (!settings.movingPanelsList) settings.movingPanelsList = {};
    return settings.movingPanelsList;
}

// --- Panel wiring -----------------------------------------------------------

function isCandidate(el) {
    if (!el || !el.id || !(el instanceof HTMLElement)) return false;
    if (NATIVE_IDS.has(el.id)) return false;
    if (el.closest('.pretext-render-settings')) return false;
    if (el.classList.contains('ptr-drag-handle')) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width >= 120 && r.height >= 80;
}

function ensureMovingUiOn() {
    if (power_user.movingUI === true) return;
    power_user.movingUI = true;
    $('body').toggleClass('movingUI', true);
    saveSettingsDebounced();
    console.log('[pretext-render] moving-panels: enabled ST MovingUI');
}

function ensureDragHandle(el) {
    const headerId = `${el.id}header`;
    let header = document.getElementById(headerId);
    if (header) return false; // panel already has a native-style header
    header = document.createElement('div');
    header.id = headerId;
    // dragElement only starts a drag when the mousedown target itself
    // carries .drag-grabber — make the whole handle the grabber.
    header.className = 'ptr-drag-handle drag-grabber';
    header.textContent = '⠿';
    el.prepend(header);
    return true;
}

function wirePanel(el) {
    if (!el || el.dataset.ptrWired) return;
    ensureMovingUiOn();

    const injectedHeader = ensureDragHandle(el);
    el.classList.add('ptr-movable');

    // CSS resize needs non-visible overflow.
    const cs = getComputedStyle(el);
    if (cs.overflow === 'visible') {
        el.dataset.ptrOverflowFix = el.style.overflow ?? '';
        el.style.overflow = 'auto';
    }

    dragElement($(el));

    // Re-apply a previously saved position (ST's restore ran before this
    // panel existed in the DOM).
    const saved = power_user.movingUIState?.[el.id];
    if (saved) $(el).css(saved);

    el.dataset.ptrWired = '1';
    // Preserve a previous injectedHeader record so we still remove OUR handle
    // on unwire even if the panel now reports a header.
    const prev = registry()[el.id];
    registry()[el.id] = { injectedHeader: prev?.injectedHeader || injectedHeader };
    saveSettings();
}

function unwirePanel(el, { keepState = true, keepRegistry = false } = {}) {
    if (!el) return;
    const entry = registry()[el.id];
    if (entry?.injectedHeader) {
        document.getElementById(`${el.id}header`)?.remove();
        entry.injectedHeader = false;
    }
    el.classList.remove('ptr-movable');
    if (el.dataset.ptrOverflowFix !== undefined) {
        el.style.overflow = el.dataset.ptrOverflowFix;
        delete el.dataset.ptrOverflowFix;
    }
    delete el.dataset.ptrWired;
    if (!keepRegistry) delete registry()[el.id];
    if (!keepState && power_user.movingUIState) {
        delete power_user.movingUIState[el.id];
        saveSettingsDebounced();
    }
    saveSettings();
    // Note: native dragElement's own listeners stay attached but are inert
    // without a drag-grabber header / CSS resize.
}

// --- Picker mode (F12-style: hover -> click -> confirm) ----------------------

let hoverEl = null;
let confirmBar = null;
let pendingEl = null;
let pickerBar = null;
// [element, openClass] pairs we temporarily closed on picker entry.
let closedForPick = [];

// ST drawers cover most of the screen; picking behind them is impossible.
// Close every open drawer on entry, restore on exit.
function closeObscuringDrawers() {
    closedForPick = [];
    for (const el of document.querySelectorAll('.drawer-content.openDrawer')) {
        el.classList.remove('openDrawer');
        el.classList.add('closedDrawer');
        closedForPick.push([el, 'openDrawer']);
        const icon = el.closest('.drawer')?.querySelector('.drawer-icon.openIcon');
        if (icon) {
            icon.classList.remove('openIcon');
            icon.classList.add('closedIcon');
            closedForPick.push([icon, 'openIcon']);
        }
    }
}

function restoreDrawers() {
    for (const [el, openClass] of closedForPick) {
        el.classList.remove(openClass === 'openDrawer' ? 'closedDrawer' : 'closedIcon');
        el.classList.add(openClass);
    }
    closedForPick = [];
}

function showPickerBar() {
    hidePickerBar();
    pickerBar = document.createElement('div');
    pickerBar.className = 'ptr-pick-ui ptr-picker-bar';
    pickerBar.innerHTML = `
        <span>拾取模式：点击浮动面板选中（可连续选多个）</span>
        <button class="menu_button" data-act="done">完成 (Esc)</button>`;
    document.body.appendChild(pickerBar);
    pickerBar.querySelector('[data-act="done"]').addEventListener('click', exitPicker);
}

function hidePickerBar() {
    pickerBar?.remove();
    pickerBar = null;
}

function showConfirmBar(el) {
    hideConfirmBar();
    pendingEl = el;
    el.classList.add('ptr-pick-pending');
    confirmBar = document.createElement('div');
    confirmBar.className = 'ptr-pick-ui ptr-confirm-bar';
    confirmBar.innerHTML = `
        <span>已选中 <b>#${el.id}</b>，使其可自由移动？</span>
        <button class="menu_button" data-act="ok">确认</button>
        <button class="menu_button" data-act="cancel">取消</button>`;
    document.body.appendChild(confirmBar);
    confirmBar.querySelector('[data-act="ok"]').addEventListener('click', () => {
        const target = pendingEl;
        hideConfirmBar();
        wirePanel(target);
        renderExtras();
        // Stay in picker mode so several panels can be picked in one session.
        toastr.success(`#${target.id} 已可拖动 / 调整大小`, 'Pretext 渲染增强');
    });
    confirmBar.querySelector('[data-act="cancel"]').addEventListener('click', hideConfirmBar);
}

function hideConfirmBar() {
    pendingEl?.classList.remove('ptr-pick-pending');
    pendingEl = null;
    confirmBar?.remove();
    confirmBar = null;
}

function onPickerOver(e) {
    if (e.target.closest?.('.ptr-pick-ui')) return; // don't pick our own UI
    const el = e.target.closest?.('div,section,aside,form');
    if (hoverEl === el) return;
    hoverEl?.classList.remove('ptr-pick-candidate');
    hoverEl = isCandidate(el) ? el : null;
    hoverEl?.classList.add('ptr-pick-candidate');
}

function onPickerClick(e) {
    if (e.target.closest?.('.ptr-pick-ui')) return; // confirm bar handles itself
    e.preventDefault();
    e.stopPropagation();
    const el = hoverEl;
    if (!el) {
        toastr.warning('该元素不可拾取：需要是有 id 的浮动面板（fixed/absolute 定位）', 'Pretext 渲染增强');
        return;
    }
    hoverEl.classList.remove('ptr-pick-candidate');
    hoverEl = null;
    showConfirmBar(el);
}

function onPickerKey(e) {
    if (e.key === 'Escape') exitPicker();
}

function enterPicker() {
    if (pickerActive) return;
    pickerActive = true;
    closeObscuringDrawers();
    document.addEventListener('mouseover', onPickerOver, true);
    document.addEventListener('click', onPickerClick, true);
    document.addEventListener('keydown', onPickerKey, true);
    document.body.classList.add('ptr-picker-active');
    showPickerBar();
    renderExtras();
}

function exitPicker() {
    if (!pickerActive) return;
    pickerActive = false;
    document.removeEventListener('mouseover', onPickerOver, true);
    document.removeEventListener('click', onPickerClick, true);
    document.removeEventListener('keydown', onPickerKey, true);
    document.body.classList.remove('ptr-picker-active');
    hoverEl?.classList.remove('ptr-pick-candidate');
    hoverEl = null;
    hideConfirmBar();
    hidePickerBar();
    restoreDrawers();
    renderExtras();
}

// --- DOM watcher: wire picked panels that (re)appear later -------------------

function scanAdded(nodes) {
    const reg = registry();
    for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.id && reg[node.id]) wirePanel(node);
        for (const id of Object.keys(reg)) {
            const inner = node.querySelector?.(`#${CSS.escape(id)}`);
            if (inner) wirePanel(inner);
        }
    }
}

function startObserver() {
    domObserver = new MutationObserver(muts => {
        const added = muts.flatMap(m => [...m.addedNodes]);
        if (added.length) scanAdded(added);
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
}

// --- Settings extras UI -------------------------------------------------------

function renderExtras() {
    if (!settingsRoot) return;
    const reg = registry();
    const ids = Object.keys(reg);
    const list = ids.length
        ? ids.map(id => `
            <div class="ptr-panel-item">
                <span title="${id}">#${id}</span>
                <span class="ptr-panel-remove fa-solid fa-xmark" data-ptr-remove="${id}" title="移除"></span>
            </div>`).join('')
        : '<small class="ptr-hint">尚未选择任何子窗口</small>';

    settingsRoot.html(`
        <div class="ptr-setting-row">
            <div class="menu_button" id="ptr-picker-toggle">
                ${pickerActive ? '取消拾取 (Esc)' : '拾取子窗口…'}
            </div>
            <small class="ptr-hint">用法：① 点上方按钮进入拾取模式 ② 像 F12 选元素一样点击页面上的浮动面板（含其他扩展添加的）③ 确认后即可拖动 / 拖右下角调宽高，位置尺寸自动记忆</small>
        </div>
        <div class="ptr-panel-list">${list}</div>
    `);

    settingsRoot.find('#ptr-picker-toggle').on('click', () => {
        pickerActive ? exitPicker() : enterPicker();
    });
    settingsRoot.find('[data-ptr-remove]').on('click', function () {
        const id = $(this).data('ptr-remove');
        unwirePanel(document.getElementById(id), { keepState: false });
        renderExtras();
    });
}

/** Called by index.js after the settings panel exists. */
export function buildSettingsExtras() {
    settingsRoot = $('[data-ptr-extra="movingPanels"]');
    if (settingsRoot.length) renderExtras();
}

// --- Module lifecycle -----------------------------------------------------------

export function init(s) {
    settings = s;
}

export function enable() {
    if (enabled) return;
    enabled = true;
    const reg = registry();
    for (const id of Object.keys(reg)) {
        const el = document.getElementById(id);
        if (el) wirePanel(el);
    }
    startObserver();
}

export function disable() {
    if (!enabled) return;
    enabled = false;
    exitPicker();
    domObserver?.disconnect();
    domObserver = null;
    for (const id of Object.keys(registry())) {
        unwirePanel(document.getElementById(id), { keepState: true, keepRegistry: true });
    }
}
