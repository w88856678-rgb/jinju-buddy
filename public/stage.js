import { api, connect } from './ui.js';
import { createScene } from './scene.js';
import { stageLook } from './led-layout.js';

const options = new URLSearchParams(location.search);
document.body.dataset.look = stageLook(options.get('look'));
document.body.toggleAttribute('data-native', options.get('native') === '1');
const stage = document.getElementById('stage');
const scene = createScene(stage, true);
const status = document.getElementById('stage-status');
let latest = -1, lastScreen, retry;
async function render(message) {
  const screen = message.screen;
  if (!screen || screen.version < latest) return;
  latest = screen.version;
  lastScreen = message;
  clearTimeout(retry);
  try {
    if (!(await scene.show(screen)) || document.hidden) return;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!document.hidden && screen.version === latest)
      live.send({ type: 'displayed', version: screen.version });
  } catch (error) {
    if (screen.version !== latest) return;
    status.textContent = error.message;
    if (!error.overflow) retry = setTimeout(() => render(lastScreen), 1800);
  }
}
const live = connect('stage', (m) => { if (m.type === 'screen') render(m); },
  (online) => { status.textContent = online ? '实时连线' : '正在重连'; });
api('stage').then(render).catch(() => {});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) live.send({ type: 'hidden' });
  else if (lastScreen) render(lastScreen);
});
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { status.textContent = '可使用浏览器全屏'; }
}
stage.addEventListener('dblclick', fullscreen);
document.addEventListener('keydown', (event) => {
  if (!event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'f')
    fullscreen();
});
