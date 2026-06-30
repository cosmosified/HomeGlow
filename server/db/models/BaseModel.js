// Shared Objection base model. Domain models extend this so cross-cutting
// concerns (and future hooks) live in one place.

const { Model } = require('objection');

class BaseModel extends Model {}

module.exports = BaseModel;
