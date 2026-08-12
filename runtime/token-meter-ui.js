((cssText) => {
  const VERSION = 10;
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
      <button class="collapse-toggle" type="button" aria-label="Collapse Token Meter" title="Collapse Token Meter" hidden>
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
    <div class="metric-row">
      <span><small>1H SESSION</small><b class="hour-total">0</b></span>
      <span><small>CURRENT TURN</small><b class="turn-total">0</b></span>
    </div>
    <div class="context-row">
      <span>
        <small>ACTIVE CONTEXT</small>
        <b><span class="context-total">0</span><i> / <span class="context-window">0</span></i></b>
      </span>
      <em class="context-percent">0%</em>
    </div>
    <div class="details-row">
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
    <div class="unbound" hidden>
      <strong>SESSION UNKNOWN</strong>
      <span>The meter will not guess which session is active.</span>
    </div>
  `;
  shadow.append(card);

  const elements = {
    header: card.querySelector(".meter-header"),
    gauge: card.querySelector(".gauge"),
    sessionId: card.querySelector(".session-id"),
    sessionTotal: card.querySelector(".session-total"),
    hourTotal: card.querySelector(".hour-total"),
    turnTotal: card.querySelector(".turn-total"),
    contextTotal: card.querySelector(".context-total"),
    contextWindow: card.querySelector(".context-window"),
    contextPercent: card.querySelector(".context-percent"),
    compactionCount: card.querySelector(".compaction-count"),
    accountHour: card.querySelector(".account-hour"),
    rate: card.querySelector(".rate"),
    baseline: card.querySelector(".baseline"),
    agentCount: card.querySelector(".agent-count"),
    usageDelta: card.querySelector(".usage-delta"),
    collapseToggle: card.querySelector(".collapse-toggle"),
    needle: card.querySelector(".needle"),
    progress: card.querySelector(".gauge-progress"),
    warning: card.querySelector(".warning"),
    unbound: card.querySelector(".unbound"),
    skillsPanel: card.querySelector(".skills-panel"),
    skillsSummary: card.querySelector(".skills-summary"),
    skillsReveal: card.querySelector(".skills-reveal"),
    skillLights: card.querySelector(".skill-lights"),
  };
  const displayed = new Map();
  const animations = new Map();
  let currentSessionId = null;
  let lastSessionTotal = 0;
  let lastRate = null;
  let deltaTimer = null;
  let collapsible = false;
  let collapsed = false;
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
    if (
      !draggable ||
      event.button !== 0 ||
      event.target.closest?.(".collapse-toggle") ||
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

  const update = (snapshot) => {
    ensureMounted();
    const bound = snapshot?.status === "bound" && snapshot?.binding?.exact;
    card.dataset.bound = String(bound);
    elements.unbound.hidden = bound;
    if (!bound) {
      elements.warning.hidden = true;
      elements.sessionId.textContent = "UNBOUND";
      elements.sessionTotal.textContent = "—";
      elements.hourTotal.textContent = "—";
      elements.turnTotal.textContent = "—";
      elements.contextTotal.textContent = "—";
      elements.contextWindow.textContent = "—";
      elements.contextPercent.textContent = "—";
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
    elements.sessionId.textContent = snapshot.sessionId.slice(-8).toUpperCase();
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
    animateNumber("hour", elements.hourTotal, snapshot.session.lastHourTokens, sessionChanged);
    animateNumber("turn", elements.turnTotal, snapshot.turn.tokens, sessionChanged);
    animateNumber("account", elements.accountHour, snapshot.account.lastHourTokens, sessionChanged);
    if (snapshot.context?.tokens == null) {
      elements.contextTotal.textContent = "—";
      elements.contextWindow.textContent = "—";
      elements.contextPercent.textContent = "—";
    } else {
      animateNumber(
        "context",
        elements.contextTotal,
        snapshot.context.tokens,
        sessionChanged,
      );
      elements.contextWindow.textContent =
        snapshot.context.windowTokens == null ? "—" : format(snapshot.context.windowTokens);
      elements.contextPercent.textContent =
        snapshot.context.percent == null ? "—" : `${snapshot.context.percent.toFixed(1)}%`;
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
  card.addEventListener("click", () => {
    if (!collapsed) {
      const wasExpanded = card.classList.contains("expanded");
      card.classList.toggle("expanded");
      if (wasExpanded) setSkillLabelsVisible(false);
    }
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
