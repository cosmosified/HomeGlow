const BaseModel = require('./BaseModel');

class Prize extends BaseModel {
    static get tableName() {
        return 'prizes';
    }
}

module.exports = Prize;
