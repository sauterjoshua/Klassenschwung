# Klassenschwung

---

## Ohne Anmeldung

Die Startseite zeigt, was Klassenschwung kann. Ohne Konto gehen:

- **Unterricht ausprobieren** (`app.html#/ausprobieren`): Vornamen eintippen
  (oder Beispielnamen einsetzen), Kanban oder sortierte Ansicht wählen und
  das Board ausprobieren. Nach dem Beenden stehen die Zeiten der Stunde da.
  Nichts wird gespeichert – der Probe-Unterricht liegt nur im
  Arbeitsspeicher des Tabs; vor dem Neuladen fragt der Browser nach.
- **Fokus-Wald** (`app.html#/focus`): Klassen nur mit Namen anlegen, Bäume
  pflanzen, Ranking, Belohnung und alle Wälder. Gespeichert wird das im
  Browser (`localStorage`, Schlüssel `bt.gast.wald`), nicht auf dem Server.

Ohne Anmeldung baut die App keine Verbindung zu Supabase auf; die Aufrufe
laufen über `guestApi` in `app.js`.

## Anmelden

Klassenschwung ist derzeit ein **privates Projekt** (siehe unten): keine
öffentliche Registrierung, Zugänge werden persönlich vergeben. Wer auf
**Anmelden** tippt, sieht zuerst diesen Hinweis und die Links zu den
Funktionen ohne Konto, darunter das Anmeldeformular.

1. Link oben öffnen und auf **Anmelden** tippen. Die App selbst liegt unter
   `app.html`; alte Lesezeichen auf `…/#/…` werden automatisch dorthin
   weitergeleitet.
2. Mit E-Mail und Passwort anmelden. Beim ersten Mal die Nutzungsbedingungen
   bestätigen.
3. Nach dem Login erscheint **Heute**. Oben in der Kopfzeile:
   - Navigation **Heute · Klassen · Unterrichte · Fokus-Wald**,
   - **Jetzt: 7b** – die Klasse der aktuellen Stunde laut Stundenplan,
   - **+ Starten** – Unterricht oder Fokus-Phase starten, die aktuelle Klasse
     steht zuerst,
   - das **Konto-Menü** (Name) mit Einstellungen, Datenexport und Abmelden.

   Eine Klasse hat die Reiter **Schüler · Sitzplan · Auswertung · Wald**.
   Während eines Unterrichts ist die Kopfzeile auf das Nötigste reduziert.

---

## Was die Seite macht

Klassenschwung macht gutes Arbeiten im Unterricht sichtbar. Jede Person
hat einen von drei Zuständen:

| Zustand | Darstellung | Zeit wird gespeichert |
| --- | --- | --- |
| Start | neutral grau | nein |
| Du arbeitest gut | helle Akzentfarbe | ja |
| Du arbeitest großartig | kräftige Akzentfarbe | ja |

„Start“ ist kein Urteil, sondern der Ausgangspunkt: Wer nicht angetippt
wurde, hat einfach noch keine Rückmeldung bekommen. Deshalb speichert die
App nur, wie lange jemand „gut“ oder „großartig“ gearbeitet hat.

Die Farben hängen von der gewählten **Farbwelt** ab: Standard ist
*Salbei* (gedämpftes Waldgrün), unter **Konto-Menü → Einstellungen** lassen
sich *Tafelgrün*, *Tinte* und *Bernstein* wählen. Die Wahl
wird im Konto gespeichert und gilt auf allen Geräten.

Beim Start eines Unterrichts wählt man eine von zwei Ansichten:

- **Kanban** – drei Spalten, alle Schüler starten links in „Start“
  und werden per **Drag & Drop** in die jeweils benachbarte Spalte
  verschoben – mit Maus, Touch oder Stift.
- **Sortierte Ansicht** – alle Schüler alphabetisch in einem Raster.
  Antippen der **linken** Boxhälfte schaltet einen Zustand zurück, die
  **rechte** Hälfte einen vor; die Position im Raster bleibt dabei fest,
  nur die Farbe wechselt. Im Header läuft eine Live-Zählung mit, z. B.
  „12 am Start | 5 arbeiten gut | 1 arbeitet großartig“.

Beide Ansichten sind nur unterschiedliche Darstellungen derselben Daten –
die App misst in beiden automatisch, **wie lange** jede Person „gut“ oder
„großartig“ gearbeitet hat, und die Auswertung macht keinen Unterschied
zwischen ihnen.

- Unter **Klasse → Auswertung** stehen je Person die Zeiten in „gut“ und
  „großartig“, die Zahl der Unterrichte und der Schnitt je Unterricht,
  alphabetisch sortiert – eine Rangliste gibt es bewusst nicht. Ein Name
  führt zu den Zeiten je Unterricht. Ein Unterricht zählt für eine Person,
  wenn sie dabei war (siehe „Wer ist da?“).
- **Exportieren** (Auswertung, Karte „Nach Schülerin / Schüler“): Übersicht
  als **PDF** oder **CSV** (Excel: Semikolon, Minuten mit Dezimalkomma) und
  alle Unterrichte als CSV, eine Zeile je Person und Unterricht. Auf der
  Seite einer Person gibt es dasselbe für sie allein. Die Dateien entstehen
  im Browser (`import-export.js`, PDF ohne fremde Bibliothek).
- Unterrichte werden mit ihren Zeiten **zum Schuljahresende** automatisch
  gelöscht (siehe unten).

Kurzablauf im Unterricht:

1. **Klassen** → Klasse anlegen → Schüler eintragen oder die
   **Klassenliste importieren** (siehe unten).
2. **Unterrichte** → *Unterricht starten* → Klasse wählen → Ansicht wählen
   (Kanban oder Sortiert).
3. Während der Stunde je nach Verhalten verschieben (Kanban) bzw. antippen
   (Sortierte Ansicht).
4. Am Ende **Unterricht beenden**, um die Zeitmessung zu stoppen – oder er
   endet automatisch (siehe unten).
5. Auswertung unter **Klassen** → Klasse → **Auswertung**.

### Wer ist da?

Im laufenden Unterricht oben **Wer ist da?** (mit Zähler, z. B. „23/25“).
Wer fehlt, wird angetippt und aus dem Unterricht genommen: Die Person
sammelt keine Zeit und der Unterricht zählt für sie in der Auswertung nicht
mit. Eine Abwesenheit wird **nicht gespeichert** – die Person steht dann
einfach nicht in diesem Unterricht. Schon gesammelte Zeit bleibt, z. B.
wenn jemand früher geht. Wer später kommt, wird wieder angetippt und
startet im Startzustand. Auch wer erst nach dem Start in die Klasse
eingetragen wurde, lässt sich so dazunehmen.

### Schlechtes WLAN

Antippen und Verschieben wirken sofort. Die Änderungen gehen über eine
Warteschlange (localStorage, nur IDs, Zustand und Zeitpunkt, keine Namen)
an den Server; ist die Verbindung weg, steht im Board „Keine Verbindung ·
2 Änderungen warten“, und die App sendet nach, sobald das WLAN wieder da
ist – auch nach dem Neuladen der Seite. Der Server trägt dabei den
Zeitpunkt des Antippens ein, nicht den des Nachsendens (höchstens
15 Minuten zurück). Gemessen wird nur, wie lange die Änderung schon
zurückliegt, deshalb spielt eine falsch gehende Geräteuhr keine Rolle.
Genauso werden im Fokus-Wald gepflanzte Bäume nachgesendet. Beenden lässt
sich ein Unterricht erst, wenn alles übertragen ist.

Für „Wer ist da?“ und die genauen Zeiten beim Nachsenden muss einmalig
`supabase/migrations/0009_presence_and_offline.sql` im Supabase SQL-Editor
ausgeführt werden (setzt 0008 voraus). Ohne sie funktioniert das Nachsenden
trotzdem, nur mit dem Zeitpunkt des Nachsendens.

---

## Klassenansicht (Beamer)

Im laufenden Unterricht oben **Klassenansicht** wählen:

- **Mit Namen** – alle sehen, wer gerade in welcher Gruppe ist (wie im
  Board, nur ohne Bedienung).
- **Nur Anzahl** – drei große Zahlen, wie viele in jeder Gruppe sind,
  ohne Namen.

Die Klassenansicht öffnet sich in einem eigenen Fenster, das man auf den
Beamer zieht (Bildschirm *erweitern*, nicht *spiegeln*) und mit
**Vollbild** groß macht. Bedient wird weiter im Board, z. B. auf dem
Tablet. Alternativ öffnet man auf dem Rechner am Beamer denselben
Unterricht und dort die Klassenansicht. Oben lässt sich jederzeit zwischen
„Mit Namen“ und „Nur Anzahl“ wechseln.

Änderungen kommen live an (Supabase Realtime). Zusätzlich lädt die Ansicht
alle 15 Sekunden, nach WLAN-Aussetzern und beim Zurückkehren in den Tab
neu; ist die Verbindung weg, steht das oben im Status.

Wird das Gerät nur gespiegelt, sieht die Klasse genau das, was die
Lehrkraft sieht – „Nur Anzahl“ braucht deshalb einen zweiten Bildschirm.

---

## Löschung zum Schuljahresende

Am **1. August** werden alle Unterrichte des abgelaufenen Schuljahres mit
ihren Zuständen und Zeiten gelöscht. Klassen, Schüler, Sitzplan und
Fokus-Wald bleiben. Das erledigt ein täglicher Job in der Datenbank
(`pg_cron`, Job `loesche-vergangene-schuljahre`); zusätzlich räumt die App
beim Anmelden die eigenen alten Unterrichte auf. Im Juli erinnert ein
Hinweis auf **Heute** und in der **Auswertung** daran, vorher zu
exportieren. Die Regel steht auch in der Auswertung, unter
**Einstellungen → Konto & Daten**, in der Datenschutzerklärung und in
§ 5 der Nutzungsbedingungen.

Einmalig muss dafür `supabase/migrations/0008_positive_only_and_yearly_purge.sql`
im Supabase SQL-Editor ausgeführt werden. Sie löscht dabei auch die bisher
gespeicherten Zeiten im Startzustand und schaltet Realtime für die
Klassenansicht ein.

---

## Stundenplan und automatisches Unterrichtsende

Unter **Konto-Menü → Einstellungen**. Wer nichts einrichtet, bei dem bleibt
alles wie gewohnt (außer dem 50-Minuten-Ende, siehe unten).

- **Stundenzeiten**: Beginn der 1. Stunde und dann der Tagesablauf als Folge
  von Stunden und Pausen mit Dauer in Minuten; die Uhrzeiten werden daraus
  berechnet. Eine Vorlage (6 × 45 min, Pausen nach der 2. und 4. Stunde)
  hilft beim Start.
- **Wochenplan**: Je Wochentag und Stunde eine Klasse auswählen.
  Aufeinanderfolgende Stunden derselben Klasse gelten als Doppelstunde.
- Ab 5 Minuten vor Stundenbeginn steht die Klasse überall zuerst: als
  **Jetzt**-Hinweis in der Kopfzeile, auf **Heute**, unter **+ Starten**, in
  der Klassenliste und beim Unterricht-Starten.

**Unterricht automatisch beenden** (gilt für Kanban und sortierte Ansicht):

| Einstellung | Wirkung |
| --- | --- |
| Spätestens 50 min nach dem Start (Standard) | eine Schulstunde + 5 min |
| Ende der Stunde laut Stundenplan + n min | z. B. 7a dienstags 11:00–11:45, n = 5 → Ende 11:50; ohne passende Stunde nach 50 min |
| Nicht nach Zeit beenden | läuft, bis man ihn selbst beendet |
| zusätzlich: beim Schließen der Seite | beendet die im Tab geöffneten Unterrichte; bloßes Neuladen setzt sie fort |

Das zeitliche Ende passiert auf dem Server: Ist die Seite zu, wird der
Unterricht beim nächsten Öffnen der App rückwirkend genau zum Endzeitpunkt
abgeschlossen, und die Auswertung zählt ohnehin nur bis dahin.
**Fortsetzen** setzt einen neuen Endzeitpunkt nach derselben Regel.

Einmalig muss dafür `supabase/migrations/0007_schedule_autoend.sql` im
Supabase SQL-Editor ausgeführt werden.

### Stundenplan importieren

**Einstellungen → Stundenplan importieren**: eine iCal-Datei (`.ics`) aus
WebUntis (eigenen Stundenplan einer Woche exportieren) oder aus einem
Kalender auswählen. Die App

- leitet die **Stundenzeiten** ab (Doppelstunden werden geteilt; Stunden,
  in denen man nie unterrichtet, werden vormittags aus den Lücken
  geschätzt und als „geschätzt“ markiert) – wer schon Stundenzeiten
  eingetragen hat, kann sie behalten,
- sortiert die Termine nach **Klassen**: Steht der Name einer vorhandenen
  Klasse im Termin, gilt sie; eine erkennbare Bezeichnung wie „8a“ oder
  „Q1“ wird als neue Klasse vorgeschlagen; Termine ohne Klasse
  (Aufsichten, Konferenzen) bleiben weg. Jede Zuordnung lässt sich ändern,
- zeigt die Woche zur Kontrolle und ersetzt erst nach **Übernehmen** den
  Wochenplan. Bei A-/B-Wochen gewinnt die häufigere Klasse.

Gelesen wird die Datei nur im Browser; gespeichert werden nur
Stundenzeiten und Wochenplan, keine Fächer, Räume oder Namen.

---

## Klassenliste importieren

Unter **Klassen** → Klasse → **Klassenliste importieren**: eine Datei
(CSV, Excel `.xlsx`, Text – z. B. die Schülerliste aus Untis/WebUntis)
auswählen oder Namen einfügen (etwa aus Excel kopiert).

- Spalten werden erkannt (Vorname/Rufname, Nachname/Familienname, Name,
  „Nachname, Vorname“, Klasse) und lassen sich in der Vorschau umstellen.
  Enthält die Datei mehrere Klassen, wählt man eine aus; passt eine zum
  Namen der Klasse in der App, ist sie vorgewählt.
- Gespeichert werden **nur Vornamen**. Gibt es einen Vornamen mehrfach,
  kommt der kürzeste eindeutige Anfang des Nachnamens dazu: „Lea M.“ und
  „Lea S.“, bei Müller und Maier „Lea Mü.“ und „Lea Ma.“.
- Namen, die es in der Klasse schon gibt, werden übersprungen. Höchstens
  60 neue Namen auf einmal.
- Nachnamen und alle anderen Angaben aus der Datei (z. B. Geburtsdaten)
  bleiben im Browser und werden nicht übertragen.

Ältere Excel-Dateien (`.xls`) bitte als `.xlsx` oder `.csv` speichern.

---

## Sitzplan

Unter **Klassen** → Klasse öffnen → **Sitzplan**.

- Oben liegen alle Schüler **ohne Platz**, darunter der Raum mit der
  **Tafel unten**.
- Tische werden per Maus oder Finger frei in den Raum gezogen. Neben, über
  oder unter einem anderen Tisch rasten sie **bündig ein**, auch wenn beim
  Loslassen noch eine kleine Lücke war – so entstehen Zweiertische,
  Reihen und Blöcke. Ohne direkten Nachbarn richtet sich ein Tisch an den
  Reihen und Spalten der übrigen Tische aus.
- **Antippen** dreht einen Tisch **hochkant** (und zurück). Hochkant
  stehende Tische rasten ebenfalls bündig an, z. B. an der Stirnseite
  einer Tischreihe oder mittig unter einem Zweiertisch.
- Auf einem belegten Tisch losgelassen, rutscht er auf den nächsten freien
  Nachbarplatz. Zurück in die Ablage ziehen gibt den Platz frei.
- **Rest automatisch platzieren** setzt alle Übrigen in Zweierreihen von
  vorne nach hinten, **Alle leeren** räumt den Raum.

Einmalig müssen dafür `supabase/migrations/0004_seating.sql` und
`0005_seat_rotation.sql` im Supabase SQL-Editor ausgeführt werden.

---

## Fokus-Wald (Lautstärke-Monitor)

Für Stillarbeit auf dem Beamer, aufgebaut wie
[Mio's Monster Meter](https://sleepy-mio.classroomzen.com/) – nur mit einem
Baum statt eines Monsters, damit es auch bei älteren Klassen zieht.

| Lautstärke | Wirkung |
| --- | --- |
| ruhig (grün) | Timer läuft, der Baum wächst |
| unruhig (gelb) | Timer pausiert |
| zu laut (rot, länger als ca. 1,5 s) | Baum vertrocknet, ein neuer Samen startet |

- Jeder erreichte Timer pflanzt den Baum dauerhaft im **Wald der Klasse**.
  Während der Fokus-Phase steht der bisherige Wald der Klasse blass im
  Hintergrund.
- Jedes Ziel hat eine eigene heimische Baumart mit **Steckbrief** (Höhe,
  Alter, ein Fakt zum Vorlesen). Wie in einem echten Wald kommen zuerst die
  schnell wachsenden Pionierbäume, zuletzt die langsamen Riesen:

  | Ziel | Baum |
  | --- | --- |
  | 3 min | Hänge-Birke |
  | 5 min | Vogelkirsche |
  | 10 min | Berg-Ahorn |
  | 15 min | Gemeine Fichte |
  | 20 min | Rotbuche |
  | 30 min | Stiel-Eiche |
  | 45 min | Riesenmammutbaum |

  Der Fakt zur aktuellen Art steht während der Fokus-Phase dezent unter dem
  Timer und beim Pflanzen in der Erfolgsmeldung.
- Ziel **Offen**: Der Timer zählt hoch, der Baum wird an den Schwellen oben
  zur nächsten Art. Mit **Baum pflanzen** (ab 3 min) wird er mit der
  erreichten Zeit gepflanzt. Wird es ab 3 min zu laut, vertrocknet der Baum
  nicht, sondern die zuletzt erreichte Stufe wird gepflanzt und ein neuer
  Samen startet.
- Die Klassen werden in einem **Ranking** nach Fokus-Minuten verglichen.
- **Alle Wälder erkunden** (Fokus-Wald → oben rechts): alle Klassenwälder
  nebeneinander in einer Landschaft, jeweils mit Schild über dem Wald. Die
  größten, am längsten erarbeiteten Bäume stehen hinten in der Mitte, die
  schnell gewachsenen vorne am Rand. Seitlich wischen oder mit der Maus
  ziehen, um durch die Wälder zu gehen; ein angetippter Baum zeigt seinen
  Steckbrief. Darunter steht das **Baum-Lexikon** mit allen Arten.
- Pro Klasse lässt sich eine **Belohnung** festlegen, z. B. „bei 20 Bäumen:
  Musik in der Stillarbeit“.
- Beim Erklären auf **Pause** tippen (oder Leertaste), damit die eigene
  Stimme nicht mitzählt. Die Empfindlichkeit lässt sich im *Probelauf ohne
  Klasse* einstellen.

Das Mikrofon misst nur die Lautstärke direkt im Browser – es wird nichts
aufgenommen, gespeichert oder übertragen. Gespeichert wird nur der fertige
Baum. Einmalig muss dafür `supabase/migrations/0003_focus.sql` im Supabase
SQL-Editor ausgeführt werden.

---

## Datenschutz & Rechtliches

- **Impressum**, **Datenschutzerklärung** und **Nutzungsbedingungen**
  (inkl. Vereinbarung zur Auftragsverarbeitung nach Art. 28 DSGVO für
  Schulen) liegen als `impressum.html`, `datenschutz.html` und
  `nutzungsbedingungen.html` im Repo und sind im Footer jeder Seite verlinkt.
  Platzhalter wie `{{NAME}}` lassen den Deploy (Netlify-`build.sh`)
  bewusst abbrechen.
- **Offen:** Name, Anschrift, E-Mail und Telefon des Anbieters stehen noch als
  „[wird ergänzt]“ in Impressum, Datenschutzerklärung, Nutzungsbedingungen und
  `docs/verarbeitungsverzeichnis.md`. Die Seite läuft bisher nicht öffentlich
  oder kommerziell; **vor einer öffentlichen Nutzung ausfüllen.** Jeder Deploy
  gibt dazu eine Warnung aus.
- Bei der Registrierung müssen die Nutzungsbedingungen akzeptiert werden;
  Fassung und Zeitpunkt landen in den `user_metadata` des Kontos.
- Unter **Einstellungen → Konto & Daten** lassen sich alle Daten als JSON
  exportieren und das Konto samt aller Daten löschen. Für die Löschung muss
  einmalig `supabase/migrations/0006_delete_account.sql` im Supabase
  SQL-Editor ausgeführt werden.
- Beim Seitenaufruf werden keine fremden Server kontaktiert: Schrift
  (`fonts/`) und Supabase-Bibliothek (`vendor/`) liegen im Repo. hCaptcha
  wird nur geladen, wenn `HCAPTCHA_SITE_KEY` gesetzt ist – dann vorher in
  `datenschutz.html` ergänzen.
- **Sicherheit:** Jede Seite hat eine Content-Security-Policy (`<meta>` im
  Kopf): Skripte nur von hier, Verbindungen nur zu Supabase. Inline-Skripte
  sind deshalb tabu, neue Skripte als eigene Datei einbinden. Netlify
  liefert zusätzlich die Header aus `_headers`; in einem fremden Frame
  startet die App nicht (Schutz vor Clickjacking).
- Das interne Verzeichnis von Verarbeitungstätigkeiten (Art. 30 DSGVO)
  liegt in `docs/verarbeitungsverzeichnis.md`. Bei neuen Funktionen, die
  Daten speichern, diese Datei und `datenschutz.html` mitpflegen.


Erweitertungen:

Yt video geben -> Fragebogen/Quiz daraus erstellen

---

## Privat oder öffentlich

**Derzeit: öffentliche Startseite, Konten nur auf Einladung.** Startseite,
Fokus-Wald und Probe-Unterricht sind für alle offen; anmelden können nur
Personen, denen der Betreiber einen Zugang angelegt hat.

> **Achtung Impressum:** Mit der öffentlichen Startseite und den Funktionen
> ohne Anmeldung ist die Seite ein Angebot an Dritte und dient nicht mehr
> ausschließlich persönlichen oder familiären Zwecken. Die Ausnahme nach
> § 18 Abs. 1 MStV, auf die `impressum.html` sich beruft, greift dann nicht
> mehr – Name und ladungsfähige Anschrift gehören ins Impressum (oder ein
> Impressum-Service mit c/o-Adresse, oder eine Organisation betreibt die
> Seite). Siehe Schritt 4 unten.

- Startseite `index.html` ist die normale Produktseite, weiterhin mit
  `noindex` (nicht in Suchmaschinen).
- In der App ist die Registrierung aus (`SIGNUP_OPEN = false` in `app.js`).
- **Wichtig:** Im Supabase-Dashboard unter *Authentication → Sign In / Providers*
  muss „Allow new users to sign up“ **aus** sein. Sonst ginge eine
  Registrierung weiterhin direkt über die API.
- **Zugang vergeben:** Supabase-Dashboard → *Authentication → Users → Add
  user → Create new user*, E-Mail und Passwort eintragen, „Auto Confirm
  User“ anhaken, Zugangsdaten persönlich weitergeben. Beim ersten Login
  bestätigt die Person die Nutzungsbedingungen.

**Ganz öffentlich machen** (z. B. wenn das Projekt größer wird):

1. ~~Öffentliche Startseite zurückholen~~ – erledigt (die alte Fassung liegt
   im Tag `startseite-oeffentlich`).
2. `SIGNUP_OPEN = true` in `app.js`, in Supabase „Allow new users to sign up“
   einschalten.
3. `noindex` aus den HTML-Seiten und `X-Robots-Tag` aus `_headers` entfernen.
4. Impressum (Name, ladungsfähige Anschrift, Kontakt) und den Verantwortlichen
   in Datenschutzerklärung und Nutzungsbedingungen eintragen. Alternativ
   betreibt eine Organisation (z. B. Schule oder Förderverein) das Angebot,
   dann stehen deren Angaben im Impressum.

