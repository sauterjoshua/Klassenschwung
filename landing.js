/* Klassenschwung – Startseite. Als Datei statt inline, damit die
   Content-Security-Policy ohne 'unsafe-inline' fuer Skripte auskommt.
   Wird synchron im <head> geladen (die Weiterleitung soll vor dem
   ersten Zeichnen greifen). */

// Die App lag frueher direkt unter index.html. Alte Lesezeichen (#/lessons/…)
// und Supabase-Links aus Bestaetigungsmails (#access_token=…, ?code=…)
// landen deshalb hier und werden an app.html weitergereicht.
(function () {
  var hash = location.hash, search = location.search;
  if (/^#\/|access_token=|error_description=/.test(hash) || /[?&]code=/.test(search)) {
    location.replace("app.html" + search + hash);
  }
})();
document.documentElement.classList.add("js");

// Scroll-Einblendung: Elemente mit .reveal werden sichtbar, sobald sie
// in den Viewport kommen. Ohne IntersectionObserver einfach alles zeigen.
document.addEventListener("DOMContentLoaded", function () {
  var items = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    items.forEach(function (el) { el.classList.add("is-visible"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      io.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.1 });
  items.forEach(function (el) { io.observe(el); });

  // Segment-Schalter: markiert den Abschnitt, der gerade auf Hoehe der
  // Bildschirmmitte liegt (im Hero und am Seitenende keiner).
  var links = Array.prototype.slice.call(document.querySelectorAll('.site-nav a[href^="#"]'));
  var inBand = {};
  var spy = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) { inBand[entry.target.id] = entry.isIntersecting; });
    links.forEach(function (link) {
      if (inBand[link.hash.slice(1)]) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }, { rootMargin: "-40% 0px -55% 0px" });
  links.forEach(function (link) {
    var target = document.getElementById(link.hash.slice(1));
    if (target) spy.observe(target);
  });
});
