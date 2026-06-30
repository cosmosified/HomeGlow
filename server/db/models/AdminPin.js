const BaseModel = require('./BaseModel');

class AdminPin extends BaseModel {
    static get tableName() {
        return 'admin_pin';
    }

    static get idColumn() {
        return 'id';
    }
}

module.exports = AdminPin;
