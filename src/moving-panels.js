// Moving panels — extend ST's native MovingUI to arbitrary sub-panels.
//
// Native MovingUI (RossAscends-mods.js dragElement) only wires 7 hardcoded
// ids and depends on ST's MovingUI toggle. This module is FULLY INDEPENDENT:
// it uses its own drag implementation and persists positions to its own
// registry ? no ST MovingUI toggle, no movingUIState, no resetMovablePanels
// interference. The two systems coexist without touching each other.
//
// On top of plain dragging this module provides:
// - an in-panel grip tab (top/bottom switchable, keeps clear of the
//   bottom-right resize corner; the whole bar drags, not just the ⠿ glyph)
// - attachment: popups opened from a moved panel are wrapped in a SHELL that
//   is edge-anchored to the panel (per-panel 左右 toggle: left/right/off,
//   上下 toggle: top/bottom/off). Anchored by the matching edge (上 → bottom
//   anchor, 右 → right anchor), shells hug their content and re-glue
//   themselves on any reflow or content swap — extension re-anchors of the
//   popup are inert inside the shell. User drags of the popup's own drag
//   logic are mirrored onto the shell and remembered (per popup id, across
//   sessions); optional width follow per panel
// - native-reset recovery: ST's MovingUI reset no longer makes floated
//   panels vanish; they return to the document flow and re-float on next drag

import { saveSettings } from './settings.js';

// Already wired by ST's initMovingUI — don't double-register.
const NATIVE_IDS = new Set([
    'sheld', 'left-nav-panel', 'right-nav-panel',
    'WorldInfo', 'floatingPrompt', 'logprobsViewer', 'cfgConfig',
]);

// Core ST layout elements that must never be floated.
const BLOCKED_IDS = new Set([
    'chat', 'top-nav', 'top-settings-holder', 'form_sheld', 'send_form',
]);

// Tags treated as "panel containers" when walking up from the click target.
const CONTAINER_TAGS = new Set([
    'DIV', 'SECTION', 'ASIDE', 'NAV', 'FORM', 'HEADER', 'FOOTER', 'MAIN',
    'FIELDSET', 'TABLE', 'UL',
]);

// Max distance (px) between a popup's top-left and a panel's original or
// current top-left for the popup to attach to that panel (only used when
// there is no recent interaction with a panel — see interactiveOwner).
const ATTACH_DISTANCE = 260;

// Height of the grip bar. The panel gets this much extra padding on the
// handle side, so the bar overlays only padding — never content.
const HANDLE_H = 16;

// A popup appearing within this window after a pointerdown inside a panel is
// attributed to that panel directly, regardless of where it opens.
const INTERACT_WINDOW = 1500;

// Global floating UI that must never be treated as a panel's popup.
const NEVER_ATTACH_IDS = new Set(['toast-container', 'top-bar']);

let lastInteraction = { id: null, t: 0 };

// Timestamp of our last style write per popup. While we are translating a
// popup during a panel drag (writes every frame), the style-attribute
// observer must not mistake those writes for a USER drag and "adopt" them.
const selfWriteAt = new Map();
function markSelfWrite(el) { selfWriteAt.set(el, performance.now()); }
function isSelfWrite(el) { return performance.now() - (selfWriteAt.get(el) ?? -1e9) < 60; }

// Direct-manipulation tracker for attached popups/shells. A popup position
// write only counts as a user drag when the pointer is down on that popup (or
// was released <300ms ago); a shell resize likewise. Extensions re-anchor
// reused popups at their spawn coordinates when swapping content ("顶掉") —
// those programmatic jumps must never become "user placements".
let popupPtr = { el: null, until: 0 };
function onPopupPtrDown(e) {
    for (const [id, state] of panelStates) {
        for (const [pop, att] of state.attachments) {
            if (att.shell === e.target) {
                // Pointer on the shell itself: the resize corner.
                popupPtr = { el: att.shell, until: Infinity };
                prepShellResize(att, e);
                return;
            }
            if (pop === e.target || pop.contains(e.target)) {
                popupPtr = { el: pop, until: Infinity };
                // Cascaded popups (opened FROM inside an attached popup)
                // inherit the owner panel's interaction credit; otherwise a
                // popup opening beside its parent - far from the panel -
                // finds no owner and stays at its spawn position.
                lastInteraction = { id, t: Date.now() };
                setTimeout(scanForPopups, 150);
                setTimeout(scanForPopups, 500);
                setTimeout(scanForPopups, 1200);
                return;
            }
        }
    }
}
function onPopupPtrUp() {
    if (popupPtr.el) popupPtr.until = performance.now() + 300;
    endShellResize();
}
function isUserManipulating(el) {
    return popupPtr.el === el && performance.now() < popupPtr.until;
}

let settings = null;
let enabled = false;
let pickerActive = false;
let domObserver = null;
let settingsRoot = null; // jQuery container for the extras UI

// Runtime per-panel state (not persisted):
// id -> {
//   origLeft, origTop,        // where the panel was when wired / last re-anchored
//   lastLeft, lastTop,        // for per-mutation drag deltas
//   followPopup, followW, followH, handleSide,
//   popupAlign, popupSide,  // 'left'|'right'|'off', 'top'|'bottom'|'off'
//   needsRefloat,             // set by native reset; next grip mousedown re-floats
//   attachments: Map<popupEl, { shell, offX, offY, width, height,
//                               snapX, snapY, wasHidden, ro }>,
//   styleObserver, resizeObserver, handle, onPointerDown, onPointerUp, onScroll,
// }
const panelStates = new Map();

// settings.movingPanelsList: { [panelId]: { injectedHeader, followPopup,
//   followW, followH, handleSide, popupAlign ('left'|'right'|'off'),
//   popupSide ('top'|'bottom'|'off'),
//   popups: { [popupId]: { offX, offY, width, height, snapX, snapY } } } }
function registry() {
    if (!settings.movingPanelsList) settings.movingPanelsList = {};
    return settings.movingPanelsList;
}

// --- Candidate resolution (picker) -------------------------------------------

/** Basic pickability: has an id, visible, sane size, not ST chrome/our UI. */
function passesBasic(el) {
    if (!el || !el.id || !(el instanceof HTMLElement)) return false;
    if (BLOCKED_IDS.has(el.id)) return false;
    if (el.closest('.pretext-render-settings, .ptr-pick-ui')) return false;
    if (el.classList.contains('ptr-drag-handle')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 16) return false;
    // Skip near-fullscreen roots — those are page scaffolding, not panels.
    if (r.width * r.height > window.innerWidth * window.innerHeight * 0.95) return false;
    return true;
}

/**
 * F12-style: walk up from the hover target; prefer the deepest CONTAINER
 * with an id, remember the first id-bearing element of any tag as fallback.
 */
function findCandidate(target) {
    let fallback = null;
    for (let el = target; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        if (!passesBasic(el)) continue;
        if (!fallback) fallback = el;
        if (CONTAINER_TAGS.has(el.tagName)) return el;
    }
    return fallback;
}

/** Nearest pickable ancestor (for the confirm bar's "parent" button). */
function parentCandidateOf(el) {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (passesBasic(p)) return p;
    }
    return null;
}

// --- Drag handle (in-panel tab, top/bottom switchable) ------------------------

function createHandle(panel, side) {
    const handle = document.createElement('div');
    handle.id = `${panel.id}header`;
    // dragElement only starts a drag when the mousedown target itself carries
    // .drag-grabber. The BAR carries it, so the whole strip drags — not just
    // the ⠿ glyph (buttons are safe: their e.target has no .drag-grabber).
    // Without this, the space-evenly gaps between buttons were dead zones,
    // and misses near the bottom-right fell into ST's 16px corner-resize
    // detection ("drag turns into resize").
    handle.className = 'ptr-pick-ui ptr-drag-handle drag-grabber';
    handle.title = '拖动此栏移动面板';
    handle.dataset.side = side;
    handle.innerHTML = `
        <span class="drag-grabber ptr-grip" title="拖动移动面板">⠿</span>
        <button type="button" class="ptr-follow" data-dim="p" title="从该面板打开的弹窗自动跟随面板">弹</button>
        <button type="button" class="ptr-follow" data-dim="w" title="附着弹窗跟随面板宽度">宽</button>
        <button type="button" class="ptr-follow" data-dim="x" title="弹窗横向：左对齐/右对齐/关闭，点击循环切换">左</button>
        <button type="button" class="ptr-follow" data-dim="y" title="弹窗纵向：上方/下方/关闭，点击循环切换">上</button>
        <button type="button" class="ptr-dock" title="取消悬浮，恢复原位置（再次拖动手柄可重新悬浮）">归</button>
        <button type="button" class="ptr-side" title="切换手柄位置：面板顶部 / 底部">⇅</button>`;
    // In-panel: the handle moves with the panel by construction, and absolute
    // positioning keeps it from disturbing the panel's own layout.
    panel.prepend(handle);

    // Keep panel-internal mousedown/click handlers (and our own resize-corner
    // detection) from seeing handle interactions; same-element listeners such
    // as dragElement's header binding still fire (stopPropagation ≠
    // stopImmediatePropagation).
    handle.addEventListener('mousedown', e => e.stopPropagation());
    handle.addEventListener('click', e => e.stopPropagation());

    for (const btn of handle.querySelectorAll('.ptr-follow')) {
        btn.addEventListener('click', () => toggleFollow(panel, btn.dataset.dim));
    }
    handle.querySelector('.ptr-dock').addEventListener('click', () => dockPanel(panel));
    handle.querySelector('.ptr-side').addEventListener('click', () => toggleSide(panel));
    return handle;
}

/** Keep the in-panel handle glued to the chosen inner edge. Absolute children
 *  scroll with panel content, so compensate by scrollTop; bottom mode also
 *  needs re-gluing on resize (ResizeObserver in wirePanel covers that). */
function glueHandle(panel) {
    const state = panelStates.get(panel.id);
    if (!state?.handle) return;
    const h = state.handle.offsetHeight || 16;
    if (state.handleSide === 'bottom') {
        state.handle.style.top = `${panel.scrollTop + panel.clientHeight - h}px`;
    } else {
        state.handle.style.top = `${panel.scrollTop}px`;
    }
}

function ensurePanelHandle(panel, state) {
    if (!state) return null;
    let handle = state.handle;
    if (!handle || !handle.isConnected) {
        const existing = document.getElementById(`${panel.id}header`);
        if (existing) {
            handle = existing;
        } else {
            handle = createHandle(panel, state.handleSide);
            bindRefloat(panel, handle);
            refreshFollowButtons(panel);
            setSidePadding(panel, state.handleSide);
        }
        state.handle = handle;
    }
    glueHandle(panel);
    return handle;
}

function toggleSide(panel) {
    const state = panelStates.get(panel.id);
    if (!state?.handle) return;
    state.handleSide = state.handleSide === 'top' ? 'bottom' : 'top';
    state.handle.dataset.side = state.handleSide;
    const entry = registry()[panel.id];
    if (entry) {
        entry.handleSide = state.handleSide;
        saveSettings();
    }
    setSidePadding(panel, state.handleSide);
    glueHandle(panel);
}

/** Give the panel HANDLE_H of extra padding on the handle side, so the
 *  full-width bar overlays only padding (browser-tab-bar effect). Original
 *  inline paddings are recorded once and restored on unwire. */
function setSidePadding(panel, side) {
    if (panel.dataset.ptrPadT === undefined) panel.dataset.ptrPadT = panel.style.paddingTop;
    if (panel.dataset.ptrPadB === undefined) panel.dataset.ptrPadB = panel.style.paddingBottom;
    panel.style.paddingTop = panel.dataset.ptrPadT;
    panel.style.paddingBottom = panel.dataset.ptrPadB;
    const cs = getComputedStyle(panel);
    if (side === 'bottom') {
        panel.style.paddingBottom = `${(parseFloat(cs.paddingBottom) || 0) + HANDLE_H}px`;
    } else {
        panel.style.paddingTop = `${(parseFloat(cs.paddingTop) || 0) + HANDLE_H}px`;
    }
}

function clearSidePadding(panel) {
    if (panel.dataset.ptrPadT !== undefined) {
        panel.style.paddingTop = panel.dataset.ptrPadT;
        delete panel.dataset.ptrPadT;
    }
    if (panel.dataset.ptrPadB !== undefined) {
        panel.style.paddingBottom = panel.dataset.ptrPadB;
        delete panel.dataset.ptrPadB;
    }
}

/** Undo floating: return the panel to its original (in-flow or stylesheet)
 *  position and forget the saved floating position. Next grip drag re-floats. */
function dockPanel(panel) {
    const state = panelStates.get(panel.id);
    if (!state) return;
    clearAttachments(state); // anchors are relative to the floated position
    if (panel.dataset.ptrOrigPos !== undefined) {
        unfloatPanel(panel);
        state.needsRefloat = true;
        // unfloatPanel only restores what floatPanel recorded; drop the rest.
        panel.style.right = '';
        panel.style.bottom = '';
        panel.style.height = '';
        ensureHandleAnchor(panel);
    } else {
        // Panel was already positioned before wiring: clearing inline geometry
        // hands it back to the stylesheet.
        for (const p of ['top', 'left', 'right', 'bottom', 'width', 'height', 'margin']) {
            panel.style[p] = '';
        }
    }
    const entry = registry()[panel.id];
    if (entry?.pos) { delete entry.pos; saveSettings(); }
    const r = panel.getBoundingClientRect();
    state.origLeft = state.lastLeft = r.left;
    state.origTop = state.lastTop = r.top;
    glueHandle(panel);
    toastr.info(`#${panel.id} 已恢复原位置；拖动 ⠿ 手柄可重新悬浮`, 'Pretext 渲染增强');
}

const ALIGN_LABEL = { left: '左对齐', right: '右对齐', off: '关闭（保持出现位置）' };
const SIDE_LABEL = { top: '面板上方', bottom: '面板下方', off: '关闭（保持出现位置）' };
const ALIGN_MARK = { left: '左', right: '右', off: '关' };
const SIDE_MARK = { top: '上', bottom: '下', off: '关' };

function refreshFollowButtons(panel) {
    const state = panelStates.get(panel.id);
    if (!state?.handle) return;
    state.handle.querySelector('[data-dim="p"]')?.classList.toggle('active', state.followPopup);
    state.handle.querySelector('[data-dim="w"]')?.classList.toggle('active', state.followW);
    // 左右/上下 are 3-state cycles; the button TEXT shows the current state
    // (绿 = 第一态, 橙 = 第二态, 灰 = 关).
    const xBtn = state.handle.querySelector('[data-dim="x"]');
    if (xBtn) {
        xBtn.textContent = ALIGN_MARK[state.popupAlign] ?? ALIGN_MARK.left;
        xBtn.classList.toggle('active', state.popupAlign === 'left');
        xBtn.classList.toggle('active-alt', state.popupAlign === 'right');
        xBtn.title = `弹窗横向：${ALIGN_LABEL[state.popupAlign] ?? ALIGN_LABEL.left}（点击循环：左→右→关）`;
    }
    const yBtn = state.handle.querySelector('[data-dim="y"]');
    if (yBtn) {
        yBtn.textContent = SIDE_MARK[state.popupSide] ?? SIDE_MARK.top;
        yBtn.classList.toggle('active', state.popupSide === 'top');
        yBtn.classList.toggle('active-alt', state.popupSide === 'bottom');
        yBtn.title = `弹窗纵向：${SIDE_LABEL[state.popupSide] ?? SIDE_LABEL.top}（点击循环：上→下→关）`;
    }
}

// --- Attachments (popups following their panel) --------------------------------

function toggleFollow(panel, dim) {
    if (dim === 'x') return toggleAlignX(panel);
    if (dim === 'y') return toggleSideY(panel);
    const state = panelStates.get(panel.id);
    if (!state) return;
    if (dim === 'p') {
        state.followPopup = !state.followPopup;
        if (!state.followPopup) clearAttachments(state); // stop following now
        else setTimeout(scanForPopups, 100);               // pick up open popups
    } else if (dim === 'w') state.followW = !state.followW;
    const entry = registry()[panel.id];
    if (entry) {
        entry.followPopup = state.followPopup;
        entry.followW = state.followW;
        saveSettings();
    }
    refreshFollowButtons(panel);
    relayoutPanel(panel, state);
}

let popupPersistTimer = null;
/** Persist an attachment's offset/size under its popup id (memory across
 *  sessions); popups without an id stay session-only. The entry update is
 *  in-memory and immediate; the save is debounced on the adoption path,
 *  which fires per frame while the user drags/resizes a popup. */
function persistPopup(panelId, pop, att, { debounce = false } = {}) {
    if (!pop.id) return;
    const entry = registry()[panelId];
    if (!entry) return;
    if (!entry.popups) entry.popups = {};
    entry.popups[pop.id] = {
        offX: att.offX, offY: att.offY, width: att.width, height: att.height,
        snapX: att.snapX ?? null, snapY: att.snapY ?? null,
    };
    if (!debounce) {
        saveSettings();
        return;
    }
    clearTimeout(popupPersistTimer);
    popupPersistTimer = setTimeout(saveSettings, 800);
}

/** Detach a single popup: un-shell it (hand it back to the document at the
 *  shell's current spot), stop observing and drop the follow link. */
function detachPopup(state, pop) {
    const att = state.attachments.get(pop);
    if (!att) return;
    att.ro?.disconnect();
    const sh = att.shell;
    if (pop.isConnected) {
        pop.classList.remove('ptr-shelled');
        if (sh?.isConnected) {
            const r = sh.getBoundingClientRect();
            sh.before(pop);
            pop.style.position = 'fixed';
            pop.style.left = `${r.left}px`;
            pop.style.top = `${r.top}px`;
            pop.style.right = 'auto';
            pop.style.bottom = 'auto';
        }
    }
    sh?.remove();
    state.attachments.delete(pop);
}

/** Detach all of a panel's popups (follow toggled off, dock, native reset). */
function clearAttachments(state) {
    for (const pop of [...state.attachments.keys()]) detachPopup(state, pop);
}

/** [左右] Cycle attached popups through 左对齐 → 右对齐 → 关闭（自由）.
 *  The chosen state is also the default for newly attached popups. */
const ALIGN_CYCLE = { left: 'right', right: 'off', off: 'left' };
function toggleAlignX(panel) {
    const state = panelStates.get(panel.id);
    if (!state) return;
    state.popupAlign = ALIGN_CYCLE[state.popupAlign] ?? 'left';
    const entry = registry()[panel.id];
    if (entry) {
        entry.popupAlign = state.popupAlign;
        saveSettings();
    }
    for (const [pop, att] of state.attachments) {
        att.snapX = state.popupAlign === 'off' ? null : state.popupAlign;
        if (!att.snapX) freezeOffset(panel, att, 'x'); // 关: stay where it is
        layoutShell(panel, att);
        persistPopup(panel.id, pop, att);
    }
    refreshFollowButtons(panel);
}

/** [上下] Cycle attached popups through 上方 → 下方 → 关闭（自由）. */
const SIDE_CYCLE = { top: 'bottom', bottom: 'off', off: 'top' };
function toggleSideY(panel) {
    const state = panelStates.get(panel.id);
    if (!state) return;
    state.popupSide = SIDE_CYCLE[state.popupSide] ?? 'top';
    const entry = registry()[panel.id];
    if (entry) {
        entry.popupSide = state.popupSide;
        saveSettings();
    }
    for (const [pop, att] of state.attachments) {
        att.snapY = state.popupSide === 'off' ? null : state.popupSide;
        if (!att.snapY) freezeOffset(panel, att, 'y'); // 关: stay where it is
        layoutShell(panel, att);
        persistPopup(panel.id, pop, att);
    }
    refreshFollowButtons(panel);
}

/** When a snap is switched off, remember the shell's current panel-relative
 *  offset so the popup simply stays put instead of jumping. */
function freezeOffset(panel, att, axis) {
    if (att.wasHidden || !att.shell?.isConnected) return; // hidden shell: zero rect
    const pr = panel.getBoundingClientRect();
    const r = att.shell.getBoundingClientRect();
    if (axis === 'x') att.offX = r.left - pr.left;
    else att.offY = r.top - pr.top;
}

/** Position a popup's shell against the panel. Snapped shells are anchored
 *  by the matching EDGE (上 → bottom-anchored, 右 → right-anchored), so
 *  content growth or a swapped-in popup re-glues itself with zero JS — that
 *  self-gluing is the whole point of the shell. Manual placements (snap off)
 *  use the remembered panel-relative offset. */
function layoutShell(panel, att) {
    const sh = att.shell;
    if (!sh?.isConnected) return;
    const pr = panel.getBoundingClientRect();
    if (att.snapX === 'left') {
        sh.style.left = `${pr.left}px`;
        sh.style.right = 'auto';
    } else if (att.snapX === 'right') {
        sh.style.left = 'auto';
        sh.style.right = `${window.innerWidth - pr.right}px`;
    } else {
        sh.style.left = `${pr.left + att.offX}px`;
        sh.style.right = 'auto';
    }
    if (att.snapY === 'top') {
        sh.style.top = 'auto';
        sh.style.bottom = `${window.innerHeight - pr.top}px`;
    } else if (att.snapY === 'bottom') {
        sh.style.top = `${pr.bottom}px`;
        sh.style.bottom = 'auto';
    } else {
        sh.style.top = `${pr.top + att.offY}px`;
        sh.style.bottom = 'auto';
    }
}

/** Shell size: [宽]/[高] follow wins, then the user-pinned resize, else auto
 *  (hug the popup). followH has no UI left but stays supported. */
function applyShellSize(panel, state, att) {
    const sh = att.shell;
    if (!sh?.isConnected) return;
    const pr = panel.getBoundingClientRect();
    const w = state.followW ? pr.width : att.width;
    sh.classList.toggle('ptr-w-fixed', w !== undefined);
    sh.style.width = w === undefined ? 'auto' : `${w}px`;
    const h = state.followH ? pr.height : att.height;
    sh.classList.toggle('ptr-h-fixed', h !== undefined);
    sh.style.height = h === undefined ? 'auto' : `${h}px`;
}

/** Re-lay out all of a panel's shells (panel dragged/resized, toggles
 *  flipped, size-follow changed). */
function relayoutPanel(panel, state) {
    for (const [pop, att] of state.attachments) {
        if (!pop.isConnected) {
            detachPopup(state, pop);
            continue;
        }
        layoutShell(panel, att);
        applyShellSize(panel, state, att);
    }
}

// A shell resize gesture is re-anchored to top/left for its duration (a
// bottom/right-anchored box resizing feels inverted); on pointerup the snap
// anchors are restored with the new pinned size.
let resizePrepAtt = null;
function prepShellResize(att, e) {
    const r = att.shell.getBoundingClientRect();
    if (e.clientX < r.right - 18 || e.clientY < r.bottom - 18) return; // not the corner
    resizePrepAtt = att;
    att.shell.style.left = `${r.left}px`;
    att.shell.style.top = `${r.top}px`;
    att.shell.style.right = 'auto';
    att.shell.style.bottom = 'auto';
}
function endShellResize() {
    if (!resizePrepAtt) return;
    const att = resizePrepAtt;
    resizePrepAtt = null;
    for (const [id, state] of panelStates) {
        for (const a of state.attachments.values()) {
            if (a === att) {
                const panel = document.getElementById(id);
                if (panel) layoutShell(panel, att);
                return;
            }
        }
    }
}

/** Pin a user-driven shell resize (CSS resize doesn't mutate the style
 *  attribute, so this runs from the shell's ResizeObserver). Content-driven
 *  hugging changes are ignored — only pointer-driven resizes pin a size. */
function adoptShellResize(pop) {
    for (const [id, state] of panelStates) {
        const att = state.attachments.get(pop);
        if (!att) continue;
        if (att !== resizePrepAtt && !isUserManipulating(att.shell)) return;
        const r = att.shell.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        att.width = r.width;
        att.height = r.height;
        att.shell.classList.add('ptr-w-fixed', 'ptr-h-fixed');
        att.shell.style.width = `${att.width}px`;
        att.shell.style.height = `${att.height}px`;
        persistPopup(id, pop, att, { debounce: true });
        return;
    }
}

/** Watch an attached popup for hide/show cycles and user drags. The shell
 *  does all positioning, so this is much simpler than before:
 *  - hidden → hide the shell; shown again → re-glue the shell (extensions
 *    respawn/re-anchor popups at will; inside the shell that's inert);
 *  - a user dragging the popup via its OWN drag logic (inline left/top
 *    writes while the pointer is on it) is mirrored onto the shell and
 *    becomes the remembered manual placement;
 *  - anything else (programmatic re-anchors, content swaps) is ignored —
 *    the shell hugs and stays glued by itself. */
function adoptPopupAdjustment(pop) {
    for (const [id, state] of panelStates) {
        const att = state.attachments.get(pop);
        if (!att) continue;
        const panel = document.getElementById(id);
        if (!panel) return;
        // Extension re-parented the popup (DOM re-mount with the same
        // element): stuff it back into its shell.
        if (pop.isConnected && att.shell.isConnected && pop.parentElement !== att.shell) {
            att.shell.appendChild(pop);
        }
        const cs = getComputedStyle(pop);
        if (cs.display === 'none' || cs.visibility === 'hidden') {
            att.wasHidden = true;
            if (att.shell.isConnected) att.shell.style.display = 'none';
            return;
        }
        if (att.wasHidden) {
            att.wasHidden = false;
            att.shell.style.display = '';
            layoutShell(panel, att);
            applyShellSize(panel, state, att);
            return;
        }
        if (isSelfWrite(pop)) return;
        // Adopt only genuine drags: the pointer is currently HELD on the
        // popup, or the panel's drag mid-drag flag is set. Writes in the
        // post-pointerup tail with no active drag are programmatic re-anchors
        // (content-swap respawn) ? never adopt those.
        const heldByPointer = popupPtr.el === pop && popupPtr.until === Infinity;
        const stDragging = pop.dataset.dragged === 'true';
        if (!heldByPointer && !stDragging) return;
        const l = parseFloat(pop.style.left);
        const t = parseFloat(pop.style.top);
        if (!Number.isFinite(l) || !Number.isFinite(t)) return;
        // Mirror the intended spot onto the shell; the popup's own writes
        // stay inert (it's a static shell child).
        const pr = panel.getBoundingClientRect();
        att.offX = l - pr.left;
        att.offY = t - pr.top;
        att.snapX = null;
        att.snapY = null;
        markSelfWrite(pop);
        pop.style.left = '';
        pop.style.top = '';
        layoutShell(panel, att);
        persistPopup(id, pop, att, { debounce: true });
        return;
    }
}

function isPopupLike(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (!el.isConnected || el.dataset.ptrWired) return false;
    if (el.closest('.ptr-pick-ui, .pretext-render-settings')) return false;
    if (el.classList.contains('ptr-drag-handle')) return false;
    if (NEVER_ATTACH_IDS.has(el.id) || BLOCKED_IDS.has(el.id)) return false;
    if (el.classList.contains('zoomed_avatar')) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 16) return false;
    if (r.width * r.height > window.innerWidth * window.innerHeight * 0.95) return false;
    return true;
}

/** Find the wired panel a popup most likely belongs to, by proximity to the
 *  panel's original anchor OR its current position. */
function findOwnerPanel(popRect) {
    let best = null;
    let bestDist = ATTACH_DISTANCE;
    for (const [id, state] of panelStates) {
        const panel = document.getElementById(id);
        if (!panel) continue;
        const cur = panel.getBoundingClientRect();
        const dOrig = Math.abs(popRect.left - state.origLeft) + Math.abs(popRect.top - state.origTop);
        const dCur = Math.abs(popRect.left - cur.left) + Math.abs(popRect.top - cur.top);
        const d = Math.min(dOrig, dCur);
        if (d < bestDist) {
            bestDist = d;
            best = { panel, state, cur };
        }
    }
    return best;
}

/** The panel the user just interacted with (pointerdown inside it), if the
 *  interaction is fresh — popups appearing now almost certainly belong to it,
 *  no matter where on screen they open. */
function interactiveOwner() {
    if (!lastInteraction.id) return null;
    if (Date.now() - lastInteraction.t > INTERACT_WINDOW) return null;
    const state = panelStates.get(lastInteraction.id);
    const panel = state && document.getElementById(lastInteraction.id);
    if (!state || !panel) return null;
    return { panel, state, cur: panel.getBoundingClientRect() };
}

function maybeAttach(el) {
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset.ptrWired || el.closest('.ptr-pick-ui')) return;
    for (const [, state] of panelStates) {
        if (state.attachments.has(el)) return; // already attached
    }
    // Never attach something living inside a wired panel (it already follows
    // its parent naturally) — nor an ANCESTOR of one (follow-cycle).
    for (const [id] of panelStates) {
        const p = document.getElementById(id);
        if (p && (p.contains(el) || el.contains(p))) return;
    }
    if (!isPopupLike(el)) return;

    const popRect = el.getBoundingClientRect();
    // Interaction decides WHICH panel owns the popup; proximity is fallback.
    const owner = interactiveOwner() ?? findOwnerPanel(popRect);
    if (!owner || owner.state.followPopup === false) return;

    const { panel, state, cur } = owner;
    const saved = el.id ? registry()[panel.id]?.popups?.[el.id] : null;

    const att = {
        shell: null,
        offX: 0, offY: 0,
        width: saved?.width,
        height: saved?.height,
        snapX: saved ? (saved.snapX ?? null) : (state.popupAlign === 'off' ? null : state.popupAlign),
        snapY: saved ? (saved.snapY ?? null) : (state.popupSide === 'off' ? null : state.popupSide),
        wasHidden: false,
        ro: null,
    };
    if (saved) {
        att.offX = saved.offX;
        att.offY = saved.offY;
    } else {
        // No snap on an axis → keep the popup's appeared offset relative to
        // the nearer anchor. Flip the default side if it would fall off-screen.
        const nearX = Math.abs(popRect.left - state.origLeft) < Math.abs(popRect.left - cur.left)
            ? state.origLeft : cur.left;
        const nearY = Math.abs(popRect.top - state.origTop) < Math.abs(popRect.top - cur.top)
            ? state.origTop : cur.top;
        att.offX = popRect.left - nearX;
        att.offY = popRect.top - nearY;
        if (att.snapY === 'top' && cur.top - popRect.height < 0) att.snapY = 'bottom';
        else if (att.snapY === 'bottom' && cur.bottom + popRect.height > window.innerHeight) att.snapY = 'top';
    }

    // Wrap the popup in a shell: the shell is what we position (edge-anchored
    // to the panel); the popup becomes a static child whose own position
    // writes no longer affect layout.
    const shell = document.createElement('div');
    shell.className = 'ptr-pick-ui ptr-pop-shell';
    if (getComputedStyle(el).zIndex !== 'auto') shell.style.zIndex = getComputedStyle(el).zIndex;
    el.before(shell);
    shell.appendChild(el);
    el.classList.add('ptr-shelled');
    att.shell = shell;

    state.attachments.set(el, att);
    // CSS resize on the shell doesn't mutate the style attribute — a
    // ResizeObserver on the shell adopts user resizes.
    att.ro = new ResizeObserver(() => adoptShellResize(el));
    att.ro.observe(shell);
    layoutShell(panel, att);
    applyShellSize(panel, state, att);
}

function onPanelStyleChanged(panel) {
    const state0 = panelStates.get(panel.id);
    console.log('[pretext] onPanelStyleChanged fired', {
        id: panel.id,
        hasState: !!state0,
        selfWriteCount: state0?.selfWriteCount,
        dragging: state0?.dragging,
        hasUserPos: !!state0?.userPos,
        currentStyle: panel.getAttribute('style')?.substring(0, 120),
    });
    if (state0) ensurePanelHandle(panel, state0);
    const state = panelStates.get(panel.id);
    if (!state) return;

    // Skip during initial position restore (wirePanel applies saved
    // position before state is fully created).
    if (panel.dataset.ptrRestoring) {
        delete panel.dataset.ptrRestoring;
        relayoutPanel(panel, state);
        return;
    }
    // Skip our own writes while dragging (every mousemove frame writes
    // to el.style, which would overwhelm a counter).
    if (state.dragging) {
        const r0 = panel.getBoundingClientRect();
        state.lastLeft = r0.left;
        state.lastTop = r0.top;
        relayoutPanel(panel, state);
        return;
    }
    // Skip our own restore writes (counter-based, for non-drag writes)
    if (state.selfWriteCount > 0) {
        state.selfWriteCount--;
        const r0 = panel.getBoundingClientRect();
        state.lastLeft = r0.left;
        state.lastTop = r0.top;
        relayoutPanel(panel, state);
        return;
    }

    const cs = getComputedStyle(panel);

    // Case 1: position reset to static/relative ? restore fixed.
    if ((cs.position === 'static' || cs.position === 'relative') &&
        panel.dataset.ptrOrigPos !== undefined &&
        !state.needsRefloat &&
        panel.dataset.dragged !== 'true') {
        const patch = { position: 'fixed', margin: '0' };
        if (panel.style.left === '' || panel.style.left === 'auto') {
            patch.left = state.lastLeft + 'px';
        }
        if (panel.style.top === '' || panel.style.top === 'auto') {
            patch.top = state.lastTop + 'px';
        }
        state.selfWriteCount = 2; // expect ~2 mutation callbacks
        Object.assign(panel.style, patch);
    }

    // Case 2: position is still fixed but left/top/width were externally
    // overwritten (e.g. acu extension re-layouts on popup open, rewriting
    // the entire style attribute). If we have a saved user position and
    // the values changed, restore them. Use a short debounce to avoid
    // fighting the extension's own observer loop.
    if (cs.position === 'fixed' && state.userPos && !state.dragging &&
        panel.dataset.dragged !== 'true') {
        const curL = parseFloat(cs.left) || 0;
        const curT = parseFloat(cs.top) || 0;
        const curW = parseFloat(cs.width) || 0;
        // Only restore if the position meaningfully changed from what
        // the user dragged to. Small drift (<2px) is ignored.
        if (Math.abs(curL - state.userPos.left) > 2 ||
            Math.abs(curT - state.userPos.top) > 2 ||
            Math.abs(curW - state.userPos.width) > 2) {
            console.log('[pretext] external style change detected', {
                id: panel.id,
                cur: { L: curL, T: curT, W: curW },
                userPos: { ...state.userPos },
                dragging: state.dragging,
                dragged: panel.dataset.dragged,
                selfWriteCount: state.selfWriteCount,
            });
            // Debounce: only restore once per burst of external writes
            if (state.restoreTimer) clearTimeout(state.restoreTimer);
            state.restoreTimer = setTimeout(() => {
                if (!panelStates.has(panel.id)) return;
                const st = panelStates.get(panel.id);
                if (!st.userPos || st.dragging) return;
                const patch = {
                    left: st.userPos.left + 'px',
                    top: st.userPos.top + 'px',
                    width: st.userPos.width + 'px',
                };
                if (st.userPos.height) {
                    patch.height = st.userPos.height + 'px';
                }
                console.log('[pretext] restoring to userPos', { patch, currentStyle: panel.getAttribute('style') });
                st.selfWriteCount = 2;
                Object.assign(panel.style, patch);
                st.restoreTimer = null;
                const r = panel.getBoundingClientRect();
                st.lastLeft = r.left;
                st.lastTop = r.top;
                relayoutPanel(panel, st);
            }, 50);
        }
    }

    const r = panel.getBoundingClientRect();
    state.lastLeft = r.left;
    state.lastTop = r.top;
    relayoutPanel(panel, state);
}

// --- Panel wiring ---------------------------------------------------------------

function ensureMovingUiOn() {}

/** Float a non-fixed/absolute panel in place so left/top drags work.
 *  Original inline styles are recorded for restoration. Returns the rect. */
function floatPanel(el) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'absolute') return el.getBoundingClientRect();
    if (el.dataset.ptrOrigPos === undefined) {
        el.dataset.ptrOrigPos = JSON.stringify({
            position: el.style.position, left: el.style.left, top: el.style.top,
            width: el.style.width, margin: el.style.margin,
        });
    }
    const rect = el.getBoundingClientRect();
    Object.assign(el.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        margin: '0',
    });
    return rect;
}

/** Undo floatPanel(): back to original in-flow styles. */
function unfloatPanel(el) {
    if (el.dataset.ptrOrigPos === undefined) return;
    try {
        Object.assign(el.style, JSON.parse(el.dataset.ptrOrigPos));
    } catch { /* leave styles as-is */ }
    // Keep the dataset entry: a later drag re-floats from it.
}

/** A panel with both top+bottom (or left+right) set is over-constrained:
 *  the browser stretches it instead of letting left/top move it. Pin the
 *  size from the live rect and clear the opposite edge. Runs at wire time
 *  and before every drag. */
function normalizeGeometry(el) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
    const hasRight = el.style.right !== '' && el.style.right !== 'auto';
    const hasBottom = el.style.bottom !== '' && el.style.bottom !== 'auto';
    if (!hasRight && !hasBottom) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return; // hidden/detached: nothing to pin
    if (hasRight) {
        el.style.width = `${r.width}px`;
        el.style.right = 'auto';
    }
    if (hasBottom) {
        el.style.height = `${r.height}px`;
        el.style.bottom = 'auto';
    }
}

/** Apply a saved position from our own registry. No-op while dragging. */
function applySavedPosition(el) {
    if (!el.isConnected || el.dataset.dragged === 'true') return;
    const entry = registry()[el.id];
    console.log('[pretext] applySavedPosition', { id: el.id, hasPos: !!entry?.pos, pos: entry?.pos });
    if (!entry?.pos) return;
    $(el).css(entry.pos);
    normalizeGeometry(el);
    clampPanelToViewport(el);
}

/** A static panel can't contain its absolute handle (the handle would anchor
 *  to the nearest positioned ancestor, i.e. usually the viewport corner).
 *  position:relative is visually identical to static for the panel itself but
 *  keeps the handle glued inside. Records the pre-change inline value. */
function ensureHandleAnchor(panel) {
    if (getComputedStyle(panel).position !== 'static') return;
    if (panel.dataset.ptrRelFix === undefined) {
        panel.dataset.ptrRelFix = panel.style.position;
    }
    panel.style.position = 'relative';
}

/** After a dock unfloated this panel, the next grip mousedown re-floats it
 *  before dragWire's own handler reads offsets (capture phase runs first). */
function bindRefloat(el, headerEl) {
    headerEl?.addEventListener('mousedown', () => {
        const st = panelStates.get(el.id);
        // Stale right/bottom over-constrains the box (top+bottom+height
        // makes left/top writes stretch instead of move). Normalize on
        // EVERY mousedown, before dragWire reads offsets.
        normalizeGeometry(el);
        if (st?.needsRefloat) {
            st.needsRefloat = false;
            floatPanel(el);
            normalizeGeometry(el);
        }
        const r = el.getBoundingClientRect();
        if (st) { st.lastLeft = r.left; st.lastTop = r.top; }
    }, true);
}


// --- Self-contained drag (no ST dragElement dependency) -----------------------

function dragWire(el) {
    const headerEl = document.getElementById(el.id + "header");
    if (!headerEl) return;
    let dragging = false;
    let sx, sy, sl, st0, sw, sh;
    headerEl.addEventListener("mousedown", e => {
        if (e.target.closest(".ptr-follow, .ptr-dock, .ptr-side")) return;
        const r = el.getBoundingClientRect();
        if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18) return;
        e.preventDefault();
        dragging = true;
        const st = panelStates.get(el.id);
        if (st) st.dragging = true;
        el.dataset.dragged = "true";
        sx = e.clientX; sy = e.clientY;
        const cs = getComputedStyle(el);
        sl = parseFloat(cs.left) || r.left;
        st0 = parseFloat(cs.top) || r.top;
        sw = r.width; sh = r.height;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });
    function onMove(e) {
        if (!dragging) return;
        e.preventDefault();
        let nx = sl + (e.clientX - sx);
        let ny = st0 + (e.clientY - sy);
        // Keep the whole panel inside the viewport while dragging; oversized
        // panels stay pinned to the top-left corner.
        nx = Math.min(Math.max(nx, 0), Math.max(0, window.innerWidth - sw));
        ny = Math.min(Math.max(ny, 0), Math.max(0, window.innerHeight - sh));
        el.style.left = nx + "px";
        el.style.top = ny + "px";
        el.style.margin = "0";
        el.style.width = sw + "px";
        el.style.height = sh + "px";
        // Mark as self-write so onPanelStyleChanged doesn't try to restore.
        // Set to 1 (not 3) per move frame: observer fires once per frame;
        // setting 3 causes a 3-frame backlog after drag ends that swallows
        // the real external-change detection.
        const st3 = panelStates.get(el.id);
        if (st3) st3.selfWriteCount = 1;
    }
    function onUp() {
        if (!dragging) return;
        dragging = false;
        const st = panelStates.get(el.id);
        if (st) st.dragging = false;
        el.dataset.dragged = "false";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        const entry = registry()[el.id];
        const r2 = el.getBoundingClientRect();
        const userPos = {
            left: parseFloat(el.style.left) || r2.left,
            top: parseFloat(el.style.top) || r2.top,
            width: parseFloat(el.style.width) || r2.width,
            height: parseFloat(el.style.height) || 0,
        };
        console.log('[pretext] dragWire onUp saving userPos', userPos);
        if (entry) {
            entry.pos = { left: userPos.left + 'px', top: userPos.top + 'px', width: userPos.width + 'px', height: userPos.height ? userPos.height + 'px' : '' };
            saveSettings();
        }
        const st2 = panelStates.get(el.id);
        if (st2) {
            st2.userPos = userPos;
            st2.lastLeft = r2.left;
            st2.lastTop = r2.top;
            st2.lastW = r2.width;
            st2.lastH = r2.height;
            relayoutPanel(el, st2);
        }
    }
}

let resizeTimer = null;

function clampPanelToViewport(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const curLeft = r.left;
    const curTop = r.top;
    const nextLeft = Math.min(Math.max(curLeft, 0), Math.max(0, window.innerWidth - r.width));
    const nextTop = Math.min(Math.max(curTop, 0), Math.max(0, window.innerHeight - r.height));
    if (Math.abs(nextLeft - curLeft) < 0.5 && Math.abs(nextTop - curTop) < 0.5) return null;
    const left = Math.round(nextLeft);
    const top = Math.round(nextTop);
    const state = panelStates.get(el.id);
    if (state) state.selfWriteCount = 1;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    if (state) {
        ensurePanelHandle(el, state);
        const r2 = el.getBoundingClientRect();
        state.lastLeft = r2.left;
        state.lastTop = r2.top;
        state.lastW = r2.width;
        state.lastH = r2.height;
        if (state.userPos) {
            state.userPos.left = r2.left;
            state.userPos.top = r2.top;
            state.userPos.width = r2.width;
            state.userPos.height = r2.height;
        }
    }
    const entry = registry()[el.id];
    if (entry) {
        const r3 = el.getBoundingClientRect();
        entry.pos = {
            left: `${r3.left}px`,
            top: `${r3.top}px`,
            width: `${r3.width}px`,
            height: `${r3.height}px`,
        };
    }
    return { left, top };
}

function onWindowResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        for (const [id, state] of panelStates) {
            const el = document.getElementById(id);
            if (!el || !el.isConnected) continue;
            const clamped = clampPanelToViewport(el);
            const r = el.getBoundingClientRect();
            state.lastLeft = r.left;
            state.lastTop = r.top;
            state.lastW = r.width;
            state.lastH = r.height;
            if (clamped) {
                const entry = registry()[id];
                if (entry) {
                    entry.pos = {
                        left: `${r.left}px`,
                        top: `${r.top}px`,
                        width: `${r.width}px`,
                        height: `${r.height}px`,
                    };
                }
                if (state.userPos) {
                    state.userPos.left = r.left;
                    state.userPos.top = r.top;
                    state.userPos.width = r.width;
                    state.userPos.height = r.height;
                }
                console.log('[pretext] viewport clamp applied', {
                    id,
                    left: r.left,
                    top: r.top,
                    width: r.width,
                    height: r.height,
                    viewport: { w: window.innerWidth, h: window.innerHeight },
                });
            }
            relayoutPanel(el, state);
        }
    }, 150);
}

function wirePanel(el) {
    console.log('[pretext] wirePanel called', { id: el?.id, ptrWired: el?.dataset?.ptrWired, hasOrigPos: el?.dataset?.ptrOrigPos !== undefined });
    if (!el || el.dataset.ptrWired) return;
    ensureMovingUiOn();

    const prev = registry()[el.id];

    // Reuse a native-style header if the panel already has one; otherwise
    // inject our own grip tab inside the panel.
    const hasNativeHeader = !!document.getElementById(`${el.id}header`);
    const handle = hasNativeHeader ? null : createHandle(el, prev?.handleSide ?? 'top');

    el.classList.add('ptr-movable');
    const cs = getComputedStyle(el);
    floatPanel(el);
    // If we have a saved position, apply it immediately after floating.
    // The panelStates entry doesn't exist yet (created below), so we
    // set a temporary flag on the element that onPanelStyleChanged
    // checks. The flag is cleared once state is created.
    const savedEntry0 = registry()[el.id];
    if (savedEntry0?.pos) {
        el.dataset.ptrRestoring = '1';
        $(el).css(savedEntry0.pos);
        normalizeGeometry(el);
    }

    // CSS resize needs non-visible overflow.
    if (cs.overflow === 'visible') {
        el.dataset.ptrOverflowFix = el.style.overflow ?? '';
        el.style.overflow = 'auto';
    }

    dragWire(el);

    // Re-apply a previously saved position (ST's restore ran before this
    // panel existed in the DOM). Owning extensions may re-anchor their
    // panel right after wiring; the deferred passes re-assert the remembered
    // spot once everything settles.
    applySavedPosition(el);
    // Record initial userPos from the applied position so onPanelStyleChanged
    // can restore it if the owning extension overwrites style.
    setTimeout(() => {
        if (!panelStates.has(el.id)) return;
        const st = panelStates.get(el.id);
        const r = el.getBoundingClientRect();
        const cs2 = getComputedStyle(el);
        st.userPos = {
            left: parseFloat(cs2.left) || r.left,
            top: parseFloat(cs2.top) || r.top,
            width: parseFloat(cs2.width) || r.width,
            height: parseFloat(cs2.height) || 0,
        };
    }, 100);
    setTimeout(() => { if (panelStates.has(el.id)) applySavedPosition(el); }, 1000);
    setTimeout(() => { if (panelStates.has(el.id)) applySavedPosition(el); }, 3000);

    // Migration: popupAlign used to be a boolean (true = 左对齐).
    const migAlign = prev?.popupAlign === true ? 'left'
        : prev?.popupAlign === false ? 'off'
            : (prev?.popupAlign ?? 'left');
    const entry = {
        injectedHeader: !hasNativeHeader,
        followPopup: prev?.followPopup ?? true,
        followW: prev?.followW ?? false,
        followH: prev?.followH ?? false,
        handleSide: prev?.handleSide ?? 'top',
        popupAlign: migAlign,
        popupSide: prev?.popupSide ?? 'top',
        popups: prev?.popups ?? {},
        pos: prev?.pos,
    };
    // Only persist if the entry actually changed (new panel or fields differ).
    // Avoiding redundant saveSettings() calls prevents a feedback loop:
    // saveSettings -> settings_updated -> owning ext re-renders -> re-wire -> saveSettings ...
    const prevJson = prev ? JSON.stringify(prev) : '';
    const entryJson = JSON.stringify(entry);
    registry()[el.id] = entry;
    if (prevJson !== entryJson) {
        console.log('[pretext] wirePanel registry set (changed)', { id: el.id, hasPos: !!entry.pos, prevHadPos: !!prev?.pos });
        saveSettings();
    } else {
        console.log('[pretext] wirePanel registry set (unchanged, skip save)', { id: el.id, hasPos: !!entry.pos });
    }

    // The injected bar is full-width; give the panel padding on that side so
    // the bar overlays only the padding strip, never content.
    if (handle) setSidePadding(el, entry.handleSide);

    const rect = el.getBoundingClientRect();
    const state = {
        origLeft: rect.left, origTop: rect.top,
        lastLeft: rect.left, lastTop: rect.top,
        lastW: rect.width, lastH: rect.height,
        followPopup: entry.followPopup,
        followW: entry.followW, followH: entry.followH,
        handleSide: entry.handleSide,
        popupAlign: entry.popupAlign,
        popupSide: entry.popupSide,
        needsRefloat: false,
        userPos: null,
        dragging: false,
        selfWriteCount: 0,
        restoreTimer: null,
        attachments: new Map(),
        handle,
        styleObserver: null,
        resizeObserver: null,
        onPointerDown: null,
        onPointerUp: null,
        onScroll: null,
    };
    state.styleObserver = new MutationObserver(() => onPanelStyleChanged(el));
    state.styleObserver.observe(el, { attributes: true, attributeFilter: ['style'] });
    // Bottom-glued handle must track panel size (CSS resize doesn't mutate the
    // style attribute, so a ResizeObserver is needed in addition); shells
    // anchored to the panel's bottom/right edge ride along on size changes.
    state.resizeObserver = new ResizeObserver(() => {
        glueHandle(el);
        const r = el.getBoundingClientRect();
        if (r.width === state.lastW && r.height === state.lastH) return;
        state.lastW = r.width;
        state.lastH = r.height;
        // User resized the panel ? update userPos so onPanelStyleChanged
        // doesn't restore the old size.
        if (state.userPos) {
            const cs2 = getComputedStyle(el);
            state.userPos.width = parseFloat(cs2.width) || r.width;
            state.userPos.height = parseFloat(cs2.height) || r.height;
        }
        relayoutPanel(el, state);
    });
    state.resizeObserver.observe(el);
    // Absolute handle scrolls with panel content — keep it glued.
    state.onScroll = () => glueHandle(el);
    el.addEventListener('scroll', state.onScroll, { passive: true });
    // Popups usually open right after a click inside the panel: remember the
    // interaction (maybeAttach prefers it over proximity guessing) and scan a
    // few times to catch slow-rendering popups.
    state.onPointerDown = () => {
        lastInteraction = { id: el.id, t: Date.now() };
        setTimeout(scanForPopups, 150);
        setTimeout(scanForPopups, 500);
        setTimeout(scanForPopups, 1200);
    };
    el.addEventListener('pointerdown', state.onPointerDown);
    // After any interaction settles (resize drag end etc.), re-assert the
    // shell layout so attached popups can't be left behind.
    state.onPointerUp = () => relayoutPanel(el, state);
    el.addEventListener('pointerup', state.onPointerUp);

    const headerEl = handle ?? document.getElementById(`${el.id}header`);
    bindRefloat(el, headerEl);

    panelStates.set(el.id, state);

    // Initialize userPos from saved position so onPanelStyleChanged
    // can restore it if the owning extension overwrites style later.
    const savedEntry2 = registry()[el.id];
    if (savedEntry2?.pos) {
        const r = el.getBoundingClientRect();
        const cs3 = getComputedStyle(el);
        state.userPos = {
            left: parseFloat(cs3.left) || r.left,
            top: parseFloat(cs3.top) || r.top,
            width: parseFloat(cs3.width) || r.width,
            height: parseFloat(cs3.height) || 0,
        };
    }

    el.dataset.ptrWired = '1';
    refreshFollowButtons(el);
    glueHandle(el);
}

function unwirePanel(el, { keepState = true, keepRegistry = false } = {}) {
    if (!el) return;
    const entry = registry()[el.id];
    const state = panelStates.get(el.id);

    state?.styleObserver?.disconnect();
    state?.resizeObserver?.disconnect();
    if (state) clearAttachments(state);
    if (state?.onScroll) el.removeEventListener('scroll', state.onScroll);
    if (state?.onPointerDown) el.removeEventListener('pointerdown', state.onPointerDown);
    if (state?.onPointerUp) el.removeEventListener('pointerup', state.onPointerUp);
    if (entry?.injectedHeader) {
        document.getElementById(`${el.id}header`)?.remove();
        entry.injectedHeader = false;
    }
    panelStates.delete(el.id);

    el.classList.remove('ptr-movable');
    if (el.dataset.ptrOverflowFix !== undefined) {
        el.style.overflow = el.dataset.ptrOverflowFix;
        delete el.dataset.ptrOverflowFix;
    }
    if (el.dataset.ptrOrigPos !== undefined) {
        unfloatPanel(el);
        delete el.dataset.ptrOrigPos;
    }
    if (el.dataset.ptrRelFix !== undefined) {
        el.style.position = el.dataset.ptrRelFix;
        delete el.dataset.ptrRelFix;
    }
    clearSidePadding(el);
    delete el.dataset.ptrWired;
    if (!keepRegistry) delete registry()[el.id];
    // Positions managed in our own registry; no ST state to clean.
    saveSettings();
    // Our dragWire listeners are on the header element which gets removed
    // above (injectedHeader case), so no manual cleanup needed.
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
        <span>拾取模式：点击目标选中（可连续选多个）</span>
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
        <span data-role="label">已选中 <b>#${el.id}</b></span>
        <button class="menu_button" data-act="parent" title="选择更外层的父元素">父级 ↑</button>
        <button class="menu_button" data-act="ok">确认</button>
        <button class="menu_button" data-act="cancel">取消</button>`;
    document.body.appendChild(confirmBar);

    confirmBar.querySelector('[data-act="parent"]').addEventListener('click', () => {
        const parent = parentCandidateOf(pendingEl);
        if (!parent) {
            toastr.info('没有更外层可拾取的父元素了', 'Pretext 渲染增强');
            return;
        }
        pendingEl.classList.remove('ptr-pick-pending');
        pendingEl = parent;
        pendingEl.classList.add('ptr-pick-pending');
        confirmBar.querySelector('[data-role="label"]').innerHTML = `已选中 <b>#${parent.id}</b>`;
    });
    confirmBar.querySelector('[data-act="ok"]').addEventListener('click', () => {
        const target = pendingEl;
        hideConfirmBar();
        if (target.dataset.ptrWired) {
            toastr.info(`#${target.id} 已经在可移动列表中`, 'Pretext 渲染增强');
            return;
        }
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
    const el = e.target instanceof Element ? findCandidate(e.target) : null;
    if (hoverEl === el) return;
    hoverEl?.classList.remove('ptr-pick-candidate');
    hoverEl = el;
    hoverEl?.classList.add('ptr-pick-candidate');
}

function onPickerClick(e) {
    if (e.target.closest?.('.ptr-pick-ui')) return; // confirm bar handles itself
    e.preventDefault();
    e.stopPropagation();
    const el = hoverEl;
    if (!el) {
        toastr.warning('该元素不可拾取：需要有 id（页面根容器除外）', 'Pretext 渲染增强');
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

// --- DOM watcher: picked panels (re)appearing + popup attachments --------------

function scanAdded(nodes) {
    const reg = registry();
    for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.id && reg[node.id]) { console.log('[pretext] scanAdded found registered panel', node.id); wirePanel(node); }
        for (const id of Object.keys(reg)) {
            const inner = node.querySelector?.(`#${CSS.escape(id)}`);
            if (inner) wirePanel(inner);
        }
        // Popups from other extensions may attach to a wired panel.
        maybeAttach(node);
        for (const inner of node.querySelectorAll?.('div, section, aside, dialog') ?? []) {
            maybeAttach(inner);
        }
    }
    // Owning extensions sometimes re-render a wired panel's innerHTML, which
    // wipes our injected handle. Recreate it in place.
    for (const [id, state] of panelStates) {
        if (!state.handle || state.handle.isConnected) continue;
        const el = document.getElementById(id);
        if (!el) continue;
        state.handle = createHandle(el, state.handleSide);
        bindRefloat(el, state.handle);
        refreshFollowButtons(el);
        glueHandle(el);
    }
}

/** Re-scan the whole body for popups (called after clicks inside panels). */
function scanForPopups() {
    for (const el of document.body.children) maybeAttach(el);
    // GC attachments whose popup left the DOM (keeps no RO alive, and lets a
    // re-created element attach fresh).
    for (const [, state] of panelStates) {
        for (const pop of state.attachments.keys()) {
            if (!pop.isConnected) detachPopup(state, pop);
        }
    }
}

function startObserver() {
    domObserver = new MutationObserver(muts => {
        const added = muts.flatMap(m => [...m.addedNodes]);
        if (added.length) scanAdded(added);
        // Many popups pre-exist in the DOM and are only SHOWN via a class or
        // style flip (no childList mutation) — catch those too. Style flips
        // on already-attached popups are the user moving/resizing them:
        // adopt those as the new remembered placement.
        for (const m of muts) {
            if (m.type !== 'attributes' || !(m.target instanceof HTMLElement)) continue;
            maybeAttach(m.target);
            adoptPopupAdjustment(m.target);
        }
    });
    domObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
    });
}

// --- Native reset recovery ------------------------------------------------------
// ST's resetMovablePanels clears inline top/left/right/bottom/height/width/margin
// (this section describes ST's behavior for reference; our panels are unaffected
// we floated from static flow that leaves position:fixed with no coordinates —
// they collapse or fly off-screen ("组件消失"). Restore their in-flow layout and
// re-float on the next drag instead.// --- Settings extras UI -------------------------------------------------------

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
            <small class="ptr-hint">用法：① 点上方按钮进入拾取模式 ② 像 F12 选元素一样点击目标（任何有 id 的元素都行，含其他扩展添加的；可用"父级↑"向外扩大选择）③ 确认后拖面板内 ⠿ 手柄移动、拖右下角调宽高。从面板打开的弹窗会自动跟随并紧贴面板；手柄按钮：[弹] 弹窗跟随开关，[宽] 弹窗宽度跟随面板，[左/右/关] 弹窗横向三态循环（左对齐/右对齐/关闭），[上/下/关] 弹窗纵向三态循环（贴上方/贴下方/关闭，贴合侧在弹窗高度变化时保持紧贴），按钮文字即当前状态；[归] 取消悬浮恢复原位，[⇅] 切换手柄在面板顶部/底部；弹窗可直接拖动/缩放，调整会被记忆</small>
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
    document.addEventListener('pointerdown', onPopupPtrDown, true);
    document.addEventListener('pointerup', onPopupPtrUp, true);
    document.addEventListener('pointercancel', onPopupPtrUp, true);
    window.addEventListener('resize', onWindowResize);
}

export function disable() {
    if (!enabled) return;
    enabled = false;
    exitPicker();
    // ST's EventEmitter has no .off(); removeListener is its equivalent.
    window.removeEventListener('resize', onWindowResize);
    document.removeEventListener('pointerdown', onPopupPtrDown, true);
    document.removeEventListener('pointerup', onPopupPtrUp, true);
    document.removeEventListener('pointercancel', onPopupPtrUp, true);
    popupPtr = { el: null, until: 0 };
    domObserver?.disconnect();
    domObserver = null;
    for (const id of Object.keys(registry())) {
        unwirePanel(document.getElementById(id), { keepState: true, keepRegistry: true });
    }
}
