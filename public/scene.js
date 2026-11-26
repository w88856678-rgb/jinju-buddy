import { imageUrl } from './ui.js';
import { fontReady, layoutQuote, overflowHint } from './led-layout.js';
import { ledQr } from './led-qr.js';
import { createBuddyMotion, quoteRollDuration } from './buddy-motion.js';

export function createScene(host, animate = false) {
  host.innerHTML = '<div class="scene" data-kind="idle"><div class="led-frame">' +
    '<div class="led-buddy" role="img" aria-label="手持小红花的 Buddy"></div>' +
    '<div class="led-quote-track"><div class="led-quote-outgoing" aria-hidden="true"></div>' +
    '<div class="led-quote" aria-live="polite" aria-atomic="true"></div></div>' +
    '<div class="led-qr"><div class="led-code"></div><span>扫码看总结</span></div></div></div>';
  const scene = host.querySelector('.scene');
  const track = scene.querySelector('.led-quote-track');
  const outgoing = scene.querySelector('.led-quote-outgoing');
  const quote = scene.querySelector('.led-quote');
  const code = scene.querySelector('.led-code');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const buddy = createBuddyMotion(scene.querySelector('.led-buddy'), animate, reduce);
  const resize = new ResizeObserver(([entry]) => {
    const scale = entry.contentRect.width / 512;
    if (!scale) return;
    scene.style.setProperty('--led-scale', scale);
    buddy.resize(scale);
  });
  resize.observe(scene);
  let current = -1, wanted = -1, inFlight, roll;

  function finishMotion() {
    roll?.finish();
  }
  reduce.addEventListener('change', () => { if (reduce.matches) finishMotion(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) finishMotion(); });

  function startRoll(delay) {
    outgoing.style.fontSize = quote.style.fontSize;
    outgoing.style.lineHeight = quote.style.lineHeight;
    outgoing.replaceChildren(...(scene.dataset.kind === 'quote' ? quote.children : []));
    // The two quotes share one moving layer. At rest the outgoing slot is above the LED.
    roll = track.animate(
      [{ transform: 'translateY(100%)' }, { transform: 'translateY(0%)' }],
      { delay, duration: quoteRollDuration, fill: 'backwards', easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
    );
  }

  async function draw(screen) {
    let layout, qr;
    if (screen.kind === 'quote') {
      await fontReady;
      layout = screen.layout || layoutQuote(screen.text, screen.compact);
    } else if (screen.kind === 'qr') {
      [qr] = await Promise.all([ledQr(imageUrl(screen.image)), fontReady]);
    }
    if (screen.version !== wanted) return false;
    if (screen.kind === 'quote' && !layout) throw Object.assign(new Error(overflowHint), { overflow: true });
    const canMove = animate && !reduce.matches && !document.hidden;
    const delay = buddy.show(screen);
    if (!layout || !canMove || (roll && outgoing.textContent === layout.lines.join(''))) finishMotion();
    if (layout) {
      // A newer quote takes the incoming slot immediately, even midway through a roll.
      if (canMove && !roll) startRoll(delay);
      quote.style.fontSize = layout.size + 'px';
      quote.style.lineHeight = layout.leading + 'px';
      quote.replaceChildren(...layout.lines.map((line) => {
        const span = document.createElement('span');
        span.textContent = line;
        return span;
      }));
    }
    if (qr) {
      qr.tile.dataset.image = screen.image;
      code.replaceChildren(qr.tile);
    }
    scene.dataset.kind = screen.kind;
    if (roll) {
      const active = roll;
      await active.finished;
      if (roll === active) {
        outgoing.replaceChildren();
        roll = null;
      }
      if (screen.version !== wanted) return false;
    }
    current = screen.version;
    return true;
  }
  function show(screen) {
    if (screen.version < wanted) return Promise.resolve(false);
    if (screen.version === current) return Promise.resolve(true);
    if (wanted === screen.version && inFlight) return inFlight;
    wanted = screen.version;
    inFlight = draw(screen).finally(() => { if (wanted === screen.version) inFlight = null; });
    return inFlight;
  }
  return { show };
}
