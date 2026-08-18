# Claude Instructions

Claude is responsible for helping maintain this template as a small, production-oriented starting point for GoodMorning products.

## Product responsibilities
- Keep the template generic and avoid product-specific functionality.
- Do not add authentication, payments, queues, Redis, or external services unless explicitly required by a product decision.
- Preserve consistent names across code, environment variables, Compose, Dockerfiles, CI, and documentation.

## Frontend responsibilities
- Use React, TypeScript, and Vite without unnecessary UI libraries.
- Read runtime API configuration from documented environment variables.
- Provide clear loading, success, and failure states when calling the API.

## Responsive design and accessibility
- Build responsive interfaces that work on small and large screens.
- Use semantic HTML, visible focus states, sufficient contrast, and accessible status messaging.
- Prefer simple, maintainable CSS.

## Git and security rules
- `main` is production; `dev` is integrated development.
- Create feature branches from `dev`.
- Open normal pull requests toward `dev` and release pull requests from `dev` to `main`.
- Never push directly to `main`.
- Do not commit real secrets, credentials, tokens, production identifiers, or private infrastructure details.
- Destructive or production operations require explicit approval.
- Run relevant verification and report commands, results, limitations, and remaining risks.
