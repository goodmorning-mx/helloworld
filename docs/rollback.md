# Rollback

Rollback procedures depend on the product's hosting environment and must be approved before execution.

General approach:
1. Identify the last known-good commit or image.
2. Confirm database compatibility before changing running services.
3. Use the approved deployment platform rollback mechanism.
4. Verify `GET /health` and the frontend after rollback.
5. Report commands, results, impact, and follow-up actions.

Do not perform production rollback or destructive operations without explicit approval.
