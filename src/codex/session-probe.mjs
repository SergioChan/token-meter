const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(value) {
  return typeof value === "string" && THREAD_ID_PATTERN.test(value);
}

export function buildSessionProbeExpression() {
  return `(() => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const href = String(location.href);
    const lowerHref = href.toLowerCase();
    const avatarMarker = document.querySelector(
      '[data-avatar-overlay], [data-avatar-overlay-root], [id*="avatar-overlay"], [class*="avatar-overlay"]'
    );
    const activeRow = document.querySelector(
      '[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]'
    );
    const activeId = activeRow?.getAttribute('data-app-action-sidebar-thread-id') ?? null;
    const routeMatch = String(location.pathname).match(/\\/thread\\/([^/?#]+)/);
    const routeId = routeMatch == null ? null : decodeURIComponent(routeMatch[1]);
    let threadId = null;
    let bindingSource = null;
    if (uuid.test(activeId ?? '')) {
      threadId = activeId;
      bindingSource = 'active-sidebar-row';
    } else if (uuid.test(routeId ?? '')) {
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

