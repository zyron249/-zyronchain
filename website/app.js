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
  stage.setAttribute('aria-label', 'Rotating Zyron currency symbol');

  const coin = document.createElement('div');
  coin.className = 'zyron-coin';

  const makeFace = (className) => {
    const face = document.createElement('div');
    face.className = className;
    const mark = document.createElement('span');
    mark.className = 'zyron-mark';
    mark.setAttribute('aria-hidden', 'true');
    face.appendChild(mark);
    return face;
  };

  coin.append(makeFace('zyron-coin-face'), makeFace('zyron-coin-back'));

  const base = document.createElement('div');
  base.className = 'hologram-base';
  base.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'hologram-label';
  label.textContent = 'ZyronChain · Verifiable Layer-1';

  stage.append(coin, base, label);
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
        stage.style.transform = `rotateX(${(-y * 3).toFixed(2)}deg) rotateY(${(x * 3).toFixed(2)}deg)`;
      });
    }, { passive: true });
    stage.addEventListener('pointerleave', () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { stage.style.transform = ''; });
    });
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

// One-click distribution is deliberately fail-closed. A future website-only
// release PR may replace null asset URLs/digests only after independently
// reviewed, signed/notarized immutable release assets exist and public mining
// activation is explicitly allowed. The website never handles miner custody.
const miningStart = document.getElementById('start');
if (miningStart && document.title.includes('Mining Launchpad')) {
  const MINER_DISTRIBUTION = Object.freeze({
    enabled: false,
    publicMiningActivated: false,
    version: null,
    assets: Object.freeze({ windows: null, macos: null, linux: null }),
    assetSha256: Object.freeze({ windows: null, macos: null, linux: null })
  });

  const platformText = `${navigator.userAgentData?.platform || navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
  const detectedPlatform = platformText.includes('win')
    ? 'windows'
    : platformText.includes('mac') || platformText.includes('darwin')
      ? 'macos'
      : platformText.includes('linux')
        ? 'linux'
        : 'unknown';

  const platformLabel = detectedPlatform === 'windows'
    ? 'Windows'
    : detectedPlatform === 'macos'
      ? 'macOS'
      : detectedPlatform === 'linux'
        ? 'Linux'
        : 'your operating system';

  const asset = detectedPlatform === 'unknown' ? null : MINER_DISTRIBUTION.assets[detectedPlatform];
  const assetDigest = detectedPlatform === 'unknown' ? null : MINER_DISTRIBUTION.assetSha256[detectedPlatform];
  const trustedReleaseAsset = typeof asset === 'string' && /^https:\/\/github\.com\/zyron249\/-zyronchain\/releases\/download\/[^/]+\/ZyronMiner-[A-Za-z0-9._-]+$/.test(asset);
  const trustedAssetDigest = typeof assetDigest === 'string' && /^[0-9a-f]{64}$/.test(assetDigest);
  const live = MINER_DISTRIBUTION.enabled === true && MINER_DISTRIBUTION.publicMiningActivated === true && trustedReleaseAsset && trustedAssetDigest;

  const shell = document.createElement('div');
  shell.className = 'shell command-card';
  shell.setAttribute('aria-label', 'One-click miner download status');

  const head = document.createElement('div');
  head.className = 'command-head';
  const title = document.createElement('span');
  title.textContent = `AUTO-DETECTED · ${platformLabel.toUpperCase()}`;
  const state = document.createElement('strong');
  state.textContent = live ? 'READY' : 'ACTIVATION GATED';
  head.append(title, state);

  const description = document.createElement('p');
  description.textContent = live
    ? `Download the reviewed ZyronMiner package for ${platformLabel}. Opening or running downloaded software still requires operating-system/user consent.`
    : `One-click ${platformLabel} distribution is prepared but remains disabled until immutable signed release assets exist and public mining is explicitly activated.`;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary-button';
  button.textContent = live ? `Download Zyron Miner for ${platformLabel}` : 'Miner download not yet activated';
  button.disabled = !live;
  button.setAttribute('aria-disabled', String(!live));
  if (live) {
    button.addEventListener('click', () => {
      window.location.assign(asset);
    });
  }

  const checksum = document.createElement('p');
  checksum.className = 'mining-note';
  checksum.textContent = live
    ? `Expected SHA-256: ${assetDigest}`
    : 'Artifact SHA-256 remains unpublished while miner distribution is activation-gated.';

  const privacy = document.createElement('p');
  privacy.className = 'mining-note';
  privacy.textContent = 'This website never requests a private key, seed phrase, wallet password, browser-mining permission, or permission to execute downloaded software.';

  shell.append(head, description, button, checksum, privacy);
  const existingCard = miningStart.querySelector('.command-card');
  if (existingCard) existingCard.before(shell);
  else miningStart.appendChild(shell);
}
