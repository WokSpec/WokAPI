# WokAPI Project Context

This file defines the purpose, boundaries, and ecosystem role of the WokAPI repository.

AI agents should read this file before making architectural changes.

## Purpose

WokAPI is the shared identity, commerce, and platform-infrastructure API for WokSpec products.

Its purpose is to act as the canonical service for authentication, sessions, billing, and shared product infrastructure.

## Core Responsibility

WokAPI is responsible for:

- authentication flows
- session management
- token issuance and verification contracts
- billing and subscription infrastructure
- shared product registry and API surfaces
- controlled proxying into other platform services

## Boundary Rules

Belongs in WokAPI:

- auth and identity contracts
- session and token flows
- Stripe integration
- shared platform API surfaces
- product registry and health-related infrastructure

Does not primarily belong in WokAPI:

- product-specific UI
- editorial experience logic
- creator-studio tooling
- orchestration runtime as a primary system concern

## Relationship to Other Systems

WokAPI supports multiple WokSpec systems.

Examples include:

- `WokSpec` site and dashboard flows
- `WokHei` product authentication and shared infrastructure
- `Nqita` or related AI service routing
- other ecosystem products that rely on shared user identity or billing

## Agent Guidance

When working in this repository:

- treat auth and token contracts as high-risk shared infrastructure
- preserve backward compatibility unless there is an explicit migration plan
- document cross-product impact when shared contracts change

## Quick Summary

WokAPI is the infrastructure spine for identity, billing, and shared product contracts across the WokSpec ecosystem.
