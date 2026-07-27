// Input autosize — height of #send_textarea computed by pretext layout()
// instead of scrollHeight reads (which force synchronous layout reflow).

import { layout } from '../lib/pretext.js';
import { getTextMetrics, prepareCached } from './utils.js';

const TEXTAREA_SEL = '#send_textarea';

let settings = null;
let enabled = false;
let metrics = null;          // cached font/lineHeight/padding info
let boxExtras = null;        // padding+border vertical extras
let maxHeightPx = Infinity;
let resizeObserver = null;
let lastWidth = 0;

function el() {
    return document.querySelector(TEXTAREA_SEL);
}

function readMetrics() {
    const ta = el();
    if (!ta) return false;
    const cs = getComputedStyle(ta);
    metrics = getTextMetrics(ta);
    boxExtras =
        parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
        parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    // Respect theme max-height if any; otherwise cap at 40% viewport height.
    const cssMax = parseFloat(cs.maxHeight);
    maxHeightPx = Number.isFinite(cssMax) ? cssMax : window.innerHeight * 0.4;
    lastWidth = ta.clientWidth;
    return true;
}

function applyHeight() {
    const ta = el();
    if (!ta || !metrics) return;

    let value = ta.value;
    // A trailing newline opens a new visual line that contains no text;
    // give it a zero-width body so pretext counts it. Empty string stays 1 line.
    if (value.endsWith('\n')) value += '​';

    const prepared = prepareCached(value, metrics, { whiteSpace: 'pre-wrap' });
    const { lineCount } = layout(prepared, metrics.contentWidth, metrics.lineHeight);
    const lines = Math.max(1, lineCount);
    const wanted = Math.ceil(lines * metrics.lineHeight + boxExtras + 1);
    const clamped = Math.min(wanted, maxHeightPx);

    ta.classList.toggle('ptr-clamped', wanted > maxHeightPx);
    ta.style.height = `${clamped}px`;
}

function onInput() {
    if (!metrics) {
        if (!readMetrics()) return;
    }
    applyHeight();
}

function onResize() {
    const ta = el();
    if (!ta) return;
    // Width changes require re-layout; height-only changes are our own writes.
    if (ta.clientWidth !== lastWidth) {
        readMetrics();
    }
    applyHeight();
}

export function init(s) {
    settings = s;
}

export function enable() {
    if (enabled) return;
    const ta = el();
    if (!ta) return;
    enabled = true;

    readMetrics();
    ta.classList.add('ptr-autosized');
    ta.addEventListener('input', onInput);
    window.addEventListener('resize', onResize);
    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(ta);
    applyHeight();
}

export function disable() {
    if (!enabled) return;
    enabled = false;
    const ta = el();
    if (ta) {
        ta.classList.remove('ptr-autosized', 'ptr-clamped');
        ta.removeEventListener('input', onInput);
        ta.style.height = '';
    }
    window.removeEventListener('resize', onResize);
    resizeObserver?.disconnect();
    resizeObserver = null;
    metrics = null;
}

export function onChatChanged() {
    // ST resets textarea height on chat change; re-apply ours next frame.
    if (!enabled) return;
    requestAnimationFrame(() => {
        readMetrics();
        applyHeight();
    });
}
