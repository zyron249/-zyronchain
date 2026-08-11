const yearTargets = document.querySelectorAll('[data-year]');
for (const target of yearTargets) target.textContent = String(new Date().getFullYear());

for (const link of document.querySelectorAll('a[target="_blank"]')) {
  const rel = new Set(link.rel.split(/\s+/).filter(Boolean));
  rel.add('noopener');
  rel.add('noreferrer');
  link.rel = [...rel].join(' ');
}

const header = document.querySelector('[data-header]');
const updateHeader = () => {
  if (header) header.classList.toggle('scrolled', window.scrollY > 10);
};
updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });

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

const revealTargets = document.querySelectorAll('[data-reveal]');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if ('IntersectionObserver' in window && !reduceMotion) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('revealed');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });

  for (const target of revealTargets) {
    target.classList.add('reveal-ready');
    observer.observe(target);
  }
} else {
  for (const target of revealTargets) target.classList.add('revealed');
}
