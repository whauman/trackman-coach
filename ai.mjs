// AI coaching: calls Claude straight from the phone with the user's own API key (kept in localStorage, never in
// the page or the sign-in link). Scripted per-shot tips stay in advice.mjs; Claude handles the pattern-level
// coaching: a spoken check-in every N shots, an on-demand "Ask coach", and the written end-of-session review.
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@1.8.0';
import { adviseShot, sessionStats, tourCompare, clubName, BASELINE } from './advice.mjs';

const MODEL = 'claude-opus-5-5';
// USD per million tokens for claude-opus-5-5 (input, output, cache read, 5-minute cache write = 1.25x input).
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

// Frozen, so it caches across every call in a session. Keep timestamps and session data out of it.
const SYSTEM = `You are a golf coach standing next to the player in a TrackMan simulator bay, talking through their phone's speaker.

The player: right-handed, real handicap about 13 (TrackMan simulator handicap 2.8, which flatters them). Irons are 2023 Titleist T100 4-iron to pitching wedge with Project X 6.0 shafts, plus a 50° wedge. Distances are in metres.

What their history (about 3,600 TrackMan shots) says:
- 7-iron club speed about 83 mph, carry about 137 m, which is roughly right for that speed. Strike efficiency (smash) is Tour-level on average; the distance gap to Tour is speed.
- They miss both ways, slightly more right than left. Left misses start nearly straight and curve: face closed to the path by 4-8°. Right misses start right with an open face and come from heel strikes.
- Path is usually 2-5° in-to-out. Face angle varies far more than path (about ±4.7° vs ±2.4°), so face control is the main dispersion problem.
- Only about 20% of strikes are within 6 mm of centre; heel and low strikes cost about 6 m of carry and double side spread.
- Spin and peak height run lower than Tour averages, so landing angles are a little shallow.
- Baselines: face-to-path within 2° on about 39% of shots; centred strikes about 20%.

Their software already speaks a short scripted tip after every shot, so you are not there to repeat single-shot feedback. Your job is the pattern across shots: what is changing, what links the misses, and the one thing to try next. Be specific to the numbers you are given, and honest when the sample is too small to say anything.

Field meanings: carry and side in metres (side + is right); face, path, f2p (face to path), launch direction in degrees (+ is right; f2p - is closed); strike offset in mm (+ toe, - heel) and strike height in mm (- low); dynamic loft and attack angle in degrees; spin in rpm; smash is ball speed / club speed.`;

const SPOKEN_RULES = `Reply with what you would say out loud, 2 or 3 short sentences, under 60 words. Plain spoken English: no lists, no markdown, no emoji, no decimals (say "about 5 degrees"), say distances like a golfer ("one thirty-seven"). End with one concrete thing to try on the next few shots.`;
const REVIEW_RULES = `Write the end-of-session review the player will read on their phone. Use short paragraphs or a few bullet points, plain text, under 220 words. Cover: what went well, the main pattern behind the misses (with the numbers that show it), how this compares with their baselines, and one or two specific things to work on next session, with a drill. Don't pad it.`;

const n1 = v => v == null || !Number.isFinite(v) ? '' : Math.round(v * 10) / 10;
function shotRow(s, i) {
  const m = s.measurement;
  return [i + 1, s.club, n1(m.carry), n1(m.carrySide), n1(m.faceAngle), n1(m.clubPath), n1(m.faceToPath), n1(m.launchDirection),
    m.impactOffset == null ? '' : Math.round(m.impactOffset * 1000), m.impactHeight == null ? '' : Math.round(m.impactHeight * 1000),
    n1(m.dynamicLoft), n1(m.attackAngle), m.spinRate == null ? '' : Math.round(m.spinRate), n1(m.smashFactor)].join(',');
}

/** Compact, model-readable description of the session so far. */
export function describeSession(shots, focus, recentTips = []) {
  const clubs = sessionStats(shots).map(c => {
    const t = tourCompare(shots, c.club);
    return `${clubName(c.club)}: ${c.n} shots, median carry ${c.carry == null ? '?' : Math.round(c.carry)} m`
      + (BASELINE[c.club]?.typical ? ` (their normal ${BASELINE[c.club].typical})` : '')
      + `, face-to-path within 2° ${c.f2pGood}%, centred ${c.centred}%, >10 m left ${c.left}% / right ${c.right}%`
      + (t?.scaledCarry ? `, Tour carry at their ball speed ${Math.round(t.scaledCarry)} m` : '');
  });
  const faults = {}; shots.forEach(s => adviseShot(s).tags.forEach(t => faults[t] = (faults[t] || 0) + 1));
  return [
    `Session focus chosen by the player: ${focus}. Shots so far: ${shots.length}.`,
    `Per club: ${clubs.join(' | ')}`,
    `Fault counts: ${Object.entries(faults).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    recentTips.length ? `What you told them earlier this session: ${recentTips.map(t => `"${t}"`).join(' ')}` : '',
    `Shots (oldest first, last 40 max). Columns: n,club,carry,side,face,path,f2p,launchDir,strikeOffset,strikeHeight,dynLoft,attack,spin,smash`,
    shots.slice(-40).map((s, i, a) => shotRow(s, shots.length - a.length + i)).join('\n'),
  ].filter(Boolean).join('\n');
}

export class Coach {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 60_000 });
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  }

  get costUsd() {
    const u = this.usage;
    return (u.input * PRICE.input + u.output * PRICE.output + u.cacheRead * PRICE.cacheRead + u.cacheWrite * PRICE.cacheWrite) / 1e6;
  }

  /** kind: 'checkpoint' (spoken, quick) or 'review' (written, end of session). Returns the text. */
  async ask(kind, shots, focus, recentTips = []) {
    const review = kind === 'review';
    const response = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: review ? 8000 : 2000,
      // Low effort keeps the spoken check-in quick; the written review gets more thought.
      output_config: { effort: review ? 'medium' : 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `${describeSession(shots, focus, recentTips)}\n\n${review ? REVIEW_RULES : SPOKEN_RULES}` }],
    });
    for (const it of response.usage?.iterations || [response.usage]) {
      if (!it) continue;
      this.usage.input += it.input_tokens || 0; this.usage.output += it.output_tokens || 0;
      this.usage.cacheRead += it.cache_read_input_tokens || 0; this.usage.cacheWrite += it.cache_creation_input_tokens || 0;
    }
    this.usage.calls++;
    if (response.stop_reason === 'refusal') throw new Error('The coach declined to answer that one.');
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) throw new Error(response.stop_reason === 'max_tokens' ? 'The coach ran out of room.' : 'Empty reply.');
    return text;
  }

  /** Cheap key check used by the settings "Test" button. */
  async test() {
    const r = await this.client.beta.messages.create({
      model: MODEL, max_tokens: 1000, output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      messages: [{ role: 'user', content: 'Reply with exactly: Coach is ready.' }],
    });
    return r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  }
}

/** Friendly message for an SDK error, using its typed classes. */
export function explainError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'API key was rejected. Check it in settings.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use the coach model.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited. The coach will try again later.';
  if (e instanceof Anthropic.BadRequestError) return /credit|billing|balance/i.test(e.message) ? 'Your Anthropic account is out of credit.' : `Request rejected: ${e.message.slice(0, 120)}`;
  if (e instanceof Anthropic.APIConnectionError) return 'No connection to the coach.';
  if (e instanceof Anthropic.APIError) return `Coach error ${e.status ?? ''}`.trim();
  return e?.message || 'Coach unavailable.';
}
