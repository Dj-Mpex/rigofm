# Rigo FM

**Tune in. Vote up.**

Eine selbstgehostete Party-Jukebox für den Rigo-Partykeller. Gäste scannen einen QR-Code, durchsuchen YouTube, fügen Songs zur Queue hinzu und voten gegenseitig hoch oder runter. Am TV läuft das jeweilige Musikvideo mit Anzeige des Wishers und der Vote-Zahl.

## Identität

- **Location:** Rigo (Partykeller)
- **Resident DJ:** Dj-Mpex
- **Tagline:** Tune in. Vote up.

## Features

- QR-Code-Onboarding für Gäste (kein Login nötig)
- YouTube-Suche und Voll-Video-Playback am TV
- Up-/Downvoting mit Score-basiertem Queue-Ranking
- Max. 5 Vote-Aktionen pro Gast pro Song (Anti-Spam)
- Admin-Panel zum Verschieben/Entfernen von Songs
- Live-Updates auf allen Clients (TV + alle Gäste-Phones)

## Tech-Stack

- **Backend:** Node.js + Express
- **Realtime:** Socket.io
- **DB:** SQLite (better-sqlite3)
- **Frontend:** Vanilla JS + Tailwind CSS
- **Player:** YouTube IFrame Player API
- **Container:** Docker Compose

## Status

🚧 In Entwicklung
