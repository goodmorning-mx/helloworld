# GoodMorning MVP Template Agent Instructions

## Branching and pull requests
- `main` is production and must remain deployable.
- `dev` is the integrated development branch.
- Create feature branches from `dev`.
- Open normal pull requests toward `dev`.
- Open release pull requests from `dev` to `main`.
- Do not push directly to `main`.

## Verification and reporting
- Run the relevant checks before reporting work as complete.
- Report every command run and its result.
- Call out any check that could not run and explain the environment limitation.
- Confirm that no real secrets, credentials, tokens, or production identifiers were added.

## Safety and approvals
- Do not perform destructive operations without explicit approval.
- Do not run production operations, migrations, deploys, rollbacks, or infrastructure changes without explicit approval.
- Do not fabricate infrastructure details, credentials, application IDs, server names, or deployment status.
