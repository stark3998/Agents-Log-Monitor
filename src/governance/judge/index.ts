import { govConfig } from '../config';
import type { Judge, JudgeInput } from '../contracts';
import type { JudgeVerdict } from '../types';
import { FoundryChatClient } from './client';
import { buildGoalMessages, buildJudgeMessages } from './prompts';
import {
  goalResponseJsonSchema,
  goalResponseSchema,
  judgeResponseJsonSchema,
  judgeResponseSchema,
} from './schema';

const client = new FoundryChatClient();

function selectDeployment(input: JudgeInput, tier: 'fast' | 'escalation'): string {
  if (tier === 'escalation') return govConfig.foundry.escalationDeployment;
  const configured = input.lane.judge.model;
  if (configured && configured !== 'fast' && configured !== 'escalation') return configured;
  return govConfig.foundry.fastDeployment;
}

export const judge: Judge = {
  get available(): boolean {
    return govConfig.foundry.enabled;
  },

  async evaluate(input: JudgeInput, tier: 'fast' | 'escalation', timeoutMs: number): Promise<JudgeVerdict> {
    if (!this.available) throw new Error(`judge (${tier}) not configured`);
    const deployment = selectDeployment(input, tier);
    const result = await client.completeJson({
      deployment,
      messages: buildJudgeMessages(input),
      schemaName: 'governance_policy_judge',
      jsonSchema: judgeResponseJsonSchema,
      timeoutMs,
      maxTokens: 700,
    });
    const parsed = judgeResponseSchema.parse(result.value);
    return {
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      laneClause: parsed.lane_clause,
      model: result.deployment,
      tier,
      latencyMs: result.latencyMs,
    };
  },
};

/** Extract a one-sentence task goal from a user prompt; null when the LLM is unavailable. */
export async function extractGoal(prompt: string, previousGoal?: string): Promise<string | null> {
  if (!govConfig.foundry.enabled) return null;
  try {
    const result = await client.completeJson({
      deployment: govConfig.foundry.intentDeployment,
      messages: buildGoalMessages(prompt, previousGoal),
      schemaName: 'governance_goal_extraction',
      jsonSchema: goalResponseJsonSchema,
      timeoutMs: 3000,
      maxTokens: 120,
    });
    const parsed = goalResponseSchema.parse(result.value);
    const goal = parsed.goal?.trim();
    return goal || null;
  } catch {
    return null;
  }
}
