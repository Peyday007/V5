/**
 * The integration registry's terminal (§103), run by `integrations.yml`.
 *
 *   node --import tsx scripts/integrations.ts list                 every integration, its credentials and consumers
 *   node --import tsx scripts/integrations.ts syncable             names a same-named GitHub secret may supply
 *   node --import tsx scripts/integrations.ts generated            names the workflow generates
 *   node --import tsx scripts/integrations.ts public-keys          the deployment's public signing and seal keys
 *   node --import tsx scripts/integrations.ts unseal NAME B64      print NAME=value for `flyctl secrets import` (machine only)
 *   node --import tsx scripts/integrations.ts seal SPKI NAME       read a value on stdin, print the sealed form (a session)
 *   node --import tsx scripts/integrations.ts fingerprints         NAME and a 16-hex sha256 prefix of each syncable value held here
 *   node --import tsx scripts/integrations.ts repaired ID STATE NAME     record an automatic repair of NAME
 *   node --import tsx scripts/integrations.ts check [--github-secrets A,B] [--record SOURCE]
 *
 * `check` prints `INTEGRATIONS: OK` when every integration in use is connected
 * or configured, `INTEGRATIONS: ATTENTION` otherwise, with one line each.
 * Nothing here prints a credential value except `unseal`, whose output is
 * piped straight into `flyctl secrets import` and never to a log.
 */
import { createHash } from 'node:crypto';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { recordIntegrationEvent } from '../server/repos/integrationEvents.ts';
import { checkAndRecord, readIntegrations } from '../server/services/integrations/health.ts';
import { seal, sealPublicKey, signingPublicKey, unseal } from '../server/services/integrations/keys.ts';
import { INTEGRATIONS, githubSyncable, sealable } from '../server/services/integrations/registry.ts';

const [command, ...rest] = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<number> {
  switch (command) {
    case 'list': {
      for (const one of INTEGRATIONS) {
        console.log(`${one.id} — ${one.name} (held by ${one.heldBy})`);
        for (const c of one.credentials) console.log(`  ${c.required ? 'needs' : 'may use'} ${c.name} [${c.where}] via ${c.delivery.join(' / ')}`);
        for (const c of one.consumers) console.log(`  used by ${c.component} — ${c.path}`);
      }
      return 0;
    }
    case 'syncable':
      console.log(githubSyncable().join(' '));
      return 0;
    case 'generated':
      console.log([...new Set(INTEGRATIONS.flatMap((one) => one.credentials).filter((c) => c.delivery.includes('GENERATED')).map((c) => c.name))].sort().join(' '));
      return 0;
    case 'public-keys': {
      const signing = signingPublicKey();
      const sealing = sealPublicKey();
      console.log(signing ? `SIGNING-PUBLIC ${signing.kid} ${signing.spki}` : 'SIGNING-PUBLIC MISSING');
      console.log(sealing ? `SEAL-PUBLIC ${sealing.kid} ${sealing.spki}` : 'SEAL-PUBLIC MISSING');
      return 0;
    }
    case 'unseal': {
      const [name, ciphertext] = rest;
      if (!name || !ciphertext || !sealable().includes(name)) {
        console.error(`UNSEAL: REFUSED — ${name ?? '(no name)'} is not a credential the registry lets a connector deliver (${sealable().join(', ')}).`);
        return 2;
      }
      const value = unseal(ciphertext);
      const spec = INTEGRATIONS.flatMap((one) => one.credentials).find((c) => c.name === name)!;
      if (/[\r\n]/.test(value) || (spec.shape && !spec.shape.test(value))) {
        console.error(`UNSEAL: REFUSED — the sealed ${name} is not well-formed.`);
        return 2;
      }
      process.stdout.write(`${name}=${value}\n`);
      return 0;
    }
    case 'seal': {
      const [spki, name] = rest;
      if (!spki || !name || !sealable().includes(name)) {
        console.error(`SEAL: usage seal SPKI NAME (one of ${sealable().join(', ')}), value on stdin`);
        return 2;
      }
      console.log(seal(spki, await readStdin()));
      return 0;
    }
    case 'fingerprints': {
      for (const name of githubSyncable()) {
        const value = (process.env[name] ?? '').trim();
        if (value) console.log(`${name} ${createHash('sha256').update(value).digest('hex').slice(0, 16)}`);
      }
      return 0;
    }
    case 'repaired': {
      const [id, state, name] = rest;
      const how: Record<string, string> = {
        GENERATED: 'generated into the deployment\'s secrets',
        SYNCED: 'copied to the deployment from the GitHub secret of the same name',
        SEALED: 'delivered to the deployment sealed from an authorized connector',
      };
      if (!id || !state || !name || !how[state] || !INTEGRATIONS.some((one) => one.id === id)) {
        console.error('REPAIRED: usage repaired INTEGRATION_ID GENERATED|SYNCED|SEALED NAME');
        return 2;
      }
      await initDatabase();
      await recordIntegrationEvent({ integrationId: id, kind: 'REPAIR', state, detail: `${name} ${how[state]}.`, source: 'integrations.yml' });
      console.log(`REPAIRED: ${id} ${state}`);
      return 0;
    }
    case 'check': {
      const list = option('--github-secrets');
      const githubSecrets = list === undefined ? null : new Set(list.split(',').map((s) => s.trim()).filter(Boolean));
      const source = option('--record');
      let readings;
      if (source) {
        await initDatabase();
        readings = await checkAndRecord({ githubSecrets, source });
      } else {
        readings = await readIntegrations({ githubSecrets, probe: true });
      }
      let ok = true;
      for (const r of readings) {
        const healthy = r.state === 'CONNECTED' || r.state === 'CONFIGURED' || r.state === 'NOT_IN_USE';
        if (!healthy) ok = false;
        console.log(`  ${r.state.padEnd(11)} ${r.id}: ${r.detail}${r.ownerAction ? ` OWNER: ${r.ownerAction}` : ''}`);
      }
      console.log(ok ? 'INTEGRATIONS: OK' : 'INTEGRATIONS: ATTENTION');
      return 0;
    }
    default:
      console.error('usage: integrations.ts list|syncable|generated|public-keys|unseal|seal|repaired|check');
      return 2;
  }
}

const code = await main().catch((error: unknown) => {
  console.error(`INTEGRATIONS: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});
await closeDatabase().catch(() => undefined);
process.exit(code);
