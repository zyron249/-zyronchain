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
