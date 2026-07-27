# Pretext 渲染增强（sillytavern-pretext-render）

基于 [@chenglou/pretext](https://github.com/chenglou/pretext) 的 SillyTavern 第三方扩展。
pretext 是一个纯 JS 文本测量/布局库：用 canvas 测量 + `Intl.Segmenter` 分段，
**不触发 DOM reflow** 即可算出多行文本的高度、行数、最宽行宽。本插件用它解决
SillyTavern 的一系列渲染性能与体验问题。

## 功能

| 功能 | 默认 | 说明 |
|---|---|---|
| 输入框自动高度 | 开 | 输入时用 pretext 算术计算 `#send_textarea` 高度，替代 `scrollHeight` 读取（消除 reflow） |
| 流式输出防跳动 | 开 | 流式期间预算消息高度并设为 min-height（单调递增），滚动合帧，消除 markdown 重排抖动 |
| 气泡宽度收缩 | 关 | 气泡宽度贴合最宽一行文本（含代码块/图片的消息自动跳过） |
| 长聊天虚拟滚动 | 开 | 视口外消息 `content-visibility: auto` 跳过渲染，高度由 pretext 估算，滚动条稳定 |
| 子窗口自由移动 | 关 | 增强 MovingUI：拾取任意浮动面板（含其他扩展添加的）即可拖动/调整宽高，位置尺寸自动记忆 |

## 安装

SillyTavern → 扩展（拼图图标）→ Install Extension → 填入本仓库 Git 地址 → 安装。
无需构建、无外部依赖（pretext 已打包为 `lib/pretext.js` 单文件 ESM 随插件分发）。

安装后在 扩展设置面板（Pretext 渲染增强）中开关各功能。

## 原理速览

- `prepare(text, font)`：一次性分段 + canvas 测量，产出句柄（本插件在 `src/utils.js` 中做了缓存）
- `layout(prepared, width, lineHeight)`：纯算术得到高度/行数，约 0.0002ms/次
- `measureLineStats / measureNaturalWidth`：气泡收缩用最宽行宽
- 虚拟滚动用浏览器原生 `content-visibility: auto` + `contain-intrinsic-size: auto <估算值>`，
  pretext 只为"从未渲染过的消息"提供估算值，渲染过一次后浏览器自动记忆真实尺寸

## 目录结构

```
manifest.json          SillyTavern 扩展清单
index.js               入口：加载设置、按开关启用模块、监听 CHAT_CHANGED
style.css              各功能样式（均由模块按需加 class 激活）
lib/pretext.js         pretext 单文件 ESM 打包产物（bun build）
src/
  settings.js          设置持久化 + 设置面板 UI
  utils.js             字体度量读取、PreparedText 缓存、rAF 节流
  input-autosize.js    输入框自动高度
  stream-stabilizer.js 流式输出防跳动
  bubble-shrinkwrap.js 气泡宽度收缩
  virtual-scroll.js    长聊天虚拟滚动
  moving-panels.js     MovingUI 子窗口移动增强（开发中）
docs/PROGRESS.md       开发进度与设计决策记录
```

## 兼容性

- 需要支持 `Intl.Segmenter` 与 `content-visibility` 的现代浏览器（Chrome/Edge/Firefox 近期版本）
- pretext 对 `system-ui` 字体在 macOS 上测量不准（见 pretext PLATFORM_BUGS.md）；
  若主题使用该字体，高度估算可能有少量误差，不影响功能正确性

## 更新 pretext

```sh
cd pretext && git pull && bun install && bun run build:package
bun build dist/layout.js --outfile dist/pretext.bundle.js --format=esm --target=browser
cp dist/pretext.bundle.js ../sillytavern-pretext-render/lib/pretext.js
```
