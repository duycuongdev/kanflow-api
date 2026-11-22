import Joi from 'joi'
import { StatusCodes } from 'http-status-codes'
import ApiError from '~/utils/ApiError'
import { OBJECT_ID_RULE, OBJECT_ID_RULE_MESSAGE } from '~/utils/validators'

// Giới hạn thời lượng 1 phiên focus: tối thiểu 1 phút, tối đa 4 giờ
const MIN_DURATION_MS = 60 * 1000
const MAX_DURATION_MS = 4 * 60 * 60 * 1000

// Giới hạn range query thống kê: tối đa ~13 tháng
const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000

const createNew = async (req, res, next) => {
  const correctCondition = Joi.object({
    startedAt: Joi.number().integer().required(),
    endedAt: Joi.number().integer().required(),
    cardId: Joi.string().optional().allow(null).pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE),
    boardId: Joi.string().optional().allow(null).pattern(OBJECT_ID_RULE).message(OBJECT_ID_RULE_MESSAGE)
  })

  try {
    const body = await correctCondition.validateAsync(req.body, { abortEarly: false })

    // Ràng buộc thời lượng phiên focus (business rule ở tầng validation để chặn sớm)
    if (body.endedAt <= body.startedAt) {
      throw new Error('endedAt must be greater than startedAt')
    }
    const durationMs = body.endedAt - body.startedAt
    if (durationMs < MIN_DURATION_MS) {
      throw new Error('Focus session must last at least 1 minute')
    }
    if (durationMs > MAX_DURATION_MS) {
      throw new Error('Focus session cannot exceed 4 hours')
    }

    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

/**
 * Validate query range cho stats/leaderboard: from & to là epoch ms bắt buộc
 */
const rangeQuery = async (req, res, next) => {
  const queryCondition = Joi.object({
    from: Joi.number().integer().required(),
    to: Joi.number().integer().required(),
    // Chỉ leaderboard dùng: phân trang (mỗi trang 10 user)
    page: Joi.number().integer().min(1).default(1).optional()
  })

  try {
    const query = await queryCondition.validateAsync(req.query, { abortEarly: false })

    if (query.to <= query.from) {
      throw new Error('"to" must be greater than "from"')
    }
    if (query.to - query.from > MAX_RANGE_MS) {
      throw new Error('Date range cannot exceed 400 days')
    }

    next()
  } catch (error) {
    next(new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, new Error(error).message))
  }
}

export const focusSessionValidation = {
  createNew,
  rangeQuery
}
