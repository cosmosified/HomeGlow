const BaseModel = require('./BaseModel');

class Event extends BaseModel {
    static get tableName() {
        return 'events';
    }
}

module.exports = Event;
