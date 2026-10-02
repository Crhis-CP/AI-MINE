# Entry points (docs/06-agents/01-parallel-development-rules.md §8.1; ADR-0017). Commit after `pnpm check`;
# merge on a `make verify` receipt for the PR's final commit. No hosted CI is involved.
#   make verify [TASK=TASK-nnnn] [SHA=<40 hex>]    every check, a receipt in .verify/receipts/
#   make check                                     the fast subset (same as pnpm check), no receipt
#   make release-check / make nightly              skeletons: they fail until their stages exist
#   make tasks-index                               regenerate tasks/INDEX.md (integrator, on main)
# Settings are environment variables; see scripts/verify/README.md.

.PHONY: verify check release-check nightly tasks-index

verify:
	node scripts/verify/run.ts $(if $(TASK),--task $(TASK)) $(if $(SHA),--sha $(SHA))

check:
	node scripts/verify/run.ts --quick

release-check:
	node scripts/verify/run.ts --release-check

nightly:
	node scripts/verify/run.ts --nightly

tasks-index:
	node scripts/verify/tasks.ts --write-index
