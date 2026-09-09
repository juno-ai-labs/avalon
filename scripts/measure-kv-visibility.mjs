#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { isEntryPoint } from './entry-point.mjs';

/** Each reader observes both a cached absence and a cached previous version. */
export async function measureVisibility({ writer, readers, samples, intervalMs, observationMs, token }) {
  const results = [];
  const call = async (url, id, method = 'GET') => {
    const response = await fetch(`${url.replace(/\/$/u, '')}/${id}`, {
      method, headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`probe_${method}_${response.status}`);
    return method === 'DELETE' ? null : response.json();
  };
  for (let sample = 0; sample < samples; sample++) {
    const id = crypto.randomUUID();
    try {
      for (const phase of ['creation', 'replacement']) {
        await Promise.all(readers.map((reader) => call(reader, id)));
        const write = await call(writer, id, 'POST');
        const startedAt = Date.now();
        const observed = await Promise.all(readers.map(async (reader) => {
          let last;
          do {
            last = await call(reader, id);
            if (last.value?.version === write.value.version) return {
              sample, phase, reader, placement: last.placement, executionPlacement: last.executionPlacement, ingressColo: last.ingressColo,
              writeAckMs: write.kvMs, visibilityMs: last.completedAt - write.value.mutationAt,
              readMs: last.kvMs, observed: true,
            };
            await sleep(intervalMs);
          } while (Date.now() - startedAt < observationMs);
          return { sample, phase, reader, observed: false, observationMs };
        }));
        results.push(...observed);
        for (const result of observed) process.stdout.write(`${JSON.stringify(result)}\n`);
        if (observed.some((result) => !result.observed)) break;
      }
    } finally { await call(writer, id, 'DELETE'); }
  }
  return results;
}

if (isEntryPoint(import.meta.url)) {
  const { values } = parseArgs({ options: {
    writer: { type: 'string' }, reader: { type: 'string', multiple: true },
    samples: { type: 'string' }, 'interval-ms': { type: 'string' }, 'observation-ms': { type: 'string' },
  } });
  const number = (name) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`positive_${name}_required`);
    return value;
  };
  if (!values.writer || !values.reader?.length || !process.env.PROBE_TOKEN) throw new Error('writer_readers_and_PROBE_TOKEN_required');
  await measureVisibility({ writer: values.writer, readers: values.reader,
    samples: number('samples'), intervalMs: number('interval-ms'), observationMs: number('observation-ms'), token: process.env.PROBE_TOKEN });
}
