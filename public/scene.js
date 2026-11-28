import { serverNow } from './ui.js';
import { fontReady, layoutQuote, overflowHint } from './led-layout.js';
import { createQrEnding } from './qr-ending.js';
import { createBuddyMotion } from './buddy-motion.js';
import { fadeDuration, quoteDeadline, quoteRollDuration, quoteRollAt, waveActive } from './show-timing.js';

export function createScene(host, animate = false) {
  host.innerHTML = '<div class="scene" data-kind="idle"><div class="led-frame">' +
    '<div class="led-buddy" role="img" aria-label="手持小红花的 Buddy"></div>' +
    '<div class="led-words"><div class="led-quote-track"><div class="led-quote-outgoing" aria-hidden="true"></div>' +
    '<div class="led-quote" aria-live="polite" aria-atomic="true"></div></div></div>' +
    '<div class="led-qr"><canvas class="led-qr-buddy" width="224" height="200" role="img" aria-label="Buddy 递出小红花"></canvas>' +
    '<div class="led-code"></div><span class="led-qr-title">辩论精彩时刻总结</span></div>' +
    '<canvas class="led-greeting" aria-hidden="true"></canvas></div></div>';
  const scene = host.querySelector('.scene');
  const words = scene.querySelector('.led-words');
  const track = scene.querySelector('.led-quote-track');
  const outgoing = scene.querySelector('.led-quote-outgoing');
  const quote = scene.querySelector('.led-quote');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const ending = createQrEnding(scene.querySelector('.led-qr'), animate, reduce);
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

  function startRoll(age, hasOutgoingQuote) {
    outgoing.style.fontSize = quote.style.fontSize;
    outgoing.style.lineHeight = quote.style.lineHeight;
    outgoing.replaceChildren(...(hasOutgoingQuote ? quote.children : []));
    // A last-moment replacement must not brighten or extend the outgoing quote.
    outgoingFade?.cancel();
    if (outgoing.childElementCount && visible)
      outgoingFade = fadeAtEnd(outgoing, quoteDeadline(visible) - serverNow());
    roll = track.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0%)' }],
      { delay: -age, duration: quoteRollDuration, fill: 'backwards', easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  }
  async function draw(screen) {
    let layout;
    if (screen.kind === 'quote') {
      layout = screen.layout;
      // Published lines already have their Tencent font size and breaks. Only
      // legacy snapshots without a layout need local font metrics before drawing.
      if (!layout) {
        await fontReady;
        layout = layoutQuote(screen.text, screen.compact);
      }
    }
    if (screen.version !== wanted) return false;
    if (screen.kind === 'quote' && !layout) throw Object.assign(new Error(overflowHint), { overflow: true });
    const greeting = buddy.show(screen);
    const now = serverNow();
    const hasOutgoingQuote = visible?.kind === 'quote' && now >= quoteRollAt(visible) && now < quoteDeadline(visible);
    // Roll from the quote actually on this screen. Network transit must not consume its transition.
    const age = layout && !hasOutgoingQuote ? now - quoteRollAt(screen) : 0;
    const expired = layout && now >= quoteDeadline(screen);
    const canRoll = animate && !reduce.matches && !document.hidden && age < quoteRollDuration;
    if (!layout || !canRoll || expired || (roll && outgoing.textContent === layout.lines.join(''))) roll?.finish();
    if (layout && !expired) {
      if (canRoll && !roll) startRoll(age, hasOutgoingQuote);
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
    visible = screen;
    scene.dataset.kind = expired ? 'idle' : screen.kind;
    deadline();
    if (screen.kind === 'qr' && !await ending.show(screen)) return false;
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
    const waitingForGreeting = screen.kind === 'idle' && waveActive(screen.buddyCue, serverNow())
      && !buddy.playingGreeting();
    if (screen.version === current && !waitingForGreeting)
      return Promise.resolve(screen.kind !== 'quote' || serverNow() < quoteDeadline(screen));
    if (wanted === screen.version && inFlight) return inFlight;
    wanted = screen.version;
    if (screen.kind !== 'qr') ending.stop();
    inFlight = draw(screen).finally(() => { if (wanted === screen.version) inFlight = null; });
    return inFlight;
  }
  return { show, greetingReady: buddy.greetingReady };
}
