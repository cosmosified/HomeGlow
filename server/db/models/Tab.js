const BaseModel = require('./BaseModel');

class Tab extends BaseModel {
    static get tableName() {
        return 'tabs';
    }
}

module.exports = Tab;
