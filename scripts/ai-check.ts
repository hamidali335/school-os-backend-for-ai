/**
 * Quick live check of the AI configuration in .env (or a saved admin setting when the API is running).
 * Usage: npm run ai:check
 */
import { providerFromEnv } from '../src/modules/ai/provider';

async function main() {
  const p = providerFromEnv();
  console.log(`Provider: ${p.name}  Model: ${p.model}  Configured: ${p.isConfigured()}`);
  if (!p.isConfigured()) throw new Error('AI is not configured: set AI_PROVIDER, AI_API_KEY and AI_MODEL in .env');

  const t0 = Date.now();
  const res = await p.chat({ messages: [{ role: 'user', content: 'Reply with exactly: OK' }], maxTokens: 300 });
  console.log(
    `1) Chat: "${(res.content ?? '').trim()}" in ${Date.now() - t0} ms, tokens ${res.usage?.totalTokens ?? '?'}`,
  );

  const t1 = Date.now();
  const tool = await p.chat({
    messages: [{ role: 'user', content: 'How many students are absent today? Use the tool.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_attendance_today',
          description: "Today's attendance",
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    maxTokens: 400,
  });
  console.log(
    `2) Tool calling: ${tool.toolCalls.length ? `called ${tool.toolCalls[0].function.name}` : 'no tool call (answered directly)'} in ${Date.now() - t1} ms`,
  );

  const models = (await p.listModels?.()) ?? [];
  console.log(
    `3) Models available to this key: ${models.length}${models.length ? ` (e.g. ${models.slice(0, 6).join(', ')})` : ''}`,
  );
}

main().catch((err) => {
  console.error('AI check failed:', err?.message ?? err, err?.detail ? `\nProvider says: ${err.detail}` : '');
  process.exit(1);
});
