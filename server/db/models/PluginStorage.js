const BaseModel = require('./BaseModel');

class PluginStorage extends BaseModel {
    static get tableName() {
        return 'plugin_storage';
    }
}

module.exports = PluginStorage;
