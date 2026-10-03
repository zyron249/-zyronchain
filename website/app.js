// ZyronChain static site: progressive enhancement only. Every page works without this script.
// No network requests, no storage, no analytics. Mining is retired: no miner download or CTA exists here.

for (const target of document.querySelectorAll('[data-year]')) target.textContent = String(new Date().getFullYear());

for (const link of document.querySelectorAll('a[target="_blank"]')) {
  const rel = new Set(link.rel.split(/\s+/).filter(Boolean));
  rel.add('noopener');
  rel.add('noreferrer');
  link.rel = [...rel].join(' ');
}

// Legacy pages (wallet / validator / legal) still use the toggle menu; the homepage nav is pure HTML/CSS.
const menuToggle = document.querySelector('[data-menu-toggle]');
const nav = document.querySelector('[data-nav]');
if (menuToggle && nav) {
  const closeMenu = () => {
    menuToggle.setAttribute('aria-expanded', 'false');
    nav.classList.remove('open');
    document.body.classList.remove('menu-open');
  };
  menuToggle.addEventListener('click', () => {
    const opening = menuToggle.getAttribute('aria-expanded') !== 'true';
    menuToggle.setAttribute('aria-expanded', String(opening));
    nav.classList.toggle('open', opening);
    document.body.classList.toggle('menu-open', opening);
  });
  for (const link of nav.querySelectorAll('a')) link.addEventListener('click', closeMenu);
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
}

const header = document.querySelector('[data-header]');
if (header) {
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

// Copy buttons for public commands only (never for secrets).
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.getAttribute('data-copy') || '');
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
