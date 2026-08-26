const BaseModel = require('./BaseModel');

class PhotoSource extends BaseModel {
    static get tableName() {
        return 'photo_sources';
    }
}

module.exports = PhotoSource;
