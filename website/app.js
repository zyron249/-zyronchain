const yearTargets = document.querySelectorAll('[data-year]');
for (const target of yearTargets) target.textContent = String(new Date().getFullYear());

for (const link of document.querySelectorAll('a[target="_blank"]')) {
  const rel = new Set(link.rel.split(/\s+/).filter(Boolean));
  rel.add('noopener');
  rel.add('noreferrer');
  link.rel = [...rel].join(' ');
}

const primaryNav = document.querySelector('[data-nav]');
if (primaryNav && !primaryNav.querySelector('a[href="./mining.html"]')) {
  const miningLink = document.createElement('a');
  miningLink.href = './mining.html';
  miningLink.textContent = 'Mining';
  const networkLink = primaryNav.querySelector('a[href="#status"]');
  primaryNav.insertBefore(miningLink, networkLink ?? null);
}

const tokenSection = document.getElementById('token');
if (tokenSection && !tokenSection.querySelector('a[href="./mining.html"]')) {
  const copy = tokenSection.querySelector('.feature-copy');
  if (copy) {
    const miningCta = document.createElement('a');
    miningCta.href = './mining.html';
    miningCta.textContent = 'Open Mining Launchpad →';
    copy.appendChild(miningCta);
  }
}

const heroSymbol = document.querySelector('.hero-symbol');
if (heroSymbol && !heroSymbol.querySelector('[data-hologram-stage]')) {
  if (!document.querySelector('link[href="./hologram.css"]')) {
    const hologramStyles = document.createElement('link');
    hologramStyles.rel = 'stylesheet';
    hologramStyles.href = './hologram.css';
    document.head.appendChild(hologramStyles);
  }

  heroSymbol.classList.add('hologram-host');
  const stage = document.createElement('div');
  stage.className = 'hologram-stage';
  stage.dataset.hologramStage = '';
  stage.setAttribute('role', 'img');
  stage.setAttribute('aria-label', 'ZyronChain holographic network artwork');

  const rotor = document.createElement('div');
  rotor.className = 'hologram-rotor';

  const card = document.createElement('div');
  card.className = 'hologram-card';

  const image = document.createElement('img');
  image.src = './zyron-hologram.webp';
  image.alt = '';
  image.width = 320;
  image.height = 320;
  image.decoding = 'async';
  image.fetchPriority = 'high';
  card.appendChild(image);
  rotor.appendChild(card);

  const base = document.createElement('div');
  base.className = 'hologram-base';
  base.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'hologram-label';
  label.textContent = 'ZyronChain · Verifiable Layer-1';

  stage.append(rotor, base, label);
  heroSymbol.replaceChildren(stage);

  const hologramReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!hologramReducedMotion) {
    let frame = 0;
    stage.addEventListener('pointermove', (event) => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = stage.getBoundingClientRect();
        const x = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) - 0.5;
        const y = ((event.clientY - bounds.top) / Math.max(1, bounds.height)) - 0.5;
        stage.style.transform = `rotateX(${(-y * 4).toFixed(2)}deg) rotateY(${(x * 4).toFixed(2)}deg)`;
      });
    }, { passive: true });
    stage.addEventListener('pointerleave', () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { stage.style.transform = ''; });
    }, { passive: true });
  }
}

const header = document.querySelector('[data-header]');
const progress = document.querySelector('[data-scroll-progress]');
const navLinks = [...document.querySelectorAll('[data-nav] a[href^="#"]')];

const updateScrollUi = () => {
  if (header) header.classList.toggle('scrolled', window.scrollY > 8);
  if (progress) {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    progress.style.width = `${Math.min(100, (window.scrollY / max) * 100)}%`;
  }

  let current = '';
  for (const link of navLinks) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const target = document.querySelector(href);
    if (target && target.getBoundingClientRect().top <= 130) current = href;
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

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const targetId = button.getAttribute('data-copy');
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) return;
    const original = button.textContent || 'Copy';
    try {
      await navigator.clipboard.writeText(target.innerText.trim());
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select text';
    }
    window.setTimeout(() => { button.textContent = original; }, 1500);
  });
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const revealTargets = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window && !reduceMotion) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('revealed');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08, rootMargin: '0px 0px -26px 0px' });

  for (const target of revealTargets) {
    target.classList.add('reveal-ready');
    observer.observe(target);
  }
} else {
  for (const target of revealTargets) target.classList.add('revealed');
}
