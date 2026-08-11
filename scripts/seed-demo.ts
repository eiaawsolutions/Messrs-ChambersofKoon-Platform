import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, stopPool } from '@/lib/db/client';
import {
  availabilityRules,
  clients,
  matterStatusEvents,
  matters,
  roles,
  users,
  type Office,
  type PracticeArea,
} from '@/lib/db/schema';
import { ROLE_NAMES } from '@/lib/auth/permissions';
import { generateTemporaryPassword, hashPassword } from '@/lib/auth/password';
import { config } from '@/lib/config/env';

/**
 * Demo / UAT seed.
 *
 *   npm run seed:demo
 *
 * Creates the people and availability the demo script needs, plus a handful of
 * matters so the dashboard is not an empty shell. Idempotent — re-running
 * updates rather than duplicating.
 *
 * Scenario 1 depends on three things existing, and fails quietly without them:
 *
 *   1. an active fee earner in the right office and practice area
 *   2. an availability rule matching that office and practice area — with no
 *      rule, proposeSlot returns null and the enquiry drops into the human
 *      queue instead of producing the proposal the demo turns on
 *   3. a working day ahead with a free slot
 *
 * Refuses to run unless DEMO_SEED_ENABLED=true, so it cannot be triggered
 * accidentally against an environment holding real client matters.
 */

interface DemoPerson {
  email: string;
  fullName: string;
  role: string;
  office: Office;
  practiceAreas: PracticeArea[] | null;
  /** Mon–Fri availability windows for the scheduling engine. */
  availability?: { practiceArea: PracticeArea | null; start: string; end: string };
}

const PEOPLE: DemoPerson[] = [
  {
    email: 'weiling.demo@chambersofkoon.com.my',
    fullName: 'Chan Wei Ling',
    role: ROLE_NAMES.ASSOCIATE,
    office: 'PJ',
    practiceAreas: ['family_matrimonial'],
    // Opens earliest, so the engine proposes her for the demo enquiry.
    availability: { practiceArea: 'family_matrimonial', start: '09:00:00', end: '17:00:00' },
  },
  {
    email: 'yongkoon.demo@chambersofkoon.com.my',
    fullName: 'Tan Yong Koon',
    role: ROLE_NAMES.MANAGING_PARTNER,
    office: 'KL',
    practiceAreas: null,
    availability: { practiceArea: null, start: '10:00:00', end: '16:00:00' },
  },
  {
    email: 'sarah.demo@chambersofkoon.com.my',
    fullName: 'Sarah Menon',
    role: ROLE_NAMES.PARTNER,
    office: 'KL',
    practiceAreas: ['debt_recovery', 'corporate_disputes'],
    availability: { practiceArea: 'debt_recovery', start: '09:30:00', end: '17:30:00' },
  },
  {
    email: 'arif.demo@chambersofkoon.com.my',
    fullName: 'Arif Hakim',
    role: ROLE_NAMES.PUPIL,
    office: 'PJ',
    practiceAreas: null,
  },
  {
    email: 'faridah.demo@chambersofkoon.com.my',
    fullName: 'Faridah Osman',
    role: ROLE_NAMES.PRACTICE_MANAGER,
    office: 'KL',
    practiceAreas: null,
  },
];

interface DemoMatter {
  reference: string;
  title: string;
  practiceArea: PracticeArea;
  office: Office;
  assignee: string;
  client: { fullName: string; email: string; phone: string };
  stages: string[];
}

const MATTERS: DemoMatter[] = [
  {
    reference: 'CK/2026/FM/0177',
    title: 'Joint petition for divorce — Rahim',
    practiceArea: 'family_matrimonial',
    office: 'PJ',
    assignee: 'weiling.demo@chambersofkoon.com.my',
    client: {
      fullName: 'Aishah binti Rahim',
      email: 'aishah.demo@example.com',
      phone: '012-555 0101',
    },
    stages: ['documents_signed', 'filing_submitted'],
  },
  {
    reference: 'CK/2026/DR/0092',
    title: 'Recovery against Deltamas Trading Sdn Bhd',
    practiceArea: 'debt_recovery',
    office: 'KL',
    assignee: 'sarah.demo@chambersofkoon.com.my',
    client: {
      fullName: 'Bina Jaya Sdn Bhd',
      email: 'accounts.demo@example.com',
      phone: '03-7788 1200',
    },
    stages: ['demand_letter_sent'],
  },
  {
    reference: 'CK/2026/LP/0044',
    title: 'SPA — Puchong apartment transfer',
    practiceArea: 'land_property',
    office: 'PJ',
    assignee: 'weiling.demo@chambersofkoon.com.my',
    client: {
      fullName: 'Lim Chee Seng',
      email: 'limcs.demo@example.com',
      phone: '016-555 0177',
    },
    stages: ['documents_signed', 'stamping_completed'],
  },
];

async function upsertPeople(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const credentials: Array<{ email: string; name: string; password: string }> = [];

  for (const person of PEOPLE) {
    const [role] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, person.role))
      .limit(1);
    if (!role) {
      console.error(`  ! role "${person.role}" missing — run npm run db:seed first`);
      continue;
    }

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${person.email}`)
      .limit(1);

    if (existing) {
      await db
        .update(users)
        .set({
          fullName: person.fullName,
          roleId: role.id,
          office: person.office,
          practiceAreas: person.practiceAreas,
          status: 'active',
        })
        .where(eq(users.id, existing.id));
      ids.set(person.email, existing.id);
      continue;
    }

    const password = generateTemporaryPassword();
    const [created] = await db
      .insert(users)
      .values({
        email: person.email,
        fullName: person.fullName,
        roleId: role.id,
        office: person.office,
        practiceAreas: person.practiceAreas,
        status: 'active',
        passwordHash: await hashPassword(password),
        passwordUpdatedAt: new Date(),
        // The presenter changes it and enrols 2FA during the dry run.
        mustChangePassword: true,
      })
      .returning({ id: users.id });

    if (created) {
      ids.set(person.email, created.id);
      credentials.push({ email: person.email, name: person.fullName, password });
    }
  }

  if (credentials.length > 0) {
    console.log('\n  Demo accounts created — temporary passwords, shown once:\n');
    for (const c of credentials) {
      console.log(`    ${c.name.padEnd(18)} ${c.email}`);
      console.log(`    ${' '.repeat(18)} ${c.password}\n`);
    }
    console.log(
      '  Sign each in once before the demo: change the password, then enrol an\n' +
        '  authenticator app. Doing it live wastes five minutes of the meeting.\n',
    );
  }

  return ids;
}

async function seedAvailability(ids: Map<string, string>): Promise<void> {
  let count = 0;
  for (const person of PEOPLE) {
    const userId = ids.get(person.email);
    if (!userId || !person.availability) continue;

    // Replace rather than accumulate on re-run.
    await db.delete(availabilityRules).where(eq(availabilityRules.userId, userId));

    for (const weekday of [1, 2, 3, 4, 5]) {
      await db.insert(availabilityRules).values({
        userId,
        office: person.office,
        practiceArea: person.availability.practiceArea,
        weekday,
        startTime: person.availability.start,
        endTime: person.availability.end,
        slotMinutes: 45,
        bufferMinutes: 15,
        isActive: true,
      });
      count += 1;
    }
  }
  console.log(`  availability rules: ${count}`);
}

async function seedMatters(ids: Map<string, string>): Promise<void> {
  let created = 0;
  for (const matter of MATTERS) {
    const [existing] = await db
      .select({ id: matters.id })
      .from(matters)
      .where(eq(matters.reference, matter.reference))
      .limit(1);
    if (existing) continue;

    const [client] = await db
      .insert(clients)
      .values({
        fullName: matter.client.fullName,
        email: matter.client.email,
        phone: matter.client.phone,
        notes: 'Demo record. Not a real client.',
      })
      .returning({ id: clients.id });
    if (!client) continue;

    const assignedUserId = ids.get(matter.assignee) ?? null;
    const [row] = await db
      .insert(matters)
      .values({
        reference: matter.reference,
        clientId: client.id,
        practiceArea: matter.practiceArea,
        office: matter.office,
        title: matter.title,
        assignedUserId,
        status: 'open',
        openedAt: new Date(Date.now() - 30 * 86_400_000),
      })
      .returning({ id: matters.id });
    if (!row) continue;

    // Backdate the timeline so it reads like a matter in progress.
    for (const [index, stage] of matter.stages.entries()) {
      await db.insert(matterStatusEvents).values({
        matterId: row.id,
        stage,
        recordedByUserId: assignedUserId,
        notes: null,
        // Suppressed: seeding must not email demo addresses.
        suppressed: true,
        occurredAt: new Date(Date.now() - (20 - index * 7) * 86_400_000),
      });
    }
    created += 1;
  }
  console.log(`  demo matters: ${created} created`);
}

async function main(): Promise<void> {
  if (process.env.DEMO_SEED_ENABLED !== 'true') {
    console.error(
      'Refusing to run. Set DEMO_SEED_ENABLED=true to confirm this environment\n' +
        'holds no real client matters.',
    );
    process.exit(1);
  }

  console.log(`Seeding demo data for ${config().FIRM_NAME}…`);
  const ids = await upsertPeople();
  console.log(`  people: ${ids.size}`);
  await seedAvailability(ids);
  await seedMatters(ids);

  console.log('\nScenario 1 is ready: an enquiry routed to PJ / family_matrimonial');
  console.log('will propose the next free slot with Chan Wei Ling.');
  console.log('\nDemo page: /demo\n');

  await stopPool();
}

main().catch(async (error: unknown) => {
  console.error('Demo seed failed:', error);
  await stopPool().catch(() => {});
  process.exit(1);
});
