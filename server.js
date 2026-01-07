// server.js
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DB_PATH = path.join(__dirname, "bookings.sqlite");
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      laundry_room TEXT NOT NULL,
      start_iso TEXT NOT NULL,
      end_iso TEXT NOT NULL,
      name TEXT NOT NULL,
      apartment TEXT NOT NULL,
      phone TEXT,
      pin TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(laundry_room, start_iso)
    )
  `);
});

function isValidIso(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

const CONFIG = {
  rooms: ["Vaskeri"],
  daysForward: 14,
  maxActivePerApartment: 1,
  timeSlots: [
    { label: "06:00–10:00", start: "06:00", end: "10:00" },
    { label: "10:00–14:00", start: "10:00", end: "14:00" },
    { label: "14:00–18:00", start: "14:00", end: "18:00" },
    { label: "18:00–22:00", start: "18:00", end: "22:00" },
  ],
  rules: [
    "Ikke skriv dere på lista mer enn en gang – altså må dere ha vasket ferdig før dere skriver dere opp på ny.",
    "Sørg for at dere legger på nok penger slik at maskinene ikke stopper før vasken er klar.",
    "Ta en titt i såpekoppene etter vask og fjern overflødige såperester.",
    "Gjør rent gummene hvis disse har vært brukt.",
    "Gjør rent lofilteret i tørketrommelen.",
    "OG TILSLUTT – vask gulvene etter dere!!",
  ],
};

function dateToYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localDateTimeToIso(dateStr, hhmm) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
  return dt.toISOString();
}

function buildSlotsForDate(dateStr, room) {
  return CONFIG.timeSlots.map((t) => ({
    room,
    label: t.label,
    start_iso: localDateTimeToIso(dateStr, t.start),
    end_iso: localDateTimeToIso(dateStr, t.end),
  }));
}

function clampBookingHorizon(dateStr) {
  const today = new Date();
  const min = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const max = new Date(min.getTime() + CONFIG.daysForward * 24 * 60 * 60 * 1000);

  const [y, m, d] = dateStr.split("-").map(Number);
  const chosen = new Date(y, m - 1, d);

  if (chosen < min) return { ok: false, error: "Dato kan ikke være i fortiden." };
  if (chosen > max) return { ok: false, error: `Dato er for langt frem i tid (maks ${CONFIG.daysForward} dager).` };
  return { ok: true };
}

app.get("/api/config", (req, res) => {
  res.json(CONFIG);
});

app.get("/api/slots", (req, res) => {
  const date = req.query.date;
  const room = req.query.room;

  if (!date || !room) return res.status(400).json({ error: "date og room kreves" });
  if (!CONFIG.rooms.includes(room)) return res.status(400).json({ error: "Ukjent vaskeri" });

  const horizon = clampBookingHorizon(date);
  if (!horizon.ok) return res.status(400).json({ error: horizon.error });

  const allSlots = buildSlotsForDate(date, room);

  db.all(
    `SELECT id, laundry_room, start_iso, end_iso, name, apartment FROM bookings
     WHERE laundry_room = ? AND start_iso >= ? AND start_iso < ?`,
    [
      room,
      new Date(`${date}T00:00:00`).toISOString(),
      new Date(`${date}T23:59:59`).toISOString(),
    ],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB-feil" });

      const bookedMap = new Map(rows.map((r) => [r.start_iso, r]));
      const result = allSlots.map((s) => {
        const b = bookedMap.get(s.start_iso);
        return b
          ? { ...s, status: "booked", booking: { id: b.id, name: b.name, apartment: b.apartment } }
          : { ...s, status: "free" };
      });

      res.json(result);
    }
  );
});

app.post("/api/book", (req, res) => {
  const { room, start_iso, end_iso, name, apartment, phone, pin, accepted_rules } = req.body || {};

  if (!CONFIG.rooms.includes(room)) return res.status(400).json({ error: "Ukjent vaskeri" });
  if (!isValidIso(start_iso) || !isValidIso(end_iso)) return res.status(400).json({ error: "Ugyldig tid" });

  // Lås bookinger for "i dag" etter kl. 18:00 (serverens lokal tid)
  const now = new Date();
  const lockHour = 18;
  const start = new Date(start_iso);
  const isSameDay =
    start.getFullYear() === now.getFullYear() &&
    start.getMonth() === now.getMonth() &&
    start.getDate() === now.getDate();
  if (isSameDay && now.getHours() >= lockHour) {
    return res.status(403).json({
      error: "Booking for i dag er låst etter kl. 18:00. Prøv en annen dato.",
    });
  }

  if (!name || !apartment || !pin) return res.status(400).json({ error: "Navn, leilighetsnr og kode kreves" });
  if (!accepted_rules) return res.status(400).json({ error: "Du må godta reglene før du kan booke." });

  const nowIso = new Date().toISOString();
  db.get(
    `SELECT COUNT(*) AS cnt FROM bookings WHERE apartment = ? AND start_iso > ?`,
    [apartment.trim(), nowIso],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB-feil" });

      if ((row?.cnt || 0) >= CONFIG.maxActivePerApartment) {
        return res.status(409).json({
          error: "Du har allerede en aktiv booking. Avbestill den før du booker på nytt.",
        });
      }

      db.run(
        `INSERT INTO bookings (laundry_room, start_iso, end_iso, name, apartment, phone, pin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [room, start_iso, end_iso, name.trim(), apartment.trim(), phone?.trim() || null, String(pin).trim()],
        function (err2) {
          if (err2) {
            if (String(err2.message || "").includes("UNIQUE")) {
              return res.status(409).json({ error: "Tiden ble akkurat booket av noen andre." });
            }
            return res.status(500).json({ error: "DB-feil" });
          }
          res.json({ ok: true, id: this.lastID });
        }
      );
    }
  );
});

app.get("/api/my-bookings", (req, res) => {
  const pin = (req.query.pin || "").trim();
  if (!pin) return res.status(400).json({ error: "Kode kreves" });

  db.all(
    `SELECT id, laundry_room, start_iso, end_iso, name, apartment
     FROM bookings
     WHERE pin = ?
     ORDER BY start_iso ASC`,
    [pin],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB-feil" });
      res.json(rows);
    }
  );
});

app.post("/api/cancel", (req, res) => {
  const { id, pin } = req.body || {};
  if (!id || !pin) return res.status(400).json({ error: "id og kode kreves" });

  db.run(`DELETE FROM bookings WHERE id = ? AND pin = ?`, [id, String(pin).trim()], function (err) {
    if (err) return res.status(500).json({ error: "DB-feil" });
    if (this.changes === 0) return res.status(403).json({ error: "Feil kode eller booking finnes ikke." });
    res.json({ ok: true });
  });
});

app.get("/api/today", (req, res) => {
  res.json({ ymd: dateToYmd(new Date()) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveren kjører på http://localhost:${PORT}`));