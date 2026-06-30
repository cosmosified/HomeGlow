const BaseModel = require('./BaseModel');

class CalendarSource extends BaseModel {
    static get tableName() {
        return 'calendar_sources';
    }
}

module.exports = CalendarSource;
