// File: server/index.js
require('dotenv').config();

const APP_TIMEZONE = process.env.TZ || 'America/New_York';

// Demo mode: a single opt-in flag for running a public, throwaway demo
// instance. It uses an in-memory database (wiped on container stop), disables
// the admin PIN, seeds sample data (re-seeded every DEMO_RESET_HOURS), and
// blocks routes that a public visitor could abuse (uploads, outbound fetch
// proxies, OAuth credential storage). Never enabled unless DEMO_MODE=true.
const DEMO_MODE = process.env.DEMO_MODE === 'true';
const DEMO_RESET_HOURS = 6;

// Guard for routes disabled in demo mode. Sends a 403 and returns true when
// the request should stop (send-reply-then-return convention).
const demoBlocked = (reply) => {
  if (!DEMO_MODE) return false;
  reply.status(403).send({ error: 'This feature is disabled in demo mode.' });
  return true;
};
process.env.TZ = APP_TIMEZONE;

const fastify = require('fastify')({ logger: true });
const Database = require('better-sqlite3');
const { Model } = require('objection');
const { createKnex } = require('./db/knex');
const { adoptOrMigrate } = require('./db/migrate');
const { Setting, AdminPin, Prize, PrizeOffer, User, Chore, ChoreSchedule, ChoreHistory, Event, CalendarSource, CalendarEventsCache, CalendarSyncStatus, PhotoSource, GooglePickedMedia, HomeglowPhoto, Device, Tab, Plugin, PluginStorage } = require('./db/models');
const ical = require('ical-generator');
const node_ical = require('node-ical');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const serverPackageJson = require('./package.json');
const multipart = require('@fastify/multipart');
const crypto = require('crypto');

// NEW: Import axios for HTTP requests and ical.js for parsing
const axios = require('axios');
const ICAL = require('ical.js');
const { CronExpressionParser } = require('cron-parser');
const cron = require('node-cron');
// For widget upload and registry
const widgetRegistryPath = path.join(__dirname, 'widgets_registry.json');

// Chore notification sounds: bundled defaults (in the image) seeded into the
// persisted uploads volume, plus user uploads. Served via the /Uploads/ static root.
const DEFAULT_SOUNDS_DIR = path.join(__dirname, 'assets', 'sounds');
const SOUNDS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'sounds');
const ALLOWED_SOUND_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac']);

function getDefaultSoundFilenames() {
  try {
    return new Set(fsSync.readdirSync(DEFAULT_SOUNDS_DIR));
  } catch {
    return new Set();
  }
}

async function seedDefaultSounds() {
  await fs.mkdir(SOUNDS_UPLOAD_DIR, { recursive: true });
  let defaults = [];
  try {
    defaults = await fs.readdir(DEFAULT_SOUNDS_DIR);
  } catch {
    return; // No bundled defaults present; nothing to seed.
  }

  for (const filename of defaults) {
    const target = path.join(SOUNDS_UPLOAD_DIR, filename);
    try {
      await fs.access(target);
    } catch {
      await fs.copyFile(path.join(DEFAULT_SOUNDS_DIR, filename), target);
      console.log(`Seeded default sound: ${filename}`);
    }
  }
}

// Default profile avatars (issue #132): bundled flat SVG art seeded into the
// persisted uploads volume under users/defaults/, so a selected default is
// served by the exact same /Uploads/users/<profile_picture> path the client
// already uses for uploaded pictures.
const DEFAULT_AVATARS_DIR = path.join(__dirname, 'assets', 'avatars');
const AVATARS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'users', 'defaults');

async function seedDefaultAvatars() {
  await fs.mkdir(AVATARS_UPLOAD_DIR, { recursive: true });
  let defaults = [];
  try {
    defaults = await fs.readdir(DEFAULT_AVATARS_DIR);
  } catch {
    return; // No bundled defaults present; nothing to seed.
  }

  for (const filename of defaults) {
    const target = path.join(AVATARS_UPLOAD_DIR, filename);
    try {
      await fs.access(target);
    } catch {
      await fs.copyFile(path.join(DEFAULT_AVATARS_DIR, filename), target);
    }
  }
}

// Calendar sync service
const CalendarSyncService = require('./services/calendarSync');
const googleConnection = require('./services/googleConnection');
const googleCalendar = require('./services/googleCalendar');
const appleCalDAV = require('./services/appleCalDAV');
const googlePhotos = require('./services/googlePhotos');
const googlePhotosPicker = require('./services/googlePhotosPicker');
const homeAssistant = require('./services/homeAssistant');
const weatherService = require('./services/weather');
const { computeSunTimes } = require('./services/weather/sun');
const {
  isEncryptionConfigured,
  getEncryptionStatus,
  encrypt,
  decrypt,
  isLegacyCiphertext,
  decryptLegacy,
} = require('./utils/encryption');
const { httpsAgentFor, isCertificateVerificationSkipped } = require('./utils/outboundTls');

// Certificate policy for every outbound axios request, decided per URL from the
// target's address class (issue #139). Registered on the default axios instance,
// which is shared by every module that requires axios — the calendar sync
// service and the Apple CalDAV client included — so no call site has to remember
// this, and a new one cannot forget it.
//
// Public hosts are always verified. Private ones (RFC1918, loopback, .local and
// friends) accept a self-signed certificate, because that is the normal case for
// a NAS or a photo server on the household's own network and there is no public
// CA that would ever issue for 192.168.1.50.
axios.interceptors.request.use((config) => {
  try {
    const resolved = config.baseURL && !/^https?:\/\//i.test(config.url || '')
      ? new URL(config.url || '', config.baseURL)
      : new URL(config.url);
    const agent = httpsAgentFor(resolved);
    if (agent) config.httpsAgent = agent;
  } catch (_) {
    // Not a URL we can classify; axios will fail on it anyway, and leaving the
    // config untouched means Node's default (verify) applies.
  }
  return config;
});
let calendarSyncService = null;

const pluginEvents = require('./services/pluginEvents');
const initializeDatabase = require('./migrations/initializeDatabase');
const migrateChoresDatabase = require('./migrations/migrateChoresDatabase');
const migrateClamsToHistory = require('./migrations/migrateClamsToHistory');
const migrateChoreHistoryTitle = require('./migrations/migrateChoreHistoryTitle');
const migrateToDurationField = require('./migrations/migrateToDurationField');

const SYSTEM_SCHEMA_ID_KEY = 'SYSTEM_SCHEMA_ID';
// Schema level encoded by the Knex baseline migration. Existing DBs below this are
// lifted to it by the legacy chain before Knex takes over (Option A).
const BASELINE_SCHEMA_VERSION = 14;

const schemaMigrations = [
  { schemaId: 6, migrationPath: './migrations/migrateDeviceSchemaV6', },
  { schemaId: 7, migrationPath: './migrations/schema7-proveMigrations', },
  { schemaId: 8, migrationPath: './migrations/schema8-calendarCacheTables', },
  { schemaId: 9, migrationPath: './migrations/schema9-googleConnection', },
  { schemaId: 10, migrationPath: './migrations/schema10-googlePhotosPicker', },
  { schemaId: 11, migrationPath: './migrations/schema11-homeglowPhotos', },
  { schemaId: 12, migrationPath: './migrations/schema12-onceCompletedScheduling', },
  { schemaId: 13, migrationPath: './migrations/schema13-tabsByDefaultBackfill', },
  { schemaId: 14, migrationPath: './migrations/schema14-deviceAndTabJsonStorage', },
  { schemaId: 15, migrationPath: './migrations/schema15-choreDueTimeSound', },
  { schemaId: 16, migrationPath: './migrations/schema16-choreDueDate', },
  { schemaId: 17, migrationPath: './migrations/schema17-choreTransferSnooze', },
  { schemaId: 18, migrationPath: './migrations/schema18-pluginsTable', },
  { schemaId: 19, migrationPath: './migrations/schema19-pluginStorage', },
  { schemaId: 20, migrationPath: './migrations/schema20-choreHistoryKind', },
  { schemaId: 21, migrationPath: './migrations/schema21-prizeOffers', },
  { schemaId: 22, migrationPath: './migrations/schema22-prizeRepeatSplit', },
  { schemaId: 23, migrationPath: './migrations/schema23-userSortOrder', },
  { schemaId: 24, migrationPath: './migrations/schema24-choreIcon', },
  { schemaId: 25, migrationPath: './migrations/schema25-unifyCredentialEncryption', },
];

const ALLOWED_SCHEDULE_DURATIONS = new Set(['day-of', 'until-completed', 'once-completed']);
const SCHEDULE_INTERVAL_REGEX = /^([1-9]\d*)([dwmy])$/;

// Fisher-Yates in-place shuffle. Mutates and returns the array.
const shuffleInPlace = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

// GitHub API configuration
const GITHUB_REPO_OWNER = 'jherforth';
const GITHUB_REPO_NAME = 'HomeGlowPlugins';
const GITHUB_API_BASE = 'https://api.github.com';

const DEFAULT_HOMEGLOW_REPOSITORY = 'jherforth/HomeGlow';
const BACKEND_VERSION = (process.env.BACKEND_VERSION || process.env.APP_VERSION || serverPackageJson.version || 'dev').trim();
const BACKEND_GIT_COMMIT = (process.env.BACKEND_GIT_COMMIT || process.env.GIT_COMMIT || process.env.GITHUB_SHA || '').trim() || null;
const BACKEND_GITHUB_REPOSITORY = (process.env.BACKEND_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || DEFAULT_HOMEGLOW_REPOSITORY).trim();

function isValidRepositorySlug(repository) {
  return typeof repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(repository);
}

function buildGitHubCommitUrl(repository, commitSha) {
  if (!commitSha || !isValidRepositorySlug(repository)) {
    return null;
  }
  return `https://github.com/${repository}/commit/${commitSha}`;
}

function getTodayLocalDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeScheduleDuration(duration) {
  if (duration === undefined || duration === null || duration === '') {
    return 'day-of';
  }
  return String(duration);
}

function normalizeScheduleInterval(intervalValue) {
  if (intervalValue === undefined || intervalValue === null) {
    return null;
  }
  const normalized = String(intervalValue).trim().toLowerCase();
  return normalized || null;
}

function isValidScheduleInterval(intervalValue) {
  return typeof intervalValue === 'string' && SCHEDULE_INTERVAL_REGEX.test(intervalValue);
}

const DUE_TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

// Returns { valid, value } where value is a normalized 'HH:MM' string or null.
function normalizeDueTime(dueTime) {
  if (dueTime === undefined || dueTime === null || dueTime === '') {
    return { valid: true, value: null };
  }
  const normalized = String(dueTime).trim();
  if (!DUE_TIME_REGEX.test(normalized)) {
    return { valid: false, value: null };
  }
  return { valid: true, value: normalized };
}

// Returns { valid, value } where value is a positive integer of minutes or null.
function normalizeReminderInterval(minutes) {
  if (minutes === undefined || minutes === null || minutes === '' || Number(minutes) === 0) {
    return { valid: true, value: null };
  }
  const parsed = Number.parseInt(minutes, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { valid: false, value: null };
  }
  return { valid: true, value: parsed > 0 ? parsed : null };
}

function parseDateOnlyToLocalDate(dateString) {
  if (typeof dateString !== 'string') {
    return null;
  }

  const parts = dateString.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return null;
  }

  const [year, month, day] = parts;
  if (!year || !month || !day) {
    return null;
  }

  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

const DUE_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function formatDateOnlyLocal(dateObj) {
  return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
}

function extractDateOnlyString(value) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (DUE_DATE_REGEX.test(normalized)) {
      return normalized;
    }
    const match = normalized.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) {
      return match[1];
    }
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateOnlyLocal(value);
  }

  return null;
}

function calculateDateOffsetDays(startDateValue, endDateValue) {
  const startDateOnly = extractDateOnlyString(startDateValue);
  const endDateOnly = extractDateOnlyString(endDateValue);
  if (!startDateOnly || !endDateOnly) {
    return null;
  }

  const startDate = parseDateOnlyToLocalDate(startDateOnly);
  const endDate = parseDateOnlyToLocalDate(endDateOnly);
  if (!startDate || !endDate) {
    return null;
  }

  return Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
}

function addDaysToDateOnly(baseDateValue, dayOffset) {
  if (!Number.isInteger(dayOffset)) {
    return null;
  }

  const baseDateOnly = extractDateOnlyString(baseDateValue);
  if (!baseDateOnly) {
    return null;
  }

  const baseDate = parseDateOnlyToLocalDate(baseDateOnly);
  if (!baseDate) {
    return null;
  }

  const resultDate = new Date(baseDate);
  resultDate.setDate(resultDate.getDate() + dayOffset);
  return formatDateOnlyLocal(resultDate);
}

// Returns { valid, value } where value is a normalized 'YYYY-MM-DD' string or null.
// Rejects malformed strings and impossible calendar dates (e.g. 2026-02-30).
function normalizeDueDate(dueDate) {
  if (dueDate === undefined || dueDate === null || dueDate === '') {
    return { valid: true, value: null };
  }
  const normalized = String(dueDate).trim();
  if (!DUE_DATE_REGEX.test(normalized)) {
    return { valid: false, value: null };
  }
  const parsed = parseDateOnlyToLocalDate(normalized);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return { valid: false, value: null };
  }
  // Guard against roll-over (e.g. '2026-02-30' -> Mar 2): re-serialize and compare.
  const roundTrip = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  if (roundTrip !== normalized) {
    return { valid: false, value: null };
  }
  return { valid: true, value: normalized };
}

// Snoozed-until is stored as an ISO UTC datetime so server and client compare
// it against "now" without timezone drift. Empty/null clears the snooze.
function normalizeSnoozedUntil(snoozedUntil) {
  if (snoozedUntil === undefined || snoozedUntil === null || snoozedUntil === '') {
    return { valid: true, value: null };
  }
  const parsed = new Date(snoozedUntil);
  if (Number.isNaN(parsed.getTime())) {
    return { valid: false, value: null };
  }
  return { valid: true, value: parsed.toISOString() };
}

// Validates the shared schedule due_time / due_date / reminder fields. On the
// first failure it sends a 400 and returns null; otherwise it returns the three
// normalized results. Used by the create + bulk-create schedule handlers. The
// PATCH handler keeps its own guards because it only validates provided fields.
const validateScheduleDateFields = ({ due_time, due_date, reminder_interval_minutes }, reply) => {
  const dueTimeResult = normalizeDueTime(due_time);
  if (!dueTimeResult.valid) {
    reply.status(400).send({ error: 'due_time must be in HH:MM 24-hour format' });
    return null;
  }
  const dueDateResult = normalizeDueDate(due_date);
  if (!dueDateResult.valid) {
    reply.status(400).send({ error: 'due_date must be a valid YYYY-MM-DD date' });
    return null;
  }
  const reminderResult = normalizeReminderInterval(reminder_interval_minutes);
  if (!reminderResult.valid) {
    reply.status(400).send({ error: 'reminder_interval_minutes must be a non-negative integer' });
    return null;
  }
  return { dueTimeResult, dueDateResult, reminderResult };
};

function addMonthsCalendarAware(baseDate, monthCount) {
  const result = new Date(baseDate);
  const originalDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + monthCount);
  const lastDayOfTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, lastDayOfTargetMonth));
  return result;
}

function addYearsCalendarAware(baseDate, yearCount) {
  return addMonthsCalendarAware(baseDate, yearCount * 12);
}

function addIntervalToDate(baseDate, intervalValue) {
  const normalizedInterval = normalizeScheduleInterval(intervalValue);
  if (!normalizedInterval || !isValidScheduleInterval(normalizedInterval)) {
    return null;
  }

  const [, countRaw, unit] = normalizedInterval.match(SCHEDULE_INTERVAL_REGEX);
  const count = parseInt(countRaw, 10);
  if (count <= 0) {
    return null;
  }

  switch (unit) {
    case 'd': {
      const result = new Date(baseDate);
      result.setDate(result.getDate() + count);
      return result;
    }
    case 'w': {
      const result = new Date(baseDate);
      result.setDate(result.getDate() + (count * 7));
      return result;
    }
    case 'm':
      return addMonthsCalendarAware(baseDate, count);
    case 'y':
      return addYearsCalendarAware(baseDate, count);
    default:
      return null;
  }
}

function buildDateCrontab(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) {
    return null;
  }
  const dayOfMonth = dateObj.getDate();
  const month = dateObj.getMonth() + 1;
  return `0 0 ${dayOfMonth} ${month} *`;
}

// Credential encryption for calendar and photo sources.
//
// These used to have their own AES-256-CBC scheme keyed on
// `ENCRYPTION_KEY || <a string hardcoded in this repository>`, which meant that
// on any install that did not set the variable — including every install using
// the stock docker-compose, which never forwarded it — Apple app passwords,
// Immich API keys and photo refresh tokens were encrypted with a published key.
//
// They now use the same auto-keyed AES-256-GCM store as the Google and Home
// Assistant credentials (utils/encryption.js), which generates and persists its
// own key and needs no configuration. Values written before that change are
// still read through the legacy path; migration 25 re-encrypts them in place.
function encryptPassword(password) {
  if (!password) return null;
  return encrypt(password);
}

function decryptPassword(encryptedPassword) {
  if (!encryptedPassword) return null;
  try {
    return isLegacyCiphertext(encryptedPassword)
      ? decryptLegacy(encryptedPassword)
      : decrypt(encryptedPassword);
  } catch (error) {
    console.error('Error decrypting password:', error);
    return null;
  }
}

// Initialize Fastify with CORS
fastify.register(require('@fastify/cors'), {
  origin: '*', // Allow all origins for development. Consider restricting in production.
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], // Explicitly allow PATCH
  allowedHeaders: ['Content-Type', 'Authorization'], // Add any other headers your client might send
});

fastify.register(multipart, {
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB per file
    files: 50,
  },
});

// Add a preHandler hook to log all incoming requests
fastify.addHook('preHandler', (request, reply, done) => {
  console.log(`Incoming request: ${request.method} ${request.url}`);
  done();
});

// Serve static files for uploads.
//
// maxAge alone emits `Cache-Control: public, max-age=86400`, so there is no
// setHeaders callback here on purpose: the one that used to live here only
// re-set that identical header. Keeping it bought nothing and cost an outage
// in #136, where v10 changed the callback's first argument from the Node
// response to a Fastify Reply and `res.setHeader` became an uncaught
// TypeError that killed the process on the first file request. Headers are
// deliberately kept minimal to avoid "Request Header Fields Too Large".
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'uploads'),
  prefix: '/Uploads/',
  decorateReply: false,
  maxAge: 86400000, // 1 day cache
});

// Additional static route specifically for user uploads
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'uploads', 'users'),
  prefix: '/Uploads/users/',
  decorateReply: false,
  maxAge: 86400000, // 1 day cache
});

// Serve static files for widgets
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'widgets'),
  prefix: '/widgets/',
  decorateReply: false
});

// Widget filenames are restricted to this charset at upload/install time; the
// serve route enforces the same rule so encoded ../ segments can never reach
// the disk-fallback path.join below (path traversal guard).
const WIDGET_FILENAME_REGEX = /^[a-zA-Z0-9-._]+$/;

// Serve widget HTML from the DB-backed plugin store (issue #105 Phase 0), with
// a read-only disk fallback for files that predate the plugins table.
fastify.get('/widgets/:filename', async (request, reply) => {
  const { filename } = request.params;

  if (!WIDGET_FILENAME_REGEX.test(filename) || filename.includes('..')) {
    return reply.status(404).send(`Widget file not found: ${filename}`);
  }

  try {
    let content;
    let pluginId = null;
    const row = await Plugin.query().select('content', 'plugin_id').where('filename', filename).first();
    if (row) {
      content = row.content;
      pluginId = row.plugin_id;
    } else {
      const filePath = path.join(__dirname, 'widgets', filename);
      content = await fs.readFile(filePath, 'utf-8');
    }

    content = content.replace(/window\.location\.origin\.replace\(['"`]:\d+['"`],\s*['"`]:\d+['"`]\)/g, 'window.location.origin');
    content = content.replace(/\$\{window\.location\.protocol\}\/\/\$\{window\.location\.hostname\}:\d+/g, '${window.location.origin}');
    content = content.replace(/window\.location\.protocol\s*\+\s*'\/\/'\s*\+\s*window\.location\.hostname\s*\+\s*':\d+'/g, 'window.location.origin');

    let injection = `<style>html,body{max-width:100%!important;overflow-x:hidden!important;box-sizing:border-box;}*{box-sizing:border-box;}</style>`;
    // Manifest plugins get their identity injected so /plugin-sdk/v1.js knows
    // which storage/settings namespace to talk to. plugin_id is validated to
    // [a-z0-9-] at install time, so it is safe to embed verbatim.
    if (pluginId) {
      injection += `<script>window.__HOMEGLOW_PLUGIN__={id:"${pluginId}",apiVersion:"v1"};</script>`;
    }
    // Inject at the START of <head> so the identity script runs before any
    // plugin script — including an SDK <script src> placed early in head.
    const headOpen = content.match(/<head\b[^>]*>/i);
    if (headOpen) {
      content = content.replace(headOpen[0], `${headOpen[0]}${injection}`);
    } else if (content.includes('<body')) {
      content = content.replace('<body', `${injection}<body`);
    } else {
      content = injection + content;
    }

    reply.header('Content-Type', 'text/html; charset=utf-8');
    return content;
  } catch (error) {
    console.error(`Error serving widget ${filename}:`, error);
    reply.status(404).send(`Widget file not found: ${filename}`);
  }
});

// Serve the plugin SDK (issue #105). Cached after first read; versioned by
// path so a future v2 can coexist with v1.
let pluginSdkV1Cache = null;
fastify.get('/plugin-sdk/v1.js', async (request, reply) => {
  try {
    if (!pluginSdkV1Cache) {
      pluginSdkV1Cache = await fs.readFile(path.join(__dirname, 'plugin-sdk', 'v1.js'), 'utf-8');
    }
    reply.header('Content-Type', 'application/javascript');
    reply.header('Cache-Control', 'public, max-age=3600');
    return pluginSdkV1Cache;
  } catch (error) {
    console.error('Error serving plugin SDK:', error);
    reply.status(500).send('// plugin SDK unavailable');
  }
});

// Add a simple test endpoint
fastify.get('/api/test', async (request, reply) => {
  return {
    message: 'Server is working!',
    timestamp: new Date().toISOString(),
    widgetsDir: path.join(__dirname, 'widgets')
  };
});

fastify.get('/api/stats', async (request, reply) => {
  const repository = isValidRepositorySlug(BACKEND_GITHUB_REPOSITORY)
    ? BACKEND_GITHUB_REPOSITORY
    : DEFAULT_HOMEGLOW_REPOSITORY;

  return {
    backend: {
      version: BACKEND_VERSION,
      commit: BACKEND_GIT_COMMIT,
      repository,
      commitUrl: buildGitHubCommitUrl(repository, BACKEND_GIT_COMMIT),
    },
  };
});

// Serve the main CSS file for widgets
fastify.get('/index.css', async (request, reply) => {
  try {
    // Try multiple possible paths
    const possiblePaths = [
      path.join(__dirname, '..', 'client', 'src', 'index.css'),
      path.join(__dirname, 'client', 'src', 'index.css'),
      '/app/client/src/index.css',
      path.join(process.cwd(), 'client', 'src', 'index.css')
    ];

    console.log('Looking for CSS file in paths:', possiblePaths);
    console.log('Current working directory:', process.cwd());
    console.log('__dirname:', __dirname);

    let cssContent = null;
    let successPath = null;

    for (const cssPath of possiblePaths) {
      try {
        cssContent = await fs.readFile(cssPath, 'utf-8');
        successPath = cssPath;
        console.log('Successfully found CSS at:', cssPath);
        break;
      } catch (pathError) {
        console.log('Failed to read CSS from:', cssPath, pathError.message);
      }
    }

    if (cssContent) {
      reply.header('Content-Type', 'text/css');
      reply.header('Access-Control-Allow-Origin', '*');
      return cssContent;
    }

    throw new Error('CSS file not found in any expected location');
  } catch (error) {
    console.error('Error serving index.css:', error);

    // Fallback: serve minimal CSS for widgets
    const fallbackCSS = `
      :root {
        --background: #f4f4f9;
        --card-bg: rgba(255, 255, 255, 0.8);
        --card-border: rgba(255, 255, 255, 0.2);
        --text-color: #1a1a2e;
        --text-color-rgb: 26, 26, 46;
        --accent: #6e44ff;
        --accent-rgb: 110, 68, 255;
        --shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        --backdrop-blur: blur(10px);
        --dynamic-text-size: 16px;
        --dynamic-card-width: 300px;
        --dynamic-card-padding: 20px;
        --error-color: #ff4444;
        --light-gradient-start: #00ddeb;
        --light-gradient-end: #ff6b6b;
        --dark-gradient-start: #2e2767;
        --dark-gradient-end: #620808;
        --light-button-gradient-start: #00ddeb;
        --light-button-gradient-end: #ff6b6b;
        --dark-button-gradient-start: #2e2767;
        --dark-button-gradient-end: #620808;
        --gradient: linear-gradient(45deg, var(--light-gradient-start), var(--light-gradient-end));
      }

      [data-theme="dark"] {
        --background: #0a0a1a;
        --card-bg: rgba(30, 30, 50, 0.7);
        --card-border: rgba(100, 100, 150, 0.3);
        --text-color: #a6a6d1;
        --text-color-rgb: 166, 166, 209;
        --accent: #00ddeb;
        --accent-rgb: 0, 221, 235;
        --shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        --gradient: linear-gradient(45deg, var(--dark-gradient-start), var(--dark-gradient-end));
      }

      html, body {
        margin: 0;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--background);
        color: var(--text-color);
        transition: background 0.3s ease, color 0.3s ease;
        touch-action: manipulation;
        width: 100%;
        height: 100%;
        overflow-x: hidden;
        overflow-y: auto;
        font-size: var(--dynamic-text-size);
      }

      .card {
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: 12px;
        padding: var(--dynamic-card-padding);
        backdrop-filter: var(--backdrop-blur);
        box-shadow: var(--shadow);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
        width: 100%;
        max-width: var(--dynamic-card-width);
        touch-action: manipulation;
      }

      .card:hover {
        transform: translateY(-5px);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
      }

      h1, h2, h3, h4, h5, h6 {
        font-weight: 700;
        letter-spacing: 0.5px;
        color: var(--text-color);
      }

      button {
        background: linear-gradient(45deg, var(--light-button-gradient-start), var(--light-button-gradient-end));
        color: var(--text-color);
        border: none;
        border-radius: 8px;
        padding: 10px 20px;
        cursor: pointer;
        font-size: 1rem;
        font-weight: 600;
        transition: background 0.3s ease;
        touch-action: manipulation;
      }

      [data-theme="dark"] button {
        background: linear-gradient(45deg, var(--dark-button-gradient-start), var(--dark-button-gradient-end));
      }

      button:hover {
        filter: brightness(1.1);
      }
    `;

    console.log('Serving fallback CSS');
    reply.header('Content-Type', 'text/css');
    reply.header('Access-Control-Allow-Origin', '*');
    return fallbackCSS;
  }
});

// --- Widget Upload Endpoints and Plugin Store ---
// Plugins live in the `plugins` table (issue #105 Phase 0) so they survive image
// upgrades; the old widgets_registry.json is only read once by migration 18.

// A plugin may embed a manifest in its HTML to opt into platform capabilities
// (issue #105 Phase 1). Plain widgets simply omit the block and work as before.
//   <script type="application/json" id="homeglow-manifest">{ ... }</script>
const PLUGIN_MANIFEST_REGEX = /<script[^>]*id=["']homeglow-manifest["'][^>]*>([\s\S]*?)<\/script>/i;
const PLUGIN_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLUGIN_SETTING_KEY_REGEX = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;
const PLUGIN_SETTING_TYPES = new Set(['number', 'string', 'boolean', 'select']);
const PLUGIN_SETTING_SCOPES = new Set(['household', 'device']);

// Returns { manifest: object|null, errors: string[] }. A missing block is not
// an error (legacy widget); a present-but-invalid block is, so a typo'd
// manifest fails the upload loudly instead of silently installing as legacy.
function extractPluginManifest(htmlContent) {
  const match = htmlContent.match(PLUGIN_MANIFEST_REGEX);
  if (!match) {
    return { manifest: null, errors: [] };
  }

  let manifest;
  try {
    manifest = JSON.parse(match[1]);
  } catch (parseError) {
    return { manifest: null, errors: [`Manifest is not valid JSON: ${parseError.message}`] };
  }

  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { manifest: null, errors: ['Manifest must be a JSON object.'] };
  }
  if (manifest.manifestVersion !== 1) {
    errors.push('manifestVersion must be 1.');
  }
  if (typeof manifest.id !== 'string' || !PLUGIN_ID_REGEX.test(manifest.id)) {
    errors.push('id is required and must be a lowercase slug (a-z, 0-9, hyphens, max 64 chars).');
  }
  if (manifest.name !== undefined && typeof manifest.name !== 'string') {
    errors.push('name must be a string.');
  }
  if (manifest.apiVersion !== undefined && manifest.apiVersion !== 'v1') {
    errors.push("apiVersion must be 'v1'.");
  }
  if (manifest.storage !== undefined && typeof manifest.storage !== 'boolean') {
    errors.push('storage must be a boolean.');
  }
  if (manifest.events !== undefined) {
    if (!Array.isArray(manifest.events) || manifest.events.some((event) => typeof event !== 'string')) {
      errors.push('events must be an array of strings.');
    } else {
      for (const event of manifest.events) {
        if (!pluginEvents.isKnownEvent(event)) {
          errors.push(`events: "${event}" is not a known event (catalog: ${pluginEvents.PLUGIN_EVENT_CATALOG.join(', ')}).`);
        }
      }
    }
  }
  if (manifest.reactions !== undefined) {
    if (!Array.isArray(manifest.reactions)) {
      errors.push('reactions must be an array.');
    } else {
      if (manifest.reactions.length > 0 && manifest.storage !== true) {
        errors.push('reactions require "storage": true (they write to plugin storage).');
      }
      manifest.reactions.forEach((reaction, index) => {
        if (!reaction || typeof reaction !== 'object') {
          errors.push(`reactions[${index}] must be an object.`);
          return;
        }
        if (typeof reaction.on !== 'string' || !pluginEvents.isKnownEvent(reaction.on)) {
          errors.push(`reactions[${index}].on must be a known event (catalog: ${pluginEvents.PLUGIN_EVENT_CATALOG.join(', ')}).`);
        }
        if (reaction.action !== 'increment') {
          errors.push(`reactions[${index}].action must be 'increment' (the only supported action).`);
        }
        if (typeof reaction.key !== 'string' || !PLUGIN_STORAGE_KEY_REGEX.test(reaction.key)) {
          errors.push(`reactions[${index}].key must be a valid storage key.`);
        }
        if (typeof reaction.path !== 'string' || reaction.path.length === 0 ||
            reaction.path.split('.').some((segment) => segment.length === 0)) {
          errors.push(`reactions[${index}].path must be a non-empty dot-separated path.`);
        }
        // Optional multiplier applied to the resolved delta — factor: -1 lets a
        // mirror reaction (e.g. on chore.uncompleted) compensate a setting- or
        // payload-driven increment that cannot be negated in the manifest.
        if (reaction.factor !== undefined && (typeof reaction.factor !== 'number' || !Number.isFinite(reaction.factor))) {
          errors.push(`reactions[${index}].factor must be a finite number.`);
        }
        const delta = reaction.delta;
        const deltaValid = (typeof delta === 'number' && Number.isFinite(delta)) ||
          (delta && typeof delta === 'object' && !Array.isArray(delta) &&
            (typeof delta.setting === 'string' || typeof delta.payload === 'string'));
        if (!deltaValid) {
          errors.push(`reactions[${index}].delta must be a number, { "setting": "<key>" }, or { "payload": "<field>" }.`);
        } else if (delta && typeof delta === 'object' && typeof delta.setting === 'string') {
          const declared = Array.isArray(manifest.settings)
            ? manifest.settings.find((setting) => setting && setting.key === delta.setting)
            : null;
          // Device-scoped settings are excluded: a server-side reaction has no
          // device context to resolve them against.
          if (!declared || declared.type !== 'number' || declared.scope === 'device') {
            errors.push(`reactions[${index}].delta.setting must reference a declared household number setting.`);
          }
        }
      });
    }
  }
  if (manifest.settings !== undefined) {
    if (!Array.isArray(manifest.settings)) {
      errors.push('settings must be an array.');
    } else {
      manifest.settings.forEach((setting, index) => {
        if (!setting || typeof setting !== 'object') {
          errors.push(`settings[${index}] must be an object.`);
          return;
        }
        if (typeof setting.key !== 'string' || !PLUGIN_SETTING_KEY_REGEX.test(setting.key)) {
          errors.push(`settings[${index}].key must be an alphanumeric identifier.`);
        }
        if (!PLUGIN_SETTING_TYPES.has(setting.type)) {
          errors.push(`settings[${index}].type must be one of: ${[...PLUGIN_SETTING_TYPES].join(', ')}.`);
        }
        if (setting.scope !== undefined && !PLUGIN_SETTING_SCOPES.has(setting.scope)) {
          errors.push(`settings[${index}].scope must be 'household' or 'device'.`);
        }
        if (setting.type === 'select' && (
          !Array.isArray(setting.options) || setting.options.length === 0 ||
          setting.options.some((option) => typeof option !== 'string')
        )) {
          errors.push(`settings[${index}].options must be a non-empty array of strings for select settings.`);
        }
        if (setting.min !== undefined && typeof setting.min !== 'number') {
          errors.push(`settings[${index}].min must be a number.`);
        }
        if (setting.max !== undefined && typeof setting.max !== 'number') {
          errors.push(`settings[${index}].max must be a number.`);
        }
      });
    }
  }

  return { manifest: errors.length === 0 ? manifest : null, errors };
}

// Shared by upload and GitHub install: validate any embedded manifest and
// upsert the plugin row. Returns an { error, status } object on rejection.
async function installPluginRow({ filename, fallbackName, content, source, originalUrl = null }) {
  const { manifest, errors } = extractPluginManifest(content);
  if (errors.length > 0) {
    return { error: `Invalid plugin manifest: ${errors.join(' ')}`, status: 400 };
  }

  const pluginId = manifest ? manifest.id : null;
  if (pluginId) {
    const conflict = await Plugin.query()
      .select('filename')
      .where('plugin_id', pluginId)
      .whereNot('filename', filename)
      .first();
    if (conflict) {
      return {
        error: `Plugin id "${pluginId}" is already used by ${conflict.filename}.`,
        status: 409,
      };
    }
  }

  await Plugin.query()
    .insert({
      filename,
      name: (manifest && manifest.name) || fallbackName,
      content,
      source,
      original_url: originalUrl,
      plugin_id: pluginId,
      manifest_json: manifest ? JSON.stringify(manifest) : null,
    })
    .onConflict('filename')
    .merge({
      content,
      name: (manifest && manifest.name) || fallbackName,
      source,
      original_url: originalUrl,
      plugin_id: pluginId,
      manifest_json: manifest ? JSON.stringify(manifest) : null,
      updated_at: knex.fn.now(),
    });

  return { pluginId };
}

// Helper: Load legacy on-disk widget registry (kept for the debug endpoint)
async function loadWidgetRegistry() {
  try {
    const data = await fs.readFile(widgetRegistryPath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

// Helper: List installed plugins in the legacy registry response shape
async function listInstalledPlugins() {
  const rows = await Plugin.query()
    .select('filename', 'name', 'source', 'original_url', 'plugin_id', 'manifest_json', 'installed_at')
    .orderBy([{ column: 'installed_at' }, { column: 'filename' }]);
  return rows.map((row) => ({
    name: row.name,
    filename: row.filename,
    uploadedAt: row.installed_at,
    source: row.source,
    ...(row.original_url ? { originalUrl: row.original_url } : {}),
    ...(row.plugin_id ? { pluginId: row.plugin_id } : {}),
    ...(row.manifest_json ? { manifest: parseJsonObject(row.manifest_json, null) } : {}),
  }));
}

// Endpoint: Upload a widget (HTML file)
// Deliberately NOT demo-blocked: plugins are a showcase feature, and since the
// plugin store moved into the database (issue #105 Phase 0) demo installs live
// in the in-memory DB and vanish on the demo reset cycle — nothing persists.
fastify.post('/api/widgets/upload', async (request, reply) => {
  try {
    const data = await request.file();
    if (!data || !data.filename.endsWith('.html')) {
      return reply.status(400).send({ error: 'Only HTML widget files are allowed.' });
    }

    const widgetName = data.filename.replace(/[^a-zA-Z0-9-._]/g, '_');
    const content = (await data.toBuffer()).toString('utf-8');

    // Re-uploading the same filename replaces the content (matches the old
    // overwrite-the-file behavior); an embedded manifest is validated first.
    const result = await installPluginRow({
      filename: widgetName,
      fallbackName: widgetName.replace('.html', ''),
      content,
      source: 'upload',
    });
    if (result.error) {
      return reply.status(result.status).send({ error: result.error });
    }

    return { success: true, message: 'Widget uploaded!', widget: widgetName, pluginId: result.pluginId || null };
  } catch (err) {
    console.error('Widget upload error:', err);
    reply.status(500).send({ error: 'Failed to upload widget.' });
  }
});

// Endpoint: List widgets
fastify.get('/api/widgets', async (request, reply) => {
  try {
    return await listInstalledPlugins();
  } catch (err) {
    console.error('Error listing plugins:', err);
    reply.status(500).send({ error: 'Failed to load widget registry.' });
  }
});

// Endpoint: Delete a widget.
// By default the plugin's platform state (storage, settings) is KEPT so a
// reinstall under the same id picks up where it left off. Pass
// ?purgeData=true to also wipe it — recommended before installing a
// *different* plugin that declares the same id, which would otherwise
// silently inherit the predecessor's data.
// Not demo-blocked — see the widget upload endpoint.
fastify.delete('/api/widgets/:filename', async (request, reply) => {
  const { filename } = request.params;
  const purgeData = request.query.purgeData === 'true';
  try {
    const pluginRow = await Plugin.query().select('plugin_id').where('filename', filename).first();
    const result = { changes: await Plugin.query().delete().where('filename', filename) };

    if (purgeData && pluginRow?.plugin_id) {
      const pluginId = pluginRow.plugin_id;
      await PluginStorage.query().delete().where('plugin_id', pluginId);
      await Setting.query().delete().where('key', pluginHouseholdSettingsKey(pluginId));
      // Sweep device-scoped values out of every device blob.
      const devices = await knex('devices').select('name', 'device_settings_json');
      for (const device of devices) {
        const deviceSettings = parseJsonObject(device.device_settings_json, {});
        const platformSettings = deviceSettings.pluginPlatformSettings;
        if (platformSettings && typeof platformSettings === 'object' && platformSettings[pluginId] !== undefined) {
          delete platformSettings[pluginId];
          await knex('devices').where('name', device.name).update({
            device_settings_json: JSON.stringify(deviceSettings),
            updateTime: knex.raw('CURRENT_TIMESTAMP'),
          });
        }
      }
    }

    // Best-effort cleanup of a pre-migration file on disk.
    let removedFromDisk = false;
    try {
      await fs.unlink(path.join(__dirname, 'widgets', filename));
      removedFromDisk = true;
    } catch {
      // Nothing on disk — expected for DB-backed plugins.
    }

    if (result.changes === 0 && !removedFromDisk) {
      return reply.status(404).send({ error: 'Widget not found.' });
    }

    return { success: true, message: 'Widget deleted.' };
  } catch (err) {
    console.error('Widget delete error:', err);
    reply.status(500).send({ error: 'Failed to delete widget.' });
  }
});

// --- Plugin Platform v1 API: storage (issue #105 Phase 1, capability c) ---
// Namespaced key/value documents for manifest plugins. Everything under
// /api/plugin/v1 is the versioned contract plugins may rely on; see
// docs/architecture/plugin-platform.md.

const PLUGIN_STORAGE_MAX_VALUE_BYTES = 64 * 1024;
const PLUGIN_STORAGE_MAX_KEYS = 500;
const PLUGIN_STORAGE_KEY_REGEX = /^[A-Za-z0-9:_.-]{1,128}$/;

// Guard: the pluginId must belong to an installed manifest plugin that declared
// `"storage": true`. Sends the error reply and returns null on failure.
async function requireStoragePlugin(pluginId, reply) {
  const row = await Plugin.query().select('manifest_json').where('plugin_id', pluginId).first();
  if (!row) {
    reply.status(403).send({ error: `Unknown plugin id "${pluginId}".` });
    return null;
  }
  const manifest = parseJsonObject(row.manifest_json, {});
  if (manifest.storage !== true) {
    reply.status(403).send({ error: `Plugin "${pluginId}" does not declare storage in its manifest.` });
    return null;
  }
  return manifest;
}

function validStorageKey(key, reply) {
  if (!PLUGIN_STORAGE_KEY_REGEX.test(key)) {
    reply.status(400).send({ error: 'Storage keys must be 1-128 chars of A-Za-z0-9 : _ . -' });
    return false;
  }
  return true;
}

fastify.get('/api/plugin/v1/storage/:pluginId', async (request, reply) => {
  const { pluginId } = request.params;
  if (!(await requireStoragePlugin(pluginId, reply))) return;

  const rows = await PluginStorage.query().select('key', 'value_json').where('plugin_id', pluginId).orderBy('key');
  const values = {};
  for (const row of rows) {
    try {
      values[row.key] = JSON.parse(row.value_json);
    } catch {
      values[row.key] = null;
    }
  }
  return values;
});

fastify.get('/api/plugin/v1/storage/:pluginId/:key', async (request, reply) => {
  const { pluginId, key } = request.params;
  if (!(await requireStoragePlugin(pluginId, reply))) return;
  if (!validStorageKey(key, reply)) return;

  const row = await PluginStorage.query().select('value_json').where({ plugin_id: pluginId, key }).first();
  if (!row) {
    return reply.status(404).send({ error: 'Key not found.' });
  }
  reply.header('Content-Type', 'application/json');
  return row.value_json;
});

// Plugin platform mutations are not demo-blocked: they only write to the
// plugin's own namespace in the (in-memory, self-resetting) demo DB, and demo
// visitors should be able to try plugins end-to-end.
fastify.put('/api/plugin/v1/storage/:pluginId/:key', async (request, reply) => {
  const { pluginId, key } = request.params;
  if (!(await requireStoragePlugin(pluginId, reply))) return;
  if (!validStorageKey(key, reply)) return;

  const valueJson = JSON.stringify(request.body === undefined ? null : request.body);
  if (Buffer.byteLength(valueJson, 'utf-8') > PLUGIN_STORAGE_MAX_VALUE_BYTES) {
    return reply.status(413).send({ error: `Value exceeds ${PLUGIN_STORAGE_MAX_VALUE_BYTES / 1024} KB limit.` });
  }

  const exists = await PluginStorage.query().select('plugin_id').where({ plugin_id: pluginId, key }).first();
  if (!exists) {
    const { count } = await knex('plugin_storage').where('plugin_id', pluginId).count({ count: '*' }).first();
    if (count >= PLUGIN_STORAGE_MAX_KEYS) {
      return reply.status(413).send({ error: `Plugin storage is limited to ${PLUGIN_STORAGE_MAX_KEYS} keys.` });
    }
  }

  await PluginStorage.query()
    .insert({ plugin_id: pluginId, key, value_json: valueJson })
    .onConflict(['plugin_id', 'key'])
    .merge({ value_json: valueJson, updated_at: knex.fn.now() });

  return { success: true };
});

fastify.delete('/api/plugin/v1/storage/:pluginId/:key', async (request, reply) => {
  const { pluginId, key } = request.params;
  if (!(await requireStoragePlugin(pluginId, reply))) return;
  if (!validStorageKey(key, reply)) return;

  const changes = await PluginStorage.query().delete().where({ plugin_id: pluginId, key });
  if (changes === 0) {
    return reply.status(404).send({ error: 'Key not found.' });
  }
  return { success: true };
});

// Atomic numeric delta on a JSON path inside a stored document — the primitive
// the clam-bucket siphon needs ("add N to the give pool") without a general
// transaction API. Creates the key/path if missing. Body: { path, delta }.
// `ex` is the Knex executor: callers pass a transaction so the read-modify-write
// is one atomic unit.
const incrementPluginStorage = async (pluginId, key, pathSegments, delta, ex = knex) => {
  const row = await ex('plugin_storage').select('value_json').where({ plugin_id: pluginId, key }).first();
  let doc = {};
  if (row) {
    try {
      doc = JSON.parse(row.value_json);
    } catch {
      doc = {};
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw Object.assign(new Error('Stored value is not a JSON object.'), { statusCode: 409 });
    }
  }

  let target = doc;
  for (const segment of pathSegments.slice(0, -1)) {
    if (target[segment] === undefined) {
      target[segment] = {};
    }
    if (!target[segment] || typeof target[segment] !== 'object' || Array.isArray(target[segment])) {
      throw Object.assign(new Error(`Path segment "${segment}" is not an object.`), { statusCode: 409 });
    }
    target = target[segment];
  }

  const leaf = pathSegments[pathSegments.length - 1];
  const current = target[leaf] === undefined ? 0 : target[leaf];
  if (typeof current !== 'number' || !Number.isFinite(current)) {
    throw Object.assign(new Error(`Value at path is not a number.`), { statusCode: 409 });
  }
  target[leaf] = current + delta;

  const valueJson = JSON.stringify(doc);
  if (Buffer.byteLength(valueJson, 'utf-8') > PLUGIN_STORAGE_MAX_VALUE_BYTES) {
    throw Object.assign(new Error('Value exceeds size limit.'), { statusCode: 413 });
  }

  await ex('plugin_storage')
    .insert({ plugin_id: pluginId, key, value_json: valueJson })
    .onConflict(['plugin_id', 'key'])
    .merge({ value_json: valueJson, updated_at: ex.fn.now() });

  return { result: target[leaf], value: doc };
};

fastify.post('/api/plugin/v1/storage/:pluginId/:key/increment', async (request, reply) => {
  const { pluginId, key } = request.params;
  if (!(await requireStoragePlugin(pluginId, reply))) return;
  if (!validStorageKey(key, reply)) return;

  const { path: incrementPath, delta } = request.body || {};
  if (typeof incrementPath !== 'string' || incrementPath.length === 0) {
    return reply.status(400).send({ error: 'path is required (dot-separated, e.g. "buckets.give").' });
  }
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    return reply.status(400).send({ error: 'delta must be a finite number.' });
  }
  const pathSegments = incrementPath.split('.');
  if (pathSegments.some((segment) => segment.length === 0)) {
    return reply.status(400).send({ error: 'path segments must be non-empty.' });
  }

  try {
    // The read-modify-write runs inside one transaction so concurrent HTTP
    // requests cannot interleave and lose an increment.
    const { result, value } = await knex.transaction(
      (trx) => incrementPluginStorage(pluginId, key, pathSegments, delta, trx)
    );
    return { success: true, result, value };
  } catch (error) {
    if (error.statusCode) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    console.error('Plugin storage increment error:', error);
    return reply.status(500).send({ error: 'Failed to apply increment.' });
  }
});

// --- Plugin Platform v1 API: settings (issue #105 Phase 2, capability d) ---
// Values for the settings a plugin declared in its manifest. Each key lives at
// exactly one scope: 'household' (default; global `settings` table under
// plugin:<id>:settings) or 'device' (per-device blob under
// device_settings_json.pluginPlatformSettings[<id>]). GET returns the merged
// effective values: manifest default <- stored value for the key's scope.

async function requireManifestPlugin(pluginId, reply) {
  const row = await Plugin.query().select('manifest_json').where('plugin_id', pluginId).first();
  if (!row) {
    reply.status(403).send({ error: `Unknown plugin id "${pluginId}".` });
    return null;
  }
  return parseJsonObject(row.manifest_json, {});
}

function pluginHouseholdSettingsKey(pluginId) {
  return `plugin:${pluginId}:settings`;
}

async function readHouseholdPluginSettings(pluginId) {
  const row = await knex('settings').select('value').where('key', pluginHouseholdSettingsKey(pluginId)).first();
  return parseJsonObject(row?.value, {});
}

async function readDevicePluginSettings(pluginId, deviceName) {
  const row = await knex('devices').select('device_settings_json').where('name', deviceName).first();
  const deviceSettings = parseJsonObject(row?.device_settings_json, {});
  const platformSettings = deviceSettings.pluginPlatformSettings;
  const values = platformSettings && typeof platformSettings === 'object' && !Array.isArray(platformSettings)
    ? platformSettings[pluginId]
    : undefined;
  return values && typeof values === 'object' && !Array.isArray(values) ? values : {};
}

// Returns a problem string or null.
function validatePluginSettingValue(setting, value) {
  switch (setting.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number';
      if (typeof setting.min === 'number' && value < setting.min) return `must be >= ${setting.min}`;
      if (typeof setting.max === 'number' && value > setting.max) return `must be <= ${setting.max}`;
      return null;
    case 'string':
      if (typeof value !== 'string') return 'must be a string';
      if (value.length > 1024) return 'must be at most 1024 characters';
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'select':
      if (typeof value !== 'string') return 'must be a string';
      if (Array.isArray(setting.options) && !setting.options.includes(value)) {
        return `must be one of: ${setting.options.join(', ')}`;
      }
      return null;
    default:
      return 'has an unsupported type';
  }
}

// The single source of truth for effective setting values (manifest default <-
// stored value at the key's scope). Used by the GET route AND the declarative
// reaction executor so the two can never drift.
async function resolveEffectiveSettings(pluginId, manifest, deviceName = null) {
  const declared = Array.isArray(manifest.settings) ? manifest.settings : [];
  const household = await readHouseholdPluginSettings(pluginId);
  const deviceValues = deviceName ? await readDevicePluginSettings(pluginId, deviceName) : {};

  const merged = {};
  for (const setting of declared) {
    const stored = setting.scope === 'device' ? deviceValues[setting.key] : household[setting.key];
    const value = stored !== undefined ? stored : setting.default;
    merged[setting.key] = value === undefined ? null : value;
  }
  return merged;
}

fastify.get('/api/plugin/v1/settings/:pluginId', async (request, reply) => {
  const { pluginId } = request.params;
  const manifest = await requireManifestPlugin(pluginId, reply);
  if (!manifest) return;

  const deviceName = typeof request.query.device === 'string' && request.query.device ? request.query.device : null;
  return await resolveEffectiveSettings(pluginId, manifest, deviceName);
});

fastify.put('/api/plugin/v1/settings/:pluginId', async (request, reply) => {
  const { pluginId } = request.params;
  const manifest = await requireManifestPlugin(pluginId, reply);
  if (!manifest) return;

  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply.status(400).send({ error: 'Body must be an object of { settingKey: value }.' });
  }

  const declared = Array.isArray(manifest.settings) ? manifest.settings : [];
  const declaredByKey = new Map(declared.map((setting) => [setting.key, setting]));
  const deviceName = typeof request.query.device === 'string' && request.query.device ? request.query.device : null;

  const householdUpdates = {};
  const deviceUpdates = {};
  for (const [key, value] of Object.entries(body)) {
    const setting = declaredByKey.get(key);
    if (!setting) {
      return reply.status(400).send({ error: `"${key}" is not declared in the plugin manifest.` });
    }
    const problem = validatePluginSettingValue(setting, value);
    if (problem) {
      return reply.status(400).send({ error: `"${key}" ${problem}.` });
    }
    if (setting.scope === 'device') {
      deviceUpdates[key] = value;
    } else {
      householdUpdates[key] = value;
    }
  }

  if (Object.keys(deviceUpdates).length > 0 && !deviceName) {
    return reply.status(400).send({ error: 'A ?device= query parameter is required to write device-scoped settings.' });
  }

  if (Object.keys(householdUpdates).length > 0) {
    const current = await readHouseholdPluginSettings(pluginId);
    const value = JSON.stringify({ ...current, ...householdUpdates });
    await knex('settings')
      .insert({ key: pluginHouseholdSettingsKey(pluginId), value })
      .onConflict('key')
      .merge({ value });
  }

  if (Object.keys(deviceUpdates).length > 0) {
    await knex('devices').insert({ name: deviceName, device_settings_json: '{}' }).onConflict('name').ignore();
    const row = await knex('devices').select('device_settings_json').where('name', deviceName).first();
    const deviceSettings = parseJsonObject(row?.device_settings_json, {});
    const platformSettings = (deviceSettings.pluginPlatformSettings && typeof deviceSettings.pluginPlatformSettings === 'object')
      ? deviceSettings.pluginPlatformSettings
      : {};
    platformSettings[pluginId] = { ...(platformSettings[pluginId] || {}), ...deviceUpdates };
    deviceSettings.pluginPlatformSettings = platformSettings;
    await knex('devices').where('name', deviceName).update({
      device_settings_json: JSON.stringify(deviceSettings),
      updateTime: knex.raw('CURRENT_TIMESTAMP'),
    });
  }

  return { success: true };
});

// --- Plugin Platform v1 API: event stream (issue #105 Phase 3, capability b) ---
// One SSE connection per dashboard; every catalog event is sent as a `data:`
// message ({ event, payload, emittedAt }) and the client bridge filters per
// plugin against its declared events. Delivery is ephemeral by design (no
// replay) — durable state belongs in plugin storage.
fastify.get('/api/plugin/v1/events/stream', (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // Tell the Nginx reverse proxy not to buffer the stream.
    'X-Accel-Buffering': 'no',
    // reply.hijack() bypasses @fastify/cors, so mirror its policy (origin '*',
    // see the cors registration above) or cross-origin EventSources (dev mode)
    // are blocked by the browser.
    'Access-Control-Allow-Origin': '*',
  });
  reply.raw.write(': connected\n\n');

  const unsubscribe = pluginEvents.subscribe((message) => {
    reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
  });
  // Comment-only heartbeat keeps idle connections alive through proxies.
  const heartbeat = setInterval(() => {
    reply.raw.write(': ping\n\n');
  }, 25000);

  request.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// --- Plugin Platform: declarative reactions (issue #105 Phase 4, Model C) ---
// A manifest may declare reactions — bounded, validated storage increments the
// server executes when a core event fires, e.g. the clam-bucket siphon:
//   { "on": "clam.withdrawn", "action": "increment",
//     "key": "give-pool", "path": "total", "delta": { "setting": "siphonAmount" } }
// This runs at emission, exactly once per event, regardless of how many (or
// zero) dashboards have the plugin mounted — no arbitrary plugin code ever runs
// on the server, only the declared increment. Reaction failures are logged and
// never break the core mutation or other plugins' reactions.

async function resolveReactionDelta(deltaSpec, manifest, pluginId, payload) {
  if (typeof deltaSpec === 'number' && Number.isFinite(deltaSpec)) {
    return deltaSpec;
  }
  if (deltaSpec && typeof deltaSpec === 'object') {
    if (typeof deltaSpec.setting === 'string') {
      // Same resolution the settings GET route serves — via the shared helper,
      // so Admin-Panel-visible values and reaction deltas can never disagree.
      const value = (await resolveEffectiveSettings(pluginId, manifest))[deltaSpec.setting];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    if (typeof deltaSpec.payload === 'string') {
      const value = payload ? payload[deltaSpec.payload] : undefined;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

async function runDeclarativeReactions(message) {
  try {
    const rows = await Plugin.query()
      .select('plugin_id', 'manifest_json')
      .whereNotNull('plugin_id')
      .whereNotNull('manifest_json');
    for (const row of rows) {
      const manifest = parseJsonObject(row.manifest_json, {});
      const reactions = Array.isArray(manifest.reactions) ? manifest.reactions : [];
      for (const reaction of reactions) {
        if (reaction.on !== message.event) continue;
        const resolved = await resolveReactionDelta(reaction.delta, manifest, row.plugin_id, message.payload);
        if (resolved === null) continue;
        const factor = typeof reaction.factor === 'number' && Number.isFinite(reaction.factor) ? reaction.factor : 1;
        const delta = resolved * factor;
        if (delta === 0) continue;
        try {
          const pathSegments = String(reaction.path).split('.');
          await knex.transaction(
            (trx) => incrementPluginStorage(row.plugin_id, reaction.key, pathSegments, delta, trx)
          );
        } catch (error) {
          console.error(`Plugin reaction failed (${row.plugin_id} on ${message.event}):`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Declarative reaction executor failed:', error);
  }
}

// Reactions run before the event is broadcast (they used to be the
// first-registered subscriber, back when the executor was synchronous), so
// storage is up to date by the time any dashboard is notified — and by the time
// the route that emitted answers. `pluginEvents.emit()` is synchronous and
// discards return values, so an async executor can no longer be a plain
// subscriber: it is invoked and awaited here instead.
async function emitPluginEvent(event, payload) {
  if (!pluginEvents.isKnownEvent(event)) {
    // Mirrors emit()'s own guard so an unknown name is refused identically
    // rather than silently running reactions for it.
    pluginEvents.emit(event, payload);
    return;
  }
  await runDeclarativeReactions({ event, payload, emittedAt: new Date().toISOString() });
  pluginEvents.emit(event, payload);
}

// --- Chore notification sound bank ---

// Endpoint: List available sounds (bundled defaults + user uploads)
fastify.get('/api/sounds', async (request, reply) => {
  try {
    await fs.mkdir(SOUNDS_UPLOAD_DIR, { recursive: true });
    const defaults = getDefaultSoundFilenames();
    const files = await fs.readdir(SOUNDS_UPLOAD_DIR);

    return files
      .filter((filename) => ALLOWED_SOUND_EXTENSIONS.has(path.extname(filename).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((filename) => ({
        filename,
        name: filename.replace(/\.[^.]+$/, ''),
        url: `/Uploads/sounds/${filename}`,
        isDefault: defaults.has(filename),
      }));
  } catch (error) {
    console.error('Error listing sounds:', error);
    reply.status(500).send({ error: 'Failed to list sounds' });
  }
});

// Endpoint: Upload a custom sound
fastify.post('/api/sounds/upload', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded.' });
    }

    const ext = path.extname(data.filename).toLowerCase();
    if (!ALLOWED_SOUND_EXTENSIONS.has(ext)) {
      return reply.status(400).send({
        error: `Unsupported file type. Allowed: ${Array.from(ALLOWED_SOUND_EXTENSIONS).join(', ')}`,
      });
    }

    await fs.mkdir(SOUNDS_UPLOAD_DIR, { recursive: true });
    const safeName = data.filename.replace(/[^a-zA-Z0-9-._]/g, '_');
    await fs.writeFile(path.join(SOUNDS_UPLOAD_DIR, safeName), await data.toBuffer());

    return {
      success: true,
      message: 'Sound uploaded!',
      sound: { filename: safeName, name: safeName.replace(/\.[^.]+$/, ''), url: `/Uploads/sounds/${safeName}`, isDefault: false },
    };
  } catch (error) {
    console.error('Error uploading sound:', error);
    reply.status(500).send({ error: 'Failed to upload sound.' });
  }
});

// Endpoint: Delete an uploaded sound (bundled defaults are protected)
fastify.delete('/api/sounds/:filename', async (request, reply) => {
  if (demoBlocked(reply)) return;
  const { filename } = request.params;
  try {
    if (getDefaultSoundFilenames().has(filename)) {
      return reply.status(400).send({ error: 'Default sounds cannot be deleted.' });
    }

    await fs.unlink(path.join(SOUNDS_UPLOAD_DIR, filename));
    return { success: true, message: 'Sound deleted.' };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return reply.status(404).send({ error: 'Sound not found.' });
    }
    console.error('Error deleting sound:', error);
    reply.status(500).send({ error: 'Failed to delete sound.' });
  }
});

// Debug endpoint to list installed plugins (DB) and any legacy on-disk files
fastify.get('/api/widgets/debug', async (request, reply) => {
  try {
    const widgetsDir = path.join(__dirname, 'widgets');

    let fileDetails = [];
    try {
      const files = await fs.readdir(widgetsDir);
      for (const file of files) {
        const filePath = path.join(widgetsDir, file);
        try {
          const stats = await fs.stat(filePath);
          fileDetails.push({
            name: file,
            size: stats.size,
            isFile: stats.isFile(),
            modified: stats.mtime
          });
        } catch (err) {
          fileDetails.push({
            name: file,
            error: err.message
          });
        }
      }
    } catch (dirError) {
      fileDetails = [{ error: dirError.message }];
    }

    const plugins = await knex('plugins')
      .select(
        'filename',
        'name',
        'source',
        'original_url',
        knex.raw('LENGTH(content) AS content_length'),
        knex.raw('manifest_json IS NOT NULL AS has_manifest'),
        'installed_at',
        'updated_at'
      )
      .orderBy([{ column: 'installed_at' }, { column: 'filename' }]);

    return {
      plugins,
      legacyDirectory: widgetsDir,
      legacyFiles: fileDetails,
      legacyRegistry: await loadWidgetRegistry()
    };
  } catch (error) {
    console.error('Error reading plugin store:', error);
    return { error: error.message };
  }
});

// Endpoint: List available widgets from GitHub repository
fastify.get('/api/widgets/github', async (request, reply) => {
  try {
    console.log('Fetching widgets from GitHub repository...');

    // Get repository contents
    const repoUrl = `${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents`;
    const response = await axios.get(repoUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'HomeGlow-Server/1.0'
      },
      timeout: 10000
    });

    // Filter for HTML files and directories
    const items = response.data.filter(item =>
      item.type === 'file' && item.name.endsWith('.html') ||
      item.type === 'dir'
    );

    const widgets = [];

    for (const item of items) {
      if (item.type === 'file' && item.name.endsWith('.html')) {
        // Direct HTML file in root
        widgets.push({
          name: item.name.replace('.html', ''),
          filename: item.name,
          description: `Widget: ${item.name.replace('.html', '')}`,
          download_url: item.download_url,
          path: item.path,
          size: item.size,
          type: 'file'
        });
      } else if (item.type === 'dir') {
        // Check if directory contains HTML files
        try {
          const dirUrl = `${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${item.path}`;
          const dirResponse = await axios.get(dirUrl, {
            headers: {
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'HomeGlow-Server/1.0'
            },
            timeout: 5000
          });

          const htmlFiles = dirResponse.data.filter(file =>
            file.type === 'file' && file.name.endsWith('.html')
          );

          for (const htmlFile of htmlFiles) {
            widgets.push({
              name: `${item.name}/${htmlFile.name.replace('.html', '')}`,
              filename: htmlFile.name,
              description: `Widget from ${item.name} folder`,
              download_url: htmlFile.download_url,
              path: htmlFile.path,
              size: htmlFile.size,
              type: 'file',
              folder: item.name
            });
          }
        } catch (dirError) {
          console.warn(`Could not read directory ${item.name}:`, dirError.message);
        }
      }
    }

    console.log(`Found ${widgets.length} widgets in GitHub repository`);
    return widgets;

  } catch (error) {
    console.error('Error fetching GitHub widgets:', error);
    if (error.response) {
      return reply.status(error.response.status).send({
        error: `GitHub API error: ${error.response.status} ${error.response.statusText}`,
        details: error.response.data
      });
    }
    return reply.status(500).send({
      error: 'Failed to fetch widgets from GitHub repository',
      details: error.message
    });
  }
});

// Endpoint: Install a widget from GitHub repository
// Not demo-blocked — see the widget upload endpoint.
fastify.post('/api/widgets/github/install', async (request, reply) => {
  try {
    const { download_url, filename, name } = request.body;

    if (!download_url || !filename) {
      return reply.status(400).send({ error: 'download_url and filename are required' });
    }

    console.log(`Installing widget ${filename} from GitHub...`);

    // Download the widget file
    const response = await axios.get(download_url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'HomeGlow-Server/1.0'
      },
      timeout: 15000
    });

    // Sanitize filename
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9-._]/g, '_');
    const content = typeof response.data === 'string' ? response.data : String(response.data);

    // Reinstalling refreshes the content in place; provenance is kept so a
    // future "update available" check knows where the plugin came from.
    const result = await installPluginRow({
      filename: sanitizedFilename,
      fallbackName: name || sanitizedFilename.replace('.html', ''),
      content,
      source: 'github',
      originalUrl: download_url,
    });
    if (result.error) {
      return reply.status(result.status).send({ error: result.error });
    }

    console.log(`Successfully installed widget: ${sanitizedFilename}`);
    return {
      success: true,
      message: 'Widget installed successfully!',
      widget: sanitizedFilename
    };

  } catch (error) {
    console.error('Error installing GitHub widget:', error);
    if (error.response) {
      return reply.status(error.response.status).send({
        error: `Failed to download widget: ${error.response.status} ${error.response.statusText}`,
        details: error.response.data
      });
    }
    return reply.status(500).send({
      error: 'Failed to install widget from GitHub',
      details: error.message
    });
  }
});

// Initialize database. Demo mode uses an in-memory database so all data is
// discarded when the container stops.
const dbPath = DEMO_MODE
  ? ':memory:'
  : (process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.resolve(__dirname, 'data', 'tasks.db'));
console.log('Database path:', dbPath);
let db; // Declare db variable outside to hold the single instance
let knex; // Knex/Objection instance, wired alongside the legacy `db` during the ORM migration

// === BEGIN LEGACY SCHEMA UPGRADE (Option A: retained ONLY to lift pre-v14 SQLite
// databases up to the v14 baseline before Knex adopts them; not used at runtime.
// Raw better-sqlite3 usage is permitted ONLY within this delimited block. The
// grep-guard test (tests/db/noRawDb.test.js) enforces that no raw db.prepare/
// db.exec/db.transaction/new Database usage exists OUTSIDE these markers.) ===
async function ConnectOrCreateDb() {
  try {
    if (dbPath !== ':memory:') {
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      await fs.chmod(path.dirname(dbPath), 0o777);
    }

    const newDb = new Database(dbPath);
    newDb.pragma('foreign_keys = ON');
    // WAL lets readers proceed while a writer is active (better-sqlite3 is still
    // single-threaded, but this avoids POSIX lock stalls across connections).
    if (dbPath !== ':memory:') {
      newDb.pragma('journal_mode = WAL');
    }
    return newDb;
  } catch (error) {
    console.error('Failed to connect or create database:', error);
    throw error;
  }
}

function doesTableExist(tableName) {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return !!table;
}

async function runLegacyMigrations() {
  await initializeDatabase(db);
  await migrateChoresDatabase(db, getTodayLocalDateString);
  await migrateClamsToHistory(db, getTodayLocalDateString);
  await migrateChoreHistoryTitle(db);
  await migrateToDurationField(db);
}

function getCurrentSchemaVersion() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SYSTEM_SCHEMA_ID_KEY);
  return row ? parseInt(row.value, 10) || 0 : 0;
}

function runSchemaMigrationModule(migration) {
  globalThis.__HOMEGLOW_SCHEMA_MIGRATION_CONTEXT = {
    db,
    schemaIdKey: SYSTEM_SCHEMA_ID_KEY,
    targetSchemaId: migration.schemaId,
  };

  try {
    delete require.cache[require.resolve(migration.migrationPath)];
    require(migration.migrationPath);
  } finally {
    delete globalThis.__HOMEGLOW_SCHEMA_MIGRATION_CONTEXT;
  }
}

async function applySchemaMigrations(currentSchemaId) {
  // Capped at the baseline: Knex owns every schema above v14, and the
  // post-baseline migrations in db/migrations reproduce 15.. Replaying the raw
  // legacy modules for those would double-apply their DDL.
  const pendingMigrations = schemaMigrations
    .filter(migration => migration.schemaId > currentSchemaId && migration.schemaId <= BASELINE_SCHEMA_VERSION)
    .sort((a, b) => a.schemaId - b.schemaId);

  if (pendingMigrations.length === 0) {
    console.log(`No pending schema migrations. Current schema ID: ${currentSchemaId}`);
    return;
  }

  for (const migration of pendingMigrations) {
    console.log(`Running schema migration path ${migration.migrationPath} (target schema ID: ${migration.schemaId})`);
    runSchemaMigrationModule(migration);
  }
}
// === END LEGACY SCHEMA UPGRADE ===

async function dailyBackgroundProcessing() {
  try {
    console.log('=== Starting daily background processing ===');
    let results = {};
    const today = getTodayLocalDateString();

    // Missed-chore logging (issue #72): record yesterday's due-but-uncompleted
    // regular chores BEFORE any pruning below deletes their schedules. Runs
    // first, in its own try/catch — metrics capture must never block the rest
    // of the nightly housekeeping. Idempotent via the partial unique index on
    // (user_id, chore_schedule_id, date) WHERE kind='missed', so the midnight
    // cron and the manual /api/system/backgroundTasks trigger can both run.
    // Vacation mode (issue #121) pauses this entirely: days off must not count
    // against completion rates or streaks.
    try {
      const missedDate = addDaysToDateOnly(today, -1);
      if (await isVacationActiveOn(missedDate)) {
        console.log(`Vacation mode active for ${missedDate} — skipping missed-chore logging`);
        results = { ...results, missedLoggedCount: 0, missedSkippedForVacation: true };
      } else {
        const endOfMissedDay = parseDateOnlyToLocalDate(missedDate);
        endOfMissedDay.setHours(23, 59, 59, 999);

        let missedLoggedCount = 0;
        const missedRows = [];
        const allUsers = await knex('users').select('id').whereNot('id', 0);
        for (const user of allUsers) {
          const dueChores = await getTodaysRegularChoresForUser(user.id, missedDate, endOfMissedDay);
          for (const schedule of dueChores) {
            if (schedule.completed_today) continue;
            // Idempotent, as the old INSERT OR IGNORE against the partial unique
            // index on (user_id, chore_schedule_id, date) WHERE kind='missed'
            // was: an already-logged miss is skipped and not counted.
            const alreadyLogged = await knex('chore_history')
              .where({ user_id: user.id, chore_schedule_id: schedule.id, date: missedDate, kind: 'missed' })
              .first();
            if (alreadyLogged) continue;
            await knex('chore_history').insert({
              user_id: user.id,
              chore_schedule_id: schedule.id,
              date: missedDate,
              clam_value: 0,
              title: schedule.title,
              kind: 'missed',
            });
            missedLoggedCount++;
            missedRows.push({ userId: user.id, scheduleId: schedule.id, title: schedule.title, date: missedDate });
          }
        }
        console.log(`Logged ${missedLoggedCount} missed chore(s) for ${missedDate}`);
        results = { ...results, missedLoggedCount, missedChores: missedRows };
      }
    } catch (missedError) {
      console.error('Missed-chore logging failed (continuing with housekeeping):', missedError);
      results = { ...results, missedLoggedCount: 0, missedLoggingError: missedError.message };
    }

    // We want to delete schedules that are completed and will never run again to avoid clutter.
    // kind = 'completion' is load-bearing (issue #72): a 'missed' row must not
    // make an UNcompleted one-time chore look completed and get it pruned.
    const schedulesToPrune = await knex('chore_schedules as cs')
      .join('chores as c', 'cs.chore_id', 'c.id')
      .select('cs.id', 'cs.chore_id', 'cs.user_id', 'c.title')
      .whereNull('cs.crontab')
      .where('cs.visible', 1)
      .whereExists(
        knex('chore_history as ch')
          .select(knex.raw('1'))
          .whereRaw('ch.chore_schedule_id = cs.id')
          .where('ch.kind', 'completion')
      );
    console.log(`Found ${schedulesToPrune.length} completed one-time chores to prune`);

    let prunedScheduleCount = 0;
    for (const schedule of schedulesToPrune) {

      await knex('chore_schedules').where('id', schedule.id).del();
      console.log(`Pruned schedule ID ${schedule.id}: "${schedule.title}" (user_id: ${schedule.user_id})`);
      prunedScheduleCount++;
    }
    results = {
      ...results,
      prunedSchedulesCount: prunedScheduleCount,
      prunedSchedules: schedulesToPrune,
    }

    // We should also delete chores that have no schedules to avoid clutter
    const choresToPrune = await knex('chores as c')
      .select('c.id', 'c.title')
      .whereRaw('NOT EXISTS (SELECT 1 FROM chore_schedules cs WHERE cs.chore_id = c.id)');
    console.log(`Found ${choresToPrune.length} orphaned chores to prune`);

    let prunedChoreCount = 0;
    for (const chore of choresToPrune) {
      await knex('chores').where('id', chore.id).del();
      console.log(`Pruned chore ID ${chore.id}: "${chore.title}"`);
      prunedChoreCount++;
    }
    results = {
      ...results,
      prunedChoresCount: prunedChoreCount,
      prunedChores: choresToPrune,
    }

    // bonus chores that persist from day to day should reset to unassigned
    const choresToReset = await knex('chore_schedules as cs')
      .join('chores as c', 'cs.chore_id', 'c.id')
      .select('cs.id', 'cs.user_id', 'c.title')
      .whereNull('cs.crontab')
      .where('cs.visible', 1)
      .whereNotNull('cs.user_id')
      .where('c.clam_value', '>', 0);
    console.log(`Found ${choresToReset.length} bonus chores to reset`);
    let resetScheduleCount = 0;
    for (const schedule of choresToReset) {
      await knex('chore_schedules').where('id', schedule.id).update({ user_id: null });
      console.log(`Reset schedule ID ${schedule.id}: "${schedule.title}" (user_id: ${schedule.user_id})`);
      resetScheduleCount++;
    }
    results = {
      ...results,
      resetSchedulesCount: resetScheduleCount,
      resetSchedules: choresToReset,
    }


    // Handle sticky schedules: create one-time children for until-completed and once-completed parents that trigger today.
    const stickyParentSchedules = await knex('chore_schedules as cs')
      .select(
        'cs.id', 'cs.chore_id', 'cs.user_id', 'cs.crontab', 'cs.duration', 'cs.interval',
        'cs.created_at', 'cs.due_date', 'cs.due_time', 'cs.sound_enabled', 'cs.sound',
        'cs.reminder_interval_minutes'
      )
      .whereNotNull('cs.crontab')
      .whereIn('cs.duration', ['until-completed', 'once-completed'])
      .where('cs.visible', 1)
      .whereNotExists(
        knex('chore_schedules as child')
          .select(knex.raw('1'))
          .whereNull('child.crontab')
          .where('child.visible', 1)
          .where((builder) => {
            builder
              .whereRaw('child.parent_schedule_id = cs.id')
              .orWhere((inner) => {
                inner
                  .whereNull('child.parent_schedule_id')
                  .whereRaw('child.chore_id = cs.chore_id')
                  .where((owner) => {
                    owner
                      .whereRaw('child.user_id = cs.user_id')
                      .orWhereRaw('(child.user_id IS NULL AND cs.user_id IS NULL)');
                  });
              });
          })
      );
    console.log(`Found ${stickyParentSchedules.length} sticky schedules to check`);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const justBeforeToday = new Date(startOfToday.getTime() - 1);
    let options = {
      currentDate: justBeforeToday,
      utc: false,
    }
    let stickySchedulesCreated = 0;
    const triggeredSchedules = [];
    for (const schedule of stickyParentSchedules) {
      let next = null;
      try {
        const cronInterval = CronExpressionParser.parse(schedule.crontab, options);
        next = cronInterval.next().toISOString().split('T')[0];
      } catch (parseError) {
        console.warn(`Skipping sticky schedule ${schedule.id} due to invalid crontab: ${schedule.crontab}`);
        continue;
      }

      if (today === next) {
        const dueDateOffset = calculateDateOffsetDays(schedule.created_at, schedule.due_date);
        const childDueDate = dueDateOffset === null
          ? (schedule.due_date || null)
          : addDaysToDateOnly(today, dueDateOffset);

        const [insertedChildId] = await knex('chore_schedules')
          .insert({
            chore_id: schedule.chore_id,
            user_id: schedule.user_id,
            crontab: null,
            duration: 'day-of',
            visible: 1,
            parent_schedule_id: schedule.id,
            due_date: childDueDate,
            due_time: schedule.due_time || null,
            sound_enabled: schedule.sound_enabled ? 1 : 0,
            sound: schedule.sound || null,
            reminder_interval_minutes: schedule.reminder_interval_minutes || null,
          });
        // Read the row back so the response carries every column (including the
        // DB-side defaults), matching the old INSERT ... RETURNING *.
        const scheduleResult = await knex('chore_schedules').where('id', insertedChildId).first();

        triggeredSchedules.push(scheduleResult);
        stickySchedulesCreated++;
      }
    }
    results = {
      ...results,
      triggeredSchedulesCount: stickySchedulesCreated,
      triggeredSchedules: triggeredSchedules,
    }


    console.log(`=== Daily background processing completed ===`);
    console.log(`  - Day-of schedules pruned: ${prunedScheduleCount}`);
    console.log(`  - Orphaned chores deleted: ${prunedChoreCount}`);
    console.log(`  - Bonus chores reset: ${resetScheduleCount}`);
    console.log(`  - Sticky chores triggered: ${stickySchedulesCreated}`);
    console.log(`Total: ${prunedScheduleCount + prunedChoreCount + resetScheduleCount} operations performed`);
    return results;
  } catch (error) {
    console.error('Error during daily background processing:', error);
    throw error;
  }
}

function startNightlyCronJob() {
  cron.schedule('0 0 * * *', async () => {
    console.log('Running daily background processing at midnight');
    await dailyBackgroundProcessing();
  }, {
    timezone: APP_TIMEZONE
  });
  console.log('Daily background processing cron job scheduled for midnight');
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore malformed JSON and fall back.
  }
  return fallback;
}

function parseTabConfigJson(configJson) {
  return parseJsonObject(configJson, {});
}

async function getDeviceUpdateTimeMs(deviceName) {
  const row = await knex('devices').select('updateTime').where('name', deviceName).first();
  if (!row?.updateTime) return null;
  const timestamp = Date.parse(row.updateTime);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sendJsonWithConditionalCache(request, reply, payload, lastModifiedMs = null) {
  const serialized = JSON.stringify(payload);
  const etag = `W/"${crypto.createHash('sha1').update(serialized).digest('hex')}"`;
  reply.header('ETag', etag);

  if (lastModifiedMs) {
    reply.header('Last-Modified', new Date(lastModifiedMs).toUTCString());
  }

  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    return reply.code(304).send();
  }

  // Use ETag validators only. Last-Modified has second-level precision and can
  // incorrectly produce 304 responses when multiple writes happen within a second.

  return reply.send(payload);
}

function normalizeLayoutFields(layout) {
  if (!layout || typeof layout !== 'object') {
    return {
      layout_x: null,
      layout_y: null,
      layout_w: null,
      layout_h: null,
    };
  }

  const normalize = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    layout_x: normalize(layout.layout_x),
    layout_y: normalize(layout.layout_y),
    layout_w: normalize(layout.layout_w),
    layout_h: normalize(layout.layout_h),
  };
}

function buildAssignmentId(tabNumber, widgetName) {
  return `${tabNumber}::${widgetName}`;
}

function parseAssignmentId(assignmentId) {
  if (typeof assignmentId !== 'string') return null;
  const delimiterIndex = assignmentId.indexOf('::');
  if (delimiterIndex <= 0) return null;

  const tabNumberRaw = assignmentId.slice(0, delimiterIndex);
  const widgetName = assignmentId.slice(delimiterIndex + 2);
  const tabNumber = Number.parseInt(tabNumberRaw, 10);
  if (!Number.isFinite(tabNumber) || !widgetName) {
    return null;
  }

  return { tabNumber, widgetName };
}

async function getTabsForDevice(deviceName) {
  return knex('tabs')
    .select('id', 'device_name', 'number', 'label', 'icon', 'show_label', 'created_at', 'config_json')
    .where('device_name', deviceName)
    .orderBy('number', 'asc');
}

async function getTabByNumber(deviceName, tabNumber) {
  return knex('tabs')
    .select('id', 'device_name', 'number', 'label', 'icon', 'show_label', 'created_at', 'config_json')
    .where({ device_name: deviceName, number: tabNumber })
    .first();
}

async function saveTabConfigById(tabId, layoutMap) {
  await knex('tabs').where('id', tabId).update({ config_json: JSON.stringify(layoutMap) });
}

async function listWidgetAssignmentsFromTabLayouts(deviceName) {
  const tabs = await getTabsForDevice(deviceName);
  const rows = [];

  tabs.forEach((tab) => {
    const layoutMap = parseTabConfigJson(tab.config_json);
    Object.entries(layoutMap).forEach(([widgetName, layout]) => {
      const normalized = normalizeLayoutFields(layout);
      rows.push({
        id: buildAssignmentId(tab.number, widgetName),
        device_name: deviceName,
        tab_number: tab.number,
        widget_name: widgetName,
        layout_x: normalized.layout_x,
        layout_y: normalized.layout_y,
        layout_w: normalized.layout_w,
        layout_h: normalized.layout_h,
      });
    });
  });

  return rows;
}

async function ensureHomeTabExists(deviceName, ex = knex) {
  // Insert default home tab if it doesn't exist
  try {
    const homeTab = await ex('tabs').select('id').where({ number: 1, device_name: deviceName }).first();
    if (!homeTab) {
      await ex('tabs').insert({ label: 'Home', icon: 'home', show_label: 1, number: 1, device_name: deviceName, config_json: '{}' });
      console.log('Default home tab created');
    }
  } catch (error) {
    console.error('Error creating default home tab:', error);
  }
}

async function doesDeviceExist(deviceName) {
  const device = await knex('devices').select('name').where('name', deviceName).first();
  return !!device;
}

function buildDefaultHomeTab(deviceName) {
  // region #98 - expected to get removed in the future (legacy empty-tabs API fallback)
  return {
    id: 1,
    device_name: deviceName,
    number: 1,
    label: 'Home',
    icon: 'home',
    show_label: 1,
    created_at: null,
    config_json: '{}',
  };
  // endRegion #98
}

async function ensureDeviceExists(deviceName, ex = knex) {
  await ex('devices').insert({ name: deviceName, updateTime: ex.raw('CURRENT_TIMESTAMP') }).onConflict('name').ignore();
  await ensureHomeTabExists(deviceName, ex);
}
async function touchDeviceUpdateTime(deviceName, ex = knex) {
  await ex('devices').where('name', deviceName).update({ updateTime: ex.raw('CURRENT_TIMESTAMP') });
}

// Devices API Endpoints
fastify.get('/api/devices', async (request, reply) => {
  try {
    const devices = await knex('devices').select('name', 'updateTime').orderBy('updateTime', 'desc');
    return Promise.all(devices.map(async (device) => {
      const tabs = await getTabsForDevice(device.name);
      const widgetCount = tabs.reduce((count, tab) => {
        const layoutMap = parseTabConfigJson(tab.config_json);
        return count + Object.keys(layoutMap).length;
      }, 0);

      return {
        ...device,
        widgets: widgetCount,
      };
    }));
  } catch (error) {
    console.error('Error fetching devices:', error);
    reply.status(500).send({ error: 'Failed to fetch devices' });
  }
});

fastify.get('/api/devices/:deviceName/settings', async (request, reply) => {
  const { deviceName } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }

  try {
    const row = await knex('devices').select('device_settings_json').where('name', deviceName).first();
    const lastModifiedMs = await getDeviceUpdateTimeMs(deviceName);
    if (!row) {
      return sendJsonWithConditionalCache(request, reply, {}, null);
    }

    return sendJsonWithConditionalCache(request, reply, parseJsonObject(row.device_settings_json, {}), lastModifiedMs);
  } catch (error) {
    console.error('Error fetching device settings:', error);
    reply.status(500).send({ error: 'Failed to fetch device settings' });
  }
});

const upsertDeviceSettings = async (request, reply) => {
  const { deviceName } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }

  const incoming = request.body;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return reply.status(400).send({ error: 'Request body must be a JSON object' });
  }

  try {
    await ensureDeviceExists(deviceName);
    const row = await knex('devices').select('device_settings_json').where('name', deviceName).first();
    const existingSettings = parseJsonObject(row?.device_settings_json, {});
    const merged = { ...existingSettings, ...incoming };

    await knex('devices').where('name', deviceName).update({ device_settings_json: JSON.stringify(merged), updateTime: knex.raw('CURRENT_TIMESTAMP') });

    return merged;
  } catch (error) {
    console.error('Error saving device settings:', error);
    reply.status(500).send({ error: 'Failed to save device settings' });
  }
};

fastify.put('/api/devices/:deviceName/settings', upsertDeviceSettings);
fastify.patch('/api/devices/:deviceName/settings', upsertDeviceSettings);


fastify.patch('/api/devices/:deviceName', async (request, reply) => {
  const { deviceName } = request.params;
  const { name: newName } = request.body || {};

  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }

  if (!newName || typeof newName !== 'string' || !newName.trim()) {
    return reply.status(400).send({ error: 'name is required' });
  }

  const trimmedNewName = newName.trim();

  if (trimmedNewName === deviceName) {
    return { success: true, name: trimmedNewName, message: 'Device name unchanged' };
  }

  try {
    const existingDevice = await knex('devices').select('name').where('name', deviceName).first();
    if (!existingDevice) {
      return reply.status(404).send({ error: 'Device not found' });
    }

    const alreadyUsed = await knex('devices').select('name').where('name', trimmedNewName).first();
    if (alreadyUsed) {
      return reply.status(409).send({ error: 'A device with that name already exists' });
    }

    await knex('devices').where('name', deviceName).update({ name: trimmedNewName, updateTime: knex.raw('CURRENT_TIMESTAMP') });
    return { success: true, name: trimmedNewName, message: 'Device name updated successfully' };
  } catch (error) {
    console.error('Error updating device name:', error);
    reply.status(500).send({ error: 'Failed to update device name' });
  }
});

fastify.post('/api/devices/:deviceName/copy-from/:sourceDeviceName', async (request, reply) => {
  const { deviceName, sourceDeviceName } = request.params;

  if (!deviceName || !sourceDeviceName) {
    return reply.status(400).send({ error: 'deviceName and sourceDeviceName are required' });
  }

  if (deviceName === sourceDeviceName) {
    return reply.status(400).send({ error: 'Source and destination devices must be different' });
  }

  try {
    const sourceExists = await knex('devices').select('name').where('name', sourceDeviceName).first();
    if (!sourceExists) {
      return reply.status(404).send({ error: 'Source device not found' });
    }

    await ensureDeviceExists(deviceName);
    const sourceDeviceSettings = await knex('devices').select('device_settings_json').where('name', sourceDeviceName).first();

    await knex.transaction(async (trx) => {
      await trx('tabs').where('device_name', deviceName).del();

      await trx.raw(`
        INSERT INTO tabs (device_name, label, icon, show_label, number, created_at, config_json)
        SELECT ?, label, icon, show_label, number, created_at, COALESCE(config_json, '{}')
        FROM tabs
        WHERE device_name = ?
        ORDER BY number ASC
      `, [deviceName, sourceDeviceName]);

      await trx('devices').where('name', deviceName).update({
        device_settings_json: sourceDeviceSettings?.device_settings_json || '{}',
        updateTime: trx.raw('CURRENT_TIMESTAMP'),
      });

      await ensureHomeTabExists(deviceName, trx);
      await touchDeviceUpdateTime(deviceName, trx);
    });

    return { success: true, message: 'Device tabs and widget settings copied successfully' };
  } catch (error) {
    console.error('Error copying device data:', error);
    reply.status(500).send({ error: 'Failed to copy device data' });
  }
});

fastify.delete('/api/devices/:deviceName', async (request, reply) => {
  const { deviceName } = request.params;

  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }

  try {
    const result = { changes: await Device.query().deleteById(deviceName) };

    if (result.changes === 0) {
      return reply.status(404).send({ error: 'Device not found' });
    }

    return { success: true, message: 'Device deleted successfully' };
  } catch (error) {
    console.error('Error deleting device:', error);
    reply.status(500).send({ error: 'Failed to delete device' });
  }
});

// Chore icons (issue #141) are stored as the literal emoji rather than a name,
// so the client can grow its bank without a migration and an unrecognized value
// still renders. The only rules are "empty means none" and a length cap — a
// single emoji can legitimately be several code points (skin tones, ZWJ
// sequences), so the cap is generous rather than 1.
const CHORE_ICON_MAX_LENGTH = 16;

function normalizeChoreIcon(icon) {
  if (icon === undefined || icon === null) return null;
  const trimmed = String(icon).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, CHORE_ICON_MAX_LENGTH);
}

// Chore routes (updated for new schema)
fastify.get('/api/chores', async (request, reply) => {
  try {
    const rows = await Chore.query();
    return rows;
  } catch (error) {
    console.error('Error fetching chores:', error);
    reply.status(500).send({ error: 'Failed to fetch chores' });
  }
});

fastify.post('/api/chores', async (request, reply) => {
  const { title, description, clam_value, icon } = request.body;
  try {
    // Empty string and undefined both mean "no icon"; store NULL so the widget
    // has a single falsy case to check (issue #141).
    const inserted = await Chore.query().insert({
      title,
      description,
      clam_value: clam_value || 0,
      icon: normalizeChoreIcon(icon),
    });
    return { id: inserted.id, success: true };
  } catch (error) {
    console.error('Error adding chore:', error);
    reply.status(500).send({ error: 'Failed to add chore' });
  }
});

fastify.patch('/api/chores/:id', async (request, reply) => {
  const { id } = request.params;
  const { title, description, clam_value, icon } = request.body;
  try {
    const updated = await Chore.query()
      .patch({ title, description, clam_value, icon: normalizeChoreIcon(icon) })
      .where({ id });
    if (updated === 0) {
      return reply.status(404).send({ error: 'Chore not found' });
    }
    return { success: true };
  } catch (error) {
    console.error('Error updating chore:', error);
    reply.status(500).send({ error: 'Failed to update chore' });
  }
});

fastify.delete('/api/chores/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    // chore_schedules.chore_id has ON DELETE CASCADE (and chore_history.
    // chore_schedule_id ON DELETE SET NULL), so deleting the chore removes its
    // schedules automatically.
    const deleted = await Chore.query().deleteById(id);
    if (deleted === 0) {
      return reply.status(404).send({ error: 'Chore not found' });
    }
    return { success: true, message: 'Chore deleted successfully' };
  } catch (error) {
    console.error('Error deleting chore:', error);
    reply.status(500).send({ error: 'Failed to delete chore' });
  }
});

// Chore Schedules routes
fastify.get('/api/chore-schedules', async (request, reply) => {
  try {
    const { user_id, visible, usage, chore_id } = request.query;
    const query = knex('chore_schedules as cs')
      .join('chores as c', 'cs.chore_id', 'c.id')
      .select('cs.*', 'c.title', 'c.description', 'c.clam_value', 'c.icon');

    if (user_id !== undefined) {
      query.where('cs.user_id', user_id);
    }
    if (visible !== undefined) {
      query.where('cs.visible', visible === 'true' || visible === '1' ? 1 : 0);
    }
    if (usage !== undefined && usage === 'chart') {
      query.where('cs.visible', 1);
      query.whereRaw('(cs.duration IS NULL OR cs.duration NOT IN (?, ?))', ['until-completed', 'once-completed']);
    }
    if (chore_id !== undefined) {
      query.where('cs.chore_id', chore_id);
    }

    return await query;
  } catch (error) {
    console.error('Error fetching chore schedules:', error);
    reply.status(500).send({ error: 'Failed to fetch chore schedules' });
  }
});

fastify.get('/api/chore-schedules/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const row = await knex('chore_schedules as cs')
      .join('chores as c', 'cs.chore_id', 'c.id')
      .select('cs.*', 'c.title', 'c.description', 'c.clam_value')
      .where('cs.id', id)
      .first();
    if (!row) {
      return reply.status(404).send({ error: 'Schedule not found' });
    }
    return row;
  } catch (error) {
    console.error('Error fetching schedule:', error);
    reply.status(500).send({ error: 'Failed to fetch schedule' });
  }
});

fastify.post('/api/chore-schedules', async (request, reply) => {
  const { chore_id, user_id, crontab, duration, visible, interval, parent_schedule_id, due_time, sound, sound_enabled, reminder_interval_minutes, due_date, transferable, can_snooze, snoozed_until } = request.body;
  try {
    if (!chore_id) {
      return reply.status(400).send({ error: 'chore_id is required' });
    }

    const dateFields = validateScheduleDateFields(request.body, reply);
    if (!dateFields) return;
    const { dueTimeResult, dueDateResult, reminderResult } = dateFields;

    const snoozedUntilResult = normalizeSnoozedUntil(snoozed_until);
    if (snoozed_until !== undefined && !snoozedUntilResult.valid) {
      return reply.status(400).send({ error: 'snoozed_until must be a valid date/time' });
    }

    const normalizedDuration = normalizeScheduleDuration(duration);
    if (!ALLOWED_SCHEDULE_DURATIONS.has(normalizedDuration)) {
      return reply.status(400).send({ error: `Invalid duration. Expected one of: ${Array.from(ALLOWED_SCHEDULE_DURATIONS).join(', ')}` });
    }

    const normalizedInterval = normalizeScheduleInterval(interval);
    if (normalizedDuration === 'once-completed') {
      if (!crontab) {
        return reply.status(400).send({ error: 'once-completed schedules require a crontab expression' });
      }
      if (!isValidScheduleInterval(normalizedInterval)) {
        return reply.status(400).send({ error: 'once-completed schedules require a valid interval like 30d, 3w, 2m, or 1y' });
      }
    } else if (normalizedInterval !== null) {
      return reply.status(400).send({ error: 'interval is only allowed for once-completed schedules' });
    }

    if (crontab) {
      try {
        CronExpressionParser.parse(crontab);
      } catch (e) {
        return reply.status(400).send({ error: 'Invalid crontab expression: ' + e.message });
      }
    }

    let normalizedParentScheduleId = null;
    if (parent_schedule_id !== undefined && parent_schedule_id !== null && parent_schedule_id !== '') {
      const parsedParentScheduleId = parseInt(parent_schedule_id, 10);
      if (Number.isNaN(parsedParentScheduleId)) {
        return reply.status(400).send({ error: 'parent_schedule_id must be a number' });
      }
      const parentExists = await ChoreSchedule.query().findById(parsedParentScheduleId);
      if (!parentExists) {
        return reply.status(400).send({ error: 'parent_schedule_id must reference an existing schedule' });
      }
      normalizedParentScheduleId = parsedParentScheduleId;
    }

    const inserted = await ChoreSchedule.query().insert({
      chore_id,
      user_id: user_id || null,
      crontab: crontab || null,
      duration: normalizedDuration,
      visible: visible !== undefined ? visible : 1,
      interval: normalizedDuration === 'once-completed' ? normalizedInterval : null,
      parent_schedule_id: normalizedParentScheduleId,
      due_time: dueTimeResult.value,
      sound: sound || null,
      sound_enabled: sound_enabled ? 1 : 0,
      reminder_interval_minutes: reminderResult.value,
      due_date: dueDateResult.value,
      transferable: transferable !== undefined ? (transferable ? 1 : 0) : 1,
      can_snooze: can_snooze !== undefined ? (can_snooze ? 1 : 0) : 1,
      snoozed_until: snoozedUntilResult.value,
    });
    return { id: inserted.id, success: true };
  } catch (error) {
    console.error('Error adding schedule:', error);
    reply.status(500).send({ error: 'Failed to add schedule' });
  }
});

fastify.post('/api/chore-schedules/bulk', async (request, reply) => {
  const { chore_id, user_ids, crontab, visible, due_time, sound, sound_enabled, reminder_interval_minutes, due_date, transferable, can_snooze } = request.body;
  try {
    if (!chore_id || !user_ids || !Array.isArray(user_ids)) {
      return reply.status(400).send({ error: 'chore_id and user_ids array are required' });
    }

    const dateFields = validateScheduleDateFields(request.body, reply);
    if (!dateFields) return;
    const { dueTimeResult, dueDateResult, reminderResult } = dateFields;

    if (crontab) {
      try {
        CronExpressionParser.parse(crontab);
      } catch (e) {
        return reply.status(400).send({ error: 'Invalid crontab expression: ' + e.message });
      }
    }

    const ids = [];
    for (const user_id of user_ids) {
      const inserted = await ChoreSchedule.query().insert({
        chore_id,
        user_id,
        crontab: crontab || null,
        visible: visible !== undefined ? visible : 1,
        due_time: dueTimeResult.value,
        sound: sound || null,
        sound_enabled: sound_enabled ? 1 : 0,
        reminder_interval_minutes: reminderResult.value,
        due_date: dueDateResult.value,
        transferable: transferable !== undefined ? (transferable ? 1 : 0) : 1,
        can_snooze: can_snooze !== undefined ? (can_snooze ? 1 : 0) : 1,
      });
      ids.push(inserted.id);
    }

    return { ids, success: true, count: ids.length };
  } catch (error) {
    console.error('Error bulk adding schedules:', error);
    reply.status(500).send({ error: 'Failed to bulk add schedules' });
  }
});

fastify.patch('/api/chore-schedules/:id', async (request, reply) => {
  const { id } = request.params;
  const { chore_id, user_id, crontab, duration, visible, interval, parent_schedule_id, due_time, sound, sound_enabled, reminder_interval_minutes, due_date, transferable, can_snooze, snoozed_until, revoke_daily_bonus, transfer_bonus_clams } = request.body;
  try {
    const dueTimeResult = normalizeDueTime(due_time);
    if (due_time !== undefined && !dueTimeResult.valid) {
      return reply.status(400).send({ error: 'due_time must be in HH:MM 24-hour format' });
    }
    const dueDateResult = normalizeDueDate(due_date);
    if (due_date !== undefined && !dueDateResult.valid) {
      return reply.status(400).send({ error: 'due_date must be a valid YYYY-MM-DD date' });
    }
    const snoozedUntilResult = normalizeSnoozedUntil(snoozed_until);
    if (snoozed_until !== undefined && !snoozedUntilResult.valid) {
      return reply.status(400).send({ error: 'snoozed_until must be a valid date/time' });
    }
    let normalizedTransferBonus = null;
    if (transfer_bonus_clams !== undefined) {
      normalizedTransferBonus = parseInt(transfer_bonus_clams, 10);
      if (Number.isNaN(normalizedTransferBonus) || normalizedTransferBonus < 0) {
        return reply.status(400).send({ error: 'transfer_bonus_clams must be a non-negative integer' });
      }
    }
    const reminderResult = normalizeReminderInterval(reminder_interval_minutes);
    if (reminder_interval_minutes !== undefined && !reminderResult.valid) {
      return reply.status(400).send({ error: 'reminder_interval_minutes must be a non-negative integer' });
    }

    if (crontab !== undefined && crontab !== null) {
      try {
        CronExpressionParser.parse(crontab);
      } catch (e) {
        return reply.status(400).send({ error: 'Invalid crontab expression: ' + e.message });
      }
    }

    const existingSchedule = await knex('chore_schedules')
      .select('id', 'user_id', 'crontab', 'duration', 'interval', 'snoozed_until')
      .where('id', id)
      .first();
    if (!existingSchedule) {
      return reply.status(404).send({ error: 'Schedule not found' });
    }

    const nextDuration = normalizeScheduleDuration(duration !== undefined ? duration : existingSchedule.duration);
    if (!ALLOWED_SCHEDULE_DURATIONS.has(nextDuration)) {
      return reply.status(400).send({ error: `Invalid duration. Expected one of: ${Array.from(ALLOWED_SCHEDULE_DURATIONS).join(', ')}` });
    }

    const nextCrontab = crontab !== undefined ? (crontab || null) : existingSchedule.crontab;
    const nextInterval = normalizeScheduleInterval(interval !== undefined ? interval : existingSchedule.interval);
    if (nextDuration === 'once-completed') {
      if (!nextCrontab) {
        return reply.status(400).send({ error: 'once-completed schedules require a crontab expression' });
      }
      if (!isValidScheduleInterval(nextInterval)) {
        return reply.status(400).send({ error: 'once-completed schedules require a valid interval like 30d, 3w, 2m, or 1y' });
      }
    } else if (interval !== undefined && nextInterval !== null) {
      return reply.status(400).send({ error: 'interval is only allowed for once-completed schedules' });
    }

    const patch = {};

    if (chore_id !== undefined) { patch.chore_id = chore_id; }
    if (user_id !== undefined) { patch.user_id = user_id || null; }
    if (crontab !== undefined) { patch.crontab = crontab || null; }
    if (duration !== undefined) { patch.duration = nextDuration; }
    if (interval !== undefined || duration !== undefined) {
      patch.interval = nextDuration === 'once-completed' ? nextInterval : null;
    }
    if (parent_schedule_id !== undefined) {
      if (parent_schedule_id === null || parent_schedule_id === '') {
        patch.parent_schedule_id = null;
      } else {
        const parsedParentScheduleId = parseInt(parent_schedule_id, 10);
        if (Number.isNaN(parsedParentScheduleId)) {
          return reply.status(400).send({ error: 'parent_schedule_id must be a number' });
        }
        if (parsedParentScheduleId === parseInt(id, 10)) {
          return reply.status(400).send({ error: 'A schedule cannot reference itself as parent_schedule_id' });
        }
        const parentExists = await ChoreSchedule.query().findById(parsedParentScheduleId);
        if (!parentExists) {
          return reply.status(400).send({ error: 'parent_schedule_id must reference an existing schedule' });
        }
        patch.parent_schedule_id = parsedParentScheduleId;
      }
    }
    if (visible !== undefined) { patch.visible = visible ? 1 : 0; }
    if (due_time !== undefined) { patch.due_time = dueTimeResult.value; }
    if (sound !== undefined) { patch.sound = sound || null; }
    if (sound_enabled !== undefined) { patch.sound_enabled = sound_enabled ? 1 : 0; }
    if (reminder_interval_minutes !== undefined) { patch.reminder_interval_minutes = reminderResult.value; }
    if (due_date !== undefined) { patch.due_date = dueDateResult.value; }
    if (transferable !== undefined) { patch.transferable = transferable ? 1 : 0; }
    if (can_snooze !== undefined) { patch.can_snooze = can_snooze ? 1 : 0; }
    if (snoozed_until !== undefined) { patch.snoozed_until = snoozedUntilResult.value; }
    if (transfer_bonus_clams !== undefined) { patch.transfer_bonus_clams = normalizedTransferBonus; }

    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    const updated = await ChoreSchedule.query().patch(patch).where({ id });

    if (updated === 0) {
      return reply.status(404).send({ error: 'Schedule not found' });
    }

    // When a chore is reassigned to a different person, re-check the daily "all
    // regular chores done" bonus for both the previous and new owner. Losing a
    // chore can make someone newly all-done, so this awards the bonus they've
    // earned. By default no one loses points on a move; the transfer dialog can
    // explicitly send `revoke_daily_bonus` (the parent's "revoke current reward
    // and assign" choice, issue #122) to take back the receiver's already-earned
    // daily bonus. The alternative "keep reward" choice persists
    // `transfer_bonus_clams` (threaded above), paid out when the moved chore is
    // completed.
    if (user_id !== undefined) {
      const previousUserId = existingSchedule.user_id;
      const nextUserId = user_id || null;
      if (previousUserId !== nextUserId) {
        const today = getTodayLocalDateString();
        if (previousUserId) {
          await awardDailyRegularBonusIfDue(previousUserId, today);
        }
        if (nextUserId) {
          if (revoke_daily_bonus === true) {
            await revokeDailyRegularBonus(nextUserId, today);
          }
          // Revoke-then-award is idempotent: if the receiver's due set is
          // somehow still complete, the bonus is immediately re-awarded.
          await awardDailyRegularBonusIfDue(nextUserId, today);
        }
      }
    }

    // Snoozing defers a chore out of today's required set — if that was the
    // assignee's last open chore, their day is now complete. Award-only:
    // un-snoozing never takes points back.
    if (snoozed_until !== undefined) {
      const assigneeId = user_id !== undefined ? (user_id || null) : existingSchedule.user_id;
      if (assigneeId) {
        await awardDailyRegularBonusIfDue(assigneeId, getTodayLocalDateString());
      }
    }

    return { success: true };
  } catch (error) {
    console.error('Error updating schedule:', error);
    reply.status(500).send({ error: 'Failed to update schedule' });
  }
});

fastify.delete('/api/chore-schedules/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const deleted = await ChoreSchedule.query().deleteById(id);
    if (deleted === 0) {
      return reply.status(404).send({ error: 'Schedule not found' });
    }
    return { success: true, message: 'Schedule deleted successfully' };
  } catch (error) {
    console.error('Error deleting schedule:', error);
    reply.status(500).send({ error: 'Failed to delete schedule' });
  }
});

// Chore History routes
fastify.get('/api/chore-history', async (request, reply) => {
  try {
    const { user_id, date, date_from, date_to } = request.query;
    const query = knex('chore_history');

    if (user_id !== undefined) query.where('user_id', user_id);
    if (date) query.where('date', date);
    if (date_from) query.where('date', '>=', date_from);
    if (date_to) query.where('date', '<=', date_to);

    query.orderBy([{ column: 'date', order: 'desc' }, { column: 'created_at', order: 'desc' }]);

    return await query;
  } catch (error) {
    console.error('Error fetching chore history:', error);
    reply.status(500).send({ error: 'Failed to fetch chore history' });
  }
});

fastify.get('/api/chore-history/user/:userId', async (request, reply) => {
  const { userId } = request.params;
  try {
    const rows = await knex('chore_history')
      .where('user_id', userId)
      .orderBy([{ column: 'date', order: 'desc' }, { column: 'created_at', order: 'desc' }]);
    return rows;
  } catch (error) {
    console.error('Error fetching user history:', error);
    reply.status(500).send({ error: 'Failed to fetch user history' });
  }
});

fastify.get('/api/chore-history/summary/:userId', async (request, reply) => {
  const { userId } = request.params;
  try {
    const total = await getUserClamTotal(userId);
    return { user_id: parseInt(userId), clam_total: total };
  } catch (error) {
    console.error('Error getting clam summary:', error);
    reply.status(500).send({ error: 'Failed to get clam summary' });
  }
});

const CHORE_HISTORY_KINDS = new Set(['completion', 'daily_bonus', 'transfer_bonus', 'adjustment', 'missed', 'spent']);

fastify.post('/api/chore-history', async (request, reply) => {
  const { user_id, chore_schedule_id, date, clam_value, kind } = request.body;
  try {
    if (!user_id || !date) {
      return reply.status(400).send({ error: 'user_id and date are required' });
    }
    if (kind !== undefined && !CHORE_HISTORY_KINDS.has(kind)) {
      return reply.status(400).send({ error: `kind must be one of: ${[...CHORE_HISTORY_KINDS].join(', ')}` });
    }
    const rowKind = kind || (chore_schedule_id ? 'completion' : 'adjustment');

    const inserted = await ChoreHistory.query().insert({
      user_id,
      chore_schedule_id: chore_schedule_id || null,
      date,
      clam_value: clam_value || 0,
      kind: rowKind,
    });
    return { id: inserted.id, success: true };
  } catch (error) {
    console.error('Error adding history entry:', error);
    reply.status(500).send({ error: 'Failed to add history entry' });
  }
});

fastify.get('/api/chore-history/recent', async (request, reply) => {
  try {
    const days = parseInt(request.query.days || '7', 10);
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;
    const rows = await knex('chore_history as ch')
      .leftJoin('users as u', 'ch.user_id', 'u.id')
      .select('ch.id', 'ch.date', 'ch.clam_value', 'ch.title', 'ch.kind', 'ch.created_at', 'u.username')
      .where('ch.date', '>=', sinceStr)
      .whereNot('ch.clam_value', 0)
      .orderBy([{ column: 'ch.date', order: 'desc' }, { column: 'ch.created_at', order: 'desc' }]);
    return rows;
  } catch (error) {
    console.error('Error fetching recent chore history:', error);
    reply.status(500).send({ error: 'Failed to fetch recent chore history' });
  }
});

fastify.delete('/api/chore-history/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const deleted = await ChoreHistory.query().deleteById(id);
    if (deleted === 0) {
      return reply.status(404).send({ error: 'History entry not found' });
    }
    return { success: true, message: 'History entry deleted successfully' };
  } catch (error) {
    console.error('Error deleting history entry:', error);
    reply.status(500).send({ error: 'Failed to delete history entry' });
  }
});

// Household vacation state (issues #121/#72): written by the Admin Panel's
// vacation-mode save as the `vacation_mode` settings key —
// { enabled, startDate, endDate } ('YYYY-MM-DD', empty = unbounded). While
// active, the nightly job skips missed-chore logging so days off never count
// against completion rates, and the metrics plugin bridges streaks across
// those days.
async function isVacationActiveOn(dateStr) {
  try {
    const row = await knex('settings').select('value').where('key', 'vacation_mode').first();
    if (!row || !row.value) return false;
    const vacation = JSON.parse(row.value);
    if (!vacation || vacation.enabled !== true) return false;
    if (vacation.startDate && dateStr < vacation.startDate) return false;
    if (vacation.endDate && dateStr > vacation.endDate) return false;
    return true;
  } catch {
    return false;
  }
}

// Returns the list of a user's regular (non-bonus) chore schedules that were
// due on `dateStr` ('YYYY-MM-DD' local). `referenceNow` anchors the snooze
// check: the award path uses real now (default); the nightly missed logger
// passes end-of-that-day so "snoozed through the day" excludes the chore
// (issue #72).
async function getTodaysRegularChoresForUser(userId, dateStr, referenceNow = new Date()) {
  const allUserSchedules = await knex('chore_schedules as cs')
    .join('chores as c', 'cs.chore_id', 'c.id')
    .select(
      'cs.*',
      'c.clam_value',
      'c.title',
      knex.raw(
        `EXISTS (
         SELECT 1
         FROM chore_history ch
         WHERE ch.chore_schedule_id = cs.id
           AND ch.user_id = cs.user_id
           AND ch.date = ?
           AND ch.kind = 'completion'
     ) AS completed_today`,
        [dateStr]
      )
    )
    .where('cs.user_id', userId)
    .where('cs.visible', 1)
    .whereRaw("NOT (cs.crontab IS NOT NULL AND cs.duration IN ('until-completed', 'once-completed'))");

  const regularChores = allUserSchedules
    .filter(s => s.clam_value === 0)
    // Snoozed chores are deferred: hidden from the dashboard and neither
    // required for nor counted toward the daily completion bonus.
    .filter(s => !s.snoozed_until || new Date(s.snoozed_until) <= referenceNow);

  // Anchor the cron replay to the target date, not the wall clock, so the
  // helper works for past dates too. For today this is byte-identical to the
  // old new Date()-based anchor.
  const startOfDay = parseDateOnlyToLocalDate(dateStr) || new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const justBeforeDay = new Date(startOfDay.getTime() - 1);
  const options = { currentDate: justBeforeDay, utc: false };

  const todaysChores = [];
  for (const schedule of regularChores) {
    // schedules without crontab are one-time and always part of today's chores
    if (!schedule.crontab) {
      todaysChores.push(schedule);
      continue;
    }

    // ensure only chores that are due today are part of today's chores
    const interval = CronExpressionParser.parse(schedule.crontab, options);
    const next = interval.next().toISOString().split('T')[0];
    if (dateStr === next) {
      todaysChores.push(schedule);
    }
  }

  return todaysChores;
}

// Awards the daily "all regular chores completed" bonus to a user if every regular
// chore due today is completed and the bonus hasn't already been recorded.
// Never removes points; safe to call any time a user's chore set changes (e.g. reassignment).
async function awardDailyRegularBonusIfDue(userId, date) {
  const today = getTodayLocalDateString();
  const todaysChores = await getTodaysRegularChoresForUser(userId, today);
  const uncompletedRegularChores = todaysChores.filter(cs => cs.completed_today == 0);

  if (!todaysChores.length || uncompletedRegularChores.length) {
    return;
  }

  const dailyRewardSetting = await knex('settings').select('value').where('key', 'daily_completion_clam_reward').first();
  const dailyReward = dailyRewardSetting ? parseInt(dailyRewardSetting.value, 10) : 2;

  // kind-based lookup (issue #72): unlike the old (clam_value = current
  // setting) tuple, this still matches bonuses awarded under an older reward.
  const bonusAlreadyAwarded = await knex('chore_history')
    .select('id')
    .where({ user_id: userId, date, kind: 'daily_bonus' })
    .first();

  if (!bonusAlreadyAwarded) {
    await knex('chore_history').insert({
      user_id: userId,
      chore_schedule_id: null,
      date,
      clam_value: dailyReward,
      title: 'Regular chores',
      kind: 'daily_bonus',
    });

    // This is the one moment "everything on today's list is done" becomes true
    // for a user, and every route that can finish someone's day funnels through
    // here — completing a chore, receiving a transfer, or snoozing the last one
    // out of today. Emitting from inside the not-already-awarded branch gives
    // the celebration the same once-per-day semantics as the bonus itself
    // (issue #140).
    //
    // The event is emitted regardless of whether any display is configured to
    // celebrate: it is a factual domain signal that plugins may want, and the
    // CHORE_CELEBRATION_ENABLED setting is a presentation preference applied
    // client-side, exactly as CHORE_SOUND_ENABLED gates playback rather than data.
    const user = await knex('users').select('username').where('id', userId).first();
    await emitPluginEvent('chore.allCompleted', {
      userId,
      username: user ? user.username : null,
      date,
      reward: dailyReward,
    });
  }
}

// Deletes the user's daily-completion bonus row for the given date, if present.
// Used when uncompleting a regular chore, and by the transfer dialog's explicit
// "revoke current reward and assign" option (issue #122).
async function revokeDailyRegularBonus(userId, date) {
  const bonusEntry = await knex('chore_history')
    .select('id')
    .where({ user_id: userId, date, kind: 'daily_bonus' })
    .first();

  if (bonusEntry) {
    await knex('chore_history').where('id', bonusEntry.id).del();
  }
}

// Chore completion endpoints
fastify.post('/api/chores/complete', async (request, reply) => {
  const { chore_schedule_id, user_id, date } = request.body;
  try {
    if (!chore_schedule_id || !user_id || !date) {
      return reply.status(400).send({ error: 'chore_schedule_id, user_id, and date are required' });
    }

    const schedule = await knex('chore_schedules as cs')
      .join('chores as c', 'cs.chore_id', 'c.id')
      .select('cs.*', 'c.clam_value', 'c.title')
      .where('cs.id', chore_schedule_id)
      .first();
    if (!schedule) {
      return reply.status(404).send({ error: 'Schedule not found' });
    }

    if (!schedule.visible) {
      return reply.status(400).send({ error: 'Schedule is not visible' });
    }

    // A 'missed' row must not block completion (retroactive catch-up is
    // legitimate); it is replaced by the completion below (issue #72).
    const existing = await knex('chore_history')
      .select('id')
      .where({ chore_schedule_id, user_id, date })
      .whereNot('kind', 'missed')
      .first();
    if (existing) {
      return reply.status(409).send({ error: 'Chore already completed for this date' });
    }

    await knex('chore_history').where({ chore_schedule_id, user_id, date, kind: 'missed' }).del();
    await knex('chore_history').insert({
      user_id,
      chore_schedule_id,
      date,
      clam_value: schedule.clam_value,
      title: schedule.title,
      kind: 'completion',
    });

    // Pay out a pending transfer bonus (attached by the parent when moving
    // this chore to a kid whose day was already complete) and clear it so it
    // pays only once.
    if (schedule.transfer_bonus_clams > 0) {
      await knex('chore_history').insert({
        user_id,
        chore_schedule_id,
        date,
        clam_value: schedule.transfer_bonus_clams,
        title: 'Transfer bonus',
        kind: 'transfer_bonus',
      });
      await knex('chore_schedules').where('id', chore_schedule_id).update({ transfer_bonus_clams: 0 });
    }

    if (schedule.parent_schedule_id) {
      const parentSchedule = await knex('chore_schedules')
        .select('id', 'duration', 'interval')
        .where('id', schedule.parent_schedule_id)
        .first();
      if (parentSchedule && parentSchedule.duration === 'once-completed') {
        const completionDate = parseDateOnlyToLocalDate(date);
        const nextDueDate = completionDate ? addIntervalToDate(completionDate, parentSchedule.interval) : null;
        const nextCrontab = buildDateCrontab(nextDueDate);

        if (nextCrontab) {
          await knex('chore_schedules').where('id', parentSchedule.id).update({ crontab: nextCrontab, visible: 1 });
        } else {
          console.warn(`Could not reschedule once-completed parent schedule ${parentSchedule.id}; invalid interval: ${parentSchedule.interval}`);
        }
      }
    }

    // Announce this completion before awarding the daily bonus, because the
    // award emits chore.allCompleted. Emitting in the other order would tell a
    // subscriber the day was finished while the chore that finished it had not
    // been announced yet — a plugin counting completions would be one short.
    await emitPluginEvent('chore.completed', {
      userId: user_id,
      choreId: schedule.chore_id,
      scheduleId: chore_schedule_id,
      clamValue: schedule.clam_value,
      date,
    });

    await awardDailyRegularBonusIfDue(user_id, date);

    // Read the total after the award so the response includes the bonus.
    const total = await getUserClamTotal(user_id);

    return { success: true, clam_total: total };
  } catch (error) {
    console.error('Error completing chore:', error);
    reply.status(500).send({ error: 'Failed to complete chore' });
  }
});

fastify.post('/api/chores/uncomplete', async (request, reply) => {
  const { chore_schedule_id, user_id, date } = request.body;
  try {
    if (!chore_schedule_id || !user_id || !date) {
      return reply.status(400).send({ error: 'chore_schedule_id, user_id, and date are required' });
    }

    // kind-based lookup finds the actual completion record, never a transfer
    // payout or a stale missed row (issue #72).
    const history = await knex('chore_history')
      .select('id', 'clam_value')
      .where({ chore_schedule_id, user_id, date, kind: 'completion' })
      .first();
    if (!history) {
      return reply.status(404).send({ error: 'Completion record not found' });
    }

    await knex('chore_history').where('id', history.id).del();

    // If completing this chore paid out a transfer bonus, take the payout back
    // and re-arm it on the schedule so re-completing pays again.
    const transferBonusRow = await knex('chore_history')
      .select('id', 'clam_value')
      .where({ chore_schedule_id, user_id, date, kind: 'transfer_bonus' })
      .first();
    if (transferBonusRow) {
      await knex('chore_history').where('id', transferBonusRow.id).del();
      await knex('chore_schedules').where('id', chore_schedule_id).update({ transfer_bonus_clams: transferBonusRow.clam_value });
    }

    // if the uncompleted chore was a bonus chore (has clam value), don't remove the daily bonus when uncompleting
    if (!history.clam_value) {
      await revokeDailyRegularBonus(user_id, date);
    }

    const total = await getUserClamTotal(user_id);

    // Mirror of chore.completed so plugins (and declarative reactions with a
    // negative factor) can compensate — without this, complete → uncomplete →
    // re-complete double-counts durable reaction effects.
    const uncompletedSchedule = await knex('chore_schedules').select('chore_id').where('id', chore_schedule_id).first();
    await emitPluginEvent('chore.uncompleted', {
      userId: user_id,
      choreId: uncompletedSchedule?.chore_id ?? null,
      scheduleId: chore_schedule_id,
      clamValue: history.clam_value,
      date,
    });

    return { success: true, clam_total: total };
  } catch (error) {
    console.error('Error uncompleting chore:', error);
    reply.status(500).send({ error: 'Failed to uncomplete chore' });
  }
});

// User clam management endpoints
fastify.get('/api/users/:id/clams', async (request, reply) => {
  const { id } = request.params;
  try {
    const total = await getUserClamTotal(id);
    return { user_id: parseInt(id), clam_total: total };
  } catch (error) {
    console.error('Error getting user clams:', error);
    reply.status(500).send({ error: 'Failed to get user clams' });
  }
});

fastify.post('/api/users/:id/clams/add', async (request, reply) => {
  const { id } = request.params;
  const { amount, date } = request.body;
  try {
    if (!amount || amount <= 0) {
      return reply.status(400).send({ error: 'Valid positive amount is required' });
    }

    const useDate = date || getTodayLocalDateString();
    await knex('chore_history').insert({
      user_id: id,
      chore_schedule_id: null,
      date: useDate,
      clam_value: amount,
      title: 'Adjustment',
      kind: 'adjustment',
    });

    const total = await getUserClamTotal(id);
    await emitPluginEvent('clam.deposited', { userId: parseInt(id), amount, newTotal: total });
    return { success: true, clam_total: total };
  } catch (error) {
    console.error('Error adding clams:', error);
    reply.status(500).send({ error: 'Failed to add clams' });
  }
});

fastify.post('/api/users/:id/clams/reduce', async (request, reply) => {
  const { id } = request.params;
  const { amount, kind, title } = request.body;
  try {
    if (!amount || amount <= 0) {
      return reply.status(400).send({ error: 'Valid positive amount is required' });
    }
    // 'spent' = prize redemption / spending (default); 'adjustment' lets the
    // admin clam editor mark corrections distinctly.
    const rowKind = kind === undefined ? 'spent' : kind;
    if (rowKind !== 'spent' && rowKind !== 'adjustment') {
      return reply.status(400).send({ error: "kind must be 'spent' or 'adjustment'" });
    }
    // Optional note recording WHAT was spent on (e.g. "Toy store" from the
    // avatar quick-spend) — lands in the ledger and metrics.
    const trimmedTitle = typeof title === 'string' ? title.trim().slice(0, 120) : '';

    const currentTotal = await getUserClamTotal(id);
    if (currentTotal < amount) {
      return reply.status(400).send({ error: 'Insufficient clams' });
    }

    // Non-destructive spend (issue #72): record a negative ledger row instead
    // of the old FIFO delete/mutate of earned rows. Balances are
    // SUM(clam_value) everywhere, so totals are unchanged — but history no
    // longer shrinks retroactively when clams are spent.
    const useDate = getTodayLocalDateString();
    await knex('chore_history').insert({
      user_id: id,
      chore_schedule_id: null,
      date: useDate,
      clam_value: -amount,
      title: trimmedTitle || (rowKind === 'spent' ? 'Spent' : 'Adjustment'),
      kind: rowKind,
    });

    const total = await getUserClamTotal(id);
    await emitPluginEvent('clam.withdrawn', { userId: parseInt(id), amount, newTotal: total });
    return { success: true, clam_total: total };
  } catch (error) {
    console.error('Error reducing clams:', error);
    reply.status(500).send({ error: 'Failed to reduce clams' });
  }
});


// User routes (updated to calculate clam_total from history)
// Clam balances are derived from chore_history (not stored on the user).
async function getUserClamTotal(userId) {
  const row = await knex('chore_history').where('user_id', userId).sum({ total: 'clam_value' }).first();
  return Number(row && row.total != null ? row.total : 0);
}

fastify.get('/api/users', async (request, reply) => {
  try {
    // Admin-chosen display order (issue #134). Every consumer — the chore
    // widget columns, assignment dropdowns, transfer and split pickers —
    // renders in the order returned here, so this one clause orders them all.
    const users = await knex('users')
      .select('id', 'username', 'email', 'profile_picture', 'sort_order')
      .orderBy([{ column: 'sort_order' }, { column: 'id' }]);

    const usersWithClams = await Promise.all(
      users.map(async (user) => ({
        id: user.id,
        username: user.username,
        email: user.email,
        profile_picture: user.profile_picture,
        clam_total: await getUserClamTotal(user.id),
      }))
    );

    return usersWithClams;
  } catch (error) {
    console.error('Error fetching users:', error);
    reply.status(500).send({ error: 'Failed to fetch users' });
  }
});

fastify.post('/api/users', async (request, reply) => {
  const { username, email, profile_picture } = request.body;
  try {
    // New users land at the end of the display order.
    const maxOrder = await knex('users').max({ max: 'sort_order' }).first();
    const inserted = await User.query().insert({
      username,
      email,
      profile_picture,
      sort_order: (maxOrder?.max ?? 0) + 1,
    });
    return { id: inserted.id };
  } catch (error) {
    console.error('Error adding user:', error);
    reply.status(500).send({ error: 'Failed to add user' });
  }
});

// Set the display order (issue #134). The client sends the full desired order
// and the server just persists it — same contract as the tab reorder endpoint.
// Registered before /api/users/:id; find-my-way matches the static path first.
fastify.patch('/api/users/reorder', async (request, reply) => {
  const { orderedUserIds } = request.body || {};
  try {
    if (!Array.isArray(orderedUserIds) || orderedUserIds.some((id) => !Number.isInteger(id))) {
      return reply.status(400).send({ error: 'orderedUserIds must be an array of user ids' });
    }

    // The bonus pseudo-user (id 0) never renders on the dashboard and keeps
    // sort_order 0, so it stays pinned first and is not reorderable.
    const reorderable = (await knex('users').select('id').whereNot('id', 0)).map((row) => row.id);
    const unique = new Set(orderedUserIds);
    const coversEveryUser = unique.size === orderedUserIds.length
      && orderedUserIds.length === reorderable.length
      && reorderable.every((id) => unique.has(id));
    if (!coversEveryUser) {
      return reply.status(400).send({ error: 'orderedUserIds must list every reorderable user exactly once' });
    }

    // Dense 1..n keeps bonus (0) first; no UNIQUE constraint here, so unlike
    // the tab reorder this needs no temporary-value pass.
    await knex.transaction(async (trx) => {
      for (let index = 0; index < orderedUserIds.length; index++) {
        await trx('users').where('id', orderedUserIds[index]).update({ sort_order: index + 1 });
      }
    });

    return { success: true, orderedUserIds };
  } catch (error) {
    console.error('Error reordering users:', error);
    reply.status(500).send({ error: 'Failed to reorder users' });
  }
});

// NEW: Endpoint to update user profile
fastify.patch('/api/users/:id', async (request, reply) => {
  const { id } = request.params;
  const { username, email, profile_picture } = request.body;
  try {
    const updated = await User.query().patch({ username, email, profile_picture }).where({ id });
    if (updated === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }
    return { success: true, message: 'User updated successfully' };
  } catch (error) {
    console.error('Error updating user:', error);
    reply.status(500).send({ error: 'Failed to update user' });
  }
});

// Default avatar bank (issue #132): bundled art users can pick instead of
// uploading a photo. Listed in a stable, curated order — people first
// (each in five skin tones), then the fun ones.
const DEFAULT_AVATAR_ORDER = ['mom', 'dad', 'girl', 'boy', 'cat', 'dog', 'fish', 'alpaca', 'chicken', 'dino', 'robot', 'unicorn', 'frog'];

fastify.get('/api/avatars/defaults', async (request, reply) => {
  try {
    let files = [];
    try {
      files = fsSync.readdirSync(AVATARS_UPLOAD_DIR).filter((f) => f.endsWith('.svg'));
    } catch {
      files = [];
    }
    const rank = (f) => {
      const base = f.replace(/\.svg$/, '');
      const prefix = base.replace(/-\d+$/, '');
      const idx = DEFAULT_AVATAR_ORDER.indexOf(prefix);
      return [idx === -1 ? DEFAULT_AVATAR_ORDER.length : idx, base];
    };
    files.sort((a, b) => {
      const [ra, na] = rank(a);
      const [rb, nb] = rank(b);
      return ra - rb || na.localeCompare(nb);
    });
    // profile_picture values are relative to /Uploads/users/, so the stored
    // filename for a default is "defaults/<file>".
    return files.map((f) => ({
      filename: `defaults/${f}`,
      name: f.replace(/\.svg$/, '').replace(/-\d+$/, '').replace(/^./, (c) => c.toUpperCase()),
    }));
  } catch (error) {
    console.error('Error listing default avatars:', error);
    reply.status(500).send({ error: 'Failed to list default avatars' });
  }
});

// Select a default avatar as a user's profile picture. Unlike photo uploads
// this is safe to allow in demo mode.
fastify.post('/api/users/:id/avatar', async (request, reply) => {
  const { id } = request.params;
  const { filename } = request.body || {};
  try {
    if (typeof filename !== 'string' || !/^defaults\/[a-z0-9-]+\.svg$/.test(filename)) {
      return reply.status(400).send({ error: 'filename must be a default avatar (defaults/<name>.svg)' });
    }
    const base = filename.slice('defaults/'.length);
    if (!fsSync.existsSync(path.join(AVATARS_UPLOAD_DIR, base))) {
      return reply.status(404).send({ error: 'Unknown default avatar' });
    }
    const updated = await User.query().patch({ profile_picture: filename }).where({ id });
    if (updated === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }
    return { success: true, filename };
  } catch (error) {
    console.error('Error setting default avatar:', error);
    reply.status(500).send({ error: 'Failed to set avatar' });
  }
});

// NEW: Endpoint to upload user profile picture
fastify.post('/api/users/:id/upload-picture', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    const { id } = request.params;
    console.log(`Upload picture request for user ${id}`);

    const data = await request.file();

    if (!data) {
      console.log('No file uploaded');
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    console.log('File received:', data.filename, 'Type:', data.mimetype);

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(data.mimetype)) {
      console.log('Invalid file type:', data.mimetype);
      return reply.status(400).send({ error: 'Only image files (JPEG, PNG, GIF) are allowed' });
    }

    // Create users directory if it doesn't exist
    const usersDir = path.join(__dirname, 'uploads', 'users');
    await fs.mkdir(usersDir, { recursive: true });

    // Generate unique filename
    const fileExtension = data.filename.split('.').pop();
    const filename = `user_${id}_${Date.now()}.${fileExtension}`;
    const filepath = path.join(usersDir, filename);

    console.log('Saving file to:', filepath);

    // Save file
    await fs.writeFile(filepath, await data.toBuffer());
    console.log('File saved successfully');

    // Update user record
    const updated = await User.query().findById(id).patch({ profile_picture: filename });

    if (updated === 0) {
      // Clean up uploaded file if user doesn't exist
      await fs.unlink(filepath);
      console.log('User not found, file deleted');
      return reply.status(404).send({ error: 'User not found' });
    }

    console.log('Profile picture uploaded successfully:', filename);

    return {
      success: true,
      message: 'Profile picture uploaded successfully',
      filename: filename
    };
  } catch (error) {
    console.error('Error uploading profile picture:', error);
    reply.status(500).send({ error: 'Failed to upload profile picture' });
  }
});

// Endpoint to delete a user
fastify.delete('/api/users/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const deleted = await User.query().deleteById(id);
    if (deleted === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }
    return { success: true, message: 'User deleted successfully' };
  } catch (error) {
    console.error('Error deleting user:', error);
    reply.status(500).send({ error: 'Failed to delete user' });
  }
});


// Calendar routes (existing)
fastify.get('/api/calendar', async (request, reply) => {
  try {
    const rows = await Event.query();
    return rows;
  } catch (error) {
    console.error('Error fetching events:', error);
    reply.status(500).send({ error: 'Failed to fetch events' });
  }
});

fastify.post('/api/calendar', async (request, reply) => {
  const { user_id, summary, start, end, description } = request.body;
  try {
    const inserted = await Event.query().insert({ user_id, summary, start, end, description });
    return { id: inserted.id };
  } catch (error) {
    console.error('Error adding event:', error);
    reply.status(500).send({ error: 'Failed to add event' });
  }
});

fastify.get('/api/calendar/ics', async (request, reply) => {
  try {
    const rows = await Event.query();
    const calendar = ical({ name: 'HomeGlow Calendar' });
    rows.forEach((event) => {
      calendar.createEvent({
        start: new Date(event.start),
        end: new Date(event.end),
        summary: event.summary,
        description: event.description,
      });
    });
    reply.header('Content-Type', 'text/calendar');
    return calendar.toString();
  } catch (error) {
    console.error('Error generating iCalendar:', error);
    reply.status(500).send('Failed to generate iCalendar');
  }
});

fastify.get('/api/timezone', async (request, reply) => {
  return reply.send({ timezone: APP_TIMEZONE });
});

// Demo-mode status for the client (banner, first-run seeding, PIN skip).
fastify.get('/api/demo', async () => {
  return { demo: DEMO_MODE, resetHours: DEMO_MODE ? DEMO_RESET_HOURS : null };
});

// Weather (issue #57). The provider — OpenWeatherMap, Home Assistant, or the
// demo snapshot — is chosen server-side, so credentials never reach a browser
// and one upstream call serves every display in the house.
fastify.get('/api/weather', async (request, reply) => {
  try {
    const { location, lat, lon, units, lang, refresh } = request.query || {};
    const payload = await weatherService.getWeather({
      locationQuery: location,
      lat: lat === undefined ? undefined : Number(lat),
      lon: lon === undefined ? undefined : Number(lon),
      units: units === 'metric' ? 'metric' : 'imperial',
      lang: String(lang || 'en').split('-')[0],
      demoMode: DEMO_MODE,
      forceRefresh: refresh === '1' || refresh === 'true',
    });
    return payload;
  } catch (error) {
    // Provider errors already carry a status (401 bad credentials, 404 unknown
    // location, 503 unreachable); anything else is ours.
    const status = Number.isInteger(error.status) ? error.status : 500;
    console.error('Error fetching weather:', error.message);
    return reply.status(status).send({ error: error.message || 'Failed to fetch weather.' });
  }
});

// Resolve a free-text location to coordinates. Used by the weather widget's
// settings dialog and by auto dark mode, both of which used to call
// OpenWeatherMap's geocoder from the browser with the raw API key.
fastify.get('/api/weather/geocode', async (request, reply) => {
  try {
    const query = String(request.query?.q || '').trim();

    // With no query, report the provider's own location where it has one. A
    // Home Assistant household already told HA where it lives, so auto dark
    // mode should not need a second answer — or an OpenWeatherMap key.
    if (!query) {
      if ((await weatherService.getConfiguredProvider()) === weatherService.PROVIDERS.HOMEASSISTANT
        && (await homeAssistant.isConfigured())) {
        const config = await homeAssistant.homeAssistantFetch('GET', '/api/config');
        if (Number.isFinite(config?.latitude) && Number.isFinite(config?.longitude)) {
          return {
            lat: config.latitude,
            lon: config.longitude,
            resolvedName: config.location_name || '',
          };
        }
      }
      return reply.status(400).send({ error: 'A location query is required.' });
    }

    const apiKey = (await knex('settings').select('value').where('key', 'WEATHER_API_KEY').first())?.value;
    if (!apiKey) {
      return reply.status(400).send({
        error: 'Geocoding needs an OpenWeatherMap API key. Save one in the Connections tab, or let Home Assistant supply the location.',
      });
    }

    const openWeatherMap = require('./services/weather/openweathermap');
    const resolved = await openWeatherMap.resolveCoordinates(query, apiKey);
    return { lat: resolved.lat, lon: resolved.lon, resolvedName: resolved.name || '' };
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    console.error('Error geocoding location:', error.message);
    return reply.status(status).send({ error: error.message || 'Failed to resolve location.' });
  }
});

// Sunrise/sunset for auto dark mode. Computed from coordinates rather than
// fetched, so the theme switches on schedule with no weather provider
// configured and no API key held.
fastify.get('/api/sun', async (request, reply) => {
  const lat = Number(request.query?.lat);
  const lon = Number(request.query?.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return reply.status(400).send({ error: 'lat and lon are required.' });
  }

  const times = computeSunTimes(lat, lon);
  return {
    sunrise: times.sunrise,
    sunset: times.sunset,
    alwaysUp: times.alwaysUp,
    alwaysDown: times.alwaysDown,
  };
});

function deserializeSettingValue(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? parsed : value;
  } catch {
    return value;
  }
}

// Settings that must never be serialized to a client. GET /api/settings is
// unauthenticated and returns the whole table, so anything secret has to be
// filtered here rather than merely encrypted at rest — the ciphertext is still
// not something to hand out. Connection state for these lives behind the
// /api/connections/* status routes, which report booleans and previews instead.
const REDACTED_SETTING_KEYS = new Set([
  'GOOGLE_CLIENT_SECRET_ENC',
  homeAssistant.TOKEN_KEY,
  // The OpenWeatherMap key used to be handed to every browser so the widget
  // could call the API itself. Now that weather is fetched server-side, nothing
  // on the client needs it — the Admin Panel shows whether one is stored via
  // GET /api/connections/weather/status and writes a replacement blind.
  'WEATHER_API_KEY',
]);

// Convert an array of {key, value} settings rows into a single {key: value}
// object, deserializing any JSON-encoded values and dropping secrets.
const rowsToSettingsObject = (rows) => rows.reduce((acc, row) => {
  if (REDACTED_SETTING_KEYS.has(row.key)) return acc;
  acc[row.key] = deserializeSettingValue(row.value);
  return acc;
}, {});

// NEW: API Endpoints for Settings (including API keys)
fastify.get('/api/settings', async (request, reply) => {
  try {
    console.log('=== FETCHING SETTINGS ===');
    const rows = await knex('settings').select('key', 'value');
    console.log('Raw settings from database:', rows);
    const settings = rowsToSettingsObject(rows);
    console.log('Processed settings object:', settings);
    return settings;
  } catch (error) {
    console.error('Error fetching settings:', error);
    reply.status(500).send({ error: 'Failed to fetch settings' });
  }
});

fastify.post('/api/settings/search', async (request, reply) => {
  try {
    // coerce the request body to array of strings to search the settings database by key:
    const keys = Array.isArray(request.body) ? request.body : [request.body];

    // accept simple wildcards for partial match via * (e.g. WEATHER_* to match all
    // weather related settings)
    const query = knex('settings').select('key', 'value');
    if (keys.length) {
      query.where((builder) => {
        keys.forEach((key) => builder.orWhere('key', 'like', String(key).replaceAll('*', '%')));
      });
    }
    const rows = await query;
    console.log('Raw settings from database:', rows);
    // rowsToSettingsObject drops REDACTED_SETTING_KEYS, so a wildcard search is
    // not a way around the redaction that GET /api/settings applies.
    const settings = rowsToSettingsObject(rows);
    console.log('Processed settings object:', settings);
    return settings;
  } catch (error) {
    console.error('Error fetching settings:', error);
    reply.status(500).send({ error: 'Failed to fetch settings' });
  }
});

fastify.post('/api/settings', async (request, reply) => {
  const { key, value } = request.body;

  if (!key || value === undefined) {
    return reply.status(400).send({ error: 'Key and value are required.' });
  }
  try {
    // Redacted settings are never sent to the client, so the Admin Panel edits
    // them blind and submits an empty string when the user did not retype one.
    // Treat that as "leave it alone" rather than as "delete it" — otherwise
    // saving any other field on the same form would silently wipe the secret.
    if (REDACTED_SETTING_KEYS.has(key) && String(value).trim() === '') {
      console.log(`Skipping blank write to redacted setting '${key}' (left unchanged).`);
      return { success: true, message: `Setting '${key}' left unchanged.` };
    }

    // Use an upsert to either insert a new setting or update an existing one
    await knex('settings').insert({ key, value }).onConflict('key').merge({ value });

    // Verify the setting was saved
    const verification = await knex('settings').select('key', 'value').where('key', key).first();
    console.log('Verification query result:', verification);

    // Changing the provider or its credentials invalidates anything cached
    // under the old configuration.
    if (key === 'WEATHER_API_KEY' || key === weatherService.PROVIDER_SETTING_KEY) {
      weatherService.clearCache();
    }
    return { success: true, message: `Setting '${key}' saved successfully.` };
  } catch (error) {
    console.error(`Error saving setting '${key}':`, error);
    reply.status(500).send({ error: `Failed to save setting '${key}'` });
  }
});

// Tabs API Endpoints
fastify.get('/api/devices/:deviceName/tabs', async (request, reply) => {
  const { deviceName } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }

  try {
    const tabs = await knex('tabs').where('device_name', deviceName).orderBy('number', 'asc');
    const lastModifiedMs = await getDeviceUpdateTimeMs(deviceName);
    // region #98 - expected to get removed in the future (legacy empty-tabs API fallback)
    if (tabs.length === 0) {
      return sendJsonWithConditionalCache(request, reply, [buildDefaultHomeTab(deviceName)], null);
    }
    // endRegion #98
    return sendJsonWithConditionalCache(request, reply, tabs, lastModifiedMs);
  } catch (error) {
    console.error('Error fetching tabs:', error);
    reply.status(500).send({ error: 'Failed to fetch tabs' });
  }
});

fastify.post('/api/devices/:deviceName/tabs', async (request, reply) => {
  const { deviceName } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }
  await ensureDeviceExists(deviceName);
  const { label, icon, show_label } = request.body;

  if (!label || !icon) {
    return reply.status(400).send({ error: 'Label and icon are required' });
  }

  try {
    const maxRow = await knex('tabs').max({ max: 'number' }).where('device_name', deviceName).first();
    const nextTabNumber = ((maxRow && maxRow.max) || 0) + 1;

    await Tab.query().insert({ device_name: deviceName, label, icon, show_label: show_label ? 1 : 0, number: nextTabNumber, config_json: '{}' });
    const row = await getTabByNumber(deviceName, nextTabNumber);
    await touchDeviceUpdateTime(deviceName);

    return row;
  } catch (error) {
    console.error('Error creating tab:', error);
    reply.status(500).send({ error: 'Failed to create tab' });
  }
});

fastify.patch('/api/devices/:deviceName/tabs/:tabNumber', async (request, reply) => {
  const { deviceName, tabNumber } = request.params;
  const { label, icon, show_label } = request.body;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }
  await ensureDeviceExists(deviceName);
  if (parseInt(tabNumber) === 1) {
    return reply.status(400).send({ error: 'Cannot modify home tab' });
  }

  try {
    const patch = {};
    if (label !== undefined) { patch.label = label; }
    if (icon !== undefined) { patch.icon = icon; }
    if (show_label !== undefined) { patch.show_label = show_label ? 1 : 0; }

    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    await knex('tabs').where({ number: tabNumber, device_name: deviceName }).update(patch);
    const row = await getTabByNumber(deviceName, tabNumber);
    await touchDeviceUpdateTime(deviceName);

    return row;
  } catch (error) {
    console.error('Error updating tab:', error);
    reply.status(500).send({ error: 'Failed to update tab' });
  }
});

fastify.patch('/api/devices/:deviceName/tabs/reorder', async (request, reply) => {
  const { deviceName } = request.params;
  const { orderedTabNumbers } = request.body;

  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }
  await ensureDeviceExists(deviceName);

  if (!Array.isArray(orderedTabNumbers)) {
    return reply.status(400).send({ error: 'orderedTabNumbers array is required' });
  }

  try {
    const nonHomeTabs = await knex('tabs').select('id', 'number').where('device_name', deviceName).whereNot('number', 1).orderBy('number', 'asc');

    if (orderedTabNumbers.length !== nonHomeTabs.length) {
      return reply.status(400).send({ error: 'orderedTabNumbers length does not match current tab count' });
    }

    const existingNumbers = new Set(nonHomeTabs.map(tab => tab.number));
    const requestedNumbers = new Set(orderedTabNumbers);
    if (existingNumbers.size !== requestedNumbers.size) {
      return reply.status(400).send({ error: 'orderedTabNumbers contains duplicates' });
    }
    for (const number of requestedNumbers) {
      if (!existingNumbers.has(number)) {
        return reply.status(400).send({ error: 'orderedTabNumbers contains unknown tab numbers' });
      }
    }

    const tabsByNumber = new Map(nonHomeTabs.map(tab => [tab.number, tab]));
    const orderedTabIds = orderedTabNumbers.map(number => tabsByNumber.get(number).id);

    await knex.transaction(async (trx) => {
      // Move to temporary values to avoid UNIQUE(device_name, number) collisions.
      for (let index = 0; index < orderedTabIds.length; index++) {
        await trx('tabs').where({ id: orderedTabIds[index], device_name: deviceName }).update({ number: -1000 - index });
      }
      for (let index = 0; index < orderedTabIds.length; index++) {
        await trx('tabs').where({ id: orderedTabIds[index], device_name: deviceName }).update({ number: index + 2 });
      }
    });
    await touchDeviceUpdateTime(deviceName);

    const updatedTabs = await knex('tabs').where('device_name', deviceName).orderBy('number', 'asc');
    return updatedTabs;
  } catch (error) {
    console.error('Error reordering tabs:', error);
    reply.status(500).send({ error: 'Failed to reorder tabs' });
  }
});

fastify.delete('/api/devices/:deviceName/tabs/:tabNumber', async (request, reply) => {
  const { deviceName, tabNumber } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }
  await ensureDeviceExists(deviceName);

  if (parseInt(tabNumber) === 1) {
    return reply.status(400).send({ error: 'Cannot delete home tab' });
  }

  try {
    const parsedTabNumber = parseInt(tabNumber, 10);

    const sourceTab = await getTabByNumber(deviceName, parsedTabNumber);
    if (!sourceTab) {
      return reply.status(404).send({ error: 'Tab not found' });
    }

    const homeTab = await getTabByNumber(deviceName, 1);
    const sourceLayoutMap = parseTabConfigJson(sourceTab.config_json);
    const homeLayoutMap = parseTabConfigJson(homeTab?.config_json);
    let homeChanged = false;

    Object.entries(sourceLayoutMap).forEach(([widgetName, layout]) => {
      if (!(widgetName in homeLayoutMap)) {
        homeLayoutMap[widgetName] = normalizeLayoutFields(layout);
        homeChanged = true;
      }
    });

    if (homeTab && homeChanged) {
      await saveTabConfigById(homeTab.id, homeLayoutMap);
    }

    await knex('tabs').where({ number: parsedTabNumber, device_name: deviceName }).del();

    const remainingTabs = await knex('tabs').select('id').where('device_name', deviceName).whereNot('number', 1).orderBy('number', 'asc');

    await knex.transaction(async (trx) => {
      for (let index = 0; index < remainingTabs.length; index++) {
        await trx('tabs').where({ id: remainingTabs[index].id, device_name: deviceName }).update({ number: -2000 - index });
      }
      for (let index = 0; index < remainingTabs.length; index++) {
        await trx('tabs').where({ id: remainingTabs[index].id, device_name: deviceName }).update({ number: index + 2 });
      }
    });
    await touchDeviceUpdateTime(deviceName);

    return { success: true, message: 'Tab deleted successfully' };
  } catch (error) {
    console.error('Error deleting tab:', error);
    reply.status(500).send({ error: 'Failed to delete tab' });
  }
});

// Widget Tab Assignments API Endpoints
fastify.get('/api/devices/:deviceName/widget-assignments', async (request, reply) => {
  const { deviceName } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }
  try {
    const lastModifiedMs = await getDeviceUpdateTimeMs(deviceName);
    return sendJsonWithConditionalCache(request, reply, await listWidgetAssignmentsFromTabLayouts(deviceName), lastModifiedMs);
  } catch (error) {
    console.error('Error fetching widget assignments:', error);
    reply.status(500).send({ error: 'Failed to fetch widget assignments' });
  }
});

fastify.post('/api/devices/:deviceName/widget-assignments', async (request, reply) => {
  const { deviceName } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }
  const { widget_name, tabNumber } = request.body;
  if (!widget_name || !tabNumber) {
    return reply.status(400).send({ error: 'widget_name and tabNumber are required' });
  }

  try {
    await ensureDeviceExists(deviceName);
    const parsedTabNumber = parseInt(tabNumber, 10);
    const tab = await getTabByNumber(deviceName, parsedTabNumber);
    if (!tab) {
      return reply.status(404).send({ error: 'Tab not found' });
    }

    const layoutMap = parseTabConfigJson(tab.config_json);
    const existing = layoutMap[widget_name];

    if (existing) {
      return reply.status(400).send({ error: 'Assignment already exists' });
    }

    layoutMap[widget_name] = {
      layout_x: null,
      layout_y: null,
      layout_w: null,
      layout_h: null,
    };

    await saveTabConfigById(tab.id, layoutMap);
    await touchDeviceUpdateTime(deviceName);

    return {
      id: buildAssignmentId(parsedTabNumber, widget_name),
      device_name: deviceName,
      tab_number: parsedTabNumber,
      widget_name,
      layout_x: null,
      layout_y: null,
      layout_w: null,
      layout_h: null,
    };
  } catch (error) {
    console.error('Error creating widget assignment:', error);
    reply.status(500).send({ error: 'Failed to create widget assignment' });
  }
});

fastify.delete('/api/devices/:deviceName/widget-assignments/:id', async (request, reply) => {
  const { id, deviceName } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }

  try {
    const parsedId = parseAssignmentId(id);
    if (!parsedId) {
      return reply.status(400).send({ error: 'Invalid assignment id' });
    }

    const tab = await getTabByNumber(deviceName, parsedId.tabNumber);
    if (!tab) {
      return reply.status(404).send({ error: 'Assignment not found' });
    }

    const layoutMap = parseTabConfigJson(tab.config_json);
    if (!(parsedId.widgetName in layoutMap)) {
      return reply.status(404).send({ error: 'Assignment not found' });
    }

    delete layoutMap[parsedId.widgetName];
    await saveTabConfigById(tab.id, layoutMap);
    await touchDeviceUpdateTime(deviceName);
    return { success: true, message: 'Assignment deleted successfully' };
  } catch (error) {
    console.error('Error deleting widget assignment:', error);
    reply.status(500).send({ error: 'Failed to delete widget assignment' });
  }
});

fastify.delete('/api/devices/:deviceName/widget-assignments/widget/:widgetName', async (request, reply) => {
  const { widgetName, deviceName } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }

  try {
    const tabs = await getTabsForDevice(deviceName);
    let changed = false;

    for (const tab of tabs) {
      const layoutMap = parseTabConfigJson(tab.config_json);
      if (widgetName in layoutMap) {
        delete layoutMap[widgetName];
        await saveTabConfigById(tab.id, layoutMap);
        changed = true;
      }
    }

    if (changed) {
      await touchDeviceUpdateTime(deviceName);
    }
    return { success: true, message: 'Widget assignments deleted successfully' };
  } catch (error) {
    console.error('Error deleting widget assignments:', error);
    reply.status(500).send({ error: 'Failed to delete widget assignments' });
  }
});

fastify.patch('/api/devices/:deviceName/widget-assignments/layout', async (request, reply) => {
  const { deviceName } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }
  const { widget_name, tabNumber, layout_x, layout_y, layout_w, layout_h, settings } = request.body;
  const hasLayoutUpdates = [layout_x, layout_y, layout_w, layout_h].some((value) => value !== undefined);
  const hasSettingsField = settings !== undefined;

  if (!widget_name || !tabNumber) {
    return reply.status(400).send({ error: 'widget_name and tabNumber are required' });
  }

  if (!hasLayoutUpdates && !hasSettingsField) {
    return reply.status(400).send({ error: 'Request must include layout fields or settings object' });
  }

  if (hasSettingsField && (!settings || typeof settings !== 'object' || Array.isArray(settings))) {
    return reply.status(400).send({ error: 'settings must be a JSON object when provided' });
  }

  try {
    await ensureDeviceExists(deviceName);
    const parsedTabNumber = parseInt(tabNumber, 10);
    const tab = await getTabByNumber(deviceName, parsedTabNumber);
    if (!tab) {
      return reply.status(404).send({ error: 'Assignment not found' });
    }

    const layoutMap = parseTabConfigJson(tab.config_json);
    const existing = layoutMap[widget_name];

    if (!existing) {
      return reply.status(404).send({ error: 'Assignment not found' });
    }

    const normalizedLayout = normalizeLayoutFields({
      layout_x: layout_x ?? existing.layout_x,
      layout_y: layout_y ?? existing.layout_y,
      layout_w: layout_w ?? existing.layout_w,
      layout_h: layout_h ?? existing.layout_h,
    });

    const mergedSettings = settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings
      : {};

    layoutMap[widget_name] = {
      ...existing,
      ...normalizedLayout,
      ...mergedSettings,
    };
    await saveTabConfigById(tab.id, layoutMap);

    await touchDeviceUpdateTime(deviceName);
    return {
      id: buildAssignmentId(parsedTabNumber, widget_name),
      device_name: deviceName,
      tab_number: parsedTabNumber,
      widget_name,
      ...layoutMap[widget_name],
    };
  } catch (error) {
    console.error('Error updating widget layout:', error);
    reply.status(500).send({ error: 'Failed to update widget layout' });
  }
});

fastify.patch('/api/devices/:deviceName/widget-assignments/layout/bulk', async (request, reply) => {
  const { deviceName } = request.params;
  if (!deviceName) {
    return reply.status(400).send({ error: 'deviceName is required' });
  }
  const { layouts } = request.body;
  if (!Array.isArray(layouts) || layouts.length === 0) {
    return reply.status(400).send({ error: 'layouts array is required' });
  }

  try {
    await ensureDeviceExists(deviceName);
    const tabsByNumber = new Map(
      (await getTabsForDevice(deviceName)).map(tab => [tab.number, {
        tab,
        layoutMap: parseTabConfigJson(tab.config_json),
        changed: false,
      }])
    );

    let anyChanged = false;
    for (const item of layouts) {
      const parsedTabNumber = parseInt(item.tabNumber, 10);
      const widgetName = item.widget_name;
      if (!Number.isFinite(parsedTabNumber) || !widgetName) {
        continue;
      }

      const tabEntry = tabsByNumber.get(parsedTabNumber);
      if (!tabEntry) {
        continue;
      }

      if (!(widgetName in tabEntry.layoutMap)) {
        continue;
      }

      const existingLayout = tabEntry.layoutMap[widgetName];
      tabEntry.layoutMap[widgetName] = {
        ...existingLayout,
        ...normalizeLayoutFields({
          layout_x: item.layout_x ?? existingLayout.layout_x,
          layout_y: item.layout_y ?? existingLayout.layout_y,
          layout_w: item.layout_w ?? existingLayout.layout_w,
          layout_h: item.layout_h ?? existingLayout.layout_h,
        }),
      };
      tabEntry.changed = true;
      anyChanged = true;
    }

    for (const tabEntry of tabsByNumber.values()) {
      if (tabEntry.changed) {
        await saveTabConfigById(tabEntry.tab.id, tabEntry.layoutMap);
      }
    }

    if (anyChanged) {
      await touchDeviceUpdateTime(deviceName);
    }

    return { success: true, message: 'Layouts updated successfully' };
  } catch (error) {
    console.error('Error updating widget layouts:', error);
    reply.status(500).send({ error: 'Failed to update widget layouts' });
  }
});

// DEBUG: Specific endpoint to test API key saving
fastify.post('/api/test-api-key', async (request, reply) => {
  const { apiKey } = request.body;
  console.log('=== TESTING API KEY SAVE ===');
  console.log('Received API key:', apiKey);
  console.log('API key type:', typeof apiKey);
  console.log('API key length:', apiKey ? apiKey.length : 'null/undefined');

  try {
    // Test insertion via the ORM
    await Setting.query().insert({ key: 'WEATHER_API_KEY', value: apiKey }).onConflict('key').merge();

    // Verify it was saved
    const verification = await Setting.query().findById('WEATHER_API_KEY');
    console.log('Verification result:', verification);

    return {
      success: true,
      message: 'API key test completed',
      saved: verification
    };
  } catch (error) {
    console.error('Test API key save error:', error);
    return reply.status(500).send({ error: error.message });
  }
});

// NEW: Generic CORS Proxy Endpoint
fastify.get('/api/proxy', async (request, reply) => {
  if (demoBlocked(reply)) return;
  console.log('=== PROXY REQUEST RECEIVED ===');
  console.log('Query params:', request.query);
  console.log('Headers:', request.headers);

  const { targetUrl } = request.query;

  if (!targetUrl) {
    console.log('ERROR: No targetUrl provided');
    return reply.status(400).send({ error: 'targetUrl query parameter is required.' });
  }

  console.log('Target URL requested:', targetUrl);

  let whitelist = [];
  try {
    // Fetch whitelist from DB. It should be a comma-separated string of hostnames.
    const whitelistSetting = await Setting.query().select('value').findById('PROXY_WHITELIST');
    if (whitelistSetting && whitelistSetting.value) {
      whitelist = whitelistSetting.value.split(',').map(domain => domain.trim());
    }
    console.log('Current whitelist:', whitelist);
  } catch (dbError) {
    console.error('Error fetching proxy whitelist from settings:', dbError);
    whitelist = []; // Default to empty for security
  }

  // For immediate use, we'll ensure the calendar API is always allowed.
  // A more robust solution might involve seeding this in the database on startup.
  if (!whitelist.includes('calapi.inadiutorium.cz')) {
    whitelist.push('calapi.inadiutorium.cz');
    console.log('Added calapi.inadiutorium.cz to whitelist');
  }

  try {
    const target = new URL(targetUrl);
    const targetHostname = target.hostname;
    console.log('Target hostname:', targetHostname);

    if (!whitelist.includes(targetHostname)) {
      console.warn(`Proxy request blocked for non-whitelisted domain: ${targetHostname}`);
      return reply.status(403).send({ error: 'Access to this domain is not allowed through the proxy.' });
    }

    console.log(`Proxying request to whitelisted domain: ${targetUrl}`);

    const proxyHttpsAgent = httpsAgentFor(targetUrl);

    // Configure axios for both HTTP and HTTPS
    const axiosConfig = {
      timeout: 15000, // 15 second timeout
      headers: {
        'User-Agent': 'HomeGlow-Proxy/1.0',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate'
      },
      maxRedirects: 5,
      validateStatus: function (status) {
        return status < 500; // Resolve only if the status code is less than 500
      },
      // Certificate policy is decided per request from the target's address
      // class (issue #139). This used to set NODE_TLS_REJECT_UNAUTHORIZED='0',
      // which disabled verification for the whole process — every later Google
      // token exchange included — and never restored it.
      ...(proxyHttpsAgent ? { httpsAgent: proxyHttpsAgent } : {}),
    };

    if (isCertificateVerificationSkipped(targetUrl)) {
      console.log(`Proxy: ${targetHostname} is a private address; accepting a self-signed certificate.`);
    }

    console.log('Making axios request with config:', axiosConfig);
    const response = await axios.get(targetUrl, axiosConfig);
    console.log('Axios response received:', response.status, response.statusText);
    console.log('Response data type:', typeof response.data);
    console.log('Response data preview:', JSON.stringify(response.data).substring(0, 200) + '...');

    // Forward the content type and the data from the external API
    if (response.headers['content-type']) {
      reply.header('Content-Type', response.headers['content-type']);
    }

    // Add CORS headers
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    console.log('Sending successful response');
    return reply.status(response.status).send(response.data);

  } catch (error) {
    console.error('Error in proxy request:', error.message);
    console.error('Full error details:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      syscall: error.syscall,
      address: error.address,
      port: error.port,
      config: error.config ? {
        url: error.config.url,
        method: error.config.method,
        timeout: error.config.timeout
      } : 'No config',
      response: error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      } : 'No response'
    });

    if (error.response) {
      // Forward the error from the target server
      console.log(`Target server responded with ${error.response.status}: ${error.response.statusText}`);
      return reply.status(error.response.status).send({
        error: `Target server error: ${error.response.status} ${error.response.statusText}`,
        details: error.response.data
      });
    } else if (error.code === 'ECONNREFUSED') {
      console.log(`Connection refused to ${error.address}:${error.port}`);
      return reply.status(503).send({
        error: 'Unable to connect to the target server. The server may be down or unreachable.',
        details: `Connection refused to ${error.address}:${error.port}`
      });
    } else if (error.code === 'ENOTFOUND') {
      return reply.status(404).send({ error: 'Target URL not found or unreachable.' });
    } else if (error.code === 'ETIMEDOUT') {
      return reply.status(408).send({ error: 'Request to target URL timed out.' });
    } else if (error.code === 'ECONNRESET') {
      return reply.status(503).send({ error: 'Connection was reset by the target server.' });
    }

    // Handle other errors (e.g., network, invalid URL)
    return reply.status(500).send({
      error: 'Failed to proxy request.',
      details: error.message
    });
  }
});

// Prize routes

// Shared validation for the prize create/update body. Returns { error } on
// failure, or the parsed { name, clam_cost } on success.
const validatePrizeBody = (body) => {
  const { name, clam_cost } = body || {};
  if (!name || !clam_cost || clam_cost <= 0) {
    return { error: 'Prize name and a positive clam cost are required.' };
  }
  return { name, clam_cost };
};

fastify.get('/api/prizes', async (request, reply) => {
  try {
    const rows = await Prize.query();
    return rows;
  } catch (error) {
    console.error('Error fetching prizes:', error);
    reply.status(500).send({ error: 'Failed to fetch prizes' });
  }
});

fastify.post('/api/prizes', async (request, reply) => {
  const { name, clam_cost, error: validationError } = validatePrizeBody(request.body);
  if (validationError) {
    return reply.status(400).send({ error: validationError });
  }
  try {
    const repeatable = request.body.repeatable === true ? 1 : 0;
    const inserted = await Prize.query().insert({ name, clam_cost, repeatable });
    return { id: inserted.id };
  } catch (error) {
    console.error('Error adding prize:', error);
    reply.status(500).send({ error: 'Failed to add prize' });
  }
});

fastify.patch('/api/prizes/:id', async (request, reply) => {
  const { id } = request.params;
  const { name, clam_cost, error: validationError } = validatePrizeBody(request.body);
  if (validationError) {
    return reply.status(400).send({ error: validationError });
  }
  try {
    const repeatable = request.body.repeatable === true ? 1 : (request.body.repeatable === false ? 0 : null);
    const updated = repeatable === null
      ? await Prize.query().patch({ name, clam_cost }).where({ id })
      : await Prize.query().patch({ name, clam_cost, repeatable }).where({ id });
    if (updated === 0) {
      return reply.status(404).send({ error: 'Prize not found' });
    }
    return { success: true, message: 'Prize updated successfully' };
  } catch (error) {
    console.error('Error updating prize:', error);
    reply.status(500).send({ error: 'Failed to update prize' });
  }
});

fastify.delete('/api/prizes/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const deleted = await Prize.query().deleteById(id);
    if (deleted === 0) {
      return reply.status(404).send({ error: 'Prize not found' });
    }
    return { success: true, message: 'Prize deleted successfully' };
  } catch (error) {
    console.error('Error deleting prize:', error);
    reply.status(500).send({ error: 'Failed to delete prize' });
  }
});

// --- Prize store (prize spending mechanism) ---
// `prizes` is the definitions ledger; a prize_offers row is one redeemable
// instance a parent placed in the store — mirroring chores/chore_schedules.
// Request-queue lifecycle: available → requested (kid asks on the kiosk) →
// redeemed (parent approves: clams deducted via a kind='spent' ledger row,
// offer leaves the store — one-time). Decline/cancel returns to available.

// List store offers (everything not yet redeemed), joined with the live prize
// definition and the requesting kid.
fastify.get('/api/prize-offers', async (request, reply) => {
  try {
    const offers = await knex('prize_offers as po')
      .join('prizes as p', 'po.prize_id', 'p.id')
      .leftJoin('users as u', 'po.requested_by', 'u.id')
      .select(
        'po.id', 'po.prize_id', 'po.status', 'po.requested_by', 'po.requested_at', 'po.created_at',
        'po.split_user_ids',
        'p.name', 'p.clam_cost', 'p.repeatable',
        'u.username as requested_by_name'
      )
      .whereNot('po.status', 'redeemed')
      .orderBy([{ column: 'po.created_at', order: 'asc' }, { column: 'po.id', order: 'asc' }]);
    return offers.map((offer) => ({
      ...offer,
      repeatable: offer.repeatable === 1,
      split_user_ids: offer.split_user_ids ? JSON.parse(offer.split_user_ids) : [],
    }));
  } catch (error) {
    console.error('Error listing prize offers:', error);
    reply.status(500).send({ error: 'Failed to list prize offers' });
  }
});

// Parent: place a prize from the ledger into the store.
fastify.post('/api/prize-offers', async (request, reply) => {
  const { prize_id } = request.body;
  try {
    const prize = await Prize.query().select('id').findById(prize_id);
    if (!prize) {
      return reply.status(404).send({ error: 'Prize not found' });
    }
    const inserted = await PrizeOffer.query().insert({ prize_id, status: 'available' });
    return { id: inserted.id, success: true };
  } catch (error) {
    console.error('Error creating prize offer:', error);
    reply.status(500).send({ error: 'Failed to add prize to the store' });
  }
});

// Parent: take an unredeemed offer back out of the store.
fastify.delete('/api/prize-offers/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const deleted = await PrizeOffer.query().delete().where('id', id).whereNot('status', 'redeemed');
    if (deleted === 0) {
      return reply.status(404).send({ error: 'Offer not found (or already redeemed)' });
    }
    return { success: true };
  } catch (error) {
    console.error('Error removing prize offer:', error);
    reply.status(500).send({ error: 'Failed to remove prize offer' });
  }
});

// Kid: request an available offer (goes to the parent approval queue).
// Optional split_user_ids: co-spenders sharing the cost evenly with the
// requester (each pays floor(cost / participants); the remainder of an uneven
// split is silently discounted).
fastify.post('/api/prize-offers/:id/request', async (request, reply) => {
  const { id } = request.params;
  const { user_id, split_user_ids } = request.body;
  try {
    if (!user_id) {
      return reply.status(400).send({ error: 'user_id is required' });
    }
    const user = await User.query().select('id').findById(user_id);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    let splitJson = null;
    if (split_user_ids !== undefined) {
      if (!Array.isArray(split_user_ids) || split_user_ids.some((sid) => !Number.isInteger(sid))) {
        return reply.status(400).send({ error: 'split_user_ids must be an array of user ids' });
      }
      const distinct = [...new Set(split_user_ids)].filter((sid) => sid !== user_id && sid !== 0);
      for (const sid of distinct) {
        if (!(await User.query().select('id').findById(sid))) {
          return reply.status(404).send({ error: `Split user ${sid} not found` });
        }
      }
      if (distinct.length > 0) splitJson = JSON.stringify(distinct);
    }

    const updated = await PrizeOffer.query()
      .patch({
        status: 'requested',
        requested_by: user_id,
        requested_at: knex.raw('CURRENT_TIMESTAMP'),
        split_user_ids: splitJson,
      })
      .where({ id, status: 'available' });
    if (updated === 0) {
      return reply.status(409).send({ error: 'Offer is not available (already requested or redeemed)' });
    }
    return { success: true };
  } catch (error) {
    console.error('Error requesting prize offer:', error);
    reply.status(500).send({ error: 'Failed to request prize' });
  }
});

// Cancel (kid withdraws) and decline (parent refuses) are the same
// transition: requested → back on the store shelf.
const returnOfferToStore = async (offerId, reply) => {
  const updated = await PrizeOffer.query()
    .patch({ status: 'available', requested_by: null, requested_at: null, split_user_ids: null })
    .where({ id: offerId, status: 'requested' });
  if (updated === 0) {
    reply.status(409).send({ error: 'Offer has no pending request' });
    return null;
  }
  return { success: true };
};

fastify.post('/api/prize-offers/:id/cancel-request', async (request, reply) => {
  try {
    return await returnOfferToStore(request.params.id, reply);
  } catch (error) {
    console.error('Error cancelling prize request:', error);
    reply.status(500).send({ error: 'Failed to cancel request' });
  }
});

fastify.post('/api/prize-offers/:id/decline', async (request, reply) => {
  try {
    return await returnOfferToStore(request.params.id, reply);
  } catch (error) {
    console.error('Error declining prize request:', error);
    reply.status(500).send({ error: 'Failed to decline request' });
  }
});

// Parent: approve a pending request. Deducts the prize's CURRENT cost as a
// negative kind='spent' ledger row (title = prize name), consumes the offer,
// and emits clam.withdrawn + prize.redeemed (drives the kiosk celebration).
// Insufficient balance leaves the request pending so the parent sees why.
fastify.post('/api/prize-offers/:id/approve', async (request, reply) => {
  const { id } = request.params;
  try {
    const offer = await knex('prize_offers as po')
      .join('prizes as p', 'po.prize_id', 'p.id')
      .leftJoin('users as u', 'po.requested_by', 'u.id')
      .select(
        'po.id', 'po.prize_id', 'po.requested_by', 'po.split_user_ids',
        'p.name', 'p.clam_cost', 'p.repeatable',
        'u.username as requested_by_name'
      )
      .where('po.id', id)
      .where('po.status', 'requested')
      .first();
    if (!offer) {
      return reply.status(409).send({ error: 'Offer has no pending request' });
    }

    // Split spending: everyone (requester + co-spenders) pays an equal
    // floor(cost / N) share; an uneven remainder is silently discounted.
    const splitIds = offer.split_user_ids ? JSON.parse(offer.split_user_ids) : [];
    const participantIds = [offer.requested_by, ...splitIds];
    const share = Math.floor(offer.clam_cost / participantIds.length);

    const usernameFor = async (pid) => {
      const row = await knex('users').select('username').where('id', pid).first();
      return row?.username;
    };

    const short = [];
    for (const pid of participantIds) {
      if ((await getUserClamTotal(pid)) < share) short.push(pid);
    }
    if (short.length > 0) {
      const names = (await Promise.all(short.map(async (pid) => (await usernameFor(pid)) || `user ${pid}`))).join(', ');
      return reply.status(400).send({
        error: `Insufficient clams: ${names} ${short.length === 1 ? 'has' : 'have'} less than the ${share}-clam share`,
      });
    }

    const today = getTodayLocalDateString();
    await knex.transaction(async (trx) => {
      for (const pid of participantIds) {
        await trx('chore_history').insert({
          user_id: pid,
          chore_schedule_id: null,
          date: today,
          clam_value: -share,
          title: offer.name,
          kind: 'spent',
        });
      }
      if (offer.repeatable === 1) {
        // Repeatable prize: back on the shelf for the next redemption.
        await trx('prize_offers').where('id', offer.id).update({
          status: 'available',
          requested_by: null,
          requested_at: null,
          split_user_ids: null,
        });
      } else {
        await trx('prize_offers').where('id', offer.id).update({
          status: 'redeemed',
          redeemed_at: trx.raw('CURRENT_TIMESTAMP'),
        });
      }
    });

    const participants = [];
    for (const pid of participantIds) {
      participants.push({
        userId: pid,
        username: (await usernameFor(pid)) || null,
        share,
        newTotal: await getUserClamTotal(pid),
      });
    }
    for (const participant of participants) {
      await emitPluginEvent('clam.withdrawn', { userId: participant.userId, amount: share, newTotal: participant.newTotal });
    }
    await emitPluginEvent('prize.redeemed', {
      userId: offer.requested_by,
      prizeId: offer.prize_id,
      offerId: offer.id,
      prizeName: offer.name,
      cost: share * participantIds.length,
      newTotal: participants[0].newTotal,
      participants,
    });

    return { success: true, clam_total: participants[0].newTotal, prize: offer.name, share, participants };
  } catch (error) {
    console.error('Error approving prize request:', error);
    reply.status(500).send({ error: 'Failed to approve prize request' });
  }
});

// Google Connections routes
fastify.get('/api/connections/google/status', async (request, reply) => {
  try {
    const oauth = await googleConnection.getOAuthStatus();
    const account = await googleConnection.getConnectedAccount();
    let redirectUri = '';
    try { redirectUri = await googleConnection.deriveRedirectUri(request); } catch (_) { }
    return {
      encryption: { configured: oauth.encryption_configured, status: getEncryptionStatus() },
      oauth: {
        has_client_id: oauth.has_client_id,
        has_client_secret: oauth.has_client_secret,
        client_id_preview: oauth.client_id_preview,
        redirect_uri_override: oauth.redirect_uri_override,
        redirect_uri: redirectUri,
      },
      account: account ? {
        id: account.id,
        email: account.email,
        name: account.name,
        picture: account.picture,
        scopes: account.scopes,
        connected_at: account.created_at,
        updated_at: account.updated_at,
      } : null,
    };
  } catch (error) {
    console.error('Error fetching Google connection status:', error);
    reply.status(500).send({ error: 'Failed to fetch Google connection status' });
  }
});

fastify.post('/api/connections/google/config', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    if (!isEncryptionConfigured()) {
      return reply.status(400).send({ error: 'ENCRYPTION_KEY is not configured on the server.' });
    }
    const { client_id, client_secret, redirect_uri_override } = request.body || {};
    await googleConnection.saveOAuthConfig({
      clientId: client_id,
      clientSecret: client_secret,
      redirectUriOverride: redirect_uri_override,
    });
    return { success: true };
  } catch (error) {
    console.error('Error saving Google OAuth config:', error);
    reply.status(500).send({ error: error.message || 'Failed to save Google OAuth config' });
  }
});

fastify.get('/api/connections/google/authorize', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    if (!isEncryptionConfigured()) {
      return reply.status(400).send({ error: 'ENCRYPTION_KEY is not configured on the server.' });
    }
    const status = await googleConnection.getOAuthStatus();
    if (!status.has_client_id || !status.has_client_secret) {
      return reply.status(400).send({ error: 'Google OAuth credentials are not configured.' });
    }
    const redirectUri = await googleConnection.deriveRedirectUri(request);
    const returnUrl = request.query && request.query.return_url;
    const state = await googleConnection.createAuthState(redirectUri, returnUrl);
    const url = await googleConnection.buildAuthUrl({ redirectUri, state });
    return { url, redirect_uri: redirectUri };
  } catch (error) {
    console.error('Error building authorize URL:', error);
    reply.status(500).send({ error: error.message || 'Failed to build authorize URL' });
  }
});

fastify.get('/api/connections/google/callback', async (request, reply) => {
  if (demoBlocked(reply)) return;
  const { code, state, error: oauthError } = request.query || {};
  const renderPage = (title, message, ok) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;max-width:480px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.3)}
h1{margin:0 0 12px;font-size:22px;color:${ok ? '#4ade80' : '#f87171'}}p{margin:0;color:#cbd5e1;line-height:1.5}
button{margin-top:20px;background:#2563eb;color:#fff;border:0;padding:10px 18px;border-radius:8px;font-size:14px;cursor:pointer}
button:hover{background:#1d4ed8}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p>
<button onclick="window.close()">Close window</button>
<script>try{window.opener&&window.opener.postMessage({type:'homeglow:google-oauth',ok:${ok ? 'true' : 'false'}},'*');}catch(e){}</script>
</div></body></html>`;
  };
  try {
    if (oauthError) {
      return renderPage('Authorization failed', `Google reported: ${oauthError}`, false);
    }
    if (!code || !state) {
      return renderPage('Authorization failed', 'Missing authorization code or state.', false);
    }
    const stateRow = await googleConnection.consumeAuthState(state);
    if (!stateRow) {
      return renderPage('Authorization failed', 'Invalid or expired OAuth state.', false);
    }
    const tokens = await googleConnection.exchangeCodeForTokens({ code, redirectUri: stateRow.redirect_uri });
    const userInfo = await googleConnection.fetchUserInfo(tokens.access_token);
    await googleConnection.upsertGoogleAccount({
      sub: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      tokens,
    });
    return renderPage('Connected to Google', `Signed in as ${userInfo.email || userInfo.name || 'your Google account'}. You can close this window.`, true);
  } catch (error) {
    console.error('Google OAuth callback error:', error);
    return renderPage('Authorization failed', error.message || 'An unexpected error occurred.', false);
  }
});

fastify.get('/api/connections/google/albums', async (request, reply) => {
  try {
    const account = await googleConnection.getConnectedAccount();
    if (!account) return reply.status(404).send({ error: 'No Google account connected.' });
    const albums = await googlePhotos.listAlbums(account.id);
    return { albums };
  } catch (error) {
    console.error('Error listing Google Photos albums:', error);
    reply.status(error.status || 500).send({ error: error.message || 'Failed to list Google Photos albums' });
  }
});

fastify.get('/api/connections/google/calendars', async (request, reply) => {
  try {
    const account = await googleConnection.getConnectedAccount();
    if (!account) return reply.status(404).send({ error: 'No Google account connected.' });
    const calendars = await googleCalendar.listCalendars(account.id);
    return { calendars };
  } catch (error) {
    console.error('Error listing Google calendars:', error);
    reply.status(500).send({ error: error.message || 'Failed to list Google calendars' });
  }
});

// Loads a calendar source by id, asserting it's a writable Google source.
// Sends a 404 (missing) or 400 (read-only, non-Google) and returns null on failure.
const loadGoogleCalendarSource = async (id, reply) => {
  const source = await CalendarSource.query().findById(id);
  if (!source) {
    reply.status(404).send({ error: 'Calendar source not found' });
    return null;
  }
  if (source.type !== 'Google') {
    reply.status(400).send({ error: 'This calendar type is read-only.' });
    return null;
  }
  return source;
};

fastify.post('/api/calendar-sources/:id/events', async (request, reply) => {
  try {
    const { id } = request.params;
    const source = await loadGoogleCalendarSource(id, reply);
    if (!source) return;
    const account = await loadConnectedGoogleAccountOr400(reply);
    if (!account) return;

    const created = await googleCalendar.createEvent(account.id, source.url, request.body || {});
    if (calendarSyncService) calendarSyncService.syncSource(source.id).catch(() => { });
    return { success: true, event: created };
  } catch (error) {
    console.error('Error creating Google calendar event:', error);
    reply.status(error.status || 500).send({ error: error.message || 'Failed to create event' });
  }
});

fastify.patch('/api/calendar-sources/:id/events/:eventId', async (request, reply) => {
  try {
    const { id, eventId } = request.params;
    const source = await loadGoogleCalendarSource(id, reply);
    if (!source) return;
    const account = await loadConnectedGoogleAccountOr400(reply);
    if (!account) return;

    const updated = await googleCalendar.updateEvent(account.id, source.url, eventId, request.body || {});
    if (calendarSyncService) calendarSyncService.syncSource(source.id).catch(() => { });
    return { success: true, event: updated };
  } catch (error) {
    console.error('Error updating Google calendar event:', error);
    reply.status(error.status || 500).send({ error: error.message || 'Failed to update event' });
  }
});

fastify.delete('/api/calendar-sources/:id/events/:eventId', async (request, reply) => {
  try {
    const { id, eventId } = request.params;
    const source = await loadGoogleCalendarSource(id, reply);
    if (!source) return;
    const account = await loadConnectedGoogleAccountOr400(reply);
    if (!account) return;

    await googleCalendar.deleteEvent(account.id, source.url, eventId);
    if (calendarSyncService) calendarSyncService.syncSource(source.id).catch(() => { });
    return { success: true };
  } catch (error) {
    console.error('Error deleting Google calendar event:', error);
    reply.status(error.status || 500).send({ error: error.message || 'Failed to delete event' });
  }
});

fastify.delete('/api/connections/google/account', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    const account = await googleConnection.getConnectedAccount();
    if (!account) {
      return { success: true, message: 'No Google account connected.' };
    }
    await googleConnection.revokeAndDisconnect(account.id);
    return { success: true };
  } catch (error) {
    console.error('Error disconnecting Google account:', error);
    reply.status(500).send({ error: error.message || 'Failed to disconnect Google account' });
  }
});

// Home Assistant connection routes (issue #57).
//
// The status route reports whether a token is stored, never the token itself —
// a Home Assistant long-lived token controls the whole house, so it is stored
// encrypted, redacted from GET /api/settings, and written blind.
fastify.get('/api/connections/homeassistant/status', async (request, reply) => {
  try {
    const status = await homeAssistant.getHomeAssistantStatus();
    return {
      ...status,
      encryption: { configured: status.encryption_configured, status: getEncryptionStatus() },
    };
  } catch (error) {
    console.error('Error fetching Home Assistant status:', error);
    reply.status(500).send({ error: 'Failed to fetch Home Assistant status' });
  }
});

fastify.put('/api/connections/homeassistant', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    const { url, token, weather_entity } = request.body || {};

    // Only the token needs encryption, so only the token needs the key.
    if (token !== undefined && token !== null && String(token).trim() !== '' && !isEncryptionConfigured()) {
      return reply.status(400).send({ error: 'ENCRYPTION_KEY is not configured on the server.' });
    }

    // saveConfig is async and rejects a bad URL, so it has to be awaited INSIDE
    // this try for that rejection to become the 400 below rather than an
    // unhandled rejection.
    await homeAssistant.saveConfig({ url, token, weatherEntity: weather_entity });
    // Provider config changed, so anything cached under the old settings is stale.
    weatherService.clearCache();
    return { success: true, status: await homeAssistant.getHomeAssistantStatus() };
  } catch (error) {
    console.error('Error saving Home Assistant config:', error);
    reply.status(400).send({ error: error.message || 'Failed to save Home Assistant config' });
  }
});

fastify.post('/api/connections/homeassistant/test', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    return await homeAssistant.testConnection();
  } catch (error) {
    console.error('Error testing Home Assistant connection:', error);
    reply.status(500).send({ error: error.message || 'Failed to test Home Assistant connection' });
  }
});

fastify.get('/api/connections/homeassistant/weather-entities', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    if (!(await homeAssistant.isConfigured())) {
      return reply.status(400).send({ error: 'Home Assistant is not configured.' });
    }
    return { entities: await homeAssistant.listWeatherEntities() };
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    console.error('Error listing Home Assistant weather entities:', error.message);
    reply.status(status).send({ error: error.message || 'Failed to list weather entities' });
  }
});

fastify.delete('/api/connections/homeassistant', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    await homeAssistant.clearConfig();
    weatherService.clearCache();
    return { success: true };
  } catch (error) {
    console.error('Error clearing Home Assistant config:', error);
    reply.status(500).send({ error: error.message || 'Failed to clear Home Assistant config' });
  }
});

// Which weather provider is active and whether it is usable. Lets the Admin
// Panel show "no API key saved" without the key ever being sent to it.
fastify.get('/api/connections/weather/status', async (request, reply) => {
  try {
    const status = await weatherService.getProviderStatus({ demoMode: DEMO_MODE });
    const hasApiKey = !!(await knex('settings').select('value').where('key', 'WEATHER_API_KEY').first())?.value;
    return { ...status, has_api_key: hasApiKey };
  } catch (error) {
    console.error('Error fetching weather provider status:', error);
    reply.status(500).send({ error: 'Failed to fetch weather provider status' });
  }
});

// Apple Calendar (iCloud CalDAV) connection routes
fastify.post('/api/connections/apple/calendars', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    const { appleId, appPassword } = request.body || {};
    if (!appleId || !appPassword) {
      return reply.status(400).send({ error: 'Apple ID and app-specific password are required.' });
    }
    const { calendars } = await appleCalDAV.discoverAndListCalendars(appleId.trim(), appPassword.trim());
    return { calendars };
  } catch (error) {
    console.error('Apple CalDAV discovery error:', error.message);
    reply.status(400).send({ error: error.message || 'Failed to connect to iCloud. Check your Apple ID and app-specific password.' });
  }
});

// Calendar sources routes
fastify.get('/api/calendar-sources', async (request, reply) => {
  try {
    const rows = await CalendarSource.query()
      .select('id', 'name', 'type', 'url', 'username', 'color', 'enabled', 'sort_order', 'created_at')
      .orderBy([{ column: 'sort_order' }, { column: 'id' }]);
    return rows;
  } catch (error) {
    console.error('Error fetching calendar sources:', error);
    reply.status(500).send({ error: 'Failed to fetch calendar sources' });
  }
});

fastify.post('/api/calendar-sources', async (request, reply) => {
  // Demo-blocked: with the sync service running in demo mode, a visitor-added
  // source would be fetched server-side (SSRF). Only the seeded feeds sync.
  if (demoBlocked(reply)) return;
  const { name, type, url, username, password, color } = request.body;
  if (!name || !type || !url) {
    return reply.status(400).send({ error: 'Name, type, and URL are required.' });
  }
  if (!['ICS', 'CalDAV', 'Google', 'Apple'].includes(type)) {
    return reply.status(400).send({ error: 'Type must be ICS, CalDAV, Google, or Apple.' });
  }
  if (type === 'Google' && !(await googleConnection.getConnectedAccount())) {
    return reply.status(400).send({ error: 'Connect your Google account before adding a Google calendar.' });
  }
  if (type === 'Apple' && (!request.body.username || !password)) {
    return reply.status(400).send({ error: 'Apple ID and app-specific password are required.' });
  }
  try {
    const encryptedPassword = password ? encryptPassword(password) : null;
    const maxRow = await knex('calendar_sources').max({ max: 'sort_order' }).first();
    const nextOrder = ((maxRow && maxRow.max) || 0) + 1;

    const inserted = await CalendarSource.query().insert({
      name,
      type,
      url,
      username: username || null,
      password: encryptedPassword,
      color: color || '#6e44ff',
      enabled: 1,
      sort_order: nextOrder,
    });

    if (calendarSyncService) {
      calendarSyncService.onSourceCreated(inserted.id);
    }

    return { id: inserted.id, success: true };
  } catch (error) {
    console.error('Error adding calendar source:', error);
    reply.status(500).send({ error: 'Failed to add calendar source' });
  }
});

fastify.patch('/api/calendar-sources/:id', async (request, reply) => {
  // Demo-blocked: editing a source's URL would make the sync service fetch a
  // visitor-supplied address (SSRF).
  if (demoBlocked(reply)) return;
  const { id } = request.params;
  const { name, type, url, username, password, color, enabled } = request.body;

  try {
    const existing = await CalendarSource.query().findById(id);
    if (!existing) {
      return reply.status(404).send({ error: 'Calendar source not found' });
    }

    const patch = {};

    if (name !== undefined) { patch.name = name; }
    if (type !== undefined) {
      if (!['ICS', 'CalDAV', 'Apple'].includes(type)) {
        return reply.status(400).send({ error: 'Type must be ICS, CalDAV, or Apple.' });
      }
      patch.type = type;
    }
    if (url !== undefined) { patch.url = url; }
    if (username !== undefined) { patch.username = username || null; }
    if (password !== undefined && password !== '') {
      patch.password = encryptPassword(password);
    }
    if (color !== undefined) { patch.color = color; }
    if (enabled !== undefined) { patch.enabled = enabled ? 1 : 0; }

    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    const updated = await CalendarSource.query().patch(patch).where({ id });

    if (updated === 0) {
      return reply.status(404).send({ error: 'Calendar source not found' });
    }

    if (calendarSyncService) {
      if (enabled !== undefined) {
        calendarSyncService.onSourceToggled(parseInt(id), enabled);
      } else {
        calendarSyncService.onSourceUpdated(parseInt(id));
      }
    }

    return { success: true, message: 'Calendar source updated successfully' };
  } catch (error) {
    console.error('Error updating calendar source:', error);
    reply.status(500).send({ error: 'Failed to update calendar source' });
  }
});

fastify.delete('/api/calendar-sources/:id', async (request, reply) => {
  // Demo-blocked so one visitor can't remove the curated demo feeds for the next.
  if (demoBlocked(reply)) return;
  const { id } = request.params;
  try {
    if (calendarSyncService) {
      calendarSyncService.onSourceDeleted(parseInt(id));
    }

    const deleted = await CalendarSource.query().deleteById(id);
    if (deleted === 0) {
      return reply.status(404).send({ error: 'Calendar source not found' });
    }
    return { success: true, message: 'Calendar source deleted successfully' };
  } catch (error) {
    console.error('Error deleting calendar source:', error);
    reply.status(500).send({ error: 'Failed to delete calendar source' });
  }
});

fastify.post('/api/calendar-sources/:id/test', async (request, reply) => {
  if (demoBlocked(reply)) return;
  const { id } = request.params;
  try {
    const source = await CalendarSource.query().findById(id);
    if (!source) {
      return reply.status(404).send({ error: 'Calendar source not found' });
    }

    if (source.type === 'ICS') {
      const response = await axios.get(source.url, { timeout: 10000 });
      const jcalData = ICAL.parse(response.data);
      const comp = new ICAL.Component(jcalData);
      const vevents = comp.getAllSubcomponents('vevent');
      return { success: true, eventCount: vevents.length, message: 'ICS calendar connection successful' };
    } else if (source.type === 'CalDAV') {
      const decryptedPassword = decryptPassword(source.password);
      const authHeader = 'Basic ' + Buffer.from(`${source.username}:${decryptedPassword}`).toString('base64');
      const response = await axios.get(source.url, {
        headers: { 'Authorization': authHeader },
        timeout: 10000
      });
      return { success: true, message: 'CalDAV connection successful' };
    } else if (source.type === 'Apple') {
      const decryptedPassword = decryptPassword(source.password);
      const events = await appleCalDAV.fetchCalendarEvents(source.url, source.username, decryptedPassword);
      return { success: true, eventCount: events.length, message: 'iCloud calendar connection successful' };
    }
  } catch (error) {
    console.error('Error testing calendar source:', error);
    return reply.status(400).send({
      success: false,
      error: 'Failed to connect to calendar source',
      details: error.message
    });
  }
});


// Get calendar events from cache (fast)
fastify.get('/api/calendar-events', async (request, reply) => {
  try {
    const { start, end } = request.query;

    if (!calendarSyncService) {
      return reply.status(503).send({ error: 'Calendar sync service not initialized' });
    }

    const events = await calendarSyncService.getCachedEvents(start, end);
    return events;
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    reply.status(500).send({ error: 'Failed to fetch calendar events.' });
  }
});

// Get calendar sync status for all sources
fastify.get('/api/calendar-sync/status', async (request, reply) => {
  try {
    if (!calendarSyncService) {
      return reply.status(503).send({ error: 'Calendar sync service not initialized' });
    }
    const status = await calendarSyncService.getSyncStatus();
    return status;
  } catch (error) {
    console.error('Error fetching sync status:', error);
    reply.status(500).send({ error: 'Failed to fetch sync status' });
  }
});

// Get sync status for a specific source
fastify.get('/api/calendar-sync/status/:sourceId', async (request, reply) => {
  try {
    const { sourceId } = request.params;
    if (!calendarSyncService) {
      return reply.status(503).send({ error: 'Calendar sync service not initialized' });
    }
    const status = await calendarSyncService.getSyncStatus(parseInt(sourceId));
    return status || { source_id: sourceId, last_sync_at: null, last_sync_status: 'never' };
  } catch (error) {
    console.error('Error fetching sync status:', error);
    reply.status(500).send({ error: 'Failed to fetch sync status' });
  }
});

// Trigger manual sync for a specific source
fastify.post('/api/calendar-sync/:sourceId', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    const { sourceId } = request.params;
    if (!calendarSyncService) {
      return reply.status(503).send({ error: 'Calendar sync service not initialized' });
    }
    const result = await calendarSyncService.syncSource(parseInt(sourceId));
    return result;
  } catch (error) {
    console.error('Error syncing calendar source:', error);
    reply.status(500).send({ error: 'Failed to sync calendar source' });
  }
});

// Trigger manual sync for all sources
fastify.post('/api/calendar-sync/all', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    if (!calendarSyncService) {
      return reply.status(503).send({ error: 'Calendar sync service not initialized' });
    }
    const results = await calendarSyncService.syncAllSources();
    return results;
  } catch (error) {
    console.error('Error syncing all calendar sources:', error);
    reply.status(500).send({ error: 'Failed to sync calendar sources' });
  }
});

// Set sync interval for a specific source
fastify.patch('/api/calendar-sync/:sourceId/interval', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    const { sourceId } = request.params;
    const { interval_minutes } = request.body;

    if (interval_minutes === undefined || interval_minutes < 0) {
      return reply.status(400).send({ error: 'interval_minutes must be a non-negative number' });
    }

    if (!calendarSyncService) {
      return reply.status(503).send({ error: 'Calendar sync service not initialized' });
    }

    await calendarSyncService.setSyncInterval(parseInt(sourceId), interval_minutes);
    return { success: true, message: `Sync interval set to ${interval_minutes} minutes` };
  } catch (error) {
    console.error('Error setting sync interval:', error);
    reply.status(500).send({ error: 'Failed to set sync interval' });
  }
});

// Get sync interval for a specific source
fastify.get('/api/calendar-sync/:sourceId/interval', async (request, reply) => {
  try {
    const { sourceId } = request.params;
    if (!calendarSyncService) {
      return reply.status(503).send({ error: 'Calendar sync service not initialized' });
    }
    const interval = await calendarSyncService.getSyncInterval(parseInt(sourceId));
    return { source_id: parseInt(sourceId), interval_minutes: interval };
  } catch (error) {
    console.error('Error getting sync interval:', error);
    reply.status(500).send({ error: 'Failed to get sync interval' });
  }
});


// Photo sources routes
fastify.get('/api/photo-sources', async (request, reply) => {
  try {
    const rows = await PhotoSource.query()
      .select('id', 'name', 'type', 'url', 'album_id', 'enabled', 'sort_order', 'created_at')
      .orderBy([{ column: 'sort_order' }, { column: 'id' }]);
    return rows;
  } catch (error) {
    console.error('Error fetching photo sources:', error);
    reply.status(500).send({ error: 'Failed to fetch photo sources' });
  }
});

fastify.post('/api/photo-sources', async (request, reply) => {
  const { name, type, url, api_key, username, password, album_id, refresh_token } = request.body;
  if (!name || !type) {
    return reply.status(400).send({ error: 'Name and type are required.' });
  }
  if (!['Immich', 'GooglePhotos', 'HomeGlowPhotos'].includes(type)) {
    return reply.status(400).send({ error: 'Type must be Immich, GooglePhotos, or HomeGlowPhotos.' });
  }
  try {
    const encryptedApiKey = api_key ? encryptPassword(api_key) : null;
    const encryptedPassword = password ? encryptPassword(password) : null;
    const encryptedRefreshToken = refresh_token ? encryptPassword(refresh_token) : null;
    const maxRow = await knex('photo_sources').max({ max: 'sort_order' }).first();
    const nextOrder = ((maxRow && maxRow.max) || 0) + 1;

    const inserted = await PhotoSource.query().insert({
      name,
      type,
      url: url || null,
      api_key: encryptedApiKey,
      username: username || null,
      password: encryptedPassword,
      album_id: album_id || null,
      refresh_token: encryptedRefreshToken,
      enabled: 1,
      sort_order: nextOrder,
    });
    return { id: inserted.id, success: true };
  } catch (error) {
    console.error('Error adding photo source:', error);
    reply.status(500).send({ error: 'Failed to add photo source' });
  }
});

fastify.patch('/api/photo-sources/:id', async (request, reply) => {
  const { id } = request.params;
  const { name, type, url, api_key, username, password, album_id, refresh_token, enabled } = request.body;

  try {
    const existing = await PhotoSource.query().findById(id);
    if (!existing) {
      return reply.status(404).send({ error: 'Photo source not found' });
    }

    const patch = {};

    if (name !== undefined) { patch.name = name; }
    if (type !== undefined) {
      if (!['Immich', 'GooglePhotos', 'HomeGlowPhotos'].includes(type)) {
        return reply.status(400).send({ error: 'Type must be Immich, GooglePhotos, or HomeGlowPhotos.' });
      }
      patch.type = type;
    }
    if (url !== undefined) { patch.url = url || null; }
    if (api_key !== undefined && api_key !== '') {
      patch.api_key = encryptPassword(api_key);
    }
    if (username !== undefined) { patch.username = username || null; }
    if (password !== undefined && password !== '') {
      patch.password = encryptPassword(password);
    }
    if (album_id !== undefined) { patch.album_id = album_id || null; }
    if (refresh_token !== undefined && refresh_token !== '') {
      patch.refresh_token = encryptPassword(refresh_token);
    }
    if (enabled !== undefined) { patch.enabled = enabled ? 1 : 0; }

    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    const updated = await PhotoSource.query().patch(patch).where({ id });

    if (updated === 0) {
      return reply.status(404).send({ error: 'Photo source not found' });
    }
    return { success: true, message: 'Photo source updated successfully' };
  } catch (error) {
    console.error('Error updating photo source:', error);
    reply.status(500).send({ error: 'Failed to update photo source' });
  }
});

fastify.delete('/api/photo-sources/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const picked = await GooglePickedMedia.query().select('local_path').where('source_id', id);
    for (const p of picked) googlePhotosPicker.removeLocalFile(p.local_path);
    await GooglePickedMedia.query().delete().where('source_id', id);

    const homeglowDir = path.join(__dirname, 'uploads', 'homeglow-photos', String(id));
    try { fsSync.rmSync(homeglowDir, { recursive: true, force: true }); } catch (_) { }
    await HomeglowPhoto.query().delete().where('source_id', id);

    const deleted = await PhotoSource.query().deleteById(id);
    if (deleted === 0) {
      return reply.status(404).send({ error: 'Photo source not found' });
    }
    return { success: true, message: 'Photo source deleted successfully' };
  } catch (error) {
    console.error('Error deleting photo source:', error);
    reply.status(500).send({ error: 'Failed to delete photo source' });
  }
});

fastify.post('/api/photo-sources/:id/test', async (request, reply) => {
  const { id } = request.params;
  try {
    const source = await PhotoSource.query().findById(id);
    if (!source) {
      return reply.status(404).send({ error: 'Photo source not found' });
    }

    if (source.type === 'Immich') {
      const decryptedApiKey = decryptPassword(source.api_key);
      const baseUrl = source.url.replace(/\/+$/, '');
      const apiBase = baseUrl.includes('/api') ? baseUrl : `${baseUrl}/api`;
      console.log(`Testing Immich connection to: ${apiBase}/search/random`);
      const response = await axios.post(`${apiBase}/search/random`,
        { size: 1 },
        {
          headers: {
            'x-api-key': decryptedApiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 10000
        }
      );
      return { success: true, assetCount: response.data.length || 0, message: `Immich connection successful (${response.data.length || 0} assets found)` };
    } else if (source.type === 'GooglePhotos') {
      const account = await googleConnection.getConnectedAccount();
      if (!account) {
        return reply.status(400).send({ success: false, error: 'No Google account connected. Connect one in Admin > Connections.' });
      }
      const count = Number((await knex('google_picked_media').where('source_id', source.id).count({ c: '*' }).first()).c);
      return { success: true, message: `${count} picked photo${count === 1 ? '' : 's'} available for this source.` };
    } else if (source.type === 'HomeGlowPhotos') {
      const count = Number((await knex('homeglow_photos').where('source_id', source.id).count({ c: '*' }).first()).c);
      return { success: true, message: `${count} uploaded photo${count === 1 ? '' : 's'} available for this source.` };
    }
    return reply.status(400).send({ success: false, error: `Unsupported photo source type: ${source.type}` });
  } catch (error) {
    console.error('Error testing photo source:', error.message);
    if (error.code === 'ECONNREFUSED') {
      return reply.status(400).send({ success: false, error: 'Connection refused. Check that the Immich server URL is correct and the server is running.', details: error.message });
    }
    if (error.code === 'ENOTFOUND') {
      return reply.status(400).send({ success: false, error: 'Host not found. Check the Immich server URL.', details: error.message });
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      return reply.status(400).send({ success: false, error: 'Connection timed out. The server may be unreachable from this network.', details: error.message });
    }
    if (error.response) {
      console.error(`Response status: ${error.response.status}`);
      console.error(`Response data:`, error.response.data);
      if (error.response.status === 401) {
        return reply.status(400).send({ success: false, error: 'Authentication failed. Check your API key.', details: `HTTP ${error.response.status}` });
      }
      if (error.response.status === 404) {
        return reply.status(400).send({ success: false, error: 'API endpoint not found. Check your Immich server URL - it should be the base URL (e.g., https://immich.example.com).', details: `HTTP ${error.response.status}` });
      }
    }
    return reply.status(400).send({
      success: false,
      error: 'Failed to connect to photo source',
      details: error.message,
      responseStatus: error.response?.status,
      responseData: error.response?.data
    });
  }
});

fastify.get('/api/photo-proxy/:sourceId/:assetId', async (request, reply) => {
  const { sourceId, assetId } = request.params;
  const { size = 'preview' } = request.query;

  try {
    const source = await PhotoSource.query().findById(sourceId);
    if (!source) {
      return reply.status(404).send({ error: 'Photo source not found' });
    }

    const decryptedApiKey = decryptPassword(source.api_key);
    const baseUrl = source.url.replace(/\/+$/, '');
    const apiBase = baseUrl.includes('/api') ? baseUrl : `${baseUrl}/api`;
    const response = await axios.get(`${apiBase}/assets/${assetId}/thumbnail`, {
      headers: {
        'x-api-key': decryptedApiKey
      },
      params: { size },
      responseType: 'arraybuffer',
      timeout: 15000
    });

    reply.header('Content-Type', response.headers['content-type'] || 'image/jpeg');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(Buffer.from(response.data));
  } catch (error) {
    console.error('Error proxying photo:', error.message);
    if (error.response) {
      console.error(`Immich response status: ${error.response.status}`);
      console.error(`Immich response data:`, error.response.data);
    }
    return reply.status(500).send({ error: 'Failed to load photo' });
  }
});

// Loads a HomeGlow Photos source by id, asserting its type. On miss, sends a
// 404 and returns null so the caller can `if (!source) return;`.
const loadHomeGlowPhotoSourceOr404 = async (sourceId, reply) => {
  const source = await PhotoSource.query().select('id', 'type').findById(sourceId);
  if (!source || source.type !== 'HomeGlowPhotos') {
    reply.status(404).send({ error: 'HomeGlow Photos source not found' });
    return null;
  }
  return source;
};

// HomeGlow Photos - list uploaded photos for a source
fastify.get('/api/photo-sources/:sourceId/uploaded', async (request, reply) => {
  const { sourceId } = request.params;
  try {
    const source = await loadHomeGlowPhotoSourceOr404(sourceId, reply);
    if (!source) return;
    const rows = await HomeglowPhoto.query()
      .select('id', 'filename', 'original_name', 'mime_type', 'size', 'uploaded_at')
      .where('source_id', sourceId)
      .orderBy('uploaded_at', 'desc');
    return rows.map((r) => ({
      ...r,
      url: `/api/photo-sources/${sourceId}/uploaded/${r.id}/file`,
      thumbnail_url: `/api/photo-sources/${sourceId}/uploaded/${r.id}/file`,
    }));
  } catch (error) {
    console.error('Error listing uploaded photos:', error);
    reply.status(500).send({ error: 'Failed to list uploaded photos' });
  }
});

// HomeGlow Photos - serve a single uploaded file
fastify.get('/api/photo-sources/:sourceId/uploaded/:photoId/file', async (request, reply) => {
  const { sourceId, photoId } = request.params;
  try {
    const row = await HomeglowPhoto.query().select('filename', 'mime_type').where({ id: photoId, source_id: sourceId }).first();
    if (!row) return reply.status(404).send({ error: 'Photo not found' });
    const filePath = path.join(__dirname, 'uploads', 'homeglow-photos', String(sourceId), row.filename);
    if (!fsSync.existsSync(filePath)) return reply.status(404).send({ error: 'File missing' });
    reply.header('Content-Type', row.mime_type || 'image/jpeg');
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(fsSync.createReadStream(filePath));
  } catch (error) {
    console.error('Error serving uploaded photo:', error);
    reply.status(500).send({ error: 'Failed to load photo' });
  }
});

// HomeGlow Photos - upload one or more photos (multipart)
fastify.post('/api/photo-sources/:sourceId/uploaded', async (request, reply) => {
  if (demoBlocked(reply)) return;
  const { sourceId } = request.params;
  try {
    const source = await loadHomeGlowPhotoSourceOr404(sourceId, reply);
    if (!source) return;
    const uploadDir = path.join(__dirname, 'uploads', 'homeglow-photos', String(sourceId));
    await fs.mkdir(uploadDir, { recursive: true });

    const parts = request.parts();
    const added = [];
    const failed = [];
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      if (!part.mimetype || !part.mimetype.startsWith('image/')) {
        failed.push({ name: part.filename, reason: 'Not an image' });
        await part.toBuffer().catch(() => null);
        continue;
      }
      try {
        const ext = path.extname(part.filename || '') || '.jpg';
        const safeBase = crypto.randomBytes(12).toString('hex');
        const filename = `${safeBase}${ext.toLowerCase()}`;
        const filePath = path.join(uploadDir, filename);
        const buffer = await part.toBuffer();
        await fs.writeFile(filePath, buffer);
        const inserted = await HomeglowPhoto.query().insert({ source_id: sourceId, filename, original_name: part.filename || null, mime_type: part.mimetype, size: buffer.length });
        added.push({ id: inserted.id, filename, original_name: part.filename });
      } catch (err) {
        console.error('Upload failure for part:', err);
        failed.push({ name: part.filename, reason: err.message });
      }
    }
    return { success: true, added: added.length, failed: failed.length, items: added, errors: failed };
  } catch (error) {
    console.error('Error uploading photos:', error);
    reply.status(500).send({ error: 'Failed to upload photos' });
  }
});

// HomeGlow Photos - delete an uploaded photo
fastify.delete('/api/photo-sources/:sourceId/uploaded/:photoId', async (request, reply) => {
  const { sourceId, photoId } = request.params;
  try {
    const row = await HomeglowPhoto.query().select('filename').where({ id: photoId, source_id: sourceId }).first();
    if (!row) return reply.status(404).send({ error: 'Photo not found' });
    const filePath = path.join(__dirname, 'uploads', 'homeglow-photos', String(sourceId), row.filename);
    try { await fs.unlink(filePath); } catch (_) { }
    await HomeglowPhoto.query().deleteById(photoId);
    return { success: true };
  } catch (error) {
    console.error('Error deleting uploaded photo:', error);
    reply.status(500).send({ error: 'Failed to delete photo' });
  }
});

fastify.get('/api/photo-sources/:sourceId/picked/:mediaRowId', async (request, reply) => {
  const { sourceId, mediaRowId } = request.params;
  try {
    const row = await GooglePickedMedia.query().select('local_path', 'mime_type').where({ id: mediaRowId, source_id: sourceId }).first();
    if (!row || !fsSync.existsSync(row.local_path)) {
      return reply.status(404).send({ error: 'Picked media not found' });
    }
    reply.header('Content-Type', row.mime_type || 'image/jpeg');
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(fsSync.readFileSync(row.local_path));
  } catch (error) {
    console.error('Error serving picked media:', error.message);
    return reply.status(500).send({ error: 'Failed to load picked media' });
  }
});

fastify.get('/api/photo-sources/:sourceId/picked', async (request, reply) => {
  const { sourceId } = request.params;
  try {
    const rows = await GooglePickedMedia.query().select('id', 'google_media_id', 'filename', 'mime_type', 'width', 'height', 'created_time', 'downloaded_at').where('source_id', sourceId).orderBy('downloaded_at', 'desc');
    return rows.map((r) => ({
      ...r,
      thumbnail_url: `/api/photo-sources/${sourceId}/picked/${r.id}`,
    }));
  } catch (error) {
    console.error('Error listing picked media:', error);
    reply.status(500).send({ error: 'Failed to list picked media' });
  }
});

fastify.delete('/api/photo-sources/:sourceId/picked/:mediaRowId', async (request, reply) => {
  const { sourceId, mediaRowId } = request.params;
  try {
    const row = await GooglePickedMedia.query().select('local_path').where({ id: mediaRowId, source_id: sourceId }).first();
    if (!row) return reply.status(404).send({ error: 'Picked media not found' });
    googlePhotosPicker.removeLocalFile(row.local_path);
    await GooglePickedMedia.query().deleteById(mediaRowId);
    return { success: true };
  } catch (error) {
    console.error('Error deleting picked media:', error);
    reply.status(500).send({ error: 'Failed to delete picked media' });
  }
});

// Loads a Google Photos photo source by id. On miss (absent or wrong type),
// sends a 404 and returns null so the caller can `if (!source) return;`.
const loadGooglePhotoSourceOr404 = async (sourceId, reply) => {
  const source = await PhotoSource.query().findById(sourceId);
  if (!source || source.type !== 'GooglePhotos') {
    reply.status(404).send({ error: 'Google Photos source not found' });
    return null;
  }
  return source;
};

// Returns the connected Google account, or sends a 400 and returns null.
const loadConnectedGoogleAccountOr400 = async (reply) => {
  const account = await googleConnection.getConnectedAccount();
  if (!account) {
    reply.status(400).send({ error: 'No Google account connected.' });
    return null;
  }
  return account;
};

fastify.post('/api/photo-sources/:sourceId/picker-session', async (request, reply) => {
  const { sourceId } = request.params;
  try {
    const source = await loadGooglePhotoSourceOr404(sourceId, reply);
    if (!source) return;
    const account = await loadConnectedGoogleAccountOr400(reply);
    if (!account) return;

    const session = await googlePhotosPicker.createSession(account.id);
    await PhotoSource.query().findById(sourceId).patch({ picker_session_id: session.id || null, picker_session_expire: session.expireTime || null });

    return {
      sessionId: session.id,
      pickerUri: session.pickerUri,
      expireTime: session.expireTime,
      mediaItemsSet: !!session.mediaItemsSet,
      pollingConfig: session.pollingConfig || null,
    };
  } catch (error) {
    console.error('Error creating picker session:', error);
    reply.status(error.status || 500).send({ error: error.message || 'Failed to create picker session' });
  }
});

fastify.get('/api/photo-sources/:sourceId/picker-session', async (request, reply) => {
  const { sourceId } = request.params;
  try {
    const source = await loadGooglePhotoSourceOr404(sourceId, reply);
    if (!source) return;
    if (!source.picker_session_id) {
      return { sessionId: null, mediaItemsSet: false };
    }
    const account = await loadConnectedGoogleAccountOr400(reply);
    if (!account) return;

    const session = await googlePhotosPicker.getSession(account.id, source.picker_session_id);
    return {
      sessionId: session.id,
      pickerUri: session.pickerUri,
      expireTime: session.expireTime,
      mediaItemsSet: !!session.mediaItemsSet,
      pollingConfig: session.pollingConfig || null,
    };
  } catch (error) {
    console.error('Error polling picker session:', error);
    if (error.status === 404 || error.status === 400) {
      await PhotoSource.query().findById(sourceId).patch({ picker_session_id: null, picker_session_expire: null });
    }
    reply.status(error.status || 500).send({ error: error.message || 'Failed to poll picker session' });
  }
});

fastify.post('/api/photo-sources/:sourceId/picker-session/ingest', async (request, reply) => {
  const { sourceId } = request.params;
  try {
    const source = await loadGooglePhotoSourceOr404(sourceId, reply);
    if (!source) return;
    if (!source.picker_session_id) {
      return reply.status(400).send({ error: 'No active picker session' });
    }
    const account = await loadConnectedGoogleAccountOr400(reply);
    if (!account) return;

    const session = await googlePhotosPicker.getSession(account.id, source.picker_session_id);
    if (!session.mediaItemsSet) {
      return reply.status(400).send({ error: 'Picker session not yet completed by user' });
    }

    const items = await googlePhotosPicker.listPickedMediaItems(account.id, source.picker_session_id);
    let added = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of items) {
      const mediaFile = item.mediaFile || {};
      const mime = mediaFile.mimeType;
      if (!googlePhotosPicker.isImageMime(mime)) { skipped++; continue; }
      const existing = await GooglePickedMedia.query().select('id').where({ source_id: sourceId, google_media_id: item.id }).first();
      if (existing) { skipped++; continue; }
      try {
        const saved = await googlePhotosPicker.downloadMedia(account.id, sourceId, item);
        await GooglePickedMedia.query().insert({ source_id: sourceId, google_media_id: item.id, filename: saved.filename, mime_type: saved.mimeType, local_path: saved.localPath, width: saved.width, height: saved.height, created_time: item.createTime || null }).onConflict(['source_id', 'google_media_id']).ignore();
        added++;
      } catch (err) {
        console.error('Failed to ingest picked item', item.id, err.message);
        failed++;
      }
    }

    try {
      await googlePhotosPicker.deleteSession(account.id, source.picker_session_id);
    } catch (e) {
      console.warn('Failed to delete picker session (non-fatal):', e.message);
    }
    await PhotoSource.query().findById(sourceId).patch({ picker_session_id: null, picker_session_expire: null });

    return { added, skipped, failed, total: items.length };
  } catch (error) {
    console.error('Error ingesting picked media:', error);
    reply.status(error.status || 500).send({ error: error.message || 'Failed to ingest picker session' });
  }
});

fastify.delete('/api/photo-sources/:sourceId/picker-session', async (request, reply) => {
  const { sourceId } = request.params;
  try {
    const source = await PhotoSource.query().findById(sourceId);
    if (!source) return reply.status(404).send({ error: 'Source not found' });
    if (source.picker_session_id) {
      const account = await googleConnection.getConnectedAccount();
      if (account) {
        try { await googlePhotosPicker.deleteSession(account.id, source.picker_session_id); } catch (_) { }
      }
    }
    await PhotoSource.query().findById(sourceId).patch({ picker_session_id: null, picker_session_expire: null });
    return { success: true };
  } catch (error) {
    console.error('Error clearing picker session:', error);
    reply.status(500).send({ error: 'Failed to clear picker session' });
  }
});

fastify.get('/api/photo-items', async (request, reply) => {
  try {
    const sources = await PhotoSource.query().where('enabled', 1).orderBy([{ column: 'sort_order' }, { column: 'id' }]);

    if (sources.length === 0) {
      return [];
    }

    const fetchPromises = sources.map(async (source) => {
      try {
        if (source.type === 'Immich') {
          const decryptedApiKey = decryptPassword(source.api_key);
          const baseUrl = source.url.replace(/\/+$/, '');
          const apiBase = baseUrl.includes('/api') ? baseUrl : `${baseUrl}/api`;
          const immichHeaders = {
            'x-api-key': decryptedApiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          };

          let assets = [];

          if (source.album_id) {
            // Immich v3 removed the `assets` array from GET /api/albums/{id}
            // (https://immich.app/blog/v3-migration). Fetch album assets via the
            // paginated metadata search instead — works on both Immich v2 and v3.
            let page = 1;
            while (page && assets.length < 1000) {
              const searchResponse = await axios.post(`${apiBase}/search/metadata`,
                { albumIds: [source.album_id], page, size: 1000 },
                {
                  headers: immichHeaders,
                  timeout: 15000
                }
              );
              const bucket = searchResponse.data?.assets || {};
              assets.push(...(bucket.items || []));
              page = bucket.nextPage ? Number(bucket.nextPage) : null;
            }
            shuffleInPlace(assets);
            assets = assets.slice(0, 100);
          } else {
            const response = await axios.post(`${apiBase}/search/random`,
              { size: 100 },
              {
                headers: immichHeaders,
                timeout: 15000
              }
            );
            assets = response.data || [];
          }

          return assets.map(asset => ({
            id: asset.id,
            url: `/api/photo-proxy/${source.id}/${asset.id}?size=preview`,
            thumbnail: `/api/photo-proxy/${source.id}/${asset.id}?size=thumbnail`,
            type: asset.type,
            source_id: source.id,
            source_name: source.name,
            source_type: 'Immich'
          }));
        } else if (source.type === 'GooglePhotos') {
          const rows = await GooglePickedMedia.query().select('id', 'google_media_id').where('source_id', source.id);
          const photos = rows.map((r) => ({
            id: r.google_media_id,
            url: `/api/photo-sources/${source.id}/picked/${r.id}`,
            thumbnail: `/api/photo-sources/${source.id}/picked/${r.id}`,
            type: 'IMAGE',
            source_id: source.id,
            source_name: source.name,
            source_type: 'GooglePhotos',
          }));
          shuffleInPlace(photos);
          return photos;
        } else if (source.type === 'HomeGlowPhotos') {
          const rows = await HomeglowPhoto.query().select('id', 'filename').where('source_id', source.id).orderBy('uploaded_at', 'desc');
          const photos = rows.map((r) => ({
            id: `homeglow-${r.id}`,
            url: `/api/photo-sources/${source.id}/uploaded/${r.id}/file`,
            thumbnail: `/api/photo-sources/${source.id}/uploaded/${r.id}/file`,
            type: 'IMAGE',
            source_id: source.id,
            source_name: source.name,
            source_type: 'HomeGlowPhotos',
          }));
          shuffleInPlace(photos);
          return photos;
        }
      } catch (error) {
        console.error(`Error fetching photos from source ${source.name}:`, error.message);
        if (error.response) {
          console.error(`Response status: ${error.response.status}`);
          console.error(`Response data:`, error.response.data);
        }
        return [];
      }
    });

    const results = await Promise.all(fetchPromises);
    const allPhotos = results.flat();

    shuffleInPlace(allPhotos);

    return allPhotos;
  } catch (error) {
    console.error('Error fetching photos:', error);
    reply.status(500).send({ error: 'Failed to fetch photos.' });
  }
});

// Admin PIN routes
fastify.get('/api/admin-pin/exists', async (request, reply) => {
  try {
    // Demo mode: report no PIN so the Admin Panel opens without prompting;
    // the set/verify/delete routes below are blocked so a visitor can't
    // lock others out by creating one.
    if (DEMO_MODE) {
      return { exists: false, demo: true };
    }
    const pin = await AdminPin.query().select('id').findById(1);
    return { exists: !!pin };
  } catch (error) {
    console.error('Error checking PIN existence:', error);
    reply.status(500).send({ error: 'Failed to check PIN existence' });
  }
});

fastify.post('/api/admin-pin/set', async (request, reply) => {
  if (demoBlocked(reply)) return;
  const { pin } = request.body;

  if (!pin || typeof pin !== 'string') {
    return reply.status(400).send({ error: 'PIN is required and must be a string' });
  }

  if (pin.length < 4 || pin.length > 8) {
    return reply.status(400).send({ error: 'PIN must be between 4 and 8 characters' });
  }

  if (!/^\d+$/.test(pin)) {
    return reply.status(400).send({ error: 'PIN must contain only numbers' });
  }

  try {
    const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
    const existingPin = await AdminPin.query().findById(1);

    if (existingPin) {
      await AdminPin.query()
        .findById(1)
        .patch({ pin_hash: pinHash, updated_at: knex.raw('CURRENT_TIMESTAMP') });
    } else {
      await AdminPin.query().insert({ id: 1, pin_hash: pinHash });
    }

    return { success: true, message: 'PIN set successfully' };
  } catch (error) {
    console.error('Error setting PIN:', error);
    reply.status(500).send({ error: 'Failed to set PIN' });
  }
});

fastify.delete('/api/admin-pin', async (request, reply) => {
  if (demoBlocked(reply)) return;
  try {
    await AdminPin.query().deleteById(1);
    return { success: true, message: 'PIN cleared successfully' };
  } catch (error) {
    console.error('Error clearing PIN:', error);
    reply.status(500).send({ error: 'Failed to clear PIN' });
  }
});

fastify.post('/api/admin-pin/verify', async (request, reply) => {
  if (demoBlocked(reply)) return;
  const { pin } = request.body;

  if (!pin || typeof pin !== 'string') {
    return reply.status(400).send({ error: 'PIN is required' });
  }

  try {
    const storedPin = await AdminPin.query().findById(1);

    if (!storedPin) {
      return reply.status(404).send({ error: 'No PIN configured' });
    }

    const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
    const isValid = pinHash === storedPin.pin_hash;

    return { valid: isValid };
  } catch (error) {
    console.error('Error verifying PIN:', error);
    reply.status(500).send({ error: 'Failed to verify PIN' });
  }
});

fastify.get('/api/system/backgroundTasks', async (request, reply) => {
  try {
    const result = await dailyBackgroundProcessing();
    return {
      success: true,
      ...result
    };
  } catch (error) {
    console.error('Error running daily background processing:', error);
    reply.status(500).send({ error: 'Failed to run daily background processing' });
  }
});
// Start server
const start = async () => {
  try {
    db = await ConnectOrCreateDb();
    // Wire Knex + Objection alongside the legacy better-sqlite3 connection. The
    // legacy handle exists only for the pre-v14 schema lift below; all runtime
    // data access goes through Knex/Objection.
    //
    // The filename is passed explicitly: createKnex() would otherwise resolve
    // DB_PATH (or server/data/tasks.db) on its own and a demo instance would
    // persist visitor data to a real file while only the legacy handle was
    // in-memory.
    knex = createKnex({ filename: dbPath });
    Model.knex(knex);

    // Schema management: Knex (knex_migrations) is the source of truth.
    //  * Existing install (settings table present): lift any pre-baseline DB to
    //    v14 with the legacy schema migrations (Option A), then Knex adopts it.
    //  * Fresh install (including demo mode's in-memory DB, where the legacy
    //    handle sees no schema at all): the Knex baseline migration builds v14
    //    directly and the post-baseline migrations take it to the current level.
    if (doesTableExist('settings')) {
      const currentSchemaId = getCurrentSchemaVersion();
      if (currentSchemaId < BASELINE_SCHEMA_VERSION) {
        console.log(`Existing DB at schema ${currentSchemaId}; lifting to baseline v${BASELINE_SCHEMA_VERSION} via legacy migrations`);
        await applySchemaMigrations(currentSchemaId);
      }
    }
    const migrationResult = await adoptOrMigrate(knex);
    console.log(`Knex migrations: adopted=${migrationResult.adopted}, applied=[${migrationResult.applied.join(', ')}]`);

    if (DEMO_MODE) {
      const { resetDemoData } = require('./utils/demoSeed');
      console.log(`DEMO MODE enabled: in-memory database, PIN disabled, sample data resets every ${DEMO_RESET_HOURS}h`);
      await resetDemoData();
      setInterval(() => {
        // resetDemoData is async: an un-awaited rejection here would be a fatal
        // unhandledRejection, so the promise is handled inside the callback.
        (async () => {
          try {
            await resetDemoData();
            // Reseeding assigns new source ids, so the running sync jobs point
            // at rows that no longer exist. Restart them (this also kicks off an
            // immediate syncAllSources to refill the wiped event cache).
            if (calendarSyncService && process.env.HOMEGLOW_DISABLE_CALENDAR_SYNC !== '1') {
              calendarSyncService.stopAllSyncJobs();
              calendarSyncService.startAllSyncJobs();
            }
          } catch (err) {
            console.error('Demo reset failed:', err);
          }
        })();
      }, DEMO_RESET_HOURS * 60 * 60 * 1000).unref();
    }

    if (process.env.HOMEGLOW_DISABLE_BACKGROUND_JOBS !== '1') {
      startNightlyCronJob(); // Start the nightly chore pruning job
    } else {
      console.log('Nightly background processing disabled by HOMEGLOW_DISABLE_BACKGROUND_JOBS=1');
    }

    // Create uploads directories
    const uploadsDir = path.join(__dirname, 'uploads');
    const usersDir = path.join(uploadsDir, 'users');
    await fs.mkdir(usersDir, { recursive: true });
    console.log('Uploads directories created');

    // Seed bundled default chore notification sounds into the persisted uploads volume
    await seedDefaultSounds();

    // Seed bundled default profile avatars (issue #132)
    await seedDefaultAvatars();

    // Initialize calendar sync service. Demo mode runs sync too, but ONLY for
    // the curated feeds in demoSeed.js: every route that could add or edit a
    // source URL is demo-blocked, so visitor-entered addresses are never
    // fetched (SSRF guard). The seeded "Family Calendar" placeholder
    // (.invalid host) is skipped by the service itself.
    if (DEMO_MODE) {
      calendarSyncService = new CalendarSyncService(null, decryptPassword);
      if (process.env.HOMEGLOW_DISABLE_CALENDAR_SYNC !== '1') {
        calendarSyncService.initialize();
        console.log('Calendar sync enabled in demo mode (seeded demo feeds only; source management is demo-blocked)');
      } else {
        console.log('Calendar sync jobs disabled in demo mode by HOMEGLOW_DISABLE_CALENDAR_SYNC=1 (cached events only)');
      }
    } else if (process.env.HOMEGLOW_DISABLE_CALENDAR_SYNC !== '1') {
      calendarSyncService = new CalendarSyncService(null, decryptPassword);
      calendarSyncService.initialize();
      console.log('Calendar sync service started');
    } else {
      console.log('Calendar sync service disabled by HOMEGLOW_DISABLE_CALENDAR_SYNC=1');
    }

    if (!isEncryptionConfigured()) {
      console.warn('================================================================');
      console.warn(' WARNING: Encryption key is unavailable or invalid.');
      console.warn(' Third-party connections (Google, etc.) will be disabled.');
      console.warn(' Provide a 32-byte key via ENCRYPTION_KEY or delete');
      console.warn(' server/data/.encryption-key to regenerate on restart.');
      console.warn('================================================================');
    }

    await fastify.listen({ port: process.env.PORT || 5000, host: '0.0.0.0' });
    console.log(`Server running on port ${process.env.PORT || 5000}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};
start();
