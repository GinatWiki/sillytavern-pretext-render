// Moving panels — extend ST's native MovingUI to arbitrary sub-panels.
//
// Native MovingUI (RossAscends-mods.js dragElement) only wires 7 hardcoded
// ids. This module adds an F12-style picker: click any element with an id
// (including panels created by OTHER extensions) to make it draggable +
// resizable. We reuse the native dragElement, so positions/sizes persist
// into power_user.movingUIState and ST restores them on load.
//
// On top of plain dragging this module provides:
// - an in-panel grip tab (top/bottom switchable, keeps clear of the
//   bottom-right resize corner; moves with the panel by construction)
// - attachment: popups opened from a moved panel snap flush to it (per-panel
//   左右 toggle: left/right/off, 上下 toggle: top/bottom/off) and follow its
//   drags; snapped popups stay flush across content-height changes; user
//   moves/resizes of an attached popup are adopted and remembered (per popup
//   id, across sessions); optional width follow per panel
// - native-reset recovery: ST's MovingUI reset no longer makes floated
//   panels vanish; they return to the document flow and re-float on next drag

import { eventSource, event_types, saveSettingsDebounced } from '../../../../../script.js';
import { dragElement } from '../../../../RossAscends-mods.js';
import { power_user } from '../../../../power-user.js';
import { saveSettings } from './settings.js';

// Already wired by ST's initMovingUI — don't double-register.
const NATIVE_IDS = new Set([
    'sheld', 'left-nav-panel', 'right-nav-panel',
    'WorldInfo', 'floatingPrompt', 'logprobsViewer', 'cfgConfig',
]);

// Core ST layout elements that must never be floated.
const BLOCKED_IDS = new Set([
    ...NATIVE_IDS,
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
//   attachments: Map<el, { offX, offY, width, height, snapX, snapY, wasHidden, ro }>,
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
        <button type="button" class="ptr-follow" data-dim="x" title="弹窗横向：左对齐/右对齐/关闭，点击循环切换">左右</button>
        <button type="button" class="ptr-follow" data-dim="y" title="弹窗纵向：下方/上方/关闭，点击循环切换">上下</button>
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
    if (power_user.movingUIState?.[panel.id]) {
        delete power_user.movingUIState[panel.id];
        saveSettingsDebounced();
    }
    const r = panel.getBoundingClientRect();
    state.origLeft = state.lastLeft = r.left;
    state.origTop = state.lastTop = r.top;
    glueHandle(panel);
    toastr.info(`#${panel.id} 已恢复原位置；拖动 ⠿ 手柄可重新悬浮`, 'Pretext 渲染增强');
}

const ALIGN_LABEL = { left: '左对齐', right: '右对齐', off: '自由（保持出现位置）' };
const SIDE_LABEL = { top: '面板上方', bottom: '面板下方', off: '自由（保持出现位置）' };

function refreshFollowButtons(panel) {
    const state = panelStates.get(panel.id);
    if (!state?.handle) return;
    state.handle.querySelector('[data-dim="p"]')?.classList.toggle('active', state.followPopup);
    state.handle.querySelector('[data-dim="w"]')?.classList.toggle('active', state.followW);
    const xBtn = state.handle.querySelector('[data-dim="x"]');
    if (xBtn) {
        xBtn.classList.toggle('active', state.popupAlign === 'left');
        xBtn.classList.toggle('active-alt', state.popupAlign === 'right');
        xBtn.title = `弹窗横向：${ALIGN_LABEL[state.popupAlign]}（点击切换：左→右→关）`;
    }
    const yBtn = state.handle.querySelector('[data-dim="y"]');
    if (yBtn) {
        yBtn.classList.toggle('active', state.popupSide === 'bottom');
        yBtn.classList.toggle('active-alt', state.popupSide === 'top');
        yBtn.title = `弹窗纵向：${SIDE_LABEL[state.popupSide]}（点击切换：下→上→关）`;
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
    applySizeFollow(panel, state);
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

/** Detach a single popup: stop observing it and drop the follow link. */
function detachPopup(state, pop) {
    state.attachments.get(pop)?.ro?.disconnect();
    state.attachments.delete(pop);
}

/** Detach all of a panel's popups (follow toggled off, dock, native reset). */
function clearAttachments(state) {
    for (const att of state.attachments.values()) att.ro?.disconnect();
    state.attachments.clear();
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
    const pr = panel.getBoundingClientRect();
    for (const [pop, att] of state.attachments) {
        att.snapX = state.popupAlign === 'off' ? null : state.popupAlign;
        if (att.snapX) {
            att.offX = att.snapX === 'left' ? 0 : pr.width - att.width;
            // Hidden popups get the new offset now and the position itself
            // when they reappear (wasHidden snap-back).
            if (pop.getBoundingClientRect().width > 0) {
                markSelfWrite(pop);
                pop.style.left = `${pr.left + att.offX}px`;
            }
        }
        persistPopup(panel.id, pop, att);
    }
    refreshFollowButtons(panel);
}

/** [上下] Cycle attached popups through 下方 → 上方 → 关闭（自由）. */
const SIDE_CYCLE = { bottom: 'top', top: 'off', off: 'bottom' };
function toggleSideY(panel) {
    const state = panelStates.get(panel.id);
    if (!state) return;
    state.popupSide = SIDE_CYCLE[state.popupSide] ?? 'bottom';
    const entry = registry()[panel.id];
    if (entry) {
        entry.popupSide = state.popupSide;
        saveSettings();
    }
    const pr = panel.getBoundingClientRect();
    for (const [pop, att] of state.attachments) {
        att.snapY = state.popupSide === 'off' ? null : state.popupSide;
        if (att.snapY) {
            // att.height (kept current by adoption) stays sane for hidden
            // popups, whose live rect is 0.
            att.offY = att.snapY === 'top' ? -att.height : pr.height;
            if (pop.getBoundingClientRect().width > 0) {
                markSelfWrite(pop);
                pop.style.top = `${pr.top + att.offY}px`;
            }
        }
        persistPopup(panel.id, pop, att);
    }
    refreshFollowButtons(panel);
}

function applySizeFollow(panel, state) {
    if (!state.followW && !state.followH) return;
    const r = panel.getBoundingClientRect();
    for (const [pop, att] of state.attachments) {
        markSelfWrite(pop);
        if (state.followW) {
            pop.style.width = `${r.width}px`;
            att.width = r.width;
        }
        if (state.followH) {
            pop.style.height = `${r.height}px`;
            att.height = r.height;
        }
    }
}

/** Re-glue snapped attachments after the PANEL itself changed size: popups
 *  snapped below ride the panel's bottom edge, right-snapped popups ride its
 *  right edge. (CSS resize doesn't move the panel's top-left, so
 *  onPanelStyleChanged's translation never fires for it.) */
function keepSnappedFlush(panel, state) {
    const pr = panel.getBoundingClientRect();
    for (const [pop, att] of state.attachments) {
        if (!pop.isConnected) continue;
        let touched = false;
        if (att.snapY === 'bottom' && Math.abs(att.offY - pr.height) > 2) {
            att.offY = pr.height;
            touched = true;
        }
        if (att.snapX === 'right' && Math.abs(att.offX - (pr.width - att.width)) > 2) {
            att.offX = pr.width - att.width;
            touched = true;
        }
        if (!touched) continue;
        if (pop.getBoundingClientRect().width > 0) {
            markSelfWrite(pop);
            pop.style.left = `${pr.left + att.offX}px`;
            pop.style.top = `${pr.top + att.offY}px`;
        }
        persistPopup(panel.id, pop, att, { debounce: true });
    }
}

/** Adopt a user's manual move/resize of an attached popup: the new offset and
 *  size become the remembered placement for future panel drags and (for
 *  popups with an id) across sessions. Runs from the style-attribute observer
 *  and the per-popup ResizeObserver, so our own writes must be filtered out
 *  first (isSelfWrite). A popup that was HIDDEN and reappears is snapped back
 *  to its remembered placement instead: extensions respawn popups at their
 *  original coordinates, which must not overwrite the memory.
 *  A manual MOVE drops the popup's snap flags (the user owns the spot now);
 *  a mere SIZE change (content growth, CSS resize) keeps them — snapped edges
 *  are re-glued so the popup stays flush with the panel. */
function adoptPopupAdjustment(pop) {
    for (const [id, state] of panelStates) {
        const att = state.attachments.get(pop);
        if (!att) continue;
        const panel = document.getElementById(id);
        if (!panel) return;
        const cs = getComputedStyle(pop);
        if (cs.display === 'none' || cs.visibility === 'hidden') {
            // Closed/hidden: a zero rect is not a user adjustment.
            att.wasHidden = true;
            return;
        }
        const pr = panel.getBoundingClientRect();
        if (att.wasHidden) {
            att.wasHidden = false;
            markSelfWrite(pop);
            pop.style.left = `${pr.left + att.offX}px`;
            pop.style.top = `${pr.top + att.offY}px`;
            pop.style.width = `${att.width}px`;
            pop.style.height = `${att.height}px`;
            return;
        }
        if (isSelfWrite(pop)) return;
        const r = pop.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return; // mid-transition, ignore
        const posChanged = Math.abs(r.left - (pr.left + att.offX)) > 2
            || Math.abs(r.top - (pr.top + att.offY)) > 2;
        const sizeChanged = Math.abs(r.width - att.width) > 2
            || Math.abs(r.height - att.height) > 2;
        if (posChanged) {
            att.offX = r.left - pr.left;
            att.offY = r.top - pr.top;
            att.width = r.width;
            att.height = r.height;
            att.snapX = null;
            att.snapY = null;
            persistPopup(id, pop, att, { debounce: true });
            return;
        }
        if (sizeChanged) {
            att.width = r.width;
            att.height = r.height;
            // Keep snapped edges flush despite the new size: top-snapped
            // popups grow upward, right-snapped popups grow leftward.
            if (att.snapY === 'top') {
                att.offY = -r.height;
                markSelfWrite(pop);
                pop.style.top = `${pr.top + att.offY}px`;
            }
            if (att.snapX === 'right') {
                att.offX = pr.width - r.width;
                markSelfWrite(pop);
                pop.style.left = `${pr.left + att.offX}px`;
            }
            persistPopup(id, pop, att, { debounce: true });
        }
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

    let offX, offY, width, height, snapX, snapY;
    if (saved) {
        // Remembered placement wins — the user put this popup there before.
        ({ offX, offY, width, height } = saved);
        snapX = saved.snapX ?? null;
        snapY = saved.snapY ?? null;
    } else {
        // Default: snug against the panel per the 左右/上下 toggles. With a
        // toggle off, keep the popup's appeared offset relative to the nearer
        // anchor instead.
        snapX = state.popupAlign === 'off' ? null : state.popupAlign;
        snapY = state.popupSide === 'off' ? null : state.popupSide;
        if (snapX === 'left') {
            offX = 0;
        } else if (snapX === 'right') {
            offX = cur.width - popRect.width;
        } else {
            const anchorX = Math.abs(popRect.left - state.origLeft) < Math.abs(popRect.left - cur.left)
                ? state.origLeft : cur.left;
            offX = popRect.left - anchorX;
        }
        if (snapY) {
            offY = snapY === 'top' ? -popRect.height : cur.height;
            // Flip if the default side would fall off-screen.
            const topPx = cur.top + offY;
            if (topPx + popRect.height > window.innerHeight || topPx < 0) {
                offY = snapY === 'top' ? cur.height : -popRect.height;
                snapY = snapY === 'top' ? 'bottom' : 'top';
            }
        } else {
            const anchorY = Math.abs(popRect.top - state.origTop) < Math.abs(popRect.top - cur.top)
                ? state.origTop : cur.top;
            offY = popRect.top - anchorY;
        }
    }

    // Normalize to left/top so we can translate it during drags.
    if (getComputedStyle(el).position !== 'fixed') el.style.position = 'fixed';
    markSelfWrite(el);
    el.style.left = `${cur.left + offX}px`;
    el.style.top = `${cur.top + offY}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    if (width !== undefined) el.style.width = `${width}px`;
    if (height !== undefined) el.style.height = `${height}px`;
    // Popups are user-adjustable; adoptPopupAdjustment picks up their changes.
    if (!el.style.resize) el.style.resize = 'both';
    if (getComputedStyle(el).overflow === 'visible') el.style.overflow = 'auto';

    const att = {
        offX, offY,
        width: width ?? popRect.width,
        height: height ?? popRect.height,
        snapX, snapY,
        wasHidden: false,
        ro: null,
    };
    state.attachments.set(el, att);
    // CSS resize (resize:both) doesn't mutate the style attribute — a
    // ResizeObserver is needed to adopt user resizes. Self-writes are
    // filtered inside adoptPopupAdjustment.
    att.ro = new ResizeObserver(() => adoptPopupAdjustment(el));
    att.ro.observe(el);
    applySizeFollow(panel, state);
}

function onPanelStyleChanged(panel) {
    glueHandle(panel);
    const state = panelStates.get(panel.id);
    if (!state) return;
    const r = panel.getBoundingClientRect();
    const dx = r.left - state.lastLeft;
    const dy = r.top - state.lastTop;
    if (dx !== 0 || dy !== 0) {
        for (const [pop, att] of state.attachments) {
            if (!pop.isConnected) {
                detachPopup(state, pop);
                continue;
            }
            markSelfWrite(pop);
            pop.style.left = `${r.left + att.offX}px`;
            pop.style.top = `${r.top + att.offY}px`;
        }
        state.lastLeft = r.left;
        state.lastTop = r.top;
    }
    applySizeFollow(panel, state);
}

// --- Panel wiring ---------------------------------------------------------------

function ensureMovingUiOn() {
    if (power_user.movingUI === true) return;
    power_user.movingUI = true;
    $('body').toggleClass('movingUI', true);
    saveSettingsDebounced();
    console.log('[pretext-render] moving-panels: enabled ST MovingUI');
}

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

/** After ST's native reset (or a dock) unfloated this panel, the next grip
 *  mousedown re-floats it BEFORE dragElement's own handler reads offsets
 *  (capture phase runs before dragElement's bubble-phase jQuery handler). */
function bindRefloat(el, headerEl) {
    headerEl?.addEventListener('mousedown', () => {
        const st = panelStates.get(el.id);
        if (!st?.needsRefloat) return;
        st.needsRefloat = false;
        floatPanel(el);
        const r = el.getBoundingClientRect();
        st.lastLeft = r.left;
        st.lastTop = r.top;
    }, true);
}

function wirePanel(el) {
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

    // CSS resize needs non-visible overflow.
    if (cs.overflow === 'visible') {
        el.dataset.ptrOverflowFix = el.style.overflow ?? '';
        el.style.overflow = 'auto';
    }

    dragElement($(el));

    // Re-apply a previously saved position (ST's restore ran before this
    // panel existed in the DOM).
    const saved = power_user.movingUIState?.[el.id];
    if (saved) $(el).css(saved);

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
        popupSide: prev?.popupSide ?? 'bottom',
        popups: prev?.popups ?? {},
    };
    registry()[el.id] = entry;
    saveSettings();

    // The injected bar is full-width; give the panel padding on that side so
    // the bar overlays only the padding strip, never content.
    if (handle) setSidePadding(el, entry.handleSide);

    const rect = el.getBoundingClientRect();
    const state = {
        origLeft: rect.left, origTop: rect.top,
        lastLeft: rect.left, lastTop: rect.top,
        followPopup: entry.followPopup,
        followW: entry.followW, followH: entry.followH,
        handleSide: entry.handleSide,
        popupAlign: entry.popupAlign,
        popupSide: entry.popupSide,
        needsRefloat: false,
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
    // style attribute, so a ResizeObserver is needed in addition).
    state.resizeObserver = new ResizeObserver(() => {
        glueHandle(el);
        applySizeFollow(el, state);
        keepSnappedFlush(el, state);
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
    // size follow so attached popups can't be left behind.
    state.onPointerUp = () => applySizeFollow(el, state);
    el.addEventListener('pointerup', state.onPointerUp);

    const headerEl = handle ?? document.getElementById(`${el.id}header`);
    bindRefloat(el, headerEl);

    panelStates.set(el.id, state);

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
        if (node.id && reg[node.id]) wirePanel(node);
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
// on every [data-dragged] element and wipes power_user.movingUIState. For panels
// we floated from static flow that leaves position:fixed with no coordinates —
// they collapse or fly off-screen ("组件消失"). Restore their in-flow layout and
// re-float on the next drag instead.
function onNativeReset() {
    let recovered = 0;
    for (const [id, state] of panelStates) {
        const el = document.getElementById(id);
        if (!el) continue;
        clearAttachments(state); // anchors are stale after a reset
        if (el.dataset.ptrOrigPos !== undefined) {
            unfloatPanel(el);
            ensureHandleAnchor(el);
            state.needsRefloat = true;
            recovered++;
        }
        // Re-anchor to wherever the panel ended up.
        const r = el.getBoundingClientRect();
        state.origLeft = state.lastLeft = r.left;
        state.origTop = state.lastTop = r.top;
        glueHandle(el);
    }
    if (recovered) {
        toastr.info('面板位置已重置；再次拖动手柄将重新悬浮定位', 'Pretext 渲染增强');
    }
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
            <small class="ptr-hint">用法：① 点上方按钮进入拾取模式 ② 像 F12 选元素一样点击目标（任何有 id 的元素都行，含其他扩展添加的；可用"父级↑"向外扩大选择）③ 确认后拖面板内 ⠿ 手柄移动、拖右下角调宽高。从面板打开的弹窗会自动跟随并紧贴面板；手柄按钮：[弹] 弹窗跟随开关，[宽] 弹窗宽度跟随面板，[左右] 左对齐/右对齐/关闭三态循环，[上下] 下方/上方/关闭三态循环（贴合侧在弹窗高度变化时保持紧贴），[归] 取消悬浮恢复原位，[⇅] 切换手柄在面板顶部/底部；弹窗可直接拖动/缩放，调整会被记忆</small>
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
    eventSource.on(event_types.MOVABLE_PANELS_RESET, onNativeReset);
}

export function disable() {
    if (!enabled) return;
    enabled = false;
    exitPicker();
    // ST's EventEmitter has no .off(); removeListener is its equivalent.
    eventSource.removeListener(event_types.MOVABLE_PANELS_RESET, onNativeReset);
    domObserver?.disconnect();
    domObserver = null;
    for (const id of Object.keys(registry())) {
        unwirePanel(document.getElementById(id), { keepState: true, keepRegistry: true });
    }
}
