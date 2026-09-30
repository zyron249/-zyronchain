const token = document.querySelector('meta[name="zyron-ui-token"]').content;
const els = Object.fromEntries([
  'connectionPill','activationNotice','walletAddress','startButton','stopButton','hashrate','height','miningHeight',
  'difficulty','submitted','rejected','balance','uptime','chainId','rpcUrl','reward','statusMessage','nodeVersion',
  'buildReady','depsReady','launcherReady','logs','errorText'
].map((id) => [id, document.getElementById(id)]));

let latest = null;

els.startButton.addEventListener('click', () => mutate('/api/start'));
els.stopButton.addEventListener('click', () => mutate('/api/stop'));

bootstrap();

async function bootstrap() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    render(await response.json());
  } catch (error) {
    els.errorText.textContent = error.message;
  }
  const events = new EventSource('/events');
  events.onmessage = (event) => render(JSON.parse(event.data));
  events.onerror = () => {
    els.connectionPill.textContent = '● UI disconnected';
    els.connectionPill.className = 'status-pill danger';
  };
  setInterval(() => {
    if (latest) render({ ...latest, uptimeSeconds: latest.startedAt ? Math.floor((Date.now() - latest.startedAt) / 1000) : 0 });
  }, 1000);
}

async function mutate(path) {
  els.errorText.textContent = '';
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'x-zyron-ui-token': token }
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    render(body);
  } catch (error) {
    els.errorText.textContent = error.message;
  }
}

function render(state) {
  latest = state;
  const active = state.activation?.publicMiningActivated === true;
  const ready = active && state.prerequisites?.launcher && state.prerequisites?.build && state.prerequisites?.nodeModules;

  els.connectionPill.textContent = state.running
    ? (state.connected ? '● Connected' : '● Starting / reconnecting')
    : '● Offline';
  els.connectionPill.className = `status-pill ${state.connected ? 'good' : state.running ? 'warn' : ''}`;

  els.activationNotice.hidden = active;
  els.activationNotice.textContent = state.activation?.profileError
    ? `Miner profile error: ${state.activation.profileError}`
    : 'Public mining is activation-gated. This development UI will not bypass the canonical network profile.';

  els.walletAddress.textContent = state.address || 'Not created yet';
  els.startButton.disabled = state.running || !ready;
  els.stopButton.disabled = !state.running;

  els.hashrate.textContent = formatRate(state.hashRate || 0);
  els.height.textContent = numberOrDash(state.finalizedHeight);
  els.miningHeight.textContent = numberOrDash(state.currentMiningHeight);
  els.difficulty.textContent = state.difficultyBits ? `${state.difficultyBits} bits` : '—';
  els.submitted.textContent = state.submitted ?? 0;
  els.rejected.textContent = state.rejected ?? 0;
  els.balance.textContent = state.balanceZyn == null ? '—' : `${formatZyn(state.balanceZyn)} ZYN`;
  els.uptime.textContent = formatDuration(state.uptimeSeconds || 0);
  els.chainId.textContent = state.chainId || state.activation?.chainId || '—';
  els.rpcUrl.textContent = state.rpcUrl || state.activation?.rpcUrl || '—';
  els.reward.textContent = state.currentRewardZyn == null ? '—' : `${formatZyn(state.currentRewardZyn)} ZYN`;
  els.statusMessage.textContent = state.lastMessage || 'Ready';
  els.nodeVersion.textContent = state.prerequisites?.nodeVersion || '—';
  els.buildReady.textContent = yesNo(state.prerequisites?.build);
  els.depsReady.textContent = yesNo(state.prerequisites?.nodeModules);
  els.launcherReady.textContent = yesNo(state.prerequisites?.launcher);
  els.errorText.textContent = state.lastError || els.errorText.textContent || '';

  const lines = (state.logs || []).slice(-60).map((entry) => {
    const time = new Date(entry.at).toLocaleTimeString();
    return `${time}  ${entry.message}`;
  });
  els.logs.textContent = lines.length ? lines.join('\n') : 'Waiting for miner…';
  els.logs.scrollTop = els.logs.scrollHeight;
}

function formatRate(value) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GH/s`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MH/s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} kH/s`;
  return `${Math.round(value)} H/s`;
}

function formatZyn(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function numberOrDash(value) {
  return Number.isSafeInteger(value) ? value.toLocaleString() : '—';
}

function yesNo(value) {
  return value ? 'Ready' : 'Missing';
}
