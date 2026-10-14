/* ===================================================================
   Klassenschwung – statische Single-Page-App (Vanilla JS, ES-Module)
   -------------------------------------------------------------------
   Sicherheitsleitlinien in dieser Datei:
   - Benutzertexte werden ausschliesslich ueber textContent gesetzt.
     innerHTML wird nirgends mit Daten aus der Datenbank benutzt.
   - Eingaben werden getrimmt, von Steuerzeichen befreit und in der
     Laenge begrenzt (zusaetzlich zu den CHECK-Constraints in Postgres).
   - Im Frontend liegt nur der oeffentliche Anon-/Publishable-Key.
     Der eigentliche Zugriffsschutz kommt aus den RLS-Policies.
   =================================================================== */

// Lokal gebuendelt statt von esm.sh geladen: kein Fremd-CDN, keine IP-Weitergabe.
import { createClient } from "./vendor/supabase-js-2.45.4.mjs";
import {
  readTableFile, parseDelimited, detectLayout, classValues, matchClassValue, extractPeople, shortNames,
  parseIcs, deriveTimes, groupEvents, buildSlots, toCsv, csvMinutes, buildPdf, MAX_IMPORT_BYTES
} from "./import-export.js";

const appEl = document.getElementById("app");
const topbarEl = document.getElementById("topbar");
const topnavEl = document.getElementById("topnav");
const topHintEl = document.getElementById("topHint");
const topbarActionsEl = document.getElementById("topbarActions");
const backBtn = document.getElementById("backBtn");
const brandLinkEl = document.querySelector(".topbar__brand");
const toastEl = document.getElementById("toast");

// Schutz vor Clickjacking: GitHub Pages kann keinen X-Frame-Options-Header
// setzen (Netlify schon, siehe _headers). In einem fremden Rahmen startet
// die App deshalb gar nicht erst.
if (window.top !== window.self) {
  appEl.textContent = "Klassenschwung kann nicht eingebettet werden. Bitte die Seite direkt öffnen.";
  throw new Error("Klassenschwung: Start in einem Frame verweigert.");
}

/* -------------------------------------------------------------------
   Kleine DOM- und Formathilfen
   ------------------------------------------------------------------- */

/** Element-Factory. Strings/Zahlen in children werden als Text eingefuegt. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      for (const [dk, dv] of Object.entries(value)) el.dataset[dk] = String(dv);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Wie h(), nur fuer SVG-Elemente. */
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Papierkorb-Icon als Inline-SVG. stroke="currentColor" macht es faerbbar
 * (z. B. via .btn--danger), anders als ein farbiges Emoji-Glyph. */
function trashIcon() {
  return svg("svg", {
    viewBox: "0 0 24 24", width: "1.1em", height: "1.1em", fill: "none", stroke: "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true"
  }, ["M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
      "M10 11v6", "M14 11v6"].map((d) => svg("path", { d })));
}

/** Steuerzeichen, die aus Eingaben entfernt werden. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Eingabe normalisieren: Steuerzeichen raus, Whitespace normalisieren, kuerzen. */
function cleanName(value, max = 80) {
  return String(value ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Uhrzeit-Format fuer Countdowns: m:ss bzw. h:mm:ss. */
function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

function formatDurationLong(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const hh = Math.floor(s / 3600);
  const mm = Math.round((s % 3600) / 60);
  if (hh === 0) return `${mm} min`;
  return `${hh} h ${String(mm).padStart(2, "0")} min`;
}

function formatDate(value) {
  if (!value) return "";
  let d;
  if (value instanceof Date) {
    d = value;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    // Reines Datum ohne Zeitzone lokal interpretieren, nicht als UTC.
    const [y, m, day] = String(value).split("-").map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(value);
  }
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

let toastTimer = null;
function toast(message, kind = "info") {
  toastEl.textContent = message;
  toastEl.className = kind === "error" ? "toast toast--error" : "toast";
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, kind === "error" ? 6000 : 3000);
}

/** Meldungen des Browsers bei fehlender Verbindung (Chrome, Firefox, Safari, Zeitueberschreitung). */
const NETWORK_ERROR = /Failed to fetch|NetworkError|Load failed|network connection|AbortError|TimeoutError/i;

function showError(error, fallback = "Es ist ein Fehler aufgetreten.") {
  let message = (error && (error.message || error.error_description)) || fallback;
  if (NETWORK_ERROR.test(message)) message = "Keine Verbindung zum Server. Bitte WLAN prüfen und es noch einmal versuchen.";
  console.error(error);
  toast(message, "error");
}

/** Bietet Daten als Datei zum Herunterladen an. */
function downloadFile(fileName, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = h("a", { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Dateiname aus Text: "Auswertung 7b" -> "auswertung-7b". */
const fileSlug = (text) => String(text).toLocaleLowerCase("de")
  .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "export";
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function loadingView(text = "Wird geladen…") {
  return h("div", { class: "loading" }, text);
}

function emptyView(text) {
  return h("p", { class: "empty" }, text);
}

/** Seitenkopf im Stil der Startseite: Eyebrow, grosse Ueberschrift, Lead, Aktionen. */
function pageHead({ eyebrow = null, title, lead = null, actions = [] }) {
  return h("header", { class: "page-head" },
    h("div", { class: "page-head__text" },
      eyebrow ? h("p", { class: "eyebrow" }, eyebrow) : null,
      h("h2", {}, title),
      lead ? h("p", { class: "page-head__lead" }, lead) : null),
    actions.length ? h("div", { class: "page-head__actions" }, actions) : null);
}

/** Strich-Icons wie auf der Startseite (viewBox 24x24, currentColor). */
const ICONS = {
  klassen: ["M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1", "M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6", "M21 19v-1a4 4 0 0 0-3-3.85", "M15.5 4.15a3 3 0 0 1 0 5.7"],
  unterricht: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"],
  wald: ["M12 3 6 11h3l-4 6h14l-4-6h3z", "M12 17v4"],
  wandern: ["M3 20h18", "M7 20l3-9 3 5 2-3 3 7", "M17 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4"]
};

function icon(name) {
  return svg("svg", { class: "icon", viewBox: "0 0 24 24", "aria-hidden": "true" },
    ICONS[name].map((d) => svg("path", { d })));
}

/* -------------------------------------------------------------------
   Konfiguration laden
   ------------------------------------------------------------------- */

function renderSetupHint() {
  topbarEl.hidden = true;
  appEl.replaceChildren(
    h("div", { class: "card stack" },
      h("h2", {}, "Konfiguration fehlt"),
      h("p", { class: "muted" },
        "Es wurde keine gültige config.js gefunden. Lege sie auf Basis von " +
        "config.example.js an und trage SUPABASE_URL sowie SUPABASE_ANON_KEY ein."),
      h("pre", { class: "small" }, "cp config.example.js config.js\n# danach die Werte eintragen")
    )
  );
}

let CONFIG = null;
try {
  ({ CONFIG } = await import("./config.js"));
} catch {
  CONFIG = null;
}
if (!CONFIG || !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY ||
    String(CONFIG.SUPABASE_URL).includes("DEIN-PROJEKT")) {
  CONFIG = null;
  renderSetupHint();
}

/* -------------------------------------------------------------------
   Spalten-Definition
   ------------------------------------------------------------------- */

// "links" ist der neutrale Startzustand: Dort beginnen alle, seine Dauer
// wird nicht gespeichert (Migration 0008). Gemessen wird nur "mitte" und "rechts".
const COLUMNS = [
  { key: "links",  title: "Start" },
  { key: "mitte",  title: "Du arbeitest gut" },
  { key: "rechts", title: "Du arbeitest großartig" }
];
const POSITIVE_COLUMNS = COLUMNS.filter((c) => c.key !== "links");
// Singular-/Pluralformen fuer die Live-Zaehlung
// (z. B. "12 am Start | 5 arbeiten gut | 2 arbeiten großartig").
const STATE_LABELS = {
  links:  { one: "am Start",        many: "am Start" },
  mitte:  { one: "arbeitet gut",    many: "arbeiten gut" },
  rechts: { one: "arbeitet großartig", many: "arbeiten großartig" }
};
const columnIndex = (key) => COLUMNS.findIndex((c) => c.key === key);
const isAdjacent = (from, to) => Math.abs(columnIndex(from) - columnIndex(to)) === 1;

/** Anzahl der Schueler je Zustand. */
function stateCounts(rows) {
  const counts = { links: 0, mitte: 0, rechts: 0 };
  for (const row of rows) {
    if (row.col in counts) counts[row.col]++;
  }
  return counts;
}

/** "12 am Start | 5 arbeiten gut | 2 arbeiten großartig" */
function countsText(counts) {
  return COLUMNS
    .map((c) => {
      const n = counts[c.key];
      return `${n} ${n === 1 ? STATE_LABELS[c.key].one : STATE_LABELS[c.key].many}`;
    })
    .join(" | ");
}

const byStudentName = (rows) =>
  [...rows].sort((a, b) => (a.students?.name ?? "").localeCompare(b.students?.name ?? "", "de"));

/** Die drei Kanban-Spalten; makeCard(row, columnKey) baut die einzelne Karte. */
function kanbanColumns(rows, makeCard) {
  const byColumn = { links: [], mitte: [], rechts: [] };
  for (const row of rows) {
    if (row.col in byColumn) byColumn[row.col].push(row);
  }
  return COLUMNS.map((column) => {
    const list = byColumn[column.key].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return h("div", { class: `column column--${column.key}` },
      h("div", { class: "column__head" },
        column.title,
        h("span", { class: "column__count" }, String(list.length))),
      h("div", { class: "column__body", dataset: { column: column.key } },
        list.length ? list.map((row) => makeCard(row, column.key)) : h("p", { class: "empty small" }, "–")));
  });
}

/** Schuelerbox ohne Bedienung (Klassenansicht). */
function staticStudentBox(row) {
  return h("div", { class: "student", dataset: { studentId: row.student_id, column: row.col } },
    h("div", { class: "student__name" }, row.students?.name ?? "Unbekannt"));
}

/* -------------------------------------------------------------------
   Board-Layout: quadratische Schueler-Boxen, Groesse dynamisch berechnet
   ------------------------------------------------------------------- */

const BOARD_MIN_HEIGHT_PX = 320;
const BOARD_BOTTOM_MARGIN_PX = 16;
const BOX_GAP_PX = 10;
const BOX_MIN_FONT_REM = 1.1;
const BOX_FONT_RATIO = 0.22; // Schriftgroesse als Anteil der Boxgroesse
const BOARD_DRAG_START_PX = 6;

/** Verkleinert die Schrift einzelner Boxen, bis der Name hineinpasst –
 * lange Namen werden so nicht mitten im Wort umbrochen ("Quenti-n"). */
function fitNames(cards, minPx) {
  for (const card of cards) {
    const nameEl = card.querySelector(".student__name");
    if (!nameEl) continue;
    for (let pass = 0; pass < 3; pass++) {
      const ratio = Math.min(
        nameEl.clientWidth / Math.max(1, nameEl.scrollWidth),
        card.clientHeight / Math.max(1, card.scrollHeight));
      if (ratio >= 0.999) break;
      const size = parseFloat(card.style.fontSize) || 16;
      const next = Math.max(minPx, size * ratio * 0.97);
      if (next >= size) break;
      card.style.fontSize = `${next}px`;
    }
  }
}

/** Groesste quadratische Boxgroesse, mit der `count` Kacheln ohne
 * Ueberlauf in width x height passen (Rasterberechnung wie bei
 * Videokonferenz-Kachel-Layouts: alle Spaltenzahlen durchprobieren). */
function bestSquareLayout(width, height, count, gap) {
  let best = { size: 0, cols: 1, rows: count };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const size = Math.min(
      (width - (cols - 1) * gap) / cols,
      (height - (rows - 1) * gap) / rows
    );
    if (size > best.size) best = { size, cols, rows };
  }
  return best;
}

/** Spaltenbreiten (flex-grow) und Boxgroessen im Board neu berechnen.
 * Muss nach jeder DOM-Aenderung des Boards sowie bei Groessenaenderungen
 * des Containers erneut aufgerufen werden. */
function layoutBoard(boardEl) {
  const availableHeight = Math.max(
    BOARD_MIN_HEIGHT_PX,
    window.innerHeight - boardEl.getBoundingClientRect().top - BOARD_BOTTOM_MARGIN_PX
  );
  boardEl.style.height = `${availableHeight}px`;

  const rootFontPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const minFontPx = BOX_MIN_FONT_REM * rootFontPx;
  const minBoxPx = minFontPx / BOX_FONT_RATIO;

  const bodies = [...boardEl.querySelectorAll(".column__body")];

  // Phase 1: flex-grow fuer ALLE Spalten setzen, bevor irgendeine Breite
  // gelesen wird. Wuerden Setzen und Lesen pro Spalte verschachtelt
  // ablaufen, saehe eine fruehe Spalte noch die alten (bzw. bei frisch
  // gebauten Spalten die Default-) flex-grow-Werte ihrer Geschwister und
  // wuerde dadurch mit einer voruebergehend falschen Breite rechnen.
  const counts = bodies.map((body) => {
    const count = body.querySelectorAll(".student").length;
    body.parentElement.style.flexGrow = String(count);
    return count;
  });

  // Phase 2: erst jetzt, wo alle Spalten ihre endgueltige Breite haben,
  // die Boxgroessen berechnen.
  bodies.forEach((body, i) => {
    const count = counts[i];
    if (!count) {
      body.style.gridTemplateColumns = "";
      body.style.gridAutoRows = "";
      body.style.overflowY = "";
      return;
    }

    const cards = body.querySelectorAll(".student");
    const cs = getComputedStyle(body);
    const width = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const height = body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (width <= 0 || height <= 0) return;

    // Zuerst die Boxgroesse ohne Untergrenze ausrechnen. Wuerde die
    // Schrift dabei die Mindestgroesse unterschreiten, Boxgroesse auf
    // das erzwungene Minimum einfrieren und stattdessen vertikal scrollen.
    let layout = bestSquareLayout(width, height, count, BOX_GAP_PX);
    let overflowY = "hidden";
    if (layout.size < minBoxPx) {
      const size = minBoxPx;
      const cols = Math.max(1, Math.min(count, Math.floor((width + BOX_GAP_PX) / (size + BOX_GAP_PX))));
      layout = { size, cols, rows: Math.ceil(count / cols) };
      overflowY = "auto";
    }

    const fontPx = Math.max(minFontPx, layout.size * BOX_FONT_RATIO);
    body.style.gridTemplateColumns = `repeat(${layout.cols}, ${layout.size}px)`;
    body.style.gridAutoRows = `${layout.size}px`;
    body.style.gap = `${BOX_GAP_PX}px`;
    body.style.overflowY = overflowY;
    cards.forEach((card) => { card.style.fontSize = `${fontPx}px`; });
    fitNames(cards, minFontPx * 0.75);
  });
}

/** Wie layoutBoard(), aber fuer die "Sortierte Ansicht": ein einzelnes
 * Raster ueber ALLE Schueler statt drei Spalten. Anders als im Kanban-Board
 * gibt es hier keinen Scroll-Fallback: Prioritaet ist, dass alle Schueler
 * gleichzeitig sichtbar bleiben, notfalls auf Kosten der Mindestschriftgroesse. */
function layoutStudentGrid(gridEl) {
  const availableHeight = Math.max(
    BOARD_MIN_HEIGHT_PX,
    window.innerHeight - gridEl.getBoundingClientRect().top - BOARD_BOTTOM_MARGIN_PX
  );
  gridEl.style.height = `${availableHeight}px`;

  const cards = gridEl.querySelectorAll(".student");
  const count = cards.length;
  if (!count) return;

  const cs = getComputedStyle(gridEl);
  const width = gridEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const height = gridEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (width <= 0 || height <= 0) return;

  const layout = bestSquareLayout(width, height, count, BOX_GAP_PX);
  const fontPx = Math.max(1, layout.size * BOX_FONT_RATIO);

  gridEl.style.gridTemplateColumns = `repeat(${layout.cols}, ${layout.size}px)`;
  gridEl.style.gridAutoRows = `${layout.size}px`;
  gridEl.style.gap = `${BOX_GAP_PX}px`;
  cards.forEach((card) => { card.style.fontSize = `${fontPx}px`; });
  fitNames(cards, 8);
}

/* -------------------------------------------------------------------
   Supabase-Client
   ------------------------------------------------------------------- */

const sb = CONFIG
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;

/** Alle Zeilen einer Abfrage: PostgREST liefert hoechstens 1000 pro Anfrage.
 * build() muss jedes Mal eine neue, eindeutig sortierte Abfrage liefern. */
async function allPages(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const data = unwrap(await build().range(from, from + 999));
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

/** Wirft bei Supabase-Fehlern, gibt sonst die Daten zurueck. */
function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

/* -------------------------------------------------------------------
   Anwendungszustand
   ------------------------------------------------------------------- */

const state = {
  session: null,
  teacher: null,
  // Ohne Anmeldung: Fokus-Wald und Probe-Unterricht nur im Browser (siehe guestApi).
  guest: false,
  // Migration 0007 (Stundenplan, automatisches Unterrichtsende) ausgefuehrt?
  scheduleAvailable: false,
  classIndex: new Map(),   // id -> Name aller eigenen Klassen (fuer Stundenplan und Menues)
  openLessons: new Set(),  // in diesem Tab laufende Unterrichte (Beenden beim Schliessen)
  cleanup: []        // Aufraeumfunktionen der aktuellen Ansicht (Timer etc.)
};

function registerCleanup(fn) { state.cleanup.push(fn); }
function runCleanup() {
  for (const fn of state.cleanup.splice(0)) {
    try { fn(); } catch (e) { console.error(e); }
  }
}

/* -------------------------------------------------------------------
   hCaptcha (optional)
   ------------------------------------------------------------------- */

const captchaEnabled = () => Boolean(CONFIG && CONFIG.HCAPTCHA_SITE_KEY);

/* Farbwelten: die Tokens stehen in style.css (Abschnitt "Farbwelten").
   Die Wahl wird im Konto gespeichert (user_metadata.palette), damit sie auf
   allen Geraeten gilt, z. B. auch am Beamer-PC. */
const PALETTES = [
  { key: "salbei",    name: "Salbei",    hint: "Gedämpftes Waldgrün (Standard)" },
  { key: "tafel",     name: "Tafelgrün", hint: "Petrol wie die Schultafel" },
  { key: "tinte",     name: "Tinte",     hint: "Königsblau wie Füllertinte" },
  { key: "bernstein", name: "Bernstein", hint: "Gold wie ein Sternchen im Heft" }
];
const DEFAULT_PALETTE = "salbei";

function paletteOf(session) {
  const key = session?.user?.user_metadata?.palette;
  return PALETTES.some((p) => p.key === key) ? key : DEFAULT_PALETTE;
}

function applyPalette(key) {
  if (key === DEFAULT_PALETTE) delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = key;
}

/** Checkbox "Nutzungsbedingungen akzeptieren" (Registrierung und
 * Bestaetigung einer neuen Fassung, siehe renderTermsGate). */
function termsCheck(input) {
  return h("label", { class: "check" },
    input,
    h("span", {},
      "Ich akzeptiere die ",
      h("a", { href: "./nutzungsbedingungen.html", target: "_blank", rel: "noopener" }, "Nutzungsbedingungen"),
      " (inkl. Auftragsverarbeitung) und gebe Schülerdaten nur mit Erlaubnis meiner Schule ein. " +
      "Hinweise zum Datenschutz: ",
      h("a", { href: "./datenschutz.html", target: "_blank", rel: "noopener" }, "Datenschutzerklärung"),
      "."));
}

/* Registrieren geht nur mit Einladungslink (app.html?einladung=<code>).
   Geprueft wird in der Datenbank (Migration 0011, Trigger auf auth.users);
   die App fragt vorher nur nach, ob der Link noch gilt. */
const INVITE_PARAM = "einladung";

function inviteFromUrl() {
  const code = new URLSearchParams(window.location.search).get(INVITE_PARAM) ?? "";
  return /^[0-9a-f]{32}$/.test(code) ? code : null;
}

function inviteLink(code) {
  return new URL(`app.html?${INVITE_PARAM}=${code}`, window.location.href).href;
}

/** Nach dem Registrieren den Code aus der Adresszeile nehmen. */
function dropInviteFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete(INVITE_PARAM);
  history.replaceState(history.state, "", url.href);
}

const INVITE_PROBLEMS = {
  used: "Dieser Einladungslink wurde schon benutzt. Wenn das dein Konto ist, melde dich einfach an.",
  expired: "Dieser Einladungslink ist abgelaufen. Bitte frag nach einem neuen.",
  unknown: "Diesen Einladungslink gibt es nicht. Bitte prüfe, ob er vollständig kopiert wurde."
};

const termsAccepted = () => state.session?.user?.user_metadata?.terms_version === TERMS_VERSION;

// Fassung von nutzungsbedingungen.html ("Stand"); wird bei der Registrierung
// mit Zeitpunkt in den user_metadata gespeichert. Bei Aenderungen anpassen.
const TERMS_VERSION = "2026-10-02";

/** Laedt hCaptcha erst, wenn es wirklich gebraucht wird (Key gesetzt und
 * Login-Ansicht offen). Ohne Key wird js.hcaptcha.com nie kontaktiert.
 * Wird es aktiviert, muss hCaptcha in datenschutz.html ergaenzt werden. */
function waitForHcaptcha(timeoutMs = 8000) {
  if (!document.querySelector("script[data-hcaptcha]")) {
    document.head.append(h("script", {
      src: "https://js.hcaptcha.com/1/api.js?render=explicit", async: true, "data-hcaptcha": true
    }));
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      if (window.hcaptcha && typeof window.hcaptcha.render === "function") {
        return resolve(window.hcaptcha);
      }
      if (Date.now() - started > timeoutMs) {
        return reject(new Error("hCaptcha konnte nicht geladen werden."));
      }
      setTimeout(poll, 100);
    })();
  });
}

/* -------------------------------------------------------------------
   Authentifizierung
   ------------------------------------------------------------------- */

async function ensureTeacher() {
  // settings gibt es erst ab Migration 0007; ohne sie laeuft alles wie bisher.
  let result = await sb.from("teachers").select("id, nickname, settings").limit(1).maybeSingle();
  state.scheduleAvailable = !result.error;
  if (result.error) {
    if (!isMissingFocusSchema(result.error)) throw result.error;
    result = await sb.from("teachers").select("id, nickname").limit(1).maybeSingle();
  }
  const existing = unwrap(result);
  if (existing) return { ...existing, settings: existing.settings ?? {} };

  // Fallback, falls der Signup-Trigger (noch) nicht existiert.
  const user = state.session?.user;
  const nickname =
    cleanName(user?.user_metadata?.nickname || String(user?.email || "Lehrkraft").split("@")[0], 60) ||
    "Lehrkraft";

  const created = unwrap(
    await sb.from("teachers")
      .insert({ auth_user_id: user.id, nickname })
      .select("id, nickname")
      .single()
  );
  return { ...created, settings: {} };
}

function renderAuth() {
  runCleanup();
  topbarEl.hidden = true;
  appEl.className = "app";

  let mode = "signin";
  let captchaWidget = null;
  const invite = inviteFromUrl();

  const errorBox = h("div", { class: "error-box", hidden: true });
  const emailInput = h("input", {
    class: "input", type: "email", required: true, autocomplete: "email",
    maxlength: "160", placeholder: "name@schule.de"
  });
  const passwordInput = h("input", {
    class: "input", type: "password", required: true, minlength: "8",
    maxlength: "72", autocomplete: "current-password", placeholder: "mindestens 8 Zeichen"
  });
  const nicknameInput = h("input", {
    class: "input", type: "text", maxlength: "60", autocomplete: "nickname",
    placeholder: "z. B. Frau Sauter"
  });
  const nicknameField = h("label", { class: "field", hidden: true },
    h("span", { class: "field__label" }, "Anzeigename"), nicknameInput);
  const termsInput = h("input", { type: "checkbox" });
  const termsField = termsCheck(termsInput);
  termsField.hidden = true;
  const captchaBox = h("div", { class: "captcha" });
  const submitBtn = h("button", { class: "btn btn--primary", type: "submit" }, "Anmelden");

  const tabSignin = h("button", { class: "btn", type: "button", "aria-pressed": "true" }, "Anmelden");
  const tabSignup = h("button", { class: "btn", type: "button", "aria-pressed": "false" }, "Registrieren");

  function setMode(next) {
    mode = next;
    const signup = next === "signup";
    tabSignin.setAttribute("aria-pressed", String(!signup));
    tabSignup.setAttribute("aria-pressed", String(signup));
    nicknameField.hidden = !signup;
    termsField.hidden = !signup;
    passwordInput.autocomplete = signup ? "new-password" : "current-password";
    submitBtn.textContent = signup ? "Konto erstellen" : "Anmelden";
    errorBox.hidden = true;
  }
  tabSignin.addEventListener("click", () => setMode("signin"));
  tabSignup.addEventListener("click", () => setMode("signup"));
  if (invite) setMode("signup");

  function fail(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  const form = h("form", { class: "card" },
    invite ? h("div", { class: "auth__tabs" }, tabSignin, tabSignup) : null,
    errorBox,
    h("label", { class: "field" }, h("span", { class: "field__label" }, "E-Mail"), emailInput),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Passwort"), passwordInput),
    nicknameField,
    termsField,
    captchaBox,
    submitBtn
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const email = String(emailInput.value).trim().slice(0, 160);
    const password = String(passwordInput.value);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return fail("Bitte eine gültige E-Mail-Adresse eingeben.");
    }
    if (password.length < 8) return fail("Das Passwort muss mindestens 8 Zeichen lang sein.");
    if (password.length > 72) return fail("Das Passwort darf höchstens 72 Zeichen lang sein.");
    if (mode === "signup" && !termsInput.checked) {
      return fail("Bitte zuerst die Nutzungsbedingungen akzeptieren.");
    }

    let captchaToken;
    if (captchaEnabled()) {
      captchaToken = captchaWidget !== null ? window.hcaptcha.getResponse(captchaWidget) : "";
      if (!captchaToken) return fail("Bitte zuerst das Captcha lösen.");
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Bitte warten…";
    try {
      if (mode === "signup") {
        const nickname = cleanName(nicknameInput.value, 60) || email.split("@")[0];
        const { data, error } = await sb.auth.signUp({
          email, password,
          // Zeitpunkt und Fassung der akzeptierten Nutzungsbedingungen als Nachweis
          options: {
            data: { nickname, invite, terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() },
            captchaToken
          }
        });
        if (error) {
          // Lehnt der Trigger ab, meldet Supabase nur "Database error saving new user".
          if (/database error/i.test(error.message ?? "")) {
            throw new Error("Registrieren hat nicht geklappt: Der Einladungslink ist ungültig, abgelaufen oder schon benutzt.");
          }
          throw error;
        }
        dropInviteFromUrl();
        if (!data.session) {
          toast("Konto erstellt. Bitte E-Mail bestätigen und danach anmelden.");
          setMode("signin");
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({
          email, password, options: { captchaToken }
        });
        if (error) throw error;
      }
    } catch (error) {
      fail(error?.message || "Anmeldung fehlgeschlagen.");
    } finally {
      if (captchaEnabled() && captchaWidget !== null) window.hcaptcha.reset(captchaWidget);
      submitBtn.disabled = false;
      submitBtn.textContent = mode === "signup" ? "Konto erstellen" : "Anmelden";
    }
  });

  // Ohne Einladung: Hinweis, und was ohne Konto geht.
  const inviteNote = h("section", { class: "card auth__note" },
    h("p", { class: "auth__note-tag" }, "Einladung"),
    h("p", {}, "Du wurdest zu Klassenschwung eingeladen. Lege hier dein Konto an."));
  const privateNote = invite ? inviteNote : h("section", { class: "card auth__note" },
    h("p", { class: "auth__note-tag" }, "Privates Projekt"),
    h("p", {}, "Ein Konto anlegen kann nur, wer einen Einladungslink bekommen hat."),
    h("p", { class: "muted small" }, "Ohne Anmeldung kannst du den Fokus-Wald nutzen und einen Probe-Unterricht ausprobieren."),
    h("div", { class: "row" },
      h("a", { class: "btn", href: "#/focus" }, "Fokus-Wald"),
      h("a", { class: "btn", href: "#/ausprobieren" }, "Unterricht ausprobieren")));

  appEl.replaceChildren(
    h("div", { class: "auth" },
      h("div", { class: "auth__brand" },
        brandMark(),
        h("h1", {}, "Klassenschwung"),
        h("p", { class: "muted" }, "Gutes Arbeiten im Unterricht sichtbar machen.")),
      privateNote,
      form,
      h("a", { class: "auth__home", href: "./" }, "\u2190 Zur Startseite"))
  );

  // Gilt der Link noch? Sonst gleich sagen statt erst nach dem Absenden.
  if (invite) {
    sb.rpc("invite_status", { p_code: invite }).then(({ data, error }) => {
      if (error || !INVITE_PROBLEMS[data] || !inviteNote.isConnected) return;
      inviteNote.replaceChildren(
        h("p", { class: "auth__note-tag" }, "Einladung"),
        h("p", {}, INVITE_PROBLEMS[data]));
      setMode("signin");
    });
  }

  if (captchaEnabled()) {
    waitForHcaptcha()
      .then((hc) => { captchaWidget = hc.render(captchaBox, { sitekey: CONFIG.HCAPTCHA_SITE_KEY }); })
      .catch((error) => fail(error.message));
  }
}

/* -------------------------------------------------------------------
   Datenzugriff
   ------------------------------------------------------------------- */

const remoteApi = {
  async listClasses() {
    return unwrap(await sb.from("classes").select("id, name, students(count)").order("name"));
  },

  async createClass(name) {
    return unwrap(await sb.from("classes")
      .insert({ teacher_id: state.teacher.id, name })
      .select("id, name").single());
  },

  async deleteClass(id) {
    return unwrap(await sb.from("classes").delete().eq("id", id));
  },

  async getClass(id) {
    return unwrap(await sb.from("classes").select("id, name").eq("id", id).maybeSingle());
  },

  async listStudents(classId) {
    return unwrap(await sb.from("students").select("id, name").eq("class_id", classId).order("name"));
  },

  async createStudent(classId, name) {
    return unwrap(await sb.from("students")
      .insert({ class_id: classId, name })
      .select("id, name").single());
  },

  async deleteStudent(id) {
    return unwrap(await sb.from("students").delete().eq("id", id));
  },

  /** Mehrere Namen auf einmal (Import einer Klassenliste). */
  async createStudents(classId, names) {
    return unwrap(await sb.from("students")
      .insert(names.map((name) => ({ class_id: classId, name }))).select("id"));
  },

  /** Alle Schueler der Klasse eines Unterrichts (auch wer gerade nicht dabei ist). */
  async lessonRoster(lessonId, classId) {
    return api.listStudents(classId);
  },

  async listSeats(classId) {
    return unwrap(await sb.from("students")
      .select("id, name, seat_x, seat_y, seat_rot").eq("class_id", classId).order("name"));
  },

  async setSeat(studentId, seat) {
    return unwrap(await sb.from("students")
      .update({ seat_x: seat?.x ?? null, seat_y: seat?.y ?? null, seat_rot: seat?.rot ?? false })
      .eq("id", studentId));
  },

  async clearSeats(classId) {
    return unwrap(await sb.from("students")
      .update({ seat_x: null, seat_y: null, seat_rot: false }).eq("class_id", classId));
  },

  async getStudent(id) {
    return unwrap(await sb.from("students").select("id, name, class_id").eq("id", id).maybeSingle());
  },

  async listLessons() {
    return unwrap(await sb.from("lessons")
      .select(`id, name, date, ended_at, created_at, class_id, classes(name)${lessonExtra()}`)
      .order("created_at", { ascending: false })
      .limit(200));
  },

  async getLesson(id) {
    return unwrap(await sb.from("lessons")
      .select(`id, name, date, ended_at, class_id, mode, created_at, classes(name)${lessonExtra()}`)
      .eq("id", id).maybeSingle());
  },

  async deleteLesson(id) {
    return unwrap(await sb.from("lessons").delete().eq("id", id));
  },

  // "column" ist in Postgres reserviert; PostgREST quotet den Bezeichner
  // korrekt, wir benennen ihn hier per Alias auf "col" um.
  async boardRows(lessonId) {
    return unwrap(await sb.from("lesson_students")
      .select("id, col:column, position, student_id, students(name)")
      .eq("lesson_id", lessonId)
      .order("position", { ascending: true }));
  },

  async studentTimes(studentId) {
    return allPages(() => sb.from("student_lesson_column_seconds")
      .select("lesson_id, lesson_name, lesson_date, col:column, seconds")
      .eq("student_id", studentId)
      .order("lesson_id").order("column"));
  },

  /** Unterrichte, an denen die Person teilgenommen hat (auch ohne erfasste Zeit). */
  async studentLessons(studentId) {
    return allPages(() => sb.from("lesson_students")
      .select("lesson_id, lessons(name, date)")
      .eq("student_id", studentId)
      .order("id"));
  },

  async startLesson(classId, mode) {
    return unwrap(await sb.rpc("start_lesson", { p_class_id: classId, p_mode: mode }));
  },

  async moveStudent(lessonId, studentId, column) {
    return unwrap(await sb.rpc("move_student", {
      p_lesson_id: lessonId, p_student_id: studentId, p_column: column
    }));
  },

  async endLesson(lessonId) {
    return unwrap(await sb.rpc("end_lesson", { p_lesson_id: lessonId }));
  },

  async reopenLesson(lessonId) {
    return unwrap(await sb.rpc("reopen_lesson", { p_lesson_id: lessonId }));
  },

  /** Setzt den automatischen Endzeitpunkt (null = kein zeitliches Ende). */
  async setAutoEnd(lessonId, date) {
    if (!state.scheduleAvailable) return null;
    return unwrap(await sb.from("lessons")
      .update({ auto_end_at: date ? date.toISOString() : null }).eq("id", lessonId));
  },

  /** Beendet faellige Unterrichte serverseitig zum eingestellten Zeitpunkt. */
  async closeDueLessons() {
    if (!state.scheduleAvailable) return 0;
    const { data, error } = await sb.rpc("close_due_lessons");
    if (error) { console.error(error); return 0; }
    return data ?? 0;
  },

  async saveSettings(settings) {
    return unwrap(await sb.from("teachers").update({ settings }).eq("id", state.teacher.id));
  },

  /** Zeiten aller Schueler einer Klasse, je Unterricht und Spalte. */
  async classTimes(classId) {
    return allPages(() => sb.from("student_lesson_column_seconds")
      .select("student_id, lesson_id, lesson_name, lesson_date, col:column, seconds")
      .eq("class_id", classId)
      .order("lesson_id").order("student_id").order("column"));
  },

  /** Wer an welchem Unterricht der Klasse teilgenommen hat. */
  async classAttendance(classId) {
    return allPages(() => sb.from("lesson_students")
      .select("student_id, lesson_id, lessons!inner(class_id, name, date)")
      .eq("lessons.class_id", classId)
      .order("id"));
  },

  /** Loescht eigene Unterrichte aus vergangenen Schuljahren (Migration 0008;
   * der Cron-Job erledigt das ohnehin taeglich fuer alle Konten). */
  async deletePastSchoolYears() {
    const { error } = await sb.rpc("delete_past_school_years");
    if (error && !["PGRST202", "42883"].includes(error.code)) console.error(error);
  },

  async listFocusClasses() {
    const select = (trees) => sb.from("classes")
      .select(`id, name, focus_reward, focus_reward_goal, focus_reward_offset, focus_trees(${trees})`)
      .order("name");
    let result = await select("id, goal_seconds, open_goal, created_at");
    // Ohne Migration 0010 gibt es "open_goal" noch nicht: Baeume dann ohne Voegel.
    if (result.error?.code === "42703") result = await select("id, goal_seconds, created_at");
    const classes = unwrap(result);
    // Gepflanzt, aber wegen schlechten WLANs noch nicht uebertragen: schon mitzaehlen.
    for (const op of queue.ops.filter((o) => o.kind === "tree")) {
      const cls = classes.find((c) => c.id === op.classId);
      if (cls && !cls.focus_trees.some((t) => t.id === op.treeId)) {
        cls.focus_trees.push({ id: op.treeId, goal_seconds: op.seconds, open_goal: op.open === true,
          created_at: new Date(op.at).toISOString() });
      }
    }
    return classes;
  },

  async updateFocusReward(classId, fields) {
    return unwrap(await sb.from("classes").update(fields).eq("id", classId));
  },

  /** Alle Zeilen einer Tabelle, die RLS diesem Konto zeigt. PostgREST
   * liefert hoechstens 1000 Zeilen pro Anfrage, daher seitenweise.
   * null, wenn die Tabelle (Migration nicht ausgefuehrt) fehlt. */
  async allRows(table) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select("*").order("id").range(from, from + 999);
      if (error) {
        if (isMissingFocusSchema(error)) return null;
        throw error;
      }
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  },

  /** Datenexport (Art. 15/20 DSGVO): alles, was zu diesem Konto gespeichert ist. */
  async exportAll() {
    const user = state.session?.user;
    const out = {
      exportiert_am: new Date().toISOString(),
      konto: {
        email: user?.email ?? null,
        registriert_am: user?.created_at ?? null,
        nutzungsbedingungen: user?.user_metadata?.terms_version ?? null,
        nutzungsbedingungen_akzeptiert_am: user?.user_metadata?.terms_accepted_at ?? null,
        farbwelt: user?.user_metadata?.palette ?? null
      },
      tabellen: {}
    };
    for (const table of ["teachers", "classes", "students", "lessons",
                         "lesson_students", "column_time_logs", "focus_trees"]) {
      const rows = await api.allRows(table);
      if (rows) out.tabellen[table] = rows;
    }
    return out;
  },

  /** Loescht den Auth-User; alle Daten haengen per ON DELETE CASCADE daran
   * (siehe supabase/migrations/0006_delete_account.sql). */
  async deleteOwnAccount() {
    return unwrap(await sb.rpc("delete_own_account"));
  }
};

/* -------------------------------------------------------------------
   Ohne Anmeldung (Gastmodus)
   -------------------------------------------------------------------
   Ohne Konto laufen Fokus-Wald und ein Probe-Unterricht ganz im
   Browser; an Supabase geht nichts. Der Fokus-Wald (nur Klassennamen,
   Baeume, Belohnung) liegt im localStorage. Der Probe-Unterricht mit den
   eingetippten Namen liegt nur im Arbeitsspeicher und ist nach dem
   Neuladen oder Schliessen weg. Im Gastmodus leitet `api` alle Aufrufe
   an guestApi um; was es dort nicht gibt, braucht ein Konto.
   ------------------------------------------------------------------- */

const GUEST_FOREST_KEY = "bt.gast.wald";
const GUEST_ID_PREFIX = "gast-";
const GUEST_MAX_CLASSES = 30;
const GUEST_MAX_TREES = 2000;
const GUEST_MAX_STUDENTS = 40;
const GUEST_CLASS_NAME_MAX = 40;

const isGuestId = (id) => typeof id === "string" && id.startsWith(GUEST_ID_PREFIX);
const guestId = () => GUEST_ID_PREFIX +
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Probe-Unterrichte dieses Tabs: id -> { lesson, rows, logs }. */
const guestLessons = new Map();

/** Fokus-Wald aus dem localStorage; unbrauchbare Eintraege fallen weg. */
function readGuestForest() {
  const raw = readPref(GUEST_FOREST_KEY, null);
  const classes = Array.isArray(raw?.classes) ? raw.classes : [];
  return classes.slice(0, GUEST_MAX_CLASSES).flatMap((c) => {
    const name = cleanName(String(c?.name ?? ""), GUEST_CLASS_NAME_MAX);
    if (!name || !isGuestId(c?.id)) return [];
    const reward = cleanName(String(c.focus_reward ?? ""), 120);
    const trees = (Array.isArray(c.focus_trees) ? c.focus_trees : [])
      .filter((t) => isGuestId(t?.id) && !Number.isNaN(Date.parse(t?.created_at)))
      .slice(-GUEST_MAX_TREES)
      .map((t) => ({ id: t.id, goal_seconds: clampInt(t.goal_seconds, 60, 7200, 60), open_goal: t.open_goal === true,
        created_at: t.created_at }));
    return [{
      id: c.id,
      name,
      focus_reward: reward || null,
      focus_reward_goal: reward ? clampInt(c.focus_reward_goal, 1, 500, 10) : null,
      focus_reward_offset: clampInt(c.focus_reward_offset, 0, GUEST_MAX_TREES, 0),
      focus_trees: trees
    }];
  });
}

let guestStorageWarned = false;
function writeGuestForest(classes) {
  try {
    localStorage.setItem(GUEST_FOREST_KEY, JSON.stringify({ classes }));
  } catch {
    if (!guestStorageWarned) {
      guestStorageWarned = true;
      toast("Dieser Browser lässt kein Speichern zu. Der Wald bleibt nur, bis du die Seite schließt.", "error");
    }
  }
}

function updateGuestClass(classId, change) {
  const classes = readGuestForest();
  const cls = classes.find((c) => c.id === classId);
  if (!cls) throw new Error("Klasse nicht gefunden.");
  const result = change(cls);
  writeGuestForest(classes);
  return result;
}

function addGuestClass(name) {
  const classes = readGuestForest();
  if (classes.length >= GUEST_MAX_CLASSES) throw new Error(`Höchstens ${GUEST_MAX_CLASSES} Klassen.`);
  if (classes.some((c) => c.name.toLocaleLowerCase("de") === name.toLocaleLowerCase("de"))) {
    throw new Error(`Die Klasse „${name}“ gibt es schon.`);
  }
  classes.push({ id: guestId(), name, focus_reward: null, focus_reward_goal: null, focus_reward_offset: 0, focus_trees: [] });
  writeGuestForest(classes);
}

function deleteGuestClass(classId) {
  writeGuestForest(readGuestForest().filter((c) => c.id !== classId));
}

/** Probe-Unterricht anlegen; names sind bereits bereinigt und eindeutig. */
function startGuestLesson(className, names, mode) {
  const id = guestId();
  const now = new Date().toISOString();
  // Alle eingetippten Namen; wer fehlt, steht nur hier und nicht in rows.
  const roster = names.map((name) => ({ id: guestId(), name }));
  guestLessons.set(id, {
    lesson: {
      id, name: `${className} (Probe)`, date: now.slice(0, 10), ended_at: null, created_at: now,
      class_id: null, mode, classes: { name: className }
    },
    rows: roster.map((s, i) => ({
      id: guestId(), col: "links", position: i + 1, student_id: s.id, students: { name: s.name }
    })),
    roster,
    // Wie column_time_logs: nur positive Zustaende.
    logs: []
  });
  return id;
}

function guestLesson(lessonId) {
  const entry = guestLessons.get(lessonId);
  if (!entry) throw new Error("Der Probe-Unterricht ist nicht mehr da. Er wird nicht gespeichert.");
  return entry;
}

const closeGuestLogs = (entry, studentId = null) => {
  const now = Date.now();
  for (const log of entry.logs) {
    if (log.ended_at === null && (studentId === null || log.student_id === studentId)) log.ended_at = now;
  }
};

/** Zeiten je Person im Probe-Unterricht (nur "gut" und "großartig"). */
function guestLessonTimes(lessonId) {
  const entry = guestLesson(lessonId);
  const now = Date.now();
  const present = new Set(entry.rows.map((r) => r.student_id));
  // Wer fehlt, steht nicht in der Liste – ausser er hat vorher schon Zeit gesammelt.
  return entry.roster
    .map((student) => {
      const times = { id: student.id, name: student.name, mitte: 0, rechts: 0 };
      for (const log of entry.logs) {
        if (log.student_id === student.id) times[log.col] += ((log.ended_at ?? now) - log.started_at) / 1000;
      }
      return times;
    })
    .filter((t) => present.has(t.id) || t.mitte + t.rechts > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

const copy = (value) => JSON.parse(JSON.stringify(value));

const guestApi = {
  async listFocusClasses() {
    return readGuestForest().sort((a, b) => a.name.localeCompare(b.name, "de"));
  },

  async plantTree(classId, goalSeconds, open = false) {
    const tree = { id: guestId(), goal_seconds: clampInt(goalSeconds, 60, 7200, 60), open_goal: open, created_at: new Date().toISOString() };
    updateGuestClass(classId, (cls) => {
      cls.focus_trees.push(tree);
      cls.focus_trees = cls.focus_trees.slice(-GUEST_MAX_TREES);
    });
    return { ...tree };
  },

  async updateFocusReward(classId, fields) {
    updateGuestClass(classId, (cls) => {
      for (const key of ["focus_reward", "focus_reward_goal", "focus_reward_offset"]) {
        if (key in fields) cls[key] = fields[key];
      }
    });
  },

  async getLesson(lessonId) {
    const entry = guestLessons.get(lessonId);
    return entry ? copy(entry.lesson) : null;
  },

  async boardRows(lessonId) {
    return copy([...guestLesson(lessonId).rows].sort((a, b) => a.position - b.position));
  },

  async moveStudent(lessonId, studentId, column) {
    const entry = guestLesson(lessonId);
    const row = entry.rows.find((r) => r.student_id === studentId);
    if (!row) throw new Error("Diese Person gehört nicht zu diesem Unterricht.");
    if (row.col === column) return;
    if (!isAdjacent(row.col, column)) throw new Error("Nur ein Schritt in die direkt benachbarte Spalte erlaubt.");
    closeGuestLogs(entry, studentId);
    if (column !== "links") entry.logs.push({ student_id: studentId, col: column, started_at: Date.now(), ended_at: null });
    row.position = Math.max(0, ...entry.rows.filter((r) => r.col === column).map((r) => r.position)) + 1;
    row.col = column;
  },

  async lessonRoster(lessonId) {
    return copy(guestLesson(lessonId).roster);
  },

  async setPresence(lessonId, studentId, present) {
    const entry = guestLesson(lessonId);
    const index = entry.rows.findIndex((r) => r.student_id === studentId);
    if (!present && index >= 0) {
      closeGuestLogs(entry, studentId);
      entry.rows.splice(index, 1);
    } else if (present && index < 0) {
      const student = entry.roster.find((s) => s.id === studentId);
      if (!student) throw new Error("Diese Person gehört nicht zu diesem Unterricht.");
      const position = Math.max(0, ...entry.rows.filter((r) => r.col === "links").map((r) => r.position)) + 1;
      entry.rows.push({ id: guestId(), col: "links", position, student_id: studentId, students: { name: student.name } });
    }
  },

  async endLesson(lessonId) {
    const entry = guestLesson(lessonId);
    closeGuestLogs(entry);
    entry.lesson.ended_at ??= new Date().toISOString();
  },

  async reopenLesson(lessonId) {
    const entry = guestLesson(lessonId);
    const now = Date.now();
    for (const row of entry.rows) {
      if (row.col !== "links") entry.logs.push({ student_id: row.student_id, col: row.col, started_at: now, ended_at: null });
    }
    entry.lesson.ended_at = null;
  },

  async setAutoEnd() { return null; },
  async closeDueLessons() { return 0; }
};

// Im Gastmodus nur guestApi; alles andere braucht ein Konto und darf
// Supabase gar nicht erst erreichen.
const api = new Proxy(remoteApi, {
  get(target, key) {
    if (!state.guest) return target[key];
    return guestApi[key] ?? (async () => { throw new Error("Dafür brauchst du ein Konto."); });
  }
});

const lessonExtra = () => (state.scheduleAvailable ? ", auto_end_at" : "");

/* -------------------------------------------------------------------
   Schlechtes WLAN: Warteschlange fuer Aenderungen
   -------------------------------------------------------------------
   Verschieben, "Wer ist da?" und gepflanzte Baeume wirken sofort in der
   Ansicht und kommen in eine Warteschlange im localStorage. Sie wird der
   Reihe nach an Supabase geschickt; ist die Verbindung weg, versucht die
   App es spaeter erneut – auch nach dem Neuladen der Seite. Mit
   p_delay_ms (Migration 0009) traegt der Server den Zeitpunkt der
   Aenderung ein, nicht den des Nachsendens. Alle Aufrufe sind so gebaut,
   dass ein doppelt gesendeter nichts kaputt macht. Gespeichert werden nur
   IDs, Zustand und Zeitpunkt, keine Namen.
   ------------------------------------------------------------------- */

const QUEUE_KEY = "bt.warteschlange";
const QUEUE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const QUEUE_TIMEOUT_MS = 10000;
const QUEUE_RETRY_MS = [2000, 5000, 10000, 20000, 30000];
const QUEUE_KINDS = ["move", "presence", "tree"];

const queue = {
  ops: [],
  sending: false,
  offline: false,
  retries: 0,
  timer: null,
  listeners: new Set(),
  // false, solange Migration 0009 fehlt: dann ohne Zeitkorrektur.
  delaySupported: true
};

const queueUser = () => state.session?.user?.id ?? null;
const queueFresh = (op) => op && Date.now() - op.at < QUEUE_MAX_AGE_MS;

function storedQueue() {
  const all = readPref(QUEUE_KEY, []);
  return Array.isArray(all) ? all.filter(queueFresh) : [];
}

/** Aenderungen des angemeldeten Kontos laden (nach Anmeldung oder Neuladen). */
function loadQueue() {
  const user = queueUser();
  queue.ops = storedQueue().filter((op) => op.user === user && QUEUE_KINDS.includes(op.kind));
  queue.offline = false;
  queue.retries = 0;
}

function saveQueue() {
  const user = queueUser();
  const all = [...storedQueue().filter((op) => op.user !== user), ...queue.ops];
  try {
    if (all.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(all));
    else localStorage.removeItem(QUEUE_KEY);
  } catch { /* ohne Speicher bleibt die Warteschlange nur im Tab */ }
}

function clearQueue() {
  queue.ops = [];
  saveQueue();
  clearTimeout(queue.timer);
  queue.offline = false;
}

function notifyQueue(event = {}) {
  for (const fn of queue.listeners) {
    try { fn(event); } catch (error) { console.error(error); }
  }
}

/** Beobachtet die Warteschlange, solange die aktuelle Ansicht offen ist. */
function onQueue(fn) {
  queue.listeners.add(fn);
  registerCleanup(() => queue.listeners.delete(fn));
}

const pendingFor = (lessonId) => queue.ops.filter((op) => op.lessonId === lessonId);

function enqueue(op) {
  queue.ops.push({ ...op, user: queueUser(), at: Date.now() });
  saveQueue();
  notifyQueue();
  flushQueue();
}

/** UUID auch dort, wo crypto.randomUUID fehlt (aeltere Browser). */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Keine Verbindung, Zeitueberschreitung, Server ueberlastet, Anmeldung
 * abgelaufen: spaeter noch einmal versuchen. Alles andere ist endgueltig. */
const isTransient = ({ error, status }) =>
  status === 0 || status === 401 || status === 408 || status === 429 || status >= 500 || error?.code === "PGRST301";

async function sendOp(op) {
  const delay = Math.max(0, Date.now() - op.at);
  const limited = (request) =>
    (typeof AbortSignal.timeout === "function" ? request.abortSignal(AbortSignal.timeout(QUEUE_TIMEOUT_MS)) : request);

  if (op.kind === "tree") {
    // Feste ID: kommt die Antwort nicht an und es wird erneut gesendet, gibt es keinen zweiten Baum (23505).
    const row = { id: op.treeId, class_id: op.classId, goal_seconds: op.seconds, created_at: new Date(op.at).toISOString() };
    let result = await limited(sb.from("focus_trees").insert(op.open ? { ...row, open_goal: true } : row));
    // Ohne Migration 0010 fehlt "open_goal": den Baum trotzdem pflanzen, nur ohne Voegel.
    if (op.open && result.error?.code === "PGRST204") result = await limited(sb.from("focus_trees").insert(row));
    return result.error?.code === "23505" ? { error: null, status: 201 } : result;
  }
  if (op.kind === "presence") {
    const result = await limited(sb.rpc("set_presence", {
      p_lesson_id: op.lessonId, p_student_id: op.studentId, p_present: op.present, p_delay_ms: delay
    }));
    if (result.error?.code === "PGRST202") {
      result.error = new Error("Für „Wer ist da?“ fehlt noch ein Datenbank-Update " +
        "(supabase/migrations/0009_presence_and_offline.sql). Bitte wende dich an den Betreiber.");
    }
    return result;
  }
  const args = { p_lesson_id: op.lessonId, p_student_id: op.studentId, p_column: op.column };
  if (queue.delaySupported) {
    const result = await limited(sb.rpc("move_student", { ...args, p_delay_ms: delay }));
    if (result.error?.code !== "PGRST202") return result;
    queue.delaySupported = false;
  }
  return limited(sb.rpc("move_student", args));
}

/** Schickt die Warteschlange der Reihe nach; bei Verbindungsproblemen spaeter erneut. */
async function flushQueue() {
  if (queue.sending || !sb || !state.session) return;
  clearTimeout(queue.timer);
  queue.sending = true;
  const wasOffline = queue.offline;
  try {
    while (queue.ops.length && state.session) {
      const op = queue.ops[0];
      let result;
      try {
        result = await sendOp(op);
      } catch (error) {
        result = { error, status: 0 };
      }
      if (result.error && isTransient(result)) {
        if (!queue.offline) toast("Keine Verbindung. Deine Änderungen werden gespeichert und nachgesendet.", "error");
        queue.offline = true;
        notifyQueue();
        const wait = QUEUE_RETRY_MS[Math.min(queue.retries, QUEUE_RETRY_MS.length - 1)];
        queue.retries++;
        queue.timer = setTimeout(flushQueue, wait);
        return;
      }
      // Waehrenddessen kann die Warteschlange geleert worden sein (Abmelden).
      const index = queue.ops.indexOf(op);
      if (index >= 0) queue.ops.splice(index, 1);
      saveQueue();
      queue.offline = false;
      queue.retries = 0;
      if (result.error) showError(result.error, "Eine Änderung konnte nicht gespeichert werden.");
      notifyQueue({ done: op, error: result.error ?? null });
    }
  } finally {
    queue.sending = false;
  }
  if (!queue.ops.length) {
    if (wasOffline) toast("Wieder verbunden – alle Änderungen sind übertragen.");
    notifyQueue({ drained: true });
  }
}

window.addEventListener("online", () => { queue.retries = 0; flushQueue(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushQueue(); });

/** Wendet eine (noch nicht uebertragene) Aenderung auf die Zeilen eines
 * Unterrichts an – genauso, wie es der Server tut. roster: id -> Name. */
function applyOp(rows, op, roster) {
  const index = rows.findIndex((r) => r.student_id === op.studentId);
  const nextPosition = (col) => Math.max(0, ...rows.filter((r) => r.col === col).map((r) => r.position ?? 0)) + 1;
  if (op.kind === "move") {
    const row = rows[index];
    if (row && row.col !== op.column && isAdjacent(row.col, op.column)) {
      row.position = nextPosition(op.column);
      row.col = op.column;
    }
  } else if (op.kind === "presence") {
    if (!op.present && index >= 0) rows.splice(index, 1);
    if (op.present && index < 0) {
      rows.push({
        id: null, col: "links", position: nextPosition("links"), student_id: op.studentId,
        students: { name: roster.get(op.studentId) ?? "…" }
      });
    }
  }
  return rows;
}

/* -------------------------------------------------------------------
   Stundenplan
   -------------------------------------------------------------------
   Gespeichert in teachers.settings.schedule:
     dayStart: "08:00"                         Beginn der 1. Stunde
     blocks:   [{ kind: "stunde"|"pause", min }]  Tagesablauf in Minuten
     slots:    { "<Wochentag 1-5>:<Stunde>": classId }
   Uhrzeiten ergeben sich fortlaufend aus dayStart und den Dauern; eine
   unregelmaessige Luecke ist einfach eine (kurze) Pause.
   ------------------------------------------------------------------- */

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"];
/** So viele Minuten vor Stundenbeginn gilt die Klasse schon als "jetzt". */
const SCHEDULE_LEAD_MIN = 5;
/** Ohne Stundenplan endet ein Unterricht spaetestens nach einer Schulstunde + 5 min. */
const AUTO_END_DEFAULT_MIN = 50;
const UNLOAD_KEY = "bt.endedOnUnload";

const settings = () => state.teacher?.settings ?? {};

const toMinutes = (hhmm) => {
  const [hh, mm] = String(hhmm || "0:0").split(":").map(Number);
  return (hh || 0) * 60 + (mm || 0);
};
const toClock = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const formatTime = (date) => date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

/** Tagesablauf mit berechneten Uhrzeiten; Stunden sind ab 1 durchnummeriert. */
function scheduleRows(schedule = settings().schedule) {
  const rows = [];
  let at = toMinutes(schedule?.dayStart ?? "08:00");
  let n = 0;
  for (const block of schedule?.blocks ?? []) {
    const min = Math.max(1, Math.round(Number(block.min) || 0));
    rows.push({ kind: block.kind, min, start: at, end: at + min, n: block.kind === "stunde" ? ++n : null });
    at += min;
  }
  return rows;
}

/** Klasse in einer Stunde, nur wenn es sie (noch) gibt. */
function slotClass(weekday, n, schedule = settings().schedule) {
  const id = schedule?.slots?.[`${weekday}:${n}`];
  return id && state.classIndex.has(id) ? id : null;
}

const hasSchedule = () => Object.values(settings().schedule?.slots ?? {}).some((id) => state.classIndex.has(id));

/** Unterrichtsbloecke eines Tages: aufeinanderfolgende Stunden derselben
 * Klasse (Doppelstunde, auch ueber eine Pause hinweg) werden zusammengefasst. */
function dayLessons(date = new Date()) {
  const weekday = date.getDay();
  if (weekday < 1 || weekday > 5) return [];
  const result = [];
  for (const row of scheduleRows().filter((r) => r.kind === "stunde")) {
    const classId = slotClass(weekday, row.n);
    const last = result[result.length - 1];
    if (classId && last && last.classId === classId && last.lastN === row.n - 1) {
      last.end = row.end;
      last.lastN = row.n;
    } else if (classId) {
      result.push({ classId, firstN: row.n, lastN: row.n, start: row.start, end: row.end });
    }
  }
  const atMinutes = (m) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(m / 60), m % 60);
  return result.map((l) => ({
    ...l,
    name: state.classIndex.get(l.classId),
    label: l.firstN === l.lastN ? `${l.firstN}. Stunde` : `${l.firstN}./${l.lastN}. Stunde`,
    from: atMinutes(l.start),
    to: atMinutes(l.end)
  }));
}

/** Die Stunde, die gerade laeuft (oder in wenigen Minuten beginnt), sonst null. */
function currentLesson(now = new Date()) {
  const t = now.getTime();
  return dayLessons(now).find((l) => t >= l.from.getTime() - SCHEDULE_LEAD_MIN * 60000 && t < l.to.getTime()) ?? null;
}

function nextLesson(now = new Date()) {
  return dayLessons(now).find((l) => l.from.getTime() - SCHEDULE_LEAD_MIN * 60000 > now.getTime()) ?? null;
}

/** Sortiert die Klasse der aktuellen Stunde nach vorn (sonst unveraendert). */
function currentFirst(list, idOf = (x) => x.id) {
  const current = currentLesson();
  if (!current) return list;
  return [...list.filter((x) => idOf(x) === current.classId), ...list.filter((x) => idOf(x) !== current.classId)];
}

function nowBadge(classId) {
  const current = currentLesson();
  return current && current.classId === classId
    ? h("span", { class: "badge badge--now" }, `Jetzt · bis ${formatTime(current.to)}`)
    : null;
}

async function refreshClassIndex() {
  const classes = unwrap(await sb.from("classes").select("id, name").order("name"));
  state.classIndex = new Map(classes.map((c) => [c.id, c.name]));
  return classes;
}

/* -------------------------------------------------------------------
   Automatisches Unterrichtsende
   ------------------------------------------------------------------- */

function autoEndSettings() {
  const a = settings().autoEnd ?? {};
  return {
    mode: ["fix", "plan", "off"].includes(a.mode) ? a.mode : "fix",
    plusMin: Math.min(60, Math.max(0, Math.round(Number(a.plusMin ?? 5)) || 0)),
    onClose: Boolean(a.onClose)
  };
}

/** Endzeitpunkt fuer einen jetzt startenden Unterricht, oder null. */
function autoEndFor(classId, start = new Date()) {
  const a = autoEndSettings();
  if (a.mode === "off") return null;
  if (a.mode === "plan") {
    const current = currentLesson(start);
    if (current && current.classId === classId) return new Date(current.to.getTime() + a.plusMin * 60000);
  }
  return new Date(start.getTime() + AUTO_END_DEFAULT_MIN * 60000);
}

/** Beim Schliessen der Seite die hier laufenden Unterrichte beenden.
 * fetch mit keepalive ueberlebt das Entladen der Seite (supabase-js nicht). */
window.addEventListener("pagehide", () => {
  if (!sb || !state.session || !autoEndSettings().onClose || !state.openLessons.size) return;
  const ids = [...state.openLessons];
  for (const id of ids) {
    fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/end_lesson`, {
      method: "POST",
      keepalive: true,
      headers: {
        apikey: CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${state.session.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_lesson_id: id })
    }).catch(() => {});
  }
  // Nur fuer ein Neuladen (F5): sessionStorage ueberlebt das, ein geschlossener Tab nicht.
  try { sessionStorage.setItem(UNLOAD_KEY, JSON.stringify({ ids, at: Date.now() })); } catch { /* egal */ }
});

/** Wurde die Seite nur neu geladen, die dabei beendeten Unterrichte fortsetzen. */
async function resumeAfterReload() {
  let record = null;
  try {
    record = JSON.parse(sessionStorage.getItem(UNLOAD_KEY) || "null");
    sessionStorage.removeItem(UNLOAD_KEY);
  } catch { return; }
  const reload = performance.getEntriesByType?.("navigation")?.[0]?.type === "reload";
  if (!record || !reload || Date.now() - record.at > 60000) return;
  for (const id of record.ids ?? []) {
    try {
      const lesson = await api.getLesson(id);
      if (!lesson?.ended_at) continue;
      await api.reopenLesson(id);
      await api.setAutoEnd(id, autoEndFor(lesson.class_id));
      state.openLessons.add(id);
    } catch (error) {
      console.error(error);
    }
  }
}

/* -------------------------------------------------------------------
   Kopfzeile: Hinweiszeile, Hauptnavigation, Schnellstart, Konto-Menue
   ------------------------------------------------------------------- */

const NAV = [
  { key: "heute", label: "Heute", hash: "/" },
  { key: "klassen", label: "Klassen", hash: "/classes" },
  { key: "unterricht", label: "Unterrichte", hash: "/lessons" },
  { key: "wald", label: "Fokus-Wald", hash: "/focus" }
];
const GUEST_NAV = [
  { key: "wald", label: "Fokus-Wald", hash: "/focus" },
  { key: "ausprobieren", label: "Unterricht ausprobieren", hash: "/ausprobieren" }
];

/**
 * Aufklappmenue. items() wird bei jedem Oeffnen neu gebaut, damit z. B.
 * die Klasse der aktuellen Stunde stimmt. Eintraege: { label, sub, onSelect,
 * danger } oder "-" als Trenner.
 */
/** Schliessfunktion des gerade offenen Menues: es ist immer hoechstens eins offen. */
let closeOpenDropdown = null;

function dropdown({ button, items, align = "end", className = "" }) {
  const panel = h("div", { class: `dropdown__panel dropdown__panel--${align}`, role: "menu", hidden: true });
  const wrap = h("div", { class: `dropdown ${className}` }, button, panel);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  const close = (focusButton = false) => {
    if (panel.hidden) return;
    panel.hidden = true;
    if (closeOpenDropdown === close) closeOpenDropdown = null;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey);
    if (focusButton) button.focus();
  };
  const onOutside = (event) => { if (!wrap.contains(event.target)) close(); };
  const onKey = (event) => {
    const entries = [...panel.querySelectorAll(".dropdown__item")];
    const i = entries.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (event.key === "ArrowDown") { event.preventDefault(); entries[(i + 1) % entries.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); entries[(i - 1 + entries.length) % entries.length]?.focus(); }
  };

  button.addEventListener("click", () => {
    if (!panel.hidden) return close();
    closeOpenDropdown?.();
    closeOpenDropdown = close;
    panel.replaceChildren(...items().map((item) => {
      if (item === "-") return h("div", { class: "dropdown__sep", role: "separator" });
      if (item.heading) return h("div", { class: "dropdown__heading" }, item.heading);
      const el = h("button", {
        class: `dropdown__item${item.danger ? " dropdown__item--danger" : ""}`, type: "button", role: "menuitem"
      }, h("span", {}, item.label), item.sub ? h("span", { class: "dropdown__sub" }, item.sub) : null);
      el.addEventListener("click", () => { close(); item.onSelect(); });
      return el;
    }));
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey);
    panel.querySelector(".dropdown__item")?.focus();
  });
  return wrap;
}

let chromeBuilt = false;
let chromeGuest = false;

/** Segment-Schalter; auf schmalen Bildschirmen als eigene Zeile (CSS). */
function navLinks(nav) {
  return nav.map((item) =>
    h("a", { class: "topnav__link", href: `#${item.hash}`, dataset: { key: item.key } }, item.label));
}

const arrow = () => [" ", h("span", { "aria-hidden": "true" }, "\u2192")];

/** Baut Navigation und Menues einmal auf: fuer Gaeste nur Fokus-Wald,
 * Probe-Unterricht und Anmelden, sonst die volle Navigation. */
function buildChrome() {
  if (chromeBuilt) return;
  chromeBuilt = true;
  chromeGuest = state.guest;
  brandLinkEl.href = state.guest ? "./" : "#/";

  if (state.guest) {
    topnavEl.replaceChildren(...navLinks(GUEST_NAV));
    topbarActionsEl.replaceChildren(h("a", { class: "btn btn--ghost", href: "#/anmelden" }, "Anmelden"));
    topHintEl.replaceChildren(
      h("span", { class: "hint__long" }, "Ohne Anmeldung bleibt alles in deinem Browser."),
      h("a", { href: "./datenschutz.html", target: "_blank", rel: "noopener" },
        h("span", { class: "hint__long" }, "Mehr zum Datenschutz"),
        h("span", { class: "hint__short" }, "Ohne Anmeldung bleibt alles im Browser"),
        ...arrow()));
    topHintEl.hidden = false;
    return;
  }

  topnavEl.replaceChildren(...navLinks(NAV));

  const startBtn = h("button", { class: "btn btn--primary topbar__start", type: "button" },
    h("span", { "aria-hidden": "true" }, "+"), h("span", { class: "topbar__start-label" }, "Starten"));
  const quickStart = dropdown({
    button: startBtn,
    items: () => {
      const current = currentLesson();
      const list = [];
      if (current) {
        list.push({ heading: `Jetzt: ${current.name} · ${current.label}` },
          { label: `Unterricht mit ${current.name}`, sub: `bis ${formatTime(current.to)}`, onSelect: () => startLessonFor(current.classId, current.name) },
          { label: `Fokus-Phase mit ${current.name}`, onSelect: () => navigate(`/focus/${current.classId}`) },
          "-");
      }
      list.push(
        { label: "Unterricht starten …", sub: "Klasse wählen", onSelect: () => navigate("/lessons/new") },
        { label: "Fokus-Phase starten …", sub: "Klasse wählen", onSelect: () => navigate("/focus") });
      return list;
    }
  });

  const accountBtn = h("button", { class: "btn btn--ghost topbar__account", type: "button", "aria-label": "Konto-Menü" },
    h("span", { class: "avatar", "aria-hidden": "true" }, (state.teacher?.nickname || "?").trim().charAt(0).toUpperCase()),
    h("span", { class: "topbar__name" }, state.teacher?.nickname ?? ""),
    h("span", { class: "caret", "aria-hidden": "true" }));
  const account = dropdown({
    button: accountBtn,
    items: () => [
      { heading: state.session?.user?.email ?? "" },
      { label: "Einstellungen", sub: "Stundenplan, Unterrichtsende, Konto", onSelect: () => navigate("/settings") },
      { label: "Daten exportieren", onSelect: exportData },
      "-",
      { label: "Impressum", onSelect: () => window.open("./impressum.html", "_blank", "noopener") },
      { label: "Datenschutz", onSelect: () => window.open("./datenschutz.html", "_blank", "noopener") },
      "-",
      { label: "Abmelden", onSelect: logout }
    ]
  });

  topbarActionsEl.replaceChildren(quickStart, account);
  updateHint();
  const timer = setInterval(updateHint, 30000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}

/** Hinweiszeile: welche Klasse laut Stundenplan gerade dran ist (sonst keine). */
function updateHint() {
  if (!chromeBuilt || chromeGuest) return;
  const current = currentLesson();
  topHintEl.hidden = !current;
  if (!current) return topHintEl.replaceChildren();
  topHintEl.replaceChildren(
    h("span", {},
      h("span", { class: "hint__long" }, "Jetzt laut Stundenplan: "),
      h("span", { class: "hint__short" }, "Jetzt: "),
      h("strong", {}, current.name),
      h("span", { class: "hint__long" }, ` · ${current.label}`),
      ` bis ${formatTime(current.to)}`),
    h("a", { href: `#/classes/${current.classId}` }, "Zur Klasse", ...arrow()));
}

async function logout() {
  const pending = queue.ops.length;
  if (pending) {
    confirmDelete(
      `${pending === 1 ? "Eine Änderung ist" : `${pending} Änderungen sind`} wegen der Verbindung noch nicht ` +
      "übertragen und gehen beim Abmelden verloren. Trotzdem abmelden?",
      () => { clearQueue(); return logout(); },
      "Trotzdem abmelden");
    return;
  }
  await sb.auth.signOut();
  state.teacher = null;
  state.openLessons.clear();
  resetChrome();
  navigate("/");
}

async function exportData() {
  try {
    const data = await api.exportAll();
    downloadFile(`klassenschwung-export-${todayIso()}.json`, JSON.stringify(data, null, 2), "application/json");
    toast("Export heruntergeladen.");
  } catch (error) {
    showError(error, "Export fehlgeschlagen.");
  }
}

/* -------------------------------------------------------------------
   Router
   ------------------------------------------------------------------- */

function navigate(hash) { window.location.hash = hash; }

function parseRoute() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  // Kaputte Escapes (z. B. "%E0") wuerfen sonst einen URIError und der
  // Router bliebe haengen; solche Teile werden einfach roh verwendet.
  return raw.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
}

/**
 * Kopfzeile fuer die aktuelle Ansicht: aktiver Navigationspunkt (section),
 * Zurueck-Pfeil fuer Unterseiten, minimal = Unterrichtsmodus ohne Navigation.
 */
function setChrome({ title, back = null, section = null, minimal = false }) {
  topbarEl.hidden = false;
  if (chromeBuilt && chromeGuest !== state.guest) resetChrome();
  buildChrome();
  document.title = title && title !== "Klassenschwung" ? `${title} – Klassenschwung` : "Klassenschwung";
  topbarEl.classList.toggle("topbar--wide", appEl.classList.contains("app--wide"));
  topbarEl.classList.toggle("topbar--minimal", minimal);
  for (const link of topnavEl.querySelectorAll(".topnav__link")) {
    if (link.dataset.key === section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  updateHint();
  if (back) {
    backBtn.hidden = false;
    backBtn.onclick = () => navigate(back);
  } else {
    backBtn.hidden = true;
    backBtn.onclick = null;
  }
}

function resetChrome() {
  chromeBuilt = false;
  topnavEl.replaceChildren();
  topbarActionsEl.replaceChildren();
  topHintEl.replaceChildren();
  topHintEl.hidden = true;
}

const ROUTES = [
  { match: (p) => p.length === 0, view: () => renderToday() },
  { match: (p) => p[0] === "settings" && p.length === 1, view: () => renderSettings() },
  { match: (p) => p[0] === "settings" && p[1] === "stundenplan" && p.length === 2, view: () => renderScheduleImport() },
  { match: (p) => p[0] === "classes" && p[2] === "stats" && p.length === 3, view: (p) => renderClassStats(p[1]) },
  { match: (p) => p[0] === "classes" && p.length === 1, view: () => renderClassList() },
  { match: (p) => p[0] === "classes" && p[2] === "students" && p[3], view: (p) => renderStudentStats(p[1], p[3]) },
  { match: (p) => p[0] === "classes" && p[2] === "seating" && p.length === 3, view: (p) => renderSeating(p[1]) },
  { match: (p) => p[0] === "classes" && p[2] === "import" && p.length === 3, view: (p) => renderClassImport(p[1]) },
  { match: (p) => p[0] === "classes" && p.length === 2, view: (p) => renderClassDetail(p[1]) },
  { match: (p) => p[0] === "lessons" && p[1] === "new", view: () => renderNewLesson() },
  { match: (p) => p[0] === "lessons" && p.length === 2, view: (p) => renderBoard(p[1]) },
  { match: (p) => p[0] === "lessons" && p[2] === "klasse" && p.length <= 4, view: (p) => renderClassView(p[1], p[3]) },
  { match: (p) => p[0] === "lessons" && p.length === 1, view: () => renderLessonList() },
  { match: (p) => p[0] === "focus" && p.length === 1, view: () => renderFocusHome() },
  { match: (p) => p[0] === "focus" && p[1] === FOCUS_WALK, view: () => renderForestWalk() },
  { match: (p) => p[0] === "focus" && p.length === 2, view: (p) => renderFocusRoom(p[1]) }
];

/** Ohne Anmeldung erreichbar; alles andere fuehrt zur Anmeldung. */
const GUEST_ROUTES = [
  { match: (p) => p[0] === "ausprobieren" && p.length === 1, view: () => renderGuestTrial() },
  { match: (p) => p[0] === "lessons" && p.length === 2 && isGuestId(p[1]), view: (p) => renderBoard(p[1]) },
  { match: (p) => p[0] === "focus" && p.length === 1, view: () => renderFocusHome() },
  { match: (p) => p[0] === "focus" && p[1] === FOCUS_WALK && p.length === 2, view: () => renderForestWalk() },
  { match: (p) => p[0] === "focus" && p.length === 2, view: (p) => renderFocusRoom(p[1]) }
];

async function runRoute(route, parts) {
  try {
    await route.view(parts);
  } catch (error) {
    showError(error);
    appEl.replaceChildren(
      h("div", { class: "card" },
        h("p", {}, "Diese Ansicht konnte nicht geladen werden."),
        h("button", { class: "btn", onclick: () => router() }, "Erneut versuchen"))
    );
  }
}

async function router() {
  if (!sb) return;
  runCleanup();
  closeOpenDropdown?.();

  if (!state.session) {
    const parts = parseRoute();
    const route = GUEST_ROUTES.find((r) => r.match(parts));
    state.guest = Boolean(route);
    if (route) await runRoute(route, parts);
    else renderAuth();
    return;
  }
  state.guest = false;
  if (!state.teacher) {
    appEl.replaceChildren(loadingView());
    try {
      state.teacher = await ensureTeacher();
      // Was bei schlechtem WLAN liegen geblieben ist (auch vor dem Neuladen), jetzt nachsenden.
      loadQueue();
      flushQueue();
      await refreshClassIndex();
      await resumeAfterReload();
      await api.deletePastSchoolYears();
    } catch (error) {
      showError(error, "Lehrer-Profil konnte nicht geladen werden.");
      return;
    }
  }
  // Ohne Bestaetigung der aktuellen Nutzungsbedingungen (inkl. Vereinbarung
  // zur Auftragsverarbeitung) keine Ansicht: betrifft Konten von vor ihrer
  // Einfuehrung und alle Konten nach einer neuen Fassung (TERMS_VERSION).
  if (!termsAccepted()) { renderTermsGate(); return; }

  // Faellige Unterrichte (automatisches Ende) bei jedem Ansichtswechsel abschliessen.
  await api.closeDueLessons();

  const parts = parseRoute();
  const route = ROUTES.find((r) => r.match(parts));
  if (!route) return navigate("/");
  await runRoute(route, parts);
}

/* -------------------------------------------------------------------
   Ansicht: Nutzungsbedingungen bestaetigen (vor allen anderen Ansichten)
   ------------------------------------------------------------------- */

function renderTermsGate() {
  appEl.className = "app";
  setChrome({ title: "Nutzungsbedingungen", minimal: true });

  const updated = Boolean(state.session.user.user_metadata?.terms_version);
  const input = h("input", { type: "checkbox" });
  const errorBox = h("div", { class: "error-box", hidden: true });
  const acceptBtn = h("button", { class: "btn btn--primary", type: "submit" }, "Bestätigen und weiter");

  const form = h("form", { class: "card" },
    h("h2", {}, updated ? "Die Nutzungsbedingungen haben sich geändert" : "Bitte bestätige die Nutzungsbedingungen"),
    h("p", { class: "muted" },
      updated
        ? "Seit deiner letzten Bestätigung gibt es eine neue Fassung der Nutzungsbedingungen. "
        : "Für Klassenschwung gelten jetzt Nutzungsbedingungen. ",
      "Sie enthalten auch die Vereinbarung zur Auftragsverarbeitung für die Schülerdaten, die du einträgst. " +
      "Deine Daten bleiben unverändert."),
    errorBox,
    termsCheck(input),
    h("div", { class: "row" },
      acceptBtn,
      h("button", { class: "btn btn--ghost", type: "button", onclick: logout }, "Abmelden")));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!input.checked) {
      errorBox.textContent = "Bitte setze zuerst den Haken.";
      errorBox.hidden = false;
      return;
    }
    acceptBtn.disabled = true;
    try {
      const { data, error } = await sb.auth.updateUser({
        data: { terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() }
      });
      if (error) throw error;
      // USER_UPDATED aktualisiert state.session ebenfalls; hier zur Sicherheit direkt.
      state.session = { ...state.session, user: data.user };
      router();
    } catch (error) {
      showError(error, "Die Bestätigung konnte nicht gespeichert werden.");
      acceptBtn.disabled = false;
    }
  });

  appEl.replaceChildren(
    h("div", { class: "stack terms-gate" },
      form,
      // Betroffenenrechte bleiben auch ohne Zustimmung erreichbar.
      h("p", { class: "muted small" },
        "Nicht einverstanden? Dann kannst du hier alle deine Daten herunterladen oder dein Konto löschen."),
      accountCard()));
}

/* -------------------------------------------------------------------
   Ansicht: Heute (Startseite nach der Anmeldung)
   ------------------------------------------------------------------- */

async function renderToday() {
  appEl.className = "app";
  setChrome({ title: "Heute", section: "heute" });
  appEl.replaceChildren(loadingView());

  const lessons = await api.listLessons();
  const running = lessons.filter((l) => !l.ended_at);
  const now = new Date();
  const current = currentLesson(now);
  const next = nextLesson(now);
  const today = dayLessons(now);

  const lead = current
    ? `Jetzt laut Stundenplan: ${current.name}.`
    : next ? `Als Nächstes: ${next.name} um ${formatTime(next.from)} Uhr.` : "Was möchtest du tun?";

  const sections = [schoolYearNotice(now)].filter(Boolean);

  if (current) {
    const open = running.find((l) => l.class_id === current.classId);
    sections.push(h("section", { class: "card now-card" },
      h("p", { class: "now-card__kicker" },
        h("span", { class: "now-pill__dot", "aria-hidden": "true" }),
        `Jetzt · ${current.label} · ${formatTime(current.from)}–${formatTime(current.to)}`),
      h("h2", {}, current.name),
      h("div", { class: "row" },
        open
          ? h("button", { class: "btn btn--primary", type: "button", onclick: () => navigate(`/lessons/${open.id}`) }, "Laufenden Unterricht öffnen")
          : h("button", { class: "btn btn--primary", type: "button", onclick: () => startLessonFor(current.classId, current.name) }, "Unterricht starten"),
        h("button", { class: "btn", type: "button", onclick: () => navigate(`/focus/${current.classId}`) }, "Fokus-Phase"),
        h("button", { class: "btn", type: "button", onclick: () => navigate(`/classes/${current.classId}/seating`) }, "Sitzplan"),
        h("button", { class: "btn btn--ghost", type: "button", onclick: () => navigate(`/classes/${current.classId}`) }, "Klasse öffnen"))));
  }

  if (running.length) {
    sections.push(h("section", { class: "card" },
      h("h2", {}, running.length === 1 ? "Läuft gerade" : "Laufen gerade"),
      h("ul", { class: "list" }, running.map((lesson) =>
        h("li", { class: "list__item" },
          h("button", { class: "list__main", type: "button", onclick: () => navigate(`/lessons/${lesson.id}`) },
            lesson.classes?.name ?? lesson.name,
            h("span", { class: "list__sub" }, lessonStatusText(lesson))),
          h("span", { class: "badge badge--live" }, "läuft"))))));
  }

  if (hasSchedule()) {
    const t = now.getTime();
    sections.push(h("section", { class: "card" },
      h("h2", {}, `${WEEKDAYS[now.getDay() - 1] ?? "Heute"} laut Stundenplan`),
      today.length
        ? h("ol", { class: "day" }, today.map((l) => {
            const status = t >= l.to.getTime() ? "past" : current && current.classId === l.classId && current.firstN === l.firstN ? "now" : "later";
            return h("li", { class: `day__item day__item--${status}` },
              h("span", { class: "day__time" }, `${formatTime(l.from)}–${formatTime(l.to)}`),
              h("button", { class: "list__main", type: "button", onclick: () => navigate(`/classes/${l.classId}`) },
                l.name, h("span", { class: "list__sub" }, l.label)),
              status === "now" ? h("span", { class: "badge badge--now" }, "Jetzt") : null);
          }))
        : emptyView("Heute stehen keine Stunden im Stundenplan."),
      h("p", { class: "muted small" },
        h("a", { href: "#/settings" }, "Stundenplan bearbeiten"))));
  } else if (state.classIndex.size) {
    sections.push(h("section", { class: "card hint-card" },
      h("div", {},
        h("h2", {}, "Stundenplan einrichten"),
        h("p", { class: "muted" },
          "Trage einmal deine Stundenzeiten und Klassen ein. Dann steht zur richtigen Zeit immer die passende Klasse " +
          "oben, und ein Unterricht kann automatisch am Stundenende enden.")),
      h("button", { class: "btn", type: "button", onclick: () => navigate("/settings") }, "Zum Stundenplan")));
  }

  const item = (iconName, title, text, hash) =>
    h("button", { class: "menu__item", type: "button", onclick: () => navigate(hash) },
      h("span", { class: "feature__icon" }, icon(iconName)),
      h("h3", {}, title),
      h("p", {}, text));

  appEl.replaceChildren(...[
    pageHead({ eyebrow: formatDate(now), title: `Hallo ${state.teacher.nickname}`, lead }),
    sections.length ? h("div", { class: "stack" }, sections) : null,
    h("div", { class: `menu${sections.length ? " menu--after" : ""}` },
      item("klassen", "Klassen", "Klassen anlegen, Schülerinnen und Schüler verwalten, Sitzplan und Auswertung.", "/classes"),
      item("unterricht", "Unterrichte", "Laufende und vergangene Unterrichte öffnen oder einen neuen starten.", "/lessons"),
      item("wald", "Fokus-Wald", "Lautstärke-Monitor für den Beamer: Ist die Klasse ruhig, wächst ein Baum im Klassenwald.", "/focus"))
  ].filter(Boolean));
}

/** "seit 10:05 · endet automatisch um 10:55" */
function lessonStatusText(lesson) {
  const parts = [];
  if (lesson.created_at) parts.push(`seit ${formatTime(new Date(lesson.created_at))}`);
  if (lesson.auto_end_at) parts.push(`endet automatisch um ${formatTime(new Date(lesson.auto_end_at))}`);
  return parts.join(" · ");
}

/* -------------------------------------------------------------------
   Ansicht: Einstellungen (Stundenplan, Unterrichtsende, Konto)
   ------------------------------------------------------------------- */

const SCHEDULE_PRESET = {
  dayStart: "08:00",
  blocks: [
    { kind: "stunde", min: 45 }, { kind: "stunde", min: 45 }, { kind: "pause", min: 20 },
    { kind: "stunde", min: 45 }, { kind: "stunde", min: 45 }, { kind: "pause", min: 15 },
    { kind: "stunde", min: 45 }, { kind: "stunde", min: 45 }
  ]
};

async function renderSettings() {
  appEl.className = "app";
  setChrome({ title: "Einstellungen" });
  appEl.replaceChildren(loadingView());
  const classes = await refreshClassIndex();

  if (!state.scheduleAvailable) {
    appEl.replaceChildren(
      pageHead({ title: "Einstellungen" }),
      h("div", { class: "stack" },
        scheduleMigrationHint(),
        paletteCard(),
        accountCard(),
        inviteCard()));
    return;
  }

  const draft = JSON.parse(JSON.stringify(settings()));
  draft.schedule ??= {};
  draft.schedule.dayStart ??= "08:00";
  draft.schedule.blocks ??= [];
  draft.schedule.slots ??= {};
  draft.autoEnd = autoEndSettings();

  const statusEl = h("span", { class: "save-status", role: "status", "aria-live": "polite" });
  let saveTimer = null;
  function scheduleSave() {
    statusEl.textContent = "Wird gespeichert …";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }
  async function save() {
    // Zuordnungen zu entfernten Stunden oder Klassen aufraeumen.
    const count = scheduleRows(draft.schedule).filter((r) => r.kind === "stunde").length;
    for (const key of Object.keys(draft.schedule.slots)) {
      const [, n] = key.split(":").map(Number);
      if (n > count || !state.classIndex.has(draft.schedule.slots[key])) delete draft.schedule.slots[key];
    }
    try {
      await api.saveSettings(draft);
      state.teacher.settings = JSON.parse(JSON.stringify(draft));
      updateHint();
      statusEl.textContent = "Gespeichert";
    } catch (error) {
      statusEl.textContent = "";
      showError(error, "Einstellungen konnten nicht gespeichert werden.");
    }
  }
  registerCleanup(() => { if (saveTimer) { clearTimeout(saveTimer); save(); } });

  /* ----- Stundenzeiten ----- */

  const timesEl = h("div");
  const weekEl = h("div");

  function changed() { drawTimes(); drawWeek(); scheduleSave(); }

  function drawTimes() {
    const startInput = h("input", { class: "input input--time", type: "time", value: draft.schedule.dayStart, "aria-label": "Beginn der 1. Stunde" });
    startInput.addEventListener("change", () => {
      if (!startInput.value) return;
      draft.schedule.dayStart = startInput.value;
      changed();
    });

    const rows = scheduleRows(draft.schedule);
    const table = rows.length
      ? h("table", { class: "table times" },
          h("thead", {}, h("tr", {},
            h("th", {}, ""), h("th", {}, "Zeit"), h("th", {}, "Dauer"), h("th", {}, h("span", { class: "sr-only" }, "Entfernen")))),
          h("tbody", {}, rows.map((row, i) => {
            const minInput = h("input", {
              class: "input input--num", type: "number", min: "1", max: "240", step: "1", inputmode: "numeric",
              value: String(row.min), "aria-label": `Dauer ${row.n ? `${row.n}. Stunde` : "Pause"} in Minuten`
            });
            minInput.addEventListener("change", () => {
              const min = Math.round(Number(minInput.value));
              if (!(min >= 1 && min <= 240)) { minInput.value = String(row.min); return; }
              draft.schedule.blocks[i].min = min;
              changed();
            });
            return h("tr", { class: row.kind === "pause" ? "times__pause" : "" },
              h("th", { scope: "row" }, row.n ? `${row.n}. Stunde` : "Pause"),
              h("td", { class: "num" }, `${toClock(row.start)}–${toClock(row.end)}`),
              h("td", {}, h("span", { class: "times__min" }, minInput, "min")),
              h("td", {}, h("button", {
                class: "btn btn--sm btn--ghost btn--icon", type: "button", "aria-label": "Zeile entfernen",
                onclick: () => { draft.schedule.blocks.splice(i, 1); changed(); }
              }, trashIcon())));
          })))
      : h("div", { class: "empty-hint" },
          h("p", { class: "muted" }, "Noch keine Stundenzeiten. Starte mit einer Vorlage und passe sie an:"),
          h("button", { class: "btn", type: "button", onclick: () => {
            draft.schedule.blocks = SCHEDULE_PRESET.blocks.map((b) => ({ ...b }));
            changed();
          } }, "Vorlage: 6 Stunden à 45 min, Pausen nach der 2. und 4. Stunde"));

    const lastLesson = [...draft.schedule.blocks].reverse().find((b) => b.kind === "stunde");
    timesEl.replaceChildren(
      h("label", { class: "field field--inline" }, h("span", { class: "field__label" }, "Beginn der 1. Stunde"), startInput),
      table,
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", onclick: () => {
          draft.schedule.blocks.push({ kind: "stunde", min: lastLesson?.min ?? 45 });
          changed();
        } }, "+ Stunde"),
        h("button", { class: "btn", type: "button", onclick: () => {
          draft.schedule.blocks.push({ kind: "pause", min: 15 });
          changed();
        } }, "+ Pause")));
  }

  /* ----- Wochenplan ----- */

  function drawWeek() {
    const rows = scheduleRows(draft.schedule);
    if (!rows.some((r) => r.kind === "stunde")) {
      weekEl.replaceChildren(emptyView("Lege zuerst oben die Stundenzeiten an."));
      return;
    }
    if (!classes.length) {
      weekEl.replaceChildren(emptyView("Lege zuerst unter „Klassen“ deine Klassen an."));
      return;
    }
    const cell = (weekday, n) => {
      const key = `${weekday}:${n}`;
      const select = h("select", { class: "input week__select", "aria-label": `${WEEKDAYS[weekday - 1]}, ${n}. Stunde` },
        h("option", { value: "" }, "–"),
        classes.map((c) => h("option", { value: c.id, selected: draft.schedule.slots[key] === c.id }, c.name)));
      select.addEventListener("change", () => {
        if (select.value) draft.schedule.slots[key] = select.value;
        else delete draft.schedule.slots[key];
        select.closest("td").classList.toggle("is-set", Boolean(select.value));
        scheduleSave();
      });
      return h("td", { class: draft.schedule.slots[key] ? "is-set" : "" }, select);
    };
    weekEl.replaceChildren(h("div", { class: "week__scroll" },
      h("table", { class: "week" },
        h("thead", {}, h("tr", {}, h("th", {}, ""), WEEKDAYS.map((d) => h("th", { scope: "col" },
          h("span", { class: "week__long" }, d), h("span", { class: "week__short", "aria-hidden": "true" }, d.slice(0, 2)))))),
        h("tbody", {}, rows.map((row) => row.kind === "pause"
          ? h("tr", { class: "week__pause" }, h("td", { colspan: "6" }, `Pause · ${row.min} min`))
          : h("tr", {},
              h("th", { scope: "row" }, `${row.n}.`, h("span", { class: "week__time" }, `${toClock(row.start)}–${toClock(row.end)}`)),
              WEEKDAYS.map((_, d) => cell(d + 1, row.n))))))));
  }

  /* ----- Automatisches Unterrichtsende ----- */

  const plusInput = h("input", {
    class: "input input--num", type: "number", min: "0", max: "60", step: "1", inputmode: "numeric",
    value: String(draft.autoEnd.plusMin), "aria-label": "Minuten nach Stundenende"
  });
  const radio = (value, label, extra = null) => {
    const input = h("input", { type: "radio", name: "autoEnd", value, checked: draft.autoEnd.mode === value });
    input.addEventListener("change", () => {
      draft.autoEnd.mode = value;
      plusInput.disabled = value !== "plan";
      scheduleSave();
    });
    return h("label", { class: "choice" }, input, h("span", {}, label, extra));
  };
  plusInput.disabled = draft.autoEnd.mode !== "plan";
  plusInput.addEventListener("change", () => {
    const n = Math.round(Number(plusInput.value));
    draft.autoEnd.plusMin = n >= 0 && n <= 60 ? n : 5;
    plusInput.value = String(draft.autoEnd.plusMin);
    scheduleSave();
  });
  const closeInput = h("input", { type: "checkbox", checked: draft.autoEnd.onClose });
  closeInput.addEventListener("change", () => { draft.autoEnd.onClose = closeInput.checked; scheduleSave(); });

  const autoEndCard = h("section", { class: "card" },
    h("h2", {}, "Unterricht automatisch beenden"),
    h("p", { class: "muted small" }, "Damit kein Unterricht versehentlich bis zum Abend weiterläuft und die Auswertung verfälscht."),
    h("div", { class: "choices" },
      radio("fix", `Spätestens ${AUTO_END_DEFAULT_MIN} Minuten nach dem Start`,
        h("span", { class: "choice__sub" }, "Eine Schulstunde plus 5 Minuten. Standard.")),
      radio("plan", "Am Ende der Stunde laut Stundenplan",
        h("span", { class: "choice__sub" },
          h("span", { class: "choice__inline" }, "plus ", plusInput, " Minuten, falls du überziehst."),
          ` Ohne passende Stunde im Stundenplan nach ${AUTO_END_DEFAULT_MIN} Minuten. Doppelstunden zählen als eine Stunde.`)),
      radio("off", "Nicht nach Zeit beenden",
        h("span", { class: "choice__sub" }, "Der Unterricht läuft, bis du ihn selbst beendest."))),
    h("label", { class: "check check--setting" }, closeInput,
      h("span", {}, h("strong", {}, "Beenden, wenn die Seite geschlossen wird. "),
        "Gilt für Unterrichte, die in diesem Tab offen waren. Beim bloßen Neuladen läuft der Unterricht weiter.")));

  drawTimes();
  drawWeek();

  appEl.replaceChildren(
    pageHead({
      title: "Einstellungen",
      lead: "Änderungen werden automatisch gespeichert.",
      actions: [statusEl]
    }),
    h("div", { class: "stack" },
      h("section", { class: "card hint-card" },
        h("div", {},
          h("h2", {}, "Aus WebUntis übernehmen"),
          h("p", { class: "muted" },
            "Statt alles von Hand einzutragen: eine iCal-Datei (.ics) deines Stundenplans einlesen. " +
            "Stundenzeiten und Klassen werden daraus vorgeschlagen.")),
        h("button", { class: "btn", type: "button", onclick: () => navigate("/settings/stundenplan") }, "Stundenplan importieren")),
      h("section", { class: "card" },
        h("h2", {}, "Stundenzeiten"),
        h("p", { class: "muted small" },
          "Wann beginnt die 1. Stunde, wie lange dauern Stunden und Pausen? Die Uhrzeiten werden daraus berechnet. " +
          "Eine unregelmäßige Lücke trägst du einfach als kurze Pause ein."),
        timesEl),
      h("section", { class: "card" },
        h("h2", {}, "Wochenplan"),
        h("p", { class: "muted small" },
          "Ordne jeder Stunde eine Klasse zu. Zur richtigen Zeit steht diese Klasse dann überall zuerst – " +
          "in der Kopfzeile, auf „Heute“ und beim Starten."),
        weekEl),
      autoEndCard,
      paletteCard(),
      accountCard(),
      inviteCard()));
}

/** Farbwelt-Auswahl. Gespeichert im Auth-Profil (user_metadata.palette)
 * statt in teachers.settings: steht so schon vor dem Laden des
 * Lehrerprofils fest und braucht keine Migration. */
function paletteCard() {
  const current = paletteOf(state.session);
  // Jede Option traegt ihre eigene Farbwelt (data-palette-preview), damit
  // die Farbfelder die jeweiligen Farben zeigen statt der aktiven.
  const picker = h("fieldset", { class: "palette-picker" },
    h("legend", { class: "sr-only" }, "Farbwelt"),
    PALETTES.map((p) =>
      h("label", { class: "palette-option", "data-palette-preview": p.key },
        h("input", { type: "radio", name: "palette", value: p.key, checked: p.key === current }),
        h("span", { class: "palette-option__swatches", "aria-hidden": "true" },
          h("i", { class: "is-accent" }), h("i", { class: "is-links" }),
          h("i", { class: "is-mitte" }), h("i", { class: "is-rechts" })),
        h("span", { class: "palette-option__text" },
          h("strong", {}, p.name), h("span", { class: "muted small" }, p.hint)))));

  picker.addEventListener("change", async (event) => {
    const key = event.target.value;
    const previous = paletteOf(state.session);
    applyPalette(key); // sofort zeigen, dann speichern
    picker.disabled = true;
    try {
      const { error } = await sb.auth.updateUser({ data: { palette: key } });
      if (error) throw error;
      toast(`Farbwelt „${PALETTES.find((p) => p.key === key).name}“ gespeichert.`);
    } catch (error) {
      applyPalette(previous);
      picker.querySelector(`input[value="${previous}"]`).checked = true;
      showError(error, "Die Farbwelt konnte nicht gespeichert werden.");
    } finally {
      picker.disabled = false;
    }
  });

  return h("section", { class: "card" },
    h("h2", {}, "Farbwelt"),
    h("p", { class: "muted small" },
      "Gilt für dein Konto auf allen Geräten. Der Fokus-Wald am Beamer behält seine eigenen Farben."),
    picker);
}

/** Konto & Daten: Export und Loeschung (Betroffenenrechte nach DSGVO). */
function accountCard() {
  const exportBtn = h("button", { class: "btn", type: "button" }, "Daten exportieren");
  exportBtn.addEventListener("click", async () => {
    exportBtn.disabled = true;
    await exportData();
    exportBtn.disabled = false;
  });

  const deleteBtn = h("button", { class: "btn btn--danger", type: "button" }, "Konto löschen");
  deleteBtn.addEventListener("click", () => confirmDelete(
    "Konto wirklich löschen? Alle Klassen, Schülernamen, Unterrichte, Zeiten und Bäume werden sofort " +
    "und endgültig gelöscht. Tipp: Vorher „Daten exportieren“.",
    async () => {
      try {
        await api.deleteOwnAccount();
      } catch (error) {
        // PGRST202: Funktion unbekannt, d. h. Migration 0006 fehlt noch
        if (error?.code === "PGRST202" || error?.code === "42883") {
          throw new Error("Die Kontolöschung ist auf dem Server noch nicht eingerichtet. " +
            "Bitte wende dich an den Betreiber, von dem du deinen Zugang hast.");
        }
        throw error;
      }
      // Der User existiert nicht mehr: nur die lokale Sitzung entfernen.
      clearQueue();
      await sb.auth.signOut({ scope: "local" });
      state.teacher = null;
      resetChrome();
      navigate("/");
      toast("Dein Konto und alle Daten wurden gelöscht.");
    },
    "Endgültig löschen"));

  return h("section", { class: "card" },
    h("h2", {}, "Konto & Daten"),
    h("p", { class: "muted small" },
      `Angemeldet als ${state.session?.user?.email ?? ""}. Du kannst jederzeit alle deine Daten ` +
      "herunterladen oder dein Konto samt aller Daten löschen."),
    h("p", { class: "muted small" }, SCHOOL_YEAR_DELETE_INFO),
    h("div", { class: "row" }, exportBtn, deleteBtn));
}

/**
 * Einladungslinks erstellen (nur fuer Admins, Tabelle admins aus
 * Migration 0011). Bleibt unsichtbar, solange die Pruefung laeuft, fuer
 * alle anderen und wenn die Migration fehlt.
 */
function inviteCard() {
  const noteInput = h("input", {
    class: "input", type: "text", maxlength: "80", placeholder: "Für wen? (nur für dich sichtbar)",
    "aria-label": "Notiz zur Einladung"
  });
  const createBtn = h("button", { class: "btn btn--primary", type: "submit" }, "Link erstellen");
  const listEl = h("ul", { class: "list" });
  const card = h("section", { class: "card", hidden: true },
    h("h2", {}, "Einladungen"),
    h("p", { class: "muted small" },
      "Nur wer einen Einladungslink bekommt, kann ein Konto anlegen. Jeder Link gilt einmal und 14 Tage."),
    h("form", { class: "row row--form", onsubmit: create }, noteInput, createBtn),
    listEl);

  async function copy(code) {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      toast("Einladungslink kopiert.");
    } catch {
      window.prompt("Einladungslink zum Kopieren:", inviteLink(code));
    }
  }

  function statusText(inv) {
    if (inv.used_at) return `Benutzt am ${formatDate(inv.used_at)}`;
    if (new Date(inv.expires_at) < new Date()) return `Abgelaufen am ${formatDate(inv.expires_at)}`;
    return `Offen bis ${formatDate(inv.expires_at)}`;
  }

  function draw(invites) {
    listEl.replaceChildren(...invites.map((inv) => {
      const open = !inv.used_at && new Date(inv.expires_at) >= new Date();
      return h("li", { class: "list__item" },
        h("div", { class: "invite__main" },
          inv.note || "Ohne Notiz",
          h("span", { class: "list__sub" }, statusText(inv))),
        open ? h("button", { class: "btn", type: "button", onclick: () => copy(inv.code) }, "Kopieren") : null,
        open ? h("button", { class: "btn btn--ghost", type: "button", onclick: () => remove(inv.code) }, "Zurückziehen") : null);
    }));
  }

  async function load() {
    const { data, error } = await sb.rpc("list_invites");
    if (error) throw error;
    draw(data ?? []);
  }

  async function create(event) {
    event.preventDefault();
    createBtn.disabled = true;
    try {
      const { data, error } = await sb.rpc("create_invite", { p_note: cleanName(noteInput.value, 80) });
      if (error) throw error;
      noteInput.value = "";
      await load();
      await copy(data.code);
    } catch (error) {
      showError(error, "Einladung konnte nicht erstellt werden.");
    } finally {
      createBtn.disabled = false;
    }
  }

  async function remove(code) {
    try {
      const { error } = await sb.rpc("delete_invite", { p_code: code });
      if (error) throw error;
      await load();
      toast("Einladung zurückgezogen.");
    } catch (error) {
      showError(error, "Einladung konnte nicht zurückgezogen werden.");
    }
  }

  if (!state.guest) {
    sb.rpc("is_admin").then(async ({ data, error }) => {
      if (error || data !== true) return;
      try {
        await load();
        card.hidden = false;
      } catch { /* ohne Liste keine Karte */ }
    });
  }
  return card;
}

/* -------------------------------------------------------------------
   Ansicht: Stundenplan importieren
   -------------------------------------------------------------------
   iCal-Datei (.ics) aus WebUntis oder einem Kalender. Gelesen wird nur
   im Browser (import-export.js); gespeichert werden nur Stundenzeiten
   und welche Klasse wann dran ist – keine Faecher, Raeume oder
   Lehrkraefte aus der Datei.
   ------------------------------------------------------------------- */

const WEEKDAYS_SHORT = WEEKDAYS.map((d) => d.slice(0, 2));

function scheduleMigrationHint() {
  return h("div", { class: "card" },
    h("h2", {}, "Datenbank-Update fehlt"),
    h("p", { class: "muted" },
      "Für Stundenplan und automatisches Unterrichtsende muss einmalig die Migration " +
      "supabase/migrations/0007_schedule_autoend.sql im Supabase SQL-Editor ausgeführt werden."));
}

async function renderScheduleImport() {
  appEl.className = "app";
  setChrome({ title: "Stundenplan importieren", back: "/settings" });
  appEl.replaceChildren(loadingView());
  const classes = await refreshClassIndex();

  const head = pageHead({
    eyebrow: "Einstellungen",
    title: "Stundenplan importieren",
    lead: "Aus WebUntis oder einem Kalender: Die App liest eine iCal-Datei (.ics) und schlägt Stundenzeiten und " +
      "Klassen vor. Du prüfst alles, bevor es übernommen wird."
  });
  if (!state.scheduleAvailable) {
    appEl.replaceChildren(head, scheduleMigrationHint());
    return;
  }

  const ownTimes = scheduleRows().filter((r) => r.kind === "stunde");
  const hadSlots = hasSchedule();
  let events = null;
  let derived = null;
  let groups = [];
  let useFileTimes = true;
  // Gruppe -> "" (nicht uebernehmen), "id:<Klasse>" oder "neu:<Name>"
  const choices = new Map();

  const errorBox = h("div", { class: "error-box", hidden: true });
  const fail = (message) => { errorBox.textContent = message; errorBox.hidden = !message; };
  const fileInput = h("input", { type: "file", class: "sr-only", accept: ".ics,text/calendar", tabindex: "-1" });
  const fileLabel = h("span", { class: "muted small" }, "Keine Datei ausgewählt");
  const resultEl = h("div", { class: "stack" });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileLabel.textContent = file.name;
    fail("");
    events = null;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("Die Datei ist zu groß (höchstens 5 MB).");
      const found = parseIcs(await file.text());
      if (!found.length) throw new Error("In der Datei stehen keine Termine von Montag bis Freitag.");
      events = found;
      derived = deriveTimes(events);
      useFileTimes = !ownTimes.length;
      groups = groupEvents(events, classes);
      choices.clear();
      for (const g of groups) choices.set(g.key, g.classId ? `id:${g.classId}` : g.guess ? `neu:${g.guess}` : "");
    } catch (error) {
      fail(error.message || "Die Datei konnte nicht gelesen werden.");
    }
    draw();
  });

  const periodsNow = () => (useFileTimes ? derived.periods : ownTimes);
  const choiceLabel = (value) => (value.startsWith("id:") ? state.classIndex.get(value.slice(3)) : value.slice(4));

  function timesCard() {
    const radio = (value, label) => {
      const input = h("input", { type: "radio", name: "importTimes", checked: useFileTimes === value });
      input.addEventListener("change", () => { useFileTimes = value; draw(); });
      return h("label", { class: "choice" }, input, h("span", {}, label));
    };
    const estimated = useFileTimes && derived.periods.some((p) => p.estimated);
    return h("section", { class: "card" },
      h("h2", {}, "Stundenzeiten"),
      ownTimes.length ? h("div", { class: "choices" },
        radio(true, "Aus der Datei übernehmen"),
        radio(false, `Meine bisherigen ${ownTimes.length} Stunden behalten`)) : null,
      h("table", { class: "table times" },
        h("tbody", {}, periodsNow().map((p, i) => h("tr", {},
          h("th", { scope: "row" }, `${i + 1}. Stunde`),
          h("td", { class: "num" }, `${toClock(p.start)}–${toClock(p.end)}`),
          h("td", {}, p.estimated ? h("span", { class: "badge" }, "geschätzt") : null))))),
      estimated ? h("p", { class: "muted small" },
        "„Geschätzt“: In diesen Stunden unterrichtest du laut Datei nie, ihre Zeiten sind aus den Lücken berechnet. " +
        "Prüfe sie nach dem Übernehmen in den Einstellungen.") : null);
  }

  function classesCard() {
    const items = groups.map((g) => {
      const days = [...new Set(g.events.map((e) => e.weekday))].sort().map((d) => WEEKDAYS_SHORT[d - 1]).join(", ");
      const titles = [...g.titles].slice(0, 3).join(", ") + (g.titles.size > 3 ? " …" : "");
      const select = h("select", { class: "input import-groups__select", "aria-label": `Klasse für ${g.label}` },
        h("option", { value: "" }, "– nicht übernehmen –"),
        g.guess ? h("option", { value: `neu:${g.guess}`, selected: choices.get(g.key) === `neu:${g.guess}` },
          `Neue Klasse „${g.guess}“ anlegen`) : null,
        classes.map((c) => h("option", { value: `id:${c.id}`, selected: choices.get(g.key) === `id:${c.id}` }, c.name)));
      select.addEventListener("change", () => { choices.set(g.key, select.value); draw(); });
      return h("li", { class: "list__item" },
        h("div", { class: "import-groups__text" },
          h("strong", {}, g.label),
          h("span", { class: "list__sub" },
            `${titles ? `${titles} · ` : ""}${g.events.length} ${g.events.length === 1 ? "Termin" : "Termine"} · ${days}`)),
        select);
    });
    return h("section", { class: "card" },
      h("h2", {}, "Klassen zuordnen"),
      h("p", { class: "muted small" },
        "Die Termine sind nach Klassen sortiert. Prüfe die Zuordnung; Termine ohne Klasse wie Aufsichten oder " +
        "Konferenzen lässt du einfach weg."),
      h("ul", { class: "list import-groups" }, items));
  }

  function previewCard() {
    const periods = periodsNow();
    const { slots, unmatched, conflicts } = buildSlots(groups, periods, (g) => choices.get(g.key) || null);
    const count = Object.keys(slots).length;
    const applyBtn = h("button", { class: "btn btn--primary", type: "button", disabled: !count }, "Übernehmen");
    applyBtn.addEventListener("click", () => (hadSlots
      ? confirmDelete("Dein bisheriger Wochenplan wird durch diesen ersetzt. Fortfahren?", () => apply(applyBtn), "Ersetzen")
      : apply(applyBtn)));

    return h("section", { class: "card" },
      h("h2", {}, "So sieht deine Woche aus"),
      h("p", { class: "muted small" },
        count ? `${count} ${count === 1 ? "Stunde" : "Stunden"} pro Woche mit Klasse.` : "Noch keine Stunde mit Klasse."),
      h("div", { class: "week__scroll" },
        h("table", { class: "week week--preview" },
          h("thead", {}, h("tr", {}, h("th", {}, ""), WEEKDAYS.map((d) => h("th", { scope: "col" },
            h("span", { class: "week__long" }, d), h("span", { class: "week__short", "aria-hidden": "true" }, d.slice(0, 2)))))),
          h("tbody", {}, periods.map((p, i) => h("tr", {},
            h("th", { scope: "row" }, `${i + 1}.`, h("span", { class: "week__time" }, `${toClock(p.start)}–${toClock(p.end)}`)),
            WEEKDAYS.map((_, d) => {
              const value = slots[`${d + 1}:${i + 1}`];
              return h("td", { class: value ? "is-set" : "" }, value ? choiceLabel(value) : "");
            })))))),
      conflicts ? h("p", { class: "muted small" },
        `${conflicts === 1 ? "Eine Stunde war" : `${conflicts} Stunden waren`} in der Datei unterschiedlich belegt ` +
        "(z. B. A-/B-Woche). Übernommen ist jeweils die häufigere Klasse.") : null,
      unmatched ? h("p", { class: "muted small" },
        `${unmatched === 1 ? "Ein Termin passt" : `${unmatched} Termine passen`} zu keiner Stunde und ` +
        `${unmatched === 1 ? "fehlt" : "fehlen"} deshalb.`) : null,
      h("div", { class: "row", style: "margin-top:16px" }, applyBtn,
        hadSlots ? h("span", { class: "muted small" }, "Ersetzt deinen bisherigen Wochenplan.") : null));
  }

  async function apply(button) {
    button.disabled = true;
    try {
      // Vorgeschlagene neue Klassen anlegen (oder eine inzwischen gleichnamige nehmen).
      const created = new Map();
      for (const value of new Set([...choices.values()].filter((v) => v.startsWith("neu:")))) {
        const name = cleanName(value.slice(4), 80);
        const same = [...state.classIndex].find(([, n]) => n.toLocaleLowerCase("de") === name.toLocaleLowerCase("de"));
        created.set(value, same ? same[0] : (await api.createClass(name)).id);
      }
      const resolve = (value) => (!value ? null : value.startsWith("id:") ? value.slice(3) : created.get(value) ?? null);
      const { slots } = buildSlots(groups, periodsNow(), (g) => resolve(choices.get(g.key)));
      const next = JSON.parse(JSON.stringify(settings()));
      next.schedule = useFileTimes
        ? { dayStart: derived.dayStart, blocks: derived.blocks, slots }
        : { ...(next.schedule ?? {}), slots };
      await api.saveSettings(next);
      state.teacher.settings = next;
      await refreshClassIndex();
      updateHint();
      toast(created.size
        ? `Stundenplan übernommen, ${created.size === 1 ? "1 Klasse" : `${created.size} Klassen`} neu angelegt.`
        : "Stundenplan übernommen.");
      navigate("/settings");
    } catch (error) {
      showError(error, "Der Stundenplan konnte nicht übernommen werden.");
      button.disabled = false;
    }
  }

  function draw() {
    resultEl.replaceChildren(...(events ? [timesCard(), classesCard(), previewCard()] : []));
  }

  appEl.replaceChildren(
    head,
    h("div", { class: "stack" },
      h("section", { class: "card" },
        h("h2", {}, "iCal-Datei auswählen"),
        errorBox,
        h("div", { class: "row" },
          h("button", { class: "btn", type: "button", onclick: () => fileInput.click() }, "Datei auswählen"),
          fileLabel, fileInput),
        h("p", { class: "muted small", style: "margin-bottom:0" },
          "In WebUntis deinen Stundenplan einer ganzen Woche als iCal-Datei exportieren, oder aus deinem Kalender " +
          "(Outlook, Google, Apple) eine .ics-Datei speichern. Die Datei wird nur hier im Browser gelesen. Gespeichert " +
          "werden nur die Stundenzeiten und welche Klasse wann dran ist – keine Fächer, Räume oder Namen.")),
      resultEl));
}

/* -------------------------------------------------------------------
   Ansicht: Klassenliste
   ------------------------------------------------------------------- */

async function renderClassList() {
  appEl.className = "app";
  setChrome({ title: "Klassen", section: "klassen" });
  appEl.replaceChildren(loadingView());

  const classes = currentFirst(await api.listClasses());
  state.classIndex = new Map(classes.map((c) => [c.id, c.name]));

  const nameInput = h("input", {
    class: "input", type: "text", maxlength: "80", placeholder: "Klassenname, z. B. 7b"
  });
  const addBtn = h("button", { class: "btn btn--primary", type: "submit" }, "Anlegen");

  const form = h("form", { class: "row row--form" }, nameInput, addBtn);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = cleanName(nameInput.value, 80);
    if (!name) return toast("Bitte einen Klassennamen eingeben.", "error");

    addBtn.disabled = true;
    try {
      await api.createClass(name);
      nameInput.value = "";
      await renderClassList();
      toast(`Klasse „${name}“ angelegt.`);
    } catch (error) {
      showError(error, "Klasse konnte nicht angelegt werden.");
    } finally {
      addBtn.disabled = false;
    }
  });

  const list = classes.length
    ? h("ul", { class: "list" }, classes.map((cls) => {
        const count = cls.students?.[0]?.count ?? 0;
        return h("li", { class: "list__item" },
          h("button", { class: "list__main", onclick: () => navigate(`/classes/${cls.id}`) },
            cls.name,
            h("span", { class: "list__sub" },
              count === 1 ? "1 Schülerin/Schüler" : `${count} Schülerinnen und Schüler`)),
          nowBadge(cls.id),
          h("button", {
            class: "btn btn--sm btn--danger",
            onclick: () => confirmDelete(
              `Klasse „${cls.name}“ wirklich löschen? Alle Schüler, Unterrichte und Zeiten dieser Klasse gehen verloren.`,
              async () => { await api.deleteClass(cls.id); await renderClassList(); toast("Klasse gelöscht."); })
          }, "Löschen"));
      }))
    : emptyView("Noch keine Klassen. Lege oben die erste an.");

  appEl.replaceChildren(
    pageHead({
      title: "Klassen",
      lead: "Klasse anlegen, Namen eintragen – danach kannst du Unterrichte starten, den Sitzplan bauen und im Fokus-Wald Bäume sammeln."
    }),
    h("div", { class: "stack" },
      h("div", { class: "card" }, h("h2", {}, "Neue Klasse"), form),
      h("div", { class: "card" }, h("h2", {}, "Deine Klassen"), list))
  );
}

/** Reiter einer Klasse: alles zu einer Klasse an einem Ort. */
function classTabs(classId, active) {
  const tabs = [
    ["schueler", "Schüler", `/classes/${classId}`],
    ["sitzplan", "Sitzplan", `/classes/${classId}/seating`],
    ["auswertung", "Auswertung", `/classes/${classId}/stats`],
    ["wald", "Wald", `/focus/${classId}`]
  ];
  return h("nav", { class: "tabs", "aria-label": "Bereiche der Klasse" },
    tabs.map(([key, label, hash]) =>
      h("a", { class: "tabs__link", href: `#${hash}`, "aria-current": key === active ? "page" : null }, label)));
}

/** Kopf einer Klassen-Unterseite: Name, Jetzt-Hinweis, Schnellaktionen, Reiter. */
function classHead(cls, active, { lead = null, canStart = true } = {}) {
  const current = currentLesson();
  return [
    pageHead({
      eyebrow: current && current.classId === cls.id
        ? `Jetzt · ${current.label} · bis ${formatTime(current.to)}`
        : "Klasse",
      title: cls.name,
      lead,
      actions: [
        h("button", { class: "btn", type: "button", onclick: () => navigate(`/focus/${cls.id}`) }, "Fokus-Phase"),
        h("button", {
          class: "btn btn--primary", type: "button", disabled: !canStart,
          title: canStart ? null : "Zuerst Schülerinnen und Schüler eintragen",
          onclick: () => startLessonFor(cls.id, cls.name)
        }, "Unterricht starten")
      ]
    }),
    classTabs(cls.id, active)
  ];
}

/* -------------------------------------------------------------------
   Ansicht: Klassendetail (Schuelerliste)
   ------------------------------------------------------------------- */

async function renderClassDetail(classId) {
  appEl.className = "app";
  setChrome({ title: "Klasse", back: "/classes", section: "klassen" });
  appEl.replaceChildren(loadingView());

  const cls = await api.getClass(classId);
  if (!cls) { toast("Klasse nicht gefunden.", "error"); return navigate("/classes"); }
  setChrome({ title: cls.name, back: "/classes", section: "klassen" });

  const students = await api.listStudents(classId);

  const nameInput = h("input", {
    class: "input", type: "text", maxlength: "80",
    placeholder: "Vorname oder Kürzel"
  });
  const addBtn = h("button", { class: "btn btn--primary", type: "submit" }, "Hinzufügen");

  const form = h("form", { class: "row row--form" }, nameInput, addBtn);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = cleanName(nameInput.value, 80);
    if (!name) return toast("Bitte einen Namen eingeben.", "error");

    addBtn.disabled = true;
    try {
      await api.createStudent(classId, name);
      nameInput.value = "";
      await renderClassDetail(classId);
      toast(`„${name}“ hinzugefügt.`);
    } catch (error) {
      showError(error, "Schüler konnte nicht angelegt werden.");
    } finally {
      addBtn.disabled = false;
    }
  });

  const list = students.length
    ? h("ul", { class: "list" }, students.map((student) =>
        h("li", { class: "list__item" },
          h("button", {
            class: "list__main",
            onclick: () => navigate(`/classes/${classId}/students/${student.id}`)
          }, student.name, h("span", { class: "list__sub" }, "Zeiten ansehen")),
          h("button", {
            class: "btn btn--sm btn--danger",
            onclick: () => confirmDelete(
              `„${student.name}“ wirklich aus der Klasse löschen? Alle erfassten Zeiten gehen verloren.`,
              async () => { await api.deleteStudent(student.id); await renderClassDetail(classId); toast("Schüler gelöscht."); })
          }, "Löschen"))))
    : emptyView("Noch keine Schülerinnen und Schüler in dieser Klasse.");

  appEl.replaceChildren(
    ...classHead(cls, "schueler", {
      lead: students.length === 1 ? "1 Schülerin/Schüler" : `${students.length} Schülerinnen und Schüler`,
      canStart: students.length > 0
    }),
    h("div", { class: "stack" },
      h("div", { class: "card" },
        h("h2", {}, "Schülerin / Schüler hinzufügen"), form,
        h("p", { class: "muted small", style: "margin:.6rem 0 0" },
          "Vorname oder Kürzel reicht – je weniger Daten, desto besser. " +
          "Bitte nur mit Erlaubnis deiner Schule eintragen."),
        h("div", { class: "row", style: "margin-top:1rem" },
          h("a", { class: "btn", href: `#/classes/${classId}/import` }, "Klassenliste importieren"),
          h("span", { class: "muted small" }, "aus Untis, WebUntis, Excel oder CSV – nur Vornamen"))),
      h("div", { class: "card" },
        h("h2", {}, "Klassenliste"),
        h("p", { class: "muted small" }, "Auf einen Namen klicken, um die Zeiten zu sehen."),
        list))
  );
  // `autofocus` greift beim dynamischen Neuaufbau nach dem Anlegen nicht
  // zuverlaessig – deshalb explizit fokussieren, damit sich eine ganze
  // Klassenliste ohne Mausklick eintippen laesst.
  nameInput.focus();
}

/* -------------------------------------------------------------------
   Ansicht: Klassenliste importieren
   -------------------------------------------------------------------
   Datei (CSV, Excel, Export aus Untis/WebUntis) oder eingefuegter Text.
   Die Datei wird nur im Browser gelesen (import-export.js). Uebernommen
   werden nur Vornamen, bei gleichen Vornamen mit dem kuerzesten
   eindeutigen Anfang des Nachnamens ("Lea M." bzw. "Lea Mü."/"Lea Ma.").
   ------------------------------------------------------------------- */

const IMPORT_MAX_STUDENTS = 60;
const TABLE_FILE_TYPES = ".csv,.tsv,.txt,.xlsx,text/csv,text/plain," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function renderClassImport(classId) {
  appEl.className = "app";
  setChrome({ title: "Klassenliste importieren", back: `/classes/${classId}`, section: "klassen" });
  appEl.replaceChildren(loadingView());

  const cls = await api.getClass(classId);
  if (!cls) { toast("Klasse nicht gefunden.", "error"); return navigate("/classes"); }
  const existing = (await api.listStudents(classId)).map((s) => s.name);

  let table = null;   // { rows, delimiter }
  let layout = null;  // siehe detectLayout()
  let values = [];    // Klassen in der Klassenspalte, z. B. bei einem Export der ganzen Schule
  let klasse = null;

  const errorBox = h("div", { class: "error-box", hidden: true });
  const fail = (message) => { errorBox.textContent = message; errorBox.hidden = !message; };
  const fileInput = h("input", { type: "file", class: "sr-only", accept: TABLE_FILE_TYPES, tabindex: "-1" });
  const fileLabel = h("span", { class: "muted small" }, "Keine Datei ausgewählt");
  const pasteInput = h("textarea", {
    class: "input", rows: "6", placeholder: "Z. B. aus Excel kopiert, oder ein Name pro Zeile"
  });
  const mappingEl = h("section", { class: "card", hidden: true });
  const previewEl = h("section", { class: "card", hidden: true });

  function use(result) {
    fail("");
    table = result?.rows.length ? result : null;
    if (result && !table) fail("In der Datei stehen keine Namen.");
    layout = table ? detectLayout(table.rows, table.delimiter) : null;
    values = table ? classValues(table.rows, layout) : [];
    klasse = values.length > 1 ? matchClassValue(values, cls.name) : null;
    drawMapping();
    drawPreview();
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileLabel.textContent = file.name;
    pasteInput.value = "";
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("Die Datei ist zu groß (höchstens 5 MB).");
      use(await readTableFile(new Uint8Array(await file.arrayBuffer())));
    } catch (error) {
      use(null);
      fail(error.message || "Die Datei konnte nicht gelesen werden.");
    }
  });

  let pasteTimer = null;
  pasteInput.addEventListener("input", () => {
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
      fileInput.value = "";
      fileLabel.textContent = "Keine Datei ausgewählt";
      use(pasteInput.value.trim() ? parseDelimited(pasteInput.value) : null);
    }, 250);
  });
  registerCleanup(() => clearTimeout(pasteTimer));

  function drawMapping() {
    mappingEl.hidden = !table;
    if (!table) return;
    const header = layout.headerRow >= 0 ? table.rows[layout.headerRow] : [];
    const column = (i) => (header[i] ? `Spalte „${header[i]}“` : `Spalte ${i + 1}`);
    const current = layout.first >= 0 ? `col:${layout.first}` : `${layout.order}:${layout.full}`;

    const firstSelect = h("select", { class: "input" },
      layout.columns.map((_, i) => h("option", { value: `col:${i}`, selected: current === `col:${i}` }, column(i))),
      h("optgroup", { label: "Ganzer Name in einer Spalte" },
        layout.columns.flatMap((_, i) => [
          h("option", { value: `vn:${i}`, selected: current === `vn:${i}` }, `${column(i)}: Vorname Nachname`),
          h("option", { value: `nv:${i}`, selected: current === `nv:${i}` }, `${column(i)}: Nachname, Vorname`)])));
    firstSelect.addEventListener("change", () => {
      const [kind, i] = firstSelect.value.split(":");
      if (kind === "col") {
        layout.first = Number(i);
        layout.full = -1;
        if (layout.last === layout.first) layout.last = -1;
      } else {
        Object.assign(layout, { first: -1, last: -1, full: Number(i), order: kind });
      }
      drawMapping();
      drawPreview();
    });

    const lastSelect = layout.first < 0 ? null : h("select", { class: "input" },
      h("option", { value: "-1" }, "– keine –"),
      layout.columns.map((_, i) => (i === layout.first ? null
        : h("option", { value: String(i), selected: layout.last === i }, column(i)))));
    lastSelect?.addEventListener("change", () => { layout.last = Number(lastSelect.value); drawPreview(); });

    const classSelect = values.length < 2 ? null : h("select", { class: "input" },
      h("option", { value: "", selected: !klasse }, "– Klasse wählen –"),
      values.map((v) => h("option", { value: v.name, selected: v.name === klasse }, `${v.name} (${v.count})`)));
    classSelect?.addEventListener("change", () => { klasse = classSelect.value || null; drawPreview(); });

    const headerInput = h("input", { type: "checkbox", checked: layout.headerRow >= 0 });
    headerInput.addEventListener("change", () => {
      layout.headerRow = headerInput.checked ? 0 : -1;
      values = classValues(table.rows, layout);
      drawMapping();
      drawPreview();
    });

    mappingEl.replaceChildren(
      h("h2", {}, "So wird die Liste gelesen"),
      h("p", { class: "muted small" }, "Passt etwas nicht, stell es hier um. Die Vorschau ändert sich sofort."),
      h("div", { class: "import-fields" },
        h("label", { class: "field" }, h("span", { class: "field__label" }, "Vornamen"), firstSelect),
        lastSelect ? h("label", { class: "field" },
          h("span", { class: "field__label" }, "Nachnamen (nur zum Unterscheiden gleicher Vornamen)"), lastSelect) : null,
        classSelect ? h("label", { class: "field" },
          h("span", { class: "field__label" }, "Klasse in der Datei"), classSelect) : null),
      h("label", { class: "check" }, headerInput, h("span", {}, "Die erste Zeile enthält Überschriften")));
  }

  function drawPreview() {
    previewEl.hidden = !table;
    if (!table) return;
    if (values.length > 1 && !klasse) {
      previewEl.replaceChildren(h("h2", {}, "Vorschau"), emptyView("Wähle oben aus, welche Klasse aus der Datei du übernehmen willst."));
      return;
    }
    const names = shortNames(extractPeople(table.rows, layout, { klasse }), existing);
    const fresh = names.filter((n) => !n.exists);
    const skipped = names.length - fresh.length;
    const tooMany = fresh.length > IMPORT_MAX_STUDENTS;

    const submit = h("button", { class: "btn btn--primary", type: "button", disabled: !fresh.length || tooMany },
      fresh.length === 1 ? "1 Namen übernehmen" : `${fresh.length} Namen übernehmen`);
    submit.addEventListener("click", async () => {
      submit.disabled = true;
      try {
        await api.createStudents(classId, fresh.map((n) => n.name));
        toast(fresh.length === 1 ? "1 Name übernommen." : `${fresh.length} Namen übernommen.`);
        navigate(`/classes/${classId}`);
      } catch (error) {
        showError(error, "Die Namen konnten nicht gespeichert werden.");
        submit.disabled = false;
      }
    });

    // replaceChildren() wuerde null als Text "null" einfuegen.
    previewEl.replaceChildren(...[
      h("h2", {}, "Vorschau"),
      h("p", { class: "muted small" }, names.length
        ? `${names.length} ${names.length === 1 ? "Name" : "Namen"}` + (skipped ? `, davon ${skipped} schon in der Klasse.` : ".")
        : "Keine Namen gefunden. Stimmt oben die Spalte für die Vornamen?"),
      names.length ? h("ul", { class: "name-list" }, names.map((n) =>
        h("li", { class: n.exists ? "is-existing" : null },
          n.name, n.exists ? h("span", { class: "name-list__note" }, "schon da") : null))) : null,
      tooMany ? h("div", { class: "error-box" },
        `Das sind mehr als ${IMPORT_MAX_STUDENTS} Namen. Ist die richtige Klasse gewählt?`) : null,
      h("p", { class: "muted small" },
        "Gespeichert werden nur diese Namen. Nachnamen und alle anderen Angaben aus der Datei bleiben in deinem " +
        "Browser und werden nicht übertragen."),
      h("div", { class: "row" }, submit)
    ].filter(Boolean));
  }

  appEl.replaceChildren(
    pageHead({
      eyebrow: cls.name,
      title: "Klassenliste importieren",
      lead: "Aus Untis, WebUntis, Excel oder einer anderen Liste. Übernommen werden nur Vornamen – gibt es einen " +
        "Vornamen mehrfach, mit dem Anfang des Nachnamens, z. B. „Lea M.“ und „Lea S.“."
    }),
    h("div", { class: "stack" },
      h("section", { class: "card" },
        h("h2", {}, "Liste auswählen"),
        errorBox,
        h("div", { class: "row" },
          h("button", { class: "btn", type: "button", onclick: () => fileInput.click() }, "Datei auswählen"),
          fileLabel, fileInput),
        h("p", { class: "muted small" },
          "CSV, Excel (.xlsx) oder Text. Aus Untis oder WebUntis: die Schülerliste als CSV- oder Excel-Datei exportieren."),
        h("label", { class: "field" }, h("span", { class: "field__label" }, "Oder Namen einfügen"), pasteInput),
        h("p", { class: "muted small", style: "margin:0" }, "Bitte nur mit Erlaubnis deiner Schule importieren.")),
      mappingEl,
      previewEl));
}

/* -------------------------------------------------------------------
   Ansicht: Sitzplan einer Klasse
   -------------------------------------------------------------------
   Tische werden frei per Pointer (Maus, Finger, Stift) verschoben;
   Antippen dreht einen Tisch hochkant bzw. zurueck. Positionen sind
   virtuelle Raumeinheiten (SEAT_ROOM_W x SEAT_ROOM_H), der Raum skaliert
   per CSS auf die verfuegbare Breite. Beim Loslassen rastet ein Tisch
   buendig an einer Seite eines Nachbarn ein (Kante oder Mitte
   ausgerichtet, damit hochkant stehende Tische z. B. an die Stirnseite
   eines Zweiertisches passen), auch wenn noch eine kleine Luecke war.
   Ohne Nachbarn in Reichweite richtet er sich an den Kanten der anderen
   Tische aus.
   ------------------------------------------------------------------- */

const SEAT_ROOM_W = 1200;
const SEAT_ROOM_H = 700;
const SEAT_W = 120;          // quer; hochkant sind Breite und Hoehe vertauscht
const SEAT_H = 60;
const SEAT_SNAP = 45;        // bis zu dieser Entfernung rastet ein Tisch am Nachbarn ein
const SEAT_ALIGN = 14;       // Ausrichten an Kanten anderer Tische
const SEAT_EPS = 0.5;
const SEAT_DRAG_START_PX = 4;
// Automatisch platzieren: Zweiertische, vier pro Reihe, vorne (unten) beginnend.
const SEAT_AUTO_PAIRS = 4;
const SEAT_AUTO_AISLE = 60;
const SEAT_AUTO_ROW_GAP = 40;
const SEAT_AUTO_MARGIN = 20;

/** Tisch als Rechteck { x, y, w, h, rot } in Raumeinheiten. */
const seatRect = (x, y, rot) => ({ x, y, rot, w: rot ? SEAT_H : SEAT_W, h: rot ? SEAT_W : SEAT_H });

const clampSeat = (r) => seatRect(
  Math.min(Math.max(Math.round(r.x), 0), SEAT_ROOM_W - r.w),
  Math.min(Math.max(Math.round(r.y), 0), SEAT_ROOM_H - r.h),
  r.rot);

const seatInRoom = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= SEAT_ROOM_W && r.y + r.h <= SEAT_ROOM_H;

const seatsOverlap = (a, b) =>
  a.x < b.x + b.w - SEAT_EPS && b.x < a.x + a.w - SEAT_EPS &&
  a.y < b.y + b.h - SEAT_EPS && b.y < a.y + a.h - SEAT_EPS;

const seatOverlapsAny = (r, others) => others.some((o) => seatsOverlap(r, o));

function nearestWithin(value, candidates, max) {
  let best = null;
  let bestD = max;
  for (const c of candidates) {
    const d = Math.abs(value - c);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

/** Buendige Andockplaetze fuer einen Tisch der Groesse w x h an o. */
function dockCandidates(o, w, h) {
  const ys = [o.y, o.y + o.h - h, o.y + (o.h - h) / 2];
  const xs = [o.x, o.x + o.w - w, o.x + (o.w - w) / 2];
  return [
    ...ys.map((y) => ({ x: o.x + o.w, y })), ...ys.map((y) => ({ x: o.x - w, y })),
    ...xs.map((x) => ({ x, y: o.y + o.h })), ...xs.map((x) => ({ x, y: o.y - h }))
  ];
}

/** Zielposition fuer einen losgelassenen Tisch, oder null, wenn er dort
 * einen anderen Tisch ueberdecken wuerde. */
function snapSeat(raw, others) {
  const p = clampSeat(raw);

  // Auf einem anderen Tisch losgelassen: an den naechsten freien Nachbarplatz.
  let best = null;
  let bestD = seatOverlapsAny(p, others) ? SEAT_W : SEAT_SNAP;
  for (const o of others) {
    for (const { x, y } of dockCandidates(o, p.w, p.h)) {
      const c = seatRect(x, y, p.rot);
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bestD && seatInRoom(c) && !seatOverlapsAny(c, others)) { best = c; bestD = d; }
    }
  }
  if (best) return best;

  const ax = nearestWithin(p.x, others.flatMap((o) => [o.x, o.x + o.w, o.x - p.w, o.x + o.w - p.w]), SEAT_ALIGN);
  const ay = nearestWithin(p.y, others.flatMap((o) => [o.y, o.y + o.h, o.y - p.h, o.y + o.h - p.h]), SEAT_ALIGN);
  const aligned = clampSeat(seatRect(ax ?? p.x, ay ?? p.y, p.rot));
  if (!seatOverlapsAny(aligned, others)) return aligned;
  return seatOverlapsAny(p, others) ? null : p;
}

/** Freie Plaetze fuer "Automatisch platzieren", vorderste Reihe zuerst. */
function autoSeatSlots(occupied) {
  const pairW = 2 * SEAT_W;
  const rowW = SEAT_AUTO_PAIRS * pairW + (SEAT_AUTO_PAIRS - 1) * SEAT_AUTO_AISLE;
  const startX = Math.round((SEAT_ROOM_W - rowW) / 2);
  const slots = [];
  for (let y = SEAT_ROOM_H - SEAT_AUTO_MARGIN - SEAT_H; y >= 0; y -= SEAT_H + SEAT_AUTO_ROW_GAP) {
    for (let pair = 0; pair < SEAT_AUTO_PAIRS; pair++) {
      const x = startX + pair * (pairW + SEAT_AUTO_AISLE);
      for (const slot of [seatRect(x, y, false), seatRect(x + SEAT_W, y, false)]) {
        if (!seatOverlapsAny(slot, occupied)) slots.push(slot);
      }
    }
  }
  return slots;
}

async function renderSeating(classId) {
  appEl.className = "app app--wide";
  setChrome({ title: "Sitzplan", back: "/classes", section: "klassen" });
  appEl.replaceChildren(loadingView());

  const cls = await api.getClass(classId);
  if (!cls) { toast("Klasse nicht gefunden.", "error"); return navigate("/classes"); }
  setChrome({ title: `Sitzplan ${cls.name}`, back: "/classes", section: "klassen" });

  let students;
  try {
    students = await api.listSeats(classId);
  } catch (error) {
    if (!isMissingFocusSchema(error)) throw error;
    appEl.replaceChildren(
      h("div", { class: "card stack" },
        h("h2", {}, "Datenbank-Update fehlt"),
        h("p", { class: "muted" },
          "Für den Sitzplan müssen einmalig die Migrationen supabase/migrations/0004_seating.sql " +
          "und 0005_seat_rotation.sql im Supabase SQL-Editor ausgeführt werden.")));
    return;
  }

  // Lokaler Zustand: id -> seatRect | null
  const seats = new Map(students.map((s) =>
    [s.id, s.seat_x === null || s.seat_y === null ? null : seatRect(s.seat_x, s.seat_y, s.seat_rot)]));
  const nameOf = new Map(students.map((s) => [s.id, s.name]));

  const trayEl = h("div", { class: "seat-tray" });
  const roomEl = h("div", { class: "seat-room" });
  const ghostEl = h("div", { class: "seat-ghost", hidden: true });
  const autoBtn = h("button", { class: "btn", type: "button", onclick: autoPlace }, "Rest automatisch platzieren");
  const clearBtn = h("button", {
    class: "btn btn--danger", type: "button",
    onclick: () => confirmDelete(
      "Alle Plätze leeren? Die Tische kommen zurück in die Ablage.",
      async () => {
        await api.clearSeats(classId);
        for (const id of seats.keys()) seats.set(id, null);
        draw();
        toast("Sitzplan geleert.");
      }, "Leeren")
  }, "Alle leeren");

  appEl.replaceChildren(
    ...classHead(cls, "sitzplan", { canStart: students.length > 0 }),
    h("div", { class: "stack" },
      h("div", { class: "card stack" },
        h("div", { class: "row", style: "justify-content:space-between" },
          h("h2", { style: "margin:0" }, "Noch ohne Platz"),
          h("div", { class: "row" }, autoBtn, clearBtn)),
        trayEl),
      h("div", { class: "card seating" },
        roomEl,
        h("div", { class: "seating__board" }, "Tafel")),
      h("p", { class: "muted small" },
        "Tische in den Raum ziehen. An jeder Seite eines anderen Tisches rasten sie bündig ein. " +
        "Anklicken dreht einen Tisch hochkant, z. B. für die Stirnseite einer Tischreihe. " +
        "Zurück in die Ablage ziehen, um einen Platz freizugeben."))
  );

  const placedOthers = (exceptId) => [...seats]
    .filter(([id, seat]) => seat && id !== exceptId)
    .map(([, seat]) => seat);

  function seatEl(id) {
    const el = h("div", { class: "seat", dataset: { studentId: id }, title: nameOf.get(id) },
      h("span", { class: "seat__name" }, nameOf.get(id)));
    el.addEventListener("pointerdown", (event) => startDrag(event, id, el));
    return el;
  }

  function draw() {
    const unplaced = students.filter((s) => !seats.get(s.id));
    trayEl.replaceChildren(...(unplaced.length
      ? unplaced.map((s) => seatEl(s.id))
      : [h("p", { class: "muted small", style: "margin:0" }, "Alle haben einen Platz.")]));
    autoBtn.disabled = unplaced.length === 0;
    clearBtn.disabled = unplaced.length === students.length;

    const placed = students.filter((s) => seats.get(s.id));
    roomEl.replaceChildren(ghostEl, ...placed.map((s) => {
      const seat = seats.get(s.id);
      const el = seatEl(s.id);
      placeEl(el, seat);
      el.classList.toggle("seat--rot", seat.rot);
      // Ecken, an denen ein Nachbar buendig anliegt, ohne Rundung, damit
      // aneinanderstehende Tische wie ein Stueck wirken.
      const others = placedOthers(s.id);
      const near = (a, b) => Math.abs(a - b) < SEAT_EPS;
      const covers = (from, len, at) => from <= at + SEAT_EPS && from + len >= at - SEAT_EPS;
      const side = {
        l: others.filter((o) => near(o.x + o.w, seat.x) && seatsOverlapY(o, seat)),
        r: others.filter((o) => near(o.x, seat.x + seat.w) && seatsOverlapY(o, seat)),
        t: others.filter((o) => near(o.y + o.h, seat.y) && seatsOverlapX(o, seat)),
        b: others.filter((o) => near(o.y, seat.y + seat.h) && seatsOverlapX(o, seat))
      };
      const byY = (list, y) => list.some((o) => covers(o.y, o.h, y));
      const byX = (list, x) => list.some((o) => covers(o.x, o.w, x));
      const top = seat.y, bottom = seat.y + seat.h, left = seat.x, right = seat.x + seat.w;
      el.classList.toggle("seat--sq-tl", byY(side.l, top) || byX(side.t, left));
      el.classList.toggle("seat--sq-tr", byY(side.r, top) || byX(side.t, right));
      el.classList.toggle("seat--sq-bl", byY(side.l, bottom) || byX(side.b, left));
      el.classList.toggle("seat--sq-br", byY(side.r, bottom) || byX(side.b, right));
      return el;
    }));
  }

  const seatsOverlapY = (a, b) => a.y < b.y + b.h - SEAT_EPS && b.y < a.y + a.h - SEAT_EPS;
  const seatsOverlapX = (a, b) => a.x < b.x + b.w - SEAT_EPS && b.x < a.x + a.w - SEAT_EPS;

  function placeEl(el, r) {
    el.style.left = `${(r.x / SEAT_ROOM_W) * 100}%`;
    el.style.top = `${(r.y / SEAT_ROOM_H) * 100}%`;
    el.style.width = `${(r.w / SEAT_ROOM_W) * 100}%`;
    el.style.height = `${(r.h / SEAT_ROOM_H) * 100}%`;
  }

  async function saveSeat(id, seat) {
    const before = seats.get(id);
    seats.set(id, seat);
    draw();
    try {
      await api.setSeat(id, seat);
    } catch (error) {
      seats.set(id, before);
      draw();
      showError(error, "Platz konnte nicht gespeichert werden.");
    }
  }

  /** Dreht einen Tisch um seine Mitte; rastet danach wie beim Ablegen ein. */
  function rotate(id) {
    const seat = seats.get(id);
    const turned = seatRect(0, 0, !seat.rot);
    const target = snapSeat(seatRect(
      seat.x + (seat.w - turned.w) / 2, seat.y + (seat.h - turned.h) / 2, turned.rot), placedOthers(id));
    if (!target) return toast("Zum Drehen ist hier kein Platz.", "error");
    saveSeat(id, target);
  }

  async function autoPlace() {
    const unplaced = students.filter((s) => !seats.get(s.id));
    const slots = autoSeatSlots(placedOthers(null));
    const assigned = unplaced.slice(0, slots.length).map((s, i) => [s.id, slots[i]]);
    if (!assigned.length) return toast("Im Raum ist kein freier Platz mehr.", "error");

    autoBtn.disabled = true;
    for (const [id, seat] of assigned) seats.set(id, seat);
    draw();
    const results = await Promise.allSettled(assigned.map(([id, seat]) => api.setSeat(id, seat)));
    const failed = results.filter((r) => r.status === "rejected");
    results.forEach((r, i) => { if (r.status === "rejected") seats.set(assigned[i][0], null); });
    draw();
    if (failed.length) showError(failed[0].reason, "Einige Plätze konnten nicht gespeichert werden.");
    else if (assigned.length < unplaced.length) toast("Nicht alle passen in die Reihen – den Rest bitte von Hand setzen.");
  }

  function startDrag(event, id, el) {
    if (event.button !== 0) return;
    event.preventDefault();
    el.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    const from = seats.get(id);
    // Aus der Ablage kommen Tische quer in den Raum.
    const size = from ?? seatRect(0, 0, false);
    let floating = null;
    let offX = 0;
    let offY = 0;
    let target = null;       // eingerastete Zielposition im Raum
    let overRoom = false;

    function begin() {
      const room = roomEl.getBoundingClientRect();
      const scale = room.width / SEAT_ROOM_W;
      const w = size.w * scale;
      const hgt = size.h * scale;
      const rect = el.getBoundingClientRect();
      // Aus dem Raum: Griffpunkt behalten. Aus der Ablage: Tisch mittig greifen.
      offX = from ? startX - rect.left : w / 2;
      offY = from ? startY - rect.top : hgt / 2;
      floating = h("div", { class: `seat seat--floating${size.rot ? " seat--rot" : ""}` },
        h("span", { class: "seat__name" }, nameOf.get(id)));
      floating.style.width = `${w}px`;
      floating.style.height = `${hgt}px`;
      // Wie .seat-room .seat in style.css: clamp(.7rem, 1.25cqw, 1.05rem)
      floating.style.fontSize = `${Math.min(Math.max(room.width * 0.0125, 11.2), 16.8)}px`;
      document.body.append(floating);
      el.classList.add("seat--lifted");
    }

    function onMove(ev) {
      if (!floating) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < SEAT_DRAG_START_PX) return;
        begin();
      }
      const left = ev.clientX - offX;
      const top = ev.clientY - offY;
      floating.style.transform = `translate(${left}px, ${top}px)`;

      const room = roomEl.getBoundingClientRect();
      const scale = room.width / SEAT_ROOM_W;
      overRoom = ev.clientX >= room.left && ev.clientX <= room.right &&
                 ev.clientY >= room.top && ev.clientY <= room.bottom;
      target = overRoom
        ? snapSeat(seatRect((left - room.left) / scale, (top - room.top) / scale, size.rot), placedOthers(id))
        : null;

      ghostEl.hidden = !target;
      if (target) placeEl(ghostEl, target);
      floating.classList.toggle("seat--invalid", overRoom && !target);
    }

    function finish(ev) {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", finish);
      ghostEl.hidden = true;
      if (!floating) {
        // Antippen ohne Ziehen dreht einen Tisch im Raum.
        if (ev.type === "pointerup" && from) rotate(id);
        return;
      }
      floating.remove();
      el.classList.remove("seat--lifted");
      if (ev.type === "pointercancel") return;

      if (target) {
        if (!from || from.x !== target.x || from.y !== target.y) saveSeat(id, target);
      } else if (!overRoom && from) {
        saveSeat(id, null);
      }
    }

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
  }

  draw();
}

/* -------------------------------------------------------------------
   Loeschung zum Schuljahresende
   -------------------------------------------------------------------
   Unterrichte samt Zustaenden und Zeiten loescht der Server zum
   31. Juli (Migration 0008, Cron-Job "loesche-vergangene-schuljahre").
   ------------------------------------------------------------------- */

const SCHOOL_YEAR_DELETE_INFO =
  "Unterrichte werden mit ihren Zeiten zum Ende des Schuljahres am 31. Juli automatisch gelöscht. " +
  "Klassen, Schülerinnen und Schüler, Sitzplan und Fokus-Wald bleiben erhalten.";

/** Im Juli: Hinweis auf die Loeschung am 1. August, mit Export. */
function schoolYearNotice(now = new Date()) {
  if (now.getMonth() !== 6) return null;
  return h("section", { class: "card hint-card notice-card" },
    h("div", {},
      h("h2", {}, "Bald beginnt ein neues Schuljahr"),
      h("p", { class: "muted" },
        "Am 1. August werden alle Unterrichte dieses Schuljahres mit ihren Zeiten gelöscht. " +
        "Klassen, Schülerinnen und Schüler, Sitzplan und Fokus-Wald bleiben. " +
        "Lade vorher herunter, was du noch brauchst.")),
    h("button", { class: "btn", type: "button", onclick: exportData }, "Daten exportieren"));
}

/* -------------------------------------------------------------------
   Ansicht: Auswertung einer Klasse
   -------------------------------------------------------------------
   Gezeigt werden nur die positiven Zeiten ("gut", "großartig"), die Zahl
   der Unterrichte und der Schnitt je Unterricht. Die Liste ist
   alphabetisch, eine Rangliste gibt es bewusst nicht.
   ------------------------------------------------------------------- */

const isPositive = (col) => col === "mitte" || col === "rechts";
const perLesson = (seconds, lessons) => (lessons > 0 ? seconds / lessons : 0);
const lessonsLabel = (n) => `${n} ${n === 1 ? "Unterricht" : "Unterrichte"}`;
const EXPORT_NOTE = "Zeiten in „Du arbeitest gut“ und „Du arbeitest großartig“. Ø je Unterricht zählt beides zusammen. " +
  "Gezählt werden die Unterrichte, bei denen die Person dabei war. Alphabetisch sortiert, eine Rangliste gibt es bewusst nicht.";

/**
 * Zeiten einer Klasse. Ein Unterricht zaehlt fuer eine Person, wenn sie
 * dabei ist (lesson_students) oder dort Zeit gesammelt hat – so zaehlt er
 * auch fuer jemanden, der mitten in der Stunde gegangen ist ("Wer ist da?").
 */
function summarizeClass(students, rows, attendance) {
  const per = new Map(students.map((st) => [st.id, { mitte: 0, rechts: 0, lessonIds: new Set() }]));
  const lessons = new Map();
  const cells = new Map();
  const cell = (studentId, lessonId) => {
    const key = `${studentId}|${lessonId}`;
    if (!cells.has(key)) cells.set(key, { studentId, lessonId, mitte: 0, rechts: 0 });
    return cells.get(key);
  };
  for (const row of attendance) {
    const entry = per.get(row.student_id);
    if (!entry) continue;
    entry.lessonIds.add(row.lesson_id);
    cell(row.student_id, row.lesson_id);
    lessons.set(row.lesson_id, { name: row.lessons?.name ?? "Unterricht", date: row.lessons?.date ?? null });
  }
  for (const row of rows) {
    const entry = per.get(row.student_id);
    const seconds = Number(row.seconds) || 0;
    if (!entry || !isPositive(row.col) || seconds <= 0) continue;
    entry[row.col] += seconds;
    entry.lessonIds.add(row.lesson_id);
    cell(row.student_id, row.lesson_id)[row.col] += seconds;
    if (!lessons.has(row.lesson_id)) lessons.set(row.lesson_id, { name: row.lesson_name ?? "Unterricht", date: row.lesson_date ?? null });
  }
  const total = { mitte: 0, rechts: 0, lessons: 0 };
  for (const entry of per.values()) {
    entry.lessons = entry.lessonIds.size;
    total.mitte += entry.mitte;
    total.rechts += entry.rechts;
    total.lessons += entry.lessons;
  }
  return { per, total, lessons, cells: [...cells.values()] };
}

/** Knopf "Exportieren" mit Aufklappmenue; items wie bei dropdown(). */
function exportMenu(items) {
  return dropdown({
    button: h("button", { class: "btn btn--sm", type: "button" }, "Exportieren", h("span", { class: "caret", "aria-hidden": "true" })),
    items: () => [{ heading: "Enthält Namen – sicher aufbewahren" }, ...items]
  });
}

const CSV_TYPE = "text/csv;charset=utf-8";
const PDF_TYPE = "application/pdf";

async function renderClassStats(classId) {
  appEl.className = "app";
  setChrome({ title: "Auswertung", back: "/classes", section: "klassen" });
  appEl.replaceChildren(loadingView());

  const cls = await api.getClass(classId);
  if (!cls) { toast("Klasse nicht gefunden.", "error"); return navigate("/classes"); }
  setChrome({ title: `Auswertung ${cls.name}`, back: "/classes", section: "klassen" });

  const [students, rows, attendance] = await Promise.all([
    api.listStudents(classId), api.classTimes(classId), api.classAttendance(classId)]);
  const { per, total, lessons, cells } = summarizeClass(students, rows, attendance);
  const lessonCount = lessons.size;
  const minutes = (seconds, n) => (n ? formatDurationLong(seconds) : "–");
  const classAverage = (key) => minutes(perLesson(total[key], total.lessons), total.lessons);

  const exportName = (ext) => `auswertung-${fileSlug(cls.name)}-${todayIso()}.${ext}`;
  const exportOverviewCsv = () => downloadFile(exportName("csv"), toCsv([
    ["Name", "gut (Minuten)", "großartig (Minuten)", "Unterrichte", "Ø je Unterricht (Minuten)"],
    ...students.map((st) => {
      const t = per.get(st.id);
      return [st.name, csvMinutes(t.mitte), csvMinutes(t.rechts), t.lessons, csvMinutes(perLesson(t.mitte + t.rechts, t.lessons))];
    })
  ]), CSV_TYPE);
  const exportLessonsCsv = () => {
    const names = new Map(students.map((st) => [st.id, st.name]));
    const list = cells
      .map((c) => ({ ...c, name: names.get(c.studentId), lesson: lessons.get(c.lessonId) }))
      .sort((a, b) => String(b.lesson?.date).localeCompare(String(a.lesson?.date)) ||
        String(a.lesson?.name).localeCompare(String(b.lesson?.name), "de") || a.name.localeCompare(b.name, "de"));
    downloadFile(`unterrichte-${fileSlug(cls.name)}-${todayIso()}.csv`, toCsv([
      ["Datum", "Unterricht", "Name", "gut (Minuten)", "großartig (Minuten)"],
      ...list.map((c) => [formatDate(c.lesson?.date), c.lesson?.name ?? "", c.name, csvMinutes(c.mitte), csvMinutes(c.rechts)])
    ]), CSV_TYPE);
  };
  const exportPdf = () => downloadFile(exportName("pdf"), buildPdf({
    title: `Auswertung ${cls.name}`,
    subtitle: `Stand ${formatDate(new Date())} · ${lessonCount ? `erfasst über ${lessonsLabel(lessonCount)}` : "noch keine Unterrichte"}`,
    facts: lessonCount ? [`Ganze Klasse, im Schnitt je Person und Unterricht: gut ${classAverage("mitte")} · großartig ${classAverage("rechts")}`] : [],
    columns: [
      { label: "Name", weight: 3 }, { label: "gut", align: "right" }, { label: "großartig", align: "right" },
      { label: "Unterrichte", align: "right" }, { label: "Ø je Unterricht", weight: 1.4, align: "right" }],
    rows: students.map((st) => {
      const t = per.get(st.id);
      return [st.name, minutes(t.mitte, t.lessons), minutes(t.rechts, t.lessons), String(t.lessons),
        minutes(perLesson(t.mitte + t.rechts, t.lessons), t.lessons)];
    }),
    notes: [EXPORT_NOTE, SCHOOL_YEAR_DELETE_INFO],
    footer: `Klassenschwung · ${cls.name}`
  }), PDF_TYPE);

  const table = students.length
    ? h("table", { class: "table class-stats" },
        h("thead", {}, h("tr", {},
          h("th", {}, "Name"),
          h("th", { class: "num" }, "gut"),
          h("th", { class: "num" }, "großartig"),
          h("th", { class: "num" }, "Unterrichte"),
          h("th", { class: "num" }, "Ø je Unterricht"))),
        h("tbody", {}, students.map((st) => {
          const t = per.get(st.id);
          return h("tr", {},
            h("td", {}, h("a", { href: `#/classes/${classId}/students/${st.id}` }, st.name)),
            h("td", { class: "num" }, minutes(t.mitte, t.lessons)),
            h("td", { class: "num" }, minutes(t.rechts, t.lessons)),
            h("td", { class: "num" }, String(t.lessons)),
            h("td", { class: "num" }, minutes(perLesson(t.mitte + t.rechts, t.lessons), t.lessons)));
        })))
    : emptyView("Noch keine Schülerinnen und Schüler in dieser Klasse.");

  appEl.replaceChildren(
    ...classHead(cls, "auswertung", {
      lead: lessonCount ? `Erfasst über ${lessonsLabel(lessonCount)}.` : "Noch keine Unterrichte erfasst.",
      canStart: students.length > 0
    }),
    h("div", { class: "stack" },
      schoolYearNotice(),
      h("div", { class: "card" },
        h("h2", {}, "Ganze Klasse"),
        h("p", { class: "muted small" }, "Zeiten im Schnitt je Person und Unterricht."),
        h("div", { class: "stats__grid" },
          h("div", { class: "stat" },
            h("div", { class: "stat__label" }, "Unterrichte"),
            h("div", { class: "stat__value" }, String(lessonCount))),
          POSITIVE_COLUMNS.map((c) => h("div", { class: `stat stat--${c.key}` },
            h("div", { class: "stat__label" }, c.title),
            h("div", { class: "stat__value" }, classAverage(c.key)))))),
      h("div", { class: "card" },
        h("div", { class: "card__head" },
          h("h2", {}, "Nach Schülerin / Schüler"),
          students.length ? exportMenu([
            { label: "Übersicht als PDF", sub: "Zum Ausdrucken oder Ablegen", onSelect: exportPdf },
            { label: "Übersicht als CSV", sub: "Für Excel, eine Zeile je Person", onSelect: exportOverviewCsv },
            { label: "Alle Unterrichte als CSV", sub: "Eine Zeile je Person und Unterricht", onSelect: exportLessonsCsv }
          ]) : null),
        h("p", { class: "muted small" },
          "Zeiten in „Du arbeitest gut“ und „Du arbeitest großartig“. Ø je Unterricht zählt beides zusammen. " +
          "Namen anklicken, um die Zeiten je Unterricht zu sehen."),
        h("div", { class: "table-scroll" }, table)),
      h("p", { class: "muted small" }, SCHOOL_YEAR_DELETE_INFO)));
}

/* -------------------------------------------------------------------
   Ansicht: Zeiten einer Schuelerin / eines Schuelers
   ------------------------------------------------------------------- */

async function renderStudentStats(classId, studentId) {
  appEl.className = "app";
  setChrome({ title: "Zeiten", back: `/classes/${classId}/stats`, section: "klassen" });
  appEl.replaceChildren(loadingView());

  const student = await api.getStudent(studentId);
  if (!student) { toast("Schüler nicht gefunden.", "error"); return navigate(`/classes/${classId}`); }
  setChrome({ title: student.name, back: `/classes/${classId}/stats`, section: "klassen" });

  const [rows, attended] = await Promise.all([api.studentTimes(studentId), api.studentLessons(studentId)]);

  const perLessonTimes = new Map(attended.map((row) => [row.lesson_id, {
    name: row.lessons?.name ?? "Unterricht", date: row.lessons?.date ?? null, mitte: 0, rechts: 0
  }]));
  const totals = { mitte: 0, rechts: 0 };
  for (const row of rows) {
    const seconds = Number(row.seconds) || 0;
    if (!isPositive(row.col) || seconds <= 0) continue;
    totals[row.col] += seconds;
    if (!perLessonTimes.has(row.lesson_id)) {
      perLessonTimes.set(row.lesson_id, { name: row.lesson_name, date: row.lesson_date, mitte: 0, rechts: 0 });
    }
    perLessonTimes.get(row.lesson_id)[row.col] += seconds;
  }

  const lessons = [...perLessonTimes.values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const count = lessons.length;
  const average = count ? formatDurationLong(perLesson(totals.mitte + totals.rechts, count)) : "–";
  const className = state.classIndex.get(classId) ?? "";

  const exportName = (ext) => `zeiten-${fileSlug(student.name)}-${fileSlug(className)}-${todayIso()}.${ext}`;
  const exportCsv = () => downloadFile(exportName("csv"), toCsv([
    ["Datum", "Unterricht", "gut (Minuten)", "großartig (Minuten)"],
    ...lessons.map((l) => [formatDate(l.date), l.name, csvMinutes(l.mitte), csvMinutes(l.rechts)])
  ]), CSV_TYPE);
  const exportPdf = () => downloadFile(exportName("pdf"), buildPdf({
    title: student.name,
    subtitle: `${className ? `Klasse ${className} · ` : ""}Stand ${formatDate(new Date())} · ${count ? `erfasst über ${lessonsLabel(count)}` : "noch keine Unterrichte"}`,
    facts: [
      `Du arbeitest gut: ${formatDurationLong(totals.mitte)}`,
      `Du arbeitest großartig: ${formatDurationLong(totals.rechts)}`,
      `Gut oder großartig, im Schnitt je Unterricht: ${average}`
    ],
    columns: [{ label: "Unterricht", weight: 3 }, { label: "Datum", weight: 1.2 },
      { label: "gut", align: "right" }, { label: "großartig", align: "right" }],
    rows: lessons.map((l) => [l.name, formatDate(l.date), formatDurationLong(l.mitte), formatDurationLong(l.rechts)]),
    notes: [EXPORT_NOTE.replace(/ Alphabetisch.*$/, ""), SCHOOL_YEAR_DELETE_INFO],
    footer: `Klassenschwung · ${student.name}`
  }), PDF_TYPE);

  const tiles = h("div", { class: "stats__grid" },
    POSITIVE_COLUMNS.map((c) =>
      h("div", { class: `stat stat--${c.key}` },
        h("div", { class: "stat__label" }, c.title),
        h("div", { class: "stat__value" }, formatDurationLong(totals[c.key])))),
    h("div", { class: "stat" },
      h("div", { class: "stat__label" }, "gut oder großartig, Ø je Unterricht"),
      h("div", { class: "stat__value" }, average)));

  const table = count
    ? h("table", { class: "table" },
        h("thead", {}, h("tr", {},
          h("th", {}, "Unterricht"),
          POSITIVE_COLUMNS.map((c) => h("th", { class: "num" }, c.title)))),
        h("tbody", {}, lessons.map((lesson) =>
          h("tr", {},
            h("td", {}, lesson.name, lesson.date ? h("span", { class: "list__sub" }, formatDate(lesson.date)) : null),
            POSITIVE_COLUMNS.map((c) => h("td", { class: "num" }, formatDurationLong(lesson[c.key])))))))
    : emptyView("Diese Schülerin / dieser Schüler war noch in keinem Unterricht dabei.");

  appEl.replaceChildren(
    pageHead({ eyebrow: "Auswertung", title: student.name }),
    classTabs(classId, "auswertung"),
    h("div", { class: "stack" },
      h("div", { class: "card" },
        h("h2", {}, "Gesamtzeiten"),
        h("p", { class: "muted small" }, count ? `Erfasst über ${lessonsLabel(count)}.` : "Noch keine Daten."),
        tiles),
      h("div", { class: "card" },
        h("div", { class: "card__head" },
          h("h2", {}, "Nach Unterricht"),
          count ? exportMenu([
            { label: "Als PDF", sub: "Zum Ausdrucken oder Ablegen", onSelect: exportPdf },
            { label: "Als CSV", sub: "Für Excel", onSelect: exportCsv }
          ]) : null),
        h("div", { class: "table-scroll" }, table)),
      h("p", { class: "muted small" }, SCHOOL_YEAR_DELETE_INFO))
  );
}

/* -------------------------------------------------------------------
   Ansicht: Unterrichtsliste
   ------------------------------------------------------------------- */

async function renderLessonList() {
  appEl.className = "app";
  setChrome({ title: "Unterrichte", section: "unterricht" });
  appEl.replaceChildren(loadingView());

  const lessons = await api.listLessons();

  const list = lessons.length
    ? h("ul", { class: "list" }, lessons.map((lesson) =>
        h("li", { class: "list__item" },
          h("button", { class: "list__main", onclick: () => navigate(`/lessons/${lesson.id}`) },
            lesson.name,
            h("span", { class: "list__sub" },
              `${lesson.classes?.name ?? "Klasse entfernt"} · ${formatDate(lesson.date)}` +
              (!lesson.ended_at && lesson.auto_end_at ? ` · endet um ${formatTime(new Date(lesson.auto_end_at))}` : ""))),
          lesson.ended_at
            ? h("span", { class: "badge" }, "beendet")
            : h("span", { class: "badge badge--live" }, "läuft"),
          h("button", {
            class: "btn btn--sm btn--danger btn--icon", type: "button", "aria-label": "Unterricht löschen",
            onclick: () => confirmDelete(
              `Unterricht „${lesson.name}“ wirklich löschen? Alle erfassten Zeiten dieses Unterrichts gehen unwiderruflich verloren.`,
              async () => { await api.deleteLesson(lesson.id); await renderLessonList(); toast("Unterricht gelöscht."); })
          }, trashIcon()))))
    : emptyView("Noch keine Unterrichte. Starte oben den ersten.");

  appEl.replaceChildren(
    pageHead({
      title: "Unterrichte",
      lead: "Klasse auswählen – der Name wird automatisch aus Klasse und Datum gebildet.",
      actions: [h("button", { class: "btn btn--primary", onclick: () => navigate("/lessons/new") },
        "Unterricht starten")]
    }),
    h("div", { class: "card" },
      h("h2", {}, "Bisherige Unterrichte"),
      list)
  );
}

/* -------------------------------------------------------------------
   Ansicht: Neuen Unterricht starten
   ------------------------------------------------------------------- */

async function renderNewLesson() {
  appEl.className = "app";
  setChrome({ title: "Unterricht starten", back: "/lessons", section: "unterricht" });
  appEl.replaceChildren(loadingView());

  const classes = await api.listClasses();
  const usable = currentFirst(classes.filter((cls) => (cls.students?.[0]?.count ?? 0) > 0));

  if (!usable.length) {
    appEl.replaceChildren(
      h("div", { class: "card stack" },
        h("h2", {}, "Keine Klasse mit Schülern"),
        h("p", { class: "muted" },
          "Lege zuerst eine Klasse an und trage Schülerinnen und Schüler ein."),
        h("button", { class: "btn btn--primary", onclick: () => navigate("/classes") }, "Zu den Klassen"))
    );
    return;
  }

  const today = formatDate(new Date());

  appEl.replaceChildren(
    pageHead({ title: "Unterricht starten", lead: `Der Unterricht heißt dann „[Klasse] ${today}“.` }),
    h("div", { class: "card" },
      h("h2", {}, "Klasse wählen"),
      h("ul", { class: "list" }, usable.map((cls) =>
        h("li", { class: "list__item" },
          h("button", { class: "list__main", onclick: () => startLessonFor(cls.id, cls.name) },
            cls.name,
            h("span", { class: "list__sub" }, `${cls.name} ${today}`)),
          nowBadge(cls.id),
          h("span", { class: "badge" }, `${cls.students?.[0]?.count ?? 0}`)))))
  );
}

async function startLessonFor(classId, className) {
  const mode = await pickLessonMode();
  if (!mode) return;

  toast(`Unterricht für ${className} wird gestartet…`);
  try {
    const lessonId = await api.startLesson(classId, mode);
    try {
      await api.setAutoEnd(lessonId, autoEndFor(classId));
    } catch (error) {
      // Der Unterricht laeuft trotzdem, nur ohne automatisches Ende.
      console.error(error);
    }
    state.openLessons.add(lessonId);
    navigate(`/lessons/${lessonId}`);
  } catch (error) {
    showError(error, "Unterricht konnte nicht gestartet werden.");
  }
}

/* -------------------------------------------------------------------
   Ansicht: Board
   ------------------------------------------------------------------- */

async function renderBoard(lessonId) {
  // Board wird nach Beenden/Fortsetzen auch direkt neu aufgebaut – dabei
  // muss der Timer der vorherigen Instanz gestoppt werden.
  runCleanup();
  const listHash = state.guest ? "/ausprobieren" : "/lessons";
  appEl.className = "app app--wide";
  setChrome({ title: "Unterricht", back: listHash, minimal: true });
  appEl.replaceChildren(loadingView());

  const lesson = await api.getLesson(lessonId);
  if (!lesson) {
    toast(state.guest
      ? "Der Probe-Unterricht ist nicht mehr da – ohne Anmeldung wird nichts gespeichert."
      : "Unterricht nicht gefunden.", "error");
    return navigate(listHash);
  }
  setChrome({ title: lesson.name, back: listHash, minimal: true });

  // Alle der Klasse, auch wer gerade nicht dabei ist (fuer "Wer ist da?").
  let roster = [];
  try {
    roster = await api.lessonRoster(lessonId, lesson.class_id);
  } catch (error) {
    console.error(error);
  }
  const rosterNames = new Map(roster.map((s) => [s.id, s.name]));

  // Probe-Unterricht liegt nur im Arbeitsspeicher: vor dem Neuladen oder
  // Schliessen nachfragen, solange er laeuft.
  if (state.guest && !lesson.ended_at) {
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    registerCleanup(() => window.removeEventListener("beforeunload", warn));
  }

  // Offener Unterricht in diesem Tab: wird ggf. beim Schliessen beendet und
  // zum eingestellten Zeitpunkt automatisch abgeschlossen.
  if (lesson.ended_at) {
    state.openLessons.delete(lessonId);
  } else {
    state.openLessons.add(lessonId);
    if (lesson.auto_end_at) {
      const wait = new Date(lesson.auto_end_at).getTime() - Date.now();
      const timer = setTimeout(async () => {
        await api.closeDueLessons();
        state.openLessons.delete(lessonId);
        await renderBoard(lessonId);
        toast("Unterricht automatisch beendet.");
      }, Math.min(Math.max(0, wait) + 1000, 2 ** 31 - 1));
      registerCleanup(() => clearTimeout(timer));
    }
  }

  const sorted = lesson.mode === "sortiert";
  const boardEl = h("div", { class: sorted ? "sorted-grid" : "board" });
  const headerEl = h("div", { class: sorted ? "card board-header" : "card row" });
  const statsEl = h("div", { class: "board-stats" });
  const syncEl = h("span", { class: "sync-status", role: "status", "aria-live": "polite", hidden: true });
  const presenceBtn = h("button", { class: "btn btn--ghost", type: "button", onclick: openPresence });
  // Aktueller Stand inkl. noch nicht uebertragener Aenderungen.
  let rows = [];
  // Nach dem Uebertragen einmal mit dem Server abgleichen.
  let needsSync = !state.guest && pendingFor(lessonId).length > 0;

  appEl.replaceChildren(h("div", { class: "stack" },
    headerEl, state.guest && lesson.ended_at ? guestSummaryCard(lessonId) : null, boardEl));

  const layout = () => (sorted ? layoutStudentGrid(boardEl) : layoutBoard(boardEl));

  // Groesse und Grid haengen von der verfuegbaren Flaeche ab – bei
  // Groessenaenderungen des Containers (Fenster, Zoom, Orientierung) neu
  // berechnen. Aenderungen durch Drag & Drop bzw. Klick loest draw() selbst aus.
  const boardResizeObserver = new ResizeObserver(layout);
  boardResizeObserver.observe(boardEl);
  registerCleanup(() => boardResizeObserver.disconnect());

  window.addEventListener("resize", layout);
  registerCleanup(() => window.removeEventListener("resize", layout));

  async function refresh() {
    const fresh = await api.boardRows(lessonId);
    rows = state.guest ? fresh : pendingFor(lessonId).reduce((list, op) => applyOp(list, op, rosterNames), fresh);
    draw(rows);
  }

  function draw(rows) {
    if (sorted) drawSorted(rows); else drawKanban(rows);
    drawPresenceCount();
  }

  function drawSorted(rows) {
    boardEl.replaceChildren(...byStudentName(rows).map((row) => studentTile(row)));
    layoutStudentGrid(boardEl);
    statsEl.textContent = countsText(stateCounts(rows));
  }

  function drawKanban(rows) {
    boardEl.replaceChildren(...kanbanColumns(rows, studentCard));
    layoutBoard(boardEl);
  }

  /** Drag & Drop per Pointer Events statt HTML5-Drag-and-Drop: funktioniert
   * so gleichermassen mit Maus, Finger und Stift (HTML5-DnD ist auf
   * Tablets je nach Browser gar nicht oder nur per Langdruck verfuegbar). */
  function studentCard(row, columnKey) {
    const name = row.students?.name ?? "Unbekannt";

    const card = h("div", {
      class: `student${lesson.ended_at ? "" : " student--draggable"}`,
      dataset: { studentId: row.student_id, column: columnKey }
    },
      h("div", { class: "student__name" }, name));

    card.addEventListener("pointerdown", (event) => {
      if (lesson.ended_at || event.button !== 0) return;
      event.preventDefault();
      card.setPointerCapture(event.pointerId);

      const startX = event.clientX;
      const startY = event.clientY;
      let floating = null;
      let offX = 0;
      let offY = 0;
      let target = null;

      function begin() {
        const rect = card.getBoundingClientRect();
        offX = startX - rect.left;
        offY = startY - rect.top;
        floating = card.cloneNode(true);
        floating.classList.add("student--floating");
        floating.style.width = `${rect.width}px`;
        floating.style.height = `${rect.height}px`;
        document.body.append(floating);
        card.classList.add("student--dragging");
        // Nicht benachbarte Spalten optisch abblenden.
        boardEl.querySelectorAll(".column__body").forEach((el) => {
          if (!isAdjacent(columnKey, el.dataset.column)) el.parentElement.classList.add("column--invalid");
        });
      }

      function onMove(ev) {
        if (!floating) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < BOARD_DRAG_START_PX) return;
          begin();
        }
        floating.style.transform = `translate(${ev.clientX - offX}px, ${ev.clientY - offY}px)`;
        // Nur direkt benachbarte Spalten sind gueltige Drop-Ziele.
        const column = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".column");
        const key = column?.querySelector(".column__body")?.dataset.column;
        const next = key && isAdjacent(columnKey, key) ? column : null;
        if (next !== target) {
          target?.classList.remove("column--dragover");
          next?.classList.add("column--dragover");
          target = next;
        }
      }

      function finish(ev) {
        card.removeEventListener("pointermove", onMove);
        card.removeEventListener("pointerup", finish);
        card.removeEventListener("pointercancel", finish);
        if (!floating) return;
        floating.remove();
        card.classList.remove("student--dragging");
        boardEl.querySelectorAll(".column--dragover, .column--invalid")
          .forEach((el) => el.classList.remove("column--dragover", "column--invalid"));
        if (ev.type === "pointerup" && target) {
          move(row.student_id, target.querySelector(".column__body").dataset.column);
        }
      }

      card.addEventListener("pointermove", onMove);
      card.addEventListener("pointerup", finish);
      card.addEventListener("pointercancel", finish);
    });

    return card;
  }

  function studentTile(row) {
    const name = row.students?.name ?? "Unbekannt";

    const tile = h("div", {
      class: "student",
      dataset: { studentId: row.student_id, column: row.col }
    },
      h("div", { class: "student__name" }, name));

    // Linke Haelfte der Box = einen Zustand zurueck, rechte Haelfte = vor.
    tile.addEventListener("click", (event) => {
      if (lesson.ended_at) return;
      const rect = tile.getBoundingClientRect();
      const forward = event.clientX - rect.left > rect.width / 2;
      const target = COLUMNS[columnIndex(row.col) + (forward ? 1 : -1)]?.key;
      if (target) move(row.student_id, target);
    });

    return tile;
  }

  /** Wirkt sofort; gespeichert wird ueber die Warteschlange, damit kurze
   * WLAN-Aussetzer niemanden ausbremsen. Ohne Konto direkt im Tab. */
  async function change(op) {
    applyOp(rows, op, rosterNames);
    draw(rows);
    if (!state.guest) {
      needsSync = true;
      enqueue({ ...op, lessonId });
      return;
    }
    try {
      if (op.kind === "move") await api.moveStudent(lessonId, op.studentId, op.column);
      else await api.setPresence(lessonId, op.studentId, op.present);
    } catch (error) {
      showError(error);
      await refresh();
    }
  }

  function move(studentId, targetColumn) {
    if (lesson.ended_at) return;
    const row = rows.find((r) => r.student_id === studentId);
    if (row && isAdjacent(row.col, targetColumn)) change({ kind: "move", studentId, column: targetColumn });
  }

  function drawPresenceCount() {
    const total = Math.max(roster.length, rows.length);
    presenceBtn.replaceChildren("Wer ist da?", h("span", { class: "badge" }, `${rows.length}/${total}`));
  }

  /** "Wer ist da?": Wer fehlt, wird aus dem Unterricht genommen und
   * sammelt keine Zeit; eine Abwesenheit wird nicht gespeichert. */
  function openPresence() {
    const list = roster.length
      ? [...roster].sort((a, b) => a.name.localeCompare(b.name, "de"))
      : byStudentName(rows).map((r) => ({ id: r.student_id, name: r.students?.name ?? "Unbekannt" }));
    const summary = h("p", { class: "presence__summary" });
    const grid = h("div", { class: "presence__grid" });
    function drawList() {
      const here = new Set(rows.map((r) => r.student_id));
      const missing = list.length - list.filter((s) => here.has(s.id)).length;
      summary.textContent = missing ? `${list.length - missing} da · ${missing} ${missing === 1 ? "fehlt" : "fehlen"}` : "Alle da";
      grid.replaceChildren(...list.map((s) => {
        const present = here.has(s.id);
        return h("button", {
          class: "presence__item", type: "button", "aria-pressed": String(present),
          onclick: () => { change({ kind: "presence", studentId: s.id, present: !present }); drawList(); }
        }, h("span", { class: "presence__name" }, s.name), h("span", { class: "presence__state" }, present ? "da" : "fehlt"));
      }));
    }
    drawList();
    const close = openModal([
      h("h2", { style: "margin-top:0" }, "Wer ist da?"),
      h("p", { class: "muted small" },
        "Tippe an, wer fehlt. Wer fehlt, sammelt keine Zeit, und der Unterricht zählt für diese Person in der " +
        "Auswertung nicht mit. Schon gesammelte Zeit bleibt, z. B. wenn jemand früher geht."),
      summary,
      grid,
      h("div", { class: "row", style: "justify-content:flex-end" },
        h("button", { class: "btn btn--primary", type: "button", onclick: () => close() }, "Fertig"))
    ], { className: "modal__panel--wide" });
    registerCleanup(close);
  }

  function drawSync() {
    const n = pendingFor(lessonId).length;
    syncEl.hidden = !n;
    syncEl.classList.toggle("sync-status--offline", queue.offline);
    syncEl.textContent = !n ? "" : queue.offline
      ? `Keine Verbindung · ${n === 1 ? "1 Änderung wartet" : `${n} Änderungen warten`}`
      : "Wird gespeichert …";
  }

  if (!state.guest) {
    onQueue((event) => {
      drawSync();
      // Abgelehnte Aenderung oder alles uebertragen: mit dem Server abgleichen.
      const rejected = event.done?.lessonId === lessonId && event.error;
      if (rejected || (event.drained && needsSync)) {
        needsSync = false;
        refresh().catch(console.error);
      }
    });
  }

  function boardStatus() {
    if (lesson.ended_at) return `${formatDate(lesson.date)} · beendet`;
    const parts = [`${formatDate(lesson.date)} · läuft`];
    if (lesson.auto_end_at) parts.push(`endet automatisch um ${formatTime(new Date(lesson.auto_end_at))}`);
    if (autoEndSettings().onClose && state.scheduleAvailable) parts.push("endet beim Schließen der Seite");
    return parts.join(" · ");
  }

  function drawHeader() {
    const actions = lesson.ended_at
      ? h("button", { class: "btn", onclick: async () => {
          try {
            await api.reopenLesson(lessonId);
            await api.setAutoEnd(lessonId, autoEndFor(lesson.class_id));
            await renderBoard(lessonId);
            toast("Unterricht fortgesetzt.");
          }
          catch (error) { showError(error); }
        } }, "Fortsetzen")
      : h("button", { class: "btn btn--primary", onclick: () => confirmDelete(
          "Unterricht jetzt beenden? Alle laufenden Zeiten werden gestoppt.",
          async () => {
            const waiting = pendingFor(lessonId).length;
            if (waiting) {
              flushQueue();
              throw new Error(queue.offline
                ? `Keine Verbindung: ${waiting === 1 ? "1 Änderung wartet" : `${waiting} Änderungen warten`} noch. ` +
                  "Beende den Unterricht, sobald das WLAN wieder da ist."
                : "Die letzten Änderungen werden noch gespeichert. Bitte gleich noch einmal tippen.");
            }
            await api.endLesson(lessonId);
            state.openLessons.delete(lessonId);
            await renderBoard(lessonId);
            toast("Unterricht beendet.");
          },
          "Beenden") }, "Unterricht beenden");

    const info = h("div", { style: sorted ? "min-width:0" : "flex:1 1 auto;min-width:0" },
      h("strong", {}, lesson.classes?.name ?? "Klasse"),
      h("span", { class: "list__sub" }, boardStatus()),
      syncEl);

    // Die Klassenansicht laeuft in einem eigenen Fenster und braucht dafuer
    // die Datenbank; der Probe-Unterricht existiert nur in diesem Tab.
    const classView = state.guest ? null : dropdown({
      button: h("button", { class: "btn btn--ghost", type: "button" },
        "Klassenansicht", h("span", { class: "caret", "aria-hidden": "true" })),
      items: () => [
        { heading: "Für Beamer oder zweiten Bildschirm" },
        { label: "Mit Namen", sub: "Alle sehen, wer in welcher Gruppe ist", onSelect: () => openClassView(lessonId, "namen") },
        { label: "Nur Anzahl", sub: "Wie viele in jeder Gruppe sind, ohne Namen", onSelect: () => openClassView(lessonId, "anzahl") }
      ]
    });

    headerEl.replaceChildren(info, ...(sorted ? [statsEl] : []),
      h("div", { class: "row board-actions" }, presenceBtn, classView, actions));
  }

  drawHeader();
  drawSync();
  await refresh();
}

/* -------------------------------------------------------------------
   Ansicht: Klassenansicht (Beamer / zweiter Bildschirm)
   -------------------------------------------------------------------
   Zeigt einen Unterricht nur zum Anschauen: alle mit Namen in ihrer
   Gruppe oder nur die Anzahl je Gruppe. Bedient wird weiter im Board,
   z. B. auf dem Tablet. Aenderungen kommen live per Supabase Realtime
   (Migration 0008). Zusaetzlich laedt die Ansicht regelmaessig, nach
   WLAN-Aussetzern und beim Zurueckkehren in den Tab neu, damit sie auch
   ohne Realtime stimmt.
   ------------------------------------------------------------------- */

const CLASS_VIEW_MODES = ["namen", "anzahl"];
const CLASS_VIEW_POLL_MS = 15000;

function openClassView(lessonId, mode) {
  const url = `${location.pathname}${location.search}#/lessons/${lessonId}/klasse/${mode}`;
  // Benanntes Fenster: laesst sich auf den Beamer ziehen, ein zweiter Klick nutzt es wieder.
  const win = window.open(url, `klassenansicht-${lessonId}`);
  if (win) win.focus();
  else toast("Das Fenster wurde blockiert. Bitte Pop-ups für diese Seite erlauben.", "error");
}

async function renderClassView(lessonId, requestedMode) {
  const mode = CLASS_VIEW_MODES.includes(requestedMode) ? requestedMode : "namen";
  appEl.className = "app app--wide class-view";
  setChrome({ title: "Klassenansicht", back: `/lessons/${lessonId}`, minimal: true });
  appEl.replaceChildren(loadingView());

  let [lesson, rows] = await Promise.all([api.getLesson(lessonId), api.boardRows(lessonId)]);
  if (!lesson) { toast("Unterricht nicht gefunden.", "error"); return navigate("/lessons"); }
  const className = lesson.classes?.name ?? "Klasse";
  setChrome({ title: `Klassenansicht ${className}`, back: `/lessons/${lessonId}`, minimal: true });

  const sorted = lesson.mode === "sortiert";
  const counting = mode === "anzahl";
  const statusEl = h("span", { class: "list__sub" });
  const summaryEl = h("div", { class: "board-stats" });
  const bodyEl = h("div", { class: counting ? "count-board" : sorted ? "sorted-grid" : "board" });
  let offline = false;
  let alive = true;

  const modeLink = (key, label) => h("a", {
    class: "chip", href: `#/lessons/${lessonId}/klasse/${key}`, "aria-current": String(key === mode)
  }, label);

  const fullscreenBtn = document.fullscreenEnabled
    ? h("button", { class: "btn btn--ghost", type: "button" }, "Vollbild")
    : null;

  const headerEl = h("div", { class: "card board-header" },
    h("div", { style: "min-width:0" }, h("strong", {}, className), statusEl),
    summaryEl,
    h("div", { class: "row board-actions" },
      h("div", { class: "chips class-view__modes", role: "group", "aria-label": "Anzeige" },
        modeLink("namen", "Mit Namen"), modeLink("anzahl", "Nur Anzahl")),
      fullscreenBtn));

  function layout() {
    if (counting) {
      bodyEl.style.height = `${Math.max(BOARD_MIN_HEIGHT_PX,
        window.innerHeight - bodyEl.getBoundingClientRect().top - BOARD_BOTTOM_MARGIN_PX)}px`;
    } else if (sorted) {
      layoutStudentGrid(bodyEl);
    } else {
      layoutBoard(bodyEl);
    }
  }

  function drawStatus() {
    const parts = [lesson.ended_at ? "beendet" : "läuft"];
    if (offline) parts.push("Verbindung unterbrochen, wird erneut versucht …");
    statusEl.textContent = parts.join(" · ");
  }

  function draw() {
    drawStatus();
    const counts = stateCounts(rows);
    summaryEl.textContent = sorted && !counting ? countsText(counts) : "";
    if (counting) {
      bodyEl.replaceChildren(...COLUMNS.map((c) =>
        h("div", { class: `count-tile count-tile--${c.key}` },
          h("div", { class: "count-tile__value" }, String(counts[c.key])),
          h("div", { class: "count-tile__label" }, c.title))));
    } else if (sorted) {
      bodyEl.replaceChildren(...byStudentName(rows).map((row) => staticStudentBox(row)));
    } else {
      bodyEl.replaceChildren(...kanbanColumns(rows, staticStudentBox));
    }
    layout();
  }

  // Mehrere Aenderungen kurz hintereinander (z. B. Unterricht beenden)
  // loesen nur ein Neuladen aus; waehrend eines Ladevorgangs wird eins vorgemerkt.
  let timer = null;
  let loading = false;
  let again = false;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 150); };

  async function refresh() {
    if (!alive) return;
    if (loading) { again = true; return; }
    loading = true;
    try {
      const [nextLesson, nextRows] = await Promise.all([api.getLesson(lessonId), api.boardRows(lessonId)]);
      if (!alive) return;
      if (!nextLesson) {
        alive = false;
        appEl.replaceChildren(emptyView("Dieser Unterricht wurde gelöscht."));
        return;
      }
      lesson = nextLesson;
      rows = nextRows;
      offline = false;
      draw();
    } catch (error) {
      console.error(error);
      if (!alive) return;
      offline = true;
      drawStatus();
    } finally {
      loading = false;
      if (again && alive) { again = false; schedule(); }
    }
  }

  const channel = sb.channel(`klassenansicht-${lessonId}-${Date.now()}`)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "lesson_students", filter: `lesson_id=eq.${lessonId}` }, schedule)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "lessons", filter: `id=eq.${lessonId}` }, schedule)
    // "Wer ist da?" loescht Zeilen; Loeschungen kommen bei Realtime nur ungefiltert an.
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "lesson_students" }, schedule)
    // Auch nach einer Wiederverbindung: verpasste Aenderungen nachladen.
    .subscribe((status) => { if (status === "SUBSCRIBED") schedule(); });

  const poll = setInterval(schedule, CLASS_VIEW_POLL_MS);
  const onVisible = () => { if (document.visibilityState === "visible") schedule(); };
  const onFullscreen = () => {
    if (fullscreenBtn) fullscreenBtn.textContent = document.fullscreenElement ? "Vollbild beenden" : "Vollbild";
    layout();
  };
  fullscreenBtn?.addEventListener("click", () => {
    const pending = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    pending?.catch?.(() => {});
  });
  const resizeObserver = new ResizeObserver(layout);
  resizeObserver.observe(bodyEl);
  window.addEventListener("resize", layout);
  window.addEventListener("online", schedule);
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("fullscreenchange", onFullscreen);
  registerCleanup(() => {
    alive = false;
    clearTimeout(timer);
    clearInterval(poll);
    resizeObserver.disconnect();
    window.removeEventListener("resize", layout);
    window.removeEventListener("online", schedule);
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("fullscreenchange", onFullscreen);
    sb.removeChannel(channel);
  });

  appEl.replaceChildren(h("div", { class: "stack" }, headerEl, bodyEl));
  onFullscreen();
  draw();
}

/* -------------------------------------------------------------------
   Ansichten ohne Anmeldung
   ------------------------------------------------------------------- */

const GUEST_SAMPLE_NAMES = ["Amira", "Ben", "Clara", "Deniz", "Emil", "Finn",
  "Greta", "Hannah", "Ilyas", "Jonas", "Lea", "Mats"];

/** Namen aus Zeilen, Kommas oder Semikolons; bereinigt, ohne Doppelte. */
function parseNameList(text) {
  const seen = new Set();
  const names = [];
  for (const part of String(text).split(/[\n,;]+/)) {
    const name = cleanName(part, 80);
    const key = name.toLocaleLowerCase("de");
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function guestAccountHint() {
  return h("section", { class: "card hint-card" },
    h("div", {},
      h("h2", {}, "Mit Konto"),
      h("p", { class: "muted" },
        "Klassen und Namen bleiben gespeichert, die Auswertung sammelt die Zeiten über das ganze Schuljahr, " +
        "dazu kommen Sitzplan, Stundenplan und die Klassenansicht für den Beamer. " +
        "Konten werden derzeit nur persönlich vergeben.")),
    h("a", { class: "btn", href: "#/anmelden" }, "Anmelden"));
}

/** Zeiten nach einem beendeten Probe-Unterricht. */
function guestSummaryCard(lessonId) {
  const times = guestLessonTimes(lessonId);
  return h("section", { class: "card" },
    h("h2", {}, "Zeiten in diesem Probe-Unterricht"),
    h("p", { class: "muted small" },
      "Nur hier zu sehen und nicht gespeichert. Mit Konto sammelt die Auswertung diese Zeiten über alle Unterrichte."),
    h("div", { class: "table-scroll" },
      h("table", { class: "table" },
        h("thead", {}, h("tr", {},
          h("th", {}, "Name"),
          POSITIVE_COLUMNS.map((c) => h("th", { class: "num" }, c.title)))),
        h("tbody", {}, times.map((t) => h("tr", {},
          h("td", {}, t.name),
          POSITIVE_COLUMNS.map((c) => h("td", { class: "num" }, formatDurationLong(t[c.key])))))))));
}

function renderGuestTrial() {
  appEl.className = "app";
  setChrome({ title: "Unterricht ausprobieren", section: "ausprobieren" });

  const classInput = h("input", {
    class: "input", type: "text", maxlength: String(GUEST_CLASS_NAME_MAX), placeholder: "z. B. 7b"
  });
  const namesInput = h("textarea", { class: "input", rows: "8", placeholder: "Ein Vorname pro Zeile" });
  const errorBox = h("div", { class: "error-box", hidden: true });
  const fail = (message) => { errorBox.textContent = message; errorBox.hidden = false; };

  const sampleBtn = h("button", { class: "btn btn--ghost", type: "button" }, "Beispielnamen einsetzen");
  sampleBtn.addEventListener("click", () => {
    namesInput.value = GUEST_SAMPLE_NAMES.join("\n");
    if (!classInput.value.trim()) classInput.value = "7b";
  });

  const form = h("form", { class: "card" },
    h("h2", {}, "Probe-Unterricht starten"),
    errorBox,
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Klasse (freiwillig)"), classInput),
    h("label", { class: "field" }, h("span", { class: "field__label" }, "Vornamen"), namesInput),
    h("p", { class: "muted small" }, "Ein Name pro Zeile oder durch Komma getrennt. Vornamen genügen."),
    h("div", { class: "row" },
      h("button", { class: "btn btn--primary", type: "submit" }, "Unterricht starten"),
      sampleBtn));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const names = parseNameList(namesInput.value);
    if (!names.length) return fail("Bitte mindestens einen Namen eintragen.");
    if (names.length > GUEST_MAX_STUDENTS) return fail(`Bitte höchstens ${GUEST_MAX_STUDENTS} Namen eintragen.`);
    const mode = await pickLessonMode();
    if (!mode) return;
    const className = cleanName(classInput.value, GUEST_CLASS_NAME_MAX) || "Probeklasse";
    navigate(`/lessons/${startGuestLesson(className, names, mode)}`);
  });

  // Probe-Unterrichte bleiben, solange der Tab offen ist.
  const lessons = [...guestLessons.values()].map((entry) => entry.lesson).reverse();
  const openCard = lessons.length
    ? h("section", { class: "card" },
        h("h2", {}, "In diesem Tab"),
        h("ul", { class: "list" }, lessons.map((lesson) =>
          h("li", { class: "list__item" },
            h("button", { class: "list__main", type: "button", onclick: () => navigate(`/lessons/${lesson.id}`) },
              lesson.name,
              h("span", { class: "list__sub" }, `seit ${formatTime(new Date(lesson.created_at))}`)),
            h("span", { class: `badge${lesson.ended_at ? "" : " badge--live"}` }, lesson.ended_at ? "beendet" : "läuft")))))
    : null;

  appEl.replaceChildren(
    pageHead({
      eyebrow: "Ohne Anmeldung",
      title: "Unterricht ausprobieren",
      lead: "Trag ein paar Vornamen ein und probier das Board aus. Es wird nichts gespeichert: " +
        "Beim Neuladen oder Schließen der Seite ist der Probe-Unterricht weg."
    }),
    h("div", { class: "stack" }, openCard, form, guestAccountHint()));
}

/** Fokus-Wald ohne Konto: Klassen anlegen und loeschen (nur im Browser). */
function guestClassesCard(classes) {
  const input = h("input", {
    class: "input", type: "text", maxlength: String(GUEST_CLASS_NAME_MAX), placeholder: "Klassenname, z. B. 7b"
  });
  const form = h("form", { class: "row row--form" },
    input, h("button", { class: "btn btn--primary", type: "submit" }, "Anlegen"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = cleanName(input.value, GUEST_CLASS_NAME_MAX);
    if (!name) return toast("Bitte einen Klassennamen eingeben.", "error");
    try {
      addGuestClass(name);
    } catch (error) {
      return showError(error);
    }
    await router();
    toast(`Klasse „${name}“ angelegt.`);
  });

  const list = classes.length
    ? h("ul", { class: "list" }, classes.map((cls) =>
        h("li", { class: "list__item" },
          h("button", { class: "list__main", type: "button", onclick: () => navigate(`/focus/${cls.id}`) },
            cls.name, h("span", { class: "list__sub" }, treesLabel(cls.focus_trees.length))),
          h("button", {
            class: "btn btn--sm btn--danger", type: "button",
            onclick: () => confirmDelete(
              `Klasse „${cls.name}“ mit ihrem Wald aus diesem Browser löschen?`,
              async () => { deleteGuestClass(cls.id); await router(); toast("Klasse gelöscht."); })
          }, "Löschen"))))
    : null;

  return h("section", { class: "card" },
    h("h2", {}, "Klassen in diesem Browser"),
    h("p", { class: "muted small" },
      "Ohne Anmeldung liegen Klassennamen, Bäume und Belohnung nur in diesem Browser. Auf einem anderen Gerät " +
      "oder nach dem Löschen der Browserdaten ist der Wald nicht da. Schülernamen braucht der Fokus-Wald nicht."),
    form,
    list);
}

/* -------------------------------------------------------------------
   Fokus-Wald: Lautstaerke-Monitor mit Klassenwald
   -------------------------------------------------------------------
   Mechanik wie "Mio's Monster Meter": Solange es ruhig ist, laeuft der
   Timer; bei Unruhe pausiert er, bei anhaltendem Laerm geht es von vorn
   los. Statt eines Monsters waechst ein Baum, und jedes erreichte Ziel
   pflanzt ihn dauerhaft in den Wald der Klasse. Sammlung, Klassen-
   Ranking und eine selbst gewaehlte Belohnung ziehen auch bei aelteren
   Schuelern, bei denen ein Kuschelmonster nicht mehr wirkt.

   Audio wird nur im Browser ausgewertet (Pegel pro Frame), nichts wird
   aufgenommen oder uebertragen. Gespeichert wird nur der fertige Baum.
   ------------------------------------------------------------------- */

const FOCUS_PROBE = "probelauf";
/** Route der Uebersicht ueber alle Klassenwaelder (#/focus/waelder). */
const FOCUS_WALK = "waelder";
const FOCUS_GOALS_MIN = [3, 5, 10, 15, 20, 30, 45];
/** Offenes Ziel: der Timer zaehlt hoch; erst Birke, dann Kirschbaum, dann ziehen Voegel ein. */
const FOCUS_OPEN = "offen";
/** Im offenen Modus ist der Baum nach dieser Zeit ausgewachsen (wie beim kuerzesten Ziel). */
const FOCUS_OPEN_GROWN_SECONDS = FOCUS_GOALS_MIN[0] * 60;
/** Obergrenze laut Datenbank (focus_trees.goal_seconds). */
const FOCUS_OPEN_MAX_SECONDS = 7200;
const FOCUS_TICK_MS = 50;
/** Zonengrenzen auf der Pegelskala 0–100 (nach Empfindlichkeit), wie bei Mio. */
const FOCUS_ZONES = { unruhig: 25, laut: 50 };
/** So lange muss eine neue Zone anliegen, bevor sie gilt – filtert Einzelgeraeusche. */
const FOCUS_ZONE_DWELL_MS = { ruhig: 800, unruhig: 300, laut: 300 };
/** So lange darf es "laut" sein, bevor der Baum vertrocknet. */
const FOCUS_WITHER_MS = 1500;
/** Dauer der Vertrocknen-Animation, danach startet ein neuer Samen. */
const FOCUS_WITHER_ANIM_MS = 2300;
/** Unterhalb dieser Wachstumszeit wird ohne Animation zurueckgesetzt. */
const FOCUS_MIN_WITHER_SECONDS = 5;
const PREF_FOCUS_GOAL = "bt.focus.goal";
const PREF_FOCUS_SENSITIVITY = "bt.focus.sensitivity";

/** Browser-lokale Einstellungen; darf fehlschlagen (privater Modus etc.). */
function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* nur Komfort */ }
}

function isMissingFocusSchema(error) {
  return ["42703", "42P01", "PGRST200", "PGRST204", "PGRST205"].includes(error?.code);
}

const treesLabel = (n) => (n === 1 ? "1 Baum" : `${n} Bäume`);

/* ---------- Baeume (SVG) ---------- */

/** Logo (Kirschbaum mit Amsel) als Kopie aus der Kopfzeile von app.html;
 * die Amsel fliegt beim Einfuegen neu an (CSS). */
function brandMark() {
  return brandLinkEl.querySelector(".brand-mark").cloneNode(true);
}

/**
 * Baumarten mit Steckbrief. Die Reihenfolge folgt der Waldentwicklung:
 * kurze Ziele ergeben schnell wachsende Pionierbaeume, lange Ziele die
 * langsam wachsenden, uralten Waldriesen. So lernen die Schuelerinnen und
 * Schueler nebenbei heimische Baeume kennen. `from` = ab dieser ruhigen
 * Zeit (Sekunden) waechst die Art.
 */
const TREE_SPECIES = {
  birke: {
    name: "Birke", full: "Hänge-Birke", latin: "Betula pendula", article: "Die", from: 0,
    height: "bis 30 m", age: "bis 120 Jahre", growth: "sehr schnell",
    fact: "Pionierbaum: Auf freien Flächen wächst die Birke als einer der ersten Bäume. " +
      "Ihre weiße Rinde wirft das Sonnenlicht zurück und schützt den Stamm vor Hitze."
  },
  kirsch: {
    name: "Kirschbaum", full: "Vogelkirsche", latin: "Prunus avium", article: "Der", from: 5 * 60,
    height: "bis 25 m", age: "rund 100 Jahre", growth: "schnell",
    fact: "Im April ist sie voller weißer Blüten, die von Bienen bestäubt werden – ohne Bienen keine Kirschen. " +
      "Aus der wilden Vogelkirsche wurden unsere Süßkirschen gezüchtet."
  },
  ahorn: {
    name: "Ahorn", full: "Berg-Ahorn", latin: "Acer pseudoplatanus", article: "Der", from: 10 * 60,
    height: "bis 35 m", age: "bis 500 Jahre", growth: "schnell",
    fact: "Seine Früchte haben Flügel und drehen sich beim Herunterfallen wie kleine Propeller. " +
      "So trägt der Wind die Samen weit vom Baum weg."
  },
  fichte: {
    name: "Fichte", full: "Gemeine Fichte", latin: "Picea abies", article: "Die", from: 15 * 60,
    height: "bis 50 m", age: "bis 600 Jahre", growth: "mittel",
    fact: "Fichtenzapfen hängen nach unten und fallen als Ganzes herab. Tannenzapfen stehen aufrecht " +
      "und zerfallen am Baum – ein Zapfen auf dem Waldboden stammt deshalb fast nie von einer Tanne."
  },
  buche: {
    name: "Buche", full: "Rotbuche", latin: "Fagus sylvatica", article: "Die", from: 20 * 60,
    height: "bis 40 m", age: "bis 300 Jahre", growth: "langsam",
    fact: "Ohne den Menschen wäre der größte Teil Deutschlands von Buchenwald bedeckt. " +
      "Ihren Namen hat sie vom leicht rötlichen Holz."
  },
  eiche: {
    name: "Eiche", full: "Stiel-Eiche", latin: "Quercus robur", article: "Die", from: 30 * 60,
    height: "bis 40 m", age: "bis 1000 Jahre", growth: "langsam",
    fact: "Eine alte Eiche ist ein Hochhaus für Tiere: Hunderte Insektenarten, Vögel und Fledermäuse leben an ihr. " +
      "Eichelhäher verstecken Eicheln als Vorrat – vergessene keimen zu neuen Eichen."
  },
  mammut: {
    name: "Mammutbaum", full: "Riesenmammutbaum", latin: "Sequoiadendron giganteum", article: "Der", from: 45 * 60,
    height: "bis 95 m", age: "über 3000 Jahre", growth: "langsam, aber riesig",
    fact: "Der größte Baum der Erde ist ein Mammutbaum: „General Sherman“ in Kalifornien ist 84 m hoch " +
      "und wiegt über 1000 Tonnen. Seine dicke Rinde schützt ihn sogar vor Waldbränden."
  }
};

/** Arten vom ersten (kuerzestes Ziel) bis zum seltensten Baum. */
const TREE_ORDER = Object.keys(TREE_SPECIES);

function speciesForGoal(seconds) {
  return [...TREE_ORDER].reverse().find((key) => seconds >= TREE_SPECIES[key].from);
}

const circles = (list) => list.map(([cx, cy, r]) => ({ cx, cy, r }));
/** Zusatzdetails (Bluete, Zapfen, Fruechte), erscheinen erst am ausgewachsenen Baum. */
const dots = (list, attrs) => list.map(([cx, cy]) => ["circle", { cx, cy, ...attrs }]);

// Koordinaten im viewBox 0 0 200 240, Stammfuss bei (100, 222).
// Blaetter stehen in der Reihenfolge, in der sie beim Wachsen erscheinen.
const TREE_SHAPES = {
  birke: {
    wood: "#5e5a52",
    trunkFill: "#ecebe4",
    trunk: "M96 222 C97 196 98 150 99 62 L101 62 C102 150 103 196 104 222 Z",
    branchWidth: 2.5,
    bark: [[97, 205, 5, 2], [99, 190, 4, 1.6], [96.6, 174, 4, 1.6], [99.4, 156, 3.4, 1.4], [97.6, 136, 3, 1.3], [99, 116, 2.6, 1.2]]
      .map(([x, y, width, height]) => ["rect", { x, y, width, height, fill: "#2d2d2d" }]),
    branches: ["M99 120 C90 118 80 128 76 150", "M101 108 C112 106 122 118 126 140",
      "M99 90 C92 88 84 96 80 112", "M101 80 C108 78 116 86 120 100"],
    leaves: circles([[96, 132, 14], [106, 142, 12], [80, 134, 13], [120, 134, 13], [92, 106, 16], [108, 106, 16],
      [76, 110, 15], [124, 110, 15], [100, 80, 16], [80, 86, 15], [120, 86, 15], [88, 64, 14], [112, 64, 14], [100, 48, 13]]),
    colors: ["#8cc63f", "#a5d65a", "#74b23a"],
    extras: [[84, 96], [116, 94], [78, 124], [122, 122], [96, 118], [106, 84], [90, 140], [112, 128]]
      .map(([cx, cy]) => ["ellipse", { cx, cy, rx: 2, ry: 5.5, fill: "#c2a83e" }])
  },
  kirsch: {
    wood: "#5b3a29",
    trunk: "M93 222 C95 192 96 164 97 122 L103 122 C104 164 105 192 107 222 Z",
    branches: ["M98 170 C86 160 74 150 64 138", "M102 160 C114 150 126 142 136 132",
      "M99 140 C92 128 88 116 84 104", "M101 136 C108 124 112 114 116 104"],
    leaves: circles([[100, 112, 24], [66, 122, 20], [134, 120, 20], [84, 96, 26], [116, 96, 26],
      [56, 100, 18], [144, 98, 18], [100, 76, 26], [76, 72, 20], [124, 72, 20], [100, 54, 18]]),
    colors: ["#6fbf5a", "#86cc6c", "#5aa846"],
    extras: dots([[80, 110], [118, 104], [96, 90], [64, 118], [136, 112], [108, 70], [86, 62], [124, 82],
      [70, 90], [132, 96], [100, 50], [92, 112], [56, 104], [144, 102], [112, 120], [84, 80], [116, 58], [100, 100]],
      { r: 4.2, fill: "#ffffff", stroke: "#f2c9d8", "stroke-width": 1 })
  },
  ahorn: {
    wood: "#6e4b33",
    trunk: "M92 222 C94 196 95 170 96 130 L104 130 C105 170 106 196 108 222 Z",
    branches: ["M98 168 C88 158 78 150 68 140", "M102 160 C112 150 122 144 132 136",
      "M99 140 C94 128 90 120 86 110", "M101 138 C106 128 112 120 116 110"],
    leaves: circles([[100, 120, 26], [70, 118, 24], [130, 118, 24], [56, 96, 22], [144, 96, 22], [84, 94, 28],
      [116, 94, 28], [100, 70, 30], [70, 68, 24], [130, 68, 24], [100, 44, 24]]),
    colors: ["#4caf50", "#43a047", "#66bb6a"],
    extras: [[72, 128], [128, 130], [58, 104], [142, 106], [90, 74], [114, 78], [100, 110], [80, 52], [122, 50]]
      .map(([x, y]) => ["path", { d: `M${x} ${y} q-8 -1 -11 -9 M${x} ${y} q8 -1 11 -9`, fill: "none",
        stroke: "#c08f3e", "stroke-width": 3, "stroke-linecap": "round" }])
  },
  fichte: {
    wood: "#5d4030",
    trunk: "M95 222 L96 196 L104 196 L105 222 Z",
    branches: [],
    // Untere Spitzen tiefer als die Mitte: haengende Zweige wie bei der Fichte.
    leaves: [[204, 124, 48], [180, 108, 46], [156, 94, 44], [132, 80, 42], [108, 64, 40], [84, 48, 36], [60, 32, 34]]
      .map(([y, w, hh]) => ({ points: `${100 - w / 2},${y} 100,${y - hh} ${100 + w / 2},${y} ` +
        `${100 + w / 4},${y - 7} 100,${y - 4} ${100 - w / 4},${y - 7}` })),
    colors: ["#1e5631", "#2a6b3c", "#173f27"],
    extras: [[66, 192], [134, 190], [76, 168], [124, 166], [84, 142], [116, 144], [90, 118], [110, 96]]
      .map(([cx, cy]) => ["ellipse", { cx, cy, rx: 2.8, ry: 7, fill: "#8a5530" }])
  },
  buche: {
    wood: "#8b8a83",
    trunk: "M92 222 C94 194 95 168 96 128 L104 128 C105 168 106 194 108 222 Z",
    branches: ["M98 164 C86 154 72 146 58 138", "M102 158 C114 148 128 142 142 136",
      "M99 138 C92 124 86 112 80 98", "M101 136 C108 122 114 110 120 98"],
    leaves: circles([[100, 124, 26], [64, 128, 22], [136, 128, 22], [44, 108, 20], [156, 108, 20], [74, 104, 28],
      [126, 104, 28], [100, 96, 32], [58, 80, 22], [142, 80, 22], [82, 66, 28], [118, 66, 28], [100, 44, 24]]),
    colors: ["#2e7d32", "#388e3c", "#256d2a"],
    extras: [[60, 118], [140, 116], [86, 92], [116, 90], [100, 64], [72, 74], [128, 74], [100, 120]]
      .map(([x, y]) => ["polygon", { points: `${x - 3.5},${y + 3} ${x + 3.5},${y + 3} ${x},${y - 4.5}`, fill: "#8d5a2b" }])
  },
  eiche: {
    wood: "#5a4128",
    trunk: "M86 222 C92 202 94 184 92 160 C98 155 102 155 108 160 C106 184 108 202 114 222 Z",
    branchWidth: 7,
    branches: ["M94 164 C84 150 70 146 56 136", "M106 162 C118 150 132 146 146 136",
      "M98 160 C94 140 90 128 86 110", "M102 158 C108 140 114 128 118 112"],
    leaves: circles([[52, 126, 20], [148, 126, 20], [72, 122, 22], [128, 122, 22], [100, 118, 22], [38, 102, 18],
      [162, 102, 18], [62, 98, 24], [138, 98, 24], [100, 92, 28], [56, 74, 16], [144, 74, 16], [78, 72, 24],
      [122, 72, 24], [100, 52, 22]]),
    colors: ["#4f7a28", "#5f8f32", "#456b22"],
    extras: [[56, 134], [144, 132], [80, 108], [120, 106], [100, 128], [66, 86], [134, 84], [96, 70], [112, 60]]
      .flatMap(([cx, cy]) => [
        ["ellipse", { cx, cy, rx: 3.2, ry: 4.4, fill: "#b07a33" }],
        ["ellipse", { cx, cy: cy - 3.4, rx: 3.8, ry: 2.2, fill: "#6b4423" }]
      ])
  },
  mammut: {
    wood: "#8b3f22",
    trunk: "M82 222 C90 210 92 190 94 150 L97 34 L103 34 L106 150 C108 190 110 210 118 222 Z",
    bark: ["M96 216 L97 160", "M104 216 L103 160", "M100 218 L100 170"]
      .map((d) => ["path", { d, fill: "none", stroke: "#6d2f18", "stroke-width": 1.6, "stroke-linecap": "round" }]),
    branches: [],
    leaves: [[84, 150, 15, 10], [116, 152, 15, 10], [104, 138, 11, 8], [80, 120, 16, 11], [120, 122, 16, 11],
      [96, 108, 12, 9], [82, 92, 14, 10], [118, 94, 14, 10], [100, 80, 13, 9], [86, 64, 13, 9], [114, 66, 13, 9],
      [98, 54, 12, 8], [92, 38, 11, 8], [108, 42, 11, 8], [100, 22, 9, 8]]
      .map(([cx, cy, rx, ry]) => ({ cx, cy, rx, ry })),
    colors: ["#2f5d3a", "#3b6e45", "#264d30"],
    extras: []
  }
};

const TREE_MOODS = ["calm", "uneasy", "loud", "withered", "banked", "done", "paused"];

/* ---------- Offenes Ziel: Kirschbaum mit Voegeln ---------- */

/** Ab hier kommen im offenen Modus die Voegel, dann bauen sie ein Nest. */
const FOCUS_BIRDS_FROM = 10 * 60;
const FOCUS_NEST_FROM = 15 * 60;
/** Danach kommt in diesem Abstand ein Vogel dazu: erst Kueken, dann weitere Amseln. */
const FOCUS_MORE_BIRDS_FROM = 20 * 60;
const FOCUS_MORE_BIRDS_EVERY = 5 * 60;

// Koordinaten wie TREE_SHAPES.kirsch; [x, y, Blickrichtung] mit Fuessen bei (x, y).
const BIRD_PERCHES = [[76, 53, 1], [124, 53, -1], [57, 82, 1], [143, 80, -1], [100, 37, 1]];
const BIRD_CHICKS = [[93, 120], [100, 119], [107, 120]];
const BIRD_FLYERS = [[34, 44], [168, 32]];
/** Die ersten zwei Sitzplaetze belegen die Voegel, die zuerst kommen. */
const BIRD_EXTRA = BIRD_CHICKS.length + (BIRD_PERCHES.length - 2) + BIRD_FLYERS.length;

const BIRD_FACTS = {
  birds: "Die Vogelkirsche heißt so, weil Amseln, Drosseln und Stare ihre Früchte lieben. " +
    "Die Kerne lassen sie woanders fallen – so pflanzen Vögel neue Kirschbäume.",
  nest: "Amseln bauen ihr Nest aus Zweigen, Gras und Moos und kleiden es innen mit Lehm aus. " +
    "Meist legt das Weibchen 3 bis 5 Eier.",
  chicks: "Nach etwa zwei Wochen schlüpfen die Küken. Sie sind zuerst nackt und blind, " +
    "und die Eltern fliegen viele Male am Tag mit Futter zum Nest."
};

/** Stufe im offenen Modus: Baumart, Voegel, Nest und zusaetzliche Voegel. */
function openStage(seconds) {
  const extra = seconds < FOCUS_MORE_BIRDS_FROM ? 0
    : Math.min(BIRD_EXTRA, 1 + Math.floor((seconds - FOCUS_MORE_BIRDS_FROM) / FOCUS_MORE_BIRDS_EVERY));
  return {
    species: speciesForGoal(Math.min(seconds, TREE_SPECIES.kirsch.from)),
    birds: seconds >= FOCUS_BIRDS_FROM,
    nest: seconds >= FOCUS_NEST_FROM,
    extra
  };
}

/** Naechster Schritt im offenen Modus, oder null wenn alles erreicht ist. */
function nextOpenStep(seconds) {
  if (seconds < TREE_SPECIES.kirsch.from) return { seconds: TREE_SPECIES.kirsch.from, text: "Kirschbaum" };
  if (seconds < FOCUS_BIRDS_FROM) return { seconds: FOCUS_BIRDS_FROM, text: "Vögel" };
  if (seconds < FOCUS_NEST_FROM) return { seconds: FOCUS_NEST_FROM, text: "Nest" };
  const { extra } = openStage(seconds);
  if (extra >= BIRD_EXTRA) return null;
  return {
    seconds: FOCUS_MORE_BIRDS_FROM + extra * FOCUS_MORE_BIRDS_EVERY,
    text: extra < BIRD_CHICKS.length ? "Küken" : "noch ein Vogel"
  };
}

function birdCount(stage) {
  return stage.birds ? 2 + stage.extra : 0;
}

/** Wer im Baum wohnt, als Satz fuer Steckbrief und Beschriftung. */
function describeBirds(stage) {
  if (!stage.birds) return "";
  if (!stage.nest) return "Zwei Amseln wohnen darin.";
  const chicks = Math.min(stage.extra, BIRD_CHICKS.length);
  const more = stage.extra - chicks;
  const parts = [];
  if (chicks) parts.push(chicks === 1 ? "ein Küken ist geschlüpft" : `${chicks} Küken sind geschlüpft`);
  if (more) parts.push(more === 1 ? "ein weiterer Vogel ist eingezogen" : `${more} weitere Vögel sind eingezogen`);
  return `Zwei Amseln haben darin ein Nest gebaut${parts.length ? `, ${parts.join(" und ")}` : ""}.`;
}

/**
 * Ebenen eines Vogels, jede mit eigener Animation:
 * Position (SVG-Attribut) > .bird (Ankommen) > .bird__mood (Laerm) > .bird__idle (Alltag).
 * timing = Dauer und Versatz des Alltags, damit nicht alle Voegel gleichzeitig picken.
 */
function birdLayers(transform, kind, timing, flight, ...parts) {
  return svg("g", { transform },
    svg("g", { class: `bird bird--${kind}`, style: flight },
      svg("g", { class: "bird__mood" },
        svg("g", { class: "bird__idle", style: timing }, ...parts))));
}

/** Amsel, sitzend; Fuesse bei (0, 0), schaut nach rechts und kommt von hinten angeflogen. */
function perchedBird(x, y, dir, timing) {
  return birdLayers(`translate(${x} ${y}) scale(${1.3 * dir} 1.3)`, "perched", timing, "--fx:-150px;--fy:-90px",
    svg("path", { d: "M-1 0 V-3 M2 0 V-3", stroke: "#d98a2b", "stroke-width": 1, "stroke-linecap": "round" }),
    svg("polygon", { points: "-4,-6 -13,-3 -12,-8", fill: "#1f1f1f" }),
    svg("ellipse", { cx: 0, cy: -6, rx: 6.5, ry: 4.5, fill: "#2a2a2a" }),
    svg("ellipse", { class: "bird__wing", cx: -1.5, cy: -6.8, rx: 4.8, ry: 2.6, fill: "#3d3d3d" }),
    svg("g", { class: "bird__head" },
      svg("circle", { cx: 5, cy: -11, r: 3.6, fill: "#2a2a2a" }),
      svg("polygon", { points: "8,-12.4 12.5,-11 8,-9.8", fill: "#f2a33a" }),
      svg("circle", { cx: 6, cy: -12, r: 1, fill: "#f2a33a" })));
}

/** Kueken im Nest; sperrt ab und zu den Schnabel auf. */
function chick(x, y, timing) {
  return birdLayers(`translate(${x} ${y})`, "chick", timing, "",
    svg("circle", { cx: 0, cy: 0, r: 3.2, fill: "#7d6650" }),
    svg("polygon", { class: "bird__beak", points: "-2,-2 0,-8 2,-2", fill: "#f6d33c" }));
}

function flyingBird(x, y, from, timing) {
  return birdLayers(`translate(${x} ${y})`, "flying", timing, `--fx:${from}px;--fy:-40px`,
    svg("path", { class: "bird__wings", d: "M-9 0 Q-4.5 -6 0 0 Q4.5 -6 9 0", fill: "none", stroke: "#2a2a2a",
      "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
}

/**
 * Haengt Voegel und Nest an einen Kirschbaum aus buildTree. Sitzende Voegel
 * und Nest schwingen mit dem Baum, fliegende nicht. set(stage) aus openStage.
 * seed: fester Zufall pro Baum, damit jeder Vogel seinen eigenen Takt hat.
 */
function attachBirds(treeEl, seed = "") {
  let n = 0;
  const timing = () => {
    n += 1;
    const t = 7 + hashUnit(seed, 10 + n) * 8;
    return `--t:${t.toFixed(1)}s;--delay:${(-hashUnit(seed, 40 + n) * t).toFixed(1)}s`;
  };
  const nestBack = svg("ellipse", { cx: 100, cy: 124, rx: 13, ry: 3.4, fill: "#3f2a1a" });
  const chicks = BIRD_CHICKS.map(([x, y]) => chick(x, y, timing()));
  const nestFront = svg("g", {},
    svg("path", { d: "M85 123 Q100 141 115 123 Z", fill: "#7a5230" }),
    svg("path", { d: "M87 126 L111 129 M89 131 L113 126 M93 134 L108 132", fill: "none", stroke: "#a57846",
      "stroke-width": 1.2, "stroke-linecap": "round" }));
  const nest = svg("g", { class: "bird bird--nest" }, nestBack, chicks, nestFront);
  const perched = BIRD_PERCHES.map(([x, y, dir]) => perchedBird(x, y, dir, timing()));
  const flyers = BIRD_FLYERS.map(([x, y]) => flyingBird(x, y, x < 100 ? -120 : 120, timing()));

  treeEl.querySelector(".tree__motion").append(nest, ...perched);
  treeEl.append(...flyers);

  const on = (g, value) => g.firstChild.classList.toggle("is-on", value);
  return function set(stage) {
    // Reihenfolge der Neuankoemmlinge: Kueken, weitere Amseln, dann fliegende.
    const extraPerched = Math.max(0, stage.extra - chicks.length);
    nest.classList.toggle("is-on", stage.nest);
    chicks.forEach((c, i) => on(c, stage.nest && i < stage.extra));
    perched.forEach((p, i) => on(p, stage.birds && i < 2 + extraPerched));
    flyers.forEach((f, i) => on(f, i < extraPerched - (perched.length - 2)));
  };
}

/**
 * Baut einen Baum, der ueber setProgress(0..1) waechst.
 * still = statische Variante fuer Wald und Symbole (ohne Keimling/Animation).
 */
function buildTree(speciesKey, { still = false } = {}) {
  const shape = TREE_SHAPES[speciesKey] || TREE_SHAPES[TREE_ORDER[0]];

  const leafEls = shape.leaves.map((leaf, i) => {
    const attrs = { class: "leaf", fill: shape.colors[i % shape.colors.length], style: `--i:${i}` };
    if (leaf.points) return svg("polygon", { ...attrs, points: leaf.points });
    if (leaf.rx) return svg("ellipse", { ...attrs, cx: leaf.cx, cy: leaf.cy, rx: leaf.rx, ry: leaf.ry });
    return svg("circle", { ...attrs, cx: leaf.cx, cy: leaf.cy, r: leaf.r });
  });
  const extraEls = shape.extras.map(([tag, attrs], i) =>
    svg(tag, { ...attrs, class: "leaf leaf--extra", style: `--i:${i + leafEls.length}` }));

  const scaleEl = svg("g", { class: "tree__scale" },
    svg("g", { class: "tree__motion" },
      svg("path", { d: shape.trunk, fill: shape.trunkFill ?? shape.wood }),
      (shape.bark ?? []).map(([tag, attrs]) => svg(tag, attrs)),
      shape.branches.map((d) => svg("path", {
        d, fill: "none", stroke: shape.wood, "stroke-width": shape.branchWidth ?? 5, "stroke-linecap": "round"
      })),
      leafEls,
      extraEls));

  const sproutEl = still ? null : svg("g", { class: "tree__sprout" },
    svg("path", { d: "M100 216 C100 210 100 206 101 200", fill: "none", stroke: "#4d9a45", "stroke-width": 3, "stroke-linecap": "round" }),
    svg("ellipse", { cx: 93, cy: 200, rx: 8, ry: 4, fill: "#5cb85c", transform: "rotate(-28 93 200)" }),
    svg("ellipse", { cx: 108, cy: 198, rx: 8, ry: 4, fill: "#6fcf6f", transform: "rotate(24 108 198)" }));

  const el = svg("svg", {
    class: `tree${still ? " tree--still" : ""}`, viewBox: "0 0 200 240",
    "aria-hidden": "true", focusable: "false"
  },
    still ? svg("ellipse", { class: "tree__shadow", cx: 100, cy: 223, rx: 46, ry: 5 }) : null,
    sproutEl,
    scaleEl,
    // Der Erdhuegel liegt vor dem Stammfuss.
    still ? null : svg("path", { class: "tree__soil", d: "M48 226 Q100 202 152 226 Z" }));

  function setProgress(value, { instant = false } = {}) {
    const p = Math.min(1, Math.max(0, value));
    if (instant) el.classList.add("tree--instant");

    // Erst Keimling, dann waechst der Baum; ease-out macht fruehen Fortschritt sichtbar.
    const grow = Math.min(1, Math.max(0, (p - 0.08) / 0.92));
    const scale = 0.22 + 0.78 * (1 - (1 - grow) ** 2);
    scaleEl.style.transform = `scale(${scale.toFixed(3)})`;
    scaleEl.style.opacity = p >= 0.08 ? "1" : "0";
    if (sproutEl) sproutEl.style.opacity = p < 0.08 ? "1" : "0";
    leafEls.forEach((leaf, i) => leaf.classList.toggle("is-on", p >= 0.18 + (0.72 * i) / leafEls.length));
    extraEls.forEach((b, i) => b.classList.toggle("is-on", p >= 0.9 + (0.1 * i) / extraEls.length));

    if (instant) {
      el.getBoundingClientRect();   // Styles ohne Transition uebernehmen
      requestAnimationFrame(() => el.classList.remove("tree--instant"));
    }
  }

  function setMood(mood) {
    for (const m of TREE_MOODS) el.classList.toggle(`tree--${m}`, m === mood);
  }

  return { el, setProgress, setMood };
}

/** stage: Voegel aus openStage (offenes Ziel), seed: ihr fester Takt. */
function stillTree(speciesKey, heightRem, label, { stage = null, seed = "" } = {}) {
  const tree = buildTree(speciesKey, { still: true });
  tree.setProgress(1);
  if (stage?.birds) attachBirds(tree.el, seed)(stage);
  tree.el.style.height = `${heightRem.toFixed(2)}rem`;
  tree.el.style.width = `${(heightRem * 200 / 240).toFixed(2)}rem`;
  if (label) tree.el.append(svg("title", {}, label));
  return tree.el;
}

/** Art eines gepflanzten Baums: offene Ziele ergeben Birke oder Kirschbaum. */
function treeSpecies(tree) {
  return tree.open_goal ? openStage(tree.goal_seconds).species : speciesForGoal(tree.goal_seconds);
}

/** Voegel eines gepflanzten Baums, oder null bei festen Zielen. */
function treeStage(tree) {
  return tree.open_goal ? openStage(tree.goal_seconds) : null;
}

function treeLabel(tree, sep = " · ") {
  const stage = treeStage(tree);
  const count = stage ? birdCount(stage) : 0;
  return [TREE_SPECIES[treeSpecies(tree)].name + (count ? ` mit ${count} Vögeln` : ""),
    `${Math.round(tree.goal_seconds / 60)} min`, formatDate(tree.created_at)].join(sep);
}

/** Steckbrief zu einem angetippten Baum im Wald. */
function plantedTreeCard(tree, options = {}) {
  const stage = treeStage(tree);
  return treeFactCard(treeSpecies(tree), {
    ...options,
    stage,
    seed: tree.id,
    note: `Gepflanzt am ${formatDate(tree.created_at)} nach ${Math.round(tree.goal_seconds / 60)} Minuten Ruhe.` +
      (stage?.birds ? ` ${describeBirds(stage)}` : "")
  });
}

/** Wald einer Klasse; groessere Ziele ergeben groessere Baeume. */
function forestView(trees, { limit = Infinity, scale = 1 } = {}) {
  const sorted = [...trees]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-limit);
  return h("div", { class: "forest", role: "img", "aria-label": treesLabel(trees.length) },
    sorted.map((tree) => {
      const height = (2.4 + Math.min(1, tree.goal_seconds / 2700) * 2.2) * scale;
      return stillTree(treeSpecies(tree), height, treeLabel(tree), { stage: treeStage(tree), seed: tree.id });
    }));
}

/* ---------- Baum-Steckbriefe ---------- */

/** Steckbrief zum Lernen: Bild, Name, Eckdaten und ein Fakt zur Art. */
function treeFactCard(speciesKey, { note = null, kicker = "Wusstest du?", stage = null, seed = "" } = {}) {
  const sp = TREE_SPECIES[speciesKey];
  return h("article", { class: "treefact" },
    h("div", { class: "treefact__pic" }, stillTree(speciesKey, 6, null, { stage, seed })),
    h("div", { class: "treefact__body" },
      h("p", { class: "treefact__kicker" }, kicker),
      h("h3", {}, sp.full, h("span", { class: "treefact__latin" }, sp.latin)),
      h("ul", { class: "treefact__chips" },
        h("li", {}, `Höhe ${sp.height}`),
        h("li", {}, `Alter ${sp.age}`),
        h("li", {}, `wächst ${sp.growth}`)),
      h("p", { class: "treefact__text" }, sp.fact),
      note ? h("p", { class: "treefact__note" }, note) : null));
}

/** Stufen des offenen Ziels: Birke, Kirschbaum, Voegel, Nest, mehr Voegel. */
function openLadder() {
  const step = (seconds, label, from) => {
    const stage = openStage(seconds);
    return h("li", {}, stillTree(stage.species, 3.2, null, { stage, seed: label }), h("strong", {}, label), h("span", {}, `ab ${from} min`));
  };
  return h("ol", { class: "ladder" },
    step(FOCUS_OPEN_GROWN_SECONDS, "Birke", FOCUS_GOALS_MIN[0]),
    step(TREE_SPECIES.kirsch.from, "Kirschbaum", TREE_SPECIES.kirsch.from / 60),
    step(FOCUS_BIRDS_FROM, "Vögel", FOCUS_BIRDS_FROM / 60),
    step(FOCUS_NEST_FROM, "Nest", FOCUS_NEST_FROM / 60),
    step(FOCUS_OPEN_MAX_SECONDS, "Mehr Vögel", FOCUS_MORE_BIRDS_FROM / 60));
}

/* ---------- Waelder: Hain-Layout und Rundgang ---------- */

/** Hoehe einer Birke im Wald (px); seltenere Arten werden groesser. */
const GROVE_BASE_PX = 46;

function treeHeightPx(seconds, base) {
  return base * (1 + TREE_ORDER.indexOf(speciesForGoal(seconds)) * 0.32);
}

/** Fester Pseudozufall pro Baum, damit der Wald bei jedem Aufbau gleich aussieht. */
function hashUnit(text, salt = 0) {
  let x = 2166136261 ^ salt;
  for (const ch of String(text)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  return ((x >>> 0) % 10007) / 10007;
}

/**
 * Ordnet die Baeume einer Klasse als Hain an: Reihen von hinten nach vorn,
 * die groessten (am laengsten erarbeiteten) Baeume hinten, die kleinen vorn.
 * In jeder Reihe stehen die besten in der Mitte, die leichter erreichten
 * aussen. Liefert Pixelpositionen relativ zur linken oberen Ecke.
 */
function groveLayout(trees, base) {
  const items = [...trees]
    .sort((a, b) => b.goal_seconds - a.goal_seconds || String(a.created_at).localeCompare(String(b.created_at)))
    .map((tree) => {
      const hgt = treeHeightPx(tree.goal_seconds, base);
      return { tree, h: hgt, w: hgt * 200 / 240, step: hgt * 200 / 240 * 0.58 };
    });

  // Vordere Reihen sind breiter – der Hain oeffnet sich zum Betrachter hin.
  const rowWidth = Math.max(base * 3, Math.sqrt(items.length) * base * 1.4);
  const rows = [];
  let row = [];
  let width = 0;
  for (const item of items) {
    if (row.length && width + item.step > rowWidth * (1 + rows.length * 0.2)) {
      rows.push(row);
      row = [];
      width = 0;
    }
    row.push(item);
    width += item.step;
  }
  if (row.length) rows.push(row);

  const placed = [];
  rows.forEach((list, k) => {
    // Mitte-aussen-Reihenfolge: bester Baum in die Mitte, dann abwechselnd rechts und links.
    const ordered = [];
    list.forEach((item, i) => (i % 2 ? ordered.push(item) : ordered.unshift(item)));
    const total = ordered.reduce((sum, item) => sum + item.step, 0);
    let cursor = -total / 2;
    for (const item of ordered) {
      const id = item.tree.id ?? item.tree.created_at;
      placed.push({
        ...item,
        x: cursor + item.step / 2 + (hashUnit(id, 1) - 0.5) * base * 0.2,
        y: k * base * 0.42 + (hashUnit(id, 2) - 0.5) * base * 0.12,
        z: k
      });
      cursor += item.step;
    }
  });

  const left = Math.min(...placed.map((p) => p.x - p.w / 2));
  const right = Math.max(...placed.map((p) => p.x + p.w / 2));
  const top = Math.min(...placed.map((p) => p.y - p.h));
  const bottom = Math.max(...placed.map((p) => p.y));
  return {
    width: right - left,
    height: bottom - top,
    items: placed.map((p) => ({ ...p, left: p.x - p.w / 2 - left, top: p.y - p.h - top }))
  };
}

/** Wald einer Klasse als Hain mit Schild; Baeume sind antippbar (onPick). */
function groveView(cls, { base = GROVE_BASE_PX, rank = null, onPick = null } = {}) {
  const trees = cls.focus_trees || [];
  const stats = forestStats(cls);
  let plot;
  if (trees.length) {
    const layout = groveLayout(trees, base);
    plot = h("div", { class: "grove__plot", style: `width:${layout.width.toFixed(0)}px;height:${layout.height.toFixed(0)}px` },
      layout.items.map((item) => {
        const label = treeLabel(item.tree, ", ");
        const tree = buildTree(treeSpecies(item.tree), { still: true });
        tree.setProgress(1);
        const stage = treeStage(item.tree);
        if (stage?.birds) attachBirds(tree.el, item.tree.id)(stage);
        const btn = h("button", {
          class: "grove__tree", type: "button", "aria-label": label, title: label,
          style: `left:${item.left.toFixed(1)}px;top:${item.top.toFixed(1)}px;` +
            `width:${item.w.toFixed(1)}px;height:${item.h.toFixed(1)}px;z-index:${item.z + 1}`
        }, tree.el);
        if (onPick) btn.addEventListener("click", () => onPick(item.tree, cls, btn));
        return btn;
      }));
  } else {
    const sprout = buildTree(TREE_ORDER[0]);
    sprout.setProgress(0, { instant: true });
    plot = h("div", { class: "grove__empty" }, sprout.el, h("span", {}, "Noch keine Bäume"));
  }
  return h("section", { class: "grove", dataset: { classId: cls.id }, "aria-label": `Wald von ${cls.name}` },
    h("div", { class: "grove__sign" },
      h("strong", {}, rank ? `${rank}. ${cls.name}` : cls.name),
      h("span", {}, `${treesLabel(stats.count)} · ${stats.minutes} min`)),
    plot);
}

/**
 * Landschaft mit den Hainen nebeneinander. Auf Touch-Geraeten wird nativ
 * gewischt, mit der Maus laesst sich die Landschaft ziehen.
 */
function forestLandscape(groves, { compact = false } = {}) {
  const track = h("div", { class: "landscape__track" }, groves);
  const scroller = h("div", {
    class: `landscape${compact ? " landscape--compact" : ""}`, tabindex: "0",
    role: "region", "aria-label": "Wälder – zum Erkunden zur Seite ziehen oder mit den Pfeiltasten scrollen"
  }, track);

  let drag = null;
  let suppressClick = false;
  // Klick nach dem Ziehen nicht als Baum-Auswahl werten.
  scroller.addEventListener("click", (event) => {
    if (suppressClick) { event.stopPropagation(); event.preventDefault(); }
  }, { capture: true });
  scroller.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    drag = { x: event.clientX, left: scroller.scrollLeft, moved: false };
  });
  scroller.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 5) return;
    if (!drag.moved) { drag.moved = true; scroller.setPointerCapture(event.pointerId); scroller.classList.add("is-dragging"); }
    scroller.scrollLeft = drag.left - dx;
  });
  const endDrag = (event) => {
    if (!drag) return;
    if (drag.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    drag = null;
    scroller.classList.remove("is-dragging");
    if (scroller.hasPointerCapture?.(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
  };
  scroller.addEventListener("pointerup", endDrag);
  scroller.addEventListener("pointercancel", endDrag);
  return scroller;
}

/** Scrollt die Landschaft so, dass der Hain mittig steht. */
function centerGrove(scroller, grove, smooth = true) {
  const target = grove.offsetLeft + grove.offsetWidth / 2 - scroller.clientWidth / 2;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollTo({ left: Math.max(0, target), behavior: smooth && !reduce ? "smooth" : "auto" });
}

function progressBar(fraction) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return h("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) },
    h("div", { class: "progress__fill", style: `width:${pct}%` }));
}

/* ---------- Auswertung ---------- */

function forestStats(cls) {
  const trees = cls.focus_trees || [];
  const seconds = trees.reduce((sum, t) => sum + (Number(t.goal_seconds) || 0), 0);
  return { count: trees.length, minutes: Math.round(seconds / 60) };
}

/** Ranking nach Fokus-Minuten; gleiche Minuten teilen sich den Platz. */
function focusRanking(classes) {
  const entries = classes.map((cls) => ({ cls, ...forestStats(cls) }));
  for (const entry of entries) {
    entry.rank = 1 + entries.filter((other) => other.minutes > entry.minutes).length;
  }
  return entries.sort((a, b) =>
    a.rank - b.rank || b.count - a.count || a.cls.name.localeCompare(b.cls.name, "de"));
}

/** Fortschritt zur Belohnung; gezaehlt wird ab focus_reward_offset. */
function rewardProgress(cls) {
  if (!cls?.focus_reward || !cls.focus_reward_goal) return null;
  const earned = Math.max(0, (cls.focus_trees?.length ?? 0) - (cls.focus_reward_offset ?? 0));
  return {
    text: cls.focus_reward,
    goal: cls.focus_reward_goal,
    done: Math.min(earned, cls.focus_reward_goal),
    reached: earned >= cls.focus_reward_goal
  };
}

/* ---------- Mikrofon ---------- */

function micErrorMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Der Mikrofonzugriff wurde verweigert. Bitte im Browser für diese Seite erlauben.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Es wurde kein Mikrofon gefunden.";
    case "NotReadableError":
      return "Das Mikrofon wird gerade von einem anderen Programm benutzt.";
    default:
      return error?.message || "Das Mikrofon konnte nicht gestartet werden.";
  }
}

/**
 * Pegelmessung per Web Audio. Kalibrierung wie bei Mio: RMS ueber das
 * Byte-Spektrum (fftSize 256), mal Empfindlichkeit, gekappt auf 0–100.
 */
function createNoiseMeter() {
  let ctx = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let data = null;
  let smoothed = 0;
  let lastAt = 0;

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Mikrofonzugriff ist hier nicht möglich (HTTPS erforderlich).");
    }
    // Noch synchron im Klick-Handler anlegen, sonst startet er "suspended".
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    ctx = new AudioCtx();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      throw new Error(micErrorMessage(error));
    }
    if (ctx.state === "suspended") await ctx.resume();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    // Wird pro Abruf angewandt; bei 20 Hz entspricht 0.85 etwa Mios 0.95 bei 60 fps.
    analyser.smoothingTimeConstant = 0.85;
    source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    data = new Uint8Array(analyser.frequencyBinCount);
  }

  /** Aktueller, leicht geglaetteter Pegel 0–100. */
  function read(sensitivity) {
    if (!analyser) return 0;
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    const rms = (Math.sqrt(sum / data.length) / 255) * 100;
    const gain = sensitivity < 1 ? sensitivity * sensitivity : sensitivity;
    const level = Math.min(100, rms * gain);

    const now = performance.now();
    const dt = lastAt ? (now - lastAt) / 1000 : FOCUS_TICK_MS / 1000;
    lastAt = now;
    smoothed += (level - smoothed) * (1 - Math.exp(-dt / 0.2));
    return smoothed;
  }

  function stop() {
    source?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
    ctx = stream = source = analyser = null;
  }

  return { start, read, stop };
}

/* ---------- Ansicht: Fokus-Wald Uebersicht ---------- */

function renderFocusSchemaHint() {
  appEl.replaceChildren(
    h("div", { class: "card stack" },
      h("h2", {}, "Datenbank-Update fehlt"),
      h("p", { class: "muted" },
        "Für den Fokus-Wald muss einmalig die Migration supabase/migrations/0003_focus.sql " +
        "im Supabase SQL-Editor ausgeführt werden."),
      h("button", { class: "btn", onclick: () => navigate(`/focus/${FOCUS_PROBE}`) },
        "Probelauf ohne Speichern"))
  );
}

async function renderFocusHome() {
  appEl.className = "app";
  setChrome({ title: "Fokus-Wald", section: "wald" });
  appEl.replaceChildren(loadingView());

  let classes;
  try {
    classes = await api.listFocusClasses();
  } catch (error) {
    if (isMissingFocusSchema(error)) return renderFocusSchemaHint();
    throw error;
  }

  const ranking = focusRanking(classes);
  const list = ranking.length
    ? h("ol", { class: "list" }, ranking.map((entry) =>
        h("li", { class: "list__item" },
          h("span", { class: "rank", "aria-label": `Platz ${entry.rank}` }, String(entry.rank)),
          h("button", { class: "list__main", onclick: () => navigate(`/focus/${entry.cls.id}`) },
            entry.cls.name,
            h("span", { class: "list__sub" },
              `${treesLabel(entry.count)} · ${entry.minutes} Fokus-Minuten`)),
          nowBadge(entry.cls.id))))
    : emptyView(state.guest
        ? "Noch keine Klasse. Lege unten eine an."
        : "Noch keine Klassen. Lege zuerst unter „Klassen“ eine an.");

  // Klasse der aktuellen Stunde direkt anbieten; das Ranking bleibt unveraendert.
  const current = currentLesson();
  const nowCard = current && classes.some((c) => c.id === current.classId)
    ? h("section", { class: "card now-card now-card--inline" },
        h("div", {},
          h("p", { class: "now-card__kicker" },
            h("span", { class: "now-pill__dot", "aria-hidden": "true" }),
            `Jetzt · ${current.label} · bis ${formatTime(current.to)}`),
          h("h2", {}, current.name)),
        h("button", { class: "btn btn--primary", type: "button", onclick: () => navigate(`/focus/${current.classId}`) },
          "Fokus-Phase vorbereiten"))
    : null;

  appEl.replaceChildren(
    pageHead({
      eyebrow: "Lautstärke-Monitor",
      title: "Fokus-Wald",
      lead: "Für Stillarbeit auf dem Beamer: Solange es ruhig ist, wächst ein Baum, wird es zu laut, vertrocknet er. " +
        "Jeder fertige Baum wird im Wald der Klasse gepflanzt – Klassen sammeln Bäume, vergleichen sich im Ranking " +
        "und arbeiten auf eine selbst gewählte Belohnung hin.",
      actions: [
        h("button", { class: "btn", onclick: () => navigate(`/focus/${FOCUS_PROBE}`) }, "Probelauf ohne Klasse"),
        h("button", { class: "btn btn--primary", onclick: () => navigate(`/focus/${FOCUS_WALK}`) },
          icon("wandern"), "Alle Wälder erkunden")
      ]
    }),
    h("div", { class: "stack" },
      nowCard,
      h("div", { class: "card" },
        h("h2", {}, "Klassen-Ranking"),
        h("p", { class: "muted small" }, "Klasse anklicken, um ihren Wald zu sehen und eine Fokus-Phase zu starten."),
        list),
      state.guest ? guestClassesCard(classes) : null)
  );
}

/* ---------- Ansicht: Alle Waelder ---------- */

async function renderForestWalk() {
  appEl.className = "app app--wide";
  setChrome({ title: "Alle Wälder", back: "/focus", section: "wald" });
  appEl.replaceChildren(loadingView());

  let classes;
  try {
    classes = await api.listFocusClasses();
  } catch (error) {
    if (isMissingFocusSchema(error)) return renderFocusSchemaHint();
    throw error;
  }

  const ranking = focusRanking(classes);
  const infoEl = h("div", { class: "walk__info" });
  let selected = null;

  function pick(tree, cls, btn) {
    selected?.classList.remove("is-selected");
    selected = btn;
    btn.classList.add("is-selected");
    infoEl.replaceChildren(plantedTreeCard(tree, { kicker: `Wald von ${cls.name}` }));
  }

  // Auf grossen Bildschirmen (Beamer) duerfen die Baeume groesser sein.
  const base = window.innerWidth >= 1024 ? 62 : 52;
  const groves = ranking.map((entry) => groveView(entry.cls, { base, rank: entry.rank, onPick: pick }));
  const landscape = forestLandscape(groves);

  // Sprungmarken zu den Klassen und Vor/Zurueck-Pfeile
  const current = () => {
    const mid = landscape.scrollLeft + landscape.clientWidth / 2;
    let best = 0;
    groves.forEach((g, i) => {
      if (Math.abs(g.offsetLeft + g.offsetWidth / 2 - mid) <
          Math.abs(groves[best].offsetLeft + groves[best].offsetWidth / 2 - mid)) best = i;
    });
    return best;
  };
  const go = (i) => centerGrove(landscape, groves[Math.min(groves.length - 1, Math.max(0, i))]);
  const chips = ranking.map((entry, i) =>
    h("button", { class: "chip", type: "button", onclick: () => go(i) }, entry.cls.name));
  const markCurrent = () => {
    const i = current();
    chips.forEach((chip, j) => chip.setAttribute("aria-current", String(i === j)));
  };
  landscape.addEventListener("scroll", () => requestAnimationFrame(markCurrent), { passive: true });

  const totalTrees = classes.reduce((sum, c) => sum + (c.focus_trees?.length ?? 0), 0);
  const counts = Object.fromEntries(TREE_ORDER.map((key) => [key, 0]));
  for (const c of classes) for (const t of c.focus_trees ?? []) counts[treeSpecies(t)]++;

  infoEl.append(h("p", { class: "walk__hint" },
    "Klicke einen Baum an, um seinen Steckbrief zu sehen."));

  appEl.replaceChildren(
    h("div", { class: "walk" },
      pageHead({
        eyebrow: `${treesLabel(totalTrees)} in ${classes.length} ${classes.length === 1 ? "Wald" : "Wäldern"}`,
        title: "Alle Wälder",
        lead: "Jede Klasse hat ihren eigenen Wald. Die größten, am längsten erarbeiteten Bäume stehen hinten in der Mitte, " +
          "die schnell gewachsenen vorne am Rand. Ziehe die Landschaft zur Seite oder nutze die Pfeile, um durch die Wälder zu gehen."
      }),
      ranking.length
        ? h("div", { class: "walk__nav" },
            h("button", { class: "btn btn--icon", type: "button", "aria-label": "Vorheriger Wald", onclick: () => go(current() - 1) }, "\u2190"),
            h("div", { class: "chips" }, chips),
            h("button", { class: "btn btn--icon", type: "button", "aria-label": "Nächster Wald", onclick: () => go(current() + 1) }, "\u2192"))
        : null,
      ranking.length ? landscape : emptyView(state.guest
        ? "Noch keine Klasse. Lege im Fokus-Wald eine an."
        : "Noch keine Klassen. Lege zuerst unter „Klassen“ eine an."),
      infoEl,
      h("section", { class: "lexicon" },
        h("h2", {}, "Baum-Lexikon"),
        h("p", { class: "muted" },
          "Wie in einem echten Wald kommen zuerst die schnell wachsenden Pionierbäume, zuletzt die langsamen Riesen. " +
          "Je länger eure Klasse ruhig arbeitet, desto seltener der Baum."),
        h("div", { class: "lexicon__grid" }, TREE_ORDER.map((key) =>
          treeFactCard(key, {
            kicker: `Ziel ab ${Math.max(FOCUS_GOALS_MIN[0], TREE_SPECIES[key].from / 60)} min · ${counts[key]}× gepflanzt`
          })))))
  );

  // Mit dem bestplatzierten Wald beginnen.
  if (groves.length) {
    requestAnimationFrame(() => { go(0); markCurrent(); });
  }
}

/* ---------- Ansicht: Fokus-Wald einer Klasse ---------- */

async function renderFocusRoom(classId) {
  appEl.className = "app";
  setChrome({ title: "Fokus-Wald", back: "/focus", section: "wald" });
  appEl.replaceChildren(loadingView());

  // Wird beim Verlassen der Ansicht gesetzt – z. B. waehrend der
  // Mikrofon-Abfrage des Browsers.
  let disposed = false;
  registerCleanup(() => { disposed = true; });

  const probe = classId === FOCUS_PROBE;
  let classes = [];
  let cls = null;
  if (!probe) {
    try {
      classes = await api.listFocusClasses();
    } catch (error) {
      if (isMissingFocusSchema(error)) return renderFocusSchemaHint();
      throw error;
    }
    cls = classes.find((c) => c.id === classId) ?? null;
    if (!cls) { toast("Klasse nicht gefunden.", "error"); return navigate("/focus"); }
    cls.focus_trees ??= [];
  }

  let goalMinutes = readPref(PREF_FOCUS_GOAL, 10);
  if (!FOCUS_GOALS_MIN.includes(goalMinutes) && goalMinutes !== FOCUS_OPEN) goalMinutes = 10;

  showSetup();

  /* ----- Vorbereitung (Lehrkraft) ----- */

  function showSetup() {
    appEl.className = "app";
    setChrome({ title: probe ? "Fokus-Wald: Probelauf" : `Fokus-Wald: ${cls.name}`, back: "/focus", section: "wald" });

    // Steckbrief zum gewaehlten Ziel: zum Vorlesen vor der Stillarbeit.
    const factEl = h("div", { class: "goal-fact", "aria-live": "polite" });
    const showFact = () => factEl.replaceChildren(goalMinutes === FOCUS_OPEN
      ? h("div", {},
          h("p", { class: "treefact__kicker" }, "Offenes Ziel"),
          h("p", { class: "muted small" }, "Der Timer zählt hoch: Erst wächst eine Birke, dann ein Kirschbaum. " +
            "Bleibt es weiter ruhig, kommen Vögel, bauen ein Nest und werden immer mehr."),
          openLadder())
      : treeFactCard(speciesForGoal(goalMinutes * 60), { kicker: `Bei ${goalMinutes} min wächst …` }));

    const goalButtons = [...FOCUS_GOALS_MIN, FOCUS_OPEN].map((minutes) => {
      const open = minutes === FOCUS_OPEN;
      const species = speciesForGoal(open ? 0 : minutes * 60);
      const btn = h("button", { class: "goal", type: "button", "aria-pressed": String(minutes === goalMinutes) },
        stillTree(species, 3),
        h("span", { class: "goal__min" }, open ? "Offen" : `${minutes} min`),
        h("span", { class: "goal__species" }, open ? "zählt hoch" : TREE_SPECIES[species].name));
      btn.addEventListener("click", () => {
        goalMinutes = minutes;
        writePref(PREF_FOCUS_GOAL, minutes);
        for (const other of goalButtons) other.setAttribute("aria-pressed", String(other === btn));
        showFact();
      });
      return btn;
    });
    showFact();

    const startBtn = h("button", { class: "btn btn--primary btn--lg", type: "button" }, "Mikrofon an und los");
    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      const noise = createNoiseMeter();
      try {
        await noise.start();
      } catch (error) {
        noise.stop();
        startBtn.disabled = false;
        return showError(error, "Das Mikrofon konnte nicht gestartet werden.");
      }
      if (disposed) { noise.stop(); return; }
      runSession(noise, goalMinutes === FOCUS_OPEN ? null : goalMinutes * 60);
    });

    const startCard = h("div", { class: "card" },
      h("h2", {}, "Ziel wählen"),
      h("p", { class: "muted small" },
        "So lange muss es insgesamt ruhig sein, bis der Baum ausgewachsen ist. " +
        "Wie im echten Wald: Kurze Ziele lassen schnell wachsende Pionierbäume wachsen, lange Ziele die langsamen Waldriesen. " +
        "„Offen“ zählt hoch: Birke, Kirschbaum, dann ziehen Vögel ein – " +
        `gepflanzt wird mit „Baum pflanzen“ (ab ${FOCUS_GOALS_MIN[0]} min).`),
      h("div", { class: "goals" }, goalButtons),
      factEl,
      startBtn,
      h("p", { class: "muted small" },
        "Das Mikrofon misst nur die Lautstärke – direkt im Browser. " +
        "Es wird nichts aufgenommen, gespeichert oder übertragen." +
        (probe ? " Im Probelauf wird auch kein Baum gespeichert." : "")),
      h("details", { class: "small muted" },
        h("summary", {}, "So funktioniert es"),
        h("ul", { class: "rules" },
          h("li", {}, "Grün (ruhig): Der Timer läuft, der Baum wächst."),
          h("li", {}, "Gelb (unruhig): Der Timer pausiert."),
          h("li", {}, "Rot (länger als ca. 1,5 s zu laut): Der Baum vertrocknet, es beginnt ein neuer Samen. " +
            `Bei „Offen“ wird ab ${FOCUS_GOALS_MIN[0]} min stattdessen die erreichte Stufe gepflanzt.`),
          h("li", {}, "Beim Erklären auf „Pause“ tippen oder die Leertaste drücken – sonst zählt die eigene Stimme mit."),
          h("li", {}, "Mit dem Regler „Empfindlichkeit“ an Raum und Mikrofon anpassen; der Probelauf eignet sich zum Einstellen."))));

    if (probe) {
      appEl.replaceChildren(pageHead({ eyebrow: "Fokus-Wald", title: "Probelauf" }), h("div", { class: "stack" }, startCard));
      return;
    }

    const stats = forestStats(cls);
    const rank = 1 + classes.filter((c) => c.id !== cls.id && forestStats(c).minutes > stats.minutes).length;
    const reward = rewardProgress(cls);

    const forestInfo = h("div", { class: "walk__info" });
    let picked = null;
    const forestCard = h("div", { class: "card" },
      h("h2", {}, `Wald von ${cls.name}`),
      h("div", { class: "stats__grid" },
        h("div", { class: "stat" },
          h("div", { class: "stat__label" }, "Bäume"),
          h("div", { class: "stat__value" }, String(stats.count))),
        h("div", { class: "stat" },
          h("div", { class: "stat__label" }, "Fokus-Minuten"),
          h("div", { class: "stat__value" }, String(stats.minutes))),
        h("div", { class: "stat" },
          h("div", { class: "stat__label" }, "Ranking"),
          h("div", { class: "stat__value" }, `Platz ${rank}`),
          h("div", { class: "stat__label" }, `von ${classes.length} ${classes.length === 1 ? "Klasse" : "Klassen"}`))),
      reward ? rewardView(reward) : null,
      stats.count
        ? forestLandscape([groveView(cls, {
            onPick: (tree, _cls, btn) => {
              picked?.classList.remove("is-selected");
              picked = btn;
              btn.classList.add("is-selected");
              forestInfo.replaceChildren(plantedTreeCard(tree));
            }
          })], { compact: true })
        : emptyView("Noch keine Bäume. Der erste wächst bei der nächsten ruhigen Arbeitsphase."),
      forestInfo);

    appEl.replaceChildren(
      pageHead({
        eyebrow: "Fokus-Wald",
        title: cls.name,
        actions: [h("button", { class: "btn", onclick: () => navigate(`/focus/${FOCUS_WALK}`) }, icon("wandern"), "Alle Wälder")]
      }),
      classTabs(cls.id, "wald"),
      h("div", { class: "stack" }, forestCard, startCard, rewardCard()));
  }

  function rewardView(reward) {
    return h("div", { class: "reward" },
      h("div", { class: "reward__head" },
        h("strong", {}, reward.reached ? "Belohnung erreicht!" : "Belohnung"),
        h("span", { class: "muted small" }, `${reward.done} / ${treesLabel(reward.goal)}`)),
      h("div", {}, reward.text),
      progressBar(reward.done / reward.goal),
      reward.reached
        ? h("button", {
            class: "btn btn--sm", type: "button",
            onclick: () => confirmDelete(
              "Belohnung als eingelöst markieren? Der Fortschritt beginnt dann wieder bei 0.",
              async () => {
                const offset = cls.focus_trees.length;
                await api.updateFocusReward(cls.id, { focus_reward_offset: offset });
                cls.focus_reward_offset = offset;
                showSetup();
                toast("Belohnung eingelöst.");
              },
              "Eingelöst")
          }, "Als eingelöst markieren")
        : null);
  }

  function rewardCard() {
    const textInput = h("input", {
      class: "input", type: "text", maxlength: "120",
      placeholder: "z. B. Musik in der Stillarbeit", value: cls.focus_reward ?? ""
    });
    const goalInput = h("input", {
      class: "input", type: "number", min: "1", max: "500", step: "1", inputmode: "numeric",
      value: String(cls.focus_reward_goal ?? 10)
    });
    const saveBtn = h("button", { class: "btn btn--primary", type: "submit" }, "Speichern");

    const form = h("form", { class: "reward-form" },
      h("label", { class: "field" }, h("span", { class: "field__label" }, "Belohnung"), textInput),
      h("label", { class: "field field--num" }, h("span", { class: "field__label" }, "bei Bäumen"), goalInput),
      saveBtn);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = cleanName(textInput.value, 120);
      const goal = Math.round(Number(goalInput.value));
      if (text && !(goal >= 1 && goal <= 500)) {
        return toast("Bitte eine Anzahl zwischen 1 und 500 eingeben.", "error");
      }

      // Eine neue Belohnung zaehlt erst ab jetzt; Aendern behaelt den Fortschritt.
      const fields = text
        ? { focus_reward: text, focus_reward_goal: goal }
        : { focus_reward: null, focus_reward_goal: null };
      if (text && !cls.focus_reward) fields.focus_reward_offset = cls.focus_trees.length;

      saveBtn.disabled = true;
      try {
        await api.updateFocusReward(cls.id, fields);
        Object.assign(cls, fields);
        showSetup();
        toast(text ? "Belohnung gespeichert." : "Belohnung entfernt.");
      } catch (error) {
        showError(error, "Belohnung konnte nicht gespeichert werden.");
        saveBtn.disabled = false;
      }
    });

    return h("div", { class: "card" },
      h("h2", {}, "Belohnung"),
      h("p", { class: "muted small" },
        "Am besten mit der Klasse gemeinsam festlegen. Gezählt werden Bäume ab dem ersten Speichern. " +
        "Leeres Feld entfernt die Belohnung."),
      form);
  }

  /* ----- Laufende Fokus-Phase (Beamer) ----- */

  /** goalSeconds = null: offenes Ziel, der Timer zaehlt hoch. */
  function runSession(noise, goalSeconds) {
    const open = goalSeconds === null;
    const limit = open ? FOCUS_OPEN_MAX_SECONDS : goalSeconds;
    let species = speciesForGoal(open ? 0 : goalSeconds);
    let sensitivity = Number(readPref(PREF_FOCUS_SENSITIVITY, 2.5));
    if (!(sensitivity >= 0.5 && sensitivity <= 8)) sensitivity = 2.5;

    let phase = "running";   // running | withering | banked | done
    let paused = false;
    let elapsed = 0;          // ruhige Sekunden fuer den aktuellen Baum
    let zone = "ruhig";
    let candidate = "ruhig";
    let candidateSince = performance.now();
    let loudSince = null;
    let lastTick = performance.now();
    let witherTimer = null;
    let wakeLock = null;
    let stopped = false;
    let lastMood = "";
    let celebration = null;
    let round = 0;            // zaehlt Neustarts, damit spaete Antworten nichts ueberschreiben
    let plantedSeconds = 0;

    const STATUS = {
      calm: "Ruhig – der Baum wächst",
      uneasy: "Etwas leiser – der Baum wächst gerade nicht",
      loud: "Zu laut! Gleich vertrocknet der Baum",
      withered: "Vertrocknet – gleich startet ein neuer Samen",
      done: "Geschafft!",
      paused: "Pause – der Baum wartet"
    };

    let tree = buildTree(species);
    tree.setProgress(0, { instant: true });
    // Offen: Voegel am Kirschbaum; null, solange noch die Birke waechst.
    let setBirds = null;
    let stage = open ? openStage(0) : null;

    const timeEl = h("div", { class: "focus__time" }, formatClock(open ? 0 : goalSeconds));
    const goalEl = h("div", { class: "focus__goal" });
    const factEl = h("div", { class: "focus__fact" });
    const factText = () => !stage?.birds ? TREE_SPECIES[species].fact
      : stage.extra > 0 ? BIRD_FACTS.chicks
      : stage.nest ? BIRD_FACTS.nest
      : BIRD_FACTS.birds;
    const showFact = () => { factEl.textContent = `Wusstest du? ${factText()}`; };
    showFact();
    const backdropEl = h("div", { class: "focus__backdrop", "aria-hidden": "true" });
    const statusEl = h("div", { class: "focus__status", role: "status", "aria-live": "polite" });
    const progressFill = h("div", { class: "focus__progress-fill" });
    const meterFill = h("div", { class: "meter__fill" });
    const footerEl = h("div", { class: "focus__bottom" });

    const pauseBtn = h("button", { class: "btn", type: "button", onclick: togglePause }, "Pause");
    const plantBtn = open
      ? h("button", { class: "btn btn--primary", type: "button", disabled: true, onclick: plantNow }, "Baum pflanzen")
      : null;
    const slider = h("input", {
      class: "slider", type: "range", min: "0.5", max: "8", step: "0.25",
      value: String(sensitivity), "aria-label": "Empfindlichkeit"
    });
    slider.addEventListener("input", () => {
      sensitivity = Number(slider.value);
      writePref(PREF_FOCUS_SENSITIVITY, sensitivity);
    });

    const root = h("div", { class: "focus" },
      h("div", { class: "focus__progress" }, progressFill),
      h("div", { class: "focus__top" },
        h("div", { class: "focus__head" },
          timeEl,
          goalEl,
          factEl),
        h("div", { class: "focus__panel" },
          h("div", { class: "focus__buttons" },
            plantBtn,
            pauseBtn,
            h("button", { class: "btn", type: "button", onclick: restart }, "Neu starten"),
            document.fullscreenEnabled
              ? h("button", { class: "btn", type: "button", onclick: toggleFullscreen }, "Vollbild")
              : null,
            h("button", { class: "btn", type: "button", onclick: requestExit }, "Beenden")),
          h("div", {},
            h("div", { class: "focus__label" }, "Lautstärke"),
            h("div", { class: "meter", "aria-hidden": "true" },
              meterFill,
              h("span", { class: "meter__mark", style: `left:${(FOCUS_ZONES.unruhig / 75) * 100}%` }),
              h("span", { class: "meter__mark", style: `left:${(FOCUS_ZONES.laut / 75) * 100}%` }))),
          h("label", {},
            h("span", { class: "focus__label" }, "Empfindlichkeit"),
            slider,
            h("span", { class: "focus__scale" }, h("span", {}, "weniger"), h("span", {}, "mehr"))))),
      h("div", { class: "focus__stage" }, backdropEl, statusEl, tree.el),
      footerEl);

    topbarEl.hidden = true;
    appEl.className = "app app--focus";
    appEl.replaceChildren(root);
    drawFooter();
    draw(0);

    const interval = setInterval(tick, FOCUS_TICK_MS);
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);
    lockScreen();
    registerCleanup(stop);

    function tick() {
      const now = performance.now();
      // Spruenge nach Standby oder gedrosselten Hintergrund-Tabs begrenzen.
      const dt = Math.min(2, (now - lastTick) / 1000);
      lastTick = now;

      const level = noise.read(sensitivity);
      const raw = level >= FOCUS_ZONES.laut ? "laut" : level >= FOCUS_ZONES.unruhig ? "unruhig" : "ruhig";
      if (raw !== candidate) { candidate = raw; candidateSince = now; }
      if (candidate !== zone && now - candidateSince >= FOCUS_ZONE_DWELL_MS[candidate]) zone = candidate;

      if (phase === "running" && !paused) {
        if (zone === "ruhig") elapsed = Math.min(limit, elapsed + dt);
        if (zone === "laut") {
          loudSince ??= now;
          if (now - loudSince >= FOCUS_WITHER_MS) { loudSince = null; wither(); }
        } else {
          loudSince = null;
        }
        if (elapsed >= limit) complete();
      }
      draw(level);
    }

    function draw(level) {
      meterFill.style.width = `${Math.min(100, (level / 75) * 100)}%`;
      meterFill.className = `meter__fill meter__fill--${zone}`;

      if (open) {
        // Beim Erreichen einer Schwelle: Kirschbaum, dann Voegel, Nest und mehr Voegel.
        if (phase === "running") {
          const now = openStage(elapsed);
          if (now.species !== species) setSpecies(now.species, elapsed >= FOCUS_OPEN_GROWN_SECONDS ? 1 : 0);
          if (now.birds !== stage.birds || now.nest !== stage.nest || now.extra !== stage.extra) {
            stage = now;
            setBirds?.(stage);
            showFact();
          }
        }
        const next = nextOpenStep(elapsed);
        const count = birdCount(stage);
        const current = [TREE_SPECIES[species].name, stage.nest ? "Nest" : null,
          count ? `${count} Vögel` : null].filter(Boolean).join(" · ");
        timeEl.textContent = formatClock(Math.floor(elapsed));
        progressFill.style.width = `${(next ? elapsed / next.seconds : 1) * 100}%`;
        goalEl.textContent = next
          ? `${current} · ${next.text} ab ${next.seconds / 60} min`
          : `${current} · alle Vögel sind da`;
        plantBtn.disabled = phase !== "running" || elapsed < FOCUS_OPEN_GROWN_SECONDS;
        if (phase !== "withering") tree.setProgress(elapsed / FOCUS_OPEN_GROWN_SECONDS);
      } else {
        timeEl.textContent = formatClock(Math.ceil(goalSeconds - elapsed));
        progressFill.style.width = `${(elapsed / goalSeconds) * 100}%`;
        goalEl.textContent = `${TREE_SPECIES[species].name} · Ziel ${goalSeconds / 60} min`;
        if (phase !== "withering") tree.setProgress(elapsed / goalSeconds);
      }

      const mood = phase === "done" ? "done"
        : phase === "withering" ? "withered"
        : phase === "banked" ? "banked"
        : paused ? "paused"
        : zone === "laut" ? "loud"
        : zone === "unruhig" ? "uneasy"
        : "calm";
      if (mood !== lastMood) {
        lastMood = mood;
        tree.setMood(mood);
        root.className = `focus focus--${mood}`;
        statusEl.textContent = mood === "banked"
          ? `Zu laut! ${TREE_SPECIES[species].article} ${TREE_SPECIES[species].name} wurde gepflanzt – ein neuer Samen startet`
          : STATUS[mood];
      }
    }

    /** Tauscht den wachsenden Baum gegen eine andere Art (offener Modus). */
    function setSpecies(next, progress) {
      species = next;
      const replacement = buildTree(species);
      replacement.setProgress(progress, { instant: true });
      tree.el.replaceWith(replacement.el);
      tree = replacement;
      setBirds = species === "kirsch" ? attachBirds(tree.el, String(round)) : null;
      stage = openStage(elapsed);
      setBirds?.(stage);
      showFact();
      lastMood = "";
    }

    function plantNow() {
      if (phase === "running" && elapsed >= FOCUS_OPEN_GROWN_SECONDS) complete();
    }

    function wither() {
      if (elapsed < FOCUS_MIN_WITHER_SECONDS) { elapsed = 0; return; }
      // Offen: die zuletzt erreichte Stufe wird trotzdem gepflanzt, danach neuer Samen.
      const bank = open && elapsed >= FOCUS_OPEN_GROWN_SECONDS;
      if (bank) savePlant(Math.floor(elapsed)).then(drawFooter);
      phase = bank ? "banked" : "withering";
      witherTimer = setTimeout(() => {
        elapsed = 0;
        tree.setProgress(0, { instant: true });
        phase = "running";
      }, FOCUS_WITHER_ANIM_MS);
    }

    async function complete() {
      phase = "done";
      loudSince = null;
      plantedSeconds = open ? Math.floor(elapsed) : goalSeconds;
      const myRound = round;
      const number = await savePlant(plantedSeconds);
      drawFooter();
      if (stopped || round !== myRound) return;
      showCelebration(number);
    }

    /** Speichert einen Baum; liefert seine Nummer im Wald oder null. Mit
     * Konto ueber die Warteschlange: Bei schlechtem WLAN wird er nachgesendet. */
    async function savePlant(seconds) {
      if (probe) return null;
      try {
        let planted;
        if (state.guest) {
          planted = await api.plantTree(cls.id, seconds, open);
        } else {
          planted = { id: uuid(), goal_seconds: seconds, open_goal: open, created_at: new Date().toISOString() };
          enqueue({ kind: "tree", classId: cls.id, treeId: planted.id, seconds, open });
        }
        cls.focus_trees.push(planted);
        return cls.focus_trees.length;
      } catch (error) {
        showError(error, "Der Baum konnte nicht gespeichert werden.");
        return null;
      }
    }

    function showCelebration(number) {
      const minutes = Math.floor(plantedSeconds / 60);
      const reward = probe ? null : rewardProgress(cls);
      const message = number
        ? `Baum Nr. ${number} steht jetzt im Wald von ${cls.name}.`
        : `${minutes} Minuten konzentriert gearbeitet.${probe ? " (Probelauf – nichts gespeichert)" : ""}`;
      const left = reward ? reward.goal - reward.done : 0;

      const nextBtn = h("button", { class: "btn btn--primary", type: "button", onclick: restart }, "Nächster Baum");
      celebration = h("div", { class: "celebrate", role: "dialog", "aria-modal": "true", "aria-label": "Baum gepflanzt" },
        confettiView(),
        h("div", { class: "celebrate__panel" },
          celebrationTree(),
          h("h2", {}, number ? `${TREE_SPECIES[species].article} ${TREE_SPECIES[species].name} ist gepflanzt!` : "Geschafft!"),
          h("p", {}, message),
          h("p", { class: "celebrate__fact" },
            h("strong", {}, `${TREE_SPECIES[species].full}: `), TREE_SPECIES[species].fact),
          reward
            ? h("p", { class: "celebrate__reward" },
                reward.reached
                  ? `Belohnung freigeschaltet: ${reward.text}`
                  : `Noch ${left === 1 ? "1 Baum" : `${left} Bäume`} bis zur Belohnung: ${reward.text}`)
            : null,
          h("div", { class: "row", style: "justify-content:center" },
            h("button", { class: "btn", type: "button", onclick: exit }, "Beenden"),
            nextBtn)));
      root.append(celebration);
      nextBtn.focus();
    }

    function celebrationTree() {
      return stillTree(species, 9, null, { stage: open ? openStage(plantedSeconds) : null, seed: String(round) });
    }

    function drawFooter() {
      if (probe) {
        footerEl.replaceChildren(h("span", { class: "focus__sub" }, "Probelauf – es wird nichts gespeichert."));
        return;
      }
      const stats = forestStats(cls);
      const reward = rewardProgress(cls);
      // Die bisher geschafften Baeume stehen hinter dem wachsenden Baum.
      backdropEl.replaceChildren(stats.count ? forestView(cls.focus_trees, { limit: 60, scale: 1.5 }) : "");
      footerEl.replaceChildren(
        h("div", { class: "focus__forest" },
          h("div", {},
            h("strong", {}, `Wald von ${cls.name}`),
            h("div", { class: "focus__sub" },
              `${stats.count === 1 ? "1 Baum" : `${stats.count} Bäume`} · ${stats.minutes} Fokus-Minuten`))));
      if (reward) {
        footerEl.append(
          h("div", { class: "focus__reward" },
            h("div", { class: "focus__sub" },
              reward.reached ? `Belohnung erreicht: ${reward.text}` : `Belohnung: ${reward.text}`),
            progressBar(reward.done / reward.goal),
            h("div", { class: "focus__sub" }, `${reward.done} / ${reward.goal} Bäume`)));
      }
    }

    function restart() {
      round += 1;
      clearTimeout(witherTimer);
      celebration?.remove();
      celebration = null;
      elapsed = 0;
      loudSince = null;
      phase = "running";
      tree.setProgress(0, { instant: true });
      draw(0);
    }

    function togglePause() {
      if (phase !== "running") return;
      paused = !paused;
      loudSince = null;
      pauseBtn.textContent = paused ? "Weiter" : "Pause";
    }

    function toggleFullscreen() {
      const request = document.fullscreenElement
        ? document.exitFullscreen()
        : document.documentElement.requestFullscreen();
      request?.catch?.(() => {});
    }

    function requestExit() {
      if (phase === "running" && elapsed >= 30) {
        const hint = open && elapsed >= FOCUS_OPEN_GROWN_SECONDS ? " Zum Pflanzen vorher „Baum pflanzen“ tippen." : "";
        confirmDelete(`Fokus-Phase beenden? Der aktuelle Baum wird nicht gepflanzt.${hint}`, async () => exit(), "Beenden");
      } else {
        exit();
      }
    }

    function exit() {
      stop();
      showSetup();
    }

    function onKey(event) {
      if (event.key !== " " || event.repeat) return;
      // Leertaste auf Buttons/Feldern normal wirken lassen, ebenso in Dialogen.
      if (event.target.closest?.("button, input, textarea, select, .modal")) return;
      event.preventDefault();
      togglePause();
    }

    async function lockScreen() {
      try {
        const lock = await navigator.wakeLock?.request("screen");
        if (stopped) lock?.release().catch(() => {});
        else wakeLock = lock ?? null;
      } catch {
        // Wake-Lock ist nur Komfort (Bildschirm bleibt an).
      }
    }

    function onVisibility() {
      // Der Wake-Lock faellt beim Verstecken der Seite automatisch weg.
      if (document.visibilityState === "visible" && !stopped) lockScreen();
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      clearTimeout(witherTimer);
      noise.stop();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
      wakeLock?.release().catch(() => {});
      wakeLock = null;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  }
}

function confettiView(count = 60) {
  const colors = ["#fde047", "#fb923c", "#22d3ee", "#86efac", "#f472b6", "#a78bfa"];
  return h("div", { class: "confetti", "aria-hidden": "true" },
    Array.from({ length: count }, () => h("span", {
      style: `left:${(Math.random() * 100).toFixed(1)}%;` +
        `background:${colors[Math.floor(Math.random() * colors.length)]};` +
        `--d:${(2.2 + Math.random() * 1.6).toFixed(2)}s;--delay:${(Math.random() * 0.6).toFixed(2)}s`
    })));
}

/* -------------------------------------------------------------------
   Dialoge
   ------------------------------------------------------------------- */

/** Dialog mit beliebigem Inhalt; Escape oder Klick daneben schliesst.
 * Liefert die Funktion zum Schliessen. */
function openModal(children, { className = "" } = {}) {
  const panel = h("div", { class: `modal__panel stack ${className}` }, children);
  const modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true" }, panel);
  const close = () => {
    modal.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(modal);
  panel.querySelector("button")?.focus();
  return close;
}

function confirmDelete(message, onConfirm, confirmLabel = "Löschen") {
  const panel = h("div", { class: "modal__panel" });
  const modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true" }, panel);

  const cancelBtn = h("button", { class: "btn", type: "button" }, "Abbrechen");
  const okBtn = h("button", { class: "btn btn--primary", type: "button" }, confirmLabel);

  const close = () => {
    modal.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => { if (event.key === "Escape") close(); };

  cancelBtn.addEventListener("click", close);
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  document.addEventListener("keydown", onKey);

  okBtn.addEventListener("click", async () => {
    okBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      await onConfirm();
      close();
    } catch (error) {
      showError(error);
      close();
    }
  });

  panel.append(
    h("p", { style: "margin-top:0" }, message),
    h("div", { class: "row", style: "justify-content:flex-end" }, cancelBtn, okBtn)
  );
  document.body.append(modal);
  okBtn.focus();
}

/** Modal zur Wahl der Unterrichts-Ansicht beim Start. Liefert
 * "kanban" | "sortiert", oder null bei Abbruch. */
function pickLessonMode() {
  return new Promise((resolve) => {
    const panel = h("div", { class: "modal__panel stack" });
    const modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true" }, panel);

    const close = (value) => {
      modal.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event) => { if (event.key === "Escape") close(null); };

    modal.addEventListener("click", (event) => { if (event.target === modal) close(null); });
    document.addEventListener("keydown", onKey);

    // Zwei gleichrangige Optionen mit kleiner Skizze der Ansicht in den
    // Zustandsfarben (links = Start, mitte = gut, rechts = grossartig).
    const option = (mode, title, sub, glyph) =>
      h("button", { class: "mode-option", type: "button", onclick: () => close(mode) },
        glyph,
        h("span", {},
          h("span", { class: "mode-option__title" }, title),
          h("span", { class: "mode-option__sub" }, sub)));
    const glyph = (variant, states) =>
      h("span", { class: `mode-glyph mode-glyph--${variant}`, "aria-hidden": "true" },
        states.map((s) => h("i", { "data-s": s })));

    panel.append(
      h("h2", { id: "mode-title", style: "margin-top:0" }, "Ansicht wählen"),
      h("div", { class: "mode-options" },
        option("kanban", "Kanban", "Namen per Drag & Drop durch drei Spalten ziehen.",
          glyph("kanban", ["links", "mitte", "rechts"])),
        option("sortiert", "Sortierte Ansicht", "Alle Namen alphabetisch im Raster, per Tipp weiterschalten.",
          glyph("grid", ["mitte", "links", "rechts", "links", "mitte", "mitte",
            "links", "rechts", "mitte", "links", "links", "mitte"]))),
      h("div", { class: "row", style: "justify-content:flex-end" },
        h("button", { class: "btn btn--ghost", type: "button", onclick: () => close(null) }, "Abbrechen"))
    );
    modal.setAttribute("aria-labelledby", "mode-title");
    document.body.append(modal);
    panel.querySelector(".mode-option").focus();
  });
}

/* -------------------------------------------------------------------
   Start
   ------------------------------------------------------------------- */

if (sb) {
  window.addEventListener("hashchange", router);

  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  applyPalette(paletteOf(session));

  sb.auth.onAuthStateChange((event, nextSession) => {
    const changedUser = nextSession?.user?.id !== state.session?.user?.id;
    state.session = nextSession;
    applyPalette(paletteOf(nextSession));
    if (changedUser) {
      state.teacher = null;
      state.openLessons.clear();
      resetChrome();
      router();
    }
  });

  await router();
}
