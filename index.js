// Pretext 渲染增强 — SillyTavern third-party extension entry point.
// Wires settings UI and feature modules to SillyTavern events.

import { eventSource, event_types } from '../../../../script.js';
import { loadSettings, buildSettingsPanel } from './src/settings.js';
import { clearPreparedCache } from './src/utils.js';
import * as inputAutosize from './src/input-autosize.js';
import * as streamStabilizer from './src/stream-stabilizer.js';
import * as bubbleShrinkwrap from './src/bubble-shrinkwrap.js';
import * as virtualScroll from './src/virtual-scroll.js';
import * as movingPanels from './src/moving-panels.js';

const MODULES = {
    inputAutosize,
    streamStabilize,
    bubbleShrinkwrap,
    virtualScroll,
    movingPanels,
};

jQuery(async () => {
    const settings = loadSettings();

    for (const mod of Object.values(MODULES)) {
        mod.init?.(settings);
    }

    buildSettingsPanel(settings, MODULES);
    movingPanels.buildSettingsExtras?.();

    for (const [key, mod] of Object.entries(MODULES)) {
        if (settings[key]) mod.enable?.();
    }

    // Font-dependent caches are invalid when the chat/theme changes.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        clearPreparedCache();
        for (const mod of Object.values(MODULES)) mod.onChatChanged?.();
    });

    console.log('[pretext-render] loaded');
});
