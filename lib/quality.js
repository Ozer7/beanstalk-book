// The quality loop, used for everything the image model makes: generate, analyse,
// and if it fails, generate again, up to 3 generations in all. If none passes,
// keep the best of the three.
import { PASS_SCORE } from "./vision.js";
import { withMeter } from "./cost.js";

export const MAX_GENERATIONS = 3;
class OutOfTime extends Error {}

/**
 * make(attempt, problems) -> any result     analyse(result) -> { score, problems }
 * timeLeft() -> how many ms this picture may still use. A new generation only
 * starts if there's room for one, and one that overruns is dropped, so the book
 * keeps its promise of 60 seconds and keeps the best picture so far.
 * onAttempt({ attempt, score, problems, ms, error })
 */
export async function bestOfThree({ make, analyse, timeLeft = () => Infinity, retryNeeds = 0, onAttempt = () => {} }) {
  let best = null, lastProblems = [], lastError = null;
  const attempts = [];
  for (let attempt = 1; attempt <= MAX_GENERATIONS; attempt++) {
    if (attempt > 1 && timeLeft() < retryNeeds) { attempts.push({ attempt, skipped: "out of time" }); break; }
    const t = Date.now();
    try {
      // Every API call made for this attempt is costed against it (see cost.js).
      const generation = withMeter({ attempt }, async () => {
        const result = await make(attempt, lastProblems);
        const check = await analyse(result).catch((err) => ({ score: null, problems: [], checkError: err.message }));
        return { result, check };
      });
      // Only a retry can be dropped: the first try is all a page has.
      const left = timeLeft();
      const { result, check } = attempt === 1 || left === Infinity ? await generation
        : await Promise.race([generation, new Promise((_, no) => setTimeout(() => no(new OutOfTime()), left))]);
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
      if (err instanceof OutOfTime) { attempts.push({ attempt, skipped: "ran out of time" }); break; }
      lastError = err;
      const rec = { attempt, error: err.message, ms: Date.now() - t };
      attempts.push(rec);
      onAttempt(rec);
    }
  }
  return { best, attempts, lastError };
}
