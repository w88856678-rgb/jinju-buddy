const view = new URLSearchParams(location.search).get('view');
const status = document.getElementById('status');
const retry = document.getElementById('retry');
const video = document.querySelector('video');
const reduce = matchMedia('(prefers-reduced-motion: reduce)');

async function openExperience() {
  status.hidden = false;
  retry.hidden = true;
  status.textContent = view === 'control' ? '正在连接体验控台…' : '正在连接观众屏…';
  try {
    const reply = await fetch('./connection.json?t=' + Date.now(), {cache: 'no-store', signal: AbortSignal.timeout(9000)});
    if (!reply.ok) throw new Error();
    const {origin, event} = await reply.json();
    const backend = new URL(origin);
    if (backend.protocol !== 'https:' || backend.origin !== origin || !/^[a-z0-9-]+$/.test(event)) throw new Error();
    await new Promise((ok, fail) => {
      const probe = new Image();
      const timer = setTimeout(() => fail(new Error()), 9000);
      probe.onload = () => { clearTimeout(timer); ok(); };
      probe.onerror = () => { clearTimeout(timer); fail(new Error()); };
      probe.referrerPolicy = 'no-referrer';
      probe.src = new URL('/static/assets/red-flower.png?ping=' + Date.now(), origin).href;
    });
    const target = new URL('/e/' + event + '/' + view, origin);
    if (view === 'stage') target.searchParams.set('look', 'dark');
    location.replace(target.href);
  } catch {
    status.textContent = '实时服务暂时连接不上，可以重试，或先看下方的观众屏实录。';
    retry.hidden = false;
  }
}
retry.addEventListener('click', openExperience);
if (view === 'control' || view === 'stage') {
  openExperience();
} else if (!reduce.matches) {
  video.play().catch(() => {});
}
reduce.addEventListener('change', () => { if (reduce.matches) video.pause(); });
