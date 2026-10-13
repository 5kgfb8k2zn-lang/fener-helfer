# Fener-Helfer einrichten (Push-Nachrichten bei geschlossener App)

## Der schnelle Weg: nur mit dem iPhone (ca. 5 Minuten)
1. **ntfy** aus dem App Store installieren.
2. Diesen Link in Safari öffnen (oder in der Fener-App unter Live → „Helfer bei Cloudflare einrichten“ tippen):
   https://deploy.workers.cloudflare.com/?url=https://github.com/5kgfb8k2zn-lang/Fener-Simulator-/tree/claude/fenerbahce-football-simulation-vo094a/helfer
3. Mit GitHub anmelden bzw. ein kostenloses Cloudflare-Konto anlegen.
4. Im Formular:
   - **API_KEY**: deinen Schlüssel von api-football.com einfügen
   - **NTFY_TOPIC**: den vorgeschlagenen Namen so lassen
   - Datenbank und Namen so lassen wie vorgeschlagen
5. **Create and deploy** tippen und 1–2 Minuten warten.
6. Die angezeigte Adresse (`…workers.dev`) öffnen. Auf der Seite **„In ntfy abonnieren“** und **„Test-Nachricht senden“** tippen.
7. **„Adresse kopieren“** tippen, in der Fener-App unter Live → Hintergrund-Helfer einfügen → Speichern.

Cloudflare legt dabei eine Kopie des Helfers in deinem GitHub-Konto an. Von dort spielt Cloudflare künftige Änderungen automatisch ein.

---

## Der Weg von Hand

Der Helfer ist ein kleines Programm bei Cloudflare. Es läuft jede Minute, fragt aber nur rund um Fener-Spiele bei API-Football nach. Bei Anpfiff, Toren, Roten Karten, Halbzeit und Abpfiff schickt es dir eine Push-Nachricht über die App **ntfy**. Deine Fener-App holt sich alles vom Helfer und verbraucht selbst keine Anfragen mehr.

Kosten: 0 € (Cloudflare Free-Plan, ntfy kostenlos, API-Football Free-Plan).
Dauer: ca. 15 Minuten. Am besten am Computer, am iPhone geht es aber auch.

---

## 1. ntfy aufs iPhone (2 Minuten)
1. App **ntfy** aus dem App Store installieren.
2. Öffnen → **+** → bei „Topic“ deinen geheimen Kanalnamen eintragen (siehe unten bzw. im Chat) → **Subscribe**.
3. Mitteilungen erlauben.

> Der Kanalname ist wie ein Passwort: Wer ihn kennt, kann deine Nachrichten mitlesen. Gib ihn nicht weiter.

## 2. Cloudflare-Konto (2 Minuten)
1. **dash.cloudflare.com/sign-up** öffnen, mit E-Mail registrieren, E-Mail bestätigen.
2. Es wird keine eigene Domain gebraucht. Fragen danach kannst du überspringen.

## 3. Datenbank anlegen (1 Minute)
1. Im Menü links: **Storage & databases** → **D1 SQL database**.
2. **Create** → Name: `fener` → **Create**.

## 4. Worker anlegen (3 Minuten)
1. Im Menü links: **Compute (Workers)** → **Workers & Pages** → **Create**.
2. **Start with Hello World!** (oder „Create Worker“) → Name: `fener-helfer` → **Deploy**.
3. Auf **Edit code** tippen.
4. Den ganzen Beispielcode löschen und den Code aus `helfer/fener-helfer.js` einfügen.
   Direkt kopieren kannst du ihn hier:
   https://raw.githubusercontent.com/5kgfb8k2zn-lang/Fener-Simulator-/claude/fenerbahce-football-simulation-vo094a/helfer/fener-helfer.js
5. Oben rechts **Deploy**.

## 5. Einstellungen des Workers (5 Minuten)
Zurück zur Übersicht des Workers `fener-helfer` → Reiter **Settings**:

**a) Datenbank verbinden**
- **Bindings** → **Add** → **D1 database**
- Variable name: `DB` (genau so, in Großbuchstaben)
- D1 database: `fener` → **Add Binding** / **Deploy**

**b) Geheime Werte**
- **Variables and Secrets** → **Add**
- Type **Secret**, Name `API_KEY`, Value: dein Schlüssel von api-football.com
- Noch einmal **Add**: Type **Secret**, Name `NTFY_TOPIC`, Value: dein Kanalname aus Schritt 1
- Optional: Type **Text**, Name `APP_URL`, Value `https://5kgfb8k2zn-lang.github.io/Fener-Simulator-/` (dann öffnet ein Tipp auf die Nachricht die App)
- **Deploy**

**c) Jede Minute laufen lassen**
- **Trigger Events** (oder „Triggers“) → **Add** → **Cron Triggers**
- „Every minute“ wählen bzw. `* * * * *` eintragen → **Add** / **Deploy**

## 6. Prüfen
1. In der Übersicht des Workers steht seine Adresse, z. B. `https://fener-helfer.DEINNAME.workers.dev`. Öffne sie im Browser.
   Es sollte „Fener-Helfer läuft“ erscheinen.
2. Eine Minute warten, dann `…workers.dev/state` öffnen. Dort sollten jetzt Spiele (`fixtures`) stehen und `"error": ""`.

## 7. App verbinden
1. Fener-App öffnen → Tab **Live** → nach unten zu **Hintergrund-Helfer**.
2. Adresse des Workers einfügen → **Speichern**.
3. **Test-Nachricht senden** → nach ein paar Sekunden kommt die Nachricht in ntfy.

Fertig! Ab jetzt bekommst du bei jedem Fener-Spiel Push-Nachrichten, auch wenn die App zu ist.

---

## Wenn etwas nicht klappt
- **`/state` zeigt `"error": "API_KEY fehlt"`**: Schritt 5b prüfen, danach **Deploy** nicht vergessen.
- **„Datenbank-Bindung DB fehlt“**: Schritt 5a, der Name muss genau `DB` sein.
- **Keine Spiele nach ein paar Minuten**: Schritt 5c prüfen (Cron). Unter **Logs** im Worker siehst du Fehlermeldungen.
- **Test-Nachricht kommt nicht an**: Ist der Kanalname in ntfy und in `NTFY_TOPIC` exakt gleich? Mitteilungen für ntfy erlaubt?

## Alternative: automatisch einrichten lassen
Mit `helfer/deploy.sh` richtet ein Befehl alles ein (Datenbank, Worker, Cron, geheime Werte). Dafür braucht es die Umgebungsvariablen `CLOUDFLARE_API_TOKEN` (Rechte: Workers Scripts bearbeiten, D1 bearbeiten), `CLOUDFLARE_ACCOUNT_ID`, `API_FOOTBALL_KEY` und `NTFY_TOPIC`. Mit denselben Variablen spielt das Skript später auch Updates des Helfers ein.

## Updates
Die Fener-App selbst aktualisiert sich automatisch. Den Helfer-Code musst du nur neu einfügen (Schritt 4.3 bis 4.5), wenn Claude ausdrücklich sagt, dass sich der Helfer geändert hat.
