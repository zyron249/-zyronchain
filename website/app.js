const yearTargets = document.querySelectorAll('[data-year]');
for (const target of yearTargets) target.textContent = String(new Date().getFullYear());

const externalLinks = document.querySelectorAll('a[target="_blank"]');
for (const link of externalLinks) {
  const rel = new Set(link.rel.split(/\s+/).filter(Boolean));
  rel.add('noopener');
  rel.add('noreferrer');
  link.rel = [...rel].join(' ');
}

const header = document.querySelector('[data-header]');
const updateHeader = () => {
  if (!header) return;
  header.classList.toggle('scrolled', window.scrollY > 12);
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

const copyButton = document.querySelector('[data-copy-target]');
if (copyButton) {
  copyButton.addEventListener('click', async () => {
    const targetId = copyButton.getAttribute('data-copy-target');
    const target = targetId ? document.getElementById(targetId) : null;
    const label = copyButton.querySelector('[data-copy-label]');
    if (!target || !label) return;

    const text = target.innerText.trim();
    try {
      await navigator.clipboard.writeText(text);
      label.textContent = 'Copied';
    } catch {
      label.textContent = 'Select text';
    }
    window.setTimeout(() => { label.textContent = 'Copy'; }, 1600);
  });
}

const revealTargets = document.querySelectorAll(
  '.protocol-card, .security-stack article, .resource-grid a, .launch-item, .metrics article'
);

if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('revealed');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.1, rootMargin: '0px 0px -24px 0px' });

  let delay = 0;
  for (const target of revealTargets) {
    target.classList.add('reveal-ready');
    target.style.transitionDelay = `${Math.min(delay, 180)}ms`;
    observer.observe(target);
    delay = (delay + 35) % 210;
  }
}
