/*
 * The Suplex analytics consent banner. getsuplex.ai (Framer Custom Code) and suplex.sh both load
 * this one file from https://suplex.sh/consent.js. Do not copy the banner text or styles elsewhere.
 *
 * - The choice is localStorage "suplex.analytics.consent.v1": "granted" or "denied".
 * - A `consent=granted|denied` URL parameter is stored as the choice. Other values are ignored.
 * - Links to the other site, and same-site links that already have `consent`, carry the stored
 *   choice as `consent` when they are opened, because localStorage is per origin.
 * - Global Privacy Control or Do Not Track: the choice is always "denied", "granted" is never
 *   stored, and no banner or settings button shows.
 * - The Google Tag Manager snippet reads the same key to grant Consent Mode. This file only
 *   sends a denied update when a granted choice is withdrawn.
 *
 * API: window.SuplexConsent.value(), grant(), deny(), clear(), and subscribe(listener). The
 * listener gets the new choice ("granted", "denied", or null). A script that runs before this
 * file can queue a listener in the array window.SuplexConsentListeners.
 */
(function suplexConsent(window, document) {
  "use strict";

  if (window.SuplexConsent) return;

  var key = "suplex.analytics.consent.v1";
  var sites = ["https://suplex.sh", "https://getsuplex.ai", "https://www.getsuplex.ai"];
  var listeners = [];

  function stored() {
    var value = null;
    try { value = window.localStorage.getItem(key); } catch (_) { return null; }
    return value === "granted" || value === "denied" ? value : null;
  }

  function store(value) {
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch (_) { /* storage is optional */ }
  }

  function privacySignal() {
    return window.navigator.globalPrivacyControl === true || window.navigator.doNotTrack === "1" || window.doNotTrack === "1";
  }

  /** The choice that pages and links use. A privacy signal is always "denied". */
  function value() {
    return privacySignal() ? "denied" : stored();
  }

  function notify(choice) {
    listeners.slice().forEach(function (listener) {
      try { listener(choice); } catch (_) { /* one listener does not stop the others */ }
    });
  }

  function withdrawConsentMode() {
    if (typeof window.gtag !== "function") return;
    window.gtag("consent", "update", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  }

  /** Stores a choice and updates the page. `always` notifies even when the choice is the same. */
  function choose(choice, always) {
    if (choice === "granted" && privacySignal()) return;
    var previous = stored();
    store(choice);
    if (previous === "granted" && choice !== "granted") withdrawConsentMode();
    render();
    decorateAll();
    if (always || previous !== choice) notify(choice);
  }

  function decorate(element) {
    if (!element || !element.getAttribute) return;
    var attribute = element.tagName === "FORM" ? "action" : "href";
    var raw = element.getAttribute(attribute);
    if (!raw) return;
    var target;
    try { target = new URL(raw, window.location.href); } catch (_) { return; }
    if (target.protocol !== "https:" && target.protocol !== "http:") return;
    var internal = target.origin === window.location.origin;
    var partner = !internal && sites.indexOf(target.origin) >= 0;
    if (!partner && !(internal && target.searchParams.has("consent"))) return;
    var before = target.toString();
    var choice = value();
    if (choice) target.searchParams.set("consent", choice);
    else if (target.searchParams.has("consent")) target.searchParams.delete("consent");
    if (target.toString() !== before) element.setAttribute(attribute, target.toString());
  }

  function decorateAll() {
    if (!document.querySelectorAll) return;
    Array.prototype.forEach.call(document.querySelectorAll("a[href],area[href],form[action]"), decorate);
  }

  function decorateEvent(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    decorate(event.type === "submit" ? target.closest("form") : target.closest("a[href],area[href]"));
  }

  function removeElement(id) {
    var element = document.getElementById(id);
    if (element) element.remove();
  }

  function showSettingsButton() {
    if (document.getElementById("suplex-analytics-settings")) return;
    var button = document.createElement("button");
    button.id = "suplex-analytics-settings";
    button.type = "button";
    button.textContent = "Analytics settings";
    button.setAttribute("aria-label", "Open analytics settings");
    button.style.cssText = "position:fixed;z-index:2147483647;left:16px;bottom:16px;padding:6px 10px;border:1px solid #a3a3a3;background:#fff;color:#171717;font:13px/1.4 system-ui,sans-serif;cursor:pointer";
    button.addEventListener("click", function () { window.SuplexConsent.clear(); });
    document.body.appendChild(button);
  }

  function showConsentBanner() {
    if (document.getElementById("suplex-analytics-consent")) return;
    var banner = document.createElement("div");
    banner.id = "suplex-analytics-consent";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Website analytics consent");
    banner.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:420px;padding:12px;border:1px solid #d4d4d4;background:#fff;color:#171717;font:14px/1.4 system-ui,sans-serif;display:flex;gap:12px;align-items:center";
    var text = document.createElement("span");
    text.textContent = "Suplex collects usage data to improve the product.";
    var reject = document.createElement("button");
    reject.type = "button";
    reject.textContent = "Reject";
    reject.style.cssText = "padding:6px 10px;border:1px solid #a3a3a3;background:#fff;color:#171717;cursor:pointer";
    var allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = "Accept";
    allow.style.cssText = "padding:6px 10px;border:1px solid #171717;background:#171717;color:#fff;cursor:pointer";
    reject.addEventListener("click", function () { window.SuplexConsent.deny(); });
    allow.addEventListener("click", function () { window.SuplexConsent.grant(); });
    banner.append(text, reject, allow);
    document.body.appendChild(banner);
  }

  /** The banner shows only when no choice is stored; the settings button reopens it. */
  function render() {
    if (!document.body) return;
    if (privacySignal()) {
      removeElement("suplex-analytics-consent");
      removeElement("suplex-analytics-settings");
    } else if (stored()) {
      removeElement("suplex-analytics-consent");
      showSettingsButton();
    } else {
      removeElement("suplex-analytics-settings");
      showConsentBanner();
    }
  }

  function inboundChoice() {
    try {
      var choice = new URL(window.location.href).searchParams.get("consent");
      return choice === "granted" || choice === "denied" ? choice : null;
    } catch (_) { return null; }
  }

  window.SuplexConsent = {
    value: value,
    grant: function () { choose("granted", true); },
    deny: function () { choose("denied", true); },
    clear: function () { choose(null, true); },
    subscribe: function (listener) {
      if (typeof listener === "function") listeners.push(listener);
    },
  };

  var queued = window.SuplexConsentListeners;
  if (queued && typeof queued.forEach === "function") queued.forEach(window.SuplexConsent.subscribe);
  window.SuplexConsentListeners = { push: window.SuplexConsent.subscribe };

  var inbound = inboundChoice();
  if (inbound) choose(inbound, false);

  ["click", "auxclick", "contextmenu", "submit"].forEach(function (type) {
    document.addEventListener(type, decorateEvent, true);
  });
  function ready() { render(); decorateAll(); }
  if (document.body) ready();
  else document.addEventListener("DOMContentLoaded", ready);
}(window, document));
