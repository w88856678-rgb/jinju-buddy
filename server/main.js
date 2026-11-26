import { createApp } from './app.js';
import { config } from './config.js';
const app = createApp();
app.server.on('error', (e) => {
  console.error(
    e.code === 'EADDRINUSE' ? '此端口已在使用，请打开现有服务或修改 PORT。' : '服务启动失败（' + e.code + '）'
  );
  process.exit(1);
});
app.server.listen(config.port, config.host, () => {
  const url = (config.tlsKey ? 'https' : 'http') + '://localhost:' + config.port + app.base;
  console.log('金句buddy 已启动\n控台 ' + url + '/control\n大屏 ' + url + '/stage');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await app.stop();
    process.exit(0);
  });
