const DESKTOP_SESSION_ID_PATTERN =
  /^(?:local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|session_[0-9A-Za-z]{24})$/;

export function isClaudeDesktopSessionId(value) {
  return (
    typeof value === "string" && DESKTOP_SESSION_ID_PATTERN.test(value)
  );
}

export function buildClaudeSessionProbeExpression() {
  const sessionIdSource = DESKTOP_SESSION_ID_PATTERN.source;
  return `(() => {
    const sessionIdPattern = new RegExp(${JSON.stringify(sessionIdSource)});
    const normalizeSessionId = (value) =>
      typeof value === 'string' && sessionIdPattern.test(value) ? value : null;
    const sessionIdFromPath = (value) => {
      if (typeof value !== 'string') return null;
      let decoded = value;
      try { decoded = decodeURIComponent(value); } catch {}
      const match = decoded.match(
        /(?:^|\\/)(?:code|epitaxy)\\/((?:local_[0-9a-f-]{36}|session_[0-9A-Za-z]{24}))(?:[\\/?#]|$)/
      );
      return normalizeSessionId(match?.[1] ?? null);
    };
    const routeIds = [
      sessionIdFromPath(String(location.pathname)),
      sessionIdFromPath(String(location.hash).replace(/^#/, '')),
      sessionIdFromPath(String(location.href)),
    ].filter(Boolean);
    const uniqueRouteIds = [...new Set(routeIds)];
    const routeId = uniqueRouteIds.length === 1 ? uniqueRouteIds[0] : null;

    const currentAnchors = [...document.querySelectorAll(
      'a[aria-current="page"][href], a[aria-current="true"][href]'
    )];
    const activeIds = currentAnchors
      .map((anchor) => sessionIdFromPath(anchor.getAttribute('href')))
      .filter(Boolean);
    const uniqueActiveIds = [...new Set(activeIds)];
    const activeId = uniqueActiveIds.length === 1 ? uniqueActiveIds[0] : null;

    const bindingConflict =
      activeId != null && routeId != null && activeId !== routeId;
    const desktopSessionId = bindingConflict ? null : activeId ?? routeId;
    const bindingSource = desktopSessionId == null
      ? null
      : activeId != null
        ? 'active-code-session-link'
        : 'code-session-route';
    const protocol = String(location.protocol).toLowerCase();
    const host = String(location.hostname ?? '').toLowerCase();
    const trustedLocation =
      protocol === 'file:' ||
      protocol === 'app:' ||
      (protocol === 'https:' && ['claude.ai', 'claude.com'].includes(host));
    const markers = {
      root: Boolean(document.querySelector('#root, [data-reactroot]')),
      sessionHeader: Boolean(document.querySelector(
        '[data-testid="session-title-split"]'
      )),
      composer: Boolean(document.querySelector(
        'textarea, [contenteditable="true"]'
      )),
      activeSessionLink: activeId != null,
      codeRoute: routeId != null,
    };
    const eligible =
      trustedLocation &&
      desktopSessionId != null &&
      !bindingConflict &&
      markers.root &&
      markers.sessionHeader &&
      markers.composer &&
      markers.codeRoute &&
      window.innerWidth >= 640 &&
      window.innerHeight >= 420;

    return {
      eligible,
      desktopSessionId,
      bindingSource,
      bindingConflict,
      markers,
      surface: routeId == null ? 'unknown' : 'code',
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  })()`;
}
