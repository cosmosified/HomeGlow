// Objection model barrel. Models are bound to Knex globally in index.js via
// Model.knex(knex) at startup, so `Model.query()` works without passing knex.

module.exports = {
    BaseModel: require('./BaseModel'),
    User: require('./User'),
    Setting: require('./Setting'),
    AdminPin: require('./AdminPin'),
};
