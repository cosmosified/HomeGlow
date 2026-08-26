const BaseModel = require('./BaseModel');

class HomeglowPhoto extends BaseModel {
    static get tableName() {
        return 'homeglow_photos';
    }
}

module.exports = HomeglowPhoto;
