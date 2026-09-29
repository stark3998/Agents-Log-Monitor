import { z } from 'zod';

export const judgeResponseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['allow', 'deny', 'escalate'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', maxLength: 300 },
    lane_clause: { type: 'string' },
  },
  required: ['verdict', 'confidence', 'rationale', 'lane_clause'],
} as const;

export const judgeResponseSchema = z.object({
  verdict: z.enum(['allow', 'deny', 'escalate']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(300),
  lane_clause: z.string(),
}).strict();

export const goalResponseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    goal: {
      anyOf: [
        { type: 'string', maxLength: 200 },
        { type: 'null' },
      ],
    },
  },
  required: ['goal'],
} as const;

export const goalResponseSchema = z.object({
  goal: z.string().max(200).nullable(),
}).strict();

export type JudgeResponse = z.infer<typeof judgeResponseSchema>;
export type GoalResponse = z.infer<typeof goalResponseSchema>;
