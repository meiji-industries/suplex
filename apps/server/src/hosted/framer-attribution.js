/*
 * Suplex website analytics for Framer Custom Code (end of <body>).
 * The project token is a public, write-only PostHog key. No personal API key belongs here.
 */
(function suplexWebsiteAnalytics(window, document) {
  "use strict";

  var defaults = {
    apiKey: "phc_uPRTBcCQ33JsQF3wskzdPALBpeuDnkGPK39YeyRX7YCJ",
    apiHost: "https://meta.suplex.sh",
    uiHost: "https://us.posthog.com",
    defaults: "2026-05-30",
    consentStorageKey: "suplex.analytics.consent.v1",
    attributionStorageKey: "suplex.analytics.attribution.v1",
    downloadVersion: "unknown",
    enableDataLayer: false,
  };
  var config = Object.assign({}, defaults, window.SUPLEX_POSTHOG_CONFIG || {});
  var allowedUtm = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  var allowedClickIds = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid"];
  var maxValueLength = 120;
  var allowedCtas = ["pricing", "get", "product", "download", "hero-download", "start-free", "start-trial"];
  var allowedPlatforms = ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64"];
  var posthog;
  var started = false;

  function bounded(value) {
    return typeof value === "string" ? value.trim().slice(0, maxValueLength) : "";
  }

  function safeHost(value) {
    try { return bounded(new URL(value).hostname.toLowerCase()); } catch (_) { return ""; }
  }

  function storageRead(key) {
    try { return window.localStorage.getItem(key); } catch (_) { return null; }
  }

  function storageWrite(key, value) {
    try { window.localStorage.setItem(key, value); } catch (_) { /* storage is optional */ }
  }

  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (_) { /* storage is optional */ }
  }

  function consent() { return storageRead(config.consentStorageKey); }

  function privacySignal() {
    return window.navigator.globalPrivacyControl === true || window.navigator.doNotTrack === "1" || window.doNotTrack === "1";
  }

  function urlWithoutSecrets(value, referrer) {
    try {
      var parsed = new URL(value, window.location.origin);
      return referrer ? parsed.origin : parsed.origin + parsed.pathname;
    } catch (_) { return ""; }
  }

  function scrubSdkProperties(properties) {
    var safe = Object.assign({}, properties || {});
    ["$current_url", "$initial_current_url"].forEach(function (key) {
      if (safe[key]) safe[key] = urlWithoutSecrets(safe[key], false);
    });
    ["$referrer", "$initial_referrer"].forEach(function (key) {
      if (safe[key]) safe[key] = urlWithoutSecrets(safe[key], true);
    });
    if (safe.$set) safe.$set = scrubSdkProperties(safe.$set);
    if (safe.$set_once) safe.$set_once = scrubSdkProperties(safe.$set_once);
    return safe;
  }

  function currentTouch() {
    var params = new URLSearchParams(window.location.search);
    var touch = { referrer_domain: safeHost(document.referrer) };
    allowedUtm.forEach(function (key) {
      var value = bounded(params.get(key));
      if (value) touch[key.slice(4)] = value;
    });
    allowedClickIds.forEach(function (key) {
      var value = bounded(params.get(key));
      if (value && /^[A-Za-z0-9._~-]+$/.test(value)) touch[key] = value;
    });
    return touch;
  }

  function attribution() {
    var saved = {};
    try { saved = JSON.parse(storageRead(config.attributionStorageKey) || "{}"); } catch (_) { saved = {}; }
    if (!saved || typeof saved !== "object") return {};
    function safeTouch(touch) {
      if (!touch || typeof touch !== "object") return {};
      var safe = {};
      ["source", "medium", "campaign", "content", "term"].forEach(function (key) {
        var value = bounded(touch[key]);
        if (value) safe[key] = value;
      });
      var domain = bounded(touch.referrer_domain).toLowerCase();
      if (domain && /^[a-z0-9.-]+$/.test(domain)) safe.referrer_domain = domain;
      allowedClickIds.forEach(function (key) {
        var value = bounded(touch[key]);
        if (value && /^[A-Za-z0-9._~-]+$/.test(value)) safe[key] = value;
      });
      return Object.keys(safe).length ? safe : null;
    }
    return { first: safeTouch(saved.first), last: safeTouch(saved.last) };
  }

  function updateAttribution() {
    if (consent() !== "granted") return {};
    var previous = attribution();
    var touch = currentTouch();
    var hasCampaign = Object.keys(touch).some(function (key) { return key !== "referrer_domain" && touch[key]; });
    var hasReferrer = touch.referrer_domain && touch.referrer_domain !== window.location.hostname.toLowerCase();
    if (!hasCampaign && !hasReferrer) return previous;
    var next = { first: previous.first || touch, last: touch };
    storageWrite(config.attributionStorageKey, JSON.stringify(next));
    return next;
  }

  function attributionProperties() {
    var saved = attribution();
    var result = {};
    ["first", "last"].forEach(function (position) {
      var touch = saved[position] || {};
      ["source", "medium", "campaign", "content", "term", "referrer_domain"].forEach(function (key) {
        if (touch[key]) result["attribution_" + position + "_" + key] = touch[key];
      });
      allowedClickIds.forEach(function (key) {
        if (touch[key]) result["attribution_" + position + "_" + key] = touch[key];
      });
    });
    return result;
  }

  function safePageProperties() {
    return Object.assign({
      surface: "website",
      page_path: bounded(window.location.pathname),
      page_title: bounded(document.title),
    }, attributionProperties());
  }

  function capturePageview() {
    if (!posthog || consent() !== "granted") return;
    posthog.capture("$pageview", safePageProperties());
  }

  function signalConversion(eventName, properties) {
    var detail = Object.assign({ event: eventName }, properties, attributionProperties());
    window.dispatchEvent(new CustomEvent("suplex:conversion", { detail: detail }));
    if (config.enableDataLayer) {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(detail);
    }
  }

  function classifiedLink(element) {
    var href;
    try { href = new URL(element.href || "", window.location.href); } catch (_) { return null; }
    var annotatedCta = bounded(element.getAttribute("data-suplex-cta"));
    var cta = allowedCtas.indexOf(annotatedCta) >= 0 ? annotatedCta : "";
    var requestedPlatform = bounded(element.getAttribute("data-suplex-platform"));
    var platform = allowedPlatforms.indexOf(requestedPlatform) >= 0 ? requestedPlatform : "";
    var isDownload = element.hasAttribute("data-suplex-download");
    var approvedDownloadOrigin = href.origin === window.location.origin || href.origin === "https://suplex.sh";
    if (approvedDownloadOrigin && href.pathname === "/download") {
      var queryPlatform = bounded(href.searchParams.get("platform"));
      platform = allowedPlatforms.indexOf(queryPlatform) >= 0 ? queryPlatform : platform;
      isDownload = Boolean(platform);
      cta = cta || "download";
    }
    if (!cta && href.origin === "https://suplex.sh" && href.pathname === "/start") cta = href.searchParams.get("plan") === "pro" ? "start-trial" : "start-free";
    if (!cta && href.origin === window.location.origin && href.pathname === "/" && href.hash === "#pricing") cta = "pricing";
    if (!cta && href.origin === window.location.origin && href.pathname === "/" && href.hash === "#get") cta = "get";
    if (!cta && href.origin === window.location.origin && href.pathname === "/product") cta = "product";
    if (!cta && !isDownload) return null;
    return { cta: cta, destinationDomain: href.hostname.toLowerCase(), isDownload: isDownload, platform: platform };
  }

  function captureAnnotatedClick(target) {
    var element = target && target.closest ? target.closest("a,[data-suplex-cta],[data-suplex-download]") : null;
    if (!element || consent() !== "granted") return;
    var link = classifiedLink(element);
    if (!link) return;
    var eventName = link.isDownload ? "website_download_clicked" : "website_cta_clicked";
    var properties = Object.assign(safePageProperties(), {
      cta: link.cta,
      destination_domain: link.destinationDomain,
    });
    if (link.isDownload) {
      properties.platform = link.platform;
      var version = bounded(element.getAttribute("data-suplex-version")) || bounded(config.downloadVersion);
      properties.version = /^[A-Za-z0-9._-]+$/.test(version) ? version : "unknown";
    }
    posthog.capture(eventName, properties);
    signalConversion(eventName, properties);
    if (link.isDownload || link.cta === "start-free" || link.cta === "start-trial") addVisitor(element);
  }

  // Carries the consented visitor ID to suplex.sh, which keeps it in a first-party cookie so a
  // later Suplex account login joins this visitor (docs/accounts.md).
  function addVisitor(element) {
    var visitor = typeof posthog.get_distinct_id === "function" ? posthog.get_distinct_id() : "";
    if (typeof visitor !== "string" || !/^[A-Za-z0-9._:-]{8,64}$/.test(visitor)) return;
    try {
      var href = new URL(element.href || "", window.location.href);
      if (href.origin !== "https://suplex.sh" || (href.pathname !== "/download" && href.pathname !== "/start")) return;
      href.searchParams.set("visitor", visitor);
      element.href = href.toString();
    } catch (_) { /* leave the link unchanged */ }
  }

  function installSpaPageviews() {
    ["pushState", "replaceState"].forEach(function (method) {
      var original = window.history[method];
      window.history[method] = function () {
        var result = original.apply(this, arguments);
        window.setTimeout(capturePageview, 0);
        return result;
      };
    });
    window.addEventListener("popstate", capturePageview);
  }

  function loadSdk() {
    if (started) return;
    started = true;
    (function (t, e) {
      var o, n, p, r;
      e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) {
        function g(t, e) { var o = e.split("."); if (o.length === 2) { t = t[o[0]]; e = o[1]; } t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments))); }; }
        p = t.createElement("script"); p.type = "text/javascript"; p.async = true; p.src = s.api_host + "/static/array.js";
        r = t.getElementsByTagName("script")[0]; r.parentNode.insertBefore(p, r);
        var u = e; if (a !== undefined) u = e[a] = []; else a = "posthog"; u.people = u.people || [];
        o = "capture opt_in_capturing opt_out_capturing has_opted_out_capturing".split(" ");
        for (n = 0; n < o.length; n++) g(u, o[n]); e._i.push([i, s, a]);
      }, e.__SV = 1);
    }(document, window.posthog || []));
    posthog = window.posthog;
    posthog.init(config.apiKey, {
      api_host: config.apiHost,
      ui_host: config.uiHost,
      defaults: config.defaults,
      respect_dnt: true,
      disable_capture_url_hashes: true,
      property_denylist: ["$current_url", "$initial_current_url", "$referrer", "$initial_referrer"],
      opt_out_capturing_by_default: true,
      capture_pageview: false,
      capture_pageleave: false,
      autocapture: false,
      capture_exceptions: false,
      capture_performance: false,
      capture_heatmaps: false,
      enable_recording_console_log: false,
      logs: { captureConsoleLogs: false },
      disable_session_recording: true,
      before_send: function (event) {
        if (!event || consent() !== "granted" || privacySignal()) return null;
        event.properties = scrubSdkProperties(event.properties);
        return event;
      },
      loaded: function (client) {
        posthog = client;
        if (consent() === "granted" && !privacySignal()) {
          client.opt_in_capturing();
          updateAttribution();
          capturePageview();
        } else {
          client.opt_out_capturing();
        }
      },
    });
    installSpaPageviews();
    document.addEventListener("click", function (event) { captureAnnotatedClick(event.target); });
  }


  function removeConsentBanner() {
    var banner = document.getElementById("suplex-analytics-consent");
    if (banner) banner.remove();
  }

  function removeSettingsButton() {
    var button = document.getElementById("suplex-analytics-settings");
    if (button) button.remove();
  }

  function showSettingsButton() {
    if (privacySignal() || document.getElementById("suplex-analytics-settings")) return;
    var button = document.createElement("button");
    button.id = "suplex-analytics-settings";
    button.type = "button";
    button.textContent = "Analytics settings";
    button.setAttribute("aria-label", "Open analytics settings");
    button.style.cssText = "position:fixed;z-index:2147483647;left:16px;bottom:16px;padding:6px 10px;border:1px solid #a3a3a3;background:#fff;color:#171717;font:13px/1.4 system-ui,sans-serif;cursor:pointer";
    button.addEventListener("click", function () { window.SuplexAnalytics.clearConsent(); });
    document.body.appendChild(button);
  }

  function showConsentBanner() {
    if (consent() || document.getElementById("suplex-analytics-consent")) return;
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
    reject.addEventListener("click", function () { window.SuplexAnalytics.denyConsent(); });
    allow.addEventListener("click", function () { window.SuplexAnalytics.grantConsent(); });
    banner.append(text, reject, allow);
    document.body.appendChild(banner);
  }

  window.SuplexAnalytics = {
    grantConsent: function () {
      if (privacySignal()) return;
      storageWrite(config.consentStorageKey, "granted");
      updateAttribution();
      removeConsentBanner();
      showSettingsButton();
      if (!started) { loadSdk(); return; }
      if (posthog) { posthog.opt_in_capturing(); capturePageview(); }
    },
    denyConsent: function () {
      storageWrite(config.consentStorageKey, "denied");
      storageRemove(config.attributionStorageKey);
      removeConsentBanner();
      showSettingsButton();
      if (posthog) { posthog.opt_out_capturing(); }
    },
    clearConsent: function () {
      storageRemove(config.consentStorageKey);
      storageRemove(config.attributionStorageKey);
      if (posthog) { posthog.opt_out_capturing(); }
      removeSettingsButton();
      showConsentBanner();
    },
  };

  if (privacySignal()) return;
  if (consent() === "granted") { showSettingsButton(); loadSdk(); }
  else if (consent() === "denied") showSettingsButton();
  else showConsentBanner();
}(window, document));
