/**
 * @license
 * Standalone check: one DeepSeek message exchange through the ported client.
 *
 *   npx tsx packages/core/src/deepseek/test-client.ts ["prompt"]
 */

import { createDeepSeekClient } from './client.js';

async function main(): Promise<void> {
  const prompt = process.argv[2] ?? 'Reply with exactly the word: done';
  const client = createDeepSeekClient();
  console.log(`[test-client] prompt: ${prompt}`);
  const result = await client.chat(prompt, { thinking: false, search: true });
  console.log(
    `[test-client] finished=${result.finished} incomplete=${result.incomplete}`,
  );
  console.log(`[test-client] conversation_id=${result.conversationId}`);
  console.log('[test-client] reply:');
  console.log(result.text);
  if (result.toolCalls.length) {
    console.log(`[test-client] tool calls: ${result.toolCalls.length}`);
    for (const call of result.toolCalls) {
      console.log('  ' + call.text);
    }
  }
}

main().catch((error) => {
  console.error('[test-client] FAILED:', error);
  process.exit(1);
});
