const BaseModel = require('./BaseModel');

class PrizeOffer extends BaseModel {
    static get tableName() {
        return 'prize_offers';
    }

    static get relationMappings() {
        const Prize = require('./Prize');
        const User = require('./User');
        return {
            prize: {
                relation: BaseModel.BelongsToOneRelation,
                modelClass: Prize,
                join: { from: 'prize_offers.prize_id', to: 'prizes.id' },
            },
            requester: {
                relation: BaseModel.BelongsToOneRelation,
                modelClass: User,
                join: { from: 'prize_offers.requested_by', to: 'users.id' },
            },
        };
    }
}

module.exports = PrizeOffer;
