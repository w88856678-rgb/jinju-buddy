// The 25 fps film is packed into a ten-by-ten grid of transparent cells.
const frameMs = 40;
const range = (first, count) => Array.from({ length: count }, (_, i) => first + i);
function poses(frames) {
  return frames.map(frame => ({
    transform: 'translate(' + (-10 * (frame % 10)) + '%,' + (-10 * Math.floor(frame / 10)) + '%)',
    easing: 'steps(1, end)',
  }));
}
const listening = poses([...range(0, 80), 79]);
const listeningDuration = (listening.length - 1) * frameMs;
// Retrace the filmed arm movement into frame 79, where the listening loop turns back.
const retract = [97, 95, 93, 91, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80, 79];
const reveal = poses([...range(80, 20), ...Array(7).fill(99), ...retract]);
const revealDuration = (reveal.length - 1) * frameMs;
const flowerSweep = 6 * frameMs;
export const quoteRollDuration = 180;

export function createBuddyMotion(host, enabled, reducedMotion) {
  const sheet = new Image();
  sheet.alt = '';
  sheet.decoding = 'async';
  sheet.sizes = '950px';
  sheet.srcset = [1, 2, 4].map(n => '/static/assets/buddy-film-' + n + 'x.webp ' + (1020 * n) + 'w').join(', ');
  sheet.src = '/static/assets/buddy-film-1x.webp';
  host.append(sheet);

  let kind = 'idle', cueStart = -Infinity, listeningOrigin = 0, playback, ready = false;
  const canPlay = () => enabled && !reducedMotion.matches && !document.hidden && kind !== 'qr';

  function play() {
    if (playback) {
      playback.onfinish = null;
      playback.cancel();
      playback = null;
    }
    const elapsed = performance.now() - cueStart;
    const issuing = kind === 'quote' && elapsed < revealDuration;
    const state = ready && canPlay() ? (issuing ? 'reveal' : 'listening') : 'still';
    host.dataset.motion = state;
    if (state === 'still') return;
    if (issuing) {
      playback = sheet.animate(reveal, { id: 'buddy-reveal', duration: revealDuration, fill: 'both' });
      playback.currentTime = elapsed;
      playback.onfinish = () => {
        cueStart = -Infinity;
        play();
      };
    } else {
      playback = sheet.animate(listening, {
        id: 'buddy-listening', duration: listeningDuration, iterations: Infinity, direction: 'alternate',
      });
      const cycle = listeningDuration * 2;
      playback.currentTime = ((Date.now() - listeningOrigin) % cycle + cycle) % cycle;
    }
  }

  async function loaded() {
    // A responsive source can be replaced during decode. Its own load event resumes here.
    try { await sheet.decode(); } catch { return; }
    if (ready) return;
    ready = true;
    host.setAttribute('data-ready', '');
    play();
  }
  sheet.addEventListener('load', loaded);
  sheet.addEventListener('error', () => {
    ready = false;
    host.removeAttribute('data-ready');
    play();
  });
  if (sheet.complete && sheet.naturalWidth) loaded();

  function rest() {
    cueStart = -Infinity;
    play();
  }
  reducedMotion.addEventListener('change', rest);
  document.addEventListener('visibilitychange', rest);
  play();

  return {
    resize(scale) { sheet.sizes = Math.ceil(950 * scale) + 'px'; },
    show(screen) {
      kind = screen.kind;
      if (kind !== 'quote' || !canPlay()) {
        listeningOrigin = screen.publishedAt || 0;
        if (kind === 'quote') listeningOrigin += revealDuration - listeningDuration;
        rest();
        return 0;
      }
      const now = performance.now();
      // Closely spaced sends share the lift already in progress and show the latest words.
      if (now - cueStart >= flowerSweep + quoteRollDuration) {
        const wallTime = Date.now();
        const age = wallTime - screen.publishedAt;
        // Align a live send across receivers. A page reload replays even an old quote from its start.
        const lag = age >= 0 && age < flowerSweep ? age : 0;
        cueStart = now - lag;
        listeningOrigin = wallTime - lag + revealDuration - listeningDuration;
        play();
      }
      return ready ? Math.max(0, flowerSweep - (now - cueStart)) : 0;
    },
  };
}
