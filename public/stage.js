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
let checkTimer, checking = false;
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
// A socket can look connected for longer than a quote lives. A small snapshot
// recovers a missed publication without replaying a version already on screen.
async function checkScreen() {
  clearTimeout(checkTimer);
  if (checking || document.hidden) return;
  checking = true;
  const request = new AbortController();
  const timeout = setTimeout(() => request.abort(), 3500);
  try {
    const state = await api('stage', 'GET', undefined, request.signal);
    if (!document.hidden && state.screen.version > latest) render(state);
  } catch {
    // The socket and the next check can independently restore the current state.
  } finally {
    clearTimeout(timeout);
    checking = false;
    if (!document.hidden) checkTimer = setTimeout(checkScreen, 1500);
  }
}
const live = connect('stage', (m) => { if (m.type === 'screen') render(m); },
  (online) => {
    status.textContent = online ? '实时连线' : '正在重连';
    if (online) scene.greetingReady.then(() => live.send({ type: 'greeting-ready' }));
    else checkScreen();
  });
checkScreen();
window.addEventListener('online', checkScreen);
window.addEventListener('pageshow', checkScreen);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(checkTimer);
    live.send({ type: 'hidden' });
  } else {
    checkScreen();
    if (lastScreen) render(lastScreen);
  }
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
