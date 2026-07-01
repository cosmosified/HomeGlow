// File: server/index.js
require('dotenv').config();

const APP_TIMEZONE = process.env.TZ || 'America/New_York';
process.env.TZ = APP_TIMEZONE;

const fastify = require('fastify')({ logger: true });
const Database = require('better-sqlite3');
const { Model } = require('objection');
const { createKnex } = require('./db/knex');
const { adoptOrMigrate } = require('./db/migrate');
const { Setting, AdminPin, Prize, User, Chore, ChoreSchedule, ChoreHistory, Event, CalendarSource, CalendarEventsCache, CalendarSyncStatus, PhotoSource, GooglePickedMedia, HomeglowPhoto, Device, Tab } = require('./db/models');
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

// Calendar sync service
const CalendarSyncService = require('./services/calendarSync');
const googleConnection = require('./services/googleConnection');
const googleCalendar = require('./services/googleCalendar');
const appleCalDAV = require('./services/appleCalDAV');
const googlePhotos = require('./services/googlePhotos');
const googlePhotosPicker = require('./services/googlePhotosPicker');
const { isEncryptionConfigured, getEncryptionStatus } = require('./utils/encryption');
let calendarSyncService = null;

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
];

const ALLOWED_SCHEDULE_DURATIONS = new Set(['day-of', 'until-completed', 'once-completed']);
const SCHEDULE_INTERVAL_REGEX = /^([1-9]\d*)([dwmy])$/;

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

// Encryption utilities for calendar credentials
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'homeglow-default-key-change-in-production-32bytes';
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';

function encryptPassword(password) {
  if (!password) return null;
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptPassword(encryptedPassword) {
  if (!encryptedPassword) return null;
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const parts = encryptedPassword.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
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

// Serve static files for uploads
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'uploads'),
  prefix: '/Uploads/',
  decorateReply: false,
  maxAge: 86400000, // 1 day cache
  setHeaders: (res, path) => {
    // Minimize headers to avoid "Request Header Fields Too Large" error
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
});

// Additional static route specifically for user uploads
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'uploads', 'users'),
  prefix: '/Uploads/users/',
  decorateReply: false,
  maxAge: 86400000, // 1 day cache
  setHeaders: (res, path) => {
    // Minimize headers to avoid "Request Header Fields Too Large" error
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
});

// Serve static files for widgets
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'widgets'),
  prefix: '/widgets/',
  decorateReply: false
});

// Add debugging for widget file requests
fastify.get('/widgets/:filename', async (request, reply) => {
  const { filename } = request.params;
  const filePath = path.join(__dirname, 'widgets', filename);

  console.log(`Widget request for: ${filename}`);
  console.log(`Looking for file at: ${filePath}`);

  try {
    const stats = await fs.stat(filePath);
    console.log(`File exists, size: ${stats.size} bytes`);

    let content = await fs.readFile(filePath, 'utf-8');
    console.log(`File content preview: ${content.substring(0, 100)}...`);

    content = content.replace(/window\.location\.origin\.replace\(['"`]:\d+['"`],\s*['"`]:\d+['"`]\)/g, 'window.location.origin');
    content = content.replace(/\$\{window\.location\.protocol\}\/\/\$\{window\.location\.hostname\}:\d+/g, '${window.location.origin}');
    content = content.replace(/window\.location\.protocol\s*\+\s*'\/\/'\s*\+\s*window\.location\.hostname\s*\+\s*':\d+'/g, 'window.location.origin');

    const overflowFix = `<style>html,body{max-width:100%!important;overflow-x:hidden!important;box-sizing:border-box;}*{box-sizing:border-box;}</style>`;
    if (content.includes('</head>')) {
      content = content.replace('</head>', `${overflowFix}</head>`);
    } else if (content.includes('<body')) {
      content = content.replace('<body', `${overflowFix}<body`);
    } else {
      content = overflowFix + content;
    }

    reply.header('Content-Type', 'text/html');
    return content;
  } catch (error) {
    console.error(`Error serving widget ${filename}:`, error);
    reply.status(404).send(`Widget file not found: ${filename}`);
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

// --- Widget Upload Endpoint and Registry ---

// Helper: Load widget registry
async function loadWidgetRegistry() {
  try {
    const data = await fs.readFile(widgetRegistryPath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

// Helper: Save widget registry
async function saveWidgetRegistry(registry) {
  await fs.writeFile(widgetRegistryPath, JSON.stringify(registry, null, 2), 'utf-8');
}

// Endpoint: Upload a widget (HTML file)
fastify.post('/api/widgets/upload', async (request, reply) => {
  try {
    const data = await request.file();
    if (!data || !data.filename.endsWith('.html')) {
      return reply.status(400).send({ error: 'Only HTML widget files are allowed.' });
    }

    const widgetName = data.filename.replace(/[^a-zA-Z0-9-._]/g, '_');
    const savePath = path.join(__dirname, 'widgets', widgetName);

    // Save the file
    await fs.writeFile(savePath, await data.toBuffer());

    // Update registry
    const registry = await loadWidgetRegistry();
    if (!registry.find(w => w.filename === widgetName)) {
      registry.push({
        name: widgetName.replace('.html', ''),
        filename: widgetName,
        uploadedAt: new Date().toISOString()
      });
      await saveWidgetRegistry(registry);
    }

    return { success: true, message: 'Widget uploaded!', widget: widgetName };
  } catch (err) {
    console.error('Widget upload error:', err);
    reply.status(500).send({ error: 'Failed to upload widget.' });
  }
});

// Endpoint: List widgets
fastify.get('/api/widgets', async (request, reply) => {
  try {
    const registry = await loadWidgetRegistry();
    return registry;
  } catch (err) {
    reply.status(500).send({ error: 'Failed to load widget registry.' });
  }
});

// Endpoint: Delete a widget
fastify.delete('/api/widgets/:filename', async (request, reply) => {
  const { filename } = request.params;
  try {
    const filePath = path.join(__dirname, 'widgets', filename);
    await fs.unlink(filePath);

    // Update registry
    let registry = await loadWidgetRegistry();
    registry = registry.filter(w => w.filename !== filename);
    await saveWidgetRegistry(registry);

    return { success: true, message: 'Widget deleted.' };
  } catch (err) {
    reply.status(500).send({ error: 'Failed to delete widget.' });
  }
});

// Debug endpoint to list widget files
fastify.get('/api/widgets/debug', async (request, reply) => {
  try {
    const widgetsDir = path.join(__dirname, 'widgets');
    console.log(`Checking widgets directory: ${widgetsDir}`);

    const files = await fs.readdir(widgetsDir);
    console.log(`Files in widgets directory:`, files);

    const fileDetails = [];
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

    return {
      directory: widgetsDir,
      files: fileDetails,
      registry: await loadWidgetRegistry()
    };
  } catch (error) {
    console.error('Error reading widgets directory:', error);
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
    const savePath = path.join(__dirname, 'widgets', sanitizedFilename);

    // Save the widget file
    await fs.writeFile(savePath, response.data, 'utf-8');

    // Update registry
    const registry = await loadWidgetRegistry();
    const existingWidget = registry.find(w => w.filename === sanitizedFilename);

    if (!existingWidget) {
      registry.push({
        name: name || sanitizedFilename.replace('.html', ''),
        filename: sanitizedFilename,
        uploadedAt: new Date().toISOString(),
        source: 'github',
        originalUrl: download_url
      });
      await saveWidgetRegistry(registry);
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

// Initialize database
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, 'data', 'tasks.db');
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
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.chmod(path.dirname(dbPath), 0o777);

    const newDb = new Database(dbPath);
    newDb.pragma('foreign_keys = ON');
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
  const pendingMigrations = schemaMigrations
    .filter(migration => migration.schemaId > currentSchemaId)
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

    // We want to delete schedules that are completed and will never run again to avoid clutter
    const schedulesToPrune = await knex('chore_schedules as cs')
      .join('chores as c', 'cs.chore_id', 'c.id')
      .select('cs.id', 'cs.chore_id', 'cs.user_id', 'c.title')
      .whereNull('cs.crontab')
      .where('cs.visible', 1)
      .whereRaw('EXISTS (SELECT 1 FROM chore_history ch WHERE ch.chore_schedule_id = cs.id)');
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
      .select('cs.id', 'cs.chore_id', 'cs.user_id', 'cs.crontab', 'cs.duration', 'cs.interval')
      .whereNotNull('cs.crontab')
      .whereIn('cs.duration', ['until-completed', 'once-completed'])
      .where('cs.visible', 1)
      .whereRaw(`NOT EXISTS (
          SELECT 1 FROM chore_schedules child
          WHERE child.crontab IS NULL
            AND child.visible = 1
            AND (
              child.parent_schedule_id = cs.id
              OR (
                child.parent_schedule_id IS NULL
                AND child.chore_id = cs.chore_id
                AND (
                  (child.user_id = cs.user_id)
                  OR (child.user_id IS NULL AND cs.user_id IS NULL)
                )
              )
            )
        )`);
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
        const insertedSticky = await ChoreSchedule.query().insert({
          chore_id: schedule.chore_id,
          user_id: schedule.user_id,
          crontab: null,
          duration: 'day-of',
          visible: 1,
          parent_schedule_id: schedule.id,
        });
        const scheduleResult = await ChoreSchedule.query().findById(insertedSticky.id);

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
  const { title, description, clam_value } = request.body;
  try {
    const inserted = await Chore.query().insert({ title, description, clam_value: clam_value || 0 });
    return { id: inserted.id, success: true };
  } catch (error) {
    console.error('Error adding chore:', error);
    reply.status(500).send({ error: 'Failed to add chore' });
  }
});

fastify.patch('/api/chores/:id', async (request, reply) => {
  const { id } = request.params;
  const { title, description, clam_value } = request.body;
  try {
    const updated = await Chore.query().patch({ title, description, clam_value }).where({ id });
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
      .select('cs.*', 'c.title', 'c.description', 'c.clam_value');

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
  const { chore_id, user_id, crontab, duration, visible, interval, parent_schedule_id } = request.body;
  try {
    if (!chore_id) {
      return reply.status(400).send({ error: 'chore_id is required' });
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
    });
    return { id: inserted.id, success: true };
  } catch (error) {
    console.error('Error adding schedule:', error);
    reply.status(500).send({ error: 'Failed to add schedule' });
  }
});

fastify.post('/api/chore-schedules/bulk', async (request, reply) => {
  const { chore_id, user_ids, crontab, visible } = request.body;
  try {
    if (!chore_id || !user_ids || !Array.isArray(user_ids)) {
      return reply.status(400).send({ error: 'chore_id and user_ids array are required' });
    }

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
  const { chore_id, user_id, crontab, duration, visible, interval, parent_schedule_id } = request.body;
  try {
    if (crontab !== undefined && crontab !== null) {
      try {
        CronExpressionParser.parse(crontab);
      } catch (e) {
        return reply.status(400).send({ error: 'Invalid crontab expression: ' + e.message });
      }
    }

    const existingSchedule = await ChoreSchedule.query().findById(id);
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

    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    const updated = await ChoreSchedule.query().patch(patch).where({ id });

    if (updated === 0) {
      return reply.status(404).send({ error: 'Schedule not found' });
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

fastify.post('/api/chore-history', async (request, reply) => {
  const { user_id, chore_schedule_id, date, clam_value } = request.body;
  try {
    if (!user_id || !date) {
      return reply.status(400).send({ error: 'user_id and date are required' });
    }

    const inserted = await ChoreHistory.query().insert({
      user_id,
      chore_schedule_id: chore_schedule_id || null,
      date,
      clam_value: clam_value || 0,
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
      .select('ch.id', 'ch.date', 'ch.clam_value', 'ch.title', 'ch.created_at', 'u.username')
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

    const existing = await knex('chore_history').where({ chore_schedule_id, user_id, date }).first();
    if (existing) {
      return reply.status(409).send({ error: 'Chore already completed for this date' });
    }

    await ChoreHistory.query().insert({ user_id, chore_schedule_id, date, clam_value: schedule.clam_value, title: schedule.title });

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

    const today = getTodayLocalDateString();
    const allUserSchedules = await knex('chore_schedules as cs')
      .join('chores as c', 'cs.chore_id', 'c.id')
      .select('cs.*', 'c.clam_value')
      .select(knex.raw(
        'EXISTS (SELECT 1 FROM chore_history ch WHERE ch.chore_schedule_id = cs.id AND ch.user_id = cs.user_id AND ch.date = ?) AS completed_today',
        [today]
      ))
      .where('cs.user_id', user_id)
      .where('cs.visible', 1)
      .whereRaw("NOT (cs.crontab IS NOT NULL AND cs.duration IN ('until-completed', 'once-completed'))");

    const regularChores = allUserSchedules.filter(s => s.clam_value === 0);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const justBeforeToday = new Date(startOfToday.getTime() - 1);
    let options = {
      currentDate: justBeforeToday,
      utc: false,
    }
    let todaysChores = []
    for (const schedule of regularChores) {
      // schedules without crontab are one-time and always part of today's chores
      if (!schedule.crontab) {
        todaysChores.push(schedule);
        continue;
      }

      // ensure only chores that are due today are part of today's chores
      const interval = CronExpressionParser.parse(schedule.crontab, options);
      const next = interval.next().toISOString().split('T')[0];
      if (today === next) {
        todaysChores.push(schedule);
      }
    }

    const uncompletedRegularChores = todaysChores.filter(cs => cs.completed_today == 0);
    if (todaysChores.length && !uncompletedRegularChores.length) {
      const dailyRewardSetting = await Setting.query().findById('daily_completion_clam_reward');
      const dailyReward = dailyRewardSetting ? parseInt(dailyRewardSetting.value, 10) : 2;

      const bonusAlreadyAwarded = await knex('chore_history')
        .where({ user_id, date, chore_schedule_id: null, clam_value: dailyReward, title: 'Regular chores' })
        .first();

      if (!bonusAlreadyAwarded) {
        await ChoreHistory.query().insert({ user_id, chore_schedule_id: null, date, clam_value: dailyReward, title: 'Regular chores' });
      }
    }

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

    const history = await knex('chore_history')
      .select('id', 'clam_value')
      .where({ chore_schedule_id, user_id, date })
      .first();
    if (!history) {
      return reply.status(404).send({ error: 'Completion record not found' });
    }

    await knex('chore_history').where('id', history.id).del();

    // if the uncompleted chore was a bonus chore (has clam value), don't remove the daily bonus when uncompleting
    if (!history.clam_value) {
      const dailyRewardSetting = await Setting.query().findById('daily_completion_clam_reward');
      const dailyReward = dailyRewardSetting ? parseInt(dailyRewardSetting.value, 10) : 2;

      const bonusEntry = await knex('chore_history')
        .where({ user_id, date, chore_schedule_id: null, clam_value: dailyReward, title: 'Regular chores' })
        .first();

      if (bonusEntry) {
        await knex('chore_history').where('id', bonusEntry.id).del();
      }
    }

    const total = await getUserClamTotal(user_id);

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
    });

    const total = await getUserClamTotal(id);
    return { success: true, clam_total: total };
  } catch (error) {
    console.error('Error adding clams:', error);
    reply.status(500).send({ error: 'Failed to add clams' });
  }
});

fastify.post('/api/users/:id/clams/reduce', async (request, reply) => {
  const { id } = request.params;
  const { amount } = request.body;
  try {
    if (!amount || amount <= 0) {
      return reply.status(400).send({ error: 'Valid positive amount is required' });
    }

    const currentTotal = await getUserClamTotal(id);
    if (currentTotal < amount) {
      return reply.status(400).send({ error: 'Insufficient clams' });
    }

    let remaining = amount;
    const entries = await knex('chore_history')
      .where('user_id', id)
      .where('clam_value', '>', 0)
      .orderBy('created_at', 'asc');

    for (const entry of entries) {
      if (remaining <= 0) break;

      if (entry.clam_value <= remaining) {
        await knex('chore_history').where('id', entry.id).del();
        remaining -= entry.clam_value;
      } else {
        await knex('chore_history').where('id', entry.id).update({ clam_value: entry.clam_value - remaining });
        remaining = 0;
      }
    }

    const total = await getUserClamTotal(id);
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
    const users = await User.query().select('id', 'username', 'email', 'profile_picture');

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
    const inserted = await User.query().insert({ username, email, profile_picture });
    return { id: inserted.id };
  } catch (error) {
    console.error('Error adding user:', error);
    reply.status(500).send({ error: 'Failed to add user' });
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

// NEW: Endpoint to upload user profile picture
fastify.post('/api/users/:id/upload-picture', async (request, reply) => {
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

// NEW: API Endpoints for Settings (including API keys)
fastify.get('/api/settings', async (request, reply) => {
  try {
    const rows = await Setting.query().select('key', 'value');
    // Convert array of {key, value} objects to a single object {key: value}
    const settings = rows.reduce((acc, row) => {
      acc[row.key] = deserializeSettingValue(row.value);
      return acc;
    }, {});
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
    const query = Setting.query().select('key', 'value');
    if (keys.length) {
      query.where((builder) => {
        keys.forEach((key) => builder.orWhere('key', 'like', String(key).replaceAll('*', '%')));
      });
    }
    const rows = await query;
    const settings = rows.reduce((acc, row) => {
      acc[row.key] = deserializeSettingValue(row.value);
      return acc;
    }, {});
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
    // Upsert: insert a new setting or replace the value of an existing one
    // (equivalent to the previous INSERT OR REPLACE).
    await Setting.query().insert({ key, value }).onConflict('key').merge();
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
      await getTabsForDevice(deviceName).map(tab => [tab.number, {
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
      }
    };

    // For HTTP requests, ensure we don't have HTTPS-specific configurations
    if (target.protocol === 'http:') {
      console.log('Making HTTP request (not HTTPS)');
      // No special HTTPS agent needed for HTTP
    } else {
      console.log('Making HTTPS request');
      // For HTTPS, we might need to handle self-signed certificates
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Only for development
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
  const { name, clam_cost } = request.body;
  if (!name || !clam_cost || clam_cost <= 0) {
    return reply.status(400).send({ error: 'Prize name and a positive clam cost are required.' });
  }
  try {
    const inserted = await Prize.query().insert({ name, clam_cost });
    return { id: inserted.id };
  } catch (error) {
    console.error('Error adding prize:', error);
    reply.status(500).send({ error: 'Failed to add prize' });
  }
});

fastify.patch('/api/prizes/:id', async (request, reply) => {
  const { id } = request.params;
  const { name, clam_cost } = request.body;
  if (!name || !clam_cost || clam_cost <= 0) {
    return reply.status(400).send({ error: 'Prize name and a positive clam cost are required.' });
  }
  try {
    const updated = await Prize.query().patch({ name, clam_cost }).where({ id });
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

fastify.post('/api/calendar-sources/:id/events', async (request, reply) => {
  try {
    const { id } = request.params;
    const source = await CalendarSource.query().findById(id);
    if (!source) return reply.status(404).send({ error: 'Calendar source not found' });
    if (source.type !== 'Google') {
      return reply.status(400).send({ error: 'This calendar type is read-only.' });
    }
    const account = await googleConnection.getConnectedAccount();
    if (!account) return reply.status(400).send({ error: 'No Google account connected.' });

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
    const source = await CalendarSource.query().findById(id);
    if (!source) return reply.status(404).send({ error: 'Calendar source not found' });
    if (source.type !== 'Google') {
      return reply.status(400).send({ error: 'This calendar type is read-only.' });
    }
    const account = await googleConnection.getConnectedAccount();
    if (!account) return reply.status(400).send({ error: 'No Google account connected.' });

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
    const source = await CalendarSource.query().findById(id);
    if (!source) return reply.status(404).send({ error: 'Calendar source not found' });
    if (source.type !== 'Google') {
      return reply.status(400).send({ error: 'This calendar type is read-only.' });
    }
    const account = await googleConnection.getConnectedAccount();
    if (!account) return reply.status(400).send({ error: 'No Google account connected.' });

    await googleCalendar.deleteEvent(account.id, source.url, eventId);
    if (calendarSyncService) calendarSyncService.syncSource(source.id).catch(() => { });
    return { success: true };
  } catch (error) {
    console.error('Error deleting Google calendar event:', error);
    reply.status(error.status || 500).send({ error: error.message || 'Failed to delete event' });
  }
});

fastify.delete('/api/connections/google/account', async (request, reply) => {
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

// Apple Calendar (iCloud CalDAV) connection routes
fastify.post('/api/connections/apple/calendars', async (request, reply) => {
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

// HomeGlow Photos - list uploaded photos for a source
fastify.get('/api/photo-sources/:sourceId/uploaded', async (request, reply) => {
  const { sourceId } = request.params;
  try {
    const source = await PhotoSource.query().findById(sourceId);
    if (!source || source.type !== 'HomeGlowPhotos') {
      return reply.status(404).send({ error: 'HomeGlow Photos source not found' });
    }
    const rows = await HomeglowPhoto.query().select('id', 'filename', 'original_name', 'mime_type', 'size', 'uploaded_at').where('source_id', sourceId).orderBy('uploaded_at', 'desc');
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
  const { sourceId } = request.params;
  try {
    const source = await PhotoSource.query().findById(sourceId);
    if (!source || source.type !== 'HomeGlowPhotos') {
      return reply.status(404).send({ error: 'HomeGlow Photos source not found' });
    }
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

fastify.post('/api/photo-sources/:sourceId/picker-session', async (request, reply) => {
  const { sourceId } = request.params;
  try {
    const source = await PhotoSource.query().findById(sourceId);
    if (!source || source.type !== 'GooglePhotos') {
      return reply.status(404).send({ error: 'Google Photos source not found' });
    }
    const account = await googleConnection.getConnectedAccount();
    if (!account) return reply.status(400).send({ error: 'No Google account connected.' });

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
    const source = await PhotoSource.query().findById(sourceId);
    if (!source || source.type !== 'GooglePhotos') {
      return reply.status(404).send({ error: 'Google Photos source not found' });
    }
    if (!source.picker_session_id) {
      return { sessionId: null, mediaItemsSet: false };
    }
    const account = await googleConnection.getConnectedAccount();
    if (!account) return reply.status(400).send({ error: 'No Google account connected.' });

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
    const source = await PhotoSource.query().findById(sourceId);
    if (!source || source.type !== 'GooglePhotos') {
      return reply.status(404).send({ error: 'Google Photos source not found' });
    }
    if (!source.picker_session_id) {
      return reply.status(400).send({ error: 'No active picker session' });
    }
    const account = await googleConnection.getConnectedAccount();
    if (!account) return reply.status(400).send({ error: 'No Google account connected.' });

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
            const albumResponse = await axios.get(`${apiBase}/albums/${source.album_id}`, {
              headers: immichHeaders,
              timeout: 15000
            });
            assets = albumResponse.data?.assets || [];
            for (let i = assets.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [assets[i], assets[j]] = [assets[j], assets[i]];
            }
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
          for (let i = photos.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [photos[i], photos[j]] = [photos[j], photos[i]];
          }
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
          for (let i = photos.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [photos[i], photos[j]] = [photos[j], photos[i]];
          }
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

    for (let i = allPhotos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allPhotos[i], allPhotos[j]] = [allPhotos[j], allPhotos[i]];
    }

    return allPhotos;
  } catch (error) {
    console.error('Error fetching photos:', error);
    reply.status(500).send({ error: 'Failed to fetch photos.' });
  }
});

// Admin PIN routes
fastify.get('/api/admin-pin/exists', async (request, reply) => {
  try {
    const pin = await AdminPin.query().findById(1);
    return { exists: !!pin };
  } catch (error) {
    console.error('Error checking PIN existence:', error);
    reply.status(500).send({ error: 'Failed to check PIN existence' });
  }
});

fastify.post('/api/admin-pin/set', async (request, reply) => {
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
  try {
    await AdminPin.query().deleteById(1);
    return { success: true, message: 'PIN cleared successfully' };
  } catch (error) {
    console.error('Error clearing PIN:', error);
    reply.status(500).send({ error: 'Failed to clear PIN' });
  }
});

fastify.post('/api/admin-pin/verify', async (request, reply) => {
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
    // Wire Knex + Objection alongside the legacy better-sqlite3 connection. Routes
    // still use `db` for now; domains are migrated onto Objection task by task.
    knex = createKnex();
    Model.knex(knex);

    // Schema management: Knex (knex_migrations) is the source of truth.
    //  * Existing install (settings table present): lift any pre-baseline DB to
    //    v14 with the legacy schema migrations (Option A), then Knex adopts it.
    //  * Fresh install: the Knex baseline migration builds v14 directly.
    if (doesTableExist('settings')) {
      const currentSchemaId = getCurrentSchemaVersion();
      if (currentSchemaId < BASELINE_SCHEMA_VERSION) {
        console.log(`Existing DB at schema ${currentSchemaId}; lifting to baseline v${BASELINE_SCHEMA_VERSION} via legacy migrations`);
        await applySchemaMigrations(currentSchemaId);
      }
    }
    const migrationResult = await adoptOrMigrate(knex);
    console.log(`Knex migrations: adopted=${migrationResult.adopted}, applied=[${migrationResult.applied.join(', ')}]`);

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

    // Initialize calendar sync service
    if (process.env.HOMEGLOW_DISABLE_CALENDAR_SYNC !== '1') {
      calendarSyncService = new CalendarSyncService(db, decryptPassword);
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
