## Description: <br>
Persistent cognitive memory for AI agents to query, record, review, and consolidate knowledge across sessions with spreading activation, FSRS scheduling, and NLI contradiction detection. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[idapixl](https://clawhub.ai/user/idapixl) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
Developers and agent users use this skill to configure agents to query, record, review, and consolidate local memory across sessions with a cortex-engine MCP server. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Agents may persist secrets, credentials, personal data, or confidential project details in local memory. <br>
Mitigation: Avoid storing sensitive data, and periodically review or prune stored memories. <br>
Risk: The skill depends on a separately installed cortex-engine npm package and MCP server. <br>
Mitigation: Install the scoped package `@fozikio/cortex-engine` and let it resolve to the latest version. Do not pin an old version and do not install the unscoped `cortex-engine`, which is deprecated but whose old versions still resolve. <br>


## Reference(s): <br>
- [Cortex Engine on ClawHub](https://clawhub.ai/idapixl/cortex-engine) <br>
- [@fozikio/cortex-engine npm package](https://www.npmjs.com/package/@fozikio/cortex-engine) <br>
- [cortex-engine source repository](https://github.com/Fozikio/cortex-engine) <br>


## Skill Output: <br>
**Output Type(s):** [Guidance, Markdown, Shell commands] <br>
**Output Format:** [Markdown with inline tool-call and bash examples] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Instruction-only skill; relies on a separately installed local cortex-engine MCP server.] <br>

## Skill Version(s): <br>
1.0.2 (source: server release metadata; artifact frontmatter reports 1.1.0) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
