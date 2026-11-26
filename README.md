# 金句 Buddy

工作人员在控台收音、编辑和挑选金句，观众屏接收已点选的内容。待场时 Buddy 在左侧自己玩。在 LED 监看旁点「Buddy 打招呼」，它会原地挥手一次。挥手或小跳途中也能发送金句。大屏与控台监看共用腾讯体两行版式，换句上滚 180 毫秒。每次发送从后台发布算起最多展示 10 秒，最后 200 毫秒淡出。重连按剩余时间显示，总结二维码由工作人员手动切换。

## 打开公网体验

- [体验首页](https://w88856678-rgb.github.io/jinju-buddy/)
- [前台观众屏](https://w88856678-rgb.github.io/jinju-buddy/?view=stage)，无需登录。
- [后台体验控台](https://w88856678-rgb.github.io/jinju-buddy/?view=control)，点开即可手写金句、粘贴发言、用浏览器麦克风收音，或上传总结二维码。发送后在观众屏确认效果。

所有访客共用这场公开体验，逐字稿、候选和上屏内容彼此可见。请使用演示材料。全场每天共享 30 分钟云端收音和 300 次 Hy4 请求，按北京时间零点更新。手写上屏可持续使用。

GitHub Pages 提供固定入口和观众屏动效样片。主机上的 Node 服务保存活动记录、调用腾讯云语音识别和 Hy4，并通过 WebSocket 同步两屏。体验服务依赖主机开机联网。端点由主机在隧道重新注册后更新。

## 自己运行

需要 Node.js 22.16 或更高版本。运行 `npm ci`，复制 `.env.example` 为 `.env`，再运行 `npm start`。按示例配置，本机控台位于 `http://127.0.0.1:4195/e/public-demo/control`，观众页位于 `/e/public-demo/stage?look=dark`。控制口令在服务端 `BUDDY_DATA_DIR/<活动编号>/control.key`，默认数据目录为项目的 `data`。

设置 `BUDDY_EVENT_ID=public-demo` 和 `BUDDY_PUBLIC_DEMO=1` 后，访客可直接体验控台。公开体验使用活动目录下独立的 `open-rehearsal` 数据库目录。关闭开关后，控台恢复使用原口令和原活动库。

收音需要服务端腾讯云实时语音识别凭据，提炼需要配置接收该密钥的 Hy4 Flash 接口 `BUDDY_HY4_ENDPOINT` 和 `TOKENLINK_API_KEY`。支持 WebSocket 的 HTTPS 入口可用于外部设备收音。服务器可通过 `BUDDY_FONT_DIR` 使用自己的腾讯体 W3/W7。

## 验证

运行 `npm test` 与 `npm run test:browser`。浏览器用例创建临时活动，覆盖两行排版、Buddy 动效、人工发送、双屏回执、二维码、断线重连和模拟收音。
