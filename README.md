# 金句 Buddy

工作人员在控台收音、编辑和挑选金句，观众屏接收已点选的内容。左侧 Buddy 待场时倾听，出句时递花，右侧金句上滚 180 毫秒。大屏与控台监看共用腾讯体两行版式。

## 打开公网体验

- [体验首页](https://w88856678-rgb.github.io/jinju-buddy/)
- [前台观众屏](https://w88856678-rgb.github.io/jinju-buddy/?view=stage)，无需登录。
- [后台体验控台](https://w88856678-rgb.github.io/jinju-buddy/?view=control)，输入邀请人单独提供的体验口令。可以手写金句、粘贴发言、用浏览器麦克风收音，或上传总结二维码。发送后在观众屏确认效果。

所有持有口令的人共用这场体验活动。请使用演示材料。GitHub Pages 提供固定入口和十秒实录。实时请求通过 HTTPS 和 WebSocket 连到一套独立的 Node 服务。体验服务依赖主机开机联网，入口会在连接不可用时提供重试。端点由主机在隧道重新注册后更新。

## 自己运行

需要 Node.js 22.16 或更高版本。运行 `npm ci`，复制 `.env.example` 为 `.env`，再运行 `npm start`。按示例配置，本机控台位于 `http://127.0.0.1:4195/e/public-demo/control`，观众页位于 `/e/public-demo/stage?look=dark`。控制口令在服务端 `BUDDY_DATA_DIR/<活动编号>/control.key`，默认数据目录为项目的 `data`。

收音需要服务端腾讯云实时语音识别凭据，提炼需要配置接收该密钥的 Hy4 Flash 接口 `BUDDY_HY4_ENDPOINT` 和 `TOKENLINK_API_KEY`。支持 WebSocket 的 HTTPS 入口可用于外部设备收音。服务器可通过 `BUDDY_FONT_DIR` 使用自己的腾讯体 W3/W7。项目不随仓库分发活动库、操作口令或云密钥。

## 验证

运行 `npm test` 与 `npm run test:browser`。浏览器用例创建临时活动，覆盖两行排版、Buddy 动效、人工发送、双屏回执、二维码、断线重连和模拟收音。
