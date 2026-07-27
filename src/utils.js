// Shared text-metrics helpers and PreparedText cache.
// All modules measure through here so font strings stay consistent and
// pretext prepare() results are reused instead of re-segmenting the DOM text.

import { prepare, prepareWithSegments } from '../lib/pretext.js';

/** Build a canvas-compatible font shorthand from a computed style. */
export function canvasFontFromCss(cs) {
    const style = cs.fontStyle !== 'normal' ? `${cs.fontStyle} ` : '';
    const variant = cs.fontVariant !== 'normal' ? `${cs.fontVariant} ` : '';
    return `${style}${variant}${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
}

/** Parse CSS letter-spacing into a px number (pretext expects a number). */
function parseLetterSpacing(value) {
    if (!value || value === 'normal') return 0;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

/** Resolve computed line-height to px. 'normal' falls back to 1.2x font size. */
function parseLineHeight(value, fontSize) {
    const n = parseFloat(value);
    if (Number.isFinite(n) && value.endsWith('px')) return n;
    if (Number.isFinite(n) && !value.endsWith('px') && value !== 'normal') return n * fontSize;
    return fontSize * 1.2;
}

/**
 * Read the text metrics pretext needs from an element.
 * This is the ONLY DOM-read hot path; callers should cache the result and
 * invalidate on resize/style change instead of calling every frame.
 */
export function getTextMetrics(el) {
    const cs = getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize) || 16;
    return {
        font: canvasFontFromCss(cs),
        letterSpacing: parseLetterSpacing(cs.letterSpacing),
        lineHeight: parseLineHeight(cs.lineHeight, fontSize),
        // content-box width: what line breaking actually wraps against
        contentWidth: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    };
}

// --- PreparedText cache -----------------------------------------------------
// prepare() does segmentation + canvas measurement; for repeated measurement
// of the same text (streaming ticks, resize) we cache the handle.
// pretext itself caches segment widths internally, so the cap mainly bounds
// the per-text analysis arrays.

const MAX_PREPARED = 1500;
const preparedCache = new Map(); // key -> PreparedText (insertion-ordered)

function cacheKey(text, metrics, whiteSpace) {
    return `${metrics.font}|${metrics.letterSpacing}|${whiteSpace}|${text}`;
}

function remember(key, value) {
    if (preparedCache.size >= MAX_PREPARED) {
        // Drop oldest 20% in one pass — cheaper than per-insert eviction.
        let drop = Math.ceil(MAX_PREPARED * 0.2);
        for (const k of preparedCache.keys()) {
            preparedCache.delete(k);
            if (--drop <= 0) break;
        }
    }
    preparedCache.set(key, value);
    return value;
}

export function prepareCached(text, metrics, { whiteSpace = 'pre-wrap', withSegments = false } = {}) {
    const key = cacheKey(text, metrics, whiteSpace) + (withSegments ? '|seg' : '');
    const hit = preparedCache.get(key);
    if (hit) return hit;
    const options = { whiteSpace, letterSpacing: metrics.letterSpacing };
    const prepared = withSegments
        ? prepareWithSegments(text, metrics.font, options)
        : prepare(text, metrics.font, options);
    return remember(key, prepared);
}

/** Drop all cached prepared texts (chat switch, font change, etc.). */
export function clearPreparedCache() {
    preparedCache.clear();
}

/** Run fn at most once per animation frame; coalesces bursts (token streams). */
export function rafThrottle(fn) {
    let scheduled = false;
    let lastArgs = null;
    return function (...args) {
        lastArgs = args;
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            fn.apply(this, lastArgs);
        });
    };
}

export function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}
