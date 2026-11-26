import { imageUrl, serverNow } from './ui.js';
import { fontReady, layoutQuote, overflowHint } from './led-layout.js';
import { ledQr } from './led-qr.js';
import { createBuddyMotion } from './buddy-motion.js';
import { fadeDuration, quoteDeadline, quoteRollDuration, quoteRollAt, waveActive } from './show-timing.js';

export function createScene(host, animate = false) {
  host.innerHTML = '<div class="scene" data-kind="idle"><div class="led-frame">' +
    '<div class="led-buddy" role="img" aria-label="手持小红花的 Buddy"></div>' +
    '<div class="led-words"><div class="led-quote-track"><div class="led-quote-outgoing" aria-hidden="true"></div>' +
    '<div class="led-quote" aria-live="polite" aria-atomic="true"></div></div></div>' +
    '<div class="led-qr"><div class="led-code"></div><span>扫码看总结</span></div>' +
    '<video class="led-greeting" aria-label="Buddy 打招呼" muted playsinline preload="auto" src="/static/assets/buddy-greeting.mp4"></video></div></div>';
  const scene = host.querySelector('.scene');
  const words = scene.querySelector('.led-words');
  const track = scene.querySelector('.led-quote-track');
  const outgoing = scene.querySelector('.led-quote-outgoing');
  const quote = scene.querySelector('.led-quote');
  const code = scene.querySelector('.led-code');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const buddy = createBuddyMotion(scene.querySelector('.led-buddy'), scene.querySelector('.led-greeting'), animate, reduce);
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width) scene.style.setProperty('--led-scale', entry.contentRect.width / 512);
  }).observe(scene);

  let current = -1, wanted = -1, inFlight, roll, fade, outgoingFade, timeout, visible;
  function fadeAtEnd(element, remaining) {
    const animation = element.animate([{ opacity: 1 }, { opacity: 0 }], {
      delay: remaining - fadeDuration, duration: fadeDuration, fill: 'forwards', easing: 'ease-in-out',
    });
    if (document.timeline.currentTime !== null) animation.startTime = document.timeline.currentTime;
    return animation;
  }
  function clearDeadline() {
    clearTimeout(timeout);
    fade?.cancel();
    fade = undefined;
  }
  function deadline() {
    clearDeadline();
    if (visible?.kind !== 'quote') return;
    const remaining = quoteDeadline(visible) - serverNow();
    if (remaining <= 0) {
      scene.dataset.kind = 'idle';
      quote.replaceChildren();
      outgoing.replaceChildren();
      roll?.finish();
      visible = undefined;
      return;
    }
    if (animate && !reduce.matches) fade = fadeAtEnd(words, remaining);
    timeout = setTimeout(deadline, Math.ceil(remaining));
  }
  window.addEventListener('buddy-clock', deadline);
  reduce.addEventListener('change', () => { if (reduce.matches) roll?.finish(); deadline(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) roll?.finish(); deadline(); });

  function startRoll(age) {
    outgoing.style.fontSize = quote.style.fontSize;
    outgoing.style.lineHeight = quote.style.lineHeight;
    outgoing.replaceChildren(...(scene.dataset.kind === 'quote' && visible && serverNow() >= quoteRollAt(visible) ? quote.children : []));
    // A last-moment replacement must not brighten or extend the outgoing quote.
    outgoingFade?.cancel();
    if (outgoing.childElementCount && visible)
      outgoingFade = fadeAtEnd(outgoing, quoteDeadline(visible) - serverNow());
    roll = track.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0%)' }],
      { delay: -age, duration: quoteRollDuration, fill: 'backwards', easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
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
    const greeting = buddy.show(screen);
    const age = layout ? serverNow() - quoteRollAt(screen) : 0;
    const expired = layout && serverNow() >= quoteDeadline(screen);
    const canRoll = animate && !reduce.matches && !document.hidden && age < quoteRollDuration;
    if (!layout || !canRoll || expired || (roll && outgoing.textContent === layout.lines.join(''))) roll?.finish();
    if (layout && !expired) {
      if (canRoll && !roll) startRoll(age);
      quote.style.fontSize = layout.size + 'px';
      quote.style.lineHeight = layout.leading + 'px';
      quote.replaceChildren(...layout.lines.map(line => {
        const span = document.createElement('span');
        span.textContent = line;
        return span;
      }));
    } else {
      quote.replaceChildren();
      outgoing.replaceChildren();
    }
    if (qr) {
      qr.tile.dataset.image = screen.image;
      code.replaceChildren(qr.tile);
    }
    visible = screen;
    scene.dataset.kind = expired ? 'idle' : screen.kind;
    deadline();
    if (roll) {
      const active = roll;
      await active.finished;
      if (roll === active) {
        outgoing.replaceChildren();
        outgoingFade?.cancel();
        outgoingFade = undefined;
        roll = null;
      }
    }
    if (greeting && !await greeting) return false;
    if (screen.version !== wanted || (layout && serverNow() >= quoteDeadline(screen))) return false;
    current = screen.version;
    return true;
  }
  function show(screen) {
    if (screen.version < wanted) return Promise.resolve(false);
    const waitingForMovie = screen.kind === 'idle' && waveActive(screen.buddyCue, serverNow())
      && !scene.querySelector('.led-frame').hasAttribute('data-movie-visible');
    if (screen.version === current && !waitingForMovie)
      return Promise.resolve(screen.kind !== 'quote' || serverNow() < quoteDeadline(screen));
    if (wanted === screen.version && inFlight) return inFlight;
    wanted = screen.version;
    inFlight = draw(screen).finally(() => { if (wanted === screen.version) inFlight = null; });
    return inFlight;
  }
  return { show };
}
