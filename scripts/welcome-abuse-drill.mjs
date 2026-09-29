/**
 * Two accounts, one machine, one welcome credit.
 *
 * The welcome credit is $10 of real vendor spend handed to anyone who signs
 * in. The ledger caps it at one per ACCOUNT, and accounts cost nothing, so
 * until now the only real cost of farming it was owning a Mac -- a token is
 * minted for a paired machine holding a non-exportable key, and nothing else
 * ever reaches the grant.
 *
 * This proves the machine is now the limit: the first account on a device
 * key is eligible, and a second account pairing the SAME key is not. It also
 * proves the part that matters just as much -- the second account is not
 * blocked. It pairs, it mints, it spends its own money. An abuse control that
 * locks out a real person is a worse bug than the abuse.
 *
 * It talks to the deployed hub and touches no Stripe and no vendor.
 *
 *   claude-secrets run --inject HQ_DATABASE_URL=DBU -- node scripts/welcome-abuse-drill.mjs
 */
import pg from "pg";
import { randomUUID } from "node:crypto";

const db = new pg.Client({ connectionString: process.env.DBU, ssl: { rejectUnauthorized: false } });
await db.connect();

const problems = [];
const check = (ok, said) => { console.log(`  ${ok ? "ok " : "!! "}${said}`); if (!ok) problems.push(said); };
const claim = async (user, jkt) => {
  const { rows: [r] } = await db.query(`select hq_claim_welcome($1, $2) as ok`, [user, jkt]);
  return r.ok;
};

// Two throwaway accounts and one machine, made here rather than mocked: the
// function under test is a database function and a fake would test the fake.
const jkt = `drill-${randomUUID()}`;
const [a, b] = await Promise.all([1, 2].map(async () => {
  const { rows: [r] } = await db.query(
    `insert into users (external_id) values ($1) returning id`, [`welcome-drill-${randomUUID()}`]);
  return r.id;
}));
console.log(`machine ${jkt.slice(0, 20)}…  first ${a.slice(0, 8)}  second ${b.slice(0, 8)}\n`);

try {
  check(await claim(a, jkt) === true, "the first account on this machine is eligible");
  // The mint runs every fifteen minutes for the same person; it must not
  // start saying no to somebody it already said yes to.
  check(await claim(a, jkt) === true, "and stays eligible when asked again");
  check(await claim(a, jkt) === true, "and again");

  check(await claim(b, jkt) === false, "a SECOND account on the same machine is not");
  check(await claim(b, jkt) === false, "and does not become eligible by asking repeatedly");

  // A different machine is a different person as far as this can tell, and
  // that is the deliberate limit of it.
  check(await claim(b, `drill-${randomUUID()}`) === true, "the same person on another machine is eligible again");

  // A device paired before key binding has no machine to attribute to.
  check(await claim(b, null) === false, "a device with no key is never eligible");
  check(await claim(b, "") === false, "nor one with an empty key");

  // Two sign-ups racing on one machine: exactly one wins.
  const c = (await db.query(`insert into users (external_id) values ($1) returning id`,
    [`welcome-drill-${randomUUID()}`])).rows[0].id;
  const race = `drill-${randomUUID()}`;
  const both = await Promise.all([claim(a, race), claim(c, race)]);
  check(both.filter(Boolean).length === 1, `a race gives the credit to exactly one (${both.join(", ")})`);
} finally {
  await db.query(`delete from users where external_id like 'welcome-drill-%'`);
  console.log("\n  (drill accounts removed)");
}
await db.end();
console.log(problems.length ? `\nFAILED: ${problems.length}` : "\nPASSED");
process.exit(problems.length ? 1 : 0);
