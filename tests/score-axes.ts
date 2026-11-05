/** A score-model answer whose weighted score is exactly `score` (every row of weights sums to 10). */
export const scoreAxes = (score: number, type = "company_project") => ({
  type,
  sig: score / 10,
  nov: score / 10,
  cred: score / 10,
  reson: score / 10,
  act: score / 10,
  materialUnusable: false,
});
