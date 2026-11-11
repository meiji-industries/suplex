// One conversion event for Google Tag Manager on a hosted page. The server
// replaces the two placeholders with script-safe JSON (shared/page.rs). The
// event goes to the dataLayer at once, so it is there before the page moves
// on. The email hash stays in this function: it is added as user_data only
// when the visitor granted consent and Global Privacy Control is off, which
// is the same check as the consent defaults in page.html.
(function (event, emailHash) {
  var consent = null;
  try { consent = window.localStorage.getItem("suplex.analytics.consent.v1"); } catch (error) {}
  if (emailHash && consent === "granted" && navigator.globalPrivacyControl !== true) {
    event.user_data = { sha256_email_address: emailHash };
  }
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push(event);
})(__SUPLEX_EVENT__, __SUPLEX_EMAIL_HASH__);
