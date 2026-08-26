const BaseModel = require('./BaseModel');

class GoogleAccount extends BaseModel {
    static get tableName() {
        return 'google_accounts';
    }
}

module.exports = GoogleAccount;
