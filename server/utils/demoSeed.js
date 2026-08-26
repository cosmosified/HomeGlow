// Demo-mode sample data. Populates the (in-memory) database with a believable
// household — users, chores, schedules, clam history, prizes, and a week of
// calendar events — so a public demo visitor lands on a living dashboard
// instead of an empty first-run screen.
//
// resetDemoData() wipes the domain tables (never the settings/migration
// bookkeeping) and re-seeds; the server calls it at boot and on a recurring
// timer so one visitor's changes don't linger for the next.
//
// Data access goes through Objection/Knex (models are bound to the global Knex
// instance in index.js), so every function here is async and the whole
// wipe-and-seed runs inside one transaction.

const { Model } = require('objection');
const {
  User,
  Chore,
  ChoreSchedule,
  ChoreHistory,
  Prize,
  CalendarSource,
  CalendarEventsCache,
} = require('../db/models');

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDateOnly(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function atHour(date, hours, minutes = 0) {
  const d = new Date(date);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

// Tables holding visitor-modifiable domain data. Order matters for foreign
// keys (children first). settings is intentionally excluded: it stores the
// schema version + migration bookkeeping.
const DOMAIN_TABLES = [
  'chore_history',
  'chore_schedules',
  'chores',
  'prize_offers',
  'prizes',
  'calendar_events_cache',
  'calendar_sync_status',
  'calendar_sources',
  'google_picked_media',
  'homeglow_photos',
  'photo_sources',
  'google_oauth_states',
  'google_accounts',
  'tabs',
  'devices',
  'admin_pin',
];

async function wipeDomainTables(trx) {
  for (const table of DOMAIN_TABLES) {
    try {
      if (table === 'users') continue; // handled separately (bonus user id 0 stays)
      await trx(table).del();
    } catch (err) {
      // Table may not exist on older schemas; demo DB is always current, but stay tolerant.
      console.warn(`Demo reset: skipping table ${table}: ${err.message}`);
    }
  }
  // Keep the system "bonus" user (id 0) created by migrations.
  await User.query(trx).delete().whereNot('id', 0);
}

async function seedUsersAndChores(trx) {
  // Demo users wear default avatars (issue #132) so the bank is showcased.
  const insertUser = async (username, email, profile_picture) =>
    (await User.query(trx).insert({ username, email, profile_picture })).id;
  const emmaId = await insertUser('Emma', 'emma@demo.homeglow', 'defaults/girl-2.svg');
  const liamId = await insertUser('Liam', 'liam@demo.homeglow', 'defaults/boy-4.svg');
  const noahId = await insertUser('Noah', 'noah@demo.homeglow', 'defaults/dino.svg');

  // A believable household mixes two kinds of chores, and the demo shows both:
  //  - Reward chores worth "clams" (clam_value > 0) that build toward prizes.
  //  - Everyday routines with NO clam value (clam_value 0) — brush teeth, make
  //    your bed — tracked as responsibilities without paying out. This is the
  //    key thing the sample set demonstrates: clams are optional per chore.
  const insertChore = async (title, description, clam_value) =>
    (await Chore.query(trx).insert({ title, description, clam_value })).id;
  // Reward chores (earn clams)
  const dishes = await insertChore('Dishes', 'Load and run the dishwasher after dinner', 5);
  const vacuum = await insertChore('Vacuum living room', 'Including under the couch cushions', 10);
  const trash = await insertChore('Take out trash', 'Bins to the curb on pickup nights', 3);
  const laundry = await insertChore('Fold laundry', 'Fold and put away your basket', 5);
  const dog = await insertChore('Walk the dog', 'Around the block, morning and evening', 4);
  const plants = await insertChore('Water the plants', 'Kitchen and porch pots', 2);
  const car = await insertChore('Wash the car', 'Weekend bonus — first one to grab it!', 15);
  // Routine chores (no clam value — responsibilities, not rewards)
  const bed = await insertChore('Make your bed', 'Every morning before school', 0);
  const teeth = await insertChore('Brush teeth', 'Morning and night', 0);
  const tidyRoom = await insertChore('Tidy your room', 'Clothes in the hamper, toys away', 0);
  const homework = await insertChore('Homework', 'Finish before screen time', 0);

  const insertSchedule = (chore_id, user_id, crontab, duration) =>
    ChoreSchedule.query(trx).insert({ chore_id, user_id, crontab, visible: 1, duration });
  const EVERY_DAY = '0 0 * * *';
  const WEEKDAYS = '0 0 * * 1-5';
  const WEEKENDS = '0 0 * * 0,6';
  // Emma
  await insertSchedule(dishes, emmaId, EVERY_DAY, 'day-of');
  await insertSchedule(laundry, emmaId, '0 0 * * 1,4', 'until-completed');
  await insertSchedule(bed, emmaId, EVERY_DAY, 'day-of');
  await insertSchedule(teeth, emmaId, EVERY_DAY, 'day-of');
  // Liam
  await insertSchedule(vacuum, liamId, WEEKDAYS, 'day-of');
  await insertSchedule(trash, liamId, EVERY_DAY, 'day-of');
  await insertSchedule(dog, liamId, EVERY_DAY, 'day-of');
  await insertSchedule(homework, liamId, WEEKDAYS, 'until-completed');
  // Noah (younger — mostly routines, one small reward)
  await insertSchedule(bed, noahId, EVERY_DAY, 'day-of');
  await insertSchedule(teeth, noahId, EVERY_DAY, 'day-of');
  await insertSchedule(tidyRoom, noahId, EVERY_DAY, 'day-of');
  await insertSchedule(plants, noahId, '0 0 * * 2,5', 'day-of');
  // Unassigned bonus chores anyone can grab
  await insertSchedule(vacuum, null, WEEKENDS, 'day-of');
  await insertSchedule(car, null, WEEKENDS, 'day-of');

  // A few days of completions so clam totals look lived-in. Only the reward
  // chores post clams; routines are completed too but pay out nothing.
  const insertHistory = (user_id, date, clam_value, title, kind) =>
    ChoreHistory.query(trx).insert({
      user_id,
      chore_schedule_id: null,
      date,
      clam_value,
      title,
      kind,
    });
  const today = new Date();
  for (let daysAgo = 1; daysAgo <= 4; daysAgo++) {
    const date = formatDateOnly(new Date(today.getTime() - daysAgo * DAY_MS));
    await insertHistory(emmaId, date, 5, 'Dishes', 'completion');
    await insertHistory(emmaId, date, 0, 'Make your bed', 'completion');
    if (daysAgo % 2 === 0) await insertHistory(liamId, date, 10, 'Vacuum living room', 'completion');
    await insertHistory(liamId, date, 4, 'Walk the dog', 'completion');
    await insertHistory(noahId, date, 0, 'Brush teeth', 'completion');
  }

  // Metrics showcase rows (issue #72): a streak for Emma (consecutive
  // daily-bonus days), a prize redemption (negative 'spent' row), and a couple
  // of missed chores for Liam — so the Chore Metrics plugin demos every tile
  // out of the box. Emma's total stays positive (20 earned - 10 spent + 6 bonus).
  for (let daysAgo = 1; daysAgo <= 3; daysAgo++) {
    const date = formatDateOnly(new Date(today.getTime() - daysAgo * DAY_MS));
    await insertHistory(emmaId, date, 2, 'Regular chores', 'daily_bonus');
  }
  await insertHistory(emmaId, formatDateOnly(new Date(today.getTime() - 2 * DAY_MS)), -10, 'Spent', 'spent');
  await insertHistory(liamId, formatDateOnly(new Date(today.getTime() - 1 * DAY_MS)), 0, 'Take out trash', 'missed');
  await insertHistory(liamId, formatDateOnly(new Date(today.getTime() - 3 * DAY_MS)), 0, 'Vacuum living room', 'missed');

  const insertPrize = async (name, clam_cost) =>
    (await Prize.query(trx).insert({ name, clam_cost })).id;
  await insertPrize('Movie night pick', 50);
  const iceCream = await insertPrize('Ice cream trip', 30);
  const screenTime = await insertPrize('30 min extra screen time', 15);

  // Prize store showcase: one offer on the shelf, one pending parent approval.
  const insertOffer = (prize_id, status, requested_by, requested_at) =>
    trx('prize_offers').insert({ prize_id, status, requested_by, requested_at });
  await insertOffer(iceCream, 'available', null, null);
  await insertOffer(screenTime, 'requested', liamId, new Date().toISOString());
}

// Real public ICS feeds synced live in demo mode (calendar sync runs for these;
// visitors can't add/edit sources — those routes are demo-blocked, so only this
// curated list is ever fetched). Several overlap on purpose: the two Town of
// Chili feeds share events, which shows off cross-calendar deduplication.
const DEMO_CALENDAR_FEEDS = [
  { name: 'US Federal Holidays', url: 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/holidays.ics', color: '#2a9d8f' },
  { name: 'Arizona Diamondbacks', url: 'https://ics.calendarlabs.com/99/df8470ee/Arizona_Diamondbacks_-_MLB.ics', color: '#a4133c' },
  { name: 'Town of Chili — Calendar', url: 'https://www.chiliny.gov/common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar', color: '#457b9d' },
  { name: 'Town of Chili — Community Events', url: 'https://www.chiliny.gov/common/modules/iCalendar/iCalendar.aspx?catID=30&feed=calendar', color: '#8338ec' },
];

async function seedCalendar(trx) {
  // The Family Calendar's .invalid URL is a placeholder that is never fetched
  // (the sync service skips reserved-TLD hosts); its events are the baked
  // cache entries below, so the demo has content the instant it boots.
  const familyCalendar = await CalendarSource.query(trx).insert({
    name: 'Family Calendar',
    type: 'ICS',
    url: 'https://demo.invalid/family.ics',
    color: '#6e44ff',
    enabled: 1,
    sort_order: 0,
  });
  const sourceId = familyCalendar.id;

  const insertSource = (name, type, url, color, sort_order) =>
    CalendarSource.query(trx).insert({ name, type, url, color, enabled: 1, sort_order });
  for (const [index, feed] of DEMO_CALENDAR_FEEDS.entries()) {
    await insertSource(feed.name, 'ICS', feed.url, feed.color, index + 1);
  }

  const insertEvent = (source_id, event_uid, title, start_time, end_time, description, location, all_day) =>
    CalendarEventsCache.query(trx).insert({
      source_id,
      event_uid,
      title,
      start_time,
      end_time,
      description,
      location,
      all_day,
    });

  const now = new Date();
  const day = (offset) => new Date(now.getTime() + offset * DAY_MS);
  const events = [
    ['demo-soccer', 'Soccer practice', atHour(day(0), 17), atHour(day(0), 18, 30), 'Bring water bottle', 'City fields', 0],
    ['demo-pizza', 'Pizza night', atHour(day(1), 18), atHour(day(1), 19, 30), '', 'Home', 0],
    ['demo-dentist', 'Dentist — Liam', atHour(day(2), 9, 30), atHour(day(2), 10, 15), '', 'Main St Dental', 0],
    ['demo-grandma', 'Visit Grandma', atHour(day(3), 12), atHour(day(4), 15), 'Overnight trip', '', 1],
    ['demo-recital', 'Piano recital', atHour(day(5), 15), atHour(day(5), 16), '', 'Community hall', 0],
    ['demo-library', 'Library books due', atHour(day(6), 9), atHour(day(6), 9, 30), '', '', 1],
  ];
  for (const [uid, title, start, end, description, location, allDay] of events) {
    await insertEvent(sourceId, uid, title, start.toISOString(), end.toISOString(), description, location, allDay);
  }
}

async function resetDemoData() {
  await Model.transaction(async (trx) => {
    await wipeDomainTables(trx);
    await seedUsersAndChores(trx);
    await seedCalendar(trx);
  });
  console.log('Demo data seeded');
}

module.exports = { resetDemoData };
