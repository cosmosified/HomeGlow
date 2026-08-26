const BaseModel = require('./BaseModel');

class GooglePickedMedia extends BaseModel {
    static get tableName() {
        return 'google_picked_media';
    }
}

module.exports = GooglePickedMedia;
