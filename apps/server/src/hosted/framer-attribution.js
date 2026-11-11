/*
 * Suplex website analytics for Framer Custom Code (end of the body), with a script tag that
 * loads https://suplex.sh/consent.js before or after it (docs/posthog.md).
 * The project token is a public, write-only PostHog key. No personal API key belongs here.
 *
 * With granted consent and no privacy signal, links and forms to https://suplex.sh carry the
 * stored campaign touch (click IDs and UTM values), the Conversion Linker `_gl`, and the
 * PostHog `visitor` when they are opened, so the signup on suplex.sh keeps them.
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
  // Real click IDs are about 100 characters. A longer one is dropped, never cut.
  var maxClickIdLength = 256;
  var siteOrigin = "https://suplex.sh";
  var allowedCtas = ["pricing", "get", "product", "download", "hero-download", "start-free", "start-trial"];
  var allowedPlatforms = ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64"];
  var posthog;
  var started = false;

  function bounded(value) {
    return typeof value === "string" ? value.trim().slice(0, maxValueLength) : "";
  }

  function clickId(value) {
    var id = typeof value === "string" ? value.trim() : "";
    return id.length <= maxClickIdLength && /^[A-Za-z0-9._~-]+$/.test(id) ? id : "";
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

  function allowed() { return consent() === "granted" && !privacySignal(); }

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
    var touch = {};
    var referrer = safeHost(document.referrer);
    if (referrer) touch.referrer_domain = referrer;
    allowedUtm.forEach(function (key) {
      var value = bounded(params.get(key));
      if (value) touch[key.slice(4)] = value;
    });
    allowedClickIds.forEach(function (key) {
      var value = clickId(params.get(key));
      if (value) touch[key] = value;
    });
    return touch;
  }

  function linkerFrom(search) {
    var value = new URLSearchParams(search).get("_gl");
    return value && value.length <= 512 ? value : "";
  }

  // The landing page's campaign touch and `_gl`, held in memory only. Framer can change the
  // URL before the visitor accepts the banner; consent stores this touch, not the later URL.
  var landingTouch = currentTouch();
  var landingLinker = linkerFrom(window.location.search);

  function attribution() {
    var saved = {};
    try { saved = JSON.parse(storageRead(config.attributionStorageKey) || "{}"); } catch (_) { saved = {}; }
    if (!saved || typeof saved !== "object") return {};
    function safeTouch(touch) {
      if (!touch || typeof touch !== "object") return null;
      var safe = {};
      ["source", "medium", "campaign", "content", "term"].forEach(function (key) {
        var value = bounded(touch[key]);
        if (value) safe[key] = value;
      });
      var domain = bounded(touch.referrer_domain).toLowerCase();
      if (domain && /^[a-z0-9.-]+$/.test(domain)) safe.referrer_domain = domain;
      allowedClickIds.forEach(function (key) {
        var value = clickId(touch[key]);
        if (value) safe[key] = value;
      });
      return Object.keys(safe).length ? safe : null;
    }
    return { first: safeTouch(saved.first), last: safeTouch(saved.last) };
  }

  function updateAttribution() {
    if (!allowed()) return {};
    var previous = attribution();
    var touch = landingTouch;
    var hasReferrer = touch.referrer_domain && touch.referrer_domain !== window.location.hostname.toLowerCase();
    if (!hasCampaign(touch) && !hasReferrer) return previous;
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
  }

  function hasCampaign(touch) {
    return Boolean(touch) && Object.keys(touch).some(function (key) { return key !== "referrer_domain"; });
  }

  // The touch that links carry: the last touch with a campaign value, else the first one.
  // The landing touch is the fallback when storage is not available.
  function linkTouch() {
    var saved = attribution();
    if (hasCampaign(saved.last)) return saved.last;
    if (hasCampaign(saved.first)) return saved.first;
    return hasCampaign(landingTouch) ? landingTouch : {};
  }

  // What a consented link to suplex.sh carries. suplex.sh keeps the click IDs and UTM values for
  // the signup, and the visitor in a first-party cookie, so a later Suplex account login joins
  // this visitor (docs/accounts.md).
  function linkParams() {
    var touch = linkTouch();
    var params = [];
    allowedClickIds.forEach(function (key) {
      if (touch[key]) params.push([key, touch[key]]);
    });
    allowedUtm.forEach(function (key) {
      if (touch[key.slice(4)]) params.push([key, touch[key.slice(4)]]);
    });
    var linker = linkerFrom(window.location.search) || landingLinker;
    if (linker) params.push(["_gl", linker]);
    var visitor = posthog && typeof posthog.get_distinct_id === "function" ? posthog.get_distinct_id() : "";
    if (typeof visitor === "string" && /^[A-Za-z0-9._:-]{8,64}$/.test(visitor)) params.push(["visitor", visitor]);
    return params;
  }

  // The parameters this file added to each element, so a withdrawn choice removes them.
  var added = typeof WeakMap === "function" ? new WeakMap() : null;

  // Adds the consented parameters to a link or form to suplex.sh. A parameter the link already
  // has is kept. Without consent, the parameters this file added before are removed.
  function decorate(element) {
    if (!element || !element.getAttribute) return;
    var attribute = element.tagName === "FORM" ? "action" : "href";
    var raw = element.getAttribute(attribute);
    if (!raw) return;
    var target;
    try { target = new URL(raw, window.location.href); } catch (_) { return; }
    if (target.origin !== siteOrigin) return;
    var before = target.toString();
    var previous = (added && added.get(element)) || {};
    Object.keys(previous).forEach(function (key) {
      if (target.searchParams.get(key) === previous[key]) target.searchParams.delete(key);
    });
    var next = {};
    if (allowed()) {
      linkParams().forEach(function (pair) {
        if (target.searchParams.has(pair[0])) return;
        target.searchParams.set(pair[0], pair[1]);
        next[pair[0]] = pair[1];
      });
    }
    if (added) added.set(element, next);
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

  // The banner, its settings button, the `consent` URL parameter, and the links to suplex.sh
  // belong to the shared consent script (https://suplex.sh/consent.js). This file follows its
  // choice, in either load order.
  function sharedConsent() { return window.SuplexConsent; }

  function followConsent(choice) {
    if (choice === "granted") {
      if (privacySignal()) return;
      updateAttribution();
      if (!started) loadSdk();
      else if (posthog) { posthog.opt_in_capturing(); capturePageview(); }
      decorateAll();
      return;
    }
    storageRemove(config.attributionStorageKey);
    if (posthog) { posthog.opt_out_capturing(); }
    decorateAll();
  }

  function choose(choice) {
    var shared = sharedConsent();
    if (shared) {
      if (choice === "granted") shared.grant();
      else if (choice === "denied") shared.deny();
      else shared.clear();
      return;
    }
    if (choice) storageWrite(config.consentStorageKey, choice);
    else storageRemove(config.consentStorageKey);
    followConsent(choice);
  }

  window.SuplexAnalytics = {
    grantConsent: function () {
      if (privacySignal()) return;
      choose("granted");
    },
    denyConsent: function () { choose("denied"); },
    clearConsent: function () { choose(null); },
  };

  if (sharedConsent()) sharedConsent().subscribe(followConsent);
  else (window.SuplexConsentListeners = window.SuplexConsentListeners || []).push(followConsent);

  ["click", "auxclick", "contextmenu", "submit"].forEach(function (type) {
    document.addEventListener(type, decorateEvent, true);
  });
  if (allowed()) loadSdk();
}(window, document));
