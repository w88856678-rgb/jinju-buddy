// Opt-in live evaluation. Only the synthetic fixture is sent to Hy4.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { credentials } from '../server/config.js';
import { extractQuote, QuoteQueue } from '../server/quotes.js';
import { testApp, until } from './support.js';
const cases = JSON.parse(await readFile(new URL('./fixtures/quote-cases.json', import.meta.url)));
const baseline = process.argv[3] ? (await import(pathToFileURL(process.argv[3]))).extractQuote : null;
const token = credentials().token;
const app = await testApp();
const queue = new QuoteQueue(
  app.store,
  (row, context) => extractQuote(token, row, context),
  () => {},
);
const results = [];
try {
  for (const [mode, speaker, body, expected] of cases) {
    const index = results.length;
    const id = 'fixture/' + index;
    const row = app.store.upsert({
      id,
      body,
      mode,
      speaker,
      stream: 'fixture',
      startMs: index * 1800,
      endMs: index * 1800 + 1500,
    });
    const start = performance.now();
    const old = baseline ? baseline(token, row, app.store.context(row)).catch(() => '〈模型错误〉') : null;
    queue.add(row.id);
    const final = await until(() => {
      const current = app.store.segment(id);
      return current.status !== 'pending' && current;
    }, 32000);
    const ms = Math.round(performance.now() - start);
    const { status, quote, problem, sourceIds } = final;
    results.push({
      index: index + 1,
      mode,
      body,
      speaker,
      expected,
      status,
      quote,
      problem,
      sources: JSON.parse(sourceIds || '[]'),
      ms,
      ...(baseline ? { old: await old } : {}),
    });
    console.log(index + 1, expected, status, ms);
  }
  await writeFile(process.argv[2], JSON.stringify(results, null, 2));
} finally {
  await queue.stop();
  await app.cleanup();
}
