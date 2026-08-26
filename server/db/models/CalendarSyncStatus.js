const BaseModel = require('./BaseModel');

class CalendarSyncStatus extends BaseModel {
    static get tableName() {
        return 'calendar_sync_status';
    }

    static get idColumn() {
        return 'source_id';
    }
}

module.exports = CalendarSyncStatus;
