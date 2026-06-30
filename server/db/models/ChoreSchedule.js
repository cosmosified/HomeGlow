const BaseModel = require('./BaseModel');

class ChoreSchedule extends BaseModel {
    static get tableName() {
        return 'chore_schedules';
    }

    static get relationMappings() {
        const Chore = require('./Chore');
        const ChoreHistory = require('./ChoreHistory');
        return {
            chore: {
                relation: BaseModel.BelongsToOneRelation,
                modelClass: Chore,
                join: { from: 'chore_schedules.chore_id', to: 'chores.id' },
            },
            history: {
                relation: BaseModel.HasManyRelation,
                modelClass: ChoreHistory,
                join: { from: 'chore_schedules.id', to: 'chore_history.chore_schedule_id' },
            },
        };
    }
}

module.exports = ChoreSchedule;
