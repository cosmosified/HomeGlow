const BaseModel = require('./BaseModel');

class Chore extends BaseModel {
    static get tableName() {
        return 'chores';
    }

    static get relationMappings() {
        const ChoreSchedule = require('./ChoreSchedule');
        return {
            schedules: {
                relation: BaseModel.HasManyRelation,
                modelClass: ChoreSchedule,
                join: { from: 'chores.id', to: 'chore_schedules.chore_id' },
            },
        };
    }
}

module.exports = Chore;
