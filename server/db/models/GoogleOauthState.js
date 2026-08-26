const BaseModel = require('./BaseModel');

class GoogleOauthState extends BaseModel {
    static get tableName() {
        return 'google_oauth_states';
    }

    static get idColumn() {
        return 'state';
    }
}

module.exports = GoogleOauthState;
