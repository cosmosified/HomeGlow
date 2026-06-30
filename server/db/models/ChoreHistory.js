const BaseModel = require('./BaseModel');

class ChoreHistory extends BaseModel {
    static get tableName() {
        return 'chore_history';
    }

    static get relationMappings() {
        const ChoreSchedule = require('./ChoreSchedule');
        const User = require('./User');
        return {
            schedule: {
                relation: BaseModel.BelongsToOneRelation,
                modelClass: ChoreSchedule,
                join: { from: 'chore_history.chore_schedule_id', to: 'chore_schedules.id' },
            },
            user: {
                relation: BaseModel.BelongsToOneRelation,
                modelClass: User,
                join: { from: 'chore_history.user_id', to: 'users.id' },
            },
        };
    }
}

module.exports = ChoreHistory;
