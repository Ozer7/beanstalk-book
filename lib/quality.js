// The quality loop, used for everything the image model makes: generate, analyse,
// and if it fails, generate again, up to 3 generations in all. If none passes,
// keep the best of the three.
import { PASS_SCORE } from "./vision.js";

export const MAX_GENERATIONS = 3;

/**
 * make(attempt, problems) -> any result     analyse(result) -> { score, problems }
 * canRetry(lastMs) -> false once there's no time left for another generation
 * onAttempt({ attempt, score, problems, ms, error })
 */
export async function bestOfThree({ make, analyse, canRetry = () => true, onAttempt = () => {} }) {
  let best = null, lastProblems = [], lastError = null, lastMs = 0;
  const attempts = [];
  for (let attempt = 1; attempt <= MAX_GENERATIONS; attempt++) {
    if (attempt > 1 && !canRetry(lastMs)) { attempts.push({ attempt, skipped: "out of time" }); break; }
    const t = Date.now();
    try {
      const result = await make(attempt, lastProblems);
      const check = await analyse(result).catch((err) => ({ score: null, problems: [], checkError: err.message }));
      const score = check.score;
      lastMs = Date.now() - t;
      const rec = { attempt, score, problems: check.problems, ms: lastMs };
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
