// Stream stabilizer — kills viewport wobble while tokens stream in.
//
// Why streaming wobbles: ST overwrites .mes_text innerHTML every frame
// (30fps default). Partial markdown (`**bo` → `**bold**`) reformats and the
// rendered height oscillates up/down; each oscillation shifts the viewport.
//
// Strategy: every token tick (coalesced to one rAF) we compute the message's
// text height with pretext — no DOM layout read — and pin it as min-height.
// min-height is monotonic during a stream, so the box can only grow; markdown
// reflow can no longer shrink it. Scroll-to-bottom is also coalesced into the
// same frame instead of firing per token.

import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { layout } from '../lib/pretext.js';
import { getTextMetrics, prepareCached, rafThrottle } from './utils.js';

const NEAR_BOTTOM_PX = 120;

let settings = null;
let enabled = false;

let activeTextEl = null;     // .mes_text currently being streamed into
let activeMetrics = null;
let appliedMinHeight = 0;
let userScrolledUp = false;
let streaming = false;
let chatEl = null;
let detachScrollWatch = null;

function chat() {
    if (!chatEl) chatEl = document.getElementById('chat');
    return chatEl;
}

function isNearBottom() {
    const c = chat();
    if (!c) return true;
    return c.scrollHeight - c.scrollTop - c.clientHeight < NEAR_BOTTOM_PX;
}

function resolveStreamTarget() {
    const last = document.querySelector('#chat .mes:last-child .mes_text');
    if (!last) return null;
    if (last !== activeTextEl) {
        activeTextEl = last;
        activeMetrics = getTextMetrics(last);
        appliedMinHeight = 0;
        last.classList.add('ptr-streaming');
    }
    return activeTextEl;
}

const stabilize = rafThrottle(() => {
    if (!streaming || !enabled) return;
    const target = resolveStreamTarget();
    if (!target || !activeMetrics) return;

    // Raw markdown text is a close-enough proxy for rendered height and needs
    // no DOM read: syntax chars slightly overestimate, which is safe for a
    // lower bound that gets released when the stream ends.
    const chatArr = getContext().chat;
    const text = chatArr?.[chatArr.length - 1]?.mes ?? target.textContent ?? '';

    // Width can change mid-stream (drawer open, resize) — cheap check.
    const width = target.clientWidth;
    if (Math.abs(width - activeMetrics.contentWidth) > 1) {
        activeMetrics = getTextMetrics(target);
    }

    const prepared = prepareCached(text, activeMetrics, { whiteSpace: 'pre-wrap' });
    const { height } = layout(prepared, activeMetrics.contentWidth, activeMetrics.lineHeight);

    if (height > appliedMinHeight) {
        appliedMinHeight = height;
        target.style.minHeight = `${Math.ceil(height)}px`;
    }

    if (!userScrolledUp && isNearBottom()) {
        const c = chat();
        c.scrollTop = c.scrollHeight;
    }
});

function releaseTarget() {
    if (activeTextEl) {
        activeTextEl.classList.remove('ptr-streaming');
        activeTextEl.style.minHeight = '';
    }
    activeTextEl = null;
    activeMetrics = null;
    appliedMinHeight = 0;
}

function onGenerationStarted() {
    streaming = true;
    userScrolledUp = !isNearBottom();
}

function onStreamToken() {
    if (streaming) stabilize();
}

function onGenerationFinished() {
    streaming = false;
    // Final innerHTML write lands after this event; release next frame so the
    // real layout takes over and any over-reservation disappears.
    requestAnimationFrame(() => requestAnimationFrame(releaseTarget));
}

function watchUserScroll() {
    const c = chat();
    if (!c) return;
    const onWheel = (e) => { if (streaming && e.deltaY < 0) userScrolledUp = true; };
    const onTouch = () => { if (streaming) userScrolledUp = true; };
    const onScroll = () => { if (streaming && isNearBottom()) userScrolledUp = false; };
    c.addEventListener('wheel', onWheel, { passive: true });
    c.addEventListener('scroll', onScroll, { passive: true });
    c.addEventListener('touchmove', onTouch, { passive: true });
    detachScrollWatch = () => {
        c.removeEventListener('wheel', onWheel);
        c.removeEventListener('scroll', onScroll);
        c.removeEventListener('touchmove', onTouch);
    };
}

export function init(s) {
    settings = s;
}

export function enable() {
    if (enabled) return;
    enabled = true;
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);
    watchUserScroll();
}

export function disable() {
    if (!enabled) return;
    enabled = false;
    streaming = false;
    eventSource.removeListener(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationFinished);
    eventSource.removeListener(event_types.GENERATION_STOPPED, onGenerationFinished);
    detachScrollWatch?.();
    detachScrollWatch = null;
    releaseTarget();
}
