// Minimal test suite — no test framework/dependency added, just Node's
// built-in assert. Run with: node tests/signal.test.js

const assert = require("assert");
const Signal = require("../js/signal.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    process.exitCode = 1;
  }
}

// --- cleanRRIntervals: masking behavior ---

test("cleanRRIntervals keeps a run of consistent intervals", () => {
  const rr = [800, 810, 795, 805, 800, 790];
  const { values, valid } = Signal.cleanRRIntervals(rr);
  assert.strictEqual(values.length, rr.length, "values should be unchanged in length/position");
  assert.ok(valid.every(Boolean), "all intervals should be marked valid");
});

test("cleanRRIntervals flags a single wild outlier without deleting it", () => {
  const rr = [800, 810, 2200, 795, 805, 800, 790]; // one implausible value
  const { values, valid } = Signal.cleanRRIntervals(rr);
  assert.strictEqual(values.length, rr.length, "values array must stay same length (marked, not deleted)");
  assert.strictEqual(valid[2], false, "the implausible 2200ms interval should be marked invalid");
  assert.strictEqual(valid[0], true);
  assert.strictEqual(valid[1], true);
});

// --- computeRMSSD: must skip gaps around invalid intervals, not bridge them ---

test("computeRMSSD excludes any pair touching an invalid interval", () => {
  // index 2 is invalid; pairs (1,2) and (2,3) must both be skipped,
  // leaving only pairs (0,1) and (3,4) [since index 3,4 are valid].
  const cleaned = {
    values: [800, 810, 9999, 795, 805],
    valid: [true, true, false, true, true],
  };
  const result = Signal.computeRMSSD(cleaned);
  // Manually expected: diffs used are (810-800)=10 and (805-795)=10
  // rMSSD = sqrt(mean([10^2, 10^2])) = 10
  assert.strictEqual(result, 10, `expected rMSSD to ignore the gap around the invalid interval, got ${result}`);
});

test("computeRMSSD returns null when no valid adjacent pair exists", () => {
  const cleaned = { values: [800, 900], valid: [true, false] };
  assert.strictEqual(Signal.computeRMSSD(cleaned), null);
});

// --- findPeaksBySteepestSlope: basic sanity on a synthetic periodic signal ---

test("findPeaksBySteepestSlope finds roughly one beat per synthetic pulse cycle", () => {
  const sampleRateHz = 30;
  const durationS = 10;
  const beatHz = 1.2; // 72 bpm
  const n = sampleRateHz * durationS;
  const signal = [];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRateHz;
    // Asymmetric pulse-like shape: fast rise, slow decay — closer to a
    // real PPG waveform than a plain sine, so slope detection has a
    // meaningful single steep upstroke per cycle.
    const phase = (t * beatHz) % 1;
    const value = phase < 0.3 ? phase / 0.3 : 1 - (phase - 0.3) / 0.7;
    signal.push(value);
  }
  const peaks = Signal.findPeaksBySteepestSlope(signal, sampleRateHz);
  const expectedBeats = durationS * beatHz;
  assert.ok(
    Math.abs(peaks.length - expectedBeats) <= 2,
    `expected close to ${expectedBeats} beats, got ${peaks.length}`
  );
});

// --- compareDetectors: matching and tolerance behavior ---

test("compareDetectors matches peaks within tolerance and counts the rest as unmatched", () => {
  const sampleRateHz = 30;
  const peaksA = [100, 200, 300, 400];
  const peaksB = [102, 199, 301]; // 3 of 4 close matches, missing one near 400
  const result = Signal.compareDetectors(peaksA, peaksB, sampleRateHz, 150);
  assert.strictEqual(result.countA, 4);
  assert.strictEqual(result.countB, 3);
  assert.strictEqual(result.matched, 3);
  assert.strictEqual(result.unmatchedA, 1);
  assert.strictEqual(result.unmatchedB, 0);
});

// --- End-to-end hand-verified HR/rMSSD on a clean synthetic RR series ---

test("computeHR and computeRMSSD match hand-calculated values on a clean series", () => {
  const rr = [800, 820, 790, 810, 805]; // all plausible, all close together
  const cleaned = Signal.cleanRRIntervals(rr);
  assert.deepStrictEqual(cleaned.valid, [true, true, true, true, true], "none of these should be flagged");

  // mean = 805ms -> 60000/805 = 74.53... -> rounds to 75
  assert.strictEqual(Signal.computeHR(cleaned), 75);

  // successive diffs: 20, -30, 20, -5 -> squares: 400,900,400,25 -> mean 431.25 -> sqrt ~20.77 -> rounds to 21
  assert.strictEqual(Signal.computeRMSSD(cleaned), 21);
});

// --- Missed beat: one interval ~2x normal, merging two real beats into one ---

test("a missed-beat interval is excluded, and HR/rMSSD are computed hand-verifiably around the gap", () => {
  const rr = [800, 810, 1620, 795, 805]; // index 2 is a merged (missed-beat) interval
  const cleaned = Signal.cleanRRIntervals(rr);
  assert.strictEqual(cleaned.valid[2], false, "the 1620ms interval should be rejected (exceeds plausible max)");
  assert.ok(/missed beat/i.test(cleaned.reasons[2]), "reason should mention a possible missed beat");

  // Valid intervals: 800, 810, 795, 805 -> mean 802.5 -> 60000/802.5 = 74.77 -> rounds to 75
  assert.strictEqual(Signal.computeHR(cleaned), 75);

  // rMSSD must skip any pair touching index 2: only pairs (0,1) and (3,4) count.
  // diffs: 810-800=10, 805-795=10 -> squares 100,100 -> mean 100 -> sqrt 10
  assert.strictEqual(Signal.computeRMSSD(cleaned), 10);
});

// --- Extra/duplicate beat: one interval far too short ---

test("an implausibly short interval (duplicate beat) is excluded with a matching reason", () => {
  const rr = [800, 810, 795, 805, 150]; // index 4 is far below the 333ms plausibility floor
  const cleaned = Signal.cleanRRIntervals(rr);
  assert.strictEqual(cleaned.valid[4], false);
  assert.ok(/extra\/duplicate/i.test(cleaned.reasons[4]), "reason should mention a possible extra/duplicate beat");
});

// --- assessQuality: each criterion independently, plus the all-pass case ---

test("assessQuality passes when all criteria clear their thresholds", () => {
  const cleaned = { valid: new Array(10).fill(true) }; // 100% valid
  const crossCheck = { countA: 10, matched: 9 }; // 90% agreement
  const result = Signal.assessQuality(cleaned, crossCheck, 10); // 10 raw peaks
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.reasons, []);
});

test("assessQuality fails with a specific reason when too few beats were detected", () => {
  const cleaned = { valid: [true, true, true] };
  const crossCheck = { countA: 3, matched: 3 };
  const result = Signal.assessQuality(cleaned, crossCheck, 5); // below the 8-beat minimum
  assert.strictEqual(result.ok, false);
  assert.ok(result.reasons.some((r) => /too few/i.test(r)));
});

test("assessQuality fails when fewer than 70% of intervals pass artifact correction", () => {
  const cleaned = { valid: [true, true, false, false, false, true, false, false, false, false] }; // 3/10 = 30%
  const crossCheck = { countA: 10, matched: 9 };
  const result = Signal.assessQuality(cleaned, crossCheck, 11);
  assert.strictEqual(result.ok, false);
  assert.ok(result.reasons.some((r) => /artifact checks/i.test(r)));
});

test("assessQuality fails when the two detectors agree on fewer than 60% of beats", () => {
  const cleaned = { valid: new Array(10).fill(true) };
  const crossCheck = { countA: 10, matched: 4 }; // 40% agreement
  const result = Signal.assessQuality(cleaned, crossCheck, 10);
  assert.strictEqual(result.ok, false);
  assert.ok(result.reasons.some((r) => /independent beat detectors/i.test(r)));
});

console.log(`\n${passed} test(s) passed.`);
