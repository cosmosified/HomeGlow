const axios = require('axios');
const ICAL = require('ical.js');
const node_ical = require('node-ical');
const { Model } = require('objection');
const googleConnection = require('./googleConnection');
const googleCalendar = require('./googleCalendar');
const appleCalDAV = require('./appleCalDAV');

class CalendarSyncService {
  constructor(db, decryptPassword) {
    // `db` is retained for constructor-signature compatibility but is no longer
    // used for data access; all DB work goes through the globally-bound Knex
    // instance (Model.knex()).
    this.db = db;
    this.decryptPassword = decryptPassword;
    this.syncIntervals = new Map();
    this.isSyncing = new Map();
  }

  initialize() {
    this.startAllSyncJobs().catch(err => {
      console.error('Failed to start calendar sync jobs:', err.message);
    });
    console.log('Calendar sync service initialized');
  }

  normalizeAllDayEnd(end) {
    const d = new Date(end);
    d.setDate(d.getDate() - 1);
    return d;
  }

  normalizeIcsTextValue(value) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value === 'string') {
      return value;
    }

    // node-ical returns { val, params } when ICS properties include parameters like LANGUAGE.
    if (typeof value === 'object' && typeof value.val === 'string') {
      return value.val;
    }

    return String(value);
  }

  async syncSource(sourceId) {
    if (this.isSyncing.get(sourceId)) {
      console.log(`Sync already in progress for source ${sourceId}, skipping`);
      return { skipped: true };
    }

    this.isSyncing.set(sourceId, true);
    const knex = Model.knex();

    try {
      const source = await knex('calendar_sources').where({ id: sourceId, enabled: 1 }).first();
      if (!source) {
        console.log(`Source ${sourceId} not found or disabled`);
        return { success: false, error: 'Source not found or disabled' };
      }

      console.log(`Starting sync for calendar source: ${source.name} (${source.type})`);
      const startTime = Date.now();

      let events = [];

      if (source.type === 'ICS') {
        events = await this.fetchICSEvents(source);
      } else if (source.type === 'CalDAV') {
        events = await this.fetchCalDAVEvents(source);
      } else if (source.type === 'Google') {
        events = await this.fetchGoogleEvents(source);
      } else if (source.type === 'Apple') {
        events = await this.fetchAppleCalDAVEvents(source);
      }

      await knex('calendar_events_cache').where('source_id', sourceId).del();

      await knex.transaction(async (trx) => {
        for (const event of events) {
          await trx('calendar_events_cache')
            .insert({
              source_id: sourceId,
              event_uid: event.uid,
              title: event.title,
              start_time: event.start.toISOString(),
              end_time: event.end.toISOString(),
              description: event.description || null,
              location: event.location || null,
              all_day: event.all_day ? 1 : 0,
              raw_data: JSON.stringify(event.raw || {}),
            })
            .onConflict(['source_id', 'event_uid', 'start_time'])
            .merge();
        }
      });

      const duration = Date.now() - startTime;

      await knex('calendar_sync_status')
        .insert({
          source_id: sourceId,
          last_sync_at: knex.raw("datetime('now')"),
          last_sync_status: 'success',
          last_sync_message: `Synced ${events.length} events in ${duration}ms`,
          event_count: events.length,
        })
        .onConflict('source_id')
        .merge();

      console.log(`Synced ${events.length} events for ${source.name} in ${duration}ms`);

      return { success: true, eventCount: events.length, duration };
    } catch (error) {
      console.error(`Error syncing calendar source ${sourceId}:`, error.message);

      await knex('calendar_sync_status')
        .insert({
          source_id: sourceId,
          last_sync_at: knex.raw("datetime('now')"),
          last_sync_status: 'error',
          last_sync_message: error.message,
        })
        .onConflict('source_id')
        .merge();

      return { success: false, error: error.message };
    } finally {
      this.isSyncing.set(sourceId, false);
    }
  }

  async fetchICSEvents(source) {
    const events = await node_ical.async.fromURL(source.url);
    const out = [];

    const rangeStart = new Date(Date.now() - 13 * 30 * 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(Date.now() + 13 * 30 * 24 * 60 * 60 * 1000);

    for (const event of Object.values(events)) {
      if (event.type !== 'VEVENT') continue;

      const instances = node_ical.expandRecurringEvent(event, {
        from: rangeStart,
        to: rangeEnd
      });

      if (!instances) {
        const isAllDay = event.start?.dateOnly ?? false;
        const rawEnd = event.end;
        out.push({
          uid: event.uid || `${source.id}-${Date.now()}-${Math.random()}`,
          title: this.normalizeIcsTextValue(event.summary) || 'Untitled Event',
          start: new Date(event.start),
          end: isAllDay ? this.normalizeAllDayEnd(rawEnd) : new Date(rawEnd),
          description: this.normalizeIcsTextValue(event.description),
          location: this.normalizeIcsTextValue(event.location),
          all_day: isAllDay,
          raw: { rrule: event.rrule }
        });
        continue;
      }

      for (const instance of instances) {
        const isAllDay = instance.start?.dateOnly ?? instance.event?.start?.dateOnly ?? false;
        const rawEnd = instance.end ?? instance.event?.end;
        out.push({
          uid: `${instance.uid ?? instance.event?.uid ?? source.id}-${new Date(instance.start ?? instance.event?.start).getTime()}`,
          title: this.normalizeIcsTextValue(instance.summary ?? instance.event?.summary) || 'Untitled Event',
          start: new Date(instance.start ?? instance.event?.start),
          end: isAllDay ? this.normalizeAllDayEnd(rawEnd) : new Date(rawEnd),
          description: this.normalizeIcsTextValue(instance.description ?? instance.event?.description),
          location: this.normalizeIcsTextValue(instance.location ?? instance.event?.location),
          all_day: isAllDay,
          raw: { recurring: true }
        });
      }
    }

    return out;
  }

  async fetchCalDAVEvents(source) {
    const decryptedPassword = this.decryptPassword(source.password);
    const authHeader = 'Basic ' + Buffer.from(`${source.username}:${decryptedPassword}`).toString('base64');

    const response = await axios.get(source.url, {
      headers: { 'Authorization': authHeader },
      timeout: 15000
    });

    const icsData = response.data;
    const jcalData = ICAL.parse(icsData);
    const comp = new ICAL.Component(jcalData);
    const vevents = comp.getAllSubcomponents('vevent');

    return vevents.map(vevent => {
      const event = new ICAL.Event(vevent);
      const dtstart = vevent.getFirstPropertyValue('dtstart');
      const isAllDay = dtstart?.isDate ?? false;
      const rawEnd = event.endDate.toJSDate();

      return {
        uid: event.uid || `${source.id}-${Date.now()}-${Math.random()}`,
        title: event.summary || 'Untitled Event',
        start: event.startDate.toJSDate(),
        end: isAllDay ? this.normalizeAllDayEnd(rawEnd) : rawEnd,
        description: event.description,
        location: event.location,
        all_day: isAllDay,
        raw: {}
      };
    });
  }

  async fetchAppleCalDAVEvents(source) {
    const decryptedPassword = this.decryptPassword(source.password);
    return await appleCalDAV.fetchCalendarEvents(source.url, source.username, decryptedPassword);
  }

  async fetchGoogleEvents(source) {
    const account = await googleConnection.getConnectedAccount();
    if (!account) {
      throw new Error('No Google account connected. Authorize Google in Connections.');
    }
    const calendarId = source.url;
    if (!calendarId) {
      throw new Error('Google calendar source has no calendar selected.');
    }
    const now = Date.now();
    const timeMin = new Date(now - 13 * 30 * 24 * 60 * 60 * 1000);
    const timeMax = new Date(now + 13 * 30 * 24 * 60 * 60 * 1000);
    const items = await googleCalendar.listEvents(account.id, calendarId, { timeMin, timeMax });

    const out = [];
    for (const item of items) {
      if (!item || item.status === 'cancelled') continue;
      const start = googleCalendar.parseEventDate(item.start);
      const end = googleCalendar.parseEventDate(item.end);
      if (!start || !end) continue;
      const startDate = new Date(start.date);
      let endDate = new Date(end.date);
      if (start.allDay) {
        endDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
      }
      out.push({
        uid: item.id,
        title: item.summary || 'Untitled Event',
        start: startDate,
        end: endDate,
        description: item.description || null,
        location: item.location || null,
        all_day: !!start.allDay,
        raw: { googleEventId: item.id, htmlLink: item.htmlLink, etag: item.etag },
      });
    }
    return out;
  }

  async syncAllSources() {
    const knex = Model.knex();
    const sources = await knex('calendar_sources').select('id').where('enabled', 1);
    const results = [];

    for (const source of sources) {
      const result = await this.syncSource(source.id);
      results.push({ sourceId: source.id, ...result });
    }

    return results;
  }

  async getCachedEvents(startDate, endDate) {
    const knex = Model.knex();
    const sources = await knex('calendar_sources').select('id', 'name', 'color').where('enabled', 1);

    const sourceMap = new Map(sources.map(s => [s.id, s]));

    let query = knex('calendar_events_cache');

    if (startDate) {
      query = query.where('end_time', '>=', new Date(startDate).toISOString());
    }
    if (endDate) {
      query = query.where('start_time', '<=', new Date(endDate).toISOString());
    }

    query = query.orderBy('start_time', 'asc');

    const rows = await query;

    return rows.map(row => {
      const source = sourceMap.get(row.source_id);
      return {
        id: row.event_uid,
        title: row.title,
        start: new Date(row.start_time),
        end: new Date(row.end_time),
        description: row.description,
        location: row.location,
        all_day: row.all_day === 1,
        source_id: row.source_id,
        source_name: source?.name || 'Unknown',
        source_color: source?.color || '#6e44ff'
      };
    });
  }

  async getSyncStatus(sourceId) {
    const knex = Model.knex();
    if (sourceId) {
      return await knex('calendar_sync_status').where('source_id', sourceId).first();
    }
    return await knex('calendar_sync_status as css')
      .select('css.*', 'cs.name as source_name')
      .join('calendar_sources as cs', 'css.source_id', 'cs.id');
  }

  async setSyncInterval(sourceId, intervalMinutes) {
    const knex = Model.knex();
    await knex('calendar_sync_status')
      .insert({ source_id: sourceId, sync_interval_minutes: intervalMinutes })
      .onConflict('source_id')
      .merge({ sync_interval_minutes: intervalMinutes });

    await this.restartSyncJob(sourceId);
  }

  async getSyncInterval(sourceId) {
    const knex = Model.knex();
    const row = await knex('calendar_sync_status')
      .select('sync_interval_minutes')
      .where('source_id', sourceId)
      .first();
    return row?.sync_interval_minutes || 15;
  }

  async startSyncJob(sourceId) {
    const interval = await this.getSyncInterval(sourceId);

    if (this.syncIntervals.has(sourceId)) {
      clearInterval(this.syncIntervals.get(sourceId));
    }

    if (interval <= 0) {
      console.log(`Sync disabled for source ${sourceId}`);
      return;
    }

    const intervalMs = interval * 60 * 1000;

    const intervalId = setInterval(() => {
      this.syncSource(sourceId).catch(err => {
        console.error(`Scheduled sync failed for source ${sourceId}:`, err.message);
      });
    }, intervalMs);

    this.syncIntervals.set(sourceId, intervalId);
    console.log(`Started sync job for source ${sourceId} every ${interval} minutes`);
  }

  async restartSyncJob(sourceId) {
    if (this.syncIntervals.has(sourceId)) {
      clearInterval(this.syncIntervals.get(sourceId));
      this.syncIntervals.delete(sourceId);
    }
    await this.startSyncJob(sourceId);
  }

  async startAllSyncJobs() {
    const knex = Model.knex();
    const sources = await knex('calendar_sources').select('id').where('enabled', 1);

    for (const source of sources) {
      await this.startSyncJob(source.id);
    }

    setTimeout(() => {
      this.syncAllSources().catch(err => {
        console.error('Initial sync failed:', err.message);
      });
    }, 5000);
  }

  stopAllSyncJobs() {
    for (const [sourceId, intervalId] of this.syncIntervals) {
      clearInterval(intervalId);
      console.log(`Stopped sync job for source ${sourceId}`);
    }
    this.syncIntervals.clear();
  }

  onSourceCreated(sourceId) {
    this.syncSource(sourceId).then(() => {
      return this.startSyncJob(sourceId);
    }).catch(err => {
      console.error(`onSourceCreated failed for source ${sourceId}:`, err.message);
    });
  }

  onSourceUpdated(sourceId) {
    this.syncSource(sourceId).catch(err => {
      console.error(`onSourceUpdated failed for source ${sourceId}:`, err.message);
    });
  }

  onSourceDeleted(sourceId) {
    if (this.syncIntervals.has(sourceId)) {
      clearInterval(this.syncIntervals.get(sourceId));
      this.syncIntervals.delete(sourceId);
    }
  }

  onSourceToggled(sourceId, enabled) {
    if (enabled) {
      this.syncSource(sourceId).then(() => {
        return this.startSyncJob(sourceId);
      }).catch(err => {
        console.error(`onSourceToggled failed for source ${sourceId}:`, err.message);
      });
    } else {
      if (this.syncIntervals.has(sourceId)) {
        clearInterval(this.syncIntervals.get(sourceId));
        this.syncIntervals.delete(sourceId);
      }
    }
  }
}

module.exports = CalendarSyncService;
