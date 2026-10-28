const admin = require("firebase-admin");

// Your league name -> the API's competition code.
// Saudi Pro League is not on the free plan, so it stays manual in the console.
const LEAGUES = [
  { code: "PL", name: "Premier League" },
  { code: "PD", name: "La Liga" },
  { code: "BL1", name: "Bundesliga" },
  { code: "SA", name: "Serie A" },
  { code: "FL1", name: "Ligue 1" },
  { code: "DED", name: "Eredivisie" },
  { code: "ELC", name: "Championship" },
  { code: "CL", name: "Champions League" },
  { code: "PPL", name: "Primeira Liga" },
  { code: "BSA", name: "Brazil Serie A" },
  { code: "EC", name: "European Championship" },
  { code: "WC", name: "World Cup" },
];

// The leagues the app lists. Created only if missing, never overwritten.
// A league with logo: null shows a letter circle until you add a logoUrl.
const LOGO_BASE =
  "https://raw.githubusercontent.com/Collins149/foota-assets/main/";
const LEAGUE_DOCS = [
  { id: "premier-league", name: "Premier League", country: "England", sortOrder: 1, logo: "premier-league.png" },
  { id: "la-liga", name: "La Liga", country: "Spain", sortOrder: 2, logo: "la-liga.png" },
  { id: "bundesliga", name: "Bundesliga", country: "Germany", sortOrder: 3, logo: "bundesliga.png" },
  { id: "serie-a", name: "Serie A", country: "Italy", sortOrder: 4, logo: "serie-a.png" },
  { id: "ligue-1", name: "Ligue 1", country: "France", sortOrder: 5, logo: "ligue-1.png" },
  { id: "eredivisie", name: "Eredivisie", country: "Netherlands", sortOrder: 6, logo: "eredivisie.png" },
  { id: "saudi-pro-league", name: "Saudi Pro League", country: "Saudi Arabia", sortOrder: 7, logo: "saudi-pro-league.png" },
  { id: "championship", name: "Championship", country: "England", sortOrder: 8, logo: null },
  { id: "champions-league", name: "Champions League", country: "Europe", sortOrder: 9, logo: null },
  { id: "primeira-liga", name: "Primeira Liga", country: "Portugal", sortOrder: 10, logo: null },
  { id: "brazil-serie-a", name: "Brazil Serie A", country: "Brazil", sortOrder: 11, logo: null },
  { id: "european-championship", name: "European Championship", country: "Europe", sortOrder: 12, logo: null },
  { id: "world-cup", name: "World Cup", country: "World", sortOrder: 13, logo: null },
];

// Synced matches older than this many days are removed
const KEEP_DAYS = 3;

// The free plan allows 10 calls per minute, so wait between leagues
const PAUSE_MS = 7000;

const API_KEY = process.env.FOOTBALL_DATA_KEY;
const SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!API_KEY || !SERVICE_ACCOUNT) {
  console.error("Missing FOOTBALL_DATA_KEY or FIREBASE_SERVICE_ACCOUNT secret.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(SERVICE_ACCOUNT)),
});
const db = admin.firestore();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// The API's status words -> yours
function mapStatus(status) {
  switch (status) {
    case "SCHEDULED":
    case "TIMED":
      return { status: "UPCOMING", minute: "" };
    case "IN_PLAY":
      return { status: "LIVE", minute: "In play" };
    case "PAUSED":
      return { status: "LIVE", minute: "HT" };
    case "FINISHED":
    case "AWARDED":
      return { status: "FINISHED", minute: "FT" };
    default:
      return { status: "POSTPONED", minute: "" };
  }
}

async function fetchLeague(code, from, to) {
  const url =
    `https://api.football-data.org/v4/competitions/${code}/matches` +
    `?dateFrom=${from}&dateTo=${to}`;
  const response = await fetch(url, { headers: { "X-Auth-Token": API_KEY } });
  if (!response.ok) {
    throw new Error(`${code}: HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.matches || [];
}

// Creates any league document that is missing. Existing ones are left alone,
// so anything you edit in the console is kept.
async function restoreLeagues() {
  let created = 0;
  for (const league of LEAGUE_DOCS) {
    const ref = db.collection("leagues").doc(league.id);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        name: league.name,
        country: league.country,
        sortOrder: league.sortOrder,
        logoUrl: league.logo ? LOGO_BASE + league.logo : "",
      });
      created++;
    }
  }
  console.log(`Leagues: created ${created} missing leagues.`);
}

// Deletes synced matches (ids starting with fd_) that kicked off long ago.
// Hand-made matches are never touched.
async function cleanup() {
  const cutoff = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000)
  );

  const snapshot = await db
    .collection("matches")
    .where("kickoff", "<", cutoff)
    .get();

  const oldSynced = snapshot.docs.filter((doc) => doc.id.startsWith("fd_"));

  for (let i = 0; i < oldSynced.length; i += 400) {
    const batch = db.batch();
    oldSynced.slice(i, i + 400).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  console.log(`Cleanup: removed ${oldSynced.length} old synced matches.`);
}

async function main() {
  try {
    await restoreLeagues();
  } catch (error) {
    console.error(`Restoring leagues failed: ${error.message}`);
  }

  const today = new Date();
  const from = isoDate(new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000));
  const to = isoDate(new Date(today.getTime() + 8 * 24 * 60 * 60 * 1000));

  let written = 0;
  let failedLeagues = 0;

  for (const league of LEAGUES) {
    try {
      const matches = await fetchLeague(league.code, from, to);
      const batch = db.batch();
      let count = 0;

      for (const m of matches) {
        const home = (m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name)) || null;
        const away = (m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name)) || null;
        if (!m.id || !home || !away) continue;

        const { status, minute } = mapStatus(m.status);
        const fullTime = (m.score && m.score.fullTime) || {};

        // Only these fields are written. streamUrl, posterUrl and views are
        // never touched, so the links and posters you add by hand are kept.
        const ref = db.collection("matches").doc(`fd_${m.id}`);
        batch.set(
          ref,
          {
            homeTeam: home,
            awayTeam: away,
            homeScore: fullTime.home ?? 0,
            awayScore: fullTime.away ?? 0,
            status,
            minute,
            league: league.name,
            kickoff: admin.firestore.Timestamp.fromDate(new Date(m.utcDate)),
          },
          { merge: true }
        );
        count++;
      }

      if (count > 0) await batch.commit();
      written += count;
      console.log(`${league.name}: saved ${count} matches`);
    } catch (error) {
      failedLeagues++;
      console.error(`${league.name} failed: ${error.message}`);
    }

    await sleep(PAUSE_MS);
  }

  try {
    await cleanup();
  } catch (error) {
    console.error(`Cleanup failed: ${error.message}`);
  }

  console.log(`Done. ${written} matches saved, ${failedLeagues} leagues failed.`);
  if (failedLeagues === LEAGUES.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
