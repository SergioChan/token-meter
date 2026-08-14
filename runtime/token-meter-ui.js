((cssText) => {
  const VERSION = 11;
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
      <span class="meter-title">TOKEN WIDGET</span>
      <span class="session-id">UNBOUND</span>
      <button class="settings-toggle" type="button" aria-label="Token Widget settings" title="Settings" hidden>
        <span aria-hidden="true">⚙</span>
      </button>
      <button class="collapse-toggle" type="button" aria-label="Collapse Token Widget" title="Collapse Token Widget" hidden>
        <span aria-hidden="true">−</span>
      </button>
    </header>
    <div class="meter-body">
      <div class="gauge" aria-hidden="true">
        <svg viewBox="0 0 124 66">
          <defs>
            <linearGradient id="token-meter-rate-gradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="#5f9d7c" />
              <stop offset="46%" stop-color="#5f9d7c" />
              <stop offset="54%" stop-color="#d3a62b" />
              <stop offset="68%" stop-color="#d3a62b" />
              <stop offset="76%" stop-color="#dd702c" />
              <stop offset="84%" stop-color="#dd702c" />
              <stop offset="92%" stop-color="#d64235" />
              <stop offset="100%" stop-color="#d64235" />
            </linearGradient>
          </defs>
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
        <span class="session-meta">
          <span class="agent-count"></span>
          <span class="usage-delta" aria-hidden="true"></span>
        </span>
      </div>
    </div>
    <div class="metric-row bottom-toggle" title="Click for session details">
      <span><small>24H TOTAL</small><b class="day-total">—</b></span>
      <span><small>CURRENT STREAK</small><b class="streak">—</b></span>
    </div>
    <div class="context-row bottom-toggle" title="Click for session details">
      <span>
        <small>LIFETIME TOKENS</small>
        <b class="lifetime">—</b>
      </span>
      <em class="stats-hint" aria-hidden="true">···</em>
    </div>
    <div class="details-row stats-panel bottom-toggle" title="Click to go back" hidden>
      <span>Current turn</span><b class="turn-total">0</b>
      <span>Active context</span><b><span class="context-total">0</span><i class="context-extra"></i></b>
      <span>All sessions · 1H</span><b class="account-hour">0</b>
      <span>Historical baseline</span><b class="baseline">Learning</b>
      <span>Context compactions</span><b class="compaction-count">0</b>
    </div>
    <section class="skills-panel" aria-label="Session skills">
      <div class="skills-heading">
        <span>SESSION SKILLS</span>
        <span class="skills-controls">
          <b class="skills-summary">—</b>
          <button class="skills-reveal" type="button" aria-expanded="false" aria-label="Show skill names" title="Show skill names" hidden>
            <span class="skills-reveal-label">SHOW NAMES</span>
            <span class="skills-reveal-icon" aria-hidden="true">+</span>
          </button>
        </span>
      </div>
      <div class="skill-lights" role="list"></div>
    </section>
    <div class="warning" hidden>
      <strong>Unusually high token rate</strong>
      <span>Context pollution or a retry loop may be present. Consider a new session.</span>
    </div>
    <div class="update-banner" hidden role="button" tabindex="0" title="Download the update">
      <strong class="update-title">Update ready</strong>
      <span class="update-sub">Click to download the new version.</span>
      <button class="update-dismiss" type="button" aria-label="Dismiss update notice">&times;</button>
    </div>
    <div class="unbound" hidden>
      <strong>SESSION UNKNOWN</strong>
      <span>The meter will not guess which session is active.</span>
    </div>
    <div class="meter-settings" hidden>
      <div class="settings-identity">
        <button class="settings-power" type="button" aria-label="Turn off Token Widget">&#9211;</button>
        <small>IDENTITY</small>
        <button class="settings-identity-link" type="button" hidden>@—</button>
        <span class="settings-anon">Anonymous meter</span>
      </div>
      <button class="settings-claim" type="button" hidden>Claim your @handle</button>
      <button class="settings-action-row settings-share" type="button">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        <span>Refer friends</span>
      </button>
      <button class="settings-action-row settings-dashboard" type="button">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="20" x2="6" y2="14"/><line x1="12" y1="20" x2="12" y2="8"/><line x1="18" y1="20" x2="18" y2="4"/></svg>
        <span>Your dashboard</span>
      </button>
      <button class="settings-action-row settings-leaderboard" type="button">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v6a5 5 0 0 1-10 0z"/><path d="M17 5h3a2 2 0 0 1-2 4"/><path d="M7 5H4a2 2 0 0 0 2 4"/></svg>
        <span>Check your ranking</span>
      </button>
      <div class="settings-privacy" role="radiogroup" aria-label="Data sharing">
        <button type="button" class="privacy-opt privacy-local active" aria-pressed="true">Data stays local</button>
        <button type="button" class="privacy-opt privacy-share" aria-pressed="false">Share with community</button>
      </div>
      <p class="settings-tip" aria-live="polite"></p>
    </div>
  `;
  shadow.append(card);

  const elements = {
    header: card.querySelector(".meter-header"),
    gauge: card.querySelector(".gauge"),
    sessionId: card.querySelector(".session-id"),
    sessionTotal: card.querySelector(".session-total"),
    dayTotal: card.querySelector(".day-total"),
    streak: card.querySelector(".streak"),
    lifetime: card.querySelector(".lifetime"),
    statsPanel: card.querySelector(".stats-panel"),
    turnTotal: card.querySelector(".turn-total"),
    contextTotal: card.querySelector(".context-total"),
    contextExtra: card.querySelector(".context-extra"),
    compactionCount: card.querySelector(".compaction-count"),
    accountHour: card.querySelector(".account-hour"),
    rate: card.querySelector(".rate"),
    baseline: card.querySelector(".baseline"),
    agentCount: card.querySelector(".agent-count"),
    usageDelta: card.querySelector(".usage-delta"),
    collapseToggle: card.querySelector(".collapse-toggle"),
    settingsToggle: card.querySelector(".settings-toggle"),
    settingsPanel: card.querySelector(".meter-settings"),
    settingsIdentityLink: card.querySelector(".settings-identity-link"),
    settingsAnon: card.querySelector(".settings-anon"),
    settingsShare: card.querySelector(".settings-share"),
    settingsDashboard: card.querySelector(".settings-dashboard"),
    settingsLeaderboard: card.querySelector(".settings-leaderboard"),
    settingsPrivacy: card.querySelector(".settings-privacy"),
    settingsClaim: card.querySelector(".settings-claim"),
    settingsPower: card.querySelector(".settings-power"),
    settingsTip: card.querySelector(".settings-tip"),
    privacyLocal: card.querySelector(".privacy-local"),
    privacyShare: card.querySelector(".privacy-share"),
    needle: card.querySelector(".needle"),
    progress: card.querySelector(".gauge-progress"),
    warning: card.querySelector(".warning"),
    unbound: card.querySelector(".unbound"),
    skillsPanel: card.querySelector(".skills-panel"),
    skillsSummary: card.querySelector(".skills-summary"),
    skillsReveal: card.querySelector(".skills-reveal"),
    skillLights: card.querySelector(".skill-lights"),
    updateBanner: card.querySelector(".update-banner"),
    updateTitle: card.querySelector(".update-title"),
    updateSub: card.querySelector(".update-sub"),
    updateDismiss: card.querySelector(".update-dismiss"),
  };
  const displayed = new Map();
  const animations = new Map();
  let currentSessionId = null;
  let lastSessionTotal = 0;
  let lastRate = null;
  let deltaTimer = null;
  let collapsible = false;
  let collapsed = false;
  // Reassigned by the settings block below; collapsing must always close settings
  // so the two exclusive body views can never both be hidden.
  let closeSettings = () => {};
  let draggable = false;
  let storageKey = null;
  let position = null;
  let dragState = null;
  let skillLabelsVisible = false;

  const format = (value) => {
    const number = Math.max(0, Number(value) || 0);
    if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(3)}B`;
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(3)}M`;
    if (number >= 100_000) return `${(number / 1_000).toFixed(1)}K`;
    if (number >= 10_000) return `${(number / 1_000).toFixed(1)}K`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(2)}K`;
    return Math.round(number).toLocaleString();
  };

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

  const setSkillLabelsVisible = (value) => {
    skillLabelsVisible = value === true;
    elements.skillsPanel.classList.toggle("labels-visible", skillLabelsVisible);
    elements.skillsReveal.setAttribute("aria-expanded", String(skillLabelsVisible));
    const action = skillLabelsVisible ? "Hide" : "Show";
    elements.skillsReveal.setAttribute("aria-label", `${action} skill names`);
    elements.skillsReveal.title = `${action} skill names`;
    elements.skillsReveal.querySelector(".skills-reveal-label").textContent =
      `${action.toUpperCase()} NAMES`;
    elements.skillsReveal.querySelector(".skills-reveal-icon").textContent =
      skillLabelsVisible ? "−" : "+";
    return skillLabelsVisible;
  };

  const skillIconFor = (name) => {
    const value = String(name).toLowerCase();
    if (value === "imagegen") return { family: "image", symbol: "✦" };
    if (value === "openai-docs") return { family: "openai", symbol: "◎" };
    if (value === "plugin-creator") return { family: "plugin", symbol: "◇" };
    if (value === "skill-creator") return { family: "skill", symbol: "✣" };
    if (value === "skill-installer") return { family: "installer", symbol: "↓" };
    if (value.startsWith("browser:")) return { family: "browser", symbol: "◉" };
    if (value.startsWith("chrome:")) return { family: "chrome", symbol: "◌" };
    if (value === "commons") return { family: "commons", symbol: "↔" };
    if (value.startsWith("computer-use:")) return { family: "computer", symbol: "▣" };
    if (value.startsWith("documents:")) return { family: "documents", symbol: "▤" };
    if (value.startsWith("figma:")) return { family: "figma", symbol: "F" };
    if (value.startsWith("github:")) return { family: "github", symbol: "◒" };
    if (value.startsWith("gmail:")) return { family: "gmail", symbol: "✉" };
    if (value.startsWith("google-calendar:")) return { family: "calendar", symbol: "▦" };
    if (value.startsWith("pdf:")) return { family: "pdf", symbol: "PDF" };
    if (value.startsWith("presentations:")) return { family: "presentations", symbol: "▰" };
    if (value.startsWith("sites:")) return { family: "sites", symbol: "⌂" };
    if (value.startsWith("slack:")) return { family: "slack", symbol: "✣" };
    if (value.startsWith("spreadsheets:")) return { family: "spreadsheets", symbol: "▦" };
    if (value.startsWith("template-creator:")) return { family: "template", symbol: "▥" };
    if (value.startsWith("visualize:")) return { family: "visualize", symbol: "◉" };
    const initial = value.match(/[a-z0-9]/)?.[0]?.toUpperCase() ?? "?";
    return { family: "generic", symbol: initial };
  };

  const renderSkills = (skills) => {
    const items = Array.isArray(skills?.items) ? skills.items : [];
    const loadedCount = items.filter((item) => item?.status === "loaded").length;
    const notLoadedCount = items.length - loadedCount;
    elements.skillsSummary.textContent = skills?.status === "loaded"
      ? `${loadedCount} loaded${notLoadedCount ? ` · ${notLoadedCount} not loaded` : ""}`
      : "—";
    elements.skillsReveal.hidden = items.length === 0;
    elements.skillLights.replaceChildren();
    for (const item of items) {
      const status = item?.status === "loaded" ? "loaded" : "not-loaded";
      const icon = skillIconFor(item?.name);
      const light = document.createElement("span");
      light.className = "skill-light";
      light.dataset.status = status;
      light.dataset.family = icon.family;
      light.setAttribute("role", "listitem");
      light.title = item.name;
      light.setAttribute("aria-label", `${item.name}: Skill status ${status}`);
      light.innerHTML = `
        <span class="skill-logo" data-family="${icon.family}" data-icon="${escapeHtml(icon.symbol)}" title="${escapeHtml(item.name)}" tabindex="0" role="img" aria-label="${escapeHtml(item.name)}">
          <i class="skill-status-dot"></i>
        </span>
        <b class="skill-name">${escapeHtml(item.name)}</b>
      `;
      elements.skillLights.append(light);
    }
  };

  setSkillLabelsVisible(false);

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

  const publishLayout = () => {
    window.webkit?.messageHandlers?.tokenMeterLayout?.postMessage({ collapsed });
  };

  const readStoredLayout = () => {
    if (!storageKey) return null;
    try {
      const value = JSON.parse(window.localStorage?.getItem(storageKey) ?? "null");
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  };

  const saveLayout = () => {
    if (!storageKey) return;
    try {
      window.localStorage?.setItem(storageKey, JSON.stringify({
        collapsed,
        left: position?.left ?? null,
        top: position?.top ?? null,
      }));
    } catch {}
  };

  const placeHost = (left, top) => {
    const rect = host.getBoundingClientRect();
    const margin = 8;
    const maximumLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maximumTop = Math.max(margin, window.innerHeight - rect.height - margin);
    position = {
      left: Math.min(maximumLeft, Math.max(margin, Number(left) || 0)),
      top: Math.min(maximumTop, Math.max(margin, Number(top) || 0)),
    };
    Object.assign(host.style, {
      right: "auto",
      bottom: "auto",
      left: `${position.left}px`,
      top: `${position.top}px`,
    });
    return position;
  };

  const clampPosition = () => {
    if (position) placeHost(position.left, position.top);
  };

  const setCollapsed = (value) => {
    collapsed = collapsible && value === true;
    if (collapsed) closeSettings();
    card.classList.toggle("collapsed", collapsed);
    elements.collapseToggle.querySelector("span").textContent = collapsed ? "+" : "−";
    const action = collapsed ? "Expand" : "Collapse";
    elements.collapseToggle.setAttribute("aria-label", `${action} Token Meter`);
    elements.collapseToggle.title = `${action} Token Meter`;
    publishLayout();
    requestAnimationFrame(() => {
      clampPosition();
      saveLayout();
    });
    return collapsed;
  };

  const configure = (options = {}) => {
    collapsible = options.collapsible === true;
    draggable = options.draggable === true;
    storageKey =
      typeof options.storageKey === "string" && options.storageKey.length > 0
        ? options.storageKey
        : null;
    const storedLayout = readStoredLayout();
    const nextCollapsed =
      typeof options.collapsed === "boolean"
        ? options.collapsed
        : storedLayout?.collapsed === true;
    elements.collapseToggle.hidden = !collapsible;
    card.classList.toggle("draggable", draggable);
    if (
      draggable &&
      Number.isFinite(storedLayout?.left) &&
      Number.isFinite(storedLayout?.top)
    ) {
      placeHost(storedLayout.left, storedLayout.top);
    }
    setCollapsed(nextCollapsed);
    return { collapsed, draggable, position };
  };

  const beginDrag = (event, source) => {
    const interactiveTarget = event.target.closest?.(
      "button, a, input, select, textarea, [role='button']",
    );
    if (
      !draggable ||
      event.button !== 0 ||
      interactiveTarget ||
      (source === "gauge" && !collapsed)
    ) {
      return;
    }
    const rect = host.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      moved: false,
    };
    source === "header"
      ? elements.header?.setPointerCapture?.(event.pointerId)
      : elements.gauge?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveDrag = (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) >= 3) dragState.moved = true;
    if (dragState.moved) {
      placeHost(dragState.startLeft + deltaX, dragState.startTop + deltaY);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const endDrag = (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const moved = dragState.moved;
    dragState = null;
    event.currentTarget?.releasePointerCapture?.(event.pointerId);
    if (moved) saveLayout();
    event.preventDefault();
    event.stopPropagation();
  };

  // Update banner: shown when the bridge reports a newer release. The anomaly
  // warning owns the bottom slot when both want it; a dismiss lasts the session.
  let updateDismissed = false;
  let updateDownloadStarted = false;
  const renderUpdateBanner = (snapshot) => {
    const version = snapshot?.updateInfo?.version;
    const available = typeof version === "string" && nativeActions() != null;
    if (available && !updateDownloadStarted) {
      elements.updateTitle.textContent = `Version ${version} is ready`;
      elements.updateSub.textContent = "Click to download the update.";
    }
    elements.updateBanner.hidden = !available || updateDismissed || !elements.warning.hidden;
  };

  const update = (snapshot) => {
    ensureMounted();
    const bound = snapshot?.status === "bound" && snapshot?.binding?.exact;
    card.dataset.bound = String(bound);
    elements.unbound.hidden = bound;
    if (!bound) {
      elements.warning.hidden = true;
      renderUpdateBanner(snapshot);
      elements.sessionId.textContent = "UNBOUND";
      elements.sessionTotal.textContent = "—";
      elements.dayTotal.textContent = "—";
      elements.streak.textContent = "—";
      elements.lifetime.textContent = "—";
      elements.turnTotal.textContent = "—";
      elements.contextTotal.textContent = "—";
      elements.contextExtra.textContent = "";
      elements.compactionCount.textContent = "—";
      elements.accountHour.textContent = "—";
      elements.rate.textContent = "Awaiting session";
      elements.baseline.textContent = "—";
      elements.agentCount.textContent = "";
      elements.usageDelta.textContent = "";
      setSkillLabelsVisible(false);
      renderSkills({ status: "unknown", items: [] });
      currentSessionId = null;
      lastSessionTotal = 0;
      lastRate = null;
      displayed.clear();
      animateNeedle(0);
      card.dataset.level = "learning";
      card.dataset.rateBand = "green";
      return;
    }

    const sessionChanged = currentSessionId !== snapshot.sessionId;
    if (sessionChanged) {
      currentSessionId = snapshot.sessionId;
      setSkillLabelsVisible(false);
      card.classList.remove("session-switch");
      void card.offsetWidth;
      card.classList.add("session-switch");
      displayed.clear();
      lastSessionTotal = snapshot.session.totalTokens;
    }
    const identityLabel = snapshot.meterHandle
      ? `@${snapshot.meterHandle}`
      : snapshot.meterId;
    elements.sessionId.textContent =
      identityLabel ?? snapshot.sessionId.slice(-8).toUpperCase();
    elements.sessionId.title =
      (snapshot.meterId
        ? `Meter ${snapshot.meterId} · Session ${snapshot.sessionId}`
        : `Session ${snapshot.sessionId}`) +
      (nativeActions() ? " · Click to open your dashboard" : "");
    if (snapshot.meterHandle) {
      elements.settingsIdentityLink.hidden = false;
      elements.settingsIdentityLink.textContent = `@${snapshot.meterHandle}`;
      elements.settingsAnon.hidden = true;
    } else {
      elements.settingsIdentityLink.hidden = true;
      elements.settingsAnon.hidden = false;
    }
    elements.settingsClaim.hidden = Boolean(snapshot.meterHandle) || !snapshot.meterId;
    if (Date.now() - sharingToggledAtMs > 3000) {
      setPrivacyUI(Boolean(snapshot.sharingEnabled));
    }
    const delta = Math.max(0, snapshot.session.totalTokens - lastSessionTotal);
    lastSessionTotal = snapshot.session.totalTokens;
    if (delta > 0 && !sessionChanged) {
      card.style.setProperty("--impact", String(Math.min(1, delta / 100_000)));
      card.classList.remove("usage-impact");
      void card.offsetWidth;
      card.classList.add("usage-impact");
      elements.usageDelta.textContent = `+${format(delta)}`;
      elements.usageDelta.classList.remove("visible");
      void elements.usageDelta.offsetWidth;
      elements.usageDelta.classList.add("visible");
      clearTimeout(deltaTimer);
      deltaTimer = setTimeout(() => {
        elements.usageDelta.classList.remove("visible");
      }, 1_100);
    }

    animateNumber("session", elements.sessionTotal, snapshot.session.totalTokens, sessionChanged);
    animateNumber("turn", elements.turnTotal, snapshot.turn.tokens, sessionChanged);
    animateNumber("account", elements.accountHour, snapshot.account.lastHourTokens, sessionChanged);
    if (snapshot.account?.last24hTokens == null) {
      elements.dayTotal.textContent = "—";
    } else {
      animateNumber("day", elements.dayTotal, snapshot.account.last24hTokens, sessionChanged);
    }
    const stats = snapshot.meterStats;
    elements.streak.textContent =
      stats?.currentStreakDays == null
        ? "—"
        : `${stats.currentStreakDays} day${stats.currentStreakDays === 1 ? "" : "s"}`;
    elements.lifetime.textContent =
      stats?.lifetimeTokens == null ? "—" : format(stats.lifetimeTokens);
    if (snapshot.context?.tokens == null) {
      elements.contextTotal.textContent = "—";
      elements.contextExtra.textContent = "";
    } else {
      animateNumber(
        "context",
        elements.contextTotal,
        snapshot.context.tokens,
        sessionChanged,
      );
      elements.contextExtra.textContent =
        snapshot.context.percent == null
          ? ""
          : ` · ${snapshot.context.percent.toFixed(0)}%`;
    }
    elements.compactionCount.textContent = String(snapshot.context?.compactionCount ?? 0);
    renderSkills(snapshot.skills);

    const rate = snapshot.rate.tokensPerMinute;
    const median = snapshot.anomaly.baseline.medianTokensPerMinute || 0;
    const intensity = Math.min(1, Math.max(0, snapshot.rate.intensity ?? 0));
    elements.rate.textContent = `${format(rate)}/min`;
    elements.baseline.textContent = median ? `${format(median)}/min` : "Learning";
    elements.agentCount.textContent = snapshot.childAgentCount
      ? `+${snapshot.childAgentCount} agent${snapshot.childAgentCount === 1 ? "" : "s"}`
      : "";
    if (lastRate == null || Math.abs(lastRate - rate) >= 1) {
      animateNeedle(intensity);
      lastRate = rate;
    }

    card.dataset.rateBand = snapshot.rate.band ?? "green";
    card.dataset.level = snapshot.anomaly.level;
    elements.warning.hidden = !["warning", "critical"].includes(snapshot.anomaly.level);
    renderUpdateBanner(snapshot);
  };

  const destroy = () => {
    clearTimeout(deltaTimer);
    window.removeEventListener?.("resize", clampPosition);
    for (const animation of animations.values()) animation.cancel();
    host.remove();
    if (window.__tokenMeter?.version === VERSION) delete window.__tokenMeter;
  };

  elements.collapseToggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setCollapsed(!collapsed);
  });
  elements.skillsReveal.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setSkillLabelsVisible(!skillLabelsVisible);
  });
  elements.skillsPanel.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const INSTALL_URL = "https://github.com/SergioChan/token-meter";
  const nativeActions = () =>
    window.webkit?.messageHandlers?.tokenMeterAction ??
    window.__tokenMeterActionBridge ??
    null;
  const nativeQuitAction = () =>
    window.webkit?.messageHandlers?.tokenMeterAction ?? null;
  const postAction = (payload) => nativeActions()?.postMessage(payload);
  let settingsOpen = false;
  let sharingToggledAtMs = 0;
  const setSettingsOpen = (open) => {
    settingsOpen = open;
    card.classList.toggle("settings-open", open);
    elements.settingsPanel.hidden = !open;
  };
  closeSettings = () => setSettingsOpen(false);
  // Settings need the native action bridge; the injected Codex meter hides them.
  if (nativeActions()) {
    elements.settingsToggle.hidden = false;
    elements.sessionId.classList.add("clickable");
    elements.sessionId.setAttribute("role", "button");
    elements.sessionId.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      postAction({ type: "open-dashboard" });
    });
  }
  elements.settingsToggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setSettingsOpen(!settingsOpen);
  });
  const startUpdateDownload = () => {
    if (updateDownloadStarted) return;
    updateDownloadStarted = true;
    elements.updateTitle.textContent = "Downloading update…";
    elements.updateSub.textContent = "The installer opens by itself: drag to Applications, then reopen.";
    postAction({ type: "open-update" });
    // Allow a retry if the download quietly fails (lost network, dead tunnel).
    setTimeout(() => {
      updateDownloadStarted = false;
    }, 90_000);
  };
  elements.updateBanner.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.target === elements.updateDismiss) return;
    startUpdateDownload();
  });
  elements.updateBanner.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    startUpdateDownload();
  });
  elements.updateDismiss.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    updateDismissed = true;
    elements.updateBanner.hidden = true;
  });
  let tipLockedUntilMs = 0;
  const showTip = (text, lockMs = 0) => {
    if (lockMs === 0 && Date.now() < tipLockedUntilMs) return;
    tipLockedUntilMs = Date.now() + lockMs;
    elements.settingsTip.textContent = text;
  };
  const tips = [
    [elements.settingsShare, "Copy the install link to your clipboard and refer friends"],
    [elements.settingsDashboard, "Open your private usage dashboard in the browser"],
    [elements.settingsLeaderboard, "See where you stand on the community leaderboard"],
    [elements.settingsIdentityLink, "Open your identity page"],
    [
      elements.settingsPower,
      "Turn off Token Widget. Open it from Applications to turn it back on.",
    ],
    [elements.privacyLocal, "Nothing ever leaves this machine."],
    [
      elements.privacyShare,
      "Upload signed usage totals to the community server and see your page on the public site.",
    ],
    [
      elements.settingsClaim,
      "Pick your unique @handle on the usage dashboard — first come, first served.",
    ],
  ];
  for (const [element, tip] of tips) {
    element.addEventListener("mouseenter", () => showTip(tip));
    element.addEventListener("mouseleave", () => showTip(""));
  }
  elements.settingsShare.addEventListener("click", () => {
    postAction({
      type: "copy-text",
      text: `See how hard your Agent is working — Token Meter: ${INSTALL_URL}`,
    });
    showTip("Copied install link ✓", 1400);
  });
  elements.settingsDashboard.addEventListener("click", () => {
    postAction({ type: "open-dashboard" });
  });
  elements.settingsClaim.addEventListener("click", () => {
    postAction({ type: "open-dashboard" });
    showTip("Opening the dashboard to claim your handle…", 2000);
  });
  elements.settingsPower.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    postAction({ type: "quit-widget" });
  });
  if (!nativeQuitAction()) elements.settingsPower.hidden = true;
  elements.settingsIdentityLink.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    postAction({ type: "open-dashboard" });
  });
  elements.settingsLeaderboard.addEventListener("click", () => {
    postAction({ type: "open-leaderboard" });
  });
  const setPrivacyUI = (sharingOn) => {
    elements.privacyLocal.classList.toggle("active", !sharingOn);
    elements.privacyLocal.setAttribute("aria-pressed", String(!sharingOn));
    elements.privacyShare.classList.toggle("active", sharingOn);
    elements.privacyShare.setAttribute("aria-pressed", String(sharingOn));
  };
  const chooseSharing = (enabled) => {
    sharingToggledAtMs = Date.now();
    setPrivacyUI(enabled);
    postAction({ type: "set-sharing", enabled });
    showTip(
      enabled
        ? "Sharing with the community — signed totals only."
        : "Everything stays on this machine.",
      1400,
    );
  };
  elements.privacyLocal.addEventListener("click", () => chooseSharing(false));
  elements.privacyShare.addEventListener("click", () => chooseSharing(true));
  // The bottom section flips between the primary rows and the compact stats
  // view in place; the card never changes size (the native panel is fixed).
  let statsView = false;
  const setStatsView = (open) => {
    statsView = open;
    card.classList.toggle("stats-view", open);
    elements.statsPanel.hidden = !open;
  };
  card.addEventListener("click", (event) => {
    if (collapsed) return;
    if (!event.target.closest?.(".bottom-toggle")) return;
    setStatsView(!statsView);
  });
  for (const [element, source] of [
    [elements.header, "header"],
    [elements.gauge, "gauge"],
  ]) {
    element.addEventListener("pointerdown", (event) => beginDrag(event, source));
    element.addEventListener("pointermove", moveDrag);
    element.addEventListener("pointerup", endDrag);
    element.addEventListener("pointercancel", endDrag);
    element.addEventListener("click", (event) => {
      if (draggable && (source === "header" || collapsed)) event.stopPropagation();
    });
  }
  window.addEventListener?.("resize", clampPosition);
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
    configure,
    setCollapsed,
    ensureMounted,
    destroy: destroyWithObserver,
  };
  ensureMounted();
  return { mounted: true, reused: false, version: VERSION };
})(__TOKEN_METER_CSS_JSON__)
