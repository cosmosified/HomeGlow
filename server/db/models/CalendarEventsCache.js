const BaseModel = require('./BaseModel');

class CalendarEventsCache extends BaseModel {
    static get tableName() {
        return 'calendar_events_cache';
    }
}

module.exports = CalendarEventsCache;
