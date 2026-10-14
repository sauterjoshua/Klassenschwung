/* ===================================================================
   Klassenschwung – Import und Export
   -------------------------------------------------------------------
   Klassenliste (CSV, Excel, Untis), Stundenplan (iCal aus WebUntis
   oder einem Kalender), CSV- und PDF-Export der Auswertung.

   Alles laeuft nur im Browser: Eine importierte Datei verlaesst das
   Geraet nicht. Von einer Klassenliste uebernimmt die App nur Vornamen
   (bei gleichen Vornamen mit dem Anfang des Nachnamens), von einem
   Stundenplan nur Stundenzeiten und wann welche Klasse dran ist.

   Reine Funktionen ohne DOM und ohne Netzwerk, damit sie sich auch
   unter Node testen lassen.
   =================================================================== */

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 40 * 1024 * 1024;
const MAX_ROWS = 5000;

const lower = (s) => String(s ?? "").toLocaleLowerCase("de");
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Wie cleanName() in app.js: Steuerzeichen raus, Leerraum normalisieren. */
function clean(value, max = 200) {
  return String(value ?? "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/* -------------------------------------------------------------------
   Dateien lesen
   ------------------------------------------------------------------- */

/** Text einer Datei: UTF-16 mit BOM, UTF-8, sonst Windows-1252
 * (so speichert Excel unter Windows CSV-Dateien). */
export function decodeText(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const isZip = (b) => b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04;
const isOle = (b) => b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0;

/** Tabelle aus CSV, Text oder Excel (.xlsx): { rows, delimiter }. */
export async function readTableFile(bytes) {
  if (bytes.length > MAX_IMPORT_BYTES) throw new Error("Die Datei ist zu groß (höchstens 5 MB).");
  if (isOle(bytes)) {
    throw new Error("Ältere Excel-Dateien (.xls) kann die App nicht lesen. Bitte in Excel als .xlsx oder .csv speichern.");
  }
  if (isZip(bytes)) return { rows: await readXlsx(bytes), delimiter: null };
  return parseDelimited(decodeText(bytes));
}

/** Trennzeichen erkennen (Tab, Semikolon, Komma) und CSV mit
 * Anfuehrungszeichen zerlegen. Ohne Trennzeichen: eine Spalte.
 * Liefert { rows, delimiter }. */
export function parseDelimited(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const sample = source.split("\n").filter((line) => line.trim()).slice(0, 30);
  const needed = Math.max(1, Math.ceil(sample.length * 0.6));
  const delimiter = ["\t", ";", ","].find((d) => sample.filter((line) => line.includes(d)).length >= needed) ?? null;

  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const endCell = () => { row.push(cell); cell = ""; };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim())) rows.push(row.map((c) => clean(c)));
    row = [];
  };

  for (let i = 0; i < source.length && rows.length < MAX_ROWS; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && delimiter && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (delimiter && ch === delimiter) {
      endCell();
    } else if (ch === "\n") {
      endRow();
    } else {
      cell += ch;
    }
  }
  endRow();
  return { rows, delimiter };
}

/* ----- Excel (.xlsx): ZIP mit XML-Dateien ----- */

function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Die Datei ist beschädigt oder keine Excel-Datei.");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (view.getUint32(at, true) !== 0x02014B50) break;
    const nameLen = view.getUint16(at + 28, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    entries.set(name, {
      method: view.getUint16(at + 10, true),
      size: view.getUint32(at + 20, true),
      unzipped: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true)
    });
    at += 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

async function zipText(bytes, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  if (entry.unzipped > MAX_UNZIPPED_BYTES) throw new Error("Die Datei ist zu groß.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new Error("Diese Excel-Datei ist ungewöhnlich gepackt. Bitte als .csv speichern.");

  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_UNZIPPED_BYTES) { reader.cancel(); throw new Error("Die Datei ist zu groß."); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
  return new TextDecoder().decode(out);
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function xmlText(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10FFFF ? String.fromCodePoint(code) : "";
    }
    return XML_ENTITIES[e] ?? m;
  });
}
const runsText = (xml) =>
  xmlText([...String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

function columnNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Erstes Tabellenblatt einer .xlsx-Datei als Zeilen aus Zellen. */
export async function readXlsx(bytes) {
  const entries = zipEntries(bytes);
  const workbook = await zipText(bytes, entries, "xl/workbook.xml");
  if (workbook === null) throw new Error("Diese Datei kann die App nicht lesen. Bitte als .xlsx oder .csv speichern.");

  let sheetPath = "xl/worksheets/sheet1.xml";
  const firstSheet = workbook.match(/<sheet\b[^>]*\br:id="([^"]+)"/);
  const rels = await zipText(bytes, entries, "xl/_rels/workbook.xml.rels");
  if (firstSheet && rels) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0])
      .find((tag) => tag.includes(`Id="${firstSheet[1]}"`));
    const target = rel?.match(/Target="([^"]+)"/)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }

  const shared = [...((await zipText(bytes, entries, "xl/sharedStrings.xml")) ?? "")
    .matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runsText(m[1]));
  const sheet = await zipText(bytes, entries, sheetPath);
  if (sheet === null) throw new Error("In der Excel-Datei wurde kein Tabellenblatt gefunden.");

  const rows = [];
  let rowIndex = -1;
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= MAX_ROWS) break;
    const r = rowMatch[1].match(/\br="(\d+)"/);
    rowIndex = r ? Number(r[1]) - 1 : rowIndex + 1;
    const cells = [];
    let col = -1;
    for (const cellMatch of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const ref = attrs.match(/\br="([A-Z]+)\d+"/);
      col = ref ? columnNumber(ref[1]) : col + 1;
      if (col > 200) continue;
      const type = attrs.match(/\bt="(\w+)"/)?.[1];
      const body = cellMatch[2] ?? "";
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = runsText(body);
      else if (raw !== undefined) value = xmlText(raw);
      cells[col] = clean(value);
    }
    if (cells.some((c) => c)) rows[rowIndex] = Array.from(cells, (c) => c ?? "");
  }
  return rows.filter(Boolean);
}

/* -------------------------------------------------------------------
   Klassenliste: Spalten erkennen, Vornamen bilden
   ------------------------------------------------------------------- */

const HEADERS = {
  rufname: /^rufname$/,
  first: /^(vorname|vornamen|first ?name|given ?name|forename)$/,
  last: /^(nachname|familienname|zuname|last ?name|surname|family ?name)$/,
  lastFirst: /^(nachname,? vorname|name,? vorname|familienname,? vorname)$/,
  firstLast: /^(vorname,? nachname|vorname,? name)$/,
  name: /^(name|schüler|schülerin|schüler ?innen|schülername|schueler|student|kind)$/,
  klasse: /^(klasse|klassen|class|kl|stammklasse|klassenname)$/
};
const headerKey = (cell) => lower(cell).replace(/[^\p{L}\s,]/gu, "").replace(/\s+/g, " ").trim();

/**
 * Aufbau einer Tabelle erraten: Kopfzeile, Spalte(n) fuer Vor- und
 * Nachname, Klasse. Die App zeigt das Ergebnis zur Kontrolle an.
 *   first/last/full/klasse: Spaltennummer oder -1
 *   order: Aufbau einer kombinierten Namensspalte, "vn" | "nv"
 */
export function detectLayout(rows, delimiter = null) {
  const width = Math.max(1, ...rows.slice(0, 50).map((r) => r.length));
  const layout = { headerRow: -1, columns: [], first: -1, last: -1, full: -1, order: "vn", klasse: -1 };

  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const keys = rows[i].map(headerKey);
    const find = (re) => keys.findIndex((k) => re.test(k));
    const rufname = find(HEADERS.rufname);
    const first = rufname >= 0 ? rufname : find(HEADERS.first);
    const lastFirst = find(HEADERS.lastFirst);
    const firstLast = find(HEADERS.firstLast);
    const name = find(HEADERS.name);
    if (first < 0 && lastFirst < 0 && firstLast < 0 && name < 0) continue;

    layout.headerRow = i;
    layout.klasse = find(HEADERS.klasse);
    if (first >= 0) {
      layout.first = first;
      const last = find(HEADERS.last);
      layout.last = last >= 0 ? last : name;
    } else {
      layout.full = lastFirst >= 0 ? lastFirst : firstLast >= 0 ? firstLast : name;
      layout.order = lastFirst >= 0 ? "nv" : firstLast >= 0 ? "vn" : guessOrder(rows.slice(i + 1), layout.full);
    }
    break;
  }

  if (layout.headerRow < 0) {
    const data = rows.slice(0, 50);
    if (width === 1) {
      layout.full = 0;
      layout.order = guessOrder(data, 0);
    } else {
      // Zwei Spalten durch Komma getrennt sind meist "Nachname, Vorname".
      const commaPairs = width === 2 && delimiter === ",";
      layout.first = commaPairs ? 1 : 0;
      layout.last = commaPairs ? 0 : 1;
    }
  }

  const header = layout.headerRow >= 0 ? rows[layout.headerRow] : [];
  layout.columns = Array.from({ length: width }, (_, i) => header[i] || `Spalte ${i + 1}`);
  return layout;
}

function guessOrder(rows, col) {
  const values = rows.map((r) => r[col] ?? "").filter(Boolean).slice(0, 50);
  return values.filter((v) => v.includes(",")).length > values.length / 2 ? "nv" : "vn";
}

const PARTICLES = new Set(["von", "van", "vom", "zu", "zum", "zur", "de", "der", "den", "del", "della",
  "di", "da", "du", "le", "la", "ten", "ter", "al", "el", "bin", "ibn"]);

/** "Lea Marie von Berg" -> { first: "Lea Marie", last: "von Berg" } */
function splitFull(full, order) {
  const text = clean(full);
  if (order === "nv") {
    const comma = text.indexOf(",");
    if (comma >= 0) return { first: clean(text.slice(comma + 1)), last: clean(text.slice(0, comma)) };
    const [last, ...rest] = text.split(" ");
    return rest.length ? { first: rest.join(" "), last } : { first: last, last: "" };
  }
  const comma = text.indexOf(",");
  if (comma >= 0) return { first: clean(text.slice(comma + 1)), last: clean(text.slice(0, comma)) };
  const parts = text.split(" ");
  if (parts.length === 1) return { first: text, last: "" };
  const last = [parts.pop()];
  while (parts.length > 1 && PARTICLES.has(lower(parts[parts.length - 1]))) last.unshift(parts.pop());
  return { first: parts.join(" "), last: last.join(" ") };
}

const normClass = (s) => lower(s).replace(/[\s.\-_/]+/g, "");

/** Klassen in der Klassenspalte (z. B. Export der ganzen Schule aus Untis). */
export function classValues(rows, layout) {
  if (layout.klasse < 0) return [];
  const counts = new Map();
  for (const row of rows.slice(layout.headerRow + 1)) {
    const value = clean(row[layout.klasse]);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true }));
}

/** Passender Wert der Klassenspalte zum Namen der Klasse in der App. */
export function matchClassValue(values, className) {
  const key = normClass(className);
  return values.find((v) => normClass(v.name) === key)?.name ?? null;
}

/** Personen aus der Tabelle: [{ first, last }]. */
export function extractPeople(rows, layout, { klasse = null } = {}) {
  const people = [];
  for (const row of rows.slice(layout.headerRow + 1)) {
    if (klasse !== null && layout.klasse >= 0 && normClass(row[layout.klasse]) !== normClass(klasse)) continue;
    let person;
    if (layout.first >= 0) {
      person = { first: clean(row[layout.first]), last: layout.last >= 0 ? clean(row[layout.last]) : "" };
    } else if (layout.full >= 0) {
      person = splitFull(row[layout.full] ?? "", layout.order);
    } else {
      continue;
    }
    if (person.first) people.push(person);
  }
  return people;
}

/** "LEA-MARIE" / "lea" -> "Lea-Marie" / "Lea"; gemischte Schreibung bleibt. */
function tidyCase(name) {
  const letters = name.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2 || (letters !== letters.toLocaleUpperCase("de") && letters !== letters.toLocaleLowerCase("de"))) {
    return name;
  }
  return name.toLocaleLowerCase("de").replace(/(^|[\s\-'])(\p{L})/gu, (m, sep, ch) => sep + ch.toLocaleUpperCase("de"));
}

/** Kern des Nachnamens ohne "von", "de" usw. (zum Abkuerzen). */
function lastCore(last) {
  const words = clean(last).split(" ").filter(Boolean);
  while (words.length > 1 && PARTICLES.has(lower(words[0]))) words.shift();
  return words.join(" ");
}

/** Kuerzester Anfang des Nachnamens, der in der Gruppe eindeutig ist:
 * "M." – reicht das nicht, "Mü." bzw. "Ma." usw. */
function abbreviation(core, others) {
  const letters = Array.from(core);
  if (!letters.length) return "";
  const prefix = (chars, k) => lower(chars.slice(0, k).join(""));
  const otherChars = others.map((o) => Array.from(o));
  let k = 1;
  while (k < letters.length && otherChars.some((o) => prefix(o, k) === prefix(letters, k))) k++;
  // Nicht direkt nach einem Bindestrich oder Leerzeichen abschneiden.
  while (k < letters.length && !/\p{L}/u.test(letters[k - 1])) k++;
  const tidy = tidyCase(letters.slice(0, k).join(""));
  const text = Array.from(tidy)[0].toLocaleUpperCase("de") + Array.from(tidy).slice(1).join("");
  return k < letters.length ? `${text}.` : tidyCase(core);
}

/**
 * Anzeigenamen fuer die Klasse: nur Vorname; gibt es ihn mehrfach, mit
 * dem kuerzesten eindeutigen Anfang des Nachnamens ("Lea M.", bei zwei
 * M-Nachnamen "Lea Mü." und "Lea Ma."). Doppelte Zeilen fallen weg.
 * Liefert [{ name, exists }]; exists = gibt es in der Klasse schon.
 */
export function shortNames(people, existing = [], max = 80) {
  const seen = new Set();
  const unique = [];
  for (const p of people) {
    const first = tidyCase(clean(p.first, max));
    const last = clean(p.last, 120);
    // Doppelte Zeile nur bei gleichem Vor- UND Nachnamen; ohne Nachnamen
    // koennten es zwei Kinder sein (werden dann nummeriert).
    const key = `${lower(first)}|${lower(last)}`;
    if (!first || (last && seen.has(key))) continue;
    seen.add(key);
    unique.push({ first, last });
  }

  const groups = new Map();
  for (const p of unique) {
    const key = lower(p.first);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const names = unique.map((p) => {
    const group = groups.get(lower(p.first));
    if (group.length === 1 || !p.last) return p.first;
    const others = group.filter((o) => o !== p).map((o) => lastCore(o.last));
    return `${p.first} ${abbreviation(lastCore(p.last), others)}`.slice(0, max);
  });

  // Gleiche Ergebnisse (z. B. gleicher Nachname) durchnummerieren.
  const used = new Map();
  for (const name of names) used.set(lower(name), (used.get(lower(name)) ?? 0) + 1);
  const counter = new Map();
  const existingKeys = new Set(existing.map(lower));
  return names.map((name) => {
    let result = name;
    if (used.get(lower(name)) > 1) {
      const n = (counter.get(lower(name)) ?? 0) + 1;
      counter.set(lower(name), n);
      result = `${name} (${n})`;
    }
    return { name: result, exists: existingKeys.has(lower(result)) };
  });
}

/* -------------------------------------------------------------------
   Stundenplan aus einer iCal-Datei (.ics)
   ------------------------------------------------------------------- */

const unescapeIcs = (s) => String(s).replace(/\\([\\;,nN])/g, (m, c) => (c === "n" || c === "N" ? "\n" : c));

function icsTime(value, params) {
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m || params.includes("VALUE=DATE") || m[4] === undefined) return null;
  const [y, mo, d, hh, mm, ss] = m.slice(1, 7).map((x) => Number(x ?? 0));
  // UTC in lokale Zeit umrechnen; mit TZID oder ohne Zone gilt die Uhrzeit wie angegeben.
  return m[7] ? new Date(Date.UTC(y, mo - 1, d, hh, mm, ss)) : new Date(y, mo - 1, d, hh, mm, ss);
}

function icsDuration(value) {
  const m = String(value).match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [w, d, h, min, s] = m.slice(1).map((x) => Number(x ?? 0));
  return ((((w * 7 + d) * 24 + h) * 60 + min) * 60 + s) * 1000;
}

/** Termine Montag bis Freitag mit Wochentag, Beginn und Ende in Minuten. */
export function parseIcs(text) {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { current = {}; continue; }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      if (events.length > MAX_ROWS) break;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const [name, ...params] = line.slice(0, colon).toUpperCase().split(";");
    current[name] = { value: line.slice(colon + 1), params: params.join(";") };
  }
  if (!events.length && !/BEGIN:VCALENDAR/.test(String(text))) {
    throw new Error("Das ist keine iCal-Datei (.ics).");
  }

  const result = [];
  for (const e of events) {
    if (!e.DTSTART || /CANCELLED/i.test(e.STATUS?.value ?? "")) continue;
    const start = icsTime(e.DTSTART.value, e.DTSTART.params);
    if (!start) continue;
    let end = e.DTEND ? icsTime(e.DTEND.value, e.DTEND.params) : null;
    if (!end && e.DURATION) {
      const ms = icsDuration(e.DURATION.value);
      if (ms) end = new Date(start.getTime() + ms);
    }
    if (!end) continue;
    const weekday = start.getDay();
    const from = start.getHours() * 60 + start.getMinutes();
    const to = from + Math.round((end - start) / 60000);
    if (weekday < 1 || weekday > 5 || to - from < 10 || to - from > 240 || to > 24 * 60) continue;
    const field = (key) => clean(unescapeIcs(e[key]?.value ?? ""), 300);
    result.push({
      weekday, start: from, end: to,
      date: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`,
      summary: field("SUMMARY"),
      description: field("DESCRIPTION"),
      location: field("LOCATION"),
      categories: field("CATEGORIES")
    });
  }
  return result;
}

const overlap = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start);

/**
 * Stundenzeiten aus den Terminen: haeufigste Einzelstunden, lange Termine
 * (Doppelstunden) in Einzelstunden geteilt. Vormittags werden Luecken, in
 * die ganze Stunden passen, als geschaetzte Stunden ergaenzt (Stunden,
 * in denen man nie unterrichtet, kommen im eigenen Plan nicht vor); die
 * Pause liegt dabei wie meist ueblich nach einer geraden Stunde.
 * Liefert { dayStart, blocks, periods } oder null.
 */
export function deriveTimes(events) {
  const counts = new Map();
  for (const e of events) {
    const key = `${e.start}-${e.end}`;
    counts.set(key, { start: e.start, end: e.end, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  const intervals = [...counts.values()];
  if (!intervals.length) return null;

  const durations = new Map();
  for (const iv of intervals) {
    const d = iv.end - iv.start;
    if (d <= 60) durations.set(d, (durations.get(d) ?? 0) + iv.count);
  }
  const unit = [...durations].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 45;
  const isUnit = (iv) => iv.end - iv.start <= Math.max(60, unit + 10);
  const byCount = (a, b) => b.count - a.count || a.start - b.start;

  const periods = [];
  for (const iv of intervals.filter(isUnit).sort(byCount)) {
    if (!periods.some((p) => overlap(p, iv) > 0)) periods.push({ start: iv.start, end: iv.end, estimated: false });
  }
  // Lange Termine: freie Teile in gleich lange Einzelstunden teilen.
  for (const iv of intervals.filter((x) => !isUnit(x)).sort(byCount)) {
    const inside = periods.filter((p) => overlap(p, iv) > 0).sort((a, b) => a.start - b.start);
    let at = iv.start;
    const free = [];
    for (const p of inside) {
      if (p.start > at) free.push([at, p.start]);
      at = Math.max(at, p.end);
    }
    if (iv.end > at) free.push([at, iv.end]);
    for (const [s, e] of free) {
      const n = Math.round((e - s) / unit);
      if (n < 1 || (e - s) < unit * 0.75) continue;
      for (let i = 0; i < n; i++) {
        periods.push({ start: s + Math.round((i * (e - s)) / n), end: s + Math.round(((i + 1) * (e - s)) / n), estimated: false });
      }
    }
  }
  periods.sort((a, b) => a.start - b.start);

  // Luecken am Vormittag mit geschaetzten Stunden fuellen.
  const filled = [];
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    const prev = filled[filled.length - 1];
    if (prev) {
      const gap = p.start - prev.end;
      const n = Math.floor(gap / unit);
      const rest = gap - n * unit;
      if (n >= 1 && n <= 3 && rest <= 30 && p.start <= 13 * 60 + 30) {
        // Pause nach der ersten geraden Stunde, sonst direkt vor der naechsten.
        const before = filled.length;
        let pauseAfter = n;
        for (let j = 0; j <= n; j++) if ((before + j) % 2 === 0) { pauseAfter = j; break; }
        let at = prev.end;
        for (let j = 0; j < n; j++) {
          if (j === pauseAfter) at += rest;
          filled.push({ start: at, end: at + unit, estimated: true });
          at += unit;
        }
      }
    }
    filled.push(p);
  }

  const chosen = filled.slice(0, 16);
  const blocks = [];
  chosen.forEach((p, i) => {
    if (i > 0 && p.start > chosen[i - 1].end) blocks.push({ kind: "pause", min: p.start - chosen[i - 1].end });
    blocks.push({ kind: "stunde", min: p.end - p.start });
  });
  const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { dayStart: clock(chosen[0].start), blocks, periods: chosen };
}

/** Nummern (ab 1) der Stunden, die ein Termin ueberwiegend abdeckt. */
export function eventPeriods(event, periods) {
  const result = [];
  periods.forEach((p, i) => {
    const o = overlap(event, p);
    if (o > 0 && o >= Math.min(p.end - p.start, event.end - event.start) / 2) result.push(i + 1);
  });
  return result;
}

const tokens = (text) => ` ${lower(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
// Typische Klassenbezeichnungen: 5a, 10b, 7ab, EF, Q1, Q2, Q11, E1, J2, K1 …
const CLASS_TOKEN = /^(?:(?:[1-9]|1[0-3])[a-z]{1,2}|ef|q[12]|q1[1-3]|e[12]|j[12]|k[12])$/i;

/**
 * Termine nach Klasse gruppieren. Steht der Name einer vorhandenen
 * Klasse im Termin (Titel, Beschreibung, Kategorie – nicht im Raum), gilt
 * die Klasse; sonst eine erkennbare Klassenbezeichnung als Vorschlag fuer
 * eine neue Klasse; sonst der Titel.
 * classes: [{ id, name }]. Liefert Gruppen mit den Terminen.
 */
export function groupEvents(events, classes) {
  const known = classes
    .map((c) => ({ ...c, key: tokens(c.name) }))
    .filter((c) => c.key.trim())
    .sort((a, b) => b.key.length - a.key.length);
  const groups = new Map();
  for (const e of events) {
    const text = [e.summary, e.description, e.categories].join(" ");
    const haystack = tokens(text);
    const match = known.find((c) => haystack.includes(c.key));
    const guess = match ? null : haystack.trim().split(" ").find((t) => CLASS_TOKEN.test(t)) ?? null;
    const key = match ? `klasse:${match.id}` : guess ? `neu:${guess}` : `text:${lower(e.summary) || "?"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        classId: match?.id ?? null,
        guess: guess ? guess.toLocaleUpperCase("de").replace(/^(\d+)(\p{L}+)$/u, (m, n, l) => n + l.toLocaleLowerCase("de")) : null,
        label: match ? match.name : guess ? guess : e.summary || "(ohne Titel)",
        titles: new Set(),
        events: []
      });
    }
    const group = groups.get(key);
    if (e.summary) group.titles.add(e.summary);
    group.events.push(e);
  }
  return [...groups.values()].sort((a, b) =>
    (a.classId || a.guess ? 0 : 1) - (b.classId || b.guess ? 0 : 1) || a.label.localeCompare(b.label, "de", { numeric: true }));
}

/**
 * Wochenplan aus Gruppen und Zuordnung: { "<Wochentag>:<Stunde>": Ziel }.
 * target(group) liefert das Ziel (Klassen-ID) oder null. Bei Konflikten
 * (z. B. A-/B-Woche) gewinnt, was in der Datei haeufiger vorkommt.
 */
export function buildSlots(groups, periods, target) {
  const votes = new Map();
  let unmatched = 0;
  for (const group of groups) {
    const id = target(group);
    if (!id) continue;
    for (const e of group.events) {
      const ns = eventPeriods(e, periods);
      if (!ns.length) unmatched++;
      for (const n of ns) {
        const key = `${e.weekday}:${n}`;
        if (!votes.has(key)) votes.set(key, new Map());
        votes.get(key).set(id, (votes.get(key).get(id) ?? 0) + 1);
      }
    }
  }
  const slots = {};
  let conflicts = 0;
  for (const [key, byId] of votes) {
    const ranked = [...byId].sort((a, b) => b[1] - a[1]);
    slots[key] = ranked[0][0];
    if (ranked.length > 1) conflicts++;
  }
  return { slots, unmatched, conflicts };
}

/* -------------------------------------------------------------------
   CSV (fuer Excel: Semikolon, UTF-8 mit BOM)
   ------------------------------------------------------------------- */

/** Zellen, die mit = + - @ beginnen, wuerde Excel als Formel ausfuehren
 * (CSV-Injection) – sie bekommen ein Hochkomma vorangestellt. */
export function toCsv(rows) {
  const cell = (value) => {
    let s = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `\uFEFF${rows.map((row) => row.map(cell).join(";")).join("\r\n")}\r\n`;
}

/** Minuten mit Dezimalkomma, z. B. "12,5" (Excel mit deutschen Einstellungen). */
export const csvMinutes = (seconds) => (Math.round((Number(seconds) || 0) / 6) / 10).toString().replace(".", ",");

/* -------------------------------------------------------------------
   PDF (A4, Helvetica, ohne Bibliothek)
   -------------------------------------------------------------------
   Text in WinAnsi-Kodierung (Westeuropa). Zeichen ausserhalb davon
   (z. B. ş, ł) werden auf den Grundbuchstaben zurueckgefuehrt.
   ------------------------------------------------------------------- */

const WIN_ANSI_EXTRA = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89,
  "Š": 0x8A, "‹": 0x8B, "Œ": 0x8C, "Ž": 0x8E, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9A, "›": 0x9B, "œ": 0x9C, "ž": 0x9E, "Ÿ": 0x9F
};
const FALLBACK = { "ı": "i", "İ": "I", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ħ": "h", "ŋ": "n", "ſ": "s", "\u00A0": " " };

function ansiCode(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x20 && code < 0x7F) return code;
  if (code >= 0xA0 && code <= 0xFF) return code;
  return WIN_ANSI_EXTRA[ch] ?? null;
}

/** Text als WinAnsi-Bytes (als String aus Zeichen < 256). */
export function toWinAnsi(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    let code = ansiCode(ch);
    if (code === null) {
      const base = FALLBACK[ch] ?? ch.normalize("NFD").replace(/\p{M}/gu, "");
      code = base.length === 1 ? ansiCode(base) : null;
      if (code === null && base.length > 1) { out += toWinAnsi(base); continue; }
    }
    out += String.fromCharCode(code ?? 0x3F);
  }
  return out;
}

// Zeichenbreiten (1/1000 em) fuer ASCII 32–126, aus den AFM-Dateien.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,
  278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,
  944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,
  278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,
  333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,
  944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,
  333,611,556,778,556,556,500,389,280,389,584];
const W_SPECIAL = { 0x85: 1000, 0x96: 556, 0x97: 1000, 0x84: 333, 0x93: 333, 0x94: 333, 0xDF: 611, 0xE6: 889, 0xC6: 1000,
  0xF8: 611, 0xD8: 778, 0xB7: 278, 0xD7: 584, 0xA0: 278, 0x80: 556 };

function charWidth(byte, bold) {
  const table = bold ? W_BOLD : W_REG;
  if (byte >= 32 && byte <= 126) return table[byte - 32];
  if (W_SPECIAL[byte]) return W_SPECIAL[byte];
  if (byte >= 0xC0) {
    const base = String.fromCharCode(byte).normalize("NFD")[0].charCodeAt(0);
    if (base >= 32 && base <= 126) return table[base - 32];
  }
  return 556;
}

const textWidth = (ansi, size, bold = false) =>
  [...ansi].reduce((sum, ch) => sum + charWidth(ch.charCodeAt(0), bold), 0) * size / 1000;

const pdfString = (ansi) => `(${ansi.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** Kuerzt Text mit "…", bis er in die Breite passt. */
function fit(ansi, size, bold, width) {
  if (textWidth(ansi, size, bold) <= width) return ansi;
  let s = ansi;
  while (s.length > 1 && textWidth(`${s}\x85`, size, bold) > width) s = s.slice(0, -1);
  return `${s.trimEnd()}\x85`;
}

/** Zeilenumbruch an Wortgrenzen. */
function wrap(ansi, size, width) {
  const lines = [];
  let line = "";
  for (const word of ansi.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size) > width) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 50;

/**
 * PDF mit Titel, Unterzeile, Kennzahlen, einer Tabelle (mit Kopfzeile
 * auf jeder Seite) und Hinweisen darunter.
 *   columns: [{ label, weight, align: "left"|"right" }]
 *   rows:    [[Zelltexte]]
 * Liefert die Datei als Uint8Array.
 */
export function buildPdf({ title, subtitle = "", facts = [], columns, rows, notes = [], footer = "" }) {
  const contentW = PAGE_W - 2 * MARGIN;
  const totalWeight = columns.reduce((s, c) => s + (c.weight ?? 1), 0);
  const widths = columns.map((c) => (contentW * (c.weight ?? 1)) / totalWeight);
  const pad = 6;
  const rowH = 18;
  const bottom = MARGIN + 24;

  const pages = [];
  let ops = [];
  let y = 0;
  const color = (g) => `${g} g`;
  const text = (s, x, yy, size, bold = false, gray = 0) =>
    ops.push(`BT ${color(gray)} /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td ${pdfString(s)} Tj ET`);
  const rect = (x, yy, w, hh, gray) => ops.push(`${color(gray)} ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${hh.toFixed(2)} re f`);
  const line = (x1, y1, x2, gray, width = 0.6) =>
    ops.push(`${gray} G ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y1.toFixed(2)} l S`);

  const newPage = () => {
    if (ops.length) pages.push(ops);
    ops = [];
    y = PAGE_H - MARGIN;
  };
  const cellX = (i, align, w, s, size, bold) => {
    const left = MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0);
    return align === "right" ? left + w - pad - textWidth(s, size, bold) : left + pad;
  };
  const tableHead = () => {
    columns.forEach((c, i) => {
      const s = fit(toWinAnsi(c.label), 8.5, true, widths[i] - 2 * pad);
      text(s, cellX(i, c.align, widths[i], s, 8.5, true), y - 12, 8.5, true, 0.35);
    });
    y -= rowH;
    line(MARGIN, y, PAGE_W - MARGIN, 0.6, 0.8);
  };

  newPage();
  text(toWinAnsi(title), MARGIN, y - 18, 18, true);
  y -= 30;
  if (subtitle) { text(toWinAnsi(subtitle), MARGIN, y - 10, 10, false, 0.35); y -= 20; }
  for (const fact of facts) { text(toWinAnsi(fact), MARGIN, y - 10, 10); y -= 15; }
  y -= 12;

  tableHead();
  rows.forEach((row, r) => {
    if (y - rowH < bottom) { newPage(); tableHead(); }
    if (r % 2 === 1) rect(MARGIN, y - rowH, contentW, rowH, 0.955);
    columns.forEach((c, i) => {
      const s = fit(toWinAnsi(row[i] ?? ""), 10, false, widths[i] - 2 * pad);
      text(s, cellX(i, c.align, widths[i], s, 10, false), y - 12.5, 10);
    });
    y -= rowH;
  });
  line(MARGIN, y, PAGE_W - MARGIN, 0.8);

  y -= 10;
  for (const note of notes) {
    const lines = wrap(toWinAnsi(note), 8.5, contentW);
    if (y - lines.length * 12 < bottom) newPage();
    for (const l of lines) { text(l, MARGIN, y - 10, 8.5, false, 0.35); y -= 12; }
    y -= 4;
  }
  pages.push(ops);

  // Fusszeile mit Seitenzahl auf jeder Seite.
  pages.forEach((page, i) => {
    ops = page;
    const label = toWinAnsi(`Seite ${i + 1} von ${pages.length}`);
    text(toWinAnsi(footer), MARGIN, MARGIN - 10, 8, false, 0.45);
    text(label, PAGE_W - MARGIN - textWidth(label, 8), MARGIN - 10, 8, false, 0.45);
  });

  // Objekte: 1 Katalog, 2 Seitenbaum, 3/4 Schriften, 5 Info, danach je Seite Seite + Inhalt.
  const objects = [];
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(" ");
  const utf16 = (s) => `<FEFF${[...String(s)].map((ch) => {
    const code = ch.codePointAt(0);
    const units = code > 0xFFFF
      ? [0xD800 + ((code - 0x10000) >> 10), 0xDC00 + ((code - 0x10000) & 0x3FF)]
      : [code];
    return units.map((u) => u.toString(16).padStart(4, "0").toUpperCase()).join("");
  }).join("")}>`;
  const now = new Date();
  const stamp = `D:${now.getFullYear()}${[now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, "0")).join("")}`;

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  objects.push(`<< /Title ${utf16(title)} /Producer (Klassenschwung) /CreationDate (${stamp}) >>`);
  pages.forEach((page, i) => {
    const content = page.join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xFF;
  return bytes;
}
