const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(value) {
  return typeof value === "string" && THREAD_ID_PATTERN.test(value);
}

export function normalizeThreadId(value) {
  if (typeof value !== "string") return null;
  const candidate = value.startsWith("local:") ? value.slice(6) : value;
  return isThreadId(candidate) ? candidate : null;
}

export function buildSessionProbeExpression() {
  const threadIdSource = THREAD_ID_PATTERN.source;
  return `(() => {
    const uuid = new RegExp(${JSON.stringify(threadIdSource)}, 'i');
    const href = String(location.href);
    const lowerHref = href.toLowerCase();
    const avatarMarker = document.querySelector(
      '[data-avatar-overlay], [data-avatar-overlay-root], [id*="avatar-overlay"], [class*="avatar-overlay"]'
    );
    const activeRow = document.querySelector(
      '[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]'
    );
    const normalizeThreadId = (value) => {
      if (typeof value !== 'string') return null;
      const candidate = value.startsWith('local:') ? value.slice(6) : value;
      return uuid.test(candidate) ? candidate : null;
    };
    const activeId = normalizeThreadId(
      activeRow?.getAttribute('data-app-action-sidebar-thread-id') ?? null
    );
    const conversationIds = new Set(
      [...document.querySelectorAll('[data-above-composer-conversation-id]')]
        .map((element) => normalizeThreadId(
          element.getAttribute('data-above-composer-conversation-id')
        ))
        .filter(Boolean)
    );
    const conversationId =
      conversationIds.size === 1 ? [...conversationIds][0] : null;
    const routeMatch = String(location.pathname).match(/\\/thread\\/([^/?#]+)/);
    const routeId = normalizeThreadId(
      routeMatch == null ? null : decodeURIComponent(routeMatch[1])
    );
    let threadId = null;
    let bindingSource = null;
    if (activeId != null) {
      threadId = activeId;
      bindingSource = 'active-sidebar-row';
    } else if (conversationId != null) {
      threadId = conversationId;
      bindingSource = 'active-conversation-surface';
    } else if (routeId != null) {
      threadId = routeId;
      bindingSource = 'thread-route';
    }

    const markers = {
      sidebar: Boolean(document.querySelector('aside.app-shell-left-panel')),
      mainSurface: Boolean(document.querySelector(
        'main[data-app-shell-main-surface], .app-shell-main-content-viewport, .main-surface'
      )),
      composer: Boolean(document.querySelector(
        'textarea, [contenteditable="true"], [data-app-action-composer]'
      )),
      activeThread: Boolean(activeRow),
    };
    const markerCount = Object.values(markers).filter(Boolean).length;
    const eligible =
      location.protocol === 'app:' &&
      lowerHref.includes('/index.html') &&
      !lowerHref.includes('avatar-overlay') &&
      !avatarMarker &&
      markers.mainSurface &&
      markerCount >= 2 &&
      window.innerWidth >= 640 &&
      window.innerHeight >= 420;

    return {
      eligible,
      threadId,
      bindingSource,
      markers,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  })()`;
}
