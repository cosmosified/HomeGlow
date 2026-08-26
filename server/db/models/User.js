const BaseModel = require('./BaseModel');

class User extends BaseModel {
    static get tableName() {
        return 'users';
    }

    static get idColumn() {
        return 'id';
    }
}

module.exports = User;
