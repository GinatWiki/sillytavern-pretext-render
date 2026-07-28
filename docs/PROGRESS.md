# 开发进度与设计决策

最后更新：2026-07-27

## 任务总览

| # | 功能 | 状态 | 文件 |
|---|---|---|---|
| 1 | pretext 构建打包 | ✅ 完成 | `lib/pretext.js`（bun build 单文件 ESM，115KB） |
| 2 | 插件骨架 | ✅ 完成 | `manifest.json` / `index.js` / `style.css` / `src/settings.js` / `src/utils.js` |
| 3 | 输入框自动高度 | ✅ 已实现，待实测 | `src/input-autosize.js` |
| 4 | 流式输出防跳动 | ✅ 已实现，待实测 | `src/stream-stabilizer.js` |
| 5 | 气泡宽度收缩 | ✅ 已实现，待实测 | `src/bubble-shrinkwrap.js` |
| 6 | 长聊天虚拟滚动 | ✅ 已实现，待实测 | `src/virtual-scroll.js` |
| 7 | MovingUI 子窗口移动（拖动+记忆位置+调宽高） | ✅ 已实现，待实测 | `src/moving-panels.js` |

## 已核实的 SillyTavern 事实（staging 分支，2026-07-27）

- 扩展路径：`/scripts/extensions/third-party/<name>/`，通过 `<script type="module">` 加载，
  **任何静态 import 404 都会报 `[object Event]` 加载失败**
- import 深度（已用官方第三方扩展 Extension-TopInfoBar 验证）：
  - 根目录 index.js：`../../../../script.js`、`../../../extensions.js`
  - src/ 下模块：`../../../../../script.js`、`../../../../extensions.js`、`../../../../RossAscends-mods.js`
  - 注意：`../../../script.js` + `../../extensions.js` 是**内置扩展**（如 regex）的写法，第三方多一级
- 事件：`STREAM_TOKEN_RECEIVED`、`GENERATION_STARTED/ENDED/STOPPED`、`MESSAGE_*`、
  `CHAT_CHANGED`（值是 `'chat_id_changed'`，勿硬编码）、`MORE_MESSAGES_LOADED`、
  `CHARACTER_MESSAGE_RENDERED` / `USER_MESSAGE_RENDERED`、
  `MOVABLE_PANELS_RESET`（原生重置按钮/preset 切换/关闭 MovingUI 时触发；
  resetMovablePanels 会清所有 `[data-dragged]` 元素的内联 top/left/right/bottom/
  height/width/margin 并置 `movingUIState={}`）
- dragElement：`#<id>header` 上以 jQuery bubble 阶段绑 mousedown，仅当 target 带
  `.drag-grabber` 才起动拖动；拖动中置 `data-dragged`（结束后为 'false'，属性仍在，
  故 reset 仍会清到它）
- DOM：`#chat > .mes[mesid] > .mes_block > .mes_text`；输入框 `#send_textarea`
- 流式：`StreamingProcessor` 每帧直接覆盖 `.mes_text` innerHTML，默认 30fps（`power_user.streaming_fps`）
- 输入框自适应：ST 原生为 CSS `field-sizing: content` + 兜底 `resetScrollHeight()`（读 scrollHeight）
- 分页：`#show_more_messages`，`power_user.chat_truncation`（默认 100）
- 设置：`extension_settings`（extensions.js）+ `saveSettingsDebounced`（script.js）；
  面板容器 `#extensions_settings` 和 `#extensions_settings2` 两个都存在
- jQuery 全局可用

## 设计决策记录

### 虚拟滚动：选 content-visibility 而非移除 DOM
- ST 大量代码通过 `.mes[mesid="N"]` 查询 DOM（编辑/swipe/删除），移除节点会破坏这些功能
- `content-visibility: auto` 浏览器原生跳过视口外布局/绘制；`contain-intrinsic-size: auto <估算>`
  保持滚动条稳定；`auto` 让浏览器渲染一次后自动记忆真实尺寸
- pretext 的角色：为从未渲染的消息提供高度估算（纯算术，避免逐条 offsetHeight 引发 reflow 风暴）
- Ctrl+F 查找时浏览器会自动展开 content-visibility 命中的内容，无副作用

### 流式防跳动：min-height 单调递增 + 合帧滚动
- 抖动根源：部分 markdown（如 `**bo`）重排导致高度上下振荡
- 用原始 markdown 文本做高度下界（语法字符会略微高估，可接受，流结束后释放 min-height）
- 用户上滚时停止自动滚动（wheel/touchmove 检测），回到底部附近恢复

### 输入框：field-sizing 冲突处理
- 启用时给 `#send_textarea` 加 `field-sizing: fixed`（CSS 类 `ptr-autosized`）接管高度控制
- 尾随换行追加零宽空格 `\u200b` 使最后一行空行被计入（pretext 空串返回 0 行）

### 子窗口移动：复用原生 dragElement，而非自造轮子
- ST 原生 MovingUI（`public/scripts/RossAscends-mods.js` 导出 `dragElement`）已实现拖动 + 右下角
  16px 调整大小 + 持久化到 `power_user.movingUIState[id]`，且 `loadMovingUIState()` 会恢复
  state 中任意 id —— 直接复用，位置/尺寸持久化与恢复自动获得
- 原生只注册 7 个固定 id（#sheld/#left-nav-panel/#right-nav-panel/#WorldInfo/#floatingPrompt/
  #logprobsViewer/#cfgConfig），这就是"只能移动主聊天窗口"感受的来源
- 增强方式：**拾取模式**——设置面板点"拾取子窗口"后点击任意带 id 的元素（≥40×16，
  含其他扩展添加的；静态定位元素由 floatPanel 记录原样式后转 fixed），确认条支持"父级↑"
  向外扩选；进入拾取时自动收起所有抽屉防遮挡，退出时还原
- 手柄：**面板内全宽横栏**（`#<id>header`，prepend 进面板、absolute left:0/right:0、
  flex space-evenly 按钮均布，类似浏览器标签栏），面板加 16px 对应侧 padding 容纳横栏
  ——只覆盖 padding 条不覆盖内容；底部模式 right 留 18px 让出 resize 角；随面板移动
  天然跟随；glueHandle 用 scrollTop/clientHeight 补偿面板内部滚动（ResizeObserver 覆盖
  CSS resize——它不触发 style 属性变更）；[⇅] 切换吸附顶部/底部并持久化 handleSide +
  setSidePadding 换边；unfloat 回 static 时用 position:relative（视觉等价 static）保住
  手柄包含块；所属扩展 innerHTML 重绘面板会抹掉手柄，scanAdded 末尾按
  state.handle.isConnected 检测重建
- **坑：ST 原生 `.drag-grabber` 是 `position:absolute; right:0; z-index:2000`**——
  直接用作手柄 grip 会覆盖在按钮上吞掉点击（"按钮没反应"的真因），需在我们的手柄内
  降级为普通 flex item（position:static）
- 弹窗归属判定：**优先交互导向**——面板内 pointerdown 后 1500ms 内出现的弹窗直接归该
  面板（偏移按面板当前位置算，弹窗留在原地仅建立跟随链接）；无交互时才退回距离启发式
  （重锚定到面板当前位置）；观察器同时监听 class/style 属性变化，捕获"预建 DOM、切
  class 显示"型弹窗；排除面板内部元素、面板的祖先、#toast-container、.zoomed_avatar
- 弹窗跟随：pointerdown 后 350ms + body 级 MutationObserver 扫描新出现的 fixed/absolute
  弹窗，按到面板原锚点/当前位置的曼哈顿距离 ≤260px 判定归属，重锚定偏移量后随拖动平移；
  手柄 [弹] 总开关（默认开）、[宽][高] 尺寸跟随，均持久化到 movingPanelsList
- [归] 按钮 dockPanel：静态来源面板 unfloatPanel 恢复文档流 + 清 right/bottom/height；
  原本就定位的面板清内联几何交还样式表；同时删除 movingUIState 记录，重载不还原
- 原生重置兼容：监听 `MOVABLE_PANELS_RESET`（='movable_panels_reset'，events.js 定义、
  script.js 转出口）→ onNativeReset 对所有悬浮面板 unfloatPanel（防止"重置后组件消失"），
  置 needsRefloat；下次手柄 mousedown（**capture 阶段**，先于 dragElement 的 jQuery bubble
  处理器）重新 floatPanel
- 其他扩展延迟创建的面板：body 级 MutationObserver 监听，注册过的 id 一出现即接管
- 已选面板清单存于扩展设置 `movingPanelsList`；移除面板可选择同时删除其位置记录
- 拖动依赖 `power_user.movingUI === true`，首次拾取时自动打开 ST 的 MovingUI 开关
- ST 的 EventEmitter（lib/eventemitter.js）**没有 .off()**，退订用 `removeListener`

### 气泡收缩：默认关闭
- 主题差异大，含 `pre/table/img/iframe/video/hr` 的消息自动跳过
- 用 `measureLineStats` 的最宽行宽作为气泡宽度（>1 行），单行用 `measureNaturalWidth`

## 已知限制 / TODO

- [ ] 所有模块待 SillyTavern 实测
- [ ] pretext 对 markdown 渲染后 HTML（标题/引用块等大号字体）的高度估算偏低保底，min-height 方案下可接受
- [ ] macOS + system-ui 字体测量不准（pretext 平台 bug），可后续在设置里提示
- [ ] 虚拟滚动对含图片消息用保守估算（3 行高），图片加载后浏览器 auto 记忆会纠正
- [x] moving-panels 已实现（复用原生 dragElement + 拾取模式）
- [ ] 考虑把 `streaming_fps` 与 ST 设置联动（暂独立）

## pretext 集成方式

- 仓库 `D:\program\sillytavernplugin\pretext`（github.com/chenglou/pretext）
- `bun run build:package` → `bun build dist/layout.js --format=esm --target=browser`
  → 拷贝为插件 `lib/pretext.js`
- 导出：prepare / layout / prepareWithSegments / layoutWithLines / walkLineRanges /
  measureLineStats / measureNaturalWidth / layoutNextLine(Range) / materializeLineRange /
  clearCache / setLocale
