import type { ShieldResult, Shields } from '../contracts';
import { PromptShieldsClient } from './client';

const client = new PromptShieldsClient();

export const shields: Shields = {
  get available(): boolean {
    return client.available;
  },

  async scanDocuments(docs: string[], userPrompt?: string): Promise<ShieldResult> {
    return client.scanDocuments(docs, userPrompt);
  },
};
