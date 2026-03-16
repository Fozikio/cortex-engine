---
name: learn-project
version: 1.0.0
description: Bootstrap cortex with project knowledge — reads key files and observes what it learns into the project namespace
author: idapixl
tags: [onboarding, bootstrap, memory, project]
---

# Learn Project

Quickly populate your agent's project memory by reading the codebase.

## When to use

Run this when cortex is new and you want the agent to understand your project
without waiting for it to learn organically over several sessions.

## What it does

Read these files (skip any that don't exist):

1. **package.json** — framework, key dependencies, scripts, project name
2. **README.md** — stated purpose, setup instructions
3. **tsconfig.json / jsconfig.json** — language config, strict mode
4. **Directory structure** (1 level deep) — architecture shape
5. **Config files** — .eslintrc, prettier, vite/next/webpack config
6. **Last 10 git commits** — current momentum, commit style
7. **CI config** — .github/workflows, Dockerfile, deploy scripts

## How to observe

For each file read, extract 1-3 key facts. Observe into the **project** namespace:

```
observe("Next.js 14 app with App Router, TypeScript strict mode", namespace: "project")
observe("Tests in __tests__/ using vitest, coverage threshold 80%", namespace: "project")
observe("Monorepo: packages/api (Hono) and packages/web (Next.js), shared types in packages/shared", namespace: "project")
```

## Rules

- **8-15 observations max.** This is a first impression, not a full audit.
- **Architectural facts only.** "Uses React" matters. "Has 847 files" doesn't.
- **Skip dependency lists.** Don't observe every package.json dependency.
- **Skip generated files.** Lock files, dist/, node_modules/ tell you nothing useful.
- **Ask: would my future self search for this?** If not, don't store it.

## After scanning

Show the user what you learned in a brief summary:

> "Got it — Next.js 14 app with Drizzle ORM, deployed to Vercel, monorepo
> with packages/api and packages/web. Tests use vitest. I'll pick up
> patterns as we work together."

If anything is wrong, the user corrects it. Corrections are high-signal —
observe those too.
