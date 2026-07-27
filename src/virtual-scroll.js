// Virtual scroll — long-chat performance via content-visibility.
//
// ST keeps every loaded message in #chat; with chat_truncation raised (or many
// "show more" loads) that's thousands of laid-out nodes. We mark messages far
// outside the viewport with `content-visibility: auto` so the browser skips
// their layout/paint, and give them `contain-intrinsic-size: auto <estimate>`
// so the scrollbar doesn't jump. `auto` makes the browser remember the real
// size once rendered; the estimate only matters for never-rendered nodes —
// and computing it with pretext costs pure arithmetic instead of a reflow.
//
// DOM nodes are never removed: ST's mesid lookups, edit/swipe and find-in-page
// (browsers auto-reveal content-visibility for matches) keep working.

import { eventSource, event_types } from '../../../../../script.js';
import { layout } from '../lib/pretext.js';
import { getTextMetrics, prepareCached } from './utils.js';

const FALLBACK_HEIGHT = 120;
// Content that breaks text-based height estimation.
const SKIP_CONTENT_SEL = 'pre, table, img, iframe, video';

let settings = null;
let enabled = false;
let observer = null;        // IntersectionObserver
let mutationObserver = null;
let textMetrics = null;     // shared .mes_text metrics (recomputed on invalidation)
let chromeHeight = null;    // .mes height minus .mes_text height, sampled once
let observed = new WeakSet();

function mesElements() {
    return document.querySelectorAll('#chat .mes');
}

function ensureMetrics(sampleEl) {
    if (textMetrics) return;
    const textEl = sampleEl.querySelector('.mes_text');
    if (!textEl) return;
    textMetrics = getTextMetrics(textEl);
    if (!textMetrics.contentWidth) textMetrics = null; // hidden chat; retry later
}

function sampleChromeHeight() {
    if (chromeHeight !== null) return;
    // One batched read on an already-visible message.
    for (const mes of mesElements()) {
        if (mes.classList.contains('ptr-virtualized')) continue;
        const textEl = mes.querySelector('.mes_text');
        if (!textEl || !mes.offsetHeight) continue;
        chromeHeight = Math.max(40, mes.offsetHeight - textEl.offsetHeight);
        return;
    }
    chromeHeight = 60; // no visible sample yet
}

/** pretext estimate of one message's outer height, no layout read. */
function estimateHeight(mes) {
    const textEl = mes.querySelector('.mes_text');
    if (!textEl) return FALLBACK_HEIGHT;
    ensureMetrics(mes);
    sampleChromeHeight();
    if (!textMetrics) return FALLBACK_HEIGHT;

    if (textEl.querySelector(SKIP_CONTENT_SEL)) {
        // Untextual content: fall back to a conservative guess.
        return Math.max(FALLBACK_HEIGHT, chromeHeight + 3 * textMetrics.lineHeight);
    }
    const text = textEl.textContent ?? '';
    if (!text.trim()) return chromeHeight + textMetrics.lineHeight;

    const prepared = prepareCached(text, textMetrics, { whiteSpace: 'normal' });
    const { height } = layout(prepared, textMetrics.contentWidth, textMetrics.lineHeight);
    return Math.ceil(height + chromeHeight);
}

function virtualize(mes) {
    // Only pay for an estimate until the browser has a real remembered size.
    if (!mes.dataset.ptrEstimated) {
        mes.style.containIntrinsicSize = `auto ${estimateHeight(mes)}px`;
        mes.dataset.ptrEstimated = '1';
    }
    mes.classList.add('ptr-virtualized');
}

function unvirtualize(mes) {
    mes.classList.remove('ptr-virtualized');
}

function makeObserver() {
    const marginPx = Math.max(1, settings.virtualOverscan) * window.innerHeight;
    return new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) unvirtualize(entry.target);
            else virtualize(entry.target);
        }
    }, { root: null, rootMargin: `${marginPx}px 0px`, threshold: 0 });
}

function observeAll() {
    for (const mes of mesElements()) {
        if (observed.has(mes)) continue;
        observed.add(mes);
        observer.observe(mes);
    }
}

function invalidateEstimates() {
    textMetrics = null;
    chromeHeight = null;
    for (const mes of mesElements()) {
        delete mes.dataset.ptrEstimated;
        if (mes.classList.contains('ptr-virtualized')) {
            mes.style.containIntrinsicSize = '';
            virtualize(mes);
        }
    }
}

function onMessagesMutated() {
    // New nodes (chat load, show-more, new message) start unvirtualized and
    // get picked up here; IO then classifies them on the next frame.
    observeAll();
}

function onMessageChanged(mesId) {
    // ST emits the numeric message id; remembered size may be stale now.
    const mes = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (mes) delete mes.dataset.ptrEstimated;
}

const REFRESH_EVENTS = ['MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED'];

export function init(s) {
    settings = s;
}

export function enable() {
    if (enabled) return;
    enabled = true;
    observed = new WeakSet();
    observer = makeObserver();

    mutationObserver = new MutationObserver(onMessagesMutated);
    mutationObserver.observe(document.getElementById('chat'), { childList: true });

    for (const name of REFRESH_EVENTS) {
        if (event_types[name]) eventSource.on(event_types[name], onMessageChanged);
    }
    observeAll();
}

export function disable() {
    if (!enabled) return;
    enabled = false;
    observer?.disconnect();
    mutationObserver?.disconnect();
    observer = null;
    mutationObserver = null;
    for (const name of REFRESH_EVENTS) {
        if (event_types[name]) eventSource.removeListener(event_types[name], onMessageChanged);
    }
    for (const mes of mesElements()) {
        mes.classList.remove('ptr-virtualized');
        mes.style.containIntrinsicSize = '';
        delete mes.dataset.ptrEstimated;
    }
    textMetrics = null;
    chromeHeight = null;
}

/** Re-create the IO (overscan changed) without losing remembered sizes. */
export function refresh() {
    if (!enabled) return;
    observer?.disconnect();
    observed = new WeakSet();
    observer = makeObserver();
    observeAll();
}

export function onChatChanged() {
    if (enabled) invalidateEstimates();
}
