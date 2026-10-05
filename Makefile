# Entry points (docs/06-agents/01-parallel-development-rules.md §8.1; ADR-0017). Commit after `pnpm check`;
# merge on a `make verify` receipt for the PR's final commit, from any executor. A hosted CI is only one of
# them: GitHub Actions runs this same target (.github/workflows/verify.yml; TASK-0015), never as a required check.
#   make verify [TASK=TASK-nnnn] [SHA=<40 hex>]    every check, a receipt in .verify/receipts/
#   make check                                     the fast subset (same as pnpm check), no receipt
#   make release-check / make nightly              skeletons: they fail until their stages exist
#   make tasks-index                               regenerate tasks/INDEX.md (integrator, on main)
# Settings are environment variables; see scripts/verify/README.md.

.PHONY: verify check release-check local-release-check nightly tasks-index

verify:
	node scripts/verify/run.ts $(if $(TASK),--task $(TASK)) $(if $(SHA),--sha $(SHA))

check:
	node scripts/verify/run.ts --quick

release-check:
	node scripts/verify/run.ts --release-check

# A recovered candidate failure intentionally returns nonzero; inspect its journal.
local-release-check:
	node deploy/local-release.ts --sha "$(SHA)" --previous "$(PREVIOUS_IMAGE)" --candidate "$(CANDIDATE_IMAGE)" --record "$(RECORD)"

nightly:
	node scripts/verify/run.ts --nightly

tasks-index:
	node scripts/verify/tasks.ts --write-index
