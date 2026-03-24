/**
 * social_draft — draft a reply tweet using cortex context + LLM.
 *
 * Uses ctx.llm for generation (whatever LLM cortex is configured with).
 * Queries cortex for talking points and interaction history.
 * Ensures @mention, 280 char limit, voice guidelines.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const VOICE_PROMPT = `You are drafting a reply for @idapixl (the Fozikio project).

Voice rules:
- Technical but not academic. First-person plural ("we built", "our setup").
- Specific > vague. Mention FSRS, prediction error gating, dream consolidation by name.
- Acknowledge the other person's approach before introducing ours.
- The reply MUST work as a useful comment even if you remove the cortex-engine link.
- Never use astroturfing language ("game-changer", "revolutionary", "check this out!").
- Match the thread energy — casual threads get casual replies, technical threads get technical replies.
- ALWAYS start the reply with @username. This is mandatory.
- Max 280 characters for Twitter (including the @mention). Be concise.

Product context:
- cortex-engine: open-source (MIT) persistent memory system for AI agents
- Key differentiators: spaced repetition decay (FSRS-6), typed memories (observe/believe/wonder), dream consolidation, prediction error gating
- Works as MCP server, supports SQLite (local) and Firestore (cloud)
- npm package: cortex-engine | GitHub: github.com/Fozikio/cortex-engine
- Only include the link if it feels natural. Many replies should NOT include it.`;

export const socialDraftTool: ToolDefinition = {
  name: 'social_draft',
  description:
    'Draft a reply tweet for a scored social signal. Queries cortex for talking points and interaction history, then generates a 280-char reply using the configured LLM. Always starts with @username.',
  inputSchema: {
    type: 'object',
    properties: {
      author: { type: 'string', description: 'Author username to reply to' },
      text: { type: 'string', description: 'The original tweet text' },
      score: { type: 'number', description: 'Signal score (0-100)' },
      engagementScore: { type: 'number', description: 'Engagement level' },
      matchedRule: { type: 'string', description: 'Which search rule matched' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['author', 'text'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const author = String(args['author'] || 'unknown');
    const text = String(args['text'] || '');
    const score = Number(args['score'] || 0);
    const engagementScore = Number(args['engagementScore'] || 0);
    const matchedRule = typeof args['matchedRule'] === 'string' ? args['matchedRule'] : 'none';
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    // Get context from cortex memory
    let talkingPoints = '';
    let interactionHistory = '';
    try {
      const store = ctx.namespaces.getStore(namespace);
      const topicEmbed = await ctx.embed.embed(`cortex-engine ${text.substring(0, 100)}`);
      const topicResults = await store.findNearest(topicEmbed, 3);
      if (topicResults.length > 0) {
        talkingPoints = `Relevant talking points from our memory:\n${topicResults.map((r) => r.memory?.definition || r.memory?.name || '').join('\n')}`;
      }

      const authorEmbed = await ctx.embed.embed(`interaction with @${author}`);
      const authorResults = await store.findNearest(authorEmbed, 2);
      interactionHistory = authorResults.length > 0
        ? `We've interacted with @${author} before.`
        : `First interaction with @${author}.`;
    } catch {
      interactionHistory = `First interaction with @${author} (cortex unavailable).`;
    }

    const prompt = `${VOICE_PROMPT}

${talkingPoints}

${interactionHistory}

---

The tweet you're replying to:
@${author}: "${text}"
Engagement: ${engagementScore} (likes+retweets+replies)
Rule matched: ${matchedRule}

Write a reply tweet (max 280 chars). Start with @${author}. If the tweet is about a problem cortex solves, mention it naturally. If it's just adjacent conversation, engage on the ideas without pitching.

Reply:`;

    const generated = await ctx.llm.generate(prompt, { temperature: 0.7, maxTokens: 100 });

    // Clean up
    let draft = generated.trim().replace(/^["']|["']$/g, '');
    const mention = `@${author}`;
    if (!draft.toLowerCase().startsWith(mention.toLowerCase())) {
      draft = `${mention} ${draft}`;
    }
    draft = draft.substring(0, 280);

    return {
      author,
      text: draft,
      platform: 'twitter',
      score,
      originalText: text.substring(0, 200),
    };
  },
};
