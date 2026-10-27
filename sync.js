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
];

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

async function main() {
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

    // Stay well under the free plan's 10 calls per minute
    await sleep(1500);
  }

  console.log(`Done. ${written} matches saved, ${failedLeagues} leagues failed.`);
  if (failedLeagues === LEAGUES.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
