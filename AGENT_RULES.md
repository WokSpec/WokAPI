# Agent Rules

These rules apply to AI agents working inside the WokAPI repository.

Read `PROJECT_CONTEXT.md` before making architectural changes.

## Primary Rule

Treat WokAPI as critical shared infrastructure.

Changes here can affect multiple products at once.

## Scope Discipline

Changes in this repository should strengthen one or more of the following:

- auth correctness
- token and session integrity
- billing and subscription flows
- shared platform API contracts
- operational reliability of shared infrastructure

## Shared-Contract Rule

Do not change auth payloads, token semantics, or shared API contracts casually.

When shared contracts change, document downstream impact explicitly.

## Ecosystem Boundary Rules

Do not turn WokAPI into a product-specific application layer.

Product-specific editorial, creative, or orchestration concerns belong elsewhere unless the change is a clear infrastructure integration point.

## Working Principle

Stable shared infrastructure first, ecosystem integration second.
