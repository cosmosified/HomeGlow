const BaseModel = require('./BaseModel');

class Device extends BaseModel {
    static get tableName() {
        return 'devices';
    }

    static get idColumn() {
        return 'name';
    }
}

module.exports = Device;
