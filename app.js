const firebaseConfig = {
  apiKey: "AIzaSyAdPOOOWm-yTwWl-n5J7qoQ3k2cc1Y38_8",
  authDomain: "worldcup2026-swed.firebaseapp.com",
  projectId: "worldcup2026-swed",
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

const ADMIN_UID = "e7mwX6VnBLXS5e4U9ypw4ERxvjE3";

function isAdminUser(user) {
  return user && user.uid === ADMIN_UID;
}

let toastInstance = null;
let supportEditAllowed = true;
const matchDataCache = {}; // matchId -> match document data

function updateSupportEditAllowed(allowed) {
  supportEditAllowed = allowed;
  const note = document.getElementById("support-note");
  const controls = document.getElementById("support-edit-controls");

  if (note) {
    note.style.display = allowed ? "" : "none";
  }
  if (controls) {
    controls.style.display = allowed ? "flex" : "none";
    controls.hidden = !allowed;
    controls.classList.toggle("d-none", !allowed);
  }
}

function showToast(message, type = 'success') {
  const toastEl = document.getElementById('liveToast');
  if (!toastEl) return;

  const toastBody = toastEl.querySelector('.toast-body');
  toastBody.textContent = message;

  toastEl.classList.remove('text-bg-success', 'text-bg-danger', 'text-bg-warning', 'text-bg-info');
  toastEl.classList.add(`text-bg-${type}`);

  toastInstance = bootstrap.Toast.getOrCreateInstance(toastEl);
  toastInstance.show();
}

function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMatchPredictions(predictions, usersMap, currentUid, actual) {
  if (!predictions || predictions.length === 0) {
    return `<div class="text-muted">No guesses yet.</div>`;
  }

  const sorted = [...predictions].sort((a, b) => {
    const diff = score(b, actual) - score(a, actual);
    if (diff !== 0) return diff;
    return a.userId.localeCompare(b.userId);
  });

  return `
    <div class="table-responsive">
      <table class="table table-sm mb-0">
        <thead class="table-light">
          <tr>
            <th>Player</th>
            <th class="text-center">Guess</th>
            <th class="text-end">Points</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(pred => {
            const displayName = usersMap[pred.userId]?.displayName || usersMap[pred.userId]?.email || pred.userId;
            const points = score(pred, actual);
            const highlightStart = pred.userId === currentUid ? '<strong>' : '';
            const highlightEnd = pred.userId === currentUid ? '</strong>' : '';

            return `
              <tr>
                <td>${highlightStart}${escapeHtml(displayName)}${highlightEnd}</td>
                <td class="text-center">${highlightStart}${pred.home}:${pred.away}${highlightEnd}</td>
                <td class="text-end">${highlightStart}${points}${highlightEnd}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/* =========================
   AUTH STATE
========================= */
auth.onAuthStateChanged(async user => {

  if (user) {

    document.getElementById("login-view").style.display = "none";
    document.getElementById("app-view").style.display = "block";
    document.getElementById("admin-view").style.display = "none";
    document.getElementById("logout-btn").style.display = "inline-block";
    document.getElementById("back-btn").style.display = "none";

    // Show admin button if user is admin
    const isAdmin = await isAdminUser(user);
    if (isAdmin) {
      document.getElementById("admin-btn").style.display = "inline-block";
    } else {
      document.getElementById("admin-btn").style.display = "none";
    }

    document.getElementById("user-info").innerText = `Logged in as ${user.displayName || user.email || user.uid}`;

    await syncUserProfile(user);
    await loadMatches();
    await loadLeaderboard();
    await loadUserSupport();
    if (supportEditAllowed) {
      await loadTeams();
    }

  } else {
    document.getElementById("logout-btn").style.display = "none";
    document.getElementById("admin-btn").style.display = "none";
    document.getElementById("back-btn").style.display = "none";

    document.getElementById("login-view").style.display = "block";
    document.getElementById("app-view").style.display = "none";
    document.getElementById("admin-view").style.display = "none";

    document.getElementById("user-info").innerText = "";
    document.getElementById("matches").innerHTML = "";
    document.getElementById("leaderboard").innerHTML = "";
    
    await loadPublicLeaderboard();
  }
});


/* =========================
   LOGIN / LOGOUT
========================= */
function login() {

  const provider = new firebase.auth.GoogleAuthProvider();

  // ALWAYS SHOW GOOGLE ACCOUNT PICKER
  provider.setCustomParameters({
    prompt: "select_account"
  });

  auth.signInWithPopup(provider)
    .then(async res => {

      console.log("LOGIN SUCCESS", res.user);

      // SAVE/UPDATE USER PROFILE IN FIRESTORE
      await syncUserProfile(res.user);

    })
    .catch(err => console.error("LOGIN ERROR", err));
}

function logout() {

  auth.signOut()
    .then(() => {
      console.log("LOGGED OUT");
    })
    .catch(err => console.error("LOGOUT ERROR", err));
}

function switchToAdmin() {
  document.getElementById("app-view").style.display = "none";
  document.getElementById("admin-view").style.display = "block";
  document.getElementById("admin-btn").style.display = "none";
  document.getElementById("back-btn").style.display = "inline-block";
  loadAdminMatches();
}

function switchToApp() {
  document.getElementById("admin-view").style.display = "none";
  document.getElementById("app-view").style.display = "block";
  document.getElementById("back-btn").style.display = "none";
  document.getElementById("admin-btn").style.display = "inline-block";
}

async function syncUserProfile(user) {

  if (!user) return;

  await db.collection("users")
    .doc(user.uid)
    .set({
      displayName: user.displayName || null,
      email: user.email || null,
      lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}


/* =========================
   LOAD MATCHES
========================= */
async function loadMatches() {

  const user = auth.currentUser;
  if (!user) return;

  const matchesSnap = await db.collection("matches")
    .orderBy("datetime")
    .get();

  const predSnap = await db.collection("predictions")
    .doc(user.uid)
    .collection("matches")
    .get();

  const predictions = {};
  predSnap.forEach(doc => predictions[doc.id] = doc.data());

  const container = document.getElementById("matches");
  container.innerHTML = "";

  const now = Date.now();
  const firstMatch = matchesSnap.docs[0]?.data();
  const tournamentStarted = firstMatch
    ? now >= (firstMatch.datetime?.toMillis?.() ?? Infinity)
    : false;

  updateSupportEditAllowed(!tournamentStarted);

  matchesSnap.forEach(doc => {

    const m = doc.data();
    const matchId = doc.id;
    matchDataCache[matchId] = m;   // cache for lazy accordion loading

    const pred = predictions[matchId] || null;
    const ONE_HOUR = 60 * 60 * 1000;
    const matchTime = m.datetime?.toMillis?.() ?? 0;
    const editable = now < (matchTime - ONE_HOUR);
    const hasResult = !!m.result;

    // Result cell: plain dash, or a clickable toggle when a result exists
    const resultCell = hasResult
      ? `<button class="btn btn-link btn-sm p-0 fw-bold text-decoration-none match-preds-toggle"
                 type="button"
                 data-bs-toggle="collapse"
                 data-bs-target="#preds-${matchId}"
                 aria-expanded="false"
                 aria-controls="preds-${matchId}"
                 onclick="loadMatchPredictions('${matchId}')">
           ${m.result.home}:${m.result.away}&nbsp;<span class="chevron text-muted">▾</span>
         </button>`
      : '-';

    container.innerHTML += `
      <tr>
        <td>
            ${new Date(m.datetime.toDate())
              .toLocaleString("lt-LT")
              .replace("T", " ")
              .substring(0, 19)}
        </td>

        <td class="text-end align-middle">
          <img src="${flag(flags[m.teamA])}" class="flag">
          ${m.teamA}
        </td>

        <td class="text-center align-middle">
          ${editable ? `
            <input type="number" min="0" class="form-control d-inline-block"
                   style="width:70px; margin-right:4px;" id="a-${matchId}"
                   value="${pred?.home ?? ''}">
            <span class="mx-1">:</span>
            <input type="number" min="0" class="form-control d-inline-block"
                   style="width:70px;" id="b-${matchId}"
                   value="${pred?.away ?? ''}">
          ` : `<strong>${pred?.home ?? '-'}:${pred?.away ?? '-'}</strong>`}
        </td>

        <td class="align-middle">
          ${m.teamB}
          <img src="${flag(flags[m.teamB])}" class="flag">
        </td>

        <td class="text-center align-middle">
          ${resultCell}
        </td>

        <td class="align-middle">
          ${editable
            ? `<button class="btn btn-primary btn-sm" onclick="save('${matchId}')">Save</button>`
            : (hasResult && pred ? score(pred, m.result) : `-`)}
        </td>
      </tr>
      ${hasResult ? `
        <tr class="match-preds-row">
          <td colspan="6" class="p-0 border-0">
            <div class="collapse" id="preds-${matchId}">
              <div class="p-3 bg-light border-top" id="preds-content-${matchId}">
                <div class="text-muted small">Loading predictions…</div>
              </div>
            </div>
          </td>
        </tr>
      ` : ''}
    `;
  });
}


/* =========================
   MATCH PREDICTIONS PANEL
========================= */
async function loadMatchPredictions(matchId) {

  const contentEl = document.getElementById(`preds-content-${matchId}`);
  if (!contentEl || contentEl.dataset.loaded === 'true') return;

  const matchData = matchDataCache[matchId];
  if (!matchData?.result) return;

  contentEl.innerHTML = '<div class="text-muted small py-1">Loading predictions…</div>';

  try {
    // Leaderboard is publicly readable and contains uid + displayName for every player
    const leaderboardSnap = await db.collection("leaderboard").get();
    const usersMap = {};
    leaderboardSnap.forEach(doc => {
      const data = doc.data();
      usersMap[data.uid] = data;
    });

    // Fetch every user's prediction for this match in parallel
    const allPreds = [];
    await Promise.all(
      Object.keys(usersMap).map(async uid => {
        try {
          const predDoc = await db.collection("predictions")
            .doc(uid)
            .collection("matches")
            .doc(matchId)
            .get();
          if (predDoc.exists) {
            allPreds.push({ userId: uid, ...predDoc.data() });
          }
        } catch (_) {
          // No prediction for this match – skip silently
        }
      })
    );

    const currentUid = auth.currentUser?.uid;
    contentEl.innerHTML = `
      <div class="small fw-semibold mb-2 text-secondary">All predictions for this match:</div>
      ${renderMatchPredictions(allPreds, usersMap, currentUid, matchData.result)}
    `;
    contentEl.dataset.loaded = 'true';

  } catch (err) {
    console.error("loadMatchPredictions failed:", err);
    contentEl.innerHTML = `<div class="text-danger small">Failed to load predictions: ${escapeHtml(err.message)}</div>`;
  }
}

/* =========================
   SAVE PREDICTION
========================= */
async function save(matchId) {

  const user = auth.currentUser;
  if (!user) return;

  const homeValue = document.getElementById(`a-${matchId}`).value.trim();
  const awayValue = document.getElementById(`b-${matchId}`).value.trim();

  const home = Number(homeValue);
  const away = Number(awayValue);

  if (!homeValue || !awayValue || Number.isNaN(home) || Number.isNaN(away) || home < 0 || away < 0) {
    alert("Please enter valid non-negative scores for both teams.");
    return;
  }

  await syncUserProfile(user);

  await db.collection("predictions")
    .doc(user.uid)
    .set({ updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });

  await db.collection("predictions")
    .doc(user.uid)
    .collection("matches")
    .doc(matchId)
    .set({
      home,
      away
    });

  showToast("Prediction saved ✓", 'success');
  await loadMatches();
}


/* =========================
   ADMIN FUNCTIONS
========================= */
async function loadAdminMatches() {

  const user = auth.currentUser;
  if (!user || !(await isAdminUser(user))) {
    alert("Unauthorized");
    return;
  }

  const matchesSnap = await db.collection("matches")
    .orderBy("datetime")
    .get();

  const container = document.getElementById("admin-matches");
  container.innerHTML = "";

  matchesSnap.forEach(doc => {

    const m = doc.data();
    const matchId = doc.id;
    const result = m.result || {};

    container.innerHTML += `
      <tr>
        <td>
          ${new Date(m.datetime.toDate())
              .toLocaleString("lt-LT")
              .replace("T", " ")
              .substring(0, 19)}
        </td>

        <td class="text-end align-middle">
          <img src="${flag(flags[m.teamA])}" class="flag">
          ${m.teamA}
        </td>

        <td class="align-middle">
          ${m.teamB}
          <img src="${flag(flags[m.teamB])}" class="flag">
        </td>

        <td class="text-center align-middle">
          <input type="number" min="0" class="form-control d-inline-block"
                 style="width:70px; margin-right:4px;" id="admin-a-${matchId}"
                 value="${result.home ?? ''}">
          <span class="mx-1">:</span>
          <input type="number" min="0" class="form-control d-inline-block"
                 style="width:70px;" id="admin-b-${matchId}"
                 value="${result.away ?? ''}">
        </td>

        <td class="align-middle">
          <button class="btn btn-success btn-sm" onclick="saveMatchResult('${matchId}')">Save</button>
        </td>
      </tr>
    `;
  });
}

async function saveMatchResult(matchId) {

  const user = auth.currentUser;
  if (!user || !(await isAdminUser(user))) {
    alert("Unauthorized");
    return;
  }

  const homeValue = document.getElementById(`admin-a-${matchId}`).value.trim();
  const awayValue = document.getElementById(`admin-b-${matchId}`).value.trim();

  const home = Number(homeValue);
  const away = Number(awayValue);

  if (!homeValue || !awayValue || Number.isNaN(home) || Number.isNaN(away) || home < 0 || away < 0) {
    alert("Please enter valid non-negative scores for both teams.");
    return;
  }

  try {
    console.log("Admin saving match result", { email: user.email, matchId, home, away });

    await db.collection("matches")
      .doc(matchId)
      .set({
        result: {
          home,
          away
        }
      }, { merge: true });

    await recalculateLeaderboard();

    showToast("Result saved ✓", 'success');
    await loadAdminMatches();
  } catch (err) {
    console.error("saveMatchResult failed", err);
    alert(`Save failed: ${err.message || err}`);
  }
}

async function recalculateLeaderboard() {

  const matchesSnap = await db.collection("matches").get();

  const matchResults = {};
  matchesSnap.forEach(doc => {
    const matchData = doc.data();
    if (matchData.result) {
      matchResults[doc.id] = matchData.result;
    }
  });

  const usersSnap = await db.collection("users").get();

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const userData = userDoc.data();
    const displayName = userData.displayName || userData.email || uid;

    let points = 0;
    let exactScores = 0;

    try {
      const predsSnap = await db.collection("predictions")
        .doc(uid)
        .collection("matches")
        .get();

      predsSnap.forEach(predDoc => {
        const actual = matchResults[predDoc.id];
        if (!actual) return;

        const pred = predDoc.data();
        points += score(pred, actual);

        if (pred.home === actual.home && pred.away === actual.away) {
          exactScores += 1;
        }
      });
    } catch (err) {
      console.error(`Leaderboard calculation error for ${uid}:`, err);
    }

    try {
      await db.collection("leaderboard")
        .doc(uid)
        .set({
          uid,
          displayName,
          points: Math.round(points * 100) / 100,
          exactScores,
          supports: userData.supports || null
        });
    } catch (err) {
      console.error(`Leaderboard write failed for ${uid}:`, err);
      throw err;
    }
  }
}


function score(pred, actual) {

  if (!actual) return 0;
  if (!pred) return 0;

  const actualDiff = actual.home - actual.away;
  const predDiff = pred.home - pred.away;

  // Check if direction (winner/loser) matches
  const directionMatches = 
    (actualDiff > 0 && predDiff > 0) ||
    (actualDiff < 0 && predDiff < 0) ||
    (actualDiff === 0 && predDiff === 0);

  // Component 1: Direction match (0.5 max)
  const directionScore = directionMatches ? 0.5 : 0;

  // Component 2: Difference penalty (0.5 max, only if direction matches)
  let diffScore = 0;
  if (directionMatches) {
    const diffDiff = Math.abs(Math.abs(actualDiff) - Math.abs(predDiff));
    diffScore = 0.5 * (10 / (10 + diffDiff));
  }

  // Component 3: Team A score accuracy (0.5 max)
  const teamAScore = 0.5 * (10 / (10 + Math.abs(actual.home - pred.home)));

  // Component 4: Team B score accuracy (0.5 max)
  const teamBScore = 0.5 * (10 / (10 + Math.abs(actual.away - pred.away)));

  const totalScore = directionScore + diffScore + teamAScore + teamBScore;

  return Math.round(totalScore * 100) / 100;
}


/* =========================
   LEADERBOARD
========================= */
async function loadLeaderboardInto(containerId) {

  const leaderboardSnap = await db.collection("leaderboard")
    .orderBy("points", "desc")
    .get();

  const container = document.getElementById(containerId);
  if (!container) return;
  
  container.innerHTML = "";

  if (leaderboardSnap.empty) {
    container.innerHTML = `<div class="text-muted">No rankings yet.</div>`;
    return;
  }

  let rows = "";
  let index = 1;
  leaderboardSnap.forEach(doc => {
    const data = doc.data();
    const displayScore = data.points > 0 ? data.points : "-";
    const exactScores = data.exactScores ?? 0;
    const supportFlag = data.supports && flags[data.supports]
    ? `<img src="${flag(flags[data.supports])}" class="flag me-1" alt="${data.supports}" title="${data.supports}">`
    : "";
    const displayNameHtml = `${supportFlag}${data.displayName || data.uid}`;

    rows += `
      <tr>
        <td class="align-middle">${index}</td>
        <td class="align-middle">${displayNameHtml}</td>
        <td class="text-center align-middle">${exactScores}</td>
        <td class="text-end align-middle">${displayScore}</td>
      </tr>
    `;
    index += 1;
  });

  container.innerHTML = `
    <div class="table-responsive">
      <table class="table table-sm table-hover mb-0">
        <thead class="table-light">
          <tr>
            <th style="width: 40px;">#</th>
            <th>Name</th>
            <th class="text-center">Exact guesses</th>
            <th class="text-end">Points</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

// Convenience wrappers
async function loadLeaderboard() {
  return await loadLeaderboardInto("leaderboard");
}

async function loadPublicLeaderboard() {
  return await loadLeaderboardInto("public-rankings");
}


function flag(code) {
  return `https://flagcdn.com/24x18/${code}.png`;
}

const flags = {
  "Canada": "ca",
  "Mexico": "mx",
  "USA": "us",
  "Australia": "au",
  "Iraq": "iq",
  "IR Iran": "ir",
  "Japan": "jp",
  "Jordan": "jo",
  "Korea Republic": "kr",
  "Qatar": "qa",
  "Saudi Arabia": "sa",
  "Uzbekistan": "uz",
  "Algeria": "dz",
  "Cabo Verde": "cv",
  "Congo DR": "cd",
  "Côte d'Ivoire": "ci",
  "Egypt": "eg",
  "Ghana": "gh",
  "Morocco": "ma",
  "Senegal": "sn",
  "South Africa": "za",
  "Tunisia": "tn",
  "Curaçao": "cw",
  "Haiti": "ht",
  "Panama": "pa",
  "Argentina": "ar",
  "Brazil": "br",
  "Colombia": "co",
  "Ecuador": "ec",
  "Paraguay": "py",
  "Uruguay": "uy",
  "New Zealand": "nz",
  "Austria": "at",
  "Belgium": "be",
  "Bosnia and Herzegovina": "ba",
  "Croatia": "hr",
  "Czechia": "cz",
  "England": "gb-eng",
  "France": "fr",
  "Germany": "de",
  "Netherlands": "nl",
  "Norway": "no",
  "Portugal": "pt",
  "Scotland": "gb-sct",
  "Spain": "es",
  "Sweden": "se",
  "Switzerland": "ch",
  "Türkiye": "tr"
};

function loadTeams() {
  const select = document.getElementById("support-select");

  select.innerHTML = `<option value="">-- choose team --</option>`;

  Object.keys(flags)
    .sort()
    .forEach(team => {
      const opt = document.createElement("option");
      opt.value = team;
      opt.textContent = team;
      select.appendChild(opt);
    });
}

function renderSupport(team) {
  const display = document.getElementById("support-display");

  if (!team) {
    display.textContent = "Not selected";
    return;
  }

  display.innerHTML = `
    <img class="flag" src="${flag(flags[team])}" alt="${team}">
    ${team}
  `;
}

async function loadUserSupport() {
  const user = auth.currentUser;
  if (!user) return;

  const doc = await db.collection("users").doc(user.uid).get();

  if (!doc.exists) {
    renderSupport(null);
    return;
  }

  const data = doc.data();

  if (data.supports) {
    document.getElementById("support-select").value = data.supports;
    renderSupport(data.supports);
  } else {
    renderSupport(null);
  }
}

async function saveSupport() {
  const user = auth.currentUser;
  const team = document.getElementById("support-select").value;

  if (!user || !team || !supportEditAllowed) return;

  await db.collection("users").doc(user.uid).set(
    {
      supports: team
    },
    { merge: true }
  );

  renderSupport(team);

  showToast("Support team saved ✓");
}


function guessCalculator() {
  const teamAresult = Number(document.getElementById("team-a-result").value);
  const teamBresult = Number(document.getElementById("team-b-result").value);
  const teamAguess  = Number(document.getElementById("team-a-guess").value);
  const teamBguess  = Number(document.getElementById("team-b-guess").value);

  let pointsForCorrentWinner = 0;
  let pointsForPointDifference = 0;

  let pointsForTeamAPoints =
    0.5 * (10 / (10 + Math.abs(teamAresult - teamAguess)));

  let pointsForTeamBPoints =
    0.5 * (10 / (10 + Math.abs(teamBresult - teamBguess)));

  // winner (including draw case)
  const realDiff = teamAresult - teamBresult;
  const guessDiff = teamAguess - teamBguess;

  const realIsDraw = realDiff === 0;
  const guessIsDraw = guessDiff === 0;

  if (
    (realIsDraw && guessIsDraw) ||
    (!realIsDraw &&
      ((realDiff > 0 && guessDiff > 0) ||
       (realDiff < 0 && guessDiff < 0)))
  ) {
    pointsForCorrentWinner = 0.5;
  }

  // point difference (now ALWAYS allowed if winner is correct)
  if (pointsForCorrentWinner > 0) {

    if (realDiff === guessDiff) {
      pointsForPointDifference = 0.5;
    } else {
      const deviation =
        Math.abs(Math.abs(realDiff) - Math.abs(guessDiff));

      pointsForPointDifference =
        0.5 * (10 / (10 + deviation));
    }
  }

  const total =
    pointsForCorrentWinner +
    pointsForPointDifference +
    pointsForTeamAPoints +
    pointsForTeamBPoints;

  // render helper
  const fmt = (n) => n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

  document.getElementById("winner").innerHTML = `<b>${pointsForCorrentWinner}</b>`;
  document.getElementById("pointsDiff").innerHTML = `<b>${fmt(pointsForPointDifference)}</b>`;
  document.getElementById("team1points").innerHTML = `<b>${fmt(pointsForTeamAPoints)}</b>`;
  document.getElementById("team2points").innerHTML = `<b>${fmt(pointsForTeamBPoints)}</b>`;
  document.getElementById("total").innerHTML = `<b>${fmt(total)}</b>`;
}

// attach listeners automatically
document.addEventListener("DOMContentLoaded", () => {
  const inputs = document.querySelectorAll("input.toto-input");
  inputs.forEach(input => input.addEventListener("input", guessCalculator));
});
