/**
 * `npx tsx scripts/runpod-stop.ts` — stop (never delete) every Brain pod (name starts with the
 * pod name Brain uses). A stopped pod bills no GPU; runpod-auto recreates a deleted pod but never
 * starts a stopped one. Owner cost control, 2026-11-16. Prints no secret.
 */
import { POD_NAME, listPods } from '../server/services/cheap/runpodRestore.ts';

const key = process.env['RUNPOD_API_KEY']?.trim();
if (!key) {
  console.log('FAIL config: RUNPOD_API_KEY is required');
  process.exit(2);
}
const pods = (await listPods(key)).filter((p) => String((p as { name?: unknown }).name ?? '').startsWith(POD_NAME));
if (!pods.length) console.log('STOP none: no Brain pod exists');
for (const pod of pods) {
  const res = await fetch(`https://rest.runpod.io/v1/pods/${pod.id}/stop`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
  console.log(`STOP ${pod.id} HTTP ${res.status} ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)}`);
}
