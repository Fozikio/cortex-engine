/**
 * social_score — score a social signal for engagement potential.
 *
 * 5-factor scoring: engagement, relevance, influence, recency, novelty.
 * Novelty checks cortex to see if we've interacted with this author before.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const HIGH_RELEVANCE = ['cortex-engine', 'fozikio', 'idapixl', '@idapixl', '@fozikio'];
const MED_RELEVANCE = [
  'agent memory', 'persistent memory', 'MCP memory', 'memory MCP',
  'context loss', 'agent forgets', 'memory decay', 'spaced repetition',
  'dream consolidation', 'typed memory', 'cognitive engine',
  'memory consolidation', 'agent brain', 'agent subconscious',
  'claude code memory', 'openclaw memory', 'mcp server memory',
  'open source agent', 'built my own agent', 'ai agent project',
];
const LOW_RELEVANCE = [
  'persistent context', 'context window', 'memory plugin',
  'long-term memory', 'session memory', 'vector store memory',
  'mem0', 'lossless-claw', 'QMD', 'brain-mcp',
  'vibe coding', 'vibecoding', 'side project', 'weekend project',
  'claude code', 'openclaw', 'open source', 'ai agent',
];

const WEIGHTS = { engagement: 0.25, relevance: 0.30, influence: 0.15, recency: 0.15, novelty: 0.15 };

function scoreEngagement(engagementScore: number): number {
  if (engagementScore >= 100) return 100;
  if (engagementScore >= 50) return 90;
  if (engagementScore >= 20) return 80;
  if (engagementScore >= 10) return 65;
  if (engagementScore >= 5) return 50;
  if (engagementScore >= 1) return 30;
  return 10;
}

function scoreRelevance(text: string, matchedRule?: string): number {
  const lower = text.toLowerCase();
  if (HIGH_RELEVANCE.some((kw) => lower.includes(kw.toLowerCase()))) return 100;
  const medMatches = MED_RELEVANCE.filter((kw) => lower.includes(kw.toLowerCase()));
  if (medMatches.length >= 2) return 90;
  if (medMatches.length === 1) return 70;
  const lowMatches = LOW_RELEVANCE.filter((kw) => lower.includes(kw.toLowerCase()));
  if (lowMatches.length >= 2) return 55;
  if (lowMatches.length === 1) return 40;
  if (matchedRule) return 30;
  return 10;
}

function scoreInfluence(followers: number): number {
  if (followers >= 50000) return 100;
  if (followers >= 10000) return 85;
  if (followers >= 5000) return 70;
  if (followers >= 1000) return 55;
  if (followers >= 500) return 40;
  if (followers >= 100) return 25;
  return 10;
}

function scoreRecency(timestamp: string): number {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours < 1) return 100;
  if (ageHours < 2) return 90;
  if (ageHours < 6) return 70;
  if (ageHours < 12) return 50;
  if (ageHours < 24) return 30;
  return 10;
}

export const socialScoreTool: ToolDefinition = {
  name: 'social_score',
  description:
    'Score a social media signal for engagement potential. 5-factor scoring: engagement level, topic relevance, author influence, recency, and novelty (whether we have interacted with this author before). Returns 0-100 score with breakdown.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The tweet/post text' },
      author: { type: 'string', description: 'Author username' },
      authorFollowers: { type: 'number', description: 'Author follower count' },
      engagementScore: { type: 'number', description: 'Likes + retweets*2 + replies' },
      timestamp: { type: 'string', description: 'ISO timestamp of the post' },
      matchedRule: { type: 'string', description: 'Which search rule matched (tag)' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['text', 'author'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const text = String(args['text'] || '');
    const author = String(args['author'] || 'unknown');
    const authorFollowers = Number(args['authorFollowers'] || 0);
    const engagementNum = Number(args['engagementScore'] || 0);
    const timestamp = String(args['timestamp'] || new Date().toISOString());
    const matchedRule = typeof args['matchedRule'] === 'string' ? args['matchedRule'] : undefined;
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    const engagement = scoreEngagement(engagementNum);
    const relevance = scoreRelevance(text, matchedRule);
    const influence = scoreInfluence(authorFollowers);
    const recency = scoreRecency(timestamp);

    // Novelty — check if we've interacted with this author before via cortex
    let novelty = 70; // default if cortex unavailable
    try {
      const store = ctx.namespaces.getStore(namespace);
      const embedding = await ctx.embed.embed(`conversation with @${author}`);
      const results = await store.findNearest(embedding, 3);
      const hasInteraction = results.some((r) => {
        const rText = `${r.memory?.name || ''} ${r.memory?.definition || ''}`.toLowerCase();
        return rText.includes(`@${author.toLowerCase()}`);
      });
      novelty = hasInteraction ? (results.length <= 2 ? 60 : 20) : 100;
    } catch {
      // cortex unavailable, use default
    }

    const score = Math.round(
      engagement * WEIGHTS.engagement +
      relevance * WEIGHTS.relevance +
      influence * WEIGHTS.influence +
      recency * WEIGHTS.recency +
      novelty * WEIGHTS.novelty
    );

    return {
      score: Math.min(100, Math.max(0, score)),
      scoreBreakdown: { engagement, relevance, influence, recency, novelty },
    };
  },
};
