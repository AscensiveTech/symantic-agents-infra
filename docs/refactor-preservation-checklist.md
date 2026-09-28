# Infrastructure refactor preservation checklist

Baseline commit: `fd4a67be18ef7fb5e7250364f62856ece6cedad2` (`main`).

## Baseline

- [x] Remote state loaded from the production-serving `dev` stack.
- [x] AWS caller verified as account `883155611064`.
- [x] `terraform fmt -check -recursive` passed.
- [x] `terraform validate` passed.
- [x] Live `terraform plan` reported no changes.
- [x] 670/671 Node tests passed. The one pre-existing failure was the Retell
  contract fixture's missing `acquireSlotLock` fake, not production code.
- [x] Latest observed Amplify production release (`job 143`) succeeded.

## Resource identity

- [x] Terraform remains a single root module.
- [x] Only root `.tf` file names changed; no resource/data/module label changed.
- [x] No `for_each` key, physical resource name, route key, IAM statement,
  environment variable, provider secret, output, or backend setting changed.
- [x] Lambda source directories and archive boundaries are unchanged.
- [x] No state migration or `moved` block is required for file-only moves.
- [x] No resource was removed.

## Post-refactor validation

- [x] `terraform fmt -check -recursive`
- [x] `terraform validate`
- [x] all 671 Lambda and contract tests
- [x] live `terraform plan`: zero create, zero update, zero replace, zero delete
- [x] frontend production build passed; source route comparison is 39 before /
  39 after with no additions or removals

Unchecked items must be completed or explicitly explained in the pull request
before merge. Any unexpected replacement or deletion blocks the refactor.
