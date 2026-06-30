const BaseModel = require('./BaseModel');

class Setting extends BaseModel {
    static get tableName() {
        return 'settings';
    }

    static get idColumn() {
        return 'key';
    }
}

module.exports = Setting;
