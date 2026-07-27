// Bubble shrinkwrap — fit .mes_text width to the widest actual line.
//
// A wrapped paragraph in a max-width bubble leaves dead space on the right of
// every line above the last. pretext's measureLineStats gives the widest
// wrapped line in pure arithmetic, so we can pin the bubble to exactly that
// width. Skips messages with content whose width isn't text-driven.

import { eventSource, event_types } from '../../../script.js';
import { measureLineStats, measureNaturalWidth } from '../lib/pretext.js';
import { getTextMetrics, prepareCached, rafThrottle } from './utils.js';

// Content we can't fit by text measurement.
const SKIP_CONTENT_SEL = 'pre, table, img, iframe, video, hr';

let settings = null;
let enabled = false;
// Metrics are identical for all message bodies in virtually all themes;
// recompute on resize/chat change only.
let cachedMetrics = null;
let cachedWidth = 0;

function metricsFor(el) {
    const w = el.clientWidth || el.parentElement?.clientWidth || 0;
    if (!cachedMetrics || Math.abs(w - cachedWidth) > 2) {
        cachedMetrics = getTextMetrics(el);
        // clientWidth here is the unconstrained bubble width: measure against
        // the theme's max-width instead. Read the real wrapping width.
        const cs = getComputedStyle(el);
        const parentW = el.parentElement ? el.parentElement.clientWidth : w;
        if (cs.maxWidth.endsWith('%')) {
            cachedMetrics.contentWidth = parentW * parseFloat(cs.maxWidth) / 100;
        } else {
            const maxW = parseFloat(cs.maxWidth);
            cachedMetrics.contentWidth = Number.isFinite(maxW)
                ? Math.min(maxW, parentW)
                : (cachedMetrics.contentWidth || parentW);
        }
        cachedWidth = w;
    }
    return cachedMetrics;
}

function fitElement(el) {
    if (!el.isConnected) return;
    if (el.querySelector(SKIP_CONTENT_SEL)) {
        el.style.width = '';
        return;
    }
    const text = el.textContent ?? '';
    if (!text.trim()) {
        el.style.width = '';
        return;
    }

    const metrics = metricsFor(el);
    const maxWidth = metrics.contentWidth;
    if (!maxWidth || maxWidth < 40) return;

    const prepared = prepareCached(text, metrics, { whiteSpace: 'normal', withSegments: true });
    const { lineCount, maxLineWidth } = measureLineStats(prepared, maxWidth);

    const fitWidth = lineCount <= 1
        ? measureNaturalWidth(prepared)
        : maxLineWidth;

    // +1 guards against sub-pixel rounding re-wrapping the widest line.
    el.style.width = `${Math.min(Math.ceil(fitWidth) + 1, maxWidth)}px`;
}

const refitAll = rafThrottle(() => {
    if (!enabled) return;
    cachedMetrics = null; // width may have changed
    const bodies = document.querySelectorAll('#chat .mes .mes_text');
    // Chunk to avoid a long task on big chats.
    let i = 0;
    const CHUNK = 60;
    function step() {
        if (!enabled) return;
        const end = Math.min(i + CHUNK, bodies.length);
        for (; i < end; i++) fitElement(bodies[i]);
        if (i < bodies.length) requestAnimationFrame(step);
    }
    step();
});

function onMessageRendered() {
    refitAll();
}

function onResize() {
    cachedMetrics = null;
    refitAll();
}

const EVENTS = [
    'CHARACTER_MESSAGE_RENDERED',
    'USER_MESSAGE_RENDERED',
    'MESSAGE_EDITED',
    'MESSAGE_SWIPED',
    'MESSAGE_UPDATED',
    'MORE_MESSAGES_LOADED',
];

export function init(s) {
    settings = s;
}

export function enable() {
    if (enabled) return;
    enabled = true;
    for (const name of EVENTS) {
        if (event_types[name]) eventSource.on(event_types[name], onMessageRendered);
    }
    window.addEventListener('resize', onResize);
    refitAll();
}

export function disable() {
    if (!enabled) return;
    enabled = false;
    for (const name of EVENTS) {
        if (event_types[name]) eventSource.removeListener(event_types[name], onMessageRendered);
    }
    window.removeEventListener('resize', onResize);
    document.querySelectorAll('#chat .mes .mes_text').forEach(el => {
        el.style.width = '';
    });
    cachedMetrics = null;
}

export function onChatChanged() {
    cachedMetrics = null;
    if (enabled) refitAll();
}
