// Objection model barrel. Models are bound to Knex globally in index.js via
// Model.knex(knex) at startup, so `Model.query()` works without passing knex.

module.exports = {
    BaseModel: require('./BaseModel'),
    User: require('./User'),
    Setting: require('./Setting'),
    AdminPin: require('./AdminPin'),
    Prize: require('./Prize'),
    PrizeOffer: require('./PrizeOffer'),
    Chore: require('./Chore'),
    ChoreSchedule: require('./ChoreSchedule'),
    ChoreHistory: require('./ChoreHistory'),
    Event: require('./Event'),
    CalendarSource: require('./CalendarSource'),
    CalendarEventsCache: require('./CalendarEventsCache'),
    CalendarSyncStatus: require('./CalendarSyncStatus'),
    PhotoSource: require('./PhotoSource'),
    GooglePickedMedia: require('./GooglePickedMedia'),
    HomeglowPhoto: require('./HomeglowPhoto'),
    Device: require('./Device'),
    Tab: require('./Tab'),
    GoogleAccount: require('./GoogleAccount'),
    GoogleOauthState: require('./GoogleOauthState'),
    Plugin: require('./Plugin'),
    PluginStorage: require('./PluginStorage'),
};
