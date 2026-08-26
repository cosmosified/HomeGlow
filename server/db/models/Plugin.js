const BaseModel = require('./BaseModel');

class Plugin extends BaseModel {
    static get tableName() {
        return 'plugins';
    }
}

module.exports = Plugin;
