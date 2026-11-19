/**
 * Trusted devices for the platform console (PLATFORM_DEVICE_ONLY, docs/PLATFORM_REMOTE_ACCESS.md).
 *
 *   npm run platform:device -- add "My laptop"      register a device; prints a one-time setup
 *                                                    code (15 minutes) to enter in the console
 *   npm run platform:device -- list                 registered devices and when they were last used
 *   npm run platform:device -- remove "My laptop"   the device's key stops working at once
 *
 * Running `add` again for the same name issues a new code and disables the old key (for a new
 * browser on the same laptop, or after clearing browser data).
 */
import mongoose from 'mongoose';
import { connectDatabase } from '../src/database/connection';
import { addDevice, listDevices, removeDevice } from '../src/modules/platform-admin/platform-devices';

const USAGE = 'Usage: npm run platform:device -- add "<name>" | list | remove "<name>"';

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const name = rest.join(' ').trim();
  await connectDatabase();
  if (cmd === 'add' && name) {
    const d = await addDevice(name);
    console.log(`\nDevice "${d.name}": open the admin panel on that device, choose "Set up this device"`);
    console.log(`and enter this code within ${d.expiresInMinutes} minutes (it works once):\n\n    ${d.code}\n`);
    console.log('Any earlier key of this device no longer works.');
  } else if (cmd === 'list') {
    const rows = await listDevices();
    if (!rows.length) console.log('No devices registered.');
    for (const r of rows)
      console.log(
        `${r.name.padEnd(30)} ${r.enrolledAt ? `set up ${r.enrolledAt.toISOString().slice(0, 16)}, last used ${r.lastSeenAt?.toISOString().slice(0, 16) ?? '-'}` : 'waiting for its setup code'}`,
      );
  } else if (cmd === 'remove' && name) {
    console.log(
      (await removeDevice(name)) ? `Removed "${name}": its key no longer works.` : `No device named "${name}".`,
    );
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
