// The quality loop, used for everything the image model makes: generate, analyse,
// and if it fails, generate again, up to 3 generations in all. If none passes,
// keep the best of the three.
import { PASS_SCORE } from "./vision.js";
import { blankPatches } from "./images.js";

export const MAX_GENERATIONS = 3;

/**
 * make(attempt, problems) -> any result     analyse(result) -> { score, problems }
 * canRetry() -> false once there's no time left for another generation
 * onAttempt({ attempt, score, problems, ms, error })
 */
export async function bestOfThree({ make, analyse, pixels = (r) => r, canRetry = () => true, onAttempt = () => {} }) {
  let best = null, lastProblems = [], lastError = null;
  const attempts = [];
  for (let attempt = 1; attempt <= MAX_GENERATIONS; attempt++) {
    if (attempt > 1 && !canRetry()) { attempts.push({ attempt, skipped: "out of time" }); break; }
    const t = Date.now();
    try {
      const result = await make(attempt, lastProblems);
      const check = await analyse(result).catch((err) => ({ score: null, problems: [], checkError: err.message }));
      // The eyes can miss a blank patch; the pixels can't.
      const blanks = await blankPatches(pixels(result));
      if (blanks >= 3) { check.blank = blanks; check.score = Math.min(check.score ?? 0, 20); check.problems = [...(check.problems || []), "a blank, flat patch where something should be painted"]; }
      const score = check.score;
      const rec = { attempt, score, problems: check.problems, ms: Date.now() - t };
      attempts.push(rec);
      onAttempt(rec);
      // A check that couldn't run doesn't fail the picture, but any scored picture beats it.
      const rank = score ?? 0;
      if (!best || rank > best.rank) best = { result, check, rank, attempt };
      if (score == null || score >= PASS_SCORE) break;
      lastProblems = check.problems || [];
    } catch (err) {
      lastError = err;
      const rec = { attempt, error: err.message, ms: Date.now() - t };
      attempts.push(rec);
      onAttempt(rec);
    }
  }
  return { best, attempts, lastError };
}
