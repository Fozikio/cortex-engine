# Security Policy

## Supported versions

Security fixes land on the latest published minor. `@fozikio/cortex-engine`
is currently at **1.4.1**; older minors are not backported.

| Version | Supported |
| ------- | --------- |
| 1.4.x   | Yes       |
| < 1.4   | No        |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub's
[Private vulnerability reporting](https://github.com/Fozikio/cortex-engine/security/advisories/new)
on this repository. That routes straight to the maintainers and keeps the
details unpublished until a fix is available.

Please include:

- what an attacker can achieve, not only what is technically wrong
- the affected version and how the package is being consumed
  (library import, `serve --rest`, stdio MCP server, or the Docker image)
- a minimal reproduction, if you have one

You can expect an acknowledgement within a week. If a report is confirmed,
we will agree a disclosure timeline with you before publishing.

## Scope notes

A few things are worth stating up front, because they are properties of the
design rather than defects:

- **Optional peer dependencies are loaded via dynamic `import()`.** Cloud
  and embedding providers are only pulled in when configured. A consumer that
  installs none of them never loads that code.
- **The REST server binds `0.0.0.0` in the Docker image** so the container is
  reachable. It performs no authentication of its own. Do not expose it
  directly to an untrusted network — put it behind something that
  authenticates.
- **Config files can carry API keys.** `config-loader` deliberately warns when
  it finds `openai_api_key` in a config file rather than the environment.
  Reports that keys in a config file are readable by that file's readers are
  not vulnerabilities.
