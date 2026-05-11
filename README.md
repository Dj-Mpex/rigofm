# Rigo FM

**Tune in. Vote up.**

Eine selbstgehostete Party-Jukebox für den Rigo-Partykeller. Gäste scannen einen QR-Code, durchsuchen YouTube, fügen Songs zur Queue hinzu und voten gegenseitig hoch oder runter. Am TV läuft das jeweilige Musikvideo mit Anzeige des Wishers und der Vote-Zahl.

## Identität

- **Location:** Rigo (Partykeller)
- **Resident DJ:** Dj-Mpex
- **Tagline:** Tune in. Vote up.

---

## Features

### Für Gäste
- QR-Code-Onboarding (keine Registrierung, kein App-Download)
- YouTube-Suche nach Songs und Musikvideos
- Up-/Downvoting (1 Vote pro Gast pro Song, switchbar)
- Eigene Songs als "Du"-Markierung
- "Meine Tracks"-Tab für eigene Wünsche
- Konfetti, wenn der eigene Song auf #1 landet
- Auto-Reconnect bei Netzwerk-Hicksern
- Party-Emoji statt Initialen-Avatar

### Für den Admin (DJ)
- Passwort-geschützter Admin-Bereich
- Session starten/beenden
- Live-Gästeliste mit Track- und Vote-Counts
- Anti-Abuse: Duplikat-Erkennung pro Device
- Queue per Drag & Drop sortieren
- Tracks löschen oder manuell starten
- Floating Player-Bar (Spotify-Style): Play/Pause, Skip, Volume, Mute, Force-Filler
- Filler-Playlist konfigurierbar (YouTube-Playlist-ID)

### TV-Anzeige
- Großes Musikvideo links + Live-Queue rechts
- "Now Playing"-Card mit Wisher-Name + Emoji
- QR-Code permanent sichtbar für neue Gäste
- Auto-Advance: nächster Track startet automatisch
- Idle-Filler-Playlist (Lo-Fi default), wenn Queue leer ist
- DJ-Style Fade-Out/Fade-In beim Übergang von Filler zu Gäste-Song
- "Tap to tune in"-Startscreen (umgeht Browser-Autoplay-Blocker)

### Anti-Abuse
- Device-ID via LocalStorage: ein Browser = ein Gast pro Session
- Name-Unique-Check pro Session (case-insensitive)
- Gast kann eigene Songs nicht voten (verhindert Self-Push)
- Max 10 queued Tracks pro Gast gleichzeitig
- Keine Duplikate in der aktuellen Queue

---

## Tech-Stack

- **Backend:** Node.js 20 + Express
- **Realtime:** Socket.io
- **Datenbank:** SQLite (better-sqlite3)
- **Frontend:** Vanilla JS + Tailwind-loses Custom CSS
- **YouTube:** Data API v3 (Suche) + IFrame Player API (Wiedergabe)
- **Container:** Docker Compose
- **QR-Codes:** `qrcode`-Bibliothek (serverseitig generiert)

---

## URLs

| Pfad | Wer | Was |
|------|-----|-----|
| `/` | Gäste | Guest-View (auch via `/join/CODE`) |
| `/join/CODE` | Gäste | Direkter Einstieg per QR |
| `/admin` | DJ | Admin-Panel (Passwort nötig) |
| `/tv` | DJ | Vollbild-Display für den TV |
| `/health` | – | Health-Check (JSON) |
| `/api/*` | intern | REST-Endpoints |

---

## Setup (Entwicklung)

### Voraussetzungen
- Node.js >= 20
- YouTube Data API Key ([Anleitung](https://console.cloud.google.com/apis/library/youtube.googleapis.com))

### Installation

```bash
git clone https://github.com/Dj-Mpex/rigofm.git
cd rigofm
npm install
cp .env.example .env
# .env befüllen (YOUTUBE_API_KEY, ADMIN_PASSWORD, SESSION_SECRET)
npm run dev
```

Server läuft auf `http://localhost:3002`

---

## Setup (Produktion mit Docker)

```bash
cp .env.example .env
# .env befüllen
docker compose up -d --build
```

SQLite-Daten werden im Docker-Volume `rigofm_data` persistiert.

### Env-Variablen

| Variable | Pflicht | Beschreibung |
|----------|---------|--------------|
| `YOUTUBE_API_KEY` | ✅ | YouTube Data API v3 Key |
| `ADMIN_PASSWORD` | ✅ | Passwort für das Admin-Panel |
| `SESSION_SECRET` | ✅ | Secret für Express-Sessions |
| `PORT` | – | HTTP-Port (default: 3002) |
| `FILLER_PLAYLIST_ID` | – | YouTube-Playlist-ID für Idle-Filler |

---

## Projektstruktur

```
rigofm/
├── src/
│   ├── server.js          # Express + Socket.io Setup
│   ├── db/database.js     # SQLite Setup & Migrations
│   ├── routes/
│   │   ├── sessions.js    # Session & Guest Management
│   │   ├── tracks.js      # Queue, Voting, Playback-State
│   │   ├── youtube.js     # YouTube Search API
│   │   └── settings.js    # Filler-Playlist Config
│   └── sockets/index.js   # Socket.io Events & Relay
├── public/
│   ├── css/               # tokens.css, guest.css, admin.css, tv.css
│   ├── js/                # guest.js, admin.js, tv.js
│   └── img/               # Logo, Assets
├── views/
│   ├── guest/index.html
│   ├── admin/index.html
│   └── tv/index.html
├── data/                  # SQLite DB (gitignored)
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Lizenz

Privates Projekt — Dj-Mpex / Rigo Partykeller.
