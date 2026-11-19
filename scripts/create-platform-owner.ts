/**
 * Creates (or re-activates) a platform owner account. No default credentials exist.
 *
 * Any of these work (command-line arguments win over environment variables / .env):
 *
 *   npm run create-platform-owner -- --email you@company.com --name "Your Name" --password "A-Strong-Pass-2026"
 *
 *   # PowerShell
 *   $env:PLATFORM_OWNER_EMAIL="you@company.com"; $env:PLATFORM_OWNER_PASSWORD="A-Strong-Pass-2026"; npm run create-platform-owner
 *
 *   # bash
 *   PLATFORM_OWNER_EMAIL=you@company.com PLATFORM_OWNER_PASSWORD='A-Strong-Pass-2026' npm run create-platform-owner
 *
 * Re-running with an existing email only resets the password when --reset-password is passed.
 */
import mongoose from 'mongoose';
import { closeHasherPool } from '../src/modules/auth/password-hasher';
import { connectDatabase } from '../src/database/connection';
import { hashPassword, revokeAllForSubject } from '../src/modules/auth/tokens';
import { PlatformAdmin } from '../src/modules/platform-admin/platform-admin.model';
import { email as emailSchema, password as passwordSchema } from '../src/utils/zod';

const HELP = `
Usage:
  npm run create-platform-owner -- --email you@company.com --name "Your Name" --password "A-Strong-Pass-2026"

PowerShell alternative (note: "Set NAME value" does NOT set an environment variable in PowerShell):
  $env:PLATFORM_OWNER_EMAIL="you@company.com"
  $env:PLATFORM_OWNER_NAME="Your Name"
  $env:PLATFORM_OWNER_PASSWORD="A-Strong-Pass-2026"
  npm run create-platform-owner

You can also put PLATFORM_OWNER_EMAIL / PLATFORM_OWNER_NAME / PLATFORM_OWNER_PASSWORD in .env.
Password rules: at least 10 characters, with an upper-case letter, a lower-case letter and a digit.`;

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

async function main() {
  const rawEmail = arg('email') ?? process.env.PLATFORM_OWNER_EMAIL;
  const rawPassword = arg('password') ?? process.env.PLATFORM_OWNER_PASSWORD;
  const name = (arg('name') ?? process.env.PLATFORM_OWNER_NAME)?.trim() || 'Platform Owner';

  const email = emailSchema().safeParse(rawEmail);
  if (!email.success) {
    throw new Error(`${rawEmail ? `"${rawEmail}" is not a valid email address.` : 'No email given.'}\n${HELP}`);
  }
  const password = passwordSchema().safeParse(rawPassword);
  if (!password.success) {
    const reasons = rawPassword
      ? password.error.issues.map((i) => `  - ${i.message}`).join('\n')
      : '  - No password given.';
    throw new Error(`The password is not acceptable:\n${reasons}\n${HELP}`);
  }

  await connectDatabase();
  const existing = await PlatformAdmin.findOne({ email: email.data }).lean();
  if (existing) {
    if (!process.argv.includes('--reset-password')) {
      console.log(
        `Platform admin ${email.data} already exists (role ${existing.role}). Add --reset-password to change the password.`,
      );
      return;
    }
    await PlatformAdmin.updateOne(
      { _id: existing._id },
      {
        $set: { passwordHash: await hashPassword(password.data), status: 'active', role: 'platform_owner' },
        $inc: { tokenVersion: 1 },
      },
    );
    await revokeAllForSubject('platform', existing._id.toString(), 'password_reset');
    console.log(`Password reset for platform owner ${email.data}; existing sessions revoked.`);
    return;
  }
  await PlatformAdmin.create({
    name,
    email: email.data,
    role: 'platform_owner',
    passwordHash: await hashPassword(password.data),
  });
  console.log(`Created platform owner ${email.data} (${name}). Log in via POST /api/v1/platform/auth/login.`);
}

main()
  .then(() => mongoose.disconnect())
  // Password-hashing worker threads would otherwise keep the script running after it finished.
  .then(() => closeHasherPool())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
