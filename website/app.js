const yearTargets = document.querySelectorAll('[data-year]');
for (const target of yearTargets) target.textContent = String(new Date().getFullYear());

for (const link of document.querySelectorAll('a[target="_blank"]')) {
  const rel = new Set(link.rel.split(/\s+/).filter(Boolean));
  rel.add('noopener');
  rel.add('noreferrer');
  link.rel = [...rel].join(' ');
}

const header = document.querySelector('[data-header]');
const progress = document.querySelector('[data-scroll-progress]');
const navLinks = [...document.querySelectorAll('[data-nav] a[href^="#"]')];

const updateScrollUi = () => {
  if (header) header.classList.toggle('scrolled', window.scrollY > 10);
  if (progress) {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    progress.style.width = `${Math.min(100, (window.scrollY / max) * 100)}%`;
  }

  let current = '';
  for (const link of navLinks) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const target = document.querySelector(href);
    if (target && target.getBoundingClientRect().top <= 150) current = href;
  }
  for (const link of navLinks) link.classList.toggle('active', link.getAttribute('href') === current);
};
updateScrollUi();
window.addEventListener('scroll', updateScrollUi, { passive: true });
window.addEventListener('resize', updateScrollUi, { passive: true });

const menuToggle = document.querySelector('[data-menu-toggle]');
const nav = document.querySelector('[data-nav]');
const closeMenu = () => {
  if (!menuToggle || !nav) return;
  menuToggle.setAttribute('aria-expanded', 'false');
  nav.classList.remove('open');
  document.body.classList.remove('menu-open');
};

if (menuToggle && nav) {
  menuToggle.addEventListener('click', () => {
    const opening = menuToggle.getAttribute('aria-expanded') !== 'true';
    menuToggle.setAttribute('aria-expanded', String(opening));
    nav.classList.toggle('open', opening);
    document.body.classList.toggle('menu-open', opening);
  });
  for (const link of nav.querySelectorAll('a')) link.addEventListener('click', closeMenu);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
}

const switcher = document.querySelector('[data-path-switcher]');
if (switcher) {
  const tabs = [...switcher.querySelectorAll('[data-path]')];
  const panels = [...switcher.querySelectorAll('[data-path-panel]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const name = tab.getAttribute('data-path');
      for (const candidate of tabs) {
        const active = candidate === tab;
        candidate.classList.toggle('active', active);
        candidate.setAttribute('aria-selected', String(active));
      }
      for (const panel of panels) {
        const active = panel.getAttribute('data-path-panel') === name;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      }
    });
  }
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const targetId = button.getAttribute('data-copy');
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) return;
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(target.innerText.trim());
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select text';
    }
    window.setTimeout(() => { button.textContent = original || 'Copy'; }, 1500);
  });
}

const revealTargets = document.querySelectorAll('[data-reveal]');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if ('IntersectionObserver' in window && !reduceMotion) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('revealed');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.06, rootMargin: '0px 0px -28px 0px' });

  for (const target of revealTargets) {
    target.classList.add('reveal-ready');
    observer.observe(target);
  }
} else {
  for (const target of revealTargets) target.classList.add('revealed');
}

/*
 * Holographic experience layer.
 * Purely presentational: local assets only, no network calls, no browser storage.
 */
(() => {
  const hero = document.querySelector('.hero');
  const consoleSurface = document.querySelector('.hero-console');
  if (!hero || !consoleSurface) return;

  const style = document.createElement('style');
  style.dataset.zyronExperience = 'holographic-v1';
  style.textContent = `
    .hero { isolation:isolate; perspective:1400px; }
    .hero::before {
      content:""; position:absolute; z-index:-2; width:min(76vw,980px); aspect-ratio:1;
      right:-22%; top:-36%; border-radius:50%; pointer-events:none;
      background:radial-gradient(circle,rgba(115,255,181,.12) 0%,rgba(84,211,255,.06) 28%,transparent 68%);
      filter:blur(8px); opacity:.9;
    }
    .hero-console { --mx:0deg; --my:0deg; --hx:50%; --hy:50%; position:relative; overflow:hidden; transform-style:preserve-3d;
      transform:rotateX(var(--my)) rotateY(var(--mx)); transition:transform .18s ease-out, border-color .3s ease, box-shadow .3s ease;
      box-shadow:0 40px 110px rgba(0,0,0,.42), inset 0 0 80px rgba(114,255,181,.025);
    }
    .hero-console::before { content:""; position:absolute; inset:0; z-index:8; pointer-events:none;
      background:radial-gradient(420px circle at var(--hx) var(--hy),rgba(157,255,198,.12),transparent 56%); mix-blend-mode:screen; }
    .hero-console::after { content:""; position:absolute; inset:-2px; z-index:9; pointer-events:none; border-radius:inherit;
      background:linear-gradient(120deg,transparent 8%,rgba(183,255,215,.16) 32%,transparent 46%,rgba(105,216,255,.10) 61%,transparent 78%);
      background-size:240% 100%; animation:zyronEdgeSweep 9s linear infinite; opacity:.55; mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0); mask-composite:exclude; padding:1px; }
    .zyron-holo-field { position:absolute; inset:0; z-index:0; overflow:hidden; pointer-events:none; opacity:.94; }
    .zyron-holo-grid { position:absolute; inset:-32%; transform:perspective(800px) rotateX(68deg) translateY(29%); transform-origin:center;
      background-image:linear-gradient(rgba(131,255,188,.075) 1px,transparent 1px),linear-gradient(90deg,rgba(131,255,188,.075) 1px,transparent 1px);
      background-size:34px 34px; mask-image:radial-gradient(circle at center,#000 0%,rgba(0,0,0,.85) 27%,transparent 68%); animation:zyronGridDrift 13s linear infinite; }
    .zyron-holo-aura { position:absolute; width:72%; aspect-ratio:1; left:50%; top:48%; transform:translate(-50%,-50%); border-radius:50%;
      background:radial-gradient(circle,rgba(131,255,187,.11) 0%,rgba(96,225,255,.06) 28%,transparent 68%); filter:blur(9px); animation:zyronAura 5s ease-in-out infinite; }
    .zyron-holo-stage { position:absolute; width:min(61%,360px); aspect-ratio:1; left:50%; top:48%; transform:translate(-50%,-50%); transform-style:preserve-3d; }
    .zyron-holo-ring { position:absolute; inset:8%; border:1px solid rgba(135,255,190,.24); border-radius:50%; box-shadow:0 0 28px rgba(112,255,181,.08),inset 0 0 28px rgba(112,255,181,.05); }
    .zyron-holo-ring.r1 { animation:zyronSpin 18s linear infinite; }
    .zyron-holo-ring.r2 { inset:20%; border-style:dashed; border-color:rgba(119,222,255,.28); animation:zyronSpinReverse 11s linear infinite; }
    .zyron-holo-ring.r3 { inset:31%; border-color:rgba(170,255,208,.30); box-shadow:0 0 42px rgba(117,255,187,.12); animation:zyronPulseRing 4.6s ease-in-out infinite; }
    .zyron-holo-ring::before,.zyron-holo-ring::after { content:""; position:absolute; width:7px; height:7px; border-radius:50%; background:#a4ffca; box-shadow:0 0 15px #8cffb8; }
    .zyron-holo-ring::before { top:-4px; left:50%; } .zyron-holo-ring::after { bottom:12%; right:8%; background:#7ee6ff; box-shadow:0 0 15px #66ddff; }
    .zyron-holo-logo { position:absolute; inset:28%; display:grid; place-items:center; transform-style:preserve-3d; animation:zyronFloat 5.2s ease-in-out infinite; }
    .zyron-holo-logo::before { content:""; position:absolute; inset:-34%; border-radius:50%; background:radial-gradient(circle,rgba(137,255,193,.20),transparent 64%); filter:blur(13px); }
    .zyron-holo-logo img { position:absolute; width:100%; height:100%; object-fit:contain; filter:drop-shadow(0 0 7px rgba(136,255,190,.92)) drop-shadow(0 0 28px rgba(92,224,255,.38)); }
    .zyron-holo-logo img:nth-child(1) { opacity:.17; transform:translate3d(-4px,1px,-24px) scale(1.08); filter:hue-rotate(38deg) drop-shadow(0 0 20px #71dbff); }
    .zyron-holo-logo img:nth-child(2) { opacity:.28; transform:translate3d(4px,-1px,-12px) scale(1.04); filter:hue-rotate(-16deg) drop-shadow(0 0 18px #8cffbd); }
    .zyron-holo-logo img:nth-child(3) { opacity:.90; transform:translateZ(10px); }
    .zyron-holo-scan { position:absolute; left:18%; right:18%; height:1px; top:18%; background:linear-gradient(90deg,transparent,#a7ffd0,transparent); box-shadow:0 0 14px rgba(139,255,196,.7); animation:zyronScan 4.3s ease-in-out infinite; }
    .zyron-particle { position:absolute; width:2px; height:2px; border-radius:50%; background:#a3ffc8; box-shadow:0 0 10px rgba(128,255,186,.85); opacity:.45; animation:zyronParticle var(--d) ease-in-out infinite; animation-delay:var(--delay); }
    .zyron-holo-caption { position:absolute; left:50%; top:76%; transform:translateX(-50%); display:flex; align-items:center; gap:8px; white-space:nowrap;
      font:600 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.16em; color:rgba(201,255,225,.62); }
    .zyron-holo-caption i { width:5px; height:5px; border-radius:50%; background:#8dffb9; box-shadow:0 0 11px #83ffb1; animation:zyronStatus 1.8s ease-in-out infinite; }
    .console-head,.console-grid,.network-orbit { position:relative; z-index:3; }
    .network-orbit { opacity:.74; }
    .network-orbit .core { display:none; }
    .hero-actions a,.mini-button,.text-button { position:relative; overflow:hidden; }
    .hero-actions a::after,.mini-button::after { content:""; position:absolute; inset:-1px; pointer-events:none; background:linear-gradient(105deg,transparent 15%,rgba(255,255,255,.16) 46%,transparent 70%); transform:translateX(-145%); transition:transform .7s cubic-bezier(.2,.7,.2,1); }
    .hero-actions a:hover::after,.mini-button:hover::after { transform:translateX(145%); }
    .protocol-card,.wallet-card,.path-switcher { transition:transform .35s ease,border-color .35s ease,box-shadow .35s ease; }
    .protocol-card:hover { transform:translateY(-3px); border-color:rgba(157,248,191,.24); box-shadow:0 25px 70px rgba(0,0,0,.24); }
    body::after { content:""; position:fixed; width:420px; height:420px; left:var(--cursor-x,-999px); top:var(--cursor-y,-999px); transform:translate(-50%,-50%); z-index:-1; pointer-events:none;
      background:radial-gradient(circle,rgba(113,255,181,.045),transparent 68%); filter:blur(3px); }
    @keyframes zyronEdgeSweep { to { background-position:-240% 0; } }
    @keyframes zyronGridDrift { from { background-position:0 0,0 0; } to { background-position:0 68px,68px 0; } }
    @keyframes zyronAura { 50% { transform:translate(-50%,-50%) scale(1.09); opacity:.72; } }
    @keyframes zyronSpin { to { transform:rotate(360deg); } }
    @keyframes zyronSpinReverse { to { transform:rotate(-360deg); } }
    @keyframes zyronPulseRing { 50% { transform:scale(1.08); opacity:.58; } }
    @keyframes zyronFloat { 50% { transform:translateY(-8px) rotateY(8deg) rotateX(-3deg); } }
    @keyframes zyronScan { 0%,100% { top:21%; opacity:.15; } 50% { top:76%; opacity:.9; } }
    @keyframes zyronParticle { 0%,100% { transform:translate3d(0,8px,0) scale(.6); opacity:.16; } 50% { transform:translate3d(0,-13px,0) scale(1.2); opacity:.8; } }
    @keyframes zyronStatus { 50% { opacity:.38; box-shadow:0 0 4px #83ffb1; } }
    @media (max-width:900px) { .zyron-holo-stage { width:min(57%,310px); } .hero-console { transform:none !important; } }
    @media (max-width:720px) { .zyron-holo-field { opacity:.70; } .zyron-holo-stage { width:min(68%,280px); top:46%; } .zyron-holo-grid { opacity:.55; } body::after { display:none; } }
    @media (prefers-reduced-motion:reduce) {
      .hero-console,.zyron-holo-ring,.zyron-holo-logo,.zyron-holo-scan,.zyron-particle,.zyron-holo-grid,.zyron-holo-aura,.hero-console::after { animation:none !important; transition:none !important; transform:none; }
      .zyron-holo-stage { transform:translate(-50%,-50%); } .zyron-holo-logo { transform:none; } .zyron-holo-scan { top:50%; opacity:.35; }
    }
  `;
  document.head.append(style);

  const field = document.createElement('div');
  field.className = 'zyron-holo-field';
  field.setAttribute('aria-hidden', 'true');
  field.innerHTML = `
    <div class="zyron-holo-grid"></div>
    <div class="zyron-holo-aura"></div>
    <div class="zyron-holo-stage">
      <div class="zyron-holo-ring r1"></div>
      <div class="zyron-holo-ring r2"></div>
      <div class="zyron-holo-ring r3"></div>
      <div class="zyron-holo-logo">
        <img src="./favicon.svg" alt="" />
        <img src="./favicon.svg" alt="" />
        <img src="./favicon.svg" alt="" />
      </div>
      <div class="zyron-holo-scan"></div>
      <div class="zyron-holo-caption"><i></i> ZYRON IDENTITY FIELD / VERIFIED LOCAL ASSET</div>
    </div>
  `;

  const particleFragment = document.createDocumentFragment();
  for (let i = 0; i < 18; i += 1) {
    const particle = document.createElement('i');
    particle.className = 'zyron-particle';
    particle.style.left = `${12 + ((i * 47) % 78)}%`;
    particle.style.top = `${10 + ((i * 31) % 78)}%`;
    particle.style.setProperty('--d', `${3.6 + (i % 6) * .55}s`);
    particle.style.setProperty('--delay', `${-(i % 7) * .48}s`);
    particleFragment.append(particle);
  }
  field.append(particleFragment);
  consoleSurface.prepend(field);

  const finePointer = window.matchMedia('(pointer:fine)').matches;
  if (!reduceMotion && finePointer) {
    let frame = 0;
    let lastX = window.innerWidth / 2;
    let lastY = window.innerHeight / 2;

    const paint = () => {
      frame = 0;
      const rect = consoleSurface.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (lastX - rect.left) / Math.max(1, rect.width)));
      const py = Math.max(0, Math.min(1, (lastY - rect.top) / Math.max(1, rect.height)));
      consoleSurface.style.setProperty('--mx', `${(px - .5) * 5.2}deg`);
      consoleSurface.style.setProperty('--my', `${(.5 - py) * 4.2}deg`);
      consoleSurface.style.setProperty('--hx', `${px * 100}%`);
      consoleSurface.style.setProperty('--hy', `${py * 100}%`);
      document.body.style.setProperty('--cursor-x', `${lastX}px`);
      document.body.style.setProperty('--cursor-y', `${lastY}px`);
    };

    window.addEventListener('pointermove', (event) => {
      lastX = event.clientX;
      lastY = event.clientY;
      if (!frame) frame = window.requestAnimationFrame(paint);
    }, { passive: true });

    consoleSurface.addEventListener('pointerleave', () => {
      consoleSurface.style.setProperty('--mx', '0deg');
      consoleSurface.style.setProperty('--my', '0deg');
      consoleSurface.style.setProperty('--hx', '50%');
      consoleSurface.style.setProperty('--hy', '50%');
    }, { passive: true });
  }
})();
