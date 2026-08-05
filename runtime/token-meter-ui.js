((cssText) => {
  const VERSION = 1;
  const existing = window.__tokenMeter;
  if (existing?.version === VERSION) {
    existing.ensureMounted();
    return { mounted: true, reused: true, version: VERSION };
  }
  existing?.destroy?.();

  const host = document.createElement("div");
  host.id = "token-meter-host";
  host.setAttribute("data-token-meter-version", String(VERSION));
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = cssText;
  shadow.append(style);

  const card = document.createElement("section");
  card.className = "meter-card";
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  card.innerHTML = `
    <header class="meter-header">
      <span class="live-dot" aria-hidden="true"></span>
      <span class="meter-title">TOKEN METER</span>
      <span class="session-id">UNBOUND</span>
    </header>
    <div class="meter-body">
      <div class="gauge" aria-hidden="true">
        <svg viewBox="0 0 124 66">
          <path class="gauge-track" d="M12 54 A50 50 0 0 1 112 54" />
          <path class="gauge-progress" d="M12 54 A50 50 0 0 1 112 54" />
          <line class="needle" x1="62" y1="54" x2="62" y2="15" />
          <circle class="needle-pin" cx="62" cy="54" r="4" />
        </svg>
        <span class="rate">0/min</span>
      </div>
      <div class="session-total-wrap">
        <span class="label">SESSION</span>
        <strong class="session-total">0</strong>
        <span class="agent-count"></span>
      </div>
    </div>
    <div class="metric-row">
      <span><small>1H SESSION</small><b class="hour-total">0</b></span>
      <span><small>CURRENT TURN</small><b class="turn-total">0</b></span>
    </div>
    <div class="details-row">
      <span>All sessions · 1H</span><b class="account-hour">0</b>
      <span>Historical baseline</span><b class="baseline">Learning</b>
    </div>
    <div class="warning" hidden>
      <strong>Unusually high token rate</strong>
      <span>Context pollution or a retry loop may be present. Consider a new session.</span>
    </div>
    <div class="unbound" hidden>
      <strong>SESSION UNKNOWN</strong>
      <span>The meter will not guess which session is active.</span>
    </div>
  `;
  shadow.append(card);

  const elements = {
    sessionId: card.querySelector(".session-id"),
    sessionTotal: card.querySelector(".session-total"),
    hourTotal: card.querySelector(".hour-total"),
    turnTotal: card.querySelector(".turn-total"),
    accountHour: card.querySelector(".account-hour"),
    rate: card.querySelector(".rate"),
    baseline: card.querySelector(".baseline"),
    agentCount: card.querySelector(".agent-count"),
    needle: card.querySelector(".needle"),
    progress: card.querySelector(".gauge-progress"),
    warning: card.querySelector(".warning"),
    unbound: card.querySelector(".unbound"),
  };
  const displayed = new Map();
  const animations = new Map();
  let currentSessionId = null;
  let lastSessionTotal = 0;
  let lastRate = null;

  const format = (value) => {
    const number = Math.max(0, Number(value) || 0);
    if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
    if (number >= 10_000) return `${Math.round(number / 1_000)}K`;
    return Math.round(number).toLocaleString();
  };

  const animateNumber = (key, element, target, immediate = false) => {
    animations.get(key)?.cancel?.();
    const from = immediate ? target : displayed.get(key) ?? target;
    if (!immediate && Math.abs(from - target) < 0.5) {
      displayed.set(key, target);
      element.textContent = format(target);
      return;
    }
    const started = performance.now();
    const duration = immediate ? 0 : 520;
    let cancelled = false;
    const animation = { cancel: () => (cancelled = true) };
    animations.set(key, animation);

    const frame = (now) => {
      if (cancelled) return;
      const progress = duration === 0 ? 1 : Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = from + (target - from) * eased;
      displayed.set(key, value);
      element.textContent = format(value);
      if (progress < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };

  const animateNeedle = (intensity) => {
    const angle = -100 + Math.min(1, Math.max(0, intensity)) * 200;
    elements.needle.animate(
      [
        { transform: elements.needle.style.transform || "rotate(-100deg)" },
        { transform: `rotate(${angle + Math.min(7, intensity * 5)}deg)` },
        { transform: `rotate(${angle}deg)` },
      ],
      { duration: 620, easing: "cubic-bezier(.2,.9,.25,1)", fill: "forwards" },
    );
    elements.needle.style.transform = `rotate(${angle}deg)`;
    elements.progress.style.strokeDashoffset = String(157 * (1 - intensity));
  };

  const ensureMounted = () => {
    if (!host.isConnected && document.documentElement) {
      document.documentElement.append(host);
    }
  };

  const update = (snapshot) => {
    ensureMounted();
    const bound = snapshot?.status === "bound" && snapshot?.binding?.exact;
    card.dataset.bound = String(bound);
    elements.unbound.hidden = bound;
    if (!bound) {
      elements.warning.hidden = true;
      elements.sessionId.textContent = "UNBOUND";
      card.dataset.level = "learning";
      return;
    }

    const sessionChanged = currentSessionId !== snapshot.sessionId;
    if (sessionChanged) {
      currentSessionId = snapshot.sessionId;
      card.classList.remove("session-switch");
      void card.offsetWidth;
      card.classList.add("session-switch");
      displayed.clear();
      lastSessionTotal = snapshot.session.totalTokens;
    }
    elements.sessionId.textContent = snapshot.sessionId.slice(-8).toUpperCase();
    const delta = Math.max(0, snapshot.session.totalTokens - lastSessionTotal);
    lastSessionTotal = snapshot.session.totalTokens;
    if (delta > 0 && !sessionChanged) {
      card.style.setProperty("--impact", String(Math.min(1, delta / 100_000)));
      card.classList.remove("usage-impact");
      void card.offsetWidth;
      card.classList.add("usage-impact");
    }

    animateNumber("session", elements.sessionTotal, snapshot.session.totalTokens, sessionChanged);
    animateNumber("hour", elements.hourTotal, snapshot.session.lastHourTokens, sessionChanged);
    animateNumber("turn", elements.turnTotal, snapshot.turn.tokens, sessionChanged);
    animateNumber("account", elements.accountHour, snapshot.account.lastHourTokens, sessionChanged);

    const rate = snapshot.rate.tokensPerMinute;
    const median = snapshot.anomaly.baseline.medianTokensPerMinute || 0;
    const p95 = snapshot.anomaly.baseline.p95TokensPerMinute || 0;
    const scale = Math.max(10_000, p95, median * 3, rate);
    const intensity = Math.min(1, rate / scale);
    elements.rate.textContent = `${format(rate)}/min`;
    elements.baseline.textContent = median ? `${format(median)}/min` : "Learning";
    elements.agentCount.textContent = snapshot.childAgentCount
      ? `+${snapshot.childAgentCount} agent${snapshot.childAgentCount === 1 ? "" : "s"}`
      : "";
    if (lastRate == null || Math.abs(lastRate - rate) >= 1) {
      animateNeedle(intensity);
      lastRate = rate;
    }

    card.dataset.level = snapshot.anomaly.level;
    elements.warning.hidden = !["warning", "critical"].includes(snapshot.anomaly.level);
  };

  const destroy = () => {
    for (const animation of animations.values()) animation.cancel();
    host.remove();
    if (window.__tokenMeter?.version === VERSION) delete window.__tokenMeter;
  };

  card.addEventListener("click", () => card.classList.toggle("expanded"));
  const observer = new MutationObserver(ensureMounted);
  observer.observe(document, { childList: true, subtree: true });
  const originalDestroy = destroy;
  const destroyWithObserver = () => {
    observer.disconnect();
    originalDestroy();
  };
  window.__tokenMeter = {
    version: VERSION,
    update,
    ensureMounted,
    destroy: destroyWithObserver,
  };
  ensureMounted();
  return { mounted: true, reused: false, version: VERSION };
})(__TOKEN_METER_CSS_JSON__)
