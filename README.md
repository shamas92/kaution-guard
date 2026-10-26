# KautionGuard

KautionGuard is a tenant-focused tool for reviewing German rental documents and organizing visual evidence for apartment handovers.

## Planned stack

- `frontend/`: Next.js, TypeScript, Tailwind CSS
- `backend/`: FastAPI, Python

## Project layout

```text
backend/
  legal_context/   Local legal reference material (to be added and verified)
  storage/         Temporary processing output (ignored by Git)
frontend/
  src/app/         Next.js app routes
  src/components/  UI components
  src/lib/         Frontend API helpers
```

## Getting started

Setup instructions will be added as the application is implemented. Do not commit API keys or private tenant documents. Copy `.env.example` to `.env` when environment variables are defined; `.env` is ignored by Git.

## Planned capabilities

- Review rental contracts and utility statements
- Draft German correspondence for tenant review
- Record move-in condition evidence and prepare handover documentation
- Compare move-in and move-out evidence

All legal findings and generated correspondence should be checked by a qualified professional before use.
