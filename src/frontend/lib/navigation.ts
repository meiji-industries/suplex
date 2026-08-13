const applicationPaths = [
  /^\/admin(?:\/(?:profiles|models|companies|invitations|passkeys))?$/,
  /^\/companies\/[^/]+\/settings$/,
  /^\/profile$/,
  /^\/(?:projects|tasks|board|timeline|attention|health)(?:\/[^/]+)?$/,
];

export function isApplicationPath(pathname: string): boolean {
  return applicationPaths.some((pattern) => pattern.test(pathname));
}

export function navigate(href: string): void {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin || !isApplicationPath(url.pathname)) {
    window.location.assign(url);
    return;
  }
  if (`${url.pathname}${url.search}${url.hash}` === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new Event("forge:navigate"));
}

export function shouldNavigate(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.target && anchor.target !== "_self" || anchor.hasAttribute("download")) return false;
  if (anchor.getAttribute("href")?.startsWith("#")) return false;
  const url = new URL(anchor.href, window.location.href);
  return url.origin === window.location.origin
    && isApplicationPath(url.pathname);
}
