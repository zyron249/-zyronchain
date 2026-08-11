const yearTargets = document.querySelectorAll('[data-year]');
for (const target of yearTargets) target.textContent = String(new Date().getFullYear());

const externalLinks = document.querySelectorAll('a[target="_blank"]');
for (const link of externalLinks) {
  if (!link.rel.includes('noopener')) link.rel = `${link.rel} noopener`.trim();
}

const revealTargets = document.querySelectorAll('.status-card, .feature-grid article, .launch-steps > div');
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('revealed');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12 });

  for (const target of revealTargets) {
    target.classList.add('reveal-ready');
    observer.observe(target);
  }
}
