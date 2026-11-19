import mongoose from 'mongoose';
import { connectDatabase } from '../src/database/connection';
import { onboardSchool } from '../src/modules/schools/schools.service';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { DEFAULT_PLAN_TEMPLATES, templateDocument } from '../src/modules/subscriptions/default-plans';
import { School } from '../src/modules/schools/school.model';
import { User } from '../src/modules/users/user.model';
import { closeHasherPool } from '../src/modules/auth/password-hasher';
import { hashPassword } from '../src/modules/auth/tokens';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

async function main() {
  await connectDatabase();

  const code = (arg('code') || 'APSS').trim().toUpperCase();
  const email = (arg('email') || 'chmahar335@gmail.com').trim().toLowerCase();
  const password = arg('password') || 'Password@123';
  const name = arg('name') || 'Army Public School & College (APSS)';

  // 1. Ensure default plans exist
  const planCount = await Plan.countDocuments();
  if (planCount === 0) {
    for (const t of DEFAULT_PLAN_TEMPLATES) {
      await Plan.create(templateDocument(t));
    }
  }

  // 2. Check existing school
  let school = await School.findOne({ code });
  if (school) {
    console.log(`School ${code} already exists.`);
    // Update or ensure user exists with this password
    let user = await User.findOne({ schoolId: school._id, email });
    if (!user) {
      user = await User.create({
        schoolId: school._id,
        name: 'School Administrator',
        email,
        passwordHash: await hashPassword(password),
        role: 'school_owner',
        status: 'active',
      });
      console.log(`Created owner user ${email} for school ${code}`);
    } else {
      user.passwordHash = await hashPassword(password);
      user.status = 'active';
      await user.save();
      console.log(`Updated owner password for ${email}`);
    }
  } else {
    // Onboard school
    const result = await onboardSchool({
      name,
      code,
      email,
      planCode: 'pro_max',
      campus: { name: 'Main Campus', code: 'MAIN' },
      owner: {
        name: 'School Administrator',
        email,
        password,
      },
    });
    console.log(`Successfully onboarded school ${code} (${name}) with owner ${email}`);
  }

  await closeHasherPool();
  await mongoose.disconnect();
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to create school:', err);
  process.exit(1);
});
