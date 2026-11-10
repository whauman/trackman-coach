// Shot-by-shot coaching rules, shared by the phone page (index.html) and the CLI watcher (scripts/watch.mjs).
// Input: a TrackMan stroke ({ time, club, measurement }) in API units (m/s, m, degrees, impact offset/height in m).
// Conventions (right-handed): + launch direction / face / path = right; face-to-path - = closed (draw/hook);
// impact offset + = toe, - = heel; impact height - = low on the face.

export const API = 'https://api.trackmangolf.com/graphql';

const STROKE_FIELDS = `time club measurement { carry total carrySide ballSpeed clubSpeed smashFactor launchAngle
  launchDirection spinRate faceAngle clubPath faceToPath attackAngle dynamicLoft impactOffset impactHeight maxHeight landingAngle }`;
export const SESSIONS_QUERY = `query($from: DateTime) { me { activities(timeFrom: $from, take: 10,
  kinds: [SIMULATOR, VIRTUAL_RANGE, SHOT_ANALYSIS]) { items { id kind time
  ... on SimulatorSessionActivity { strokeCount strokes { ${STROKE_FIELDS} } }
  ... on VirtualRangeSessionActivity { strokeCount strokes { ${STROKE_FIELDS} } }
  ... on ShotAnalysisSessionActivity { strokeCount strokes { ${STROKE_FIELDS} } } } } } }`;

export async function fetchSessions(token, fromIso) {
  const r = await fetch(API, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SESSIONS_QUERY, variables: { from: fromIso } }) });
  if (r.status === 401) throw new Error('TOKEN_EXPIRED');
  const j = await r.json();
  if (!j.data?.me) throw new Error(JSON.stringify(j.errors || j).slice(0, 200));
  return j.data.me.activities.items;
}

// Every stroke across the returned sessions, oldest first, with a stable key for de-duplication.
export const allStrokes = sessions => sessions.flatMap(s => (s.strokes || []).map((st, i) => ({ ...st, key: `${s.id}:${i}:${st.time}` })))
  .filter(s => s.measurement).sort((a, b) => String(a.time).localeCompare(String(b.time)));

// Typical (median) carry per club from practice since 2026-08-01, and speed-scaled targets (see README).
export const BASELINE = {
  '4Iron': { typical: 159 }, '5Iron': { typical: 156 }, '6Iron': { typical: 149, target: 148 }, '7Iron': { typical: 137, target: 140 },
  '8Iron': { typical: 128, target: 132 }, '9Iron': { typical: 118, target: 122 }, PitchingWedge: { typical: 108, target: 112 },
  '50Wedge': { typical: 96 }, '4Hybrid': { typical: 168 }, '3Wood': { typical: 194 }, Driver: { typical: 214 },
};
const SPOKEN = { PitchingWedge: 'pitching wedge', SandWedge: 'sand wedge', LobWedge: 'lob wedge', '3Wood': '3 wood', '5Wood': '5 wood',
  Driver: 'driver', Putter: 'putter' };
export const clubName = c => SPOKEN[c] || String(c || 'shot').replace(/^(\d+)(Iron|Hybrid|Wood|Wedge)$/, (_, n, t) => `${n} ${t.toLowerCase()}`);

const r0 = v => Math.round(v);
const abs = Math.abs;

// Thresholds. Tuned to this player's 7-iron spread; adjust here.
export const T = { f2pGood: 2, f2pBad: 4, heelMm: -10, toeMm: 10, lowMm: -8, startLineDeg: 4, sideM: 10, shortM: 12, partialM: 60, centreMm: 6 };

/** Returns { line: short spoken summary, cue: one piece of advice (or praise), good: boolean, tags: [] } */
export function adviseShot(stroke, focus = 'all') {
  const m = stroke.measurement, tags = [];
  const carry = m.carry, side = m.carrySide;
  const sideTxt = side == null ? '' : abs(side) < 3 ? 'on line' : `${r0(abs(side))} ${side > 0 ? 'right' : 'left'}`;
  const line = `${clubName(stroke.club)}, ${carry == null ? 'no carry' : r0(carry)}${sideTxt ? ', ' + sideTxt : ''}.`;

  const off = m.impactOffset == null ? null : m.impactOffset * 1000, ht = m.impactHeight == null ? null : m.impactHeight * 1000;
  const f2p = m.faceToPath == null ? null : Math.round(m.faceToPath * 10) / 10, face = m.faceAngle, path = m.clubPath;
  const partial = carry != null && carry < T.partialM; // pitches/chips: report strike only, not full-swing face/path cues
  const typical = BASELINE[stroke.club]?.typical;
  const cues = [];

  if (off != null && off < T.heelMm) { tags.push('heel'); cues.push({ k: 'strike', p: off < -15 ? 1 : 3, say: `Heel strike, ${r0(-off)} millimetres. Feel the strike out toward the toe, or put a tee just outside the heel.` }); }
  if (off != null && off > T.toeMm) { tags.push('toe'); cues.push({ k: 'strike', p: 3, say: `Toe strike, ${r0(off)} millimetres. Feel it more in the centre.` }); }
  if (ht != null && ht < T.lowMm) { tags.push('low'); cues.push({ k: 'strike', p: 4, say: 'Low on the face. Keep your chest over the ball and brush the turf after the ball.' }); }
  if (!partial && f2p != null && f2p <= -T.f2pBad) { tags.push('closed'); cues.push({ k: 'face', p: f2p <= -6 ? 1 : 2, say: `Face ${r0(-f2p)} degrees closed to the path, that's hook spin. Hold the face a touch more open through impact.` }); }
  if (!partial && f2p != null && f2p >= T.f2pBad) { tags.push('open'); cues.push({ k: 'face', p: f2p >= 6 ? 1 : 2, say: `Face ${r0(f2p)} degrees open to the path. Let the face square up through impact.` }); }
  if (!partial && f2p != null && abs(f2p) >= T.f2pGood && abs(f2p) < T.f2pBad) cues.push({ k: 'face', p: 5, say: `Face ${abs(f2p).toFixed(1)} ${f2p < 0 ? 'closed' : 'open'} to the path. Close, aim for inside 2.` });
  if (!partial && face != null && abs(face) >= T.startLineDeg && (f2p == null || abs(f2p) < T.f2pBad)) { tags.push('startline'); cues.push({ k: 'face', p: 3, say: `Started ${r0(abs(face))} degrees ${face > 0 ? 'right' : 'left'} with the face, check your aim and ball position.` }); }
  if (!partial && path != null && path >= 7) { tags.push('inout'); cues.push({ k: 'path', p: 4, say: `Path ${r0(path)} degrees in to out. Feel the club swing more left after impact.` }); }
  if (typical && carry != null && carry < typical - T.shortM && !tags.some(t => ['heel', 'toe', 'low'].includes(t))) { tags.push('short'); cues.push({ k: 'strike', p: 4, say: `${r0(typical - carry)} short of your normal. Check contact.` }); }

  const pool = focus === 'all' ? cues : cues.filter(c => c.k === focus);
  pool.sort((a, b) => a.p - b.p);
  const centred = off != null && ht != null && abs(off) < T.centreMm && abs(ht) < T.centreMm;
  const good = !partial && f2p != null && abs(f2p) < T.f2pGood && !tags.some(t => ['heel', 'toe', 'low'].includes(t)) && (side == null || abs(side) <= T.sideM);
  let cue = pool[0]?.say;
  if (!cue && good) cue = `Good one. Face to path ${f2p.toFixed(1)}${centred ? ', centred strike' : ''}.`;
  if (!cue) cue = focus === 'face' && f2p != null && !partial ? `Face square, ${abs(f2p).toFixed(1)} ${f2p < 0 ? 'closed' : 'open'}.`
    : focus === 'strike' ? (centred ? 'Centred strike.' : 'Strike OK.')
    : focus === 'path' && path != null && !partial ? `Path ${path.toFixed(1)}, fine.` : 'Solid.';
  return { line, cue, good, tags, f2p, off, ht, centred };
}

/** Rolling summary of the last n shots, spoken every n shots. */
export function summarise(shots) {
  const n = shots.length; if (!n) return '';
  const adv = shots.map(s => adviseShot(s));
  const goodF2p = adv.filter(a => a.f2p != null && abs(a.f2p) < T.f2pGood).length;
  const centred = adv.filter(a => a.centred).length;
  const carries = shots.map(s => s.measurement.carry).filter(v => v != null);
  const spread = carries.length ? r0(Math.max(...carries) - Math.min(...carries)) : 0;
  return `Last ${n}: ${goodF2p} of ${n} with face to path inside 2 degrees, ${centred} centred strikes, carry spread ${spread} metres.`;
}

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

/** Per-club session stats for the end-of-session summary. */
export function sessionStats(shots) {
  const by = {};
  for (const s of shots) (by[s.club] ??= []).push(s);
  return Object.entries(by).map(([club, g]) => {
    const adv = g.map(s => adviseShot(s)), carries = g.map(s => s.measurement.carry).filter(Number.isFinite);
    const n = g.length, pct = k => Math.round(100 * k / n);
    const tagCount = {};
    adv.forEach(a => a.tags.forEach(t => tagCount[t] = (tagCount[t] || 0) + 1));
    const topIssue = Object.entries(tagCount).sort((a, b) => b[1] - a[1])[0];
    return { club, name: clubName(club), n, carry: median(carries), typical: BASELINE[club]?.typical ?? null,
      spread: carries.length ? Math.max(...carries) - Math.min(...carries) : null,
      f2pGood: pct(adv.filter(a => a.f2p != null && abs(a.f2p) < T.f2pGood).length),
      centred: pct(adv.filter(a => a.centred).length),
      left: pct(g.filter(s => s.measurement.carrySide < -T.sideM).length), right: pct(g.filter(s => s.measurement.carrySide > T.sideM).length),
      good: pct(adv.filter(a => a.good).length), topIssue: topIssue ? { tag: topIssue[0], n: topIssue[1] } : null };
  }).sort((a, b) => b.n - a.n);
}

export const TAG_LABEL = { heel: 'Heel strike', toe: 'Toe strike', low: 'Low on face', closed: 'Face closed to path', open: 'Face open to path',
  startline: 'Off start line', inout: 'Path too in-to-out', short: 'Short of normal' };

// Commonly cited TrackMan PGA Tour averages (club mph, ball mph, smash, attack °, launch °, spin rpm, peak height yd,
// landing angle °, carry yd). These figures are several years old; treat them as approximate.
const TOUR_RAW = {
  Driver: [113, 167, 1.48, -1.3, 10.9, 2686, 32, 37, 275], '3Wood': [107, 158, 1.48, -2.9, 9.2, 3655, 30, 43, 243],
  '5Wood': [103, 152, 1.47, -3.3, 9.4, 4350, 31, 47, 230], Hybrid: [100, 146, 1.46, -3.5, 10.2, 4437, 29, 47, 225],
  '3Iron': [98, 142, 1.45, -3.1, 10.4, 4630, 27, 46, 212], '4Iron': [96, 137, 1.43, -3.4, 11.0, 4836, 28, 48, 203],
  '5Iron': [94, 132, 1.41, -3.7, 12.1, 5361, 31, 49, 194], '6Iron': [92, 127, 1.38, -4.1, 14.1, 6231, 30, 50, 183],
  '7Iron': [90, 120, 1.33, -4.3, 16.3, 7097, 32, 50, 172], '8Iron': [87, 115, 1.32, -4.5, 18.1, 7998, 31, 50, 160],
  '9Iron': [85, 109, 1.28, -4.7, 20.4, 8647, 30, 51, 148], PitchingWedge: [83, 102, 1.23, -5.0, 24.2, 9304, 29, 52, 136],
};
const YD = 0.9144, MPH = 2.23694; // API speeds are m/s
const tourKey = c => TOUR_RAW[c] ? c : /Hybrid$/.test(c) ? 'Hybrid' : null;
export const hasTour = c => !!tourKey(c);

/** Your session medians for one club next to the Tour average. Carry is also given scaled to your ball speed
 *  (carry ∝ ball speed^1.25, fitted on this player's own shots), which is the fairer target. */
export function tourCompare(shots, club) {
  const k = tourKey(club); if (!k) return null;
  const [cs, bs, sm, aoa, la, spin, ht, land, carry] = TOUR_RAW[k];
  const g = shots.filter(s => s.club === club).map(s => s.measurement);
  const med = f => median(g.map(f).filter(v => v != null && Number.isFinite(v)));
  const you = { carry: med(m => m.carry), ball: med(m => m.ballSpeed * MPH), club: med(m => m.clubSpeed * MPH), smash: med(m => m.smashFactor),
    launch: med(m => m.launchAngle), spin: med(m => m.spinRate), height: med(m => m.maxHeight), land: med(m => m.landingAngle), attack: med(m => m.attackAngle) };
  const tour = { carry: carry * YD, ball: bs, club: cs, smash: sm, launch: la, spin, height: ht * YD, land, attack: aoa };
  const scaledCarry = you.ball ? tour.carry * (you.ball / bs) ** 1.25 : null;
  const rows = [
    ['Carry', 'carry', 'm', 0], ['Ball speed', 'ball', 'mph', 0], ['Club speed', 'club', 'mph', 0], ['Smash', 'smash', '', 2],
    ['Launch', 'launch', '°', 1], ['Spin', 'spin', 'rpm', 0], ['Peak height', 'height', 'm', 0], ['Land angle', 'land', '°', 0], ['Attack', 'attack', '°', 1],
  ].map(([label, key, unit, dp]) => ({ label, key, unit, dp, you: you[key], tour: tour[key] }));
  return { club, n: g.length, rows, scaledCarry, tourCarry: tour.carry };
}
